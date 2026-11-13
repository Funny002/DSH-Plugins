# dsh-skill-manager

在 Harness 里管理本地技能（Agent Skills）：**Host 半侧**扫描唯一的技能根目录 `$DSH_HOME/skills`（Windows 上通常是 `C:\Users\<用户>\.dsh\skills`），解析 `SKILL.md` 目录包与扁平 `<name>.md` 的 frontmatter 和正文；**Browser 半侧**在设置页里新建、导入、编辑、改名、启停、复制与删除这些文件。技能文件本身就是持久层——本插件不把技能内容写进配置，也没有第二个可能藏技能的地方。

本包按 Harness 的 **bundle** 格式分发：`package.json` 的 `dsh.bundle` 指向自带的 `cordis.patch.yml`，该层插入唯一的一行 `skill-manager`，行上没有任何必须填写的配置。

## 目录结构

```
dsh-skill-manager/
├── package.json           # dsh.bundle（组合包层）+ dsh.client（浏览器半侧）+ exports
├── cordis.patch.yml       # bundle 自带的组合层：插入 skill-manager 行
├── lib/
│   ├── index.js           # Host 入口：SkillManager（Service）、配置 schema、RPC 分派
│   ├── scanner.js         # 技能发现：根目录、frontmatter 解析/渲染、定义校验、原子写入、扫描缓存
│   ├── channel.js         # 浏览器 RPC 通道（复用 Connection 的 unary envelope + 信任栅栏）
│   └── client.js          # 浏览器半侧：settings.section 页面（lazy-CJS factory 产物）
└── test/
    ├── check-host.mjs     # 离线：frontmatter、调用语法、扫描、遮蔽、校验、路径约束、BOM/超大文件、扫描缓存
    ├── check-service.mjs  # 离线：真实 Cordis Context 上的增删改查、改名、复制、导入、遮蔽、异常条目删除
    ├── check-channel.mjs  # 离线：RPC envelope、错误分支、体积上限、断开与超大请求
    ├── check-client.mjs   # 离线：bundle 注册、文案完整性、组件可渲染、轮询节流与展示层断言
    ├── bench-scan.mjs     # 离线：扫描 N 个合成技能的耗时（冷/热/单文件改动）
    ├── preview-panel.mjs  # 离线：把面板渲染成静态 HTML，便于截图检查排版
    └── verify-live.mjs    # 活体：对运行中的宿主做 CRUD、改名、复制、导入、异常删除
```

## 安装与卸载

作为组合包安装（`dsh plugin` 转发给 profile 内的 pnpm）：

```sh
dsh plugin --profile web add ./dsh-skill-manager              # 本地目录：pnpm 链接该 checkout
dsh plugin --profile web add ./dsh-skill-manager-0.3.0.tgz    # 或交付 tarball
dsh plugin --profile web remove dsh-skill-manager             # 连带移除依赖与组合层
```

安装后 profile 的 `package.json` 会多出 `dsh-skill-manager` 依赖与一个 `dsh.profile.bundles` 条目，profile 的 `cordis.patch.yml` **保持你自己的内容**——不要手工往里写 `skill-manager` 行，那会和 bundle 层重复挂载。

- 用 `dsh --profile web --dump-config` 可以看到 `# == dsh-skill-manager` 这一层，不启动也能确认组合正确。
- 以 `link:` 安装的 checkout 保留自己的 `node_modules`：`pnpm install` 一次的产物（`dependencies` 是 `yaml`，`devDependencies` 是 cordis/schemastery，用于本地跑测试）。改宿主代码后**重启 profile** 即生效；只改 `lib/client.js` 时刷新页面即可。
- 本包的 `peerDependencies` 只有 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`。Cordis 的服务协议走 `Symbol.for`，链接安装时宿主与本包的副本可以共存。

## 技能根目录

只有一个根目录：`<DSH_HOME>/skills`。

| 项目 | 值 |
| --- | --- |
| 解析顺序 | 行配置 `dshHome` → `$DSH_HOME` → `~/.dsh` |
| 典型路径 | `C:\Users\<用户>\.dsh\skills` |
| 与 provider 的关系 | 正是 `@deepseek-ai/dsh-skill-filesystem` 的 `user-dsh` 根目录（rank 400） |
| 跳过的子目录 | `.system`（与 provider 一致） |

因为用的是 provider 自己的根目录，保存技能后模型侧下一次目录刷新就能看到；页面不提供、也不持久化任何附加根目录。`dshHome` 只用于让本插件与 `skill-filesystem` 的 `dshHome` 覆盖保持一致，页面不会修改它。

技能只有两种形状，且只扫描根目录**下一层**：

```text
<root>/<name>/SKILL.md     # 目录包，可以额外携带 references/、scripts/、assets/
<root>/<name>.md           # 扁平文件
```

`SKILL.md` / `<name>.md` 以 YAML frontmatter 开头：

```markdown
---
name: code-review
description: Review a diff for correctness, style, and missing tests.
whenToUse: When the user asks for a code review.
disable-model-invocation: false
user-invocable: true
metadata:
  owner: platform
