/**
 * Git drawer: read-only branch + recent-commit view for the session
 * workspace. No mutation surface by design — this is a glance view; details
 * belong to real git tooling.
 *
 * The branch badge is a dropdown: picking another local branch switches the
 * viewed commit tree (never checking anything out). Polling also watches for
 * external changes — a branch switch or new commits made by other tooling
 * surface as a transient notice.
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconBranchOutline16, IconChevronDownOutline14,
  IconDataOutline16, IconGlobeOutline14, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { NS } from './locales.ts'
import type { GitSnapshot } from '../contract.ts'
import css from './GitDrawer.module.css'

export interface GitDrawerInjected {
  git(root: string, ref: string | null, signal: AbortSignal): Promise<RpcResult<GitSnapshot>>
}

const POLL_MS = 2_000
/** How long an external-change notice stays visible. */
const NOTICE_MS = 3_000

function snapshotFingerprint(snapshot: GitSnapshot | undefined): string {
  if (snapshot === undefined) return ''
  return JSON.stringify([snapshot.ok, snapshot.branch, snapshot.headHash, snapshot.commits])
}

export function GitDrawer(props: {
  root: string | undefined
  /** Whether the git tab is the active auxiliary tab (drives polling). */
  expanded: boolean
  git: GitDrawerInjected['git']
  t: TranslateNS<typeof NS>
}): React.JSX.Element {
  const { root, expanded, git, t } = props
  const [snapshot, setSnapshot] = useState<GitSnapshot | undefined>(undefined)
  const [viewRef, setViewRef] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const fingerprintRef = useRef<string>('')
  const noticeTimer = useRef<number | undefined>(undefined)
  // External-change watch: the last branch/tip seen; null suppresses the
  // notice on the first load and after the user picks a branch themselves.
  const previousState = useRef<{ branch: string | null; headHash: string | null } | null>(null)

  useEffect(() => {
    if (!expanded || root === undefined) {
      fingerprintRef.current = ''
      // The workspace leaving clears the data; a mere collapse keeps the last
      // snapshot so the title bar still shows the branch and re-expanding is
      // instant.
      if (root === undefined) setSnapshot(undefined)
      return
    }
    let cancelled = false
    let timer: number | undefined
    const refresh = async (): Promise<void> => {
      try {
        const result = await git(root, viewRef, new AbortController().signal)
        if (cancelled) return
        if (result.ok) {
          const next = snapshotFingerprint(result.value)
          if (next !== fingerprintRef.current) {
            fingerprintRef.current = next
            setSnapshot(result.value)
            const previous = previousState.current
            previousState.current = { branch: result.value.branch, headHash: result.value.headHash }
            if (previous !== null
              && (previous.branch !== result.value.branch || previous.headHash !== result.value.headHash)) {
              const message = previous.branch !== result.value.branch
                ? t('git.notice.branch', { name: result.value.branch ?? '?' })
                : t('git.notice.head')
              setNotice(message)
              window.clearTimeout(noticeTimer.current)
              noticeTimer.current = window.setTimeout(() => { setNotice(null) }, NOTICE_MS)
            }
          }
        }
      } catch {
        // transient transport failure: keep the last snapshot
      }
    }
    void refresh()
    timer = window.setInterval(() => { void refresh() }, POLL_MS)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearInterval(timer)
      window.clearTimeout(noticeTimer.current)
    }
  }, [expanded, root, viewRef, git, t])

  // The dropdown closes on any outside press.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (): void => { setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [menuOpen])

  const branch = snapshot?.ok === true ? snapshot.branch : undefined
  const upstream = snapshot?.ok === true ? snapshot.upstream : undefined
  const ahead = snapshot?.ok === true ? snapshot.ahead : 0
  const behind = snapshot?.ok === true ? snapshot.behind : 0
  const activeRef = viewRef ?? branch ?? null

  return (
    <div className={css.drawer}>
      <div className={css.branchRow}>
        {branch !== undefined && branch !== null && (
          <Tooltip
            label={upstream === null ? t('git.branch.no-upstream') : `${branch} → ${upstream}`}
            side="bottom"
            delayMs={500}
          >
            <button
              type="button"
              className={css.branchBadge}
              aria-haspopup="listbox"
              aria-expanded={menuOpen}
              onClick={(event) => { event.stopPropagation(); setMenuOpen(current => !current) }}
            >
              <IconBranchOutline16 size={12} />
              <span className={css.branchName}>{viewRef ?? branch}</span>
              {viewRef === null && upstream !== null && ahead > 0 && <span className={css.aheadMark}>↑{ahead}</span>}
              {viewRef === null && upstream !== null && behind > 0 && <span className={css.behindMark}>↓{behind}</span>}
              <IconChevronDownOutline14 size={10} />
            </button>
          </Tooltip>
        )}
      </div>
      {menuOpen && snapshot?.ok === true && snapshot.branches.length > 0 && (
        <div className={css.branchMenu} role="listbox" aria-label={t('git.select-branch')}>
          {snapshot.branches.map(name => (
            <button
              key={name}
              type="button"
              role="option"
              aria-selected={activeRef === name}
              className={clsx(css.branchItem, activeRef === name && css.branchItemActive)}
              onClick={() => {
                // Selecting the working branch returns to follow mode.
                setViewRef(name === snapshot.branch ? null : name)
                previousState.current = null // own change: no external notice
                setMenuOpen(false)
              }}
            >
              <span className={css.branchItemName}>{name}</span>
              {name === snapshot.branch && <span className={css.branchItemMark}>{t('git.current')}</span>}
            </button>
          ))}
        </div>
      )}
      <div className={css.body}>
        {notice !== null && <div className={css.notice}>{notice}</div>}
        {root === undefined ? (
          <div className={css.message}>{t('git.empty.workspace')}</div>
        ) : snapshot === undefined ? (
          <div className={css.message}>{t('git.loading')}</div>
        ) : snapshot.ok === false ? (
          <div className={css.message}>
            {snapshot.reason === 'no-git' ? t('git.empty.no-git') : t('git.empty.not-repo')}
          </div>
        ) : snapshot.commits.length === 0 ? (
          <div className={css.message}>{t('git.empty.no-commits')}</div>
        ) : (
          <>
            {snapshot.upstream === null && (
              <div className={css.noUpstream}>{t('git.no-upstream')}</div>
            )}
            <ul className={css.list}>
              {snapshot.commits.map(commit => {
                const isHead = snapshot.headHash !== null && commit.hash === snapshot.headHash
                const isRemote = snapshot.remoteHead !== null && commit.hash === snapshot.remoteHead
                return (
                  <li key={commit.hash} className={css.row} title={commit.subject}>
                    {isHead && (
                      <span className={clsx(css.tag, css.tagHead)} title={t('git.tag.head')}>
                        <IconDataOutline16 size={11} />
                      </span>
                    )}
                    {isRemote && (
                      <span className={clsx(css.tag, css.tagRemote)} title={snapshot.upstream ?? t('git.tag.remote')}>
                        <IconGlobeOutline14 size={11} />
                      </span>
                    )}
                    <span className={css.hash}>{commit.hash}</span>
                    <span className={css.subject}>{commit.subject}</span>
                    {commit.date !== undefined && <span className={css.date}>{commit.date}</span>}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
