/**
 * File explorer dock: a right-side panel rendered into the official
 * `shell.overlay` slot. Three layers: the file region (one lazy TREE of the
 * workspace with git working-tree states per row), the Git branch view
 * drawer, and the selected-file history drawer — each auxiliary drawer
 * collapses independently and has its own height divider.
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
import {
  IconChevronLeftOutline14,
  IconChevronRightOutline14,
  IconFolderOpen16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { NS } from './locales.ts'
import type { FileExplorerListing } from '../contract.ts'
import { GitDrawer, type GitDrawerInjected } from './GitDrawer.tsx'
import { FileHistoryView, type FileHistoryInjected } from './FileHistoryView.tsx'
import { FileTree, type FileTreeInjected } from './FileTree.tsx'
import css from './FileExplorerView.module.css'

/** Business callbacks injected by the register site (apply world). */
export interface FileExplorerInjected extends GitDrawerInjected, FileHistoryInjected, FileTreeInjected {
  /**
   * List one level. `root` is the locked workspace the explorer may not
   * escape; `path` (inside root) is the listed directory (a tree node).
   */
  list(root: string | undefined, path: string | undefined, signal: AbortSignal): Promise<RpcResult<FileExplorerListing>>
  /** Reveal a path in the host OS (host.openPath). */
  openInSystem(path: string, signal: AbortSignal): Promise<RpcResult<unknown>>
  /**
   * Broadcast a clicked file to consumers (ui-cw-textviewer) through the
   * cordis event bus (`ui-cw/fileexplorer/file-open`, payload below).
   */
  notifyFileOpen(file: { name: string; path: string; root: string }): void
}

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

/**
 * Seamless title-bar toggle: the whole title row collapses/expands on click,
 * but a press that was really a text-selection drag (pointer moved beyond the
 * click threshold) or a click with a live selection does nothing — copying a
 * path out of the title must never collapse the panel. Inside controls stop
 * propagation, so the collapse button keeps its own behavior.
 */
function useTitleClick(toggle: () => void): {
  onPointerDown: (event: React.PointerEvent) => void
  onClick: (event: React.MouseEvent) => void
} {
  const downRef = useRef<{ x: number; y: number } | null>(null)
  return {
    onPointerDown: (event) => { downRef.current = { x: event.clientX, y: event.clientY } },
    onClick: (event) => {
      const selection = window.getSelection()
      if (selection !== null && selection.toString() !== '') return
      const start = downRef.current
      downRef.current = null
      if (start !== null && Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 4) return
      toggle()
    },
  }
}
/** Root-level push stylesheet: official UI yields to the dock. */
const PUSH_CSS = [
  `:root { ${WIDTH_VAR}: ${RAIL_WIDTH}px; }`,
  `#root { margin-right: var(${WIDTH_VAR}); transition: margin-right 160ms ease; }`,
  `:root[data-dsh-fileexplorer-dragging] #root { transition: none; }`,
].join('\n')

