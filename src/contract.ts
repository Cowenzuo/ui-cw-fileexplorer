/**
 * Shared /fileexplorer wire contract. Pure types only: both halves import
 * this module without pulling each other's runtime code into their bundles.
 */

/** One listed row. */
export interface FileExplorerEntry {
  /** Base name shown in a row. */
  name: string
  /** Absolute host path — the client never joins path segments itself. */
  path: string
  kind: 'file' | 'dir'
  /** Byte size; absent when the probe could not produce one. */
  size?: number
  /** Last-modification epoch ms; absent when the probe could not produce one. */
  mtimeMs?: number
  /** Hidden by the platform's dot-prefix convention; the client owns whether to show it. */
  hidden: boolean
  /**
   * Git working-tree state when the listing ran inside a repository (and git
   * answered): M modified, D deleted, A added/untracked. Absent for clean
   * files and non-repository roots.
   */
  git?: 'M' | 'D' | 'A'
}

/** One breadcrumb row: root-to-target ancestor chain. */
export interface FileExplorerCrumb {
  /** Base name; the root crumb carries its full path as its name. */
  name: string
  /** Absolute host path — a jump target. */
  path: string
}

/** The list response value. */
export interface FileExplorerListing {
  /** Absolute path of the listed directory. */
  path: string
  /** Root-to-target ancestor chain, root first. */
  crumbs: FileExplorerCrumb[]
  /** Direct children, directories first then name-sorted. */
  entries: FileExplorerEntry[]
  /** True when the backend cut `entries` at its complete-result bound (the name-sorted tail is absent). */
  truncated: boolean
}

/** list request payload; an absent path lists the root (or the host process cwd). */
export interface FileExplorerListRequest {
  path?: string
  /**
   * Locked root (the session workspace): when present, `path` must equal it
   * or descend from it — the explorer cannot escape the workspace.
   */
  root?: string
  /** Ask for git working-tree state on the entries (M/D/A), when available. */
  git?: boolean
}

/** git request payload: the repository root (the session workspace). */
export interface FileExplorerGitRequest {
  root: string
  /** Branch whose commit tree to view; absent means the working branch (HEAD). */
  ref?: string
}

/** file-history request payload: the file whose commit history to list. */
export interface FileExplorerHistoryRequest {
  /** Repository root (the session workspace); the path must stay inside it. */
  root: string
  /** Absolute path of the selected file. */
  path: string
}

/**
 * Read-only history snapshot for one file. Business state rides inside the
 * RPC success value like GitSnapshot.
 */
export interface FileHistorySnapshot {
  ok: boolean
  /** Failure classification when ok is false. */
  reason?: 'no-git' | 'not-repo'
  /** Failure detail (git stderr or spawn message) when ok is false. */
  message?: string
  /** Newest-first commits touching the file (capped). */
  commits: GitCommitRow[]
}

/** open request payload: the directory to reveal in the system file manager. */
export interface FileExplorerOpenRequest {
  path: string
}

/**
 * open response value. `throttled:true` means the request arrived inside the
 * per-path cooldown after a previous open of the same directory, so the host
 * coalesced it (the window is already up) — the client treats it as success.
 */
export interface FileExplorerOpenResult {
  opened: boolean
  throttled?: boolean
}

/** One compact commit row: short hash, subject, short date. */
export interface GitCommitRow {
  hash: string
  subject: string
  /** YYYY-MM-DD (git --date=short); absent when the log format did not carry it. */
  date?: string
}

/**
 * Read-only Git snapshot. Business state rides inside the RPC success value:
 * `ok:false` with a reason means the root is not a repository or git is
 * missing — the client renders an empty state, never an error banner.
 */
export interface GitSnapshot {
  ok: boolean
  /** Failure classification when ok is false. */
  reason?: 'no-git' | 'not-repo'
  /** Failure detail (git stderr or spawn message) when ok is false. */
  message?: string
  /** Current local branch; null on a detached HEAD. */
  branch: string | null
  /** Upstream tracking branch (e.g. origin/master); null when untracked. */
  upstream: string | null
  /** Commits the local branch leads the upstream by (unpushed). */
  ahead: number
  /** Commits the local branch trails the upstream by (unpulled). */
  behind: number
  /** Local branch names (the dropdown choices). */
  branches: string[]
  /** Short hash of the viewed branch's tip commit (the working position); null with no commits. */
  headHash: string | null
  /** Short hash of the viewed branch's upstream commit (the cloud position); null when untracked. */
  remoteHead: string | null
  /** Newest-first commit rows (capped). */
  commits: GitCommitRow[]
}
