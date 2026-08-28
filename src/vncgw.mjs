// Vendored from devbox-chrome-cdp for standalone dsh.bundle packaging.
// Upstream design: server-side VNC authentication; password never reaches the browser.
// vncgw.mjs —— VNC-over-WebSocket 服务端认证网关(零依赖,纯 Node 内置)。
//
// 角色: 面板在中间做双面 RFB 中转。
//   浏览器(noVNC) <--WS(binary 帧)--> 面板 <--raw TCP--> x11vnc(127.0.0.1:5900)
//
// 关键安全目标: 浏览器侧用【None 安全类型】无密码握手;面板在服务端用 vnc-password
// 文件里的密码对 x11vnc 做 VncAuth。VNC 密码全程只在服务端内存,绝不出现在任何
// 发给浏览器的字节里 —— 分享者能看屏但拿不到密码。
//
// 自己实现: WS 握手(RFC6455)、WS 帧编解码(掩码/分片/控制帧)、RFB 3.x 双握手。

import net from 'node:net';
import { createHash } from 'node:crypto';
import { vncAuthResponse } from './vncdes.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
// 单 WS 帧大小上限(纵深防御)。浏览器->服务端的 RFB 帧都很小(鼠标/键盘/剪贴板),
// 16MB 远超任何正常帧;伪造的 64 位长度头若不挡,下面 allocUnsafe(len) 会申请超大 Buffer。
const MAX_WS_FRAME = 16 * 1024 * 1024;

// ── WS 握手 ──────────────────────────────────────────────────────────────────
export function wsAcceptKey(secWebSocketKey) {
  return createHash('sha1').update(secWebSocketKey + WS_GUID).digest('base64');
}

// 在已 upgrade 的裸 socket 上完成 WS server 握手(写 101)。
function wsHandshake(socket, req) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return false; }
  const accept = wsAcceptKey(key);
  // RFC6455: 服务端【只能】回显客户端实际在 Sec-WebSocket-Protocol 里请求过的子协议;
  // 客户端没请求子协议时若仍回一个,规范要求浏览器中断连接。
  // 注意:2021+ noVNC(本机 /usr/share/novnc 即此版)已不再请求 'binary' 子协议,
  // 早期版本才请求。无条件回 'binary' 会让新版 noVNC 的 WS 被浏览器中断 -> 看屏"未连接"。
  // 数据始终走 binary 帧(encodeFrame opcode=0x2),与是否协商子协议无关。
  const offered = String(req.headers['sec-websocket-protocol'] || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const echoProto = offered.includes('binary') ? 'binary' : null;
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    (echoProto ? `Sec-WebSocket-Protocol: ${echoProto}\r\n` : '') +
    '\r\n',
  );
  return true;
}

// ── WS 帧编码(服务端->浏览器,unmasked)──────────────────────────────────────
function encodeFrame(payload, opcode = 0x2) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    // 用 BigInt 写 64 位长度(单帧 RFB 数据通常远小于此,但严格起见走完整路径)
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
  return Buffer.concat([header, payload]);
}

// ── WS 帧解码状态机(浏览器->服务端,masked)────────────────────────────────
// 处理: 拆帧、去掩码、TCP 粘包/拆包、控制帧(close/ping/pong)。
// 通过回调把还原出的 RFB binary 字节交给上层(透传给 x11vnc)。
class WsFrameParser {
  constructor({ onData, onClose, onPing }) {
    this.buf = Buffer.alloc(0);
    this.onData = onData;
    this.onClose = onClose;
    this.onPing = onPing;
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    // 循环消费完整帧;不足一帧则留在 this.buf 等下次。
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        len = Number(big);
        offset = 10;
      }
      // 单帧大小上限(纵深防御): 超限即关,绝不按伪造长度 allocUnsafe 巨型 Buffer。
      if (len > MAX_WS_FRAME) { this.onClose && this.onClose(); return; }
      // 浏览器->服务端必须 masked(RFC6455);否则视为协议错误关闭。
      if (!masked) { this.onClose && this.onClose(); return; }
      const maskStart = offset;
      const dataStart = offset + 4;
      if (this.buf.length < dataStart + len) return; // 等更多字节
      const mask = this.buf.subarray(maskStart, maskStart + 4);
      const payload = Buffer.allocUnsafe(len);
      const src = this.buf.subarray(dataStart, dataStart + len);
      for (let i = 0; i < len; i++) payload[i] = src[i] ^ mask[i & 3];
      this.buf = this.buf.subarray(dataStart + len);

