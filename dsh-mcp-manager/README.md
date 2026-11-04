# dsh-mcp-manager

在 Harness 里管理 MCP（Model Context Protocol）服务器：**Host 半侧**监督 stdio / Streamable-HTTP 连接并把它们的工具注册到 `ctx.tools`，**Browser 半侧**在设置页里做增删改查、启停和状态查看。服务器定义写入 profile 的用户 patch 层，由 profile 的 live patch 热生效。

本包按 Harness 的 **bundle** 格式分发：`package.json` 的 `dsh.bundle` 指向自带的 `cordis.patch.yml`，该层插入唯一的一行 `mcp-manager`。

## 目录结构

```
dsh-mcp-manager/
├── package.json           # dsh.bundle（组合包层）+ dsh.client（浏览器半侧）+ exports
├── cordis.patch.yml       # bundle 自带的组合层：插入 mcp-manager 行
├── lib/
│   ├── index.js           # Host 入口：McpManager（Service）、配置 schema、行挂载模式判定
│   ├── supervisor.js      # 每个服务器一条受监督连接：世代、退避重连、工具注册/注销、状态
│   ├── channel.js         # 浏览器 RPC 通道（复用 Connection 的 unary envelope + 信任栅栏）
│   ├── patch-file.js      # cordis.patch.yml 受管区块的读写（insert / override 两种形态）
│   ├── naming.js          # mcp__<server>__<tool> 命名契约与内容投影
│   └── client.js          # 浏览器半侧：settings.section 页面（lazy-CJS factory 产物）
└── test/
    ├── mcp-echo-server.mjs  # 本地 MCP 服务器 fixture（stdio 与 --http 两种传输）
    ├── check-host.mjs       # 离线：配置、重连策略、输出 schema、命名、投影、patch 区块
    ├── check-channel.mjs    # 离线：RPC envelope、错误分支、体积上限
    ├── check-client.mjs     # 离线：bundle 注册、文案完整性、组件可渲染、展示层断言
    ├── preview-panel.mjs    # 离线：把面板渲染成静态 HTML，便于截图检查排版
    └── verify-live.mjs      # 活体：对运行中的宿主验证重连、预算耗尽、持久化模式
```

## 安装与卸载

作为组合包安装（推荐，`dsh plugin` 转发给 profile 内的 pnpm）：

```sh
dsh plugin --profile web add ./dsh-mcp-manager            # 本地目录：pnpm 链接该 checkout
dsh plugin --profile web add ./dsh-mcp-manager-0.2.0.tgz  # 或交付 tarball
dsh plugin --profile web remove dsh-mcp-manager           # 连带移除依赖与组合层
```

安装后 profile 的 `package.json` 会多出 `dsh-mcp-manager` 依赖与一个 `dsh.profile.bundles` 条目，profile 的 `cordis.patch.yml` **保持你自己的内容**——不要手工往里写 `mcp-manager` 行，那会和 bundle 层重复挂载。

- 用 `dsh --profile web --dump-config` 可以看到 `# == dsh-mcp-manager` 这一层，不启动也能确认组合正确。
- 以 `link:` 安装的 checkout 保留自己的 `node_modules`：`pnpm install` 一次的产物（`dependencies` 是 MCP SDK 与 zod，`devDependencies` 是 cordis/schemastery，用于本地跑测试）。改代码后**重启 profile** 即生效，不再需要手工拷贝。
- 本包的 `peerDependencies` 只有 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`。Cordis 的服务协议走 `Symbol.for`，链接安装时宿主与本包的副本可以共存。

### 设置页写回什么

设置页的每次变更由插件自己写进 profile 的 `cordis.patch.yml`，并只维护一个受管区块。区块有**两种形态**，插件按运行时判定后自动选择：

| 形态 | 何时使用 | 区块形状 |
| --- | --- | --- |
| `override` | 行由已安装的 bundle 层插入（`dsh plugin add` 安装） | `- id: mcp-manager` + `config:`，按 id 覆盖既有行 |
| `insert` | 行由本区块自己插入（把包拆散拷进 profile 的旧式安装） | `- insert:` + 完整行定义 |

判定依据是运行时里该行的模块定位：解析到本模块就是 `insert`，解析到别的层（例如裸包名）就是 `override`。快照里的 `patchMode` 会返回该结果，设置页把它作为页脚「配置文件」那一行的悬停提示。

## 服务器定义

```yaml
config:
  servers:
    - {"name":"github","enabled":true,"transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_TOKEN":"env.GITHUB_TOKEN"},"reconnect":{"enabled":true,"maxAttempts":10}}
    - {"name":"web","enabled":false,"transport":"streamable-http","url":"http://127.0.0.1:3000/mcp","headers":{"Authorization":"Bearer …"}}
