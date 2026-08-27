/**
 * /fileexplorer RPC handler: read-only one-level directory listing.
 *
 * Pure module with no ctx dependency: `apply` wires the factory result into
 * the connection channel, tests call the factory directly. Read-only by
 * design (v1): this endpoint is the only operation the channel serves.
 *
 * Error codes come from the core RpcErrorDetailsMap (a closed union): the
 * directory picker's `directory-unreadable` covers every unusable target,
 * `cancelled` reports caller aborts, `internal` folds unexpected failures.
 */
import { spawn } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative } from 'node:path'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type {
  FileExplorerCrumb, FileExplorerEntry, FileExplorerGitRequest, FileExplorerHistoryRequest,
  FileExplorerListing, FileExplorerListRequest, FileHistorySnapshot, GitCommitRow, GitSnapshot,
} from './contract.ts'

export type {
  FileExplorerCrumb, FileExplorerEntry, FileExplorerGitRequest, FileExplorerHistoryRequest,
  FileExplorerListing, FileExplorerListRequest, FileHistorySnapshot, GitCommitRow, GitSnapshot,
} from './contract.ts'

/** One attrib(1) output line: attribute letters then the quoted-or-plain path. */
const ATTRIB_LINE = /^([ASHR ]+)\s+(.+)$/

/** One git(1) invocation result; code null means the spawn itself failed. */
export interface RunGitResult {
  code: number | null
  stdout: string
  stderr: string
}

/** git invocation seam: the default spawns git(1), tests inject a fake. */
export type RunGit = (root: string, args: readonly string[], signal: AbortSignal) => Promise<RunGitResult>

export interface FileExplorerHandlerOptions {
  /** Complete-result bound; a cut level keeps the name-sorted head (mirrors the directory picker's maxEntries). */
  maxEntries?: number
  /**
   * Windows hidden-attribute reader for one listed directory; defaults to an
   * `attrib` spawn (Node dirents expose no FILE_ATTRIBUTE_HIDDEN). Tests
   * inject a fake; a reader that fails yields no hidden entries (the caller
   * falls back to the POSIX dot-prefix convention).
   */
  readHidden?: (root: string) => Promise<ReadonlySet<string>>
  /** git(1) runner; defaults to a spawn, tests inject a fake. */
  runGit?: RunGit
}

/** Windows drive-rooted or full-UNC absolute form; rejects relative and rooted drive-less forms. */
function isQualifiedAbsolutePath(path: string): boolean {
  if (!isAbsolute(path)) return false
  if (process.platform !== 'win32') return true
  // 'C:\foo' has a 3-char root; '\foo' and '/' have shorter ones; a full UNC
  // root ('\\server\share') is longer. Same fence as the directory picker.
  return parse(path).root.length >= 3
}

/** Strip trailing separators so containment comparisons stay exact. */
function trimTrailingSeparators(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, '') : path
}

/**
 * Whether `candidate` equals `root` or descends from it. Case-insensitive on
 * Windows (the filesystem is), exact elsewhere; always compares on the
 * platform separator so `D:\work` never matches `D:\workx`.
 */
export function isWithin(root: string, candidate: string): boolean {
  const a = trimTrailingSeparators(process.platform === 'win32' ? root.toLowerCase() : root)
  const b = trimTrailingSeparators(process.platform === 'win32' ? candidate.toLowerCase() : candidate)
  if (b === a) return true
  const separator = process.platform === 'win32' ? '\\' : '/'
  return b.startsWith(`${a}${separator}`)
}

/** POSIX dot-prefix convention; on Windows only the real attribute decides. */
function isDotHidden(name: string): boolean {
  return process.platform !== 'win32' && name.startsWith('.')
}

/**
 * Parse `attrib <dir>\*` output into the set of hidden absolute paths
 * (lowercased). Lines look like `A  H          D:\dir\.git` — attribute
 * letters, then the path (quoted when it contains spaces).
 */
