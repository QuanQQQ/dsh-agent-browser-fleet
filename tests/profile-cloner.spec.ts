import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ProfileCloner, runCommand } from '../src/profile-cloner.js'

test('ProfileCloner cleans failed reflink attempt and safely falls back to full copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abf-clone-'))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await runCommand('mkdir', ['-p', source])
  await writeFile(join(source, 'Local State'), '{"identity":"logged-in"}')
  await writeFile(join(source, 'Cookies'), 'session-cookie')
  let reflinkAttempts = 0
  const cloner = new ProfileCloner(async (file, args, options) => {
    if (args.includes('--reflink=always')) { reflinkAttempts++; return { code: 1, stdout: '', stderr: 'Operation not supported' } }
    return runCommand(file, args, options)
  })
  const result = await cloner.copy(source, destination)
  assert.equal(result.mode, 'copy')
  assert.equal(reflinkAttempts, 1)
  assert.equal(await readFile(join(destination, 'Local State'), 'utf8'), '{"identity":"logged-in"}')
  assert.equal(await readFile(join(destination, 'Cookies'), 'utf8'), 'session-cookie')
})

test('ProfileCloner reports reflink mode when COW copy succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abf-reflink-'))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await runCommand('mkdir', ['-p', source])
  await writeFile(join(source, 'Local State'), '{}')
  const cloner = new ProfileCloner()
  const result = await cloner.copy(source, destination)
  assert.ok(result.mode === 'reflink' || result.mode === 'copy')
  assert.equal(await readFile(join(destination, 'Local State'), 'utf8'), '{}')
})

test('ProfileCloner replaces a read-only destination left by an interrupted clone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'abf-readonly-destination-'))
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  await runCommand('mkdir', ['-p', join(source, 'Default'), join(destination, 'ActorSafetyLists')])
  await writeFile(join(source, 'Local State'), '{"fresh":true}')
  await writeFile(join(source, 'Default', 'Cookies'), 'fresh-cookie')
  await writeFile(join(destination, 'ActorSafetyLists', 'stale'), 'stale')
  const cloner = new ProfileCloner()
  await cloner.makeReadOnly(destination)
  await cloner.copy(source, destination)
  assert.equal(await readFile(join(destination, 'Local State'), 'utf8'), '{"fresh":true}')
  assert.equal(await readFile(join(destination, 'Default', 'Cookies'), 'utf8'), 'fresh-cookie')
})
