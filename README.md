# ui-cw-fileexplorer（右侧文件工作台 dock 插件）

右侧停靠的只读文件工作台，为 dsh web 会话区补充：文件浏览、Git 分支视图、
选中文件的历史变更记录。全部跟随当前会话的工作区，**零官方源码改动**。

---

## 一、实现介绍

### 功能总览

1. **文件区（主面板）**：单级列表 + 面包屑导航；工作区锁定（VS Code 式，host 侧
   强制校验）；Windows 真实隐藏属性过滤（`attrib`）；Git 工作区三态
   （`M` 黄 / `D` 红删除线 / `A` 绿，删除条目由 git 回填）；导航行右侧本地打开按钮
   （`host.openPath`）
2. **Git 分支视图抽屉**：当前分支徽标 + ahead/behind 计数；下拉切换查看任意本地
   分支的提交树（只读）；提交行本地/云端位置标签（蓝 / 橙图标）；外部改动提示；
   点击提交行展开完整提交描述
3. **历史变更记录抽屉**：点击文件区文件行（蓝色高亮）→ 该文件的提交历史
   （`git log -- <path>`），最新变更带蓝色标记；提交行同样可点击展开描述
4. **布局**：宽度可拖（180–640px）；两个辅助抽屉各自独立收起 + 独立高度把手；
   整体收起为全高条 + 垂直居中展开箭头

### 架构与数据流

```
浏览器 (dsh web)                              Host (Node)
┌──────────────────────────┐                 ┌──────────────────────────┐
│ shell.overlay 槽（官方）   │   POST /fileexplorer/*  │ ctx.connection.rpc.handle  │
│ FileExplorerDock         │ ──────────────────▶ │  list         只读目录+状态      │
│  ├ 文件区（主面板）        │ ◀────────────────── │  git          分支/提交/位置     │
│  ├ Git 分支视图抽屉        │    RpcResult        │  file-history 文件提交历史      │
│  └ 历史变更记录抽屉        │                   │  host.openPath（官方 /api）     │
└──────────────────────────┘                 └──────────────────────────┘
```

- **零官方改动**：挂载用官方 `shell.overlay` 槽；让位用 `#root { margin-right }`
  CSS 推挤（better-sidebar 验证过的技巧）；数据走插件自有 `/fileexplorer` RPC
  通道（`ctx.connection.rpc.handle` / `rpc.call`）；打开本地路径复用官方
  `host.openPath`
- **只读原则**：全部端点只读，无任何写操作；git 均为只读命令（rev-parse /
  status / log / for-each-ref）
- **数据跟随**：`useSessions` 全局 hook → 当前会话 cwd = 锁定工作区根；
  2s 轮询 + 指纹比对刷新

### 目录结构

```
src/
├── index.ts          # node 半：注册 /fileexplorer 通道（apply）
├── contract.ts       # 双面共享的 RPC 契约（纯类型）
├── handler.ts        # 通道实现：list / git / file-history + 解析纯函数
└── client/           # 浏览器半
    ├── index.ts      # apply：slots.inject('shell.overlay') 注册
    ├── service.ts    # RPC 客户端封装（list/git/fileHistory/openInSystem）
    ├── FileExplorerView.tsx   # dock 骨架 + 文件区（+ Breadcrumbs/FileRow）
    ├── GitDrawer.tsx          # Git 分支视图抽屉
    ├── FileHistoryView.tsx    # 历史变更记录抽屉
    ├── locales.ts             # 文案（zh 默认 / en）
    └── *.module.css           # 各组件样式
tests/host.spec.ts    # 通道/解析/真实仓库集成测试
cordis.patch.yml      # bundle 层：插入双面行
tsdown.config.ts      # node 半 + 浏览器半（CSS Modules 内容哈希）
```

### 加载与开发

```sh
pnpm install && pnpm build        # 产物：lib/index.js + lib/client.js
dsh plugin --profile web add .    # 装入 profile（bundle 机制）
pnpm typecheck                    # tsc --noEmit
pnpm test                         # vitest（30 个：解析/端点/真仓库集成）
pnpm build:watch                  # client 面 watch → HMR 热更
```

类型依赖通过 tsconfig paths 指向 dsh 源码的 `lib/types`（开发期，见 tsconfig.json）。

### 已知限制

- 只读边界：不提供提交/检出/暂存（详情交给真实 git 工具）
- `attrib` 不可用时隐藏判定降级为 POSIX 点前缀
- `.git` 目录在 Windows 无隐藏属性时会显示（无徽标）
- 删除回填条目无大小信息
- 轮询刷新（2s），非事件推送
- 布局状态（宽度/比例/展开）刷新后重置
- 打开目录：未打开时经 `Shell.Application.Explore` 新建并激活窗口；已打开时
  （Explore 只会激活旧窗口，后台服务激活被前台锁拒绝）改走
  `explorer.exe /n,/e` 强制新建窗口；均先模拟 Alt 输入获得前台资格。
  个别受限会话（窗口站隔离、更高权限进程抢占）下仍可能退化为后台打开，
  窗口任务栏可见
