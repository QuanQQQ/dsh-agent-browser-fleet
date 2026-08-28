import { writeFile } from 'node:fs/promises'

interface CdpResponse {
  id?: number
  result?: Record<string, unknown>
  error?: { message?: string }
}

/** Minimal lifecycle/observation CDP client. Agent automation belongs to Playwright MCP. */
export class CdpClient {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async isReady(port: number): Promise<boolean> {
    try {
      const response = await this.fetchImpl('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1_500) })
      return response.ok
    } catch { return false }
  }

  async browserWebSocketUrl(port: number): Promise<string> {
    const response = await this.fetchImpl('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(3_000) })
    if (!response.ok) throw new Error('CDP version endpoint returned ' + response.status)
    const value = await response.json() as { webSocketDebuggerUrl?: unknown }
    if (typeof value.webSocketDebuggerUrl !== 'string') throw new Error('CDP browser websocket URL is missing')
    return value.webSocketDebuggerUrl
  }

  async closeBrowser(port: number, signal?: AbortSignal): Promise<void> {
    const wsUrl = await this.browserWebSocketUrl(port)
    await withCdpSocket(wsUrl, signal, async (call) => { await call('Browser.close') })
  }

  async captureToFile(port: number, file: string, signal?: AbortSignal): Promise<void> {
    const target = await this.pageTarget(port)
    const screenshotBase64 = await withCdpSocket(target.webSocketDebuggerUrl, signal, async (call) => {
      await call('Page.enable')
      const result = await call('Page.captureScreenshot', { format: 'png', fromSurface: true })
      const data = result.data
      if (typeof data !== 'string') throw new Error('CDP screenshot returned no data')
      return data
    })
    await writeFile(file, Buffer.from(screenshotBase64, 'base64'), { mode: 0o600 })
  }

  private async pageTarget(port: number): Promise<{ webSocketDebuggerUrl: string }> {
    let response = await this.fetchImpl('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(3_000) })
    if (!response.ok) throw new Error('CDP target list returned ' + response.status)
    let targets = await response.json() as Array<{ type?: unknown; webSocketDebuggerUrl?: unknown }>
    let target = targets.find((candidate) => candidate.type === 'page' && typeof candidate.webSocketDebuggerUrl === 'string')
    if (!target) {
      response = await this.fetchImpl('http://127.0.0.1:' + port + '/json/new?about%3Ablank', { method: 'PUT', signal: AbortSignal.timeout(3_000) })
      if (!response.ok) throw new Error('CDP could not create page target (' + response.status + ')')
      target = await response.json() as { type?: unknown; webSocketDebuggerUrl?: unknown }
    }
    if (typeof target.webSocketDebuggerUrl !== 'string') throw new Error('CDP page websocket URL is missing')
    return { webSocketDebuggerUrl: target.webSocketDebuggerUrl }
  }
}

async function withCdpSocket<T>(
  url: string,
  signal: AbortSignal | undefined,
  body: (call: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>) => Promise<T>,
): Promise<T> {
  const socket = new WebSocket(url)
  let nextId = 1
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP websocket open timed out')), 5_000)
    socket.onopen = () => { clearTimeout(timer); resolve() }
    socket.onerror = () => { clearTimeout(timer); reject(new Error('CDP websocket failed')) }
  })
  socket.onmessage = (event) => {
    let message: CdpResponse
    try { message = JSON.parse(String(event.data)) as CdpResponse } catch { return }
    if (message.id === undefined) return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    if (message.error) waiter.reject(new Error(message.error.message || 'CDP command failed'))
    else waiter.resolve(message.result ?? {})
  }
  socket.onclose = () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('CDP websocket closed'))
    }
    pending.clear()
  }
  const abort = () => socket.close()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await opened
    const call = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('CDP command timed out: ' + method))
      }, 10_000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params }))
    })
    return await body(call)
  } finally {
    signal?.removeEventListener('abort', abort)
    socket.close()
  }
}
