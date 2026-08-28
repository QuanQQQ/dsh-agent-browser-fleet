import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CloneMode } from './domain.js'

export interface CopyResult { mode: CloneMode }
export interface CommandResult { code: number; stdout: string; stderr: string }
export type CommandRunner = (file: string, args: readonly string[], options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<CommandResult>

export class ProfileCloner {
  constructor(private readonly run: CommandRunner = runCommand) {}

  async copy(source: string, destination: string, signal?: AbortSignal): Promise<CopyResult> {
    const sourceStat = await stat(source)
    if (!sourceStat.isDirectory()) throw new Error('profile source is not a directory')
    await removeTree(destination)
    await mkdir(destination, { recursive: true, mode: 0o700 })
    const reflink = await this.run('cp', ['-a', '--reflink=always', '--', source + '/.', destination], { signal, timeoutMs: 120_000 })
    if (reflink.code === 0) return { mode: 'reflink' }

    await removeTree(destination)
    await mkdir(destination, { recursive: true, mode: 0o700 })
    const copied = await this.run('cp', ['-a', '--reflink=never', '--', source + '/.', destination], { signal, timeoutMs: 300_000 })
    if (copied.code !== 0) {
      await removeTree(destination)
      throw new Error('profile copy failed after reflink fallback: ' + (copied.stderr || copied.stdout || 'cp failed'))
    }
    return { mode: 'copy' }
  }

  async makeReadOnly(root: string): Promise<void> { await chmodTree(root, false) }
  async makeOwnerWritable(root: string): Promise<void> { await chmodTree(root, true) }
  async remove(root: string): Promise<void> { await removeTree(root) }
}

async function removeTree(path: string): Promise<void> {
  try { await chmodTree(path, true) }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  await rm(path, { recursive: true, force: true })
}

async function chmodTree(path: string, writable: boolean): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink()) return
  if (info.isDirectory()) {
    if (writable) await chmod(path, 0o700)
    for (const child of await readdir(path)) await chmodTree(join(path, child), writable)
    if (!writable) await chmod(path, 0o500)
    return
  }
  await chmod(path, writable ? 0o600 : 0o400)
}

export function runCommand(file: string, args: readonly string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(file, [...args], {
      signal: options.signal,
      timeout: options.timeoutMs ?? 120_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error instanceof Error ? error.message : '')) })
    })
  })
}