---

# Instructions
...
```

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `name` | 是 | — | kebab-case，`[a-z0-9]+(-[a-z0-9]+)*`；与文件名不一致只警告，不丢弃 |
| `description` | 是 | — | 模型靠它决定是否加载；超过 1024 字符会提醒 |
| `whenToUse` | 否 | — | 额外路由说明 |
| `disable-model-invocation` | 否 | `false` | `true` 时模型目录与 `skill` 工具不再列出它 |
| `user-invocable` | 否 | `true` | `false` 时命令面板不再列出它 |
| `metadata` | 否 | — | 任意对象，页面只展示、不编辑 |
| 其他键 | 否 | — | 编辑时原样保留（例如 `license`、`allowed-tools`） |

调用开关接受 YAML 布尔值以及大小写不敏感的 `true/false`、`yes/no`、`on/off`、`1/0`；`disableModelInvocation`、`modelInvocable`、`userInvocable` 这类旧写法会被明确拒绝，而不是静默放进模型目录。**同名解析**按 provider 的扫描顺序进行：先遇到的条目生效，其余条目仍然出现在页面上，标记为「已遮蔽」并显示赢家路径。同一个文件只会算作一个技能（按 realpath 去重，所以根目录内的符号链接别名不会变成「自己遮蔽自己」的重复行）。

解析与 provider 严格一致，因此顺带诊断三种「文件在、模型看不到」的情况，而不是让它们变成「缺少 frontmatter」：

| 情况 | 页面上报 |
| --- | --- |
| 文件以 UTF-8 BOM 开头 | 指名 BOM（provider 比较首行字节，`\uFEFF---` 不等于 `---`） |
| 单个文件超过 1 MiB | 提示把大段内容移进 `references/`，该文件被跳过 |
| 扁平文件扩展名不是小写 `.md`（如 `X.MD`） | 仍然列出，但标注「provider 只识别 `<name>.md`」 |

## 页面功能

设置 → 技能（`settings.section` id `skills`，order 26）：

- **顶部**：技能 / 模型可见 / 用户可调用 / 已遮蔽计数，异常数作为橙色提醒；右侧是「刷新」「导入」「新建技能」。标题旁的版本徽标由宿主从本包 `package.json` 读取后随快照下发。
- **搜索与筛选**：名称、描述、`whenToUse`、路径；筛选支持 全部 / 已遮蔽 / 已停用模型 / 有警告。
- **卡片（默认折叠）**：名称、状态 chip（已遮蔽、注意、模型不可见、用户不可调）、操作（停用/启用、编辑、复制、删除）、描述、磁盘路径。`详情` 展开调用策略/布局/位置/目录/正文大小/更新时间/元数据/警告；`正文` 按需从磁盘读取 Markdown 并显示，不把正文塞进状态轮询。
- **启停**是一次性开关：`停用` 同时写 `disable-model-invocation: true` 与 `user-invocable: false`，`启用` 反之；只关模型或只关用户，用编辑表单里的两个复选框。
- **新建 / 编辑 / 复制**：名称、描述、使用时机、磁盘布局、模型可见、用户可调用、正文；表单顶部固定显示「写入技能根目录：`<绝对路径>`」。编辑时布局锁定（移动是复制，不是编辑）；`校验` 调宿主做真实校验并给出按规范渲染的 frontmatter 预览。
- **导入**：粘贴一份完整的 `SKILL.md`（frontmatter + 正文），宿主用与磁盘文件**完全相同**的解析规则校验后才落盘；文本原样保留（含未知 frontmatter 键与排版），只有在「技能名称」里另填名字时才改写 frontmatter 的 `name`。
- **删除**：目录包删除整个目录（包括 `references/` 等资源），扁平文件只删该文件；确认框里写明绝对路径且不可撤销。
- **异常面板**：无法解析的文件（缺 frontmatter、非法 YAML、BOM、超大、非法调用开关）不会从列表里消失，而是列在这里——否则用户只能看到「技能没了」。每条异常都带「删除」，因为页面无法为解析不了的文件提供编辑表单；宿主只允许删除**当前扫描确实报为异常**的路径，正常技能无法从这个入口被删掉。
- **页脚**：技能根目录与工作区（宿主默认工作目录）各一行。
- **旧宿主提示**：页面只渲染技能根目录内的文件并按绝对路径去重，所以即使宿主还没重启（旧版会扫描多个根目录），也不会出现重复卡片；此时列表上方会显示一行提示，说明重启 `dsh web`（或桌面应用）后单根目录才完全生效。
- **编辑锁定**：打开编辑/复制/导入表单期间，卡片上的启停、编辑、复制、删除按钮会暂时禁用，避免在表单打开时切换到另一个技能；表单本身按目标路径重新挂载，草稿不会串到别的技能。
- **轮询开销**：8 秒轮询一次 `state`，但返回的快照与屏幕上的一致时不写入 React state（不重渲染任何卡片）；标签页隐藏时跳过轮询，重新可见时立即拉一次；「N 分钟前」由独立的 60 秒计时器刷新。
- 页面文案固定中文：`lib/client.js` 顶部的 `PAGE_LOCALE = "zh"`，与 GUI 语言无关；改成 `"auto"` 即恢复跟随 locale 服务。zh/en 两份字典仍会注册到 `skill-manager` 命名空间。
- 操作反馈（已创建 / 已保存 / 已复制 / 已导入 / 已启停…）4.5 秒后自动消失；执行新操作或打开表单会立即清掉它。失败提示不自动消失。

## 运行机制

**Host 半侧**（`lib/index.js`）

1. 每个 RPC 请求都重新扫描根目录，不缓存目录条目：外部编辑器、Git 或 shell 的改动会立刻出现在下一次 `state` 里。写操作先扫描一次、按绝对路径定位行，再落笔，避免拿旧快照写错文件；一次写操作只扫描两次（写前定位 + 写后回执），不再为唯一性检查额外扫一遍。
2. `SkillManager` 是 Cordis Service，暴露 `list()`、`get(path)`、`validate()`、`create()`、`update()`、`remove()`、`setInvocation()`、`setEnabled()`、`copy()`、`importSkill()`、`discard()`、`refresh()`。
3. **扫描缓存**：每个文件按 `path + mtime + size` 缓存已解析的表头（name/description/whenToUse/调用策略/metadata/正文大小/警告），文件没变就不再读盘、不再跑 YAML；上限 1024 条、按最近最少使用淘汰。本插件自己写入或删除一个文件时立即丢弃该条缓存，所以「写后立刻读」永远是新内容。
4. 写入是**原子替换**：同目录、进程内唯一的临时文件 + `rename`（失败时清理临时文件）。新建与复制走**独占发布**（临时文件 `link` 到目标，目标已存在则 `EEXIST`，没有「先检查后写入」的竞态；不支持硬链接的文件系统退化为 `wx` 独占创建）。改名时先移动目录（目录包）或文件（扁平），再写 `SKILL.md`，因此资源文件跟着走；改名后的写入失败会把路径移回原处并在错误里说明。未知 frontmatter 键从原文件读出后原样写回，`disable-model-invocation` 与 `user-invocable` 永远显式写出，页面开关与文件不会漂移。
5. 路径约束：只写根目录内的文件（`writeSkillFile` 用 `isInside` 拒绝越界目标）；删除目录包前拒绝删除根目录本身，也拒绝删除根目录之外的位置；新建/改名会拒绝引入**新的**同名遮蔽（磁盘上已经存在的遮蔽行仍可编辑、改名或复制）。`resolveCatalog` 按 realpath 丢弃重复条目，同一个文件永远不会解析成两个技能。
6. 技能内容由 `skill-filesystem` 自己的 watcher 索引：保存后下一次目录刷新即可见，**不需要重启**。设置页的 `state` 是本插件的视图，不读 registry 缓存，因此不会显示过期目录。

**Browser 半侧**（`lib/client.js`）

- 一个 lazy-CJS factory 产物，通过 `window.__ModuleLoader__.load({ id: 'dsh-skill-manager', factory })` 注册，只 `require('react')`（平台基线模块），因此不需要构建步骤。
- 8 秒轮询 `state`；快照未变化时不更新 state（见上「轮询开销」）；每次变更优先使用回执里的 `snapshot` 立即刷新；正文按卡片按需读取，缓存上限 32 条、任何写入后缓存清空、正文面板收起。

**RPC 端点**（`POST /skill-manager/<endpoint>`）

| endpoint | 载荷 | 返回 |
| --- | --- | --- |
| `state` | `{}` | `{ generation, version, rowId, channel, workspace, skillRoot, roots[], skills[], issues[], totals }` |
| `get` | `{ path }` | `{ skill, body, raw, frontmatter }` |
| `validate` | `{ definition }` | `{ valid, issues[], warnings[], normalized, preview, target }`，不落盘 |
| `create` | `{ definition }` | 写入回执 + `snapshot` |
| `update` | `{ path, definition }` | 写入回执 + `snapshot`（`definition.name` 改变即改名并移动文件/目录） |
| `remove` | `{ path }` | 删除回执 + `snapshot` |
| `setInvocation` | `{ path, modelInvocable?, userInvocable? }` | 只改两个调用键后的回执 + `snapshot` |
| `start` / `stop` | `{ path }` | 同时打开/关闭两个 surface 的回执 + `snapshot` |
| `copy` | `{ path, definition: { name, layout } }` | 复制回执 + `snapshot` |
| `import` | `{ text, name?, layout? }` | 导入回执（含最终 `name`）+ `snapshot`；`text` 必须是完整合法的 `SKILL.md` |
| `discard` | `{ path }` | 删除一个**当前**异常条目的回执 + `snapshot`；正常技能会被拒绝 |
| `refresh` | `{}` | 重新扫描后的 `snapshot` |

业务失败以 `200` + `{ ok: false, error }` 返回（浏览器半侧折叠成错误提示）；只有传输层问题用非 200：`401/403`（信任栅栏）、`404`（路径不是本通道或方法不对）、`413`（请求体超过 1 MiB，先回响应再关连接）、`415`（非 JSON content-type）、`400`（JSON 解析失败或请求中断）。

## 验证

离线（在 checkout 里 `pnpm install` 之后，无需 Harness）：

```sh
node test/check-host.mjs        # frontmatter、调用语法、扫描、遮蔽、校验、路径约束、BOM/超大文件、扫描缓存
node test/check-service.mjs     # 真实 Cordis Context 上的 CRUD、改名、复制、导入、遮蔽、异常条目删除
node test/check-channel.mjs     # RPC envelope、401/403/404/413/415/400 分支、断开与超大请求
node test/check-client.mjs      # bundle 注册、文案完整性、组件可渲染、轮询节流与展示层断言
node test/bench-scan.mjs        # 扫描耗时（默认 400 个合成技能，--skills/--scans/--scanner 可调）
node test/preview-panel.mjs panel-preview.html   # 渲染静态面板（可再用无头浏览器截图检查排版）
```

本机实测（Windows 11、Node 26）：`node test/bench-scan.mjs` 在 400 个合成技能（一半目录包、一半扁平）上，单次扫描从改动前的 **≈101 ms** 降到 **≈9–11 ms**（冷启动 146→128 ms，冷启动不降是因为首次仍要读每个文件）；12 个技能时 **≈5.4 ms → ≈0.5 ms**；一次写操作（create/rename）在 220 个技能下从 **94/127 ms** 降到 **17/12 ms**。复现方式：用 `--scanner <旧 scanner.js 的路径>` 对照，或 `git stash` 前后各跑一次。

活体验证（需要一个运行中的宿主；`verify-live.mjs` 用启动行打印的 `?token=` 换取 cookie）：

```sh
dsh --profile web --port 3099 --no-open
node test/verify-live.mjs http://127.0.0.1:3099 <token-from-launch-line>
```

它会验证：新建目录包并读回正文、关闭模型开关后 frontmatter 落盘、改名移动目录并保留资源、复制成同一根目录下的扁平文件、粘贴导入一份 `SKILL.md`（含未知 frontmatter 键）、删除一个异常条目、删除后文件与目录都消失，最后确认根目录里没有遗留技能。

本 checkout 的实测记录（Windows，web profile）：页面注册为 `settings.section#skills`；新建 `demo-skill` 后本会话的技能目录立即出现该技能；点 `停用` 后目录立即移除、点 `启用` 后恢复；改名为 `demo-skill-renamed` 后目录同步改名；`删除` 后目录与磁盘文件一起消失，全程未重启宿主。