- 打开按钮连点保护：同一目录 1.2s 内重复点击只开一个窗口（首次点击立即
  执行，后续静默合并），失败后冷却立即释放，可马上重试

---

## 二、提交信息规范

本仓库所有提交遵循以下格式。

### 格式

```
<type>: <中文摘要>

1. <要点一>
2. <要点二>
3. <要点三>
```

- **标题**：`type: ` + 中文摘要，一行，动词开头、简洁（≤ 50 字）
- **正文**：空一行后接**有序列表**，3～5 行，总结关键要点，**不赘述**；
  没有值得列出的要点时可省略正文

### type 枚举

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修复缺陷 |
| `refactor` | 重构（不改变行为） |
| `docs` | 文档 |
| `test` | 测试 |
| `chore` | 构建/依赖/杂项 |

### 示例

```text
feat: 右侧文件工作台 dock 插件

1. 文件区：面包屑导航、工作区锁定、隐藏属性过滤、Git 三态（M/D/A）、本地打开
2. Git 分支视图：分支切换、本地/云端位置标签、外部变更提示
3. 历史变更记录：选中文件的提交历史
4. 零官方改动：shell.overlay 槽 + CSS 推挤 + 自有 RPC 通道
5. 28 个测试全绿
```

```text
fix: 收起态展开按钮垂直居中失效

1. 根因：CSS 文件中残留旧 .rail 规则，同特异性后定义者覆盖新规则
2. 清理残留规则，类名改用内容哈希防止 HMR 新旧样式冲突
```

---

## 三、代码命名规范

### 文件与目录

| 类别 | 规则 | 示例 |
|---|---|---|
| node 半 / 浏览器半入口 | `index.ts` | `src/index.ts`、`src/client/index.ts` |
| 共享契约 / 服务 / 文案 | 小写语义名 | `contract.ts`、`handler.ts`、`service.ts`、`locales.ts` |
| React 组件文件 | PascalCase | `FileExplorerView.tsx`、`GitDrawer.tsx` |
| 组件样式 | 同名 `.module.css` | `GitDrawer.module.css` |
| 测试 | `<面>.spec.ts` | `host.spec.ts` |
| CSS Modules 类型声明 | 固定名 | `css-modules.d.ts` |

### TypeScript 标识符

- **接口/类型**：PascalCase，`FileExplorerEntry`、`GitSnapshot`、`RunGitResult`
- **函数**：camelCase 动词开头，`createFileExplorerHandler`、`parseGitLog`、
  `readFileHistory`
- **常量**：UPPER_SNAKE，`POLL_MS`、`DEFAULT_WIDTH`、`MAX_GIT_RATIO`；
  组件内常量同样 UPPER_SNAKE
- **ref / state**：camelCase + 语义后缀，`panelRef`、`gitRef`、`listing`、`gitRatio`
- **回调/注入面**：`FileExplorerInjected` 等 `*Injected` 后缀；
  客户端面 `*Client` 后缀（`FileExplorerClient`）
- **布尔状态**：`*Expanded`、`selected`、`expanded` 等 `-ed` 形态
- **禁止**：`any`、未使用的 import/变量（typecheck 全绿为提交门槛）

### React 组件与样式

- 组件与文件同名（PascalCase）；辅助纯组件同文件内定义（`Breadcrumbs`、
  `FileRow`）
- 组件**不接触 ctx**：数据经四份 props（runtime / render-slots / store / inject）
  注入；apply 内回调经 `inject` 工厂传递
- CSS Modules 类名：camelCase，语义化（`titleRow`、`branchBadge`、`railButton`、
  `dividerH`）
- 状态色只允许官方 `--dsw-alias-*` / `--dsw-specific-*` token，禁字面量颜色
- 内联样式仅限几何/动态值（宽度、flex 比例），静态样式一律进 `.module.css`

### 契约 / RPC / 国际化

- **RPC 端点**：kebab-case，`file-history`（通道前缀 `/fileexplorer`）
- **请求/响应类型**：`FileExplorer*Request` / `*Snapshot` / `*Listing` 命名
- **字段**：camelCase；布尔 `git`、`hidden`；可选字段用 `?` 且客户端必须兜底
- **git 三态**：单字母 `'M' | 'D' | 'A'`
- **错误**：复用官方封闭错误码（`directory-unreadable` / `cancelled` /
  `bad-request`），不自定义
- **locale 键**：小写点分（`view.files`、`git.title`、`history.empty.file`）；
  产品文案中文为默认、en 镜像（`locales.ts` 内 `zh` 为键源）
- **代码注释**：英文；仅产品文案/界面文字用中文

---

## Model Experience

None — 面板是浏览器 chrome，不触及任何模型请求。

#### KV Cache effect

None；本包不组装也不发送任何 provider 请求。
