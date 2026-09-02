/**
 * Tree reveal helpers: the ancestor chain the selection sync expands (see
 * FileTree's revealPath). Pure — the drive-segment bug that made the walk
 * abort on a missing node is regression-tested here.
 */
import { describe, expect, it } from 'vitest'
import { ancestorDirs } from '../src/client/treeUtils.ts'

describe('ancestorDirs', () => {
  it('collects every directory strictly below the workspace root', () => {
    expect(ancestorDirs('D:\\w\\经验记录\\01-a.md', 'D:\\w'))
      .toEqual(['D:\\w\\经验记录'])
    expect(ancestorDirs('D:\\w\\x\\y\\f.md', 'D:\\w'))
      .toEqual(['D:\\w\\x', 'D:\\w\\x\\y'])
  })

  it('returns nothing for a file directly in the workspace root', () => {
    expect(ancestorDirs('D:\\w\\a.txt', 'D:\\w')).toEqual([])
  })

  it('never includes the drive segment or anything above the root', () => {
    // The walk must stop AT the root — 'D:' / 'D' would be missing nodes
    // and abort the whole reveal.
    expect(ancestorDirs('D:\\w\\sub\\f.md', 'D:\\w')).toEqual(['D:\\w\\sub'])
    expect(ancestorDirs('D:\\w\\sub\\f.md', 'D:\\w').some(dir => dir === 'D:' || dir === 'D')).toBe(false)
  })
})
