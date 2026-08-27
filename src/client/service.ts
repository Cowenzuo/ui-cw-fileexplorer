/**
 * FileExplorer wire client: one thin wrapper over the generic connection RPC
 * channel. Lives in the apply world (constructed with ctx); the view receives
 * the callbacks through the register inject face.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the browser ConnectionHandle face (no Context merge exists on the
// client side — every plugin reaches the handle through ctx.get, this one too).
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {
  FileExplorerListing, FileExplorerListRequest, FileExplorerGitRequest,
  FileExplorerHistoryRequest, FileHistorySnapshot, GitSnapshot,
} from '../contract.ts'

/** Callback face the view consumes; plain data and callbacks only. */
export interface FileExplorerClient {
  list(root: string | undefined, path: string | undefined, signal: AbortSignal): Promise<RpcResult<FileExplorerListing>>
  git(root: string, ref: string | null, signal: AbortSignal): Promise<RpcResult<GitSnapshot>>
  fileHistory(root: string, path: string, signal: AbortSignal): Promise<RpcResult<FileHistorySnapshot>>
  /** Ask the host OS to reveal a path (the official host.openPath privilege). */
  openInSystem(path: string, signal: AbortSignal): Promise<RpcResult<unknown>>
}

/**
 * Build the client over the current connection transport.
 * @param ctx - client root context (apply world only).
 */
export function createFileExplorerClient(ctx: Context): FileExplorerClient {
  // The single tsconfig hosts both halves, so the node half's Context merge
  // (HostConnectionHandle) shapes ctx.get here; the runtime handle is the
  // browser ConnectionHandle (same service, client-side face).
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  return {
    list: async (root, path, signal) => {
      const payload: FileExplorerListRequest = {
        ...(root === undefined ? {} : { root }),
        ...(path === undefined ? {} : { path }),
        git: true, // file rows carry their working-tree state when available
      }
      const result = await connection.rpc.call('/fileexplorer', 'list', payload, signal)
      return result as RpcResult<FileExplorerListing>
    },
    git: async (root, ref, signal) => {
      const payload: FileExplorerGitRequest = {
        root,
        ...(ref === null ? {} : { ref }),
      }
      const result = await connection.rpc.call('/fileexplorer', 'git', payload, signal)
      return result as RpcResult<GitSnapshot>
    },
    fileHistory: async (root, path, signal) => {
      const payload: FileExplorerHistoryRequest = { root, path }
      const result = await connection.rpc.call('/fileexplorer', 'file-history', payload, signal)
      return result as RpcResult<FileHistorySnapshot>
    },
    openInSystem: async (path, signal) => {
      // The official host.openPath privilege rides the shared /api channel
      // (loopback-pinned); the OS reveals the folder with its default app.
      return connection.rpc.call('/api', 'host.openPath', { path }, signal)
    },
  }
}
