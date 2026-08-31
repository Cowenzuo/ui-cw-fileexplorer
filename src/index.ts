/**
 * ui-cw-fileexplorer node half: registers the /fileexplorer RPC channel.
 *
 * `ctx.connection.rpc.handle` mounts a webserver prefix route with the
 * browser-trust fence and serves RPC envelopes — the same transport the
 * browser half calls through `ctx.connection.rpc.call`. `trusted-host`
 * authority matches the trust class of the directory picker's listing
 * primitives (read-only enumeration).
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: HostConnectionService lives in rpc-host.ts, the same module that
// declares the ctx.connection Context merge — referencing it forces that
// declaration file into the program, so `ctx.connection` typechecks.
import type { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { createFileExplorerHandler } from './handler.ts'

/** Services required before activation: the host Connection transport. */
export const inject = ['connection']

/** Node half body. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.connection.rpc.handle(
    '/fileexplorer',
    createFileExplorerHandler(),
  ), 'ui-cw-fileexplorer: /fileexplorer channel')
}
