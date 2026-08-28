// Vendored from devbox-chrome-cdp for standalone dsh.bundle packaging.
// Upstream design: server-side VNC authentication; password never reaches the browser.
// vncdes.mjs —— 纯 JS DES(ECB,单 block 加密),零依赖,专供 VNC VncAuth 挑战响应。
//
// 为什么自己实现 DES:
//  - Node 24 默认 OpenSSL provider 不带 legacy DES('des-ecb' createCipheriv 报
//    "digital envelope routines::unsupported");靠 --openssl-legacy-provider 全局 flag
//    既脆弱(启动器必须记得带)又是进程级副作用。VncAuth 只需要一次性 ECB 加密 16 字节
//    挑战(两个 8 字节 block),纯 JS 实现最自洽、与启动方式解耦。
//
// VncAuth 算法(RFB 3.x):
//  - key = 密码取前 8 字节,不足补 0x00。
//  - VNC 的历史怪癖: 把 key 的每个字节做【位反转】(bit0<->bit7 ...)再当 DES key 用。
//  - 用该 key 以 DES-ECB(no padding)加密服务端发来的 16 字节 challenge -> 16 字节响应。
//
// 本文件实现标准 FIPS 46-3 DES 单 block(8 字节 in -> 8 字节 out)加密。

// 置换/移位表(标准 DES)
const PC1 = [
  57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18,
  10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36,
  63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22,
  14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4,
];
const PC2 = [
  14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10,
  23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48,
  44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const IP = [
  58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];
const FP = [
  40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];
const E = [
  32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11,
  12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21,
  22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];
const P = [
  16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];
const SBOX = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
    0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
    15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
    3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
    13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
    13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
    1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
    13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
    3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
    14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
    11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
    10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
    4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
    13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
    6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
    1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
    2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

// 把 8 字节 buffer 转成 64 位的 bit 数组(MSB first)
function bytesToBits(buf) {
  const bits = new Array(buf.length * 8);
  for (let i = 0; i < buf.length; i++) {
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (buf[i] >> (7 - b)) & 1;
  }
  return bits;
}
function bitsToBytes(bits) {
  const out = Buffer.alloc(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    out[i] = v;
  }
  return out;
}
function permute(input, table) {
  const out = new Array(table.length);
  for (let i = 0; i < table.length; i++) out[i] = input[table[i] - 1];
  return out;
}
function leftShift(arr, n) {
  const len = arr.length;
  const out = new Array(len);
  for (let i = 0; i < len; i++) out[i] = arr[(i + n) % len];
  return out;
}

// 由 8 字节 key 生成 16 个 48 位子密钥
function keySchedule(keyBuf) {
  const keyBits = bytesToBits(keyBuf);
  const pc1 = permute(keyBits, PC1); // 56 bit
  let c = pc1.slice(0, 28);
  let d = pc1.slice(28, 56);
  const sub = [];
  for (let r = 0; r < 16; r++) {
    c = leftShift(c, SHIFTS[r]);
    d = leftShift(d, SHIFTS[r]);
    sub.push(permute(c.concat(d), PC2)); // 48 bit
  }
  return sub;
}

function feistel(rBits, subKey) {
  const expanded = permute(rBits, E); // 48 bit
  const xored = new Array(48);
  for (let i = 0; i < 48; i++) xored[i] = expanded[i] ^ subKey[i];
  const sout = new Array(32);
  for (let box = 0; box < 8; box++) {
    const o = box * 6;
    const row = (xored[o] << 1) | xored[o + 5];
    const col = (xored[o + 1] << 3) | (xored[o + 2] << 2) | (xored[o + 3] << 1) | xored[o + 4];
    const val = SBOX[box][row * 16 + col];
    sout[box * 4] = (val >> 3) & 1;
    sout[box * 4 + 1] = (val >> 2) & 1;
    sout[box * 4 + 2] = (val >> 1) & 1;
    sout[box * 4 + 3] = val & 1;
  }
  return permute(sout, P); // 32 bit
}

// 加密单个 8 字节 block
function desEncryptBlock(blockBuf, subKeys) {
  const bits = permute(bytesToBits(blockBuf), IP);
  let l = bits.slice(0, 32);
  let r = bits.slice(32, 64);
  for (let round = 0; round < 16; round++) {
    const f = feistel(r, subKeys[round]);
    const newR = new Array(32);
    for (let i = 0; i < 32; i++) newR[i] = l[i] ^ f[i];
    l = r;
    r = newR;
  }
  // 最终 32 位互换: preoutput = R16 L16
  const preout = r.concat(l);
  return bitsToBytes(permute(preout, FP));
}

// VNC key 位反转(每字节 bit0<->bit7 ...)
function reverseBits(byte) {
  let r = 0;
  for (let i = 0; i < 8; i++) r |= ((byte >> i) & 1) << (7 - i);
  return r;
}

// VncAuth: 用密码做 16 字节 challenge 的响应(2 个 DES block,共用同一 key)
export function vncAuthResponse(password, challenge) {
  if (challenge.length !== 16) throw new Error('VNC challenge must be 16 bytes');
  const key = Buffer.alloc(8, 0);
  // password 可能是 string(生产: 读密码文件首行)或 Buffer(测试/调用方传 raw)。
  // string 按 latin1 取字节;Buffer 直接用其字节 —— 绝不经 String(Buffer)(会触发 UTF-8 解码毁字节)。
  const pw = Buffer.isBuffer(password) ? password : Buffer.from(String(password), 'latin1');
  for (let i = 0; i < 8 && i < pw.length; i++) key[i] = pw[i];
  // VNC 怪癖: key 每字节位反转
  const desKey = Buffer.alloc(8);
  for (let i = 0; i < 8; i++) desKey[i] = reverseBits(key[i]);
  const subKeys = keySchedule(desKey);
  const out = Buffer.alloc(16);
  desEncryptBlock(challenge.subarray(0, 8), subKeys).copy(out, 0);
  desEncryptBlock(challenge.subarray(8, 16), subKeys).copy(out, 8);
  return out;
}

// 直接暴露单 block 加密(供自测对拍 OpenSSL des-ecb 用)
export function desEcbEncrypt(keyBuf, dataBuf) {
  const subKeys = keySchedule(keyBuf);
  const out = Buffer.alloc(dataBuf.length);
  for (let off = 0; off < dataBuf.length; off += 8) {
    desEncryptBlock(dataBuf.subarray(off, off + 8), subKeys).copy(out, off);
  }
  return out;
}
