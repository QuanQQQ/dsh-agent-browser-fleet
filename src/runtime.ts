import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserPorts } from './domain.js'
import { CdpClient } from './cdp.js'

const RUNTIME_BIN = fileURLToPath(new URL('../runtime-bin/', import.meta.url))

export interface RuntimeCommandResult { code: number; stdout: string; stderr: string }
export type RuntimeCommandRunner = (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }) => Promise<RuntimeCommandResult>

export interface RuntimeStatus {
  running: boolean
  ports: BrowserPorts
  loopbackVerified: boolean
}

export class DevboxChromeRuntime {
  private stackTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly cdp: CdpClient,
    private readonly run: RuntimeCommandRunner = runRuntimeCommand,
    private readonly baseEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  async doctor(signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
    const result = await this.run('devbox-chrome-debug', ['doctor'], { env: this.safeEnv(), signal, timeoutMs: 60_000 })
    return { ok: result.code === 0, output: (result.stdout + result.stderr).trim() }
  }

  async resolvePorts(instanceName: string, signal?: AbortSignal): Promise<BrowserPorts> {
    assertInstanceName(instanceName)
    const result = await this.run('devbox-chrome-debug', ['-i', instanceName, 'env'], {
      env: this.safeEnv(), signal, timeoutMs: 10_000,
    })
    if (result.code !== 0) throw new Error('cannot resolve runtime ports: ' + (result.stderr || result.stdout))
    const match = /CHROME_CDP_PORT='(\d+)'/.exec(result.stdout)
    if (!match) throw new Error('devbox-chrome-debug env did not return CHROME_CDP_PORT')
    const cdp = Number(match[1])
    const slot = cdp - 9222
    if (!Number.isInteger(slot) || slot < 1 || slot > 50_000) throw new Error('invalid runtime slot derived from CDP ' + cdp)
    return { cdp, vnc: 5900 + slot, novnc: 6080 + slot, whistle: 8899 + slot, display: 99 + slot }
  }

  async start(instanceName: string, profilePath: string, url = 'about:blank', signal?: AbortSignal): Promise<RuntimeStatus> {
    return this.withStackLock(() => this.startUnlocked(instanceName, profilePath, url, signal))
  }

  private async startUnlocked(instanceName: string, profilePath: string, url: string, signal?: AbortSignal): Promise<RuntimeStatus> {
    assertInstanceName(instanceName)
    if (!isAbsolute(profilePath)) throw new Error('runtime profile path must be absolute')
    const ports = await this.resolvePorts(instanceName, signal)
    const result = await this.run('devbox-chrome-debug', ['-i', instanceName, 'start', url], {
      env: this.safeEnv(profilePath), signal, timeoutMs: 60_000,
    })
    if (result.code !== 0) throw new Error('browser runtime start failed: ' + (result.stderr || result.stdout))
    if (!await this.cdp.isReady(ports.cdp)) throw new Error('browser runtime started without a reachable CDP endpoint')
    let listenerStatus = await this.inspectListeners(ports, signal)
    const listenerDeadline = Date.now() + 3_000
    while (listenerStatus === 'missing' && Date.now() < listenerDeadline) {
      await delay(100, signal)
      listenerStatus = await this.inspectListeners(ports, signal)
    }
    const loopbackVerified = listenerStatus === 'verified'
    if (!loopbackVerified) {
      await this.forceStopUnlocked(instanceName, profilePath).catch(() => undefined)
      throw new Error('browser runtime required loopback-only listeners are missing or exposed outside loopback')
    }
    return { running: true, ports, loopbackVerified }
  }