export function parseAttribOutput(output: string): Set<string> {
  const hidden = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const match = ATTRIB_LINE.exec(line.trimEnd())
    if (match === null) continue
    if (!match[1]!.includes('H')) continue
    const path = match[2]!.trim().replace(/^"(.*)"$/, '$1')
    if (path !== '') hidden.add(path.toLowerCase())
  }
  return hidden
}

/**
 * Batch-read the Windows hidden attribute for every entry of `root` through
 * one `attrib /d <root>\*` call. Failures (missing binary, sandbox fences)
 * resolve to an empty set so listing never fails because of the probe.
 */
export async function readWindowsHidden(root: string): Promise<ReadonlySet<string>> {
  return new Promise((resolve) => {
    const child = spawn('attrib', ['/d', join(root, '*')], { windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('error', () => { resolve(new Set()) })
    child.on('close', (code) => {
      if (code !== 0) { resolve(new Set()); return }
      resolve(parseAttribOutput(output))
    })
  })
}

/** Default git(1) runner: spawn with the repository root as cwd. */
export function runGitCommand(root: string, args: readonly string[], signal: AbortSignal): Promise<RunGitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', [...args], { cwd: root, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error) => { resolve({ code: null, stdout: '', stderr: error.message }) })
    child.on('close', (code) => { resolve({ code: code ?? -1, stdout, stderr }) })
    signal.addEventListener('abort', () => { child.kill() }, { once: true })
  })
}

/**
 * Parse `git log --pretty=format:%h%x1f%s%x1f%ad` output into commit rows.
 * The unit separator keeps subjects with spaces intact; a line without the
 * hash/subject pair is skipped defensively.
 */
export function parseGitLog(output: string): GitCommitRow[] {
  const rows: GitCommitRow[] = []
  for (const line of output.split('\n')) {
    if (line === '') continue
    const [hash, subject, date] = line.split('\x1f')
    if (hash === undefined || subject === undefined) continue
    rows.push({ hash, subject, date: date === undefined || date === '' ? undefined : date })
  }
  return rows
}

/** Branch-state row parsed from `git status -sb`'s first line. */
export interface GitBranchStatus {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
}

/**
 * Parse the `## ...` branch line of `git status -sb`:
 * `## master...origin/master [ahead 1, behind 2]`, `## master...origin/master`,
 * `## master`, or `## HEAD (no branch)` for a detached HEAD.
 */
export function parseGitStatus(output: string): GitBranchStatus {
  const firstLine = output.split('\n')[0] ?? ''
  // Branch names cannot contain spaces, so `## HEAD (no branch)` yields the
  // literal HEAD token and reads as detached.
  const match = /^## ([^\s(]+?)(?:\.\.\.([^\s]+?))?(?: \[ahead (\d+)(?:, behind (\d+))?\])?$/.exec(firstLine)
  if (match === null || match[1] === undefined || match[1] === 'HEAD') {
    return { branch: null, upstream: null, ahead: 0, behind: 0 }
  }
  return {
    branch: match[1],
    upstream: match[2] ?? null,
    ahead: match[3] === undefined ? 0 : Number(match[3]),
    behind: match[4] === undefined ? 0 : Number(match[4]),
  }
}

