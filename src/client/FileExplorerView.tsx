/**
 * File explorer dock: a right-side panel rendered into the official
 * `shell.overlay` slot. Three layers: the file region (main panel: breadcrumb
 * + listing with git working-tree states), the Git branch view drawer, and
 * the selected-file history drawer — each auxiliary drawer collapses
 * independently and has its own height divider.
 *
 * Geometry is fully owned by this component — no official source changes:
 * a `#root { margin-right: var(--dsh-fileexplorer-width) }` stylesheet pushes
 * the official UI left (the dsh-better-sidebar-validated technique), and the
 * panel itself is `position: fixed` on the right edge. The dock width drag
 * lives on the left edge; collapsing the whole dock leaves a full-height bar
 * with a vertically centered expand arrow. The region follows the currently
 * selected session's workspace through the global session hooks. All data
 * arrives through props; the poll effects are pure behavioral hooks.
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconFolderClose16,
  IconFolderOpen16,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { NS } from './locales.ts'
import type { FileExplorerEntry, FileExplorerListing, GitSnapshot } from '../contract.ts'
import { GitDrawer, type GitDrawerInjected } from './GitDrawer.tsx'
import { FileHistoryView, type FileHistoryInjected } from './FileHistoryView.tsx'
import css from './FileExplorerView.module.css'

/** Business callbacks injected by the register site (apply world). */
export interface FileExplorerInjected extends GitDrawerInjected, FileHistoryInjected {
  /**
   * List one level. `root` is the locked workspace the explorer may not
   * escape; `path` (inside root) is the listed directory.
   */
  list(root: string | undefined, path: string | undefined, signal: AbortSignal): Promise<RpcResult<FileExplorerListing>>
  /** Reveal a path in the host OS (host.openPath). */
  openInSystem(path: string, signal: AbortSignal): Promise<RpcResult<unknown>>
}

const POLL_MS = 2_000
/** Default expanded width in px. */
const DEFAULT_WIDTH = 320
/** Expanded width drag bounds. */
const MIN_WIDTH = 180
const MAX_WIDTH = 640
/** Collapsed rail width: a slim vertical tab keeps the expand affordance visible. */
const RAIL_WIDTH = 28
/** Default share of the dock height the git drawer takes. */
const DEFAULT_GIT_RATIO = 0.35
/** Default share of the dock height the history drawer takes. */
const DEFAULT_HISTORY_RATIO = 0.25
/** Per-drawer height drag bounds (the file region keeps the remainder). */
const MIN_AUX_RATIO = 0.15
const MAX_AUX_RATIO = 0.6
/** Upper bound on the two auxiliary drawers combined (the file region always keeps a floor). */
const MAX_AUX_TOTAL = 0.8
/** CSS variable driving the official UI push; also read by the stylesheet. */
const WIDTH_VAR = '--dsh-fileexplorer-width'
/** Root-level push stylesheet: official UI yields to the dock. */
const PUSH_CSS = [
  `:root { ${WIDTH_VAR}: 0px; }`,
  `#root { margin-right: var(${WIDTH_VAR}); transition: margin-right 160ms ease; }`,
  `:root[data-dsh-fileexplorer-dragging] #root { transition: none; }`,
].join('\n')

/** Inline document glyph (the primitives library ships no file icon). */
function FileGlyph(): React.JSX.Element {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" fill="none" aria-hidden="true">
      <path
        d="M1 1.5h6.5L11 5v7.5a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path d="M7 1.5V5h4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  )
}

/** Stable fingerprint: skip a re-render when nothing user-visible changed. */
function fingerprint(listing: FileExplorerListing | undefined): string {
  if (listing === undefined) return ''
  return JSON.stringify(listing.entries.map(entry => [entry.name, entry.kind, entry.size, entry.mtimeMs]))
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = units[0]!
  for (const next of units.slice(1)) {
    if (value < 1024) break
    value /= 1024
    unit = next
  }
  return `${value.toFixed(1)} ${unit}`
}