  private async withStackLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.stackTail
    let release!: () => void
    this.stackTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await work() }
    finally { release() }
  }

  async status(instanceName: string, signal?: AbortSignal): Promise<RuntimeStatus> {
    const ports = await this.resolvePorts(instanceName, signal)
    return { running: await this.cdp.isReady(ports.cdp), ports, loopbackVerified: await this.inspectListeners(ports, signal) === 'verified' }
  }

  async cleanStop(instanceName: string, profilePath: string, signal?: AbortSignal): Promise<BrowserPorts> {
    const ports = await this.resolvePorts(instanceName, signal)
    if (!await this.cdp.isReady(ports.cdp)) {
      throw new Error('cannot prove a clean Chromium shutdown because CDP was already unreachable')
    }
    try { await this.cdp.closeBrowser(ports.cdp, signal) } catch (error) {
      if (await this.cdp.isReady(ports.cdp)) throw error
    }
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && await this.cdp.isReady(ports.cdp)) await delay(200, signal)
    if (await this.cdp.isReady(ports.cdp)) throw new Error('Chromium did not close cleanly before snapshot deadline')
    const result = await this.withStackLock(() => this.run('devbox-chrome-debug', ['-i', instanceName, 'stop'], {
      env: this.safeEnv(profilePath), signal, timeoutMs: 30_000,
    }))
    if (result.code !== 0) throw new Error('browser runtime stack stop failed: ' + (result.stderr || result.stdout))
    if (await this.cdp.isReady(ports.cdp)) throw new Error('CDP remained reachable after browser runtime stop')
    return ports
  }

  async forceStop(instanceName: string, profilePath: string): Promise<void> {
    await this.withStackLock(() => this.forceStopUnlocked(instanceName, profilePath))
  }

  private async forceStopUnlocked(instanceName: string, profilePath: string): Promise<void> {
    await this.run('devbox-chrome-debug', ['-i', instanceName, 'stop'], {
      env: this.safeEnv(profilePath), timeoutMs: 30_000,
    })
  }

  async vncPassword(instanceName: string): Promise<string> {
    assertInstanceName(instanceName)
    const runtimeRoot = this.baseEnv.XDG_RUNTIME_DIR || '/tmp'
    const user = this.baseEnv.USER || 'user'
    const file = join(runtimeRoot, 'devbox-chrome-debug-' + user, 'inst', instanceName, 'vnc-password')
    const value = (await readFile(file, 'utf8')).split(/\r?\n/, 1)[0]
    if (!value) throw new Error('VNC password is missing')
    return value
  }

  private safeEnv(profilePath?: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...this.baseEnv }
    for (const key of [
      'CHROME_INSTANCE', 'CHROME_DEBUG_PORT', 'CHROME_VNC_PORT', 'CHROME_NOVNC_PORT', 'CHROME_DISPLAY',
      'CHROME_PROXY', 'CHROME_PROXY_BYPASS_LIST', 'CHROME_EXTRA_ARGS', 'CHROME_VNC_NOPW', 'CHROME_VNC_PASSWD',
      'WHISTLE_BIND', 'WHISTLE_PORT', 'WHISTLE_RULES', 'WHISTLE_USER', 'WHISTLE_PASS',
    ]) delete env[key]
    env.PATH = RUNTIME_BIN + delimiter + (env.PATH ?? '')
    env.DEVBOX_CHROME_CONFIG = '/dev/null'
    env.CHROME_NOVNC_BIND = '127.0.0.1'
    env.WHISTLE_BIND = '127.0.0.1'
    if (profilePath) env.CHROME_USER_DATA_DIR = profilePath
    else delete env.CHROME_USER_DATA_DIR
    return env
  }

  private async inspectListeners(ports: BrowserPorts, signal?: AbortSignal): Promise<'verified' | 'missing' | 'unsafe'> {
    const result = await this.run('ss', ['-ltnH'], { env: this.safeEnv(), signal, timeoutMs: 5_000 })
    if (result.code !== 0) return 'missing'
    const lines = result.stdout.split(/\r?\n/)
    const rowsFor = (port: number) => {
      const match = new RegExp(':' + port + '\\s')
      return lines.filter((line) => match.test(line + ' '))
    }
    let missing = false
    for (const port of [ports.cdp, ports.vnc, ports.novnc]) {
      const rows = rowsFor(port)
      if (rows.some((line) => !/127\.0\.0\.1:|\[::1\]:/.test(line))) return 'unsafe'
      if (rows.length === 0) missing = true
    }
    const whistleRows = rowsFor(ports.whistle)
    if (whistleRows.some((line) => !/127\.0\.0\.1:|\[::1\]:/.test(line))) return 'unsafe'
    return missing ? 'missing' : 'verified'
  }
}

export function runRuntimeCommand(file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs: number }): Promise<RuntimeCommandResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], { env: options.env, signal: options.signal, timeout: options.timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error instanceof Error ? error.message : '')) })
    })
  })
}

function assertInstanceName(value: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(value)) throw new Error('unsafe browser instance name: ' + value)
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}