```

| 字段 | 适用 | 默认 | 说明 |
| --- | --- | --- | --- |
| `name` | 两种 | 必填 | 工具命名空间，`[A-Za-z0-9_-]{1,32}`，全局唯一 |
| `enabled` | 两种 | `true` | `false` 时保留定义但不连接 |
| `transport` | 两种 | 必填 | `stdio` 或 `streamable-http` |
| `command` / `args` / `cwd` | stdio | — | 可执行文件、参数、工作目录 |
| `env` | stdio | `{}` | 覆盖式附加环境变量，见下 |
| `url` / `headers` | streamable-http | — | MCP 端点与附加请求头 |
| `toolCallTimeoutMs` | 两种 | `60000` | 单次 `tools/call` 超时 |
| `reconnect.enabled` | 两种 | `true` | 连接丢失后自动重连 |
| `reconnect.initialDelayMs` / `maxDelayMs` | 两种 | `500` / `30000` | 指数退避的起止延迟（毫秒） |
| `reconnect.maxAttempts` | 两种 | `10` | 一次断线内允许的连续失败次数 |

`env` 的值写成 `env.NAME` 或 `${NAME}` 时，在连接那一刻从进程环境读取（含 `$DSH_HOME/.env`），因此凭据不必落在 patch 文件里。stdio 子进程继承的宿主环境会先剔除名字形如 `/KEY|PASSWORD|SECRET|TOKEN/i` 以及全部 `DSH_*` 的变量，再由 `env` 覆盖。

## 运行机制

**连接监督**（`lib/supervisor.js`）

1. 每个服务器由一条**受监督连接**表示，一次连接是一个世代（generation）：一个 `Client` 绑定一个 transport，生命周期内不换。世代关闭（`onclose`）或连接失败后，进入**有界指数退避重连**，延迟 `initialDelayMs × 2^(n-1)`、上限 `maxDelayMs`，一次断线内共享 `maxAttempts` 预算。
2. **停机期间工具仍然列出。** 断线只让调用失败（错误里带当前状态与重试次数），模型不会突然失去工具；重连成功后自动重新拉取工具列表。连接稳定超过 `maxDelayMs` 会关闭本次断线、重置预算，因此「频繁短暂成功」的崩溃循环仍会耗尽预算而不是无限重试。
3. **预算耗尽**后注销该服务器的工具并停止重连，状态变为 `error`，错误提示指向重载插件或重启 Host；设置页的「刷新」会重新发起连接，不必改配置。
4. **`notifications/tools/list_changed`** 会自动触发重新同步；初始同步、通知同步与手动刷新共用一条串行链，避免两次「注销旧世代 / 注册新世代」交错。取列表失败保留上一代工具；注册冲突（别的插件占了 `mcp__<名称>__` 命名空间）只让本服务器贡献零个工具并记录日志，不影响同一行里其他服务器。

**工具定义与结果保真**（`lib/naming.js` + `lib/supervisor.js`）

- 公开名 `mcp__<serverName>__<rawName>`，与 `@deepseek-ai/dsh-mcp-client` 完全一致（超长或含非法字符时补 12 位 SHA-256 后缀）；线上始终用原始 MCP 名调用。
- 服务器声明的 `outputSchema` 在受支持时被采纳为结果的 `structuredContent`；不受支持的写法（`$ref`、未知关键字等）退回宽松默认，而不是把非法 schema 交给宿主。
- `execution.taskSupport === "required"` 的工具会被明确拒绝，而不是发出宿主无法完成的请求。
- 内容投影：文本按块合并；`resource_link` 保留名字与 URI；`audio` / 内嵌 `resource` / 未知类型变成有界占位符。**图片**在活动模型路由声明了图片输入时落盘为附件（`ctx.attachments.saveImages`）并作为图像块进入上下文；不满足条件时降级为带原因的说明文本，原始数据仍对程序化调用方可用。

**Host 半侧**（`lib/index.js`）

1. 为每个启用的定义建立 `McpServerSupervisor`；提供 `mcpManager` 服务（Cordis Service，随 fiber 自动注销）：`list()`、`tools()`、`add()`、`update()`、`remove()`、`setEnabled()`、`refresh()`、`probe()`、`dispatch()`。
2. 在 `ctx.inject(['connection','webServer'], …)` 里注册 `/mcp-manager` 前缀路由：先跑 Connection 的 Host/Origin + 浏览器 cookie 校验（未认证返回 401/403），再解析 Connection 的 unary envelope 并转发给 `dispatch()`。
3. 每次变更先写 patch 区块（写入前回读校验模式与服务器列表，写坏就拒绝落盘），再把变更应用到当前 generation 的 supervisor —— 因此在 live 重载到达之前，启停和工具注册/注销就已经生效。

**Browser 半侧**（`lib/client.js`）

- 一个 lazy-CJS factory 产物，通过 `window.__ModuleLoader__.load({ id: 'dsh-mcp-manager', factory })` 注册，只 `require('react')`（平台基线模块），因此不需要构建步骤。
- 在 `settings.section` 注册 id 为 `mcp-servers` 的设置页（order 25）。**展示要点**：
  - 顶部汇总：服务器 / 已启用 / 已连接 / 工具数，有服务器正在重连时额外显示「重连 n」。
  - 每张卡片头部：名称、传输方式、状态徽标；重连中额外显示「2/5 · 1.8 秒后重试」，并按秒倒计时（只在有服务器重连时启用 1 秒 tick，其余时间跟随 8 秒状态轮询）。操作按钮成组靠右，窄面板下整组换行而不是从中间断开。
  - **默认折叠，按需展开**：卡片只显示身份行、单行目标（超长省略）、错误（若有）和一行入口「详情 / 工具列表 (n)」，把每张卡片的阅读量压到 3 行左右。两个入口互相独立，展开状态由设置页记住，状态轮询不会把它们收起来。
  - 「详情」展开**信息栅格**：目标完整值（stdio 命令行或 URL）、单次调用超时、重连策略（关闭 / `最多 10 次 · 500ms → 30s`），已连接时再加「已连接」「最近同步」的相对时间，重连中再加「下次重试」。
  - 错误以「最近错误」标签 + 原文显示，折叠态也始终可见（最多两行，完整文本在 `title` 里）。
  - 「工具列表 (n)」始终显示工具数（0 也可展开，得到「该服务器还没有公布工具」）；展开后可筛选（超过 6 个工具时出现搜索框），每行显示公开名、与公开名不同的原始 MCP 名、描述，并可一键复制公开名；列表最高 340px，超出滚动。
  - 操作反馈（已保存 / 已刷新 / 已启用…）以横幅显示，**4.5 秒后自动消失**；执行新操作或打开编辑表单会立即清掉它，卸载时也会取消挂起的定时器。失败提示不自动消失，但会在下一次状态轮询成功时清空。
  - 页脚只保留一行「配置文件: `<绝对路径>`」；该行由 bundle 提供还是由区块插入，改成这一行的 `title` 提示，不再占版面。
- 支持启用/停用、编辑、删除、刷新、展开工具列表、「测试连接」（`probe`，不注册任何工具）。
- **页面文案固定中文**：`lib/client.js` 顶部的 `PAGE_LOCALE = "zh"` 决定页面语言，与 GUI 语言无关；改成 `"auto"` 即恢复跟随 locale 服务。zh/en 两份字典仍会注册到 `mcp-manager` 命名空间。
- 每次变更后会轮询 `state` 直到 `generation` 变化，以此确认「已写入配置文件并热重载」。

**RPC 端点**（`POST /mcp-manager/<endpoint>`）

| endpoint | 载荷 | 返回 |
| --- | --- | --- |
| `state` | `{}` | `{ generation, rowId, patchMode, channel, patchFile, persistence, servers[], totals }` |
| `add` | `{ definition }` | 写入回执 + `snapshot` |
| `update` | `{ name, definition }` | 写入回执 + `snapshot`（改 `definition.name` 即重命名） |
| `remove` | `{ name }` | 写入回执 + `snapshot` |
| `setEnabled` / `start` / `stop` | `{ name, enabled? }` | 写入回执 + `snapshot` |
| `refresh` | `{ name? }` | 重新拉取工具列表后的 `snapshot`（服务器断开时同时恢复连接） |
| `tools` | `{ name? }` | `{ tools: [{ server, rawName, publicName, description }] }` |
| `probe` | `{ definition }` | `{ name, toolCount, tools }`，不持久化、不注册工具 |

业务失败以 `200` + `{ ok: false, error }` 返回（浏览器半侧折叠成错误提示）；只有传输层问题用非 200。

## 验证

离线（在 checkout 里 `pnpm install` 之后，无需 Harness）：

```sh
node test/check-host.mjs      # 配置、重连策略、输出 schema、命名、投影、patch 区块两种形态
node test/check-channel.mjs   # RPC envelope、401/404/413/415/400 分支
node test/check-client.mjs    # bundle 注册、70 条文案完整性、组件结构与展示层断言
node test/preview-panel.mjs panel-preview.html   # 渲染静态面板（可再用无头浏览器截图检查排版）
```

活体验证（需要一个运行中的宿主；`verify-live.mjs` 用启动时打印的 `--token` 换取 cookie）：

```sh
node test/verify-live.mjs http://127.0.0.1:3080 <token-from-launch-line>
```

它会依次验证：杀死 MCP 子进程后进入 `reconnecting` 且**工具仍列出**、按预算重连成功、不可达服务器在预算耗尽后进入 `error` 且不牵连邻居、写入落为 `override` 形态并能 round-trip 删除。

用随包 fixture 做冒烟（在设置页或直接写 `config.servers`）：

```jsonc
{ "name": "echo", "transport": "stdio", "command": "node",
  "args": ["<checkout>/test/mcp-echo-server.mjs"] }