      if (opcode === 0x8) { this.onClose && this.onClose(); return; }     // close
      else if (opcode === 0x9) { this.onPing && this.onPing(payload); }   // ping
      else if (opcode === 0xA) { /* pong: 忽略 */ }
      else { this.onData && this.onData(payload); }                       // binary/text/cont -> RFB 字节
    }
  }
}

// ── RFB 客户端侧: 面板 <-> x11vnc 的握手(面板作 RFB 客户端,做 VncAuth)──────
// 返回 Promise<Buffer>: resolve 时携带握手后 x11vnc 已多读到、属于 ServerInit 阶段
// 之后的剩余字节(通常为空),交由透传阶段先行 flush。
function rfbClientHandshake(upstream, password, log = () => {}) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    let stage = 'version';           // version -> sectypes -> challenge -> secresult -> done
    let challenge = null;

    // 握手超时: x11vnc 若卡死(TCP 没断但不回字节),否则这个 Promise 永不 settle ->
    // 浏览器侧表现为"永远连接中"。10s 上限后 reject,closeAll 收尾。
    const hsTimer = setTimeout(() => { cleanup(); reject(new Error('x11vnc handshake timeout (10s)')); }, 10_000);

    const onData = (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      try { pump(); } catch (e) { cleanup(); reject(e); }
    };
    const onErr = (e) => { cleanup(); reject(e); };
    const onEnd = () => { cleanup(); reject(new Error('x11vnc closed during handshake')); };
    upstream.on('data', onData);
    upstream.on('error', onErr);
    upstream.on('end', onEnd);

    function cleanup() {
      clearTimeout(hsTimer);
      upstream.removeListener('data', onData);
      upstream.removeListener('error', onErr);
      upstream.removeListener('end', onEnd);
    }

    function pump() {
      if (stage === 'version') {
        if (buf.length < 12) return;
        const ver = buf.subarray(0, 12).toString('ascii');
        if (!/^RFB \d{3}\.\d{3}\n$/.test(ver)) throw new Error('bad RFB version from x11vnc: ' + JSON.stringify(ver));
        buf = buf.subarray(12);
        // 回 3.8(x11vnc 支持;security-types 走 3.7+ 列表协议)
        upstream.write(Buffer.from('RFB 003.008\n', 'ascii'));
        stage = 'sectypes';
      }
      if (stage === 'sectypes') {
        if (buf.length < 1) return;
        const n = buf[0];
        if (n === 0) {
          // 失败: 后跟 4 字节原因长度 + 原因串
          if (buf.length < 5) return;
          const reasonLen = buf.readUInt32BE(1);
          if (buf.length < 5 + reasonLen) return;
          throw new Error('x11vnc rejected: ' + buf.subarray(5, 5 + reasonLen).toString('utf8'));
        }
        if (buf.length < 1 + n) return;
        const types = buf.subarray(1, 1 + n);
        buf = buf.subarray(1 + n);
        let chosen = -1;
        for (const t of types) { if (t === 2) { chosen = 2; break; } } // VncAuth
        // x11vnc 在有 -passwdfile 时给 VncAuth(2);若只给 None(1) 也能用
        if (chosen === -1) {
          for (const t of types) { if (t === 1) { chosen = 1; break; } }
        }
        if (chosen === -1) throw new Error('x11vnc offers no VncAuth/None security type: ' + Array.from(types).join(','));
        upstream.write(Buffer.from([chosen]));
        if (chosen === 1) {
          // 降级提示: x11vnc 未提供 VncAuth(无密码启动) -> 网关走 None,"看屏需 VNC 密码"
          // 这层保护此刻不存在,看屏仅由面板 token 把关。运维可据此察觉降级。
          log('vncgw: x11vnc offered None only (no VncAuth) -> screen gated by panel token only');
          stage = 'secresult';                       // None: 直接读 SecurityResult
        } else {
          log('vncgw: using VncAuth (server-side DES with vnc-password)');
          stage = 'challenge';                        // VncAuth: 读 16B challenge
        }
      }
      if (stage === 'challenge') {
        if (buf.length < 16) return;
        challenge = buf.subarray(0, 16);
        buf = buf.subarray(16);
        const resp = vncAuthResponse(password, challenge);
        upstream.write(resp);     // 16 字节响应;密码绝不出服务端
        stage = 'secresult';
      }
      if (stage === 'secresult') {
        if (buf.length < 4) return;
        const result = buf.readUInt32BE(0);
        buf = buf.subarray(4);
        if (result !== 0) {
          // 3.8: 失败可附原因串
          if (buf.length >= 4) {
            const rl = buf.readUInt32BE(0);
            if (buf.length >= 4 + rl) throw new Error('VncAuth failed: ' + buf.subarray(4, 4 + rl).toString('utf8'));
          }
          throw new Error('VncAuth failed (SecurityResult=' + result + ')');
        }
        stage = 'done';
        cleanup();
        resolve(buf); // 残留字节(一般为空)留给透传阶段
      }
    }
  });
}

