import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { exists } from './util.js'

export interface PreparedRepository {
  kind: 'url' | 'path'
  repository: string
  branch: string
  head?: string | undefined
}

function run(command: string, args: string[], cwd?: string, timeout = 120000): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  delete env.DEEPSEEK_API_KEY
  delete env.DEEPSEC_SCOPE_SIGNING_KEY
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${String(stderr).trim().split('\n').pop() || error.message}`))
      else resolve(stdout)
    })
  })
}

export function validateRepositoryAddress(input: string, allowFileForTests = false): 'url' | 'path' {
  if (/[\x00-\x1f\x7f]/.test(input)) throw new Error('远程地址不得包含控制字符')
  if (input.trim() === '') throw new Error('远程地址不能为空')
  if (input.trimStart().startsWith('-')) throw new Error('远程地址不得以 - 开头')
  const scp = /^([^/@\s]+)@(\[[^\]\s]+\]|[^:/\s\[\]]+):\S+$/.exec(input)
  if (scp !== null) {
    if (scp[1]!.includes(':')) throw new Error('远程地址不得包含用户名或密码')
    const user = scp[1]!.replace(/^\[|\]$/g, '')
    const host = scp[2]!.replace(/^\[|\]$/g, '')
    if (user.startsWith('-') || /^(?:%5b)?(?:-|%2d)/i.test(host)) throw new Error('远程地址的用户名或主机不得以 - 开头')
    return 'url'
  }
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input)) {
    if (!input.startsWith('/') && !input.startsWith('~/')) throw new Error('本机路径必须是绝对路径或以 ~/ 开头')
    return 'path'
  }
  const url = new URL(input)
  if ([url.hostname, url.username].some(part => decodeURIComponent(part).replace(/^\[|\]$/g, '').startsWith('-'))) throw new Error('远程地址的用户名或主机不得以 - 开头')
  const protocols = allowFileForTests ? ['https:', 'ssh:', 'file:'] : ['https:', 'ssh:']
  if (!protocols.includes(url.protocol)) throw new Error('远程地址只接受 https:、ssh: 或 scp 形式的 ssh 地址')
  if (url.username !== '' && !(url.protocol === 'ssh:' && url.password === '') || url.password !== '') throw new Error('远程地址不得包含用户名或密码')
  return 'url'
}

async function head(repository: string): Promise<string | undefined> {
  try {
    return (await run('git', ['-C', repository, 'rev-parse', 'HEAD'])).trim()
  } catch {
    return undefined
  }
}

async function defaultBranch(repository: string): Promise<string> {
  try {
    const reference = (await run('git', ['-C', repository, 'symbolic-ref', 'refs/remotes/origin/HEAD'])).trim()
    return reference.slice(reference.lastIndexOf('/') + 1)
  } catch {
    return (await run('git', ['-C', repository, 'symbolic-ref', '--short', 'HEAD'])).trim()
  }
}

async function remoteBranchExists(repository: string, branch: string): Promise<boolean> {
  try {
    await run('git', ['-C', repository, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
    return true
  } catch {
    return false
  }
}

export async function prepareRepository(input: string, stateDir: string, allowFileForTests = false): Promise<PreparedRepository> {
  const kind = validateRepositoryAddress(input, allowFileForTests)
  if (kind === 'path') {
    const repository = input.startsWith('~/') ? join(homedir(), input.slice(2)) : resolve(input)
    const branch = await defaultBranch(repository).catch(() => '')
    return { kind, repository, branch, ...(await head(repository) !== undefined ? { head: await head(repository) } : {}) }
  }
  const directory = clonePath(input, stateDir)
  if (!await exists(directory)) {
    await mkdir(dirname(directory), { recursive: true })
    await run('git', ['clone', '--', input, directory])
  }
  await run('git', ['-C', directory, 'fetch', '--prune', 'origin'])
  const branch = await defaultBranch(directory)
  if (await remoteBranchExists(directory, branch)) {
    try {
      await run('git', ['-C', directory, 'merge', '--ff-only', `origin/${branch}`])
    } catch {
      throw new Error('不能快进：本地有未推送提交且远端也有新提交。请先手动处理，不会 reset 或 force')
    }
  }
  return { kind, repository: directory, branch, ...(await head(directory) !== undefined ? { head: await head(directory) } : {}) }
}

function clonePath(input: string, stateDir: string): string {
  return join(stateDir, 'repositories', createHash('sha256').update(input).digest('hex'))
}

/** A sync repository as this machine last saw it, read without network access. */
export interface RepositoryStatus {
  kind: 'url' | 'path'
  /** Working copy to read; absent until the first fetch of a URL. */
  repository?: string
  head?: string
  /** When the working copy of a URL last fetched. */
  fetchedAt?: string
}

/**
 * @param input - the configured repository address.
 * @param stateDir - this plugin's state directory, which holds the working copies of URLs.
 * @param allowFileForTests - accept `file://` repositories.
 * @returns the local working copy and its head, without fetching.
 */