/** Build the read-only Git snapshot for one repository root. */
export async function readGitSnapshot(
  root: string,
  run: RunGit,
  signal: AbortSignal,
  ref?: string,
): Promise<GitSnapshot> {
  const workTree = await run(root, ['rev-parse', '--is-inside-work-tree'], signal)
  if (workTree.code !== 0) {
    const base = { branch: null, upstream: null, ahead: 0, behind: 0, branches: [], headHash: null, remoteHead: null, commits: [] }
    return workTree.code === null
      ? { ok: false, reason: 'no-git', message: workTree.stderr, ...base }
      : { ok: false, reason: 'not-repo', message: workTree.stderr.trim(), ...base }
  }
  // Local branch names: the dropdown choices. The viewed target must be one
  // of them (a client-supplied rev is never passed to git verbatim).
  const branchOut = await run(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'], signal)
  const branches = branchOut.code === 0
    ? branchOut.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
    : []
  const target = ref !== undefined && branches.includes(ref) ? ref : 'HEAD'
  const statusOut = await run(root, ['status', '-sb'], signal)
  const status = statusOut.code === 0
    ? parseGitStatus(statusOut.stdout)
    : { branch: null, upstream: null, ahead: 0, behind: 0 }
  // Cloud position: the viewed branch's upstream commit hash. Short form to
  // match the log's %h.
  let remoteHead: string | null = null
  const upstreamOut = await run(root, ['rev-parse', '--short', `${target}@{upstream}`], signal)
  if (upstreamOut.code === 0 && upstreamOut.stdout.trim() !== '') remoteHead = upstreamOut.stdout.trim()
  const logOut = await run(
    root,
    ['log', '--pretty=format:%h%x1f%s%x1f%ad', '--date=short', '-n', '20', target],
    signal,
  )
  const commits = logOut.code === 0 ? parseGitLog(logOut.stdout) : []
  // The log is newest-first, so its first row is the viewed branch's tip.
  const headHash = commits[0]?.hash ?? null
  return {
    ok: true,
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    branches,
    headHash,
    remoteHead,
    commits,
  }
}

function directoryUnreadable(path: string, cause: unknown): RpcResult<FileExplorerListing> {
  return {
    ok: false,
    error: {
      code: 'directory-unreadable',
      message: `directory listing failed for ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      details: { path },
    },
  }
}

function cancelled(message: string): RpcResult<FileExplorerListing> {
  return { ok: false, error: { code: 'cancelled', message, details: {} } }
}

/** Root-to-target crumb chain; the root crumb carries its full path as its name. */
export function crumbChain(target: string): FileExplorerCrumb[] {
  const crumbs: FileExplorerCrumb[] = []
  let current = target
  for (;;) {
    const parent = parse(current).root === current ? undefined : dirname(current)
    // A Windows drive root displays as "D:" (no trailing slash) so the
    // rendered breadcrumb reads "D:\folder\..." instead of "D:\ / folder".
    const name = parent === undefined
      ? (process.platform === 'win32' && current.endsWith('\\') ? current.slice(0, -1) : current)
      : basename(current)
    crumbs.push({ name, path: current })
    if (parent === undefined) break
    current = parent
  }
  crumbs.reverse()
  return crumbs
}

/**
 * Parse `git status --porcelain` output into a root-relative-path → state
 * map. The XY code folds to the three explorer states: D (deleted) wins,
 * then M (modified, incl. type/rename/copy/unmerged), then A (added or
 * untracked). Rename rows carry `old -> new`; the new path is the key.
 */
export function parsePorcelainStatus(output: string): Map<string, 'M' | 'D' | 'A'> {
  const map = new Map<string, 'M' | 'D' | 'A'>()
  for (const line of output.split('\n')) {
    if (line.length < 4) continue
    const code = line[0]! + line[1]!
    let path = line.slice(3)
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) path = path.slice(arrow + 4)
    if (path === '') continue
    let state: 'M' | 'D' | 'A'
    if (code.includes('D')) state = 'D'
    else if (code.includes('M') || code.includes('T') || code.includes('R') || code.includes('C') || code.includes('U')) state = 'M'
    else state = 'A' // ?? untracked and A staged-add
    map.set(path, state)
  }
  return map
}

/** Build the read-only commit history for one file inside the root. */
export async function readFileHistory(
  root: string,
  path: string,
  run: RunGit,
  signal: AbortSignal,
): Promise<FileHistorySnapshot> {
  const workTree = await run(root, ['rev-parse', '--is-inside-work-tree'], signal)
  if (workTree.code !== 0) {
    return workTree.code === null
      ? { ok: false, reason: 'no-git', message: workTree.stderr, commits: [] }
      : { ok: false, reason: 'not-repo', message: workTree.stderr.trim(), commits: [] }
  }
  // git expects forward slashes for pathspecs.
  const rel = relative(root, path).split('\\').join('/')
  const logOut = await run(
    root,
    ['log', '--pretty=format:%h%x1f%s%x1f%ad', '--date=short', '-n', '20', 'HEAD', '--', rel],
    signal,
  )
  return { ok: true, commits: logOut.code === 0 ? parseGitLog(logOut.stdout) : [] }
}

/**
 * Create the channel handler.
 * @param options - tunables (test seams).
 * @returns handler satisfying the ConnectionRpcHandler contract.
 */
export function createFileExplorerHandler(options: FileExplorerHandlerOptions = {}): ConnectionRpcHandler {
  const maxEntries = options.maxEntries ?? 1000
  const readHidden = options.readHidden ?? (process.platform === 'win32' ? readWindowsHidden : undefined)
  const runGit = options.runGit ?? runGitCommand
  return async (endpoint, payload, signal): Promise<RpcResult<unknown>> => {
    if (endpoint === 'file-history') {
      const historyPayload = payload as FileExplorerHistoryRequest | null
      const historyRoot = historyPayload?.root
      const historyPath = historyPayload?.path
      if (typeof historyRoot !== 'string' || typeof historyPath !== 'string'
        || !isQualifiedAbsolutePath(historyRoot) || !isQualifiedAbsolutePath(historyPath)) {
        return {
          ok: false,
          error: {
            code: 'directory-unreadable',
            message: 'file-history root/path must be fully qualified absolute paths',
            details: { path: String(historyPath) },
          },
        }
      }
      // The selected file must stay inside the locked workspace root.
      if (!isWithin(historyRoot, historyPath)) {
        return {
          ok: false,
          error: {
            code: 'directory-unreadable',
            message: 'file-history path escapes the locked workspace root',
            details: { path: historyPath },
          },
        }
      }
      if (signal.aborted) {
        return { ok: false, error: { code: 'cancelled', message: 'fileexplorer history was aborted', details: {} } }
      }
      return { ok: true, value: await readFileHistory(historyRoot, historyPath, runGit, signal) }
    }
    if (endpoint === 'git') {
      const gitPayload = payload as FileExplorerGitRequest | null
      const gitRoot = gitPayload?.root
      if (typeof gitRoot !== 'string' || !isQualifiedAbsolutePath(gitRoot)) {
        return {
          ok: false,
          error: {
            code: 'directory-unreadable',
            message: `git root is not fully qualified: ${String(gitRoot)}`,
            details: { path: String(gitRoot) },
          },
        }
      }
      const ref = typeof gitPayload?.ref === 'string' && gitPayload.ref !== '' ? gitPayload.ref : undefined
      if (signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'fileexplorer git was aborted', details: {} } }
      return { ok: true, value: await readGitSnapshot(gitRoot, runGit, signal, ref) }
    }
    if (endpoint !== 'list') {
      return {
        ok: false,
        error: {
          code: 'bad-request',
          message: `unknown fileexplorer endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        },
      }
    }
    const requested = (payload as FileExplorerListRequest | null)?.path
    const lockedRoot = (payload as FileExplorerListRequest | null)?.root
    const wantGit = (payload as FileExplorerListRequest | null)?.git === true
    if (requested !== undefined && !isQualifiedAbsolutePath(requested)) {
      return directoryUnreadable(requested, new Error('path is not fully qualified'))
    }
    if (lockedRoot !== undefined && !isQualifiedAbsolutePath(lockedRoot)) {
      return directoryUnreadable(lockedRoot, new Error('root is not fully qualified'))
    }
    const root = requested ?? lockedRoot ?? process.cwd()
    // Workspace lock: with a locked root the target must stay inside it —
    // enforced host-side so a client bug cannot escape the workspace.
    if (lockedRoot !== undefined && !isWithin(lockedRoot, root)) {
      return directoryUnreadable(root, new Error('path escapes the locked workspace root'))
    }
    // The breadcrumb chain starts at the locked root when one is set.
    const crumbs = lockedRoot === undefined
      ? crumbChain(root)
      : crumbChain(root).filter(crumb => isWithin(lockedRoot, crumb.path))
    let dirents
    try {
      dirents = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (signal.aborted) return cancelled('fileexplorer listing was aborted')
      return directoryUnreadable(root, error)
    }
    if (signal.aborted) return cancelled('fileexplorer listing was aborted')
    // On Windows the real FILE_ATTRIBUTE_HIDDEN decides (a dot prefix alone
    // does not); the reader failure fallback keeps dot-prefix hiding intact.
    let hiddenPaths: ReadonlySet<string> = new Set()
    if (readHidden !== undefined) {
      try {
        hiddenPaths = await readHidden(root)
      } catch {
        hiddenPaths = new Set()
      }
    }
    // Git working-tree state for the listed level, when requested and when
    // git answers (non-repository roots and missing git degrade silently).
    let gitStatuses: ReadonlyMap<string, 'M' | 'D' | 'A'> = new Map()
    if (wantGit) {
      const statusOut = await runGit(root, ['status', '--porcelain'], signal)
      if (statusOut.code === 0) gitStatuses = parsePorcelainStatus(statusOut.stdout)
    }
    // Directories first, name-sorted within each kind.
    const rows = dirents
      .map(dirent => ({ dirent, path: join(root, dirent.name) }))
      .sort((left, right) => {
        const leftDir = left.dirent.isDirectory()
        const rightDir = right.dirent.isDirectory()
        if (leftDir !== rightDir) return leftDir ? -1 : 1
        return left.dirent.name < right.dirent.name ? -1 : left.dirent.name > right.dirent.name ? 1 : 0
      })
    const truncated = rows.length > maxEntries
    const kept = truncated ? rows.slice(0, maxEntries) : rows
    const entries: FileExplorerEntry[] = []
    for (const row of kept) {
      if (signal.aborted) return cancelled('fileexplorer listing was aborted')
      const { dirent } = row
      let kind: 'file' | 'dir' | undefined
      let size: number | undefined
      let mtimeMs: number | undefined
      if (dirent.isDirectory()) {
        kind = 'dir'
      } else if (dirent.isFile()) {
        kind = 'file'
      } else {
        // Symlink or special: one probe decides the row (broken/cyclic links are skipped).
        try {
          const st = await stat(row.path)
          kind = st.isDirectory() ? 'dir' : 'file'
          size = st.size
          mtimeMs = st.mtimeMs
        } catch {
          continue
        }
      }
      if (kind === 'file' && size === undefined) {
        // Regular file rows carry size/mtime for the explorer columns.
        try {
          const st = await stat(row.path)
          size = st.size
          mtimeMs = st.mtimeMs
        } catch {
          // Vanished between readdir and stat: skip the row entirely.
          continue
        }
      }
      const gitState = gitStatuses.get(relative(root, row.path).split('\\').join('/'))
      entries.push({
        name: dirent.name,
        path: row.path,
        kind,
        size,
        mtimeMs,
        hidden: isDotHidden(dirent.name) || hiddenPaths.has(row.path.toLowerCase()),
        ...(gitState === undefined ? {} : { git: gitState }),
      })
    }
    // Deleted files no longer exist on disk, so readdir cannot list them —
    // the git status backs them into the level so the explorer can show the
    // red deleted row (kind file, no size).
    if (lockedRoot !== undefined && wantGit) {
      const level = lockedRoot === root ? '' : relative(lockedRoot, root).split('\\').join('/')
      for (const [rel, state] of gitStatuses) {
        if (state !== 'D') continue
        const slash = rel.lastIndexOf('/')
        const dir = slash < 0 ? '' : rel.slice(0, slash)
        if (dir !== level) continue
        const name = slash < 0 ? rel : rel.slice(slash + 1)
        if (entries.some(entry => entry.name === name)) continue
        entries.push({ name, path: join(root, name), kind: 'file', hidden: false, git: 'D' })
      }
      if (gitStatuses.size > 0) entries.sort(entryCompare)
    }
    return { ok: true, value: { path: root, crumbs, entries, truncated } }
  }
}

/** Directories first, then name-sorted (shared by rows and backed-in deletes). */
function entryCompare(left: FileExplorerEntry, right: FileExplorerEntry): number {
  if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
}
