# @dsh-plugins/ui-cw-fileexplorer

右侧停靠的只读文件工作台（DeepSeek Harness Web 插件）：文件浏览 + Git 分支视图
+ 选中文件的历史变更记录，全部跟随当前会话的工作区。零官方源码改动。

## 功能

- **右侧 dock 面板**（挂载于官方 `shell.overlay` 槽）：`#root { margin-right }`
  推挤让位，宽度可拖（180–640px），整体可收起为全高条 + 垂直居中的展开箭头
- **文件区（主面板）**：
  - 单级列表 + 面包屑导航（Windows 风格路径、长链省略、悬浮显示完整路径）
  - 工作区锁定（VS Code 式）：根 = 会话工作区，host 侧强制校验，不可越级
  - 隐藏条目过滤：Windows 读真实 `FILE_ATTRIBUTE_HIDDEN`（attrib），POSIX 点前缀
  - **Git 工作区三态**：`M`（黄）/ `D`（红 + 删除线，磁盘缺失条目由 git 回填）/ `A`（绿）
  - 导航行右侧：在本地打开当前文件夹（`host.openPath`）
- **Git 分支视图抽屉**（独立收起 + 独立高度拖拽）：
  - 当前分支徽标 + ahead/behind 计数，下拉切换查看任意本地分支的提交树（只读）
  - 提交行位置标签：蓝色图标 = 本地 HEAD，橙色图标 = 云端（上游）位置
  - 外部改动检测：其他工具切分支/新提交时 2s 内提示
- **历史变更记录抽屉**：点击文件区任一文件行（蓝色高亮）→ 该文件的提交历史
  （`git log -- <path>`），最新变更带蓝色标记

## 架构

```
浏览器 (dsh web)                              Host (Node)
┌──────────────────────────┐                 ┌──────────────────────────┐
│ shell.overlay 槽         │   POST /fileexplorer/*  │ ctx.connection.rpc.handle  │
│ FileExplorerDock         │ ──────────────────▶ │  list        (readdir+attrib+git)│
│  ├ 文件区（主面板）        │ ◀────────────────── │  git         (status/log/ref)   │
│  ├ Git 分支视图抽屉        │   RpcResult         │  file-history (log -- path)     │
│  └ 历史变更记录抽屉        │                   │  host.openPath（官方 /api）       │
└──────────────────────────┘                 └──────────────────────────┘
```

- **零官方改动**：挂载用官方 `shell.overlay` 槽，让位用 CSS 推挤，数据走插件自有
  `/fileexplorer` RPC 通道（`ctx.connection.rpc.handle`），路径打开复用官方 `host.openPath`
- **依赖**：仅 `@deepseek-ai/cordis`（peer）+ 官方基线（React / ui-primitives / ui-slots /
  runtime 类型），类型通过 tsconfig paths 指向 dsh 源码的 `lib/types`（开发期）
- **只读原则**：全部端点只读（list/git/file-history/openPath），无任何写操作

## 加载（外部插件 bundle）

```sh
# 构建
pnpm install && pnpm build        # lib/index.js（node 半）+ lib/client.js（浏览器半）

# 安装到 profile 并启动（dsh 安装目录的 CLI）
dsh plugin --profile web add .
dsh --profile web
```

`cordis.patch.yml` 插入一行双面行（`dsh.client` 清单使 modules node 半把
`lib/client.js` 注入浏览器 roster 并从 `/plugins` 服务）。浏览器侧改动由
`build:watch` 触发 HMR 热更；node 半改动需重启 profile。

## 开发

```sh
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest：通道/解析/集成测试（28 个，含真实 git 仓库场景）
pnpm build       # tsdown：node + client 双面产物
pnpm build:watch # client 面 watch（HMR）
```

测试覆盖：路径限定与工作区锁定、Windows 隐藏属性（attrib 解析 + 注入）、
porcelain 三态解析、git 快照（分支/上游/位置标签/ref 查看）、文件历史、错误分类。

## Model Experience

None — 面板是浏览器 chrome，不触及任何模型请求。

#### KV Cache effect

None；本包不组装也不发送任何 provider 请求。

## Known Limitations and Deferred Work

- **只读边界**：不提供提交/检出/暂存等写操作（有意为之，详情交给真实 git 工具）
- **Windows 隐藏属性**：真实 `FILE_ATTRIBUTE_HIDDEN` 通过 `attrib` 批量读取，
  `attrib` 不可用时降级为 POSIX 点前缀惯例
- **`.git` 目录**：Windows 上若无隐藏属性会显示在列表中（无 git 徽标）
- **删除回填**：`D` 状态条目由 git status 补入列表，无大小信息
- **轮询刷新**：2s 轮询（文件/分支/历史），非事件推送
- **布局状态瞬态**：宽度/抽屉比例/展开状态刷新后重置（与官方面板几何一致）
