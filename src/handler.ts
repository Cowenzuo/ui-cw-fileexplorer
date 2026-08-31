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
import { basename, dirname, isAbsolute, join, normalize, parse, relative } from 'node:path'
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

/** Native open seam: the default spawns the platform opener, tests inject a fake. */
export type RunOpen = (path: string, signal: AbortSignal) => Promise<{ code: number | null; stderr: string }>

/** Default per-path cooldown between two opens of the same directory. */
export const OPEN_COOLDOWN_MS = 1200

/** Git-log default page size (the client may submit its own `limit`). */
export const GIT_PAGE_SIZE = 20
/** Hard ceiling for a submitted `limit` (protects the host from huge pages). */
export const GIT_MAX_LIMIT = 100

/** Git working-tree state cache TTL per listed level (ms). */
export const GIT_CACHE_TTL_MS = 1_500
/** Git working-tree state cache capacity (oldest entry evicted beyond it). */
export const GIT_CACHE_MAX = 32

/** Cached git resolution for one listed level. */
export interface GitLevelState {
  repoRoot: string | null
  statuses: ReadonlyMap<string, 'M' | 'D' | 'A'>
  gitlinks: ReadonlySet<string>
  /** Epoch ms of the resolution (TTL freshness). */
  at: number
}

/** Clamp a client-submitted page size into [1, GIT_MAX_LIMIT]. */
export function clampGitLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return GIT_PAGE_SIZE
  return Math.min(Math.max(1, Math.floor(limit)), GIT_MAX_LIMIT)
}

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
  /** Native opener; defaults to a direct spawn, tests inject a fake. */
  runOpen?: RunOpen
  /**
   * Per-path open cooldown: repeat opens of the same directory inside this
   * window are coalesced (a burst of mis-clicks opens one window, not N).
   * The first open still starts immediately — no perceived lag.
   */
  openCooldownMs?: number
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
 * Default native opener — auto-switched by platform:
 *
 * - win32: a PowerShell 5.1 helper drives the Windows shell (see below).
 * - darwin: `open` direct spawn.
 * - linux/other: `xdg-open` direct spawn.
 *
 * Windows specifics (the only place the plugin touches Win32):
 * the foreground lock refuses to raise windows from processes that never
 * received input, so the helper first synthesizes one Alt key press (WScript
 * SendKeys) — the system then treats this process as the last-input process
 * and grants it foreground permission. It then opens the folder:
 *
 * - No window for it yet: `Shell.Application.Explore(path)` — opens AND
 *   raises a new window.
 * - Already open: Explore would only try to focus the existing window, and
 *   that activation from a background service is refused by the foreground
 *   lock — so `explorer.exe /n,/e,<path>` forces a brand-new window instead.
 *
 * The helper is plain COM and needs no P/Invoke, so it also survives
 * restricted PowerShell 5.1 environments where Add-Type (which shells out to
 * csc.exe) is blocked. The official host.openPath powershell Invoke-Item does
 * not surface a window in every session, hence the channel-owned open.
 */