/** Inline document glyph (the primitives library ships no file icon). */
export function FileExplorerDock(
  props: PropsRuntime<'shell.overlay'> & InjectFace<FileExplorerInjected> & PropsLocale<typeof NS>,
): React.JSX.Element {
  const { useSessions, list, git, fileHistory, openInSystem, notifyFileOpen, t } = props
  const sessionId = useSessions(state => state.current)
  // The session workspace is the explorer's locked root (VS Code style): the
  // view may only descend inside it, never escape upward.
  const cwd = useSessions(state => (sessionId === undefined ? undefined : state.byId[sessionId]?.cwd))
  const [selectedFile, setSelectedFile] = useState<{ name: string; path: string } | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const openErrorTimer = useRef<number | undefined>(undefined)
  const previousRoot = useRef(cwd)
  const root = cwd

  // Dock geometry: whole-dock expand + auxiliary-panel expand + drag shares,
  // transient (refresh restores the defaults), like the official widths.
  // The file region is the main panel and never collapses on its own — its
  // title-bar control collapses the whole dock; git and future panels are
  // auxiliary and collapse individually.
  const [expanded, setExpanded] = useState(true)
  const [gitExpanded, setGitExpanded] = useState(true)
  // The history drawer defaults collapsed: the file region and the git view
  // are the everyday surfaces; history opens on demand.
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  const [gitRatio, setGitRatio] = useState(DEFAULT_GIT_RATIO)
  const [historyRatio, setHistoryRatio] = useState(DEFAULT_HISTORY_RATIO)
  const [dragging, setDragging] = useState(false)
  const dragWidth = useRef<{ startX: number; startWidth: number; lastWidth: number } | null>(null)
  const dragGit = useRef<{ startY: number; startRatio: number; lastRatio: number } | null>(null)
  const dragHistory = useRef<{ startY: number; startRatio: number; lastRatio: number } | null>(null)
  // Whole-title-row collapse/expand toggles (selection/drag safe).
  const dockTitleClick = useTitleClick(() => setExpanded(false))
  const gitTitleClick = useTitleClick(() => setGitExpanded(current => !current))
  const historyTitleClick = useTitleClick(() => setHistoryExpanded(current => !current))
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

  // Publish the push width: expanded pushes by the panel width, collapsed by
  // the rail width (the rail still occupies that strip, so consumers must not
  // see 0 — a bottom dock reading this variable would otherwise cover it).
  useEffect(() => {
    if (dragging) return // the drag loop writes the variable directly
    document.documentElement.style.setProperty(WIDTH_VAR, expanded ? `${width}px` : `${RAIL_WIDTH}px`)
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

  /** Reveal the workspace root in the host OS; a refusal surfaces transiently. */
  const handleOpenInSystem = async (): Promise<void> => {
    if (root === undefined) return
    try {
      const result = await openInSystem(root, new AbortController().signal)
      if (result.ok) return
      setOpenError(result.error.message)
      window.clearTimeout(openErrorTimer.current)
      openErrorTimer.current = window.setTimeout(() => { setOpenError(null) }, 3_000)
    } catch (error) {
      // A transport-level failure (HTTP status, parse error) never yields an
      // RpcResult — surface the same transient error line.
      setOpenError(error instanceof Error ? error.message : String(error))
      window.clearTimeout(openErrorTimer.current)
      openErrorTimer.current = window.setTimeout(() => { setOpenError(null) }, 3_000)
    }
  }

  // A different workspace resets the selection (the tree re-roots itself).
  useEffect(() => {
    if (previousRoot.current !== cwd) {
      previousRoot.current = cwd
      setSelectedFile(null)
    }
  }, [cwd])

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
            <div className={css.titleRow} {...dockTitleClick}>
              <div className={css.title}>{t('view.files')}</div>
              <button
                type="button"
                className={css.toggle}
                aria-expanded={expanded}
                aria-label={t('collapse.label')}
                title={t('collapse.label')}
                onClick={(event) => { event.stopPropagation(); setExpanded(false) }}
              >
                <IconChevronRightOutline14 size={14} />
              </button>
            </div>
            <div className={css.body}>
              {root === undefined ? (
                <div className={css.message}>{t('empty.no-workspace')}</div>
              ) : (
                <>
                  {/* Root header: the workspace path + the reveal-in-OS
                      action. The tree below is the whole file surface. */}
                  <div className={css.navRow}>
                    <span className={css.rootLabel} title={root}>{root}</span>
                    <button
                      type="button"
                      className={css.openButton}
                      aria-label={t('open.folder')}
                      title={`${t('open.folder')}：${root}`}
                      onClick={(event) => {
                        // Drop focus immediately: the Explorer window takes
                        // the foreground, and the browser restores focus to
                        // this button in keyboard mode when the window is
                        // re-activated — leaving a stuck focus ring. A
                        // blurred button cannot keep one.
                        event.currentTarget.blur()
                        void handleOpenInSystem()
                      }}
                    >
                      <IconFolderOpen16 size={14} />
                    </button>
                  </div>
                  {openError !== null && (
                    <div className={css.message}>{t('error.load')}：{openError}</div>
                  )}
                  <FileTree
                    root={root}
                    list={list}
                    t={t}
                    selectedPath={selectedFile?.path ?? null}
                    onSelectFile={(file) => {
                      setSelectedFile(file)
                      // Broadcast to consumers (the text viewer): clicking a
                      // file opens it in the viewer; dirs never emit.
                      if (file !== null) notifyFileOpen({ name: file.name, path: file.path, root })
                    }}
                  />
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
            <div className={css.titleRow} {...gitTitleClick}>
              <div className={css.title}>{t('git.title')}</div>
              <button
                type="button"
                className={css.toggle}
                aria-expanded={gitExpanded}
                aria-label={gitExpanded ? t('git.collapse') : t('git.expand')}
                title={gitExpanded ? t('git.collapse') : t('git.expand')}
                onClick={(event) => { event.stopPropagation(); setGitExpanded(current => !current) }}
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
            <div className={css.titleRow} {...historyTitleClick}>
              <div className={css.title}>{t('history.title')}</div>
              <button
                type="button"
                className={css.toggle}
                aria-expanded={historyExpanded}
                aria-label={historyExpanded ? t('history.collapse') : t('history.expand')}
                title={historyExpanded ? t('history.collapse') : t('history.expand')}
                onClick={(event) => { event.stopPropagation(); setHistoryExpanded(current => !current) }}
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