## 与 dsh-mcp-manager 的对应关系

| MCP 管理器 | 技能管理器 |
| --- | --- |
| 每个 MCP 服务器一条受监督连接，工具注册到 `ctx.tools` | 每个本地技能一个 `SKILL.md` / `<name>.md`，由 `skill-filesystem` 索引 |
| 服务器定义整体存在 patch 层的 config 里 | 技能内容存在固定的技能根目录；没有需要持久化的定义 |
| 断线重连、世代、预算 | 每次请求重新扫描（表头按 mtime 缓存）；watcher 负责模型侧刷新 |
| `mcpManager` Service + `/mcp-manager` 通道 | `skillManager` Service + `/skill-manager` 通道 |
| 设置页编辑定义、启停、测试连接 | 设置页编辑 frontmatter/正文、导入、启停、复制、删除 |

## 已知限制

- **只管一个目录。** 项目级 `.dsh/skills`、`.agents/skills` 以及其他自定义根目录都不扫描、不展示，也不提供切换入口；本页只对应 `<DSH_HOME>/skills`。
- **随 bundle / preset 打包的技能不在此页。** 例如 `@deepseek-ai/dsh-agent-preset/skills` 下的技能由各自的 provider 作用域提供，管理器不进入它们。
- **体积上限。** 单个指令文件超过 **1 MiB** 会被跳过并在异常面板说明；页面保存的正文上限是 **1 MiB − 16 KiB**（给 frontmatter 与 YAML 渲染留余量）；RPC 请求体上限 **1 MiB**，所以正文接近上限时整份请求可能先被 413 拒绝。
- **缓存按 mtime 判定新鲜度。** 表头缓存用 `mtime + size` 作废；在同一次写入里用工具把文件改成「大小相同、mtime 也被强制回拨」的内容，要等下一次真实改动才会刷新（本插件自己的写入与删除会立即丢弃缓存）。
- **导入不做格式重排。** 名称与 frontmatter 一致时原样写盘；填写了别的名称才会重新渲染 frontmatter（保留未知键）。
- **复制只带 frontmatter 与正文。** 目录包里的 `references/`、`scripts/` 等资源不会一起复制；需要整包复制时用文件系统操作。
- **删除是递归的。** 删除目录包会连同资源文件一起删除（确认框写明完整路径），不做回收站；`异常面板` 里的删除同理，且只接受当前扫描确实报为异常的路径（符号链接按链接删除，不会删到链接目标）。
- **不支持切换布局。** 布局（目录/单文件）在编辑时锁定，因为换布局是复制而不是编辑；跨目录移动也不支持。
- **`metadata` 只读。** 页面展示 `metadata` 的 JSON 并原样保留，但不在表单里编辑它。
- **中文的范围。** 页面文案、以及插件自己产生的校验/失败提示都是中文；YAML、Node 与文件系统的原生错误保持原文（并用 `cause` 保留原始错误对象）。

## 运维备注

- 以 `link:` 安装时宿主与 checkout 各有一份 `@deepseek-ai/cordis`；两者版本应保持一致（本仓库 `devDependencies` 固定为当前部署版本），避免跨版本的服务实现漂移。
- `lib/index.js` 是 loader 直接 import 的模块；Node 按 URL 缓存 ESM，所以**同一个进程里**改宿主代码后必须重启 profile。`lib/client.js` 是静态工件，刷新页面即加载新内容。
- 技能根目录由宿主解析，页面只读展示；想让根目录指向别处，请用行配置 `dshHome`（并让 `skill-filesystem` 使用同一值），不要在页面上改。
- 想在验证时不动正在使用的 GUI，可以再起一个 `dsh --profile web --port <free> --no-open` 实例：两个进程共用同一份技能目录，验证脚本只创建并清理自己的临时技能。