// ── RFB 服务端侧: 面板 <-> 浏览器 的握手(面板作 RFB 服务端,给 None)──────────
// 回调式状态机(WS 帧层会持续喂字节进来):面板作服务端先发版本,读浏览器版本,
// 发 security-types=[None],读浏览器选择,发 SecurityResult=OK,之后 ClientInit 起透传。
function makeServerHandshaker(sendToBrowser, onDone) {
  let stage = 'version';
  let pending = Buffer.alloc(0);
  let done = false;
  sendToBrowser(Buffer.from('RFB 003.008\n', 'ascii'));
  function pump() {
    if (stage === 'version') {
      if (pending.length < 12) return;
      // 对称校验浏览器版本串(与客户端侧对 x11vnc 的校验一致):畸形输入抛错,
      // 由 parser.push 的 try/catch 兜住 closeAll,行为可预期(不进入奇怪状态分支)。
      const bver = pending.subarray(0, 12).toString('ascii');
      if (!/^RFB \d{3}\.\d{3}\n$/.test(bver)) throw new Error('bad browser RFB version: ' + JSON.stringify(bver));
      pending = pending.subarray(12);
      sendToBrowser(Buffer.from([0x01, 0x01])); // 1 个类型: None
      stage = 'sectype';
    }
    if (stage === 'sectype') {
      if (pending.length < 1) return;
      const sel = pending[0];
      pending = pending.subarray(1);
      if (sel !== 1) throw new Error('browser selected non-None security type: ' + sel);
      sendToBrowser(Buffer.from([0, 0, 0, 0])); // SecurityResult OK
      stage = 'done';
      done = true;
      const leftover = pending;
      pending = Buffer.alloc(0);
      onDone(leftover);
    }
  }
  return {
    feed(chunk) {
      if (done) return chunk; // 已握完: 直接返回给调用方做透传
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      pump();
      return null;
    },
    isDone() { return done; },
  };
}

