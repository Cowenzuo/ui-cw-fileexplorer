/**
 * /fileexplorer channel tests: the handler factory is exercised directly
 * against real temporary directories — no cordis machinery, no network.
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, parse } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createFileExplorerHandler, crumbChain, parseAttribOutput, parseGitLog, parseGitStatus, parsePorcelainStatus,
  type FileExplorerListing, type RunGit,
} from '../src/handler.ts'

/** Whether git(1) is available for the integration test. */
const hasGit = spawnSync('git', ['--version']).status === 0

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fileexplorer-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** Assert the result is the success branch and return the listing. */
function expectListing(result: unknown): FileExplorerListing {
  const r = result as { ok: true; value: FileExplorerListing } | { ok: false; error: { code: string } }
  expect(r.ok).toBe(true)
  return (r as { ok: true; value: FileExplorerListing }).value
}

describe('fileexplorer list', () => {
  it('lists files and directories, directories first, name-sorted, with size/mtime and hidden flags', async () => {
    await mkdir(join(root, 'zeta-dir'))
    await mkdir(join(root, 'alpha-dir'))
    await mkdir(join(root, '.hidden-dir'))
    await writeFile(join(root, 'b.txt'), 'hello world')
    await writeFile(join(root, 'a.txt'), 'x')
    await writeFile(join(root, '.gitkeep'), '')

    const listing = expectListing(await createFileExplorerHandler()('list', { path: root }, new AbortController().signal))

    expect(listing.path).toBe(root)
    expect(listing.truncated).toBe(false)
    expect(listing.entries.map(entry => entry.name)).toEqual([
      '.hidden-dir', 'alpha-dir', 'zeta-dir', '.gitkeep', 'a.txt', 'b.txt',
    ])
    const zeta = listing.entries.find(entry => entry.name === 'zeta-dir')
    expect(zeta?.kind).toBe('dir')
    expect(zeta?.size).toBeUndefined()
    const b = listing.entries.find(entry => entry.name === 'b.txt')
    expect(b?.kind).toBe('file')
    expect(b?.size).toBe(11)
    expect(b?.mtimeMs).toBeTypeOf('number')
    // Hidden semantics are platform-specific: POSIX hides dot-prefixed names
    // by convention, Windows only honors the real FILE_ATTRIBUTE_HIDDEN.
    if (process.platform === 'win32') {
      expect(listing.entries.find(entry => entry.name === '.gitkeep')?.hidden).toBe(false)
    } else {
      expect(listing.entries.find(entry => entry.name === '.gitkeep')?.hidden).toBe(true)
    }
    expect(listing.entries.find(entry => entry.name === 'a.txt')?.hidden).toBe(false)
  })

  it('builds a root-to-target crumb chain with the root crumb carrying its full path', async () => {
    const listing = expectListing(await createFileExplorerHandler()('list', { path: root }, new AbortController().signal))
    // The last crumb is the listed directory itself, named by its basename.
    expect(listing.crumbs.at(-1)).toEqual({ name: basename(root), path: root })
    // The first crumb is the filesystem root: on Windows the drive root drops
    // its trailing slash so the breadcrumb reads "C:\..." rather than "C:\ \".
    const rootCrumb = listing.crumbs.at(0)!
    expect(rootCrumb.path).toBe(parse(root).root)
    expect(rootCrumb.name).toBe(process.platform === 'win32' ? parse(root).root.slice(0, -1) : parse(root).root)
    // Every interior crumb names its basename and points at its own path, one
    // dirname step above its successor.
    for (let i = 0; i + 1 < listing.crumbs.length; i += 1) {
      expect(listing.crumbs[i + 1]?.path).toBe(join(listing.crumbs[i]!.path, listing.crumbs[i + 1]!.name))
    }
  })

  it.skipIf(process.platform !== 'win32')('hides entries the injected reader flags with the real attribute', async () => {
    await mkdir(join(root, 'secret'))
    await mkdir(join(root, '.envdir'))
    await writeFile(join(root, 'notes.txt'), 'x')
    const hiddenSet = new Set([join(root, 'secret').toLowerCase()])
    const listing = expectListing(await createFileExplorerHandler({
      readHidden: async () => hiddenSet,
    })('list', { path: root }, new AbortController().signal))
    const secret = listing.entries.find(entry => entry.name === 'secret')
    expect(secret?.hidden).toBe(true)
    // On Windows a dot prefix alone does NOT hide — only the attribute does.
    expect(listing.entries.find(entry => entry.name === '.envdir')?.hidden).toBe(false)
    expect(listing.entries.find(entry => entry.name === 'notes.txt')?.hidden).toBe(false)
  })

  it('locks the listing to a workspace root and clips the crumb chain to it', async () => {
    await mkdir(join(root, 'sub'))
    await writeFile(join(root, 'sub', 'deep.txt'), 'x')
    const handler = createFileExplorerHandler()
    // Descending inside the root: the crumb chain starts at the root.
    const deep = expectListing(await handler('list', { path: join(root, 'sub'), root }, new AbortController().signal))
    expect(deep.crumbs.map(crumb => crumb.path)).toEqual([root, join(root, 'sub')])
    // The root itself: a single crumb.
    const top = expectListing(await handler('list', { path: root, root }, new AbortController().signal))
    expect(top.crumbs.map(crumb => crumb.path)).toEqual([root])
    // Escaping upward is refused host-side.
    const escape = await handler('list', { path: join(root, '..'), root }, new AbortController().signal)
    expect(escape).toMatchObject({ ok: false, error: { code: 'directory-unreadable' } })
    // A locked root that is not even an ancestor of the default target fails.
    const unrelated = await handler('list', { path: root, root: process.cwd() }, new AbortController().signal)
    expect(unrelated).toMatchObject({ ok: false, error: { code: 'directory-unreadable' } })
  })

  it.skipIf(process.platform !== 'win32')('compares the locked root case-insensitively on Windows', async () => {
    const result = await createFileExplorerHandler()('list', { path: root, root: root.toUpperCase() }, new AbortController().signal)
    expect(result).toMatchObject({ ok: true })
  })

  it('parses attrib output into the hidden path set', () => {
    const output = [
      'A  H          D:\\dir\\.git',
      'A             D:\\dir\\file.txt',
      'A  H  R       D:\\dir\\Secret Folder',
      'A             D:\\dir\\$RECYCLE.BIN',
    ].join('\r\n')
    const hidden = parseAttribOutput(output)
    expect(hidden.has('d:\\dir\\.git')).toBe(true)
    expect(hidden.has('d:\\dir\\secret folder')).toBe(true)
    expect(hidden.has('d:\\dir\\file.txt')).toBe(false)
    expect(hidden.has('d:\\dir\\$recycle.bin')).toBe(false)
  })

  it('parses porcelain status into the three explorer states', () => {
    const output = [
      ' M src/a.txt',       // worktree modified
      'MM src/b.txt',       // staged + worktree modified
      'D  src/gone.txt',    // staged delete
      ' D src/rm.txt',      // worktree delete
      '?? new-file.txt',    // untracked -> added
      'A  staged.txt',      // staged add
      'R  old.txt -> new.txt', // rename -> modified, keyed by the new path
      'T  type.txt',        // type change -> modified
      'UU conflict.txt',    // unmerged -> modified
    ].join('\n')
    const map = parsePorcelainStatus(output)
    expect(map.get('src/a.txt')).toBe('M')
    expect(map.get('src/b.txt')).toBe('M')
    expect(map.get('src/gone.txt')).toBe('D')
    expect(map.get('src/rm.txt')).toBe('D')
    expect(map.get('new-file.txt')).toBe('A')
    expect(map.get('staged.txt')).toBe('A')
    expect(map.get('new.txt')).toBe('M')
    expect(map.get('type.txt')).toBe('M')
    expect(map.get('conflict.txt')).toBe('M')
    expect(map.has('old.txt')).toBe(false)
  })

  it('attaches git states to listed entries when requested', async () => {
    await writeFile(join(root, 'mod.txt'), 'a')
    await writeFile(join(root, 'new.txt'), 'b')
    const runGit: RunGit = async (_root, args) => {
      if (args[0] === 'status') return { code: 0, stdout: ' M mod.txt\n?? new.txt\n D gone.txt\n', stderr: '' }
      return { code: 1, stdout: '', stderr: 'not a repository' }
    }
    const listing = expectListing(await createFileExplorerHandler({ runGit })(
      'list',
      { path: root, root, git: true },
      new AbortController().signal,
    ))
    expect(listing.entries.find(entry => entry.name === 'mod.txt')?.git).toBe('M')
    expect(listing.entries.find(entry => entry.name === 'new.txt')?.git).toBe('A')
    // A deleted file no longer exists on disk; git backs it into the level.
    const gone = listing.entries.find(entry => entry.name === 'gone.txt')
    expect(gone?.git).toBe('D')
    expect(gone?.kind).toBe('file')
    // Without the git flag no status is requested; a failing git degrades silently.
    const plain = expectListing(await createFileExplorerHandler({ runGit })('list', { path: root, root }, new AbortController().signal))
    expect(plain.entries.every(entry => entry.git === undefined)).toBe(true)
  })

  it.skipIf(process.platform !== 'win32')('renders a Windows drive root crumb without the trailing slash', () => {
    const crumbs = crumbChain('D:\\a\\b')
    expect(crumbs.map(crumb => crumb.name)).toEqual(['D:', 'a', 'b'])
    expect(crumbs.map(crumb => crumb.path)).toEqual(['D:\\', 'D:\\a', 'D:\\a\\b'])
  })

  it('truncates at maxEntries keeping the name-sorted head', async () => {
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(root, `f${String(i).padStart(2, '0')}.txt`), 'x')
    }
    const listing = expectListing(await createFileExplorerHandler({ maxEntries: 3 })('list', { path: root }, new AbortController().signal))
    expect(listing.truncated).toBe(true)
    expect(listing.entries).toHaveLength(3)
    expect(listing.entries.map(entry => entry.name)).toEqual(['f00.txt', 'f01.txt', 'f02.txt'])
  })

  it('defaults to the host process cwd when no path is given', async () => {
    const listing = expectListing(await createFileExplorerHandler()('list', {}, new AbortController().signal))
    expect(listing.path).toBe(process.cwd())
  })

  it('rejects an unknown endpoint with bad-request', async () => {
    const result = await createFileExplorerHandler()('delete', { path: root }, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('rejects a missing directory with directory-unreadable', async () => {
    const result = await createFileExplorerHandler()('list', { path: join(root, 'nope') }, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'directory-unreadable', details: { path: join(root, 'nope') } } })
  })

  it('rejects a file target with directory-unreadable', async () => {
    await writeFile(join(root, 'plain.txt'), 'x')
    const result = await createFileExplorerHandler()('list', { path: join(root, 'plain.txt') }, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'directory-unreadable' } })
  })

  it('rejects a relative path with directory-unreadable', async () => {
    const result = await createFileExplorerHandler()('list', { path: 'relative/path' }, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'directory-unreadable' } })
  })

  it('reports a caller abort as cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await createFileExplorerHandler()('list', { path: root }, controller.signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  })
})

