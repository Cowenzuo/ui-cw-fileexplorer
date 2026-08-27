/**
 * File history view: read-only commit history of the currently selected
 * file. The file is chosen in the file region (a row click); without a
 * selection the panel shows a hint. Same glance-level presentation as the
 * git view — no details, no mutations.
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { NS } from './locales.ts'
import type { FileHistorySnapshot } from '../contract.ts'
import css from './FileHistoryView.module.css'

export interface FileHistoryInjected {
  fileHistory(root: string, path: string, signal: AbortSignal): Promise<RpcResult<FileHistorySnapshot>>
}

const POLL_MS = 2_000

function snapshotFingerprint(snapshot: FileHistorySnapshot | undefined): string {
  if (snapshot === undefined) return ''
  return JSON.stringify([snapshot.ok, snapshot.commits])
}

export function FileHistoryView(props: {
  root: string | undefined
  /** The selected file (absolute path); null shows the selection hint. */
  file: { name: string; path: string } | null
  /** Whether this tab is the active auxiliary tab (drives polling). */
  expanded: boolean
  fileHistory: FileHistoryInjected['fileHistory']
  t: TranslateNS<typeof NS>
}): React.JSX.Element {
  const { root, file, expanded, fileHistory, t } = props
  const [snapshot, setSnapshot] = useState<FileHistorySnapshot | undefined>(undefined)
  const fingerprintRef = useRef<string>('')

  useEffect(() => {
    if (!expanded || root === undefined || file === null) {
      fingerprintRef.current = ''
      if (root === undefined || file === null) setSnapshot(undefined)
      return
    }
    let cancelled = false
    let timer: number | undefined
    const refresh = async (): Promise<void> => {
      try {
        const result = await fileHistory(root, file.path, new AbortController().signal)
        if (cancelled) return
        if (result.ok) {
          const next = snapshotFingerprint(result.value)
          if (next !== fingerprintRef.current) {
            fingerprintRef.current = next
            setSnapshot(result.value)
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
    }
  }, [expanded, root, file, fileHistory])

  return (
    <div className={css.view}>
      {file !== null && (
        <div className={css.fileRow}>
          <span className={css.fileName} title={file.path}>{file.name}</span>
        </div>
      )}
      <div className={css.body}>
        {file === null ? (
          <div className={css.message}>{t('history.empty.file')}</div>
        ) : snapshot === undefined ? (
          <div className={css.message}>{t('git.loading')}</div>
        ) : snapshot.ok === false ? (
          <div className={css.message}>
            {snapshot.reason === 'no-git' ? t('git.empty.no-git') : t('git.empty.not-repo')}
          </div>
        ) : snapshot.commits.length === 0 ? (
          <div className={css.message}>{t('history.empty.commits')}</div>
        ) : (
          <ul className={css.list}>
            {snapshot.commits.map((commit, index) => (
              <li key={commit.hash} className={css.row} title={commit.subject}>
                {index === 0 && (
                  <span className={clsx(css.tag, css.tagLatest)} title={t('git.tag.head')}>
                    <IconDataOutline16 size={11} />
                  </span>
                )}
                <span className={css.hash}>{commit.hash}</span>
                <span className={css.subject}>{commit.subject}</span>
                {commit.date !== undefined && <span className={css.date}>{commit.date}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