export function runOpenCommand(path: string, signal: AbortSignal): Promise<{ code: number | null; stderr: string }> {
  if (process.platform === 'win32') {
    const script = [
      // UTF-8 on both streams so the node side decodes error text correctly
      // (the harness session's console code page is not UTF-8).
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      '[Console]::Error.OutputEncoding = [System.Text.Encoding]::UTF8',
      "$ErrorActionPreference = 'Stop'",
      'try {',
      `  $want = '${path.replaceAll("'", "''")}'.TrimEnd([char]92).ToLowerInvariant()`,
      '  $shell = New-Object -ComObject Shell.Application',
      '  $alreadyOpen = @($shell.Windows() | Where-Object { try { $_.Document.Folder.Self.Path.TrimEnd([char]92).ToLowerInvariant() -eq $want } catch { $false } }).Count -gt 0',
      "  (New-Object -ComObject WScript.Shell).SendKeys('%')",
      '  Start-Sleep -Milliseconds 80',
      '  if ($alreadyOpen) {',
      `    Start-Process explorer.exe -ArgumentList "/n,/e,${path.replaceAll('"', '""')}"`,
      '  } else {',
      `    $shell.Explore('${path.replaceAll("'", "''")}')`,
      '  }',
      '  exit 0',
      '} catch {',
      "  [Console]::Error.WriteLine('OPEN_FAILED: ' + $_.Exception.Message)",
      '  exit 1',
      '}',
    ].join('\n')
    return new Promise((resolve) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true },
      )
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('error', (error) => { resolve({ code: null, stderr: error.message }) })
      child.on('close', (code) => { resolve({ code: code ?? -1, stderr }) })
      signal.addEventListener('abort', () => { child.kill() }, { once: true })
    })
  }
  const command = process.platform === 'darwin' ? { file: 'open', args: [path] } : { file: 'xdg-open', args: [path] }
  return new Promise((resolve) => {
    const child = spawn(command.file, command.args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (error) => { resolve({ code: null, stderr: error.message }) })
    child.on('close', (code) => { resolve({ code: code ?? -1, stderr }) })
    signal.addEventListener('abort', () => { child.kill() }, { once: true })
  })
}

/**
 * Parse `git log --pretty=format:%h%x1f%s%x1f%ad%x1f%b%x1e` output into
 * commit rows. Unit separators keep hash/subject/date/body fields apart (the
 * body may span lines); the record separator closes one commit, and git
 * appends a newline after EVERY record — so every record after the first
 * carries a leading `\n` that must be stripped (it would otherwise corrupt
 * the hash and break hash-keyed comparisons like the cloud marker). A record
 * without the hash/subject pair is skipped defensively.
 */