describe('git snapshot', () => {
  it('parses git log pretty output into commit rows', () => {
    const output = [
      'abc1234\u001fFix the thing\u001f2026-08-20',
      'def5678\u001fAdd feature with spaces\u001f2026-08-19',
      '',
    ].join('\n')
    expect(parseGitLog(output)).toEqual([
      { hash: 'abc1234', subject: 'Fix the thing', date: '2026-08-20' },
      { hash: 'def5678', subject: 'Add feature with spaces', date: '2026-08-19' },
    ])
  })

  it('parses log lines without a date gracefully', () => {
    expect(parseGitLog('abc1234\u001fNo date')).toEqual([{ hash: 'abc1234', subject: 'No date', date: undefined }])
  })

  it('parses git status branch lines', () => {
    expect(parseGitStatus('## master...origin/master [ahead 1, behind 2]\n M file.txt\n')).toEqual({
      branch: 'master', upstream: 'origin/master', ahead: 1, behind: 2,
    })
    expect(parseGitStatus('## master...origin/master\n')).toEqual({
      branch: 'master', upstream: 'origin/master', ahead: 0, behind: 0,
    })
    expect(parseGitStatus('## master\n')).toEqual({ branch: 'master', upstream: null, ahead: 0, behind: 0 })
    expect(parseGitStatus('## HEAD (no branch)\n')).toEqual({ branch: null, upstream: null, ahead: 0, behind: 0 })
  })

  it('serves a git snapshot through the git endpoint', async () => {
    const calls: string[][] = []
    const runGit: RunGit = async (_root, args) => {
      calls.push([...args])
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { code: 0, stdout: 'true\n', stderr: '' }
      if (args[0] === 'for-each-ref') return { code: 0, stdout: 'main\nfeature/x\n', stderr: '' }
      if (args[0] === 'status') return { code: 0, stdout: '## main...origin/main [ahead 1]\n', stderr: '' }
      if (args[0] === 'rev-parse' && args[1] === '--short') return { code: 0, stdout: 'abc1234\n', stderr: '' }
      return { code: 0, stdout: 'def5678\u001fLocal commit\u001f2026-08-19\nabc1234\u001fCloud commit\u001f2026-08-20\n', stderr: '' }
    }
    const result = await createFileExplorerHandler({ runGit })('git', { root }, new AbortController().signal)
    expect(result).toEqual({
      ok: true,
      value: {
        ok: true,
        branch: 'main',
        upstream: 'origin/main',
        ahead: 1,
        behind: 0,
        branches: ['main', 'feature/x'],
        headHash: 'def5678',
        remoteHead: 'abc1234',
        commits: [
          { hash: 'def5678', subject: 'Local commit', date: '2026-08-19' },
          { hash: 'abc1234', subject: 'Cloud commit', date: '2026-08-20' },
        ],
      },
    })
    expect(calls).toEqual([
      ['rev-parse', '--is-inside-work-tree'],
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads'],
      ['status', '-sb'],
      ['rev-parse', '--short', 'HEAD@{upstream}'],
      ['log', '--pretty=format:%h%x1f%s%x1f%ad', '--date=short', '-n', '20', 'HEAD'],
    ])
  })

  it('views a requested branch tree and rejects unknown refs', async () => {
    const logs: string[][] = []
    const runGit: RunGit = async (_root, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return { code: 0, stdout: 'true\n', stderr: '' }
      if (args[0] === 'for-each-ref') return { code: 0, stdout: 'main\nfeature/x\n', stderr: '' }
      if (args[0] === 'status') return { code: 0, stdout: '## main\n', stderr: '' }
      if (args[0] === 'rev-parse' && args[1] === '--short') return { code: 1, stdout: '', stderr: 'no upstream' }
      if (args[0] === 'log') {
        logs.push([...args])
        return { code: 0, stdout: '1111111\u001ffeature commit\u001f2026-08-18\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
    const handler = createFileExplorerHandler({ runGit })
    const viewed = await handler('git', { root, ref: 'feature/x' }, new AbortController().signal)
    expect(viewed).toMatchObject({
      ok: true,
      value: {
        branch: 'main',
        headHash: '1111111',
        remoteHead: null,
        commits: [{ hash: '1111111', subject: 'feature commit' }],
      },
    })
    // A ref that is not a local branch falls back to HEAD.
    const bogus = await handler('git', { root, ref: 'HEAD~3' }, new AbortController().signal)
    expect(bogus).toMatchObject({ ok: true, value: { headHash: '1111111' } })
    expect(logs.every(args => args.at(-1) === 'feature/x')).toBe(false)
  })

  it('classifies a non-repository root', async () => {
    const runGit: RunGit = async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' })
    const result = await createFileExplorerHandler({ runGit })('git', { root }, new AbortController().signal)
    expect(result).toMatchObject({ ok: true, value: { ok: false, reason: 'not-repo' } })
  })

  it('classifies a missing git binary', async () => {
    const runGit: RunGit = async () => ({ code: null, stdout: '', stderr: 'spawn git ENOENT' })
    const result = await createFileExplorerHandler({ runGit })('git', { root }, new AbortController().signal)
    expect(result).toMatchObject({ ok: true, value: { ok: false, reason: 'no-git' } })
  })

  it('serves a file history through the file-history endpoint', async () => {
    const calls: string[][] = []
    const runGit: RunGit = async (_root, args) => {
      calls.push([...args])
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'true\n', stderr: '' }
      return { code: 0, stdout: 'aaa1111\u001fadded feature\u001f2026-08-20\nbbb2222\u001finitial file\u001f2026-08-19\n', stderr: '' }
    }
    const target = join(root, 'src', 'a.txt')
    const result = await createFileExplorerHandler({ runGit })('file-history', { root, path: target }, new AbortController().signal)
    expect(result).toEqual({
      ok: true,
      value: {
        ok: true,
        commits: [
          { hash: 'aaa1111', subject: 'added feature', date: '2026-08-20' },
          { hash: 'bbb2222', subject: 'initial file', date: '2026-08-19' },
        ],
      },
    })
    // The path arrives as a root-relative forward-slash pathspec.
    expect(calls.at(-1)).toEqual(['log', '--pretty=format:%h%x1f%s%x1f%ad', '--date=short', '-n', '20', 'HEAD', '--', 'src/a.txt'])
  })

  it('rejects a file-history path outside the locked root', async () => {
    const runGit: RunGit = async () => { throw new Error('must not run') }
    const result = await createFileExplorerHandler({ runGit })('file-history', { root, path: join(root, '..', 'x.txt') }, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'directory-unreadable' } })
  })

  it.skipIf(!hasGit)('reads a real file history with multiple commits', async () => {
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0)
    await writeFile(join(root, 'a.txt'), 'v1')
    expect(spawnSync('git', ['add', '.'], { cwd: root }).status).toBe(0)
    expect(spawnSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'first version'],
      { cwd: root },
    ).status).toBe(0)
    await writeFile(join(root, 'a.txt'), 'v2')
    expect(spawnSync('git', ['add', '.'], { cwd: root }).status).toBe(0)
    expect(spawnSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'second version'],
      { cwd: root },
    ).status).toBe(0)
    const result = await createFileExplorerHandler()('file-history', { root, path: join(root, 'a.txt') }, new AbortController().signal)
    const value = (result as { ok: true; value: { ok: boolean; commits: { subject: string }[] } }).value
    expect(value.ok).toBe(true)
    expect(value.commits.map(commit => commit.subject)).toEqual(['second version', 'first version'])
  })

  it('serves an open request through the open endpoint', async () => {
    const calls: string[] = []
    const runOpen = async (path: string): Promise<{ code: number | null; stderr: string }> => {
      calls.push(path)
      return { code: 0, stderr: '' }
    }
    const target = join(root, 'sub')
    const result = await createFileExplorerHandler({ runOpen })('open', { path: target }, new AbortController().signal)
    expect(result).toEqual({ ok: true, value: { opened: true } })
    expect(calls).toEqual([target])
  })

  it('rejects an open path that is not fully qualified and surfaces opener failures', async () => {
    const handler = createFileExplorerHandler({
      runOpen: async () => ({ code: 1, stderr: 'explorer failed' }),
    })
    const relative = await handler('open', { path: 'relative/path' }, new AbortController().signal)
    expect(relative).toMatchObject({ ok: false, error: { code: 'directory-unreadable' } })
    const failed = await handler('open', { path: join(root, 'x') }, new AbortController().signal)
    expect(failed).toMatchObject({ ok: false, error: { code: 'directory-unreadable', message: expect.stringContaining('explorer failed') } })
  })

  it('rejects a git root that is not fully qualified', async () => {
    const runGit: RunGit = async () => { throw new Error('must not run') }
    const result = await createFileExplorerHandler({ runGit })('git', { root: 'relative/path' }, new AbortController().signal)
    expect(result).toMatchObject({ ok: false, error: { code: 'directory-unreadable' } })
  })

  it.skipIf(!hasGit)('reads a real repository snapshot with a remote-ahead boundary', async () => {
    // Remote: a bare sibling repository.
    const remote = join(root, 'remote.git')
    expect(spawnSync('git', ['init', '-q', '--bare', remote]).status).toBe(0)
    // Working repo with one pushed commit.
    expect(spawnSync('git', ['init', '-q'], { cwd: root }).status).toBe(0)
    await writeFile(join(root, 'a.txt'), 'x')
    expect(spawnSync('git', ['add', '.'], { cwd: root }).status).toBe(0)
    expect(spawnSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'pushed commit'],
      { cwd: root },
    ).status).toBe(0)
    expect(spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: root }).status).toBe(0)
    expect(spawnSync('git', ['push', '-q', '-u', 'origin', 'HEAD'], { cwd: root }).status).toBe(0)
    // One local commit on top: ahead by one, boundary marks the older commit remote.
    await writeFile(join(root, 'b.txt'), 'y')
    expect(spawnSync('git', ['add', '.'], { cwd: root }).status).toBe(0)
    expect(spawnSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'local commit'],
      { cwd: root },
    ).status).toBe(0)
    const result = await createFileExplorerHandler()('git', { root }, new AbortController().signal)
    expect(result).toMatchObject({
      ok: true,
      value: {
        ok: true,
        branch: expect.stringMatching(/^(main|master)$/),
        upstream: expect.stringMatching(/^origin\/(main|master)$/),
        ahead: 1,
        behind: 0,
        branches: expect.arrayContaining([expect.stringMatching(/^(main|master)$/)]),
        headHash: expect.stringMatching(/^[0-9a-f]{7,}$/),
        remoteHead: expect.stringMatching(/^[0-9a-f]{7,}$/),
        commits: [
          { subject: 'local commit' },
          { subject: 'pushed commit' },
        ],
      },
    })
    // A second branch appears in the dropdown and its tree is viewable.
    expect(spawnSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: root }).status).toBe(0)
    await writeFile(join(root, 'c.txt'), 'z')
    expect(spawnSync('git', ['add', '.'], { cwd: root }).status).toBe(0)
    expect(spawnSync(
      'git',
      ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'feature commit'],
      { cwd: root },
    ).status).toBe(0)
    const feature = await createFileExplorerHandler()('git', { root }, new AbortController().signal)
    const featureValue = (feature as { ok: true; value: { branch: string; branches: string[]; commits: { subject: string }[] } }).value
    expect(featureValue.branch).toBe('feature')
    expect(featureValue.branches).toContain('feature')
    expect(featureValue.branches.some(name => name === 'main' || name === 'master')).toBe(true)
    expect(featureValue.commits[0]?.subject).toBe('feature commit')
    // Viewing the other branch's tree shows its own tip.
    const mainName = featureValue.branches.find(name => name !== 'feature')!
    const mainView = await createFileExplorerHandler()('git', { root, ref: mainName }, new AbortController().signal)
    const mainValue = (mainView as { ok: true; value: { commits: { subject: string }[] } }).value
    expect(mainValue.commits[0]?.subject).toBe('local commit')
  })
})
