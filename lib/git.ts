import { readdir, realpath } from 'node:fs/promises'
import { exec } from './exec.ts'

/** Where and how long a git command runs; defaults: 30 seconds, 1 MiB of output. `timeout: 0` waits indefinitely. */
export type GitOptions = { cwd: string; timeout?: number; maxBuffer?: number; signal?: AbortSignal }

/** Another git process holds the index: a commit or status in the same checkout, usually gone within a second. */
const indexLocked = (error: unknown) =>
  error instanceof Error && /index\.lock'?: File exists/.test(error.message)

/**
 * Run git in `cwd` and return its trimmed stdout; a failure rejects with execFile's error, stderr in its message. A
 * held `index.lock` is waited out for up to about 3 seconds before its error stands.
 */
export async function git(cwd: string | GitOptions, ...args: string[]) {
  const options = typeof cwd === 'string' ? { cwd } : cwd
  for (let attempt = 1; ; attempt++) {
    try {
      const { stdout } = await exec('git', args, {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        ...options,
      })
      return stdout.trim()
    } catch (error) {
      if (attempt === 6 || !indexLocked(error) || options.signal?.aborted) throw error
      await new Promise((resolve) => setTimeout(resolve, attempt * 200))
    }
  }
}

export const noRepository = 'Isolation needs a Git repository'
export const noCommit = 'Isolation needs a first commit'

/** Whether the repository holding `cwd` (or `cwd` itself, outside Git) has nothing in it but `.git`. */
export async function empty(cwd: string) {
  const top = await git(cwd, 'rev-parse', '--show-toplevel').catch(
    // Outside Git the folder itself is what a new repository would hold.
    () => cwd,
  )
  return (await readdir(top)).every((name) => name === '.git')
}

/** The checkout and branch an isolate of `cwd` would branch from, or why there is none. */
export async function isolatable(
  cwd: string,
): Promise<{ source: string; target: string } | { reason: string }> {
  const top = await git(cwd, 'rev-parse', '--show-toplevel').catch(
    // Outside Git there is nothing to branch from; the reason says so.
    () => undefined,
  )
  if (!top) return { reason: noRepository }
  const source = await realpath(top)
  const target = await git(source, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => '')
  if (!target) return { reason: 'Isolation needs a checked-out branch' }
  if (!(await git(source, 'rev-parse', '--verify', '--quiet', 'HEAD').catch(() => '')))
    return { reason: noCommit }
  return { source, target }
}