export async function inspectRepository(input: string, stateDir: string, allowFileForTests = false): Promise<RepositoryStatus> {
  const kind = validateRepositoryAddress(input, allowFileForTests)
  if (kind === 'path') {
    const repository = input.startsWith('~/') ? join(homedir(), input.slice(2)) : resolve(input)
    const current = await head(repository)
    return { kind, repository, ...(current !== undefined ? { head: current } : {}) }
  }
  const directory = clonePath(input, stateDir)
  if (!await exists(directory)) return { kind }
  const current = await head(directory)
  const fetched = await stat(join(directory, '.git', 'FETCH_HEAD')).catch(() => undefined)
  return { kind, repository: directory, ...(current !== undefined ? { head: current } : {}), ...(fetched !== undefined ? { fetchedAt: fetched.mtime.toISOString() } : {}) }
}

/**
 * Checks that a repository answers, without cloning it.
 * @param input - the repository address.
 * @param allowFileForTests - accept `file://` repositories.
 * @returns the default branch, when the repository has one.
 */
export async function testRepository(input: string, allowFileForTests = false): Promise<{ branch?: string }> {
  const kind = validateRepositoryAddress(input, allowFileForTests)
  const target = kind === 'path' ? (input.startsWith('~/') ? join(homedir(), input.slice(2)) : resolve(input)) : input
  const output = await run('git', ['ls-remote', '--symref', '--', target, 'HEAD'], undefined, 30000)
  const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(output)?.[1]
  return branch !== undefined ? { branch } : {}
}

export async function unpushedCount(repository: string, branch: string): Promise<number> {
  if (branch === '') return 0
  if (await remoteBranchExists(repository, branch)) return Number((await run('git', ['-C', repository, 'rev-list', '--count', `origin/${branch}..HEAD`])).trim())
  return Number((await run('git', ['-C', repository, 'rev-list', '--count', 'HEAD'])).trim())
}

export async function pushRepository(repository: string, branch: string): Promise<string> {
  if (branch === '') throw new Error('无法确定推送分支')
  await run('git', ['-C', repository, 'push', 'origin', `HEAD:${branch}`])
  return (await head(repository))!
}

/** A machine directory found in a sync repository. */
export interface MachineEntry {
  /** Directory name under `machines/`. */
  id: string
  /** Display name recorded in its snapshot. */
  name: string
  createdAt: string
  /** Last commit that touched the directory. */
  commit: string
}

/**
 * @param repository - working copy.
 * @param revision - commit to read.
 * @returns the machines with a readable `snapshot.json` at that commit, newest export first.
 */
export async function listMachines(repository: string, revision: string): Promise<MachineEntry[]> {
  const paths = (await run('git', ['-C', repository, 'ls-tree', '--name-only', revision, 'machines/'])).split('\n').filter(Boolean)
  const output: MachineEntry[] = []
  for (const path of paths) {
    const id = path.slice('machines/'.length)
    if (!/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') continue
    let snapshot: any
    try {
      snapshot = JSON.parse(await run('git', ['-C', repository, 'show', `${revision}:${path}/snapshot.json`]))
    } catch {
      // A directory without a parsable snapshot.json is not a machine this plugin wrote.
      continue
    }
    const [commit = '', committedAt = ''] = (await run('git', ['-C', repository, 'log', '-1', '--format=%H%x09%cI', revision, '--', path])).trim().split('\t')
    output.push({
      id,
      name: typeof snapshot?.machine === 'string' && snapshot.machine !== '' ? snapshot.machine : id,
      createdAt: typeof snapshot?.createdAt === 'string' ? snapshot.createdAt : committedAt,
      commit,
    })
  }
  return output.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}