// 或 Streamable-HTTP：node test/mcp-echo-server.mjs --http 8931
{ "name": "web", "transport": "streamable-http", "url": "http://127.0.0.1:8931/mcp" }
```

## 已知限制

- **只桥接工具。** MCP resources 与 prompts 没有消费方，不注册（内嵌资源在结果里降级为占位文本）。
- **整行热替换。** 每次持久化都会改变本行的 config，profile 的 live patch 因此重挂本行：所有服务器会重连一次、工具短暂注销后重新注册。会话历史与权限规则不受影响，因为公开工具名只由 `(serverName, rawName)` 决定。若只想让单个服务器重连，用「刷新」或启停该服务器。
- **图片依赖模型路由。** 只有活动模型声明图片输入、且附件存储接受该媒体类型时图片才进入上下文；否则降级为说明文本。
- **凭据可落在 patch 文件里。** 用 `env.NAME` / `${NAME}` 间接引用进程环境即可避免；注意 patch 文件本身没有权限保护。
- **启动期异步。** 服务器连接不阻塞 profile 启动，因此会话开始后一瞬间工具可能尚未出现；等待或点「刷新」即可。
- **中文的范围。** 页面文案、以及插件自己产生的校验/失败提示（服务器名、url、command、唯一性、patch 写入、重连状态等）都是中文；MCP SDK、Node 与远端服务器返回的诊断文本保持原文。

## 运维备注

- 以 `link:` 安装时宿主与 checkout 各有一份 `@deepseek-ai/cordis`；两者版本应保持一致（本仓库 `devDependencies` 固定为当前部署版本），避免跨版本的服务实现漂移。
- `lib/index.js` 是 loader 直接 import 的模块；Node 按 URL 缓存 ESM，所以在**同一个进程里**改代码后必须重启 profile 才会加载新代码。
- 受管区块由设置页重写；想手工固定模块定位，可以把 `override` 区块换成 `insert` 形态并写明 `name:`，或直接在 `cordis.patch.yml` 里加自己的行（注意不要与 bundle 层重复）。
