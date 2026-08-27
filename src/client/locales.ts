/**
 * fileexplorer locale namespace. Product copy is Chinese (default), English
 * mirrors it; the namespace merge types the register's `t` seat.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

export const NS = 'fileexplorer'

export const zh = {
  'view.files': '文件',
  'empty.no-workspace': '选择会话后在此查看文件',
  'error.load': '无法读取该目录',
  'collapse.label': '收起面板',
  'expand.label': '展开面板',
  'divider.label': '调整文件区宽度',
  'open.folder': '在本地打开当前文件夹',
  'git.divider.label': '调整 Git 面板高度',
  'history.divider.label': '调整历史面板高度',
  'git.title': 'Git 分支视图',
  'git.collapse': '收起 Git 面板',
  'git.expand': '展开 Git 面板',
  'history.title': '历史变更记录',
  'history.empty.file': '在文件区选择文件查看历史',
  'history.empty.commits': '该文件暂无变更记录',
  'history.collapse': '收起历史面板',
  'history.expand': '展开历史面板',
  'git.loading': '加载中…',
  'git.empty.workspace': '选择会话后在此查看',
  'git.empty.no-git': '未检测到 Git',
  'git.empty.not-repo': '非 Git 仓库',
  'git.empty.no-commits': '暂无提交',
  'git.no-upstream': '无远程分支',
  'git.branch.no-upstream': '未跟踪远程分支',
  'git.tag.head': 'HEAD',
  'git.tag.remote': '云端',
  'git.current': '当前',
  'git.select-branch': '选择分支',
  'git.notice.branch': '分支已切换为 {name}',
  'git.notice.head': '分支有新提交',
} as const

export const en = {
  'view.files': 'Files',
  'empty.no-workspace': 'Select a conversation to browse its files here',
  'error.load': 'Unable to read this directory',
  'collapse.label': 'Collapse panel',
  'expand.label': 'Expand panel',
  'divider.label': 'Resize file dock',
  'open.folder': 'Open current folder in system',
  'git.divider.label': 'Resize git panel',
  'history.divider.label': 'Resize history panel',
  'git.title': 'Git Branches',
  'git.collapse': 'Collapse Git panel',
  'git.expand': 'Expand Git panel',
  'history.title': 'File History',
  'history.empty.file': 'Select a file in the file region to view its history',
  'history.empty.commits': 'No commits touch this file yet',
  'history.collapse': 'Collapse history panel',
  'history.expand': 'Expand history panel',
  'git.loading': 'Loading…',
  'git.empty.workspace': 'Select a conversation to view its git state',
  'git.empty.no-git': 'Git not detected',
  'git.empty.not-repo': 'Not a Git repository',
  'git.empty.no-commits': 'No commits yet',
  'git.no-upstream': 'No remote branch',
  'git.branch.no-upstream': 'No upstream tracking branch',
  'git.tag.head': 'HEAD',
  'git.tag.remote': 'Cloud',
  'git.current': 'current',
  'git.select-branch': 'Select branch',
  'git.notice.branch': 'Branch switched to {name}',
  'git.notice.head': 'New commits on the branch',
} as const

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    [NS]: keyof typeof zh
  }
}
