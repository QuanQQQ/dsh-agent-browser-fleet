import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { chromium, type Page } from 'playwright-core'
import { CdpClient } from '../src/cdp.js'
import { ProfileCloner } from '../src/profile-cloner.js'
import { DevboxChromeRuntime } from '../src/runtime.js'

const root = resolve(process.env.AGENT_BROWSER_FLEET_EXPERIMENT_ROOT ?? '.experiment/latest')
const template = resolve(root, 'template-profile')
const snapshot = resolve(root, 'template-snapshot')
const slotA = resolve(root, 'slot-a-profile')
const slotB = resolve(root, 'slot-b-profile')
const suffix = String(process.pid)
const templateInstance = 'abf-exp-t-' + suffix
const instanceA = 'abf-exp-a-' + suffix
const instanceB = 'abf-exp-b-' + suffix
const cdp = new CdpClient()
const runtime = new DevboxChromeRuntime(cdp)
const cloner = new ProfileCloner()
const started: Array<{ name: string; profile: string }> = []
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), instances: [templateInstance, instanceA, instanceB] }

await cloner.remove(root)
await mkdir(root, { recursive: true })
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  if (req.url === '/login') {
    res.end("<!doctype html><title>Identity login</title><h1>Logged in</h1><script>localStorage.setItem('identity','template-user');document.cookie='session=template-token; Max-Age=86400; SameSite=Lax';document.body.dataset.ready='yes'</script>")
  } else {
    res.end("<!doctype html><title>Identity state</title><h1>Identity state</h1><script>document.body.dataset.identity=localStorage.getItem('identity')||''</script>")
  }
})
await new Promise<void>((resolvePromise, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolvePromise())
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('experiment server did not bind TCP')
const origin = 'http://127.0.0.1:' + address.port

try {
  const doctor = await runtime.doctor()
  assert.equal(doctor.ok, true, doctor.output)
  report.doctor = doctor.output

  const templateRuntime = await runtime.start(templateInstance, template, origin + '/login')
  started.push({ name: templateInstance, profile: template })
  const templatePage = await browserPage(templateRuntime.ports.cdp)
  await templatePage.goto(origin + '/login')
  const templateState = await browserState(templatePage)
  assert.deepEqual(templateState, { identity: 'template-user', session: true, slot: '' })
  report.templateLoginState = templateState

  await runtime.cleanStop(templateInstance, template)
  started.splice(started.findIndex((item) => item.name === templateInstance), 1)
  const localState = await readFile(resolve(template, 'Local State'))
  assert.ok(localState.length > 0)
  const snapshotCopy = await cloner.copy(template, snapshot)
  await cloner.makeReadOnly(snapshot)
  assert.deepEqual(await readFile(resolve(snapshot, 'Local State')), localState)
  report.snapshot = { cloneMode: snapshotCopy.mode, localStateBytes: localState.length, disk: await diskUsage(snapshot) }

  const [copyA, copyB] = await Promise.all([cloner.copy(snapshot, slotA), cloner.copy(snapshot, slotB)])
  await Promise.all([cloner.makeOwnerWritable(slotA), cloner.makeOwnerWritable(slotB)])
  report.slotCloneModes = { a: copyA.mode, b: copyB.mode }

  const [runtimeA, runtimeB] = await Promise.all([
    runtime.start(instanceA, slotA, origin + '/state'),
    runtime.start(instanceB, slotB, origin + '/state'),
  ])
  started.push({ name: instanceA, profile: slotA }, { name: instanceB, profile: slotB })
  assert.equal(runtimeA.loopbackVerified, true)
  assert.equal(runtimeB.loopbackVerified, true)
  const [pageA, pageB] = await Promise.all([browserPage(runtimeA.ports.cdp), browserPage(runtimeB.ports.cdp)])
  await Promise.all([pageA.goto(origin + '/state'), pageB.goto(origin + '/state')])
  const initial = await Promise.all([browserState(pageA), browserState(pageB)])
  assert.deepEqual(initial[0], { identity: 'template-user', session: true, slot: '' })
  assert.deepEqual(initial[1], { identity: 'template-user', session: true, slot: '' })

  await Promise.all([
    pageA.evaluate(() => { localStorage.setItem('slot', 'A'); document.cookie = 'slot=A' }),
    pageB.evaluate(() => { localStorage.setItem('slot', 'B'); document.cookie = 'slot=B' }),
  ])
  await Promise.all([pageA.reload(), pageB.reload()])
  const isolated = await Promise.all([browserState(pageA), browserState(pageB)])
  assert.equal(isolated[0].slot, 'A')
  assert.equal(isolated[1].slot, 'B')
  report.concurrent = { initial, afterIndependentMutation: isolated }
  report.cost = {
    disk: { template: await diskUsage(template), snapshot: await diskUsage(snapshot), slotA: await diskUsage(slotA), slotB: await diskUsage(slotB) },
    rssKiB: { slotA: await profileRss(slotA), slotB: await profileRss(slotB) },
  }
  report.ports = { a: runtimeA.ports, b: runtimeB.ports, allLoopback: runtimeA.loopbackVerified && runtimeB.loopbackVerified }

  await Promise.all([runtime.cleanStop(instanceA, slotA), runtime.cleanStop(instanceB, slotB)])
  started.length = 0
  const [restartA, restartB] = await Promise.all([
    runtime.start(instanceA, slotA, origin + '/state'),
    runtime.start(instanceB, slotB, origin + '/state'),
  ])
  started.push({ name: instanceA, profile: slotA }, { name: instanceB, profile: slotB })
  const [restartPageA, restartPageB] = await Promise.all([browserPage(restartA.ports.cdp), browserPage(restartB.ports.cdp)])
  await Promise.all([restartPageA.goto(origin + '/state'), restartPageB.goto(origin + '/state')])
  const restarted = await Promise.all([browserState(restartPageA), browserState(restartPageB)])
  assert.equal(restarted[0].slot, 'A')
  assert.equal(restarted[1].slot, 'B')
  report.restartPersistence = restarted
  report.externalLimit = 'Website single-session policies and token rotation are external constraints; this experiment verifies browser-profile cookie/localStorage persistence and isolation only.'
  report.ok = true
} catch (error) {
  report.ok = false
  report.error = error instanceof Error ? error.stack ?? error.message : String(error)
  throw error
} finally {
  await Promise.all(started.map((item) => runtime.forceStop(item.name, item.profile).catch(() => undefined)))
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  report.finishedAt = new Date().toISOString()
  await writeFile(resolve(root, 'experiment-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}

async function browserPage(port: number): Promise<Page> {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
  const context = browser.contexts()[0]
  if (!context) throw new Error('Playwright found no browser context')
  return context.pages()[0] ?? context.newPage()
}

async function browserState(page: Page): Promise<{ identity: string; session: boolean; slot: string }> {
  return page.evaluate(() => ({
    identity: localStorage.getItem('identity') || '',
    session: document.cookie.includes('session=template-token'),
    slot: localStorage.getItem('slot') || '',
  }))
}

async function diskUsage(path: string): Promise<{ apparentBytes: number; allocatedBytes: number }> {
  const apparent = await command('du', ['-sb', '--', path])
  const allocated = await command('du', ['-sB1', '--', path])
  return { apparentBytes: Number(apparent.trim().split(/\s+/, 1)[0]), allocatedBytes: Number(allocated.trim().split(/\s+/, 1)[0]) }
}

async function profileRss(profile: string): Promise<number> {
  const output = await command('ps', ['-eo', 'rss=,args='])
  return output.split(/\r?\n/).reduce((sum, line) => line.includes('--user-data-dir=' + profile) ? sum + Number(line.trim().split(/\s+/, 1)[0] || 0) : sum, 0)
}

function command(file: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => execFile(file, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolvePromise(String(stdout))))
}
