/**
 * ui-cw-fileexplorer browser half: registers the right-side dock file region
 * into the official `shell.overlay` slot (root-level list slot, zero official
 * source changes).
 *
 * The dock pushes the official UI left through a `#root { margin-right }`
 * stylesheet driven by a CSS variable (the same technique the
 * dsh-better-sidebar plugin validates), so the conversation area yields the
 * space without touching any official component. The occupant follows the
 * currently selected session through the global session hooks: clicking any
 * conversation in the sidebar switches the dock to that session's workspace,
 * and with no session selected the dock shows an empty-state hint.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the 'shell.overlay' SlotMap row (declared by ui-layout) and the
// ctx.locale / ctx.slots Context merges must be in the program for the
// register calls to type; LocaleDict/LocaleId are used below, which also
// forces the locale package's declaration file (and its ctx.locale merge) to
// load.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { LocaleDict, LocaleId } from '@deepseek-ai/dsh-client-locale/client'
import { createFileExplorerClient } from './service.ts'
import { FileExplorerDock, type FileExplorerInjected } from './FileExplorerView.tsx'
import { en, NS, zh } from './locales.ts'

/** Required services: the slot registry, the locale service, and the wire client. */
export const inject = ['slots', 'locale', 'connection']

/**
 * Browser plugin body: register the file explorer dock into the overlay
 * layer. The registration rides the slot service's effect wrapper, so plugin
 * unload removes the dock.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en } satisfies Record<LocaleId, LocaleDict>), 'fileexplorer: dictionaries')
  const client = createFileExplorerClient(ctx)
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'fileexplorer',
    locale: NS,
    // Last in the overlay layer's DOM order.
    order: 1000,
    inject: (): FileExplorerInjected => ({
      list: client.list,
      git: client.git,
      fileHistory: client.fileHistory,
      openInSystem: client.openInSystem,
    }),
  }, FileExplorerDock))
}