// ── 网关入口: 在 server 'upgrade' 事件里调用 ─────────────────────────────────
// 鉴权由调用方先做(传入已通过);这里只负责协议桥接。
export function handleVncUpgrade(req, socket, head, opts) {
  const { vncHost = '127.0.0.1', vncPort = 5900, password, log = () => {} } = opts || {};

  if (!wsHandshake(socket, req)) return;
  socket.setNoDelay(true);

  let upstream = null;
  let closed = false;
  let serverShake = null;
  let upstreamReady = false;          // x11vnc 握手是否完成
  let browserShakeDone = false;       // 浏览器 None 握手是否完成
  const browserToUpstreamQueue = [];  // 浏览器握完前到的 RFB 字节(ClientInit 等)先缓存
  const upstreamPreInit = [];         // 浏览器还没握完时,x11vnc 来的字节缓存(声明前置,消除 TDZ)

  function closeAll(reason) {
    if (closed) return;
    closed = true;
    log('vncgw close: ' + (reason || ''));
    try { socket.end(); } catch {}
    try { socket.destroy(); } catch {}
    if (upstream) { try { upstream.destroy(); } catch {} }
  }

  // 背压: socket.write 返回 false 表示内核/Node 写缓冲已满,暂停上游读,'drain' 后恢复。
  // 防慢浏览器(隧道/弱网)时 x11vnc->浏览器方向的写缓冲在服务端无界堆积拖垮常驻面板。
  const sendToBrowser = (buf) => {
    if (closed) return;
    try {
      const ok = socket.write(encodeFrame(buf, 0x2));
      if (!ok && upstream && !upstream.destroyed) upstream.pause();
    } catch (e) { closeAll('browser write: ' + e.message); }
  };

  // 1) 连 x11vnc 并完成客户端侧 VncAuth 握手
  upstream = net.connect(vncPort, vncHost, () => { upstream.setNoDelay(true); });
  upstream.on('error', (e) => closeAll('upstream error: ' + e.message));
  upstream.on('close', () => closeAll('upstream closed'));
  // 浏览器写缓冲排空 -> 恢复上游读(背压回环: x11vnc->浏览器方向)
  socket.on('drain', () => { if (!closed && upstream && !upstream.destroyed) upstream.resume(); });
  // 上游写缓冲排空 -> 恢复浏览器侧读(背压回环: 浏览器->x11vnc 方向)
  upstream.on('drain', () => { if (!closed && !socket.destroyed) socket.resume(); });

  rfbClientHandshake(upstream, password, log).then((leftover) => {
    upstreamReady = true;
    log('vncgw: upstream RFB authed (ServerInit phase reachable)');
    // x11vnc 握手后残留字节(ServerInit 等)先发给浏览器(若浏览器已握完)
    if (leftover && leftover.length) {
      if (browserShakeDone) sendToBrowser(leftover);
      else upstreamPreInit.push(leftover);
    }
    // 之后 x11vnc 的所有字节直透浏览器
    upstream.on('data', (chunk) => {
      if (browserShakeDone) sendToBrowser(chunk);
      else upstreamPreInit.push(chunk);
    });
    flushIfReady();
  }).catch((e) => closeAll('upstream handshake failed: ' + e.message));

  // 2) 浏览器侧: WS 帧 -> RFB 字节;先跑 None 握手,再透传
  serverShake = makeServerHandshaker(sendToBrowser, (browserLeftover) => {
    browserShakeDone = true;
    log('vncgw: browser None handshake done');
    // 浏览器握手后的字节(ClientInit 等)若 upstream 已就绪则转发,否则排队
    if (browserLeftover && browserLeftover.length) queueToUpstream(browserLeftover);
    flushIfReady();
  });

  function queueToUpstream(buf) {
    if (upstreamReady && upstream && !upstream.destroyed) {
      // 背压: upstream.write 返回 false -> 暂停浏览器侧读,upstream 'drain' 后恢复。
      try { if (!upstream.write(buf)) socket.pause(); } catch (e) { closeAll('upstream write: ' + e.message); }
    } else {
      browserToUpstreamQueue.push(buf);
    }
  }

  function flushIfReady() {
    if (upstreamReady) {
      while (browserToUpstreamQueue.length) {
        const b = browserToUpstreamQueue.shift();
        try { if (!upstream.write(b)) socket.pause(); } catch (e) { return closeAll('upstream flush: ' + e.message); }
      }
    }
    if (browserShakeDone) {
      while (upstreamPreInit.length) sendToBrowser(upstreamPreInit.shift());
    }
  }

  const parser = new WsFrameParser({
    onData: (rfbBytes) => {
      // 浏览器握手未完时,先喂握手机;返回非 null 表示已握完、字节应直透 upstream
      if (!serverShake.isDone()) {
        const passthrough = serverShake.feed(rfbBytes);
        if (passthrough) queueToUpstream(passthrough);
      } else {
        queueToUpstream(rfbBytes);
      }
    },
    onClose: () => closeAll('browser ws close'),
    onPing: (payload) => { if (!closed) { try { socket.write(encodeFrame(payload, 0xA)); } catch {} } },
  });

  // 若握手刚发完版本就有数据(罕见),flush 一次
  flushIfReady();

  // 'upgrade' 事件里 Node 可能把 HTTP 升级请求之后、同一 TCP 段里多读到的字节放进 head
  // (抢跑客户端/TLS 终止代理把 WS 帧 pipeline 进来)。必须在注册 'data' 监听前喂给 parser,
  // 否则这些帧会被静默吞掉、表现为握手卡死。在 parser 构造之后调用。
  if (head && head.length) {
    try { parser.push(head); } catch (e) { closeAll('ws parse(head): ' + e.message); }
  }

  socket.on('data', (chunk) => { try { parser.push(chunk); } catch (e) { closeAll('ws parse: ' + e.message); } });
  socket.on('error', (e) => closeAll('socket error: ' + e.message));
  socket.on('close', () => closeAll('socket closed'));
  socket.on('end', () => closeAll('socket end'));
}

// 测试辅助: 暴露内部用于单测
export const _internal = { encodeFrame, WsFrameParser, wsAcceptKey };
