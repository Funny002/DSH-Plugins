# dsh-mcp-manager

在 Harness 里管理 MCP（Model Context Protocol）服务器：**Host 半侧**连接 stdio / Streamable-HTTP 服务器并把它们的工具注册到 `ctx.tools`，**Browser 半侧**在设置页里做增删改查、启停和状态查看。所有变更写回 profile 的 `cordis.patch.yml`，由 profile 的 live patch 重载热生效。

## 目录结构

```
plugins/dsh-mcp-manager/
├── package.json           # 双半侧声明：main = lib/index.js，exports["./client"] + dsh.client
├── lib/
│   ├── index.js           # Host 半侧插件入口：McpManager（Service）、Config、行配置
│   ├── supervisor.js      # 每个服务器一条连接：MCP SDK 客户端、工具注册/注销、状态
│   ├── channel.js         # 浏览器 RPC 通道（复用 Connection 的 unary envelope）
│   ├── patch-file.js      # cordis.patch.yml 里受管区块的读写（保留其他内容与注释）
│   ├── naming.js          # mcp__<server>__<tool> 命名契约与内容投影
│   └── client.js          # 浏览器半侧：settings.section 页面（lazy-CJS factory 产物）
└── test/
    ├── mcp-echo-server.mjs  # 本地 MCP 服务器 fixture（stdio 与 --http 两种传输）
    ├── check-host.mjs       # 离线检查：配置校验、命名、patch 区块读写
    ├── check-channel.mjs    # 离线检查：RPC envelope、错误分支、体积上限
    └── check-client.mjs     # 离线检查：bundle 注册、文案完整性、组件可渲染
```

## 挂载

插件的行写在 profile 的 `cordis.patch.yml` 中（`$DSH_HOME/profiles/web/cordis.patch.yml`）。settings 页面自己维护这个区块，手工重装只需把下面这段放回文件：

```yaml
# >>> dsh-mcp-manager managed block — rewritten by the MCP settings page; do not edit by hand >>>
- insert:
    - id: mcp-manager
      name: './plugins/dsh-mcp-manager/lib/index.js'
      config:
        servers: []
# <<< dsh-mcp-manager managed block <<<
```

- 该行必须写在 `insert:` 里：只有 `insert` 才会新增条目，裸的 `- id:` patch 只覆盖已存在的行。
- `name` 是相对于 patch 文件的路径，loader 会把它锚定成 file URL，因此无需把包装进 `node_modules`。
- 改完文件由 profile 的 live patch 重载生效（`web` profile 默认 `patchReload: live`）；离线的一次性 profile（`headless`/`sdk`/`acp`）在下次启动时应用。
- 卸载：删掉整个受管区块，或把 `servers` 清空后删除该行。

新增一个服务器也可以完全绕开 GUI，直接往 `config.servers` 里加一条并重新启动 profile。

## 服务器定义