export function parseGitLog(output: string): GitCommitRow[] {
  const rows: GitCommitRow[] = []
  for (const record of output.split('\x1e')) {
    if (record === '') continue
    const [hash, subject, date, ...bodyParts] = record.replace(/^\r?\n/, '').split('\x1f')
    if (hash === undefined || subject === undefined) continue
    const body = bodyParts.length > 0 ? bodyParts.join('\x1f').trim() : undefined
    rows.push({
      hash,
      subject,
      date: date === undefined || date === '' ? undefined : date,
      ...(body === undefined || body === '' ? {} : { body }),
    })
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
  // literal HEAD token and reads as detached. The bracket may carry ahead
  // only, behind only, or both.
  const match = /^## ([^\s(]+?)(?:\.\.\.([^\s]+?))?(?: \[(?:ahead (\d+)(?:, behind (\d+))?|behind (\d+))\])?$/.exec(firstLine)
  if (match === null || match[1] === undefined || match[1] === 'HEAD') {
    return { branch: null, upstream: null, ahead: 0, behind: 0 }
  }
  return {
    branch: match[1],
    upstream: match[2] ?? null,
    ahead: match[3] === undefined ? 0 : Number(match[3]),
    behind: match[4] === undefined ? (match[5] === undefined ? 0 : Number(match[5])) : Number(match[4]),
  }
}

/** Build the read-only Git snapshot for one repository root. */
export async function readGitSnapshot(
  root: string,
  run: RunGit,
  signal: AbortSignal,
  ref?: string,
  skip = 0,
  limit = GIT_PAGE_SIZE,
): Promise<GitSnapshot> {
  const workTree = await run(root, ['rev-parse', '--is-inside-work-tree'], signal)
  if (workTree.code !== 0) {
    const base = { branch: null, upstream: null, ahead: 0, behind: 0, branches: [], headHash: null, remoteHead: null, commits: [], total: 0 }
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
    ['log', '--pretty=format:%h%x1f%s%x1f%ad%x1f%b%x1e', '--date=short', '-n', String(limit), `--skip=${skip}`, target],
    signal,
  )
  const commits = logOut.code === 0 ? parseGitLog(logOut.stdout) : []
  // The page is newest-first, so its first row is the viewed branch's tip.
  const headHash = commits[0]?.hash ?? null
  // Total reachable commits: drives the "load more" affordance. The count is
  // best-effort — a failure only hides the button.
  let total = commits.length
  const countOut = await run(root, ['rev-list', '--count', target], signal)
  if (countOut.code === 0 && countOut.stdout.trim() !== '') {
    const parsed = Number(countOut.stdout.trim())
    if (Number.isFinite(parsed) && parsed >= 0) total = parsed
  }
  // When the cloud is AHEAD (behind > 0), its tip is not part of the local
  // history, so no commit row can carry the cloud marker — fetch the tip
  // itself for a dedicated row. Best-effort: a failure just hides it.
  let remoteTip: GitCommitRow | undefined
  if (status.behind > 0 && remoteHead !== null) {
    const tipOut = await run(
      root,
      ['log', '-1', '--pretty=format:%h%x1f%s%x1f%ad%x1f%b%x1e', '--date=short', `${target}@{upstream}`],
      signal,
    )
    remoteTip = tipOut.code === 0 ? parseGitLog(tipOut.stdout)[0] : undefined
  }
  return {
    ok: true,
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    branches,
    headHash,
    remoteHead,
    ...(remoteTip === undefined ? {} : { remoteTip }),
    commits,
    total,
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
    // Untracked directories keep their trailing slash (`?? newdir/`): the
    // slash distinguishes a DIRECTORY entry (a nested repo or untracked dir,
    // whose own contents are not this repo's changes) from a FILE change.
    let state: 'M' | 'D' | 'A'
    if (code.includes('D')) state = 'D'
    else if (code.includes('M') || code.includes('T') || code.includes('R') || code.includes('C') || code.includes('U')) state = 'M'
    else state = 'A' // ?? untracked and A staged-add
    map.set(path, state)
  }
  return map
}

/**
 * Whether any FILE-level porcelain row lives under `dirPath` (repo-root-
 * relative prefix match) — a directory whose subtree contains uncommitted
 * changes gets an aggregate M badge. DIRECTORY entries under it (keys with a
 * trailing slash — untracked dirs) and GITLINKS (nested repos recorded in
 * the parent index — their changes belong to themselves) do NOT count.
 */
export function dirSubtreeChanged(
  repoRoot: string,
  dirPath: string,
  statuses: ReadonlyMap<string, 'M' | 'D' | 'A'>,
  gitlinks: ReadonlySet<string> = EMPTY_GITLINKS,
): boolean {
  const prefix = relative(repoRoot, dirPath).split('\\').join('/') + '/'
  for (const key of statuses.keys()) {
    if (key.endsWith('/')) continue
    if (gitlinks.has(key)) continue
    if (key.startsWith(prefix)) return true
  }
  return false
}

const EMPTY_GITLINKS: ReadonlySet<string> = new Set()

/**
 * Parse `git ls-files -s` into the set of gitlink paths (mode 160000 = a
 * nested repository recorded in the index). Porcelain v1 renders a dirty
 * gitlink exactly like a modified file (` M path`), so the modes are needed
 * to keep a parent folder from wearing a badge for its nested repos.
 */
export function parseGitlinks(output: string): Set<string> {
  const links = new Set<string>()
  for (const line of output.split('\n')) {
    const match = /^160000 [0-9a-f]{40} \d+\t(.+)$/.exec(line)
    if (match !== null && match[1] !== undefined) links.add(match[1])
  }
  return links
}

/** Build the read-only commit history for one file inside the root. */
export async function readFileHistory(
  root: string,
  path: string,
  run: RunGit,
  signal: AbortSignal,
  skip = 0,
  limit = GIT_PAGE_SIZE,
): Promise<FileHistorySnapshot> {
  const workTree = await run(root, ['rev-parse', '--is-inside-work-tree'], signal)
  if (workTree.code !== 0) {
    return workTree.code === null
      ? { ok: false, reason: 'no-git', message: workTree.stderr, commits: [], total: 0 }
      : { ok: false, reason: 'not-repo', message: workTree.stderr.trim(), commits: [], total: 0 }
  }
  // git expects forward slashes for pathspecs.
  const rel = relative(root, path).split('\\').join('/')
  const logOut = await run(
    root,
    ['log', '--pretty=format:%h%x1f%s%x1f%ad%x1f%b%x1e', '--date=short', '-n', String(limit), `--skip=${skip}`, 'HEAD', '--', rel],
    signal,
  )
  const commits = logOut.code === 0 ? parseGitLog(logOut.stdout) : []
  // Total commits touching the file: drives the "load more" affordance.
  let total = commits.length
  const countOut = await run(root, ['rev-list', '--count', 'HEAD', '--', rel], signal)
  if (countOut.code === 0 && countOut.stdout.trim() !== '') {
    const parsed = Number(countOut.stdout.trim())
    if (Number.isFinite(parsed) && parsed >= 0) total = parsed
  }
  return { ok: true, commits, total }
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
  const runOpen = options.runOpen ?? runOpenCommand
  const openCooldownMs = options.openCooldownMs ?? OPEN_COOLDOWN_MS
  // Per-path last-open timestamps; the entry is set when the open STARTS (so
  // concurrent bursts coalesce too) and removed when it fails (retry stays
  // immediate). Coalesced calls never refresh the timestamp.
  const lastOpenAt = new Map<string, number>()
  // Per-level git-state cache (see the list endpoint): a short TTL absorbs
  // the 2s client poll, pathspec scoping keeps deep levels cheap.
  const gitCache = new Map<string, GitLevelState>()
  return async (endpoint, payload, signal): Promise<RpcResult<unknown>> => {
    if (endpoint === 'open') {
      const openPath = (payload as { path?: unknown } | null)?.path
      if (typeof openPath !== 'string' || !isQualifiedAbsolutePath(openPath)) {
        return {
          ok: false,
          error: {
            code: 'directory-unreadable',
            message: `open path is not fully qualified: ${String(openPath)}`,
            details: { path: String(openPath) },
          },
        }
      }
      // Burst protection: a mis-click storm opens one window, not N. The
      // first open starts immediately; later ones inside the cooldown are
      // coalesced silently (the window is already up).
      const now = Date.now()
      const lastOpen = lastOpenAt.get(openPath)
      if (lastOpen !== undefined && now - lastOpen < openCooldownMs) {
        return { ok: true, value: { opened: true, throttled: true } }
      }
      // Stamp at START so overlapping requests coalesce too; a failed open
      // releases the slot so a retry is never delayed.
      lastOpenAt.set(openPath, now)
      const opened = await runOpen(openPath, signal)
      if (opened.code !== 0) {
        lastOpenAt.delete(openPath)
        return {
          ok: false,
          error: {
            code: 'directory-unreadable',
            message: `native open failed for ${openPath}: ${opened.stderr}`,
            details: { path: openPath },
          },
        }
      }
      return { ok: true, value: { opened: true } }
    }
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
      const historySkip = historyPayload?.skip
      const skip = typeof historySkip === 'number' && Number.isInteger(historySkip) && historySkip > 0 ? historySkip : 0
      const limit = clampGitLimit(historyPayload?.limit)
      return { ok: true, value: await readFileHistory(historyRoot, historyPath, runGit, signal, skip, limit) }
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
      const gitSkip = gitPayload?.skip
      const skip = typeof gitSkip === 'number' && Number.isInteger(gitSkip) && gitSkip > 0 ? gitSkip : 0
      const limit = clampGitLimit(gitPayload?.limit)
      if (signal.aborted) return { ok: false, error: { code: 'cancelled', message: 'fileexplorer git was aborted', details: {} } }
      return { ok: true, value: await readGitSnapshot(gitRoot, runGit, signal, ref, skip, limit) }
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
    // git answers. THE CURRENT FOLDER'S OWN REPOSITORY decides: no repo at
    // this level means no git states here at all (subdirectory repos keep
    // their own states when browsed into). Porcelain paths are
    // REPO-ROOT-relative regardless of the cwd, so the repository root is
    // resolved first and every lookup/back-in keys on it.
    //
    // Efficiency: the resolution is CACHED per level for a short TTL (the
    // client polls every ~2s, so the cache halves the git spawns with no
    // visible staleness), the porcelain/ls-files calls are PATHSCOPED to the
    // level's subtree (deep browsing diffs only that subtree, not the whole
    // repo), and ls-files is skipped entirely on clean levels.
    let gitRepoRoot: string | null = null
    let gitStatuses: ReadonlyMap<string, 'M' | 'D' | 'A'> = new Map()
    let gitlinks: ReadonlySet<string> = new Set()
    if (wantGit) {
      const cacheKey = process.platform === 'win32' ? root.toLowerCase() : root
      const cached = gitCache.get(cacheKey)
      if (cached !== undefined && Date.now() - cached.at < GIT_CACHE_TTL_MS) {
        gitRepoRoot = cached.repoRoot
        gitStatuses = cached.statuses
        gitlinks = cached.gitlinks
      } else {
        const topOut = await runGit(root, ['rev-parse', '--show-toplevel'], signal)
        // git prints the toplevel with forward slashes on Windows; normalize
        // to the platform form before any comparison.
        const top = topOut.code === 0 && topOut.stdout.trim() !== '' ? normalize(topOut.stdout.trim()) : ''
        gitRepoRoot = top !== '' && isWithin(top, root) ? top : null
        if (gitRepoRoot !== null) {
          const rel = relative(gitRepoRoot, root).split('\\').join('/')
          const scope = rel === '' ? [] : ['--', rel]
          const statusOut = await runGit(root, ['status', '--porcelain', ...scope], signal)
          if (statusOut.code === 0) gitStatuses = parsePorcelainStatus(statusOut.stdout)
          // Gitlink paths (nested repos recorded in the index): their dirty
          // state belongs to themselves, never to a parent folder's badge.
          // Only needed when the status actually has rows.
          if (gitStatuses.size > 0) {
            const lsOut = await runGit(root, ['ls-files', '-s', ...scope], signal)
            if (lsOut.code === 0) gitlinks = parseGitlinks(lsOut.stdout)
          }
        }
        // Bounded cache: drop the oldest entry when over capacity.
        if (gitCache.size >= GIT_CACHE_MAX) {
          let oldestKey: string | undefined
          let oldestAt = Number.POSITIVE_INFINITY
          for (const [key, entry] of gitCache) {
            if (entry.at < oldestAt) {
              oldestAt = entry.at
              oldestKey = key
            }
          }
          if (oldestKey !== undefined) gitCache.delete(oldestKey)
        }
        gitCache.set(cacheKey, { repoRoot: gitRepoRoot, statuses: gitStatuses, gitlinks, at: Date.now() })
      }
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
      // File rows carry their exact porcelain state; directory rows get an
      // aggregate M when their subtree has file-level changes (gitlinks and
      // untracked directory entries excluded) — the direct state wins when
      // the directory row itself is listed (e.g. an untracked dir).
      let gitState: 'M' | 'D' | 'A' | undefined
      if (kind === 'dir') {
        if (gitRepoRoot !== null) {
          const rel = relative(gitRepoRoot, row.path).split('\\').join('/')
          gitState = gitStatuses.get(rel) ?? gitStatuses.get(`${rel}/`) ?? (dirSubtreeChanged(gitRepoRoot, row.path, gitStatuses, gitlinks) ? 'M' : undefined)
        }
      } else {
        gitState = gitRepoRoot === null
          ? undefined
          : gitStatuses.get(relative(gitRepoRoot, row.path).split('\\').join('/'))
      }
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
    if (gitRepoRoot !== null && lockedRoot !== undefined && wantGit) {
      const level = relative(gitRepoRoot, root).split('\\').join('/')
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