export function FileExplorerDock(
  props: PropsRuntime<'shell.overlay'> & InjectFace<FileExplorerInjected> & PropsLocale<typeof NS>,
): React.JSX.Element {
  const { useSessions, list, git, fileHistory, openInSystem, t } = props
  const sessionId = useSessions(state => state.current)
  // The session workspace is the explorer's locked root (VS Code style): the
  // view may only descend inside it, never escape upward.
  const cwd = useSessions(state => (sessionId === undefined ? undefined : state.byId[sessionId]?.cwd))
  const [path, setPath] = useState<string | undefined>(undefined)
  const [listing, setListing] = useState<FileExplorerListing | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [selectedFile, setSelectedFile] = useState<{ name: string; path: string } | null>(null)
  const fingerprintRef = useRef<string>('')
  const previousRoot = useRef(cwd)
  const root = cwd

  // Dock geometry: whole-dock expand + auxiliary-panel expand + drag shares,
  // transient (refresh restores the defaults), like the official widths.
  // The file region is the main panel and never collapses on its own — its
  // title-bar control collapses the whole dock; git and future panels are
  // auxiliary and collapse individually.
  const [expanded, setExpanded] = useState(true)
  const [gitExpanded, setGitExpanded] = useState(true)
  const [historyExpanded, setHistoryExpanded] = useState(true)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [gitRatio, setGitRatio] = useState(DEFAULT_GIT_RATIO)
  const [historyRatio, setHistoryRatio] = useState(DEFAULT_HISTORY_RATIO)
  const [dragging, setDragging] = useState(false)
  const dragWidth = useRef<{ startX: number; startWidth: number; lastWidth: number } | null>(null)
  const dragGit = useRef<{ startY: number; startRatio: number; lastRatio: number } | null>(null)
  const dragHistory = useRef<{ startY: number; startRatio: number; lastRatio: number } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const gitRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)

  // Mount the push stylesheet once; the width variable below drives it.
  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'ui-cw-fileexplorer'
    style.textContent = PUSH_CSS
    document.head.appendChild(style)
    return () => { style.remove() }
  }, [])

  // Publish the push width: expanded pushes by the panel width, collapsed
  // pushes by nothing (the slim rail overlays the official UI instead).
  useEffect(() => {
    if (dragging) return // the drag loop writes the variable directly
    document.documentElement.style.setProperty(WIDTH_VAR, expanded ? `${width}px` : '0px')
  }, [expanded, width, dragging])

  /** Write the current drag width straight to the DOM (zero React renders). */
  const applyDragWidth = (next: number): void => {
    const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next))
    document.documentElement.style.setProperty(WIDTH_VAR, `${clamped}px`)
    if (panelRef.current !== null) panelRef.current.style.width = `${clamped}px`
    if (dragWidth.current !== null) dragWidth.current.lastWidth = clamped
  }

  const onWidthPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragWidth.current = { startX: event.clientX, startWidth: width, lastWidth: width }
    setDragging(true)
    document.documentElement.dataset.dshFileexplorerDragging = ''
  }
  const onWidthPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = dragWidth.current
    if (current === null) return
    applyDragWidth(current.startWidth + (current.startX - event.clientX))
  }
  const onWidthPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = dragWidth.current
    dragWidth.current = null
    setDragging(false)
    delete document.documentElement.dataset.dshFileexplorerDragging
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (current !== null) setWidth(current.lastWidth)
  }

  /** Write the current git-drawer height share straight to the DOM. */
  const applyDragGit = (next: number): void => {
    const clamped = Math.min(MAX_AUX_RATIO, Math.max(MIN_AUX_RATIO, Math.min(next, MAX_AUX_TOTAL - historyRatio)))
    // Same rounding as the rendered flexBasis, so pointer-up hands back the
    // exact value on screen and the re-armed transition has nothing to do.
    const rounded = Math.round(clamped * 1000) / 1000
    if (gitRef.current !== null) gitRef.current.style.flexBasis = `${rounded * 100}%`
    if (dragGit.current !== null) dragGit.current.lastRatio = rounded
  }

  const onGitDividerPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragGit.current = { startY: event.clientY, startRatio: gitRatio, lastRatio: gitRatio }
    setDragging(true)
    document.documentElement.dataset.dshFileexplorerDragging = ''
  }
  const onGitDividerPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = dragGit.current
    if (current === null) return
    const height = panelRef.current?.clientHeight ?? 1
    // Dragging the divider up grows the git drawer (the drawer's top edge
    // rises); the history drawer's share is untouched.
    applyDragGit(current.startRatio + (current.startY - event.clientY) / height)
  }
  const onGitDividerPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = dragGit.current
    dragGit.current = null
    setDragging(false)
    delete document.documentElement.dataset.dshFileexplorerDragging
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (current !== null) setGitRatio(current.lastRatio)
  }

  /** Write the current history-drawer height share straight to the DOM. */
  const applyDragHistory = (next: number): void => {
    const clamped = Math.min(MAX_AUX_RATIO, Math.max(MIN_AUX_RATIO, Math.min(next, MAX_AUX_TOTAL - gitRatio)))
    const rounded = Math.round(clamped * 1000) / 1000
    if (historyRef.current !== null) historyRef.current.style.flexBasis = `${rounded * 100}%`
    if (dragHistory.current !== null) dragHistory.current.lastRatio = rounded
  }

  const onHistoryDividerPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragHistory.current = { startY: event.clientY, startRatio: historyRatio, lastRatio: historyRatio }
    setDragging(true)
    document.documentElement.dataset.dshFileexplorerDragging = ''
  }
  const onHistoryDividerPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = dragHistory.current
    if (current === null) return
    const height = panelRef.current?.clientHeight ?? 1
    // Same feel: dragging the divider up grows the history drawer, leaving
    // the git drawer's share untouched.
    applyDragHistory(current.startRatio + (current.startY - event.clientY) / height)
  }
  const onHistoryDividerPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    const current = dragHistory.current
    dragHistory.current = null
    setDragging(false)
    delete document.documentElement.dataset.dshFileexplorerDragging
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (current !== null) setHistoryRatio(current.lastRatio)
  }

  // Re-root only when the WORKSPACE changes (a different session in the same
  // workspace keeps the browsed position); clicking into another workspace
  // resets to its root and clears the selected file.
  useEffect(() => {
    if (previousRoot.current !== cwd) {
      previousRoot.current = cwd
      setPath(undefined)
      setSelectedFile(null)
      fingerprintRef.current = ''
    }
  }, [cwd])

  // File loading and polling run only while the dock is expanded AND a
  // workspace root exists; collapsing tears the timer down with the effect.
  useEffect(() => {
    if (!expanded || root === undefined) {
      fingerprintRef.current = ''
      setListing(undefined)
      setError(undefined)
      return
    }
    let cancelled = false
    let timer: number | undefined
    const refresh = async (): Promise<void> => {
      try {
        const result = await list(root, path, new AbortController().signal)
        if (cancelled) return
        if (result.ok) {
          const next = fingerprint(result.value)
          if (next !== fingerprintRef.current) {
            fingerprintRef.current = next
            setListing(result.value)
          }
          setError(undefined)
        } else {
          setError(result.error.message)
        }
      } catch {
        if (!cancelled) setError('load failed')
      }
    }
    void refresh()
    timer = window.setInterval(() => { void refresh() }, POLL_MS)
    const onVisible = (): void => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [expanded, root, path, list])

  /** One auxiliary drawer: its own basis share when open, title bar when not. */
  const drawerStyle = (open: boolean, ratio: number): React.CSSProperties => ({
    // Independent flex properties, never the shorthand: `flex: '40% 1 0%'`
    // parses inconsistently across browsers and the drag loop writes
    // flexBasis directly, so React and the drag must agree on the property.
    flexGrow: 0, // each drawer keeps exactly its basis share
    flexShrink: open ? 1 : 0,
    flexBasis: open ? `${ratio * 100}%` : 'auto',
    transition: dragging ? 'none' : 'flex-basis 160ms ease',
  })

  return (
    <div
      ref={panelRef}
      data-dsh-fileexplorer
      className={css.panel}
      style={{
        position: 'fixed',
        top: 0,
        bottom: 0,
        right: 0,
        height: '100vh', // explicit full height: the rail's vertical centering depends on it
        zIndex: 30,
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        overflow: 'hidden',
        width: expanded ? width : RAIL_WIDTH,
        // The transition animates collapse/expand and re-arms after a drag;
        // while dragging it is off so the pointer feels 1:1.
        transition: dragging ? 'none' : 'width 160ms ease',
      }}
    >
      {expanded && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('divider.label')}
          className={css.divider}
          onPointerDown={onWidthPointerDown}
          onPointerMove={onWidthPointerMove}
          onPointerUp={onWidthPointerUp}
          onPointerCancel={onWidthPointerUp}
        />
      )}
      {!expanded && (
        <div className={css.rail}>
          <button
            type="button"
            className={css.railButton}
            aria-label={t('expand.label')}
            title={t('expand.label')}
            onClick={() => { setExpanded(true) }}
          >
            <IconChevronLeftOutline14 size={14} />
          </button>
        </div>
      )}
      {expanded && (
        <>
          {/* File region: the main panel, never collapses on its own — its
              title-bar control collapses the whole dock. It absorbs the
              space the git panel does not claim. */}
          <div className={css.drawer} style={{ flexGrow: 1, flexShrink: 1, flexBasis: '0%', minHeight: 0 }}>
            <div className={css.titleRow}>
              <div className={css.title}>{t('view.files')}</div>
              <button
                type="button"
                className={css.toggle}
                aria-expanded={expanded}
                aria-label={t('collapse.label')}
                title={t('collapse.label')}
                onClick={() => { setExpanded(false) }}
              >
                <IconChevronRightOutline14 size={14} />
              </button>
            </div>
            <div className={css.body}>
              {root === undefined ? (
                <div className={css.message}>{t('empty.no-workspace')}</div>
              ) : (
                <>
                  {listing !== undefined && (
                    <div className={css.navRow}>
                      <Breadcrumbs
                        crumbs={listing.crumbs}
                        onNavigate={setPath}
                      />
                      {/* Reveal the current folder in the host OS (Explorer /
                          Finder). */}
                      <button
                        type="button"
                        className={css.openButton}
                        aria-label={t('open.folder')}
                        title={t('open.folder')}
                        onClick={() => { void openInSystem(listing.path, new AbortController().signal) }}
                      >
                        <IconFolderOpen16 size={14} />
                      </button>
                    </div>
                  )}
                  {error !== undefined && (
                    <div className={css.message}>{t('error.load')}：{error}</div>
                  )}
                  {listing !== undefined && (
                    <ul className={css.list}>
                      {listing.entries
                        .filter(entry => !entry.hidden) // hidden entries stay off the surface (v1)
                        .map(entry => (
                          <FileRow
                            key={entry.path}
                            entry={entry}
                            onOpen={entry.kind === 'dir' ? () => { setPath(entry.path) } : undefined}
                            selected={selectedFile?.path === entry.path}
                            onSelect={() => { setSelectedFile({ name: entry.name, path: entry.path }) }}
                          />
                        ))}
                      {listing.truncated && <li className={css.message}>…</li>}
                    </ul>
                  )}
                </>
              )}
            </div>
          </div>
          {/* Divider above the git drawer (only while it is expanded). */}
          {gitExpanded && (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label={t('git.divider.label')}
              className={css.dividerH}
              onPointerDown={onGitDividerPointerDown}
              onPointerMove={onGitDividerPointerMove}
              onPointerUp={onGitDividerPointerUp}
              onPointerCancel={onGitDividerPointerUp}
            />
          )}
          {/* Git drawer: independent layer with its own title bar, collapse
              control, and height share. */}
          <div ref={gitRef} className={css.drawer} style={drawerStyle(gitExpanded, gitRatio)}>
            <div className={css.titleRow}>
              <div className={css.title}>{t('git.title')}</div>
              <button
                type="button"
                className={css.toggle}
                aria-expanded={gitExpanded}
                aria-label={gitExpanded ? t('git.collapse') : t('git.expand')}
                title={gitExpanded ? t('git.collapse') : t('git.expand')}
                onClick={() => { setGitExpanded(current => !current) }}
              >
                {gitExpanded ? <IconChevronRightOutline14 size={14} /> : <IconChevronLeftOutline14 size={14} />}
              </button>
            </div>
            {gitExpanded && (
              <GitDrawer
                root={root}
                expanded={gitExpanded}
                git={git}
                t={t}
              />
            )}
          </div>
          {/* Divider above the history drawer (only while it is expanded). */}
          {historyExpanded && (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label={t('history.divider.label')}
              className={css.dividerH}
              onPointerDown={onHistoryDividerPointerDown}
              onPointerMove={onHistoryDividerPointerMove}
              onPointerUp={onHistoryDividerPointerUp}
              onPointerCancel={onHistoryDividerPointerUp}
            />
          )}
          {/* History drawer: independent layer with its own title bar,
              collapse control, and height share. */}
          <div ref={historyRef} className={css.drawer} style={drawerStyle(historyExpanded, historyRatio)}>
            <div className={css.titleRow}>
              <div className={css.title}>{t('history.title')}</div>
              <button
                type="button"
                className={css.toggle}
                aria-expanded={historyExpanded}
                aria-label={historyExpanded ? t('history.collapse') : t('history.expand')}
                title={historyExpanded ? t('history.collapse') : t('history.expand')}
                onClick={() => { setHistoryExpanded(current => !current) }}
              >
                {historyExpanded ? <IconChevronRightOutline14 size={14} /> : <IconChevronLeftOutline14 size={14} />}
              </button>
            </div>
            {historyExpanded && (
              <FileHistoryView
                root={root}
                file={selectedFile}
                expanded={historyExpanded}
                fileHistory={fileHistory}
                t={t}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Breadcrumb navigation over one listing's crumb chain. The separator follows
 * the path style — backslash on Windows so the chain reads "D:\folder\sub"
 * rather than "D:\/sub". The chain never wraps: long chains collapse the
 * interior into an ellipsis and each crumb truncates its own label.
 */
function Breadcrumbs(props: {
  crumbs: readonly { name: string; path: string }[]
  onNavigate: (path: string) => void
}): React.JSX.Element {
  const { crumbs, onNavigate } = props
  const separator = crumbs.some(crumb => crumb.path.includes('\\')) ? '\\' : '/'
  // Interior collapse: keep the root and the last two crumbs, drop the rest.
  const visible = crumbs.length <= 3 ? crumbs : [crumbs[0]!, crumbs[crumbs.length - 2]!, crumbs[crumbs.length - 1]!]
  const collapsed = crumbs.length > 3
  return (
    <div className={css.crumbs} role="navigation" aria-label="breadcrumb">
      {visible.map((crumb, index) => {
        const last = index === visible.length - 1
        return (
          <span key={crumb.path} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, minWidth: 0 }}>
            {index > 0 && (
              <>
                {index === 1 && collapsed && (
                  <span className={css.crumbSeparator} aria-hidden="true">…</span>
                )}
                <span className={css.crumbSeparator}>{separator}</span>
              </>
            )}
            {/* Every crumb — the current one included, so the initial
                workspace-root state still answers hover — reveals its full
                path. The dock sits at the right edge, so the bubble drops
                below the crumb. */}
            <Tooltip label={crumb.path} side="bottom" delayMs={500}>
              {last ? (
                <span className={clsx(css.crumb, css.crumbActive)}>{crumb.name}</span>
              ) : (
                <button
                  type="button"
                  className={css.crumb}
                  onClick={() => { onNavigate(crumb.path) }}
                >
                  {crumb.name}
                </button>
              )}
            </Tooltip>
          </span>
        )
      })}
    </div>
  )
}

function FileRow(props: {
  entry: FileExplorerEntry
  onOpen?: () => void
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const { entry, onOpen, selected, onSelect } = props
  const [hovered, setHovered] = useState(false)
  const clickable = onOpen !== undefined || entry.kind === 'file'
  const git = entry.git
  return (
    <li>
      <div
        role={clickable ? 'button' : undefined}
        tabIndex={clickable ? 0 : undefined}
        className={clsx(css.row, onOpen !== undefined && css.rowDir, selected && css.rowSelected)}
        onClick={onOpen ?? onSelect}
        onKeyDown={clickable ? (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); (onOpen ?? onSelect)() } } : undefined}
        onMouseEnter={() => { setHovered(true) }}
        onMouseLeave={() => { setHovered(false) }}
      >
        <span className={css.rowIcon} aria-hidden="true">
          {entry.kind === 'dir'
            ? (hovered ? <IconFolderOpen16 size={16} /> : <IconFolderClose16 size={16} />)
            : <FileGlyph />}
        </span>
        {git !== undefined && (
          <span
            className={clsx(css.gitBadge, git === 'M' && css.gitModified, git === 'D' && css.gitDeleted, git === 'A' && css.gitAdded)}
            title={git === 'M' ? 'modified' : git === 'D' ? 'deleted' : 'added'}
          >
            {git}
          </span>
        )}
        <span
          className={clsx(
            css.name,
            git === 'M' && css.nameModified,
            git === 'D' && css.nameDeleted,
            git === 'A' && css.nameAdded,
          )}
        >
          {entry.name}
        </span>
        <span className={css.meta}>{entry.kind === 'dir' ? '' : formatSize(entry.size)}</span>
      </div>
    </li>
  )
}
