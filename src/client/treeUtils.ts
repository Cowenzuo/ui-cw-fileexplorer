/**
 * Pure tree helpers shared by the file tree view. Kept free of any UI
 * imports so tests can load them without the plugin's UI runtime
 * (vitest cannot resolve @deepseek-ai/dsh-client-ui-primitives).
 */

export interface FileTreeNode {
  path: string
  kind: 'file' | 'dir'
  expanded: boolean
  children: FileTreeNode[] | null
}

/** Recursively locate a node by path in the loaded tree. */
export function findNode(list: FileTreeNode[], path: string): FileTreeNode | undefined {
  for (const node of list) {
    if (node.path === path) return node
    if (node.children !== null) {
      const found = findNode(node.children, path)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * Ancestor directories of `path` strictly BELOW the workspace `root` (the
 * root itself has no row in the tree). The chain stops at the root: the
 * drive segment and everything above it must never enter the walk (a
 * missing node would abort the reveal — the "ancestors never expanded"
 * regression was exactly that).
 */
export function ancestorDirs(path: string, root: string): string[] {
  const dirs: string[] = []
  let current = path
  for (;;) {
    const idx = Math.max(current.lastIndexOf('\\'), current.lastIndexOf('/'))
    if (idx <= 0) break
    const parent = current.slice(0, idx)
    if (parent === root) break
    dirs.unshift(parent)
    current = parent
  }
  return dirs
}