```yaml
config:
  servers:
    - {"name":"github","enabled":true,"transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-github"],"env":{"GITHUB_TOKEN":"env.GITHUB_TOKEN"},"cwd":"","toolCallTimeoutMs":60000}
    - {"name":"web","enabled":false,"transport":"streamable-http","url":"http://127.0.0.1:3000/mcp","headers":{"Authorization":"Bearer …"},"toolCallTimeoutMs":60000}
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

`env` 的值写成 `env.NAME` 或 `${NAME}` 时，在连接那一刻从进程环境读取（含 `$DSH_HOME/.env`），因此凭据不必落在 patch 文件里。stdio 子进程继承的宿主环境会先剔除名字形如 `/KEY|PASSWORD|SECRET|TOKEN/i` 以及全部 `DSH_*` 的变量，再由 `env` 覆盖。

## 运行机制

**Host 半侧**（`lib/index.js`）

1. 为每个启用的定义建立一个 `McpServerSupervisor`：连接、`tools/list` 全量分页拉取、把每个工具注册到 `ctx.tools`，公开名为 `mcp__<serverName>__<rawName>`（与 `@deepseek-ai/dsh-mcp-client` 相同的命名契约，超出 64 字符或含非法字符时追加 12 位 SHA-256 后缀）。工具调用走原始 MCP 名，`isError` 结果抛错，内容按块投影成模型可见文本。
2. 提供 `mcpManager` 服务（Cordis Service，随 fiber 自动注销）：`list()`、`tools()`、`add()`、`update()`、`remove()`、`setEnabled()`、`refresh()`、`probe()`、`dispatch()`。
3. 在 `ctx.inject(['connection','webServer'], …)` 里注册 `/mcp-manager` 前缀路由：先跑 Connection 的 Host/Origin + 浏览器 cookie 校验（未认证返回 401/403），再解析 Connection 的 unary envelope 并转发给 `dispatch()`。复用同一套 envelope，浏览器半侧因此可以直接用 `ctx.connection.rpc.call('/mcp-manager', …)`。
4. 任何变更先写 patch 文件（`lib/patch-file.js` 只替换自己的受管区块，保留其余行与注释；写入前用 `readManagedBlock` 回读校验，写坏就拒绝落盘），再把变更应用到当前 generation 的 supervisor —— 因此在 live 重载到达之前，启停和工具注册/注销就已经生效。

**Browser 半侧**（`lib/client.js`）

- 一个 lazy-CJS factory 产物，通过 `window.__ModuleLoader__.load({ id: 'dsh-mcp-manager', factory })` 注册，只 `require('react')`（平台基线模块），因此不需要构建步骤、也不声明 `dsh.client.external`。
- 在 `settings.section` 注册 id 为 `mcp-servers` 的设置页（order 25）：服务器卡片显示传输方式、连接状态、工具数、目标、错误；支持启用/停用、编辑、删除、刷新、展开工具列表、「测试连接」（`probe`，不注册任何工具）。
- **页面文案固定中文**：`lib/client.js` 顶部的 `PAGE_LOCALE = "zh"` 决定页面语言，与 GUI 语言无关；改成 `"auto"` 即恢复跟随 locale 服务。zh/en 两份字典仍会注册到 `mcp-manager` 命名空间，因此改回 `"auto"` 不需要补文案。协议名（`stdio` / `streamable-http`）与工具公开名（`mcp__…`）保持原样。
- 每次变更后会轮询 `state` 直到 `generation` 变化，以此确认「已写入配置文件并热重载」。

**RPC 端点**（`POST /mcp-manager/<endpoint>`）

| endpoint | 载荷 | 返回 |
| --- | --- | --- |
| `state` | `{}` | `{ generation, rowId, channel, patchFile, persistence, servers[], totals }` |
| `add` | `{ definition }` | 写入回执 + `snapshot` |
| `update` | `{ name, definition }` | 写入回执 + `snapshot`（改 `definition.name` 即重命名） |
| `remove` | `{ name }` | 写入回执 + `snapshot` |
| `setEnabled` / `start` / `stop` | `{ name, enabled? }` | 写入回执 + `snapshot` |
| `refresh` | `{ name? }` | 重新拉取工具列表后的 `snapshot` |
| `tools` | `{ name? }` | `{ tools: [{ server, rawName, publicName, description }] }` |
| `probe` | `{ definition }` | `{ name, toolCount, tools }`，不持久化、不注册工具 |

业务失败以 `200` + `{ ok: false, error }` 返回（浏览器半侧折叠成错误提示）；只有传输层问题用非 200。

## 验证

离线（无需 Harness）：

```sh
node test/check-host.mjs      # 配置校验、命名契约、patch 区块往返
node test/check-channel.mjs   # RPC envelope、401/404/413/415/400 分支
node test/check-client.mjs    # bundle 注册、48 条文案完整性、组件结构
node test/check-client.mjs && node test/check-channel.mjs && node test/check-host.mjs
```

用随包 fixture 做端到端冒烟（在设置页或直接写 `config.servers`）：

```jsonc
{ "name": "echo", "transport": "stdio", "command": "node",
  "args": ["<profile>/plugins/dsh-mcp-manager/test/mcp-echo-server.mjs"] }
// 或 Streamable-HTTP：node test/mcp-echo-server.mjs --http 8931
{ "name": "web", "transport": "streamable-http", "url": "http://127.0.0.1:8931/mcp" }
```

已在本机对运行中的 `web` profile 实测：stdio 与 streamable-http 两种传输各注册 2 个工具；模型侧调用 `mcp__echo__add(2,3)` 返回 `5`；停用后该工具立刻变成 `unknown tool`，重新启用后 `mcp__probe-test__add(20,22)` 返回 `42`；删除后文件与运行态同步；`POST /mcp-manager/state` 未认证返回 401；`/plugins/??dsh-mcp-manager/client.js&rev=…` 返回 200 且该 id 出现在浏览器 boot 图中。

## 已知限制

- **只桥接工具。** MCP resources 与 prompts 没有消费方，不注册。
- **不做自动重连。** 连接失败记录在 `error` 里并在设置页可见；改配置或点「刷新」会重连。需要退避重连的部署可以直接用 `@deepseek-ai/dsh-mcp-client` 的行。
- **整行热替换。** 每次持久化都会让本行重新挂载，因此所有服务器会重连一次、工具短暂注销后重新注册。会话历史与权限规则不受影响，因为公开工具名只由 `(serverName, rawName)` 决定。
- **工具列表按需刷新。** 服务器主动推送的 `notifications/tools/list_changed` 不监听；用「刷新」或重新启用该服务器。
- **图片不落盘。** 带图结果投影成 `[image <mimeType>]` 文本；需要图片附件的部署请用 `@deepseek-ai/dsh-mcp-client`。
- **凭据落在 patch 文件里。** 用 `env.NAME` / `${NAME}` 间接引用进程环境即可避免；注意 patch 文件本身没有权限保护。
- **中文的范围。** 页面文案、以及插件自己产生的校验/失败提示（服务器名、url、command、唯一性、patch 写入等）都是中文；MCP SDK、Node 与远端服务器返回的诊断文本（如 `fetch failed`、`spawn … ENOENT`）保持原文，以便直接对照日志与上游问题。

## 运维备注

- `lib/index.js` 是 patch 行直接 import 的模块；Node 会按 URL 缓存 ESM，所以在**同一个进程里**改代码后必须让该行指向一个新的 URL（整个目录大小写变化最省事，因为相对 import 的基准目录也会变）或重启 profile 才会加载新代码；仅加 `?rev=` 只刷新入口模块，其相对 import 仍命中缓存。最稳妥的做法是重启。
- 受管区块由设置页重写；想手工固定模块定位，可以把 `name` 改成任意绝对路径或 file URL，保存时会原样保留。
