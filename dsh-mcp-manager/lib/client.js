/**
 * `dsh-mcp-manager` — browser half.
 *
 * Registers one `settings.section` page ("MCP servers") that lists the managed
 * servers with their live connection state, and edits / starts / stops /
 * removes them. Every mutation goes through the authenticated
 * `/mcp-manager` RPC channel owned by the host half, which persists the change
 * into the profile's `cordis.patch.yml` and lets the running tree hot-swap the
 * manager row.
 *
 * This file is the package's built `./client` artifact: a lazy-CJS factory that
 * the shell's module loader registers during boot, exactly like the shipped
 * `@deepseek-ai/dsh-client-ui-*` bundles. It requires only baseline modules
 * (`react`), so it declares no `dsh.client.external` requests.
 */
window.__ModuleLoader__.load({
  id: "dsh-mcp-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useCallback, useEffect, useRef, useState } = React;
    const h = React.createElement;

    /** RPC channel registered by the host half. */
    const CHANNEL = "/mcp-manager";
    /** Locale dictionary namespace owned by this plugin. */
    const NS = "mcp-manager";
    /** Injected stylesheet element id. */
    const STYLE_ID = "dsh-mcp-manager-style";
    /** Poll cadence for the status snapshot, in milliseconds. */
    const POLL_MS = 8000;
    /** How long a persisted change is watched for its hot-swapped generation. */
    const RELOAD_POLL_MS = 700;
    const RELOAD_POLL_TRIES = 25;

    //#region dictionaries
    const zh = {
      nav: "MCP 服务器",
      title: "MCP 服务器",
      subtitle: "连接外部 MCP 服务器并把它们的工具注册给模型。所有改动写入 profile 的 cordis.patch.yml 并热生效。",
      refresh: "刷新",
      add: "添加服务器",
      empty: "还没有配置任何 MCP 服务器。",
      emptyHint: "添加一个 stdio 或 streamable-http 服务器后，它的工具会以 mcp__<名称>__<工具名> 出现。",
      servers: "服务器",
      enabled: "已启用",
      connected: "已连接",
      tools: "工具",
      configFile: "配置文件",
      configMissing: "（未找到）",
      rowId: "行 id",
      save: "保存",
      cancel: "取消",
      edit: "编辑",
      remove: "删除",
      start: "启用",
      stop: "停用",
      retry: "重试",
      details: "工具列表",
      hideDetails: "收起",
      test: "测试连接",
      testing: "连接中…",
      confirmRemove: "删除服务器 “{name}”？它会从配置文件和运行中的工具列表里移除。",
      status: {
        connected: "已连接",
        connecting: "连接中",
        error: "连接失败",
        idle: "未连接",
        disabled: "已禁用",
      },
      field: {
        name: "名称（工具命名空间）",
        nameHint: "1-32 个字符，仅限字母、数字、下划线和连字符；工具名将变成 mcp__<名称>__<工具名>。",
        transport: "传输方式",
        enabled: "启用",
        command: "命令",
        args: "参数（每行一个）",
        cwd: "工作目录（可选）",
        env: "环境变量（每行 KEY=VALUE）",
        envHint: "值写成 env.NAME 或 ${NAME} 时，连接时从进程环境（含 $DSH_HOME/.env）读取。",
        url: "服务地址（streamable-http）",
        headers: "请求头（每行 KEY: VALUE）",
        timeout: "单次调用超时（毫秒）",
      },
      form: {
        addTitle: "添加服务器",
        editTitle: "编辑服务器 {name}",
        invalid: "请先补全必填项。",
      },
      notice: {
        saved: "已写入 cordis.patch.yml，正在热重载配置…",
        reloaded: "配置已热重载。",
        refreshed: "工具列表已刷新。",
        probed: "测试连接成功：发现 {count} 个工具。",
        started: "已启用 {name}。",
        stopped: "已停用 {name}。",
        removed: "已删除 {name}。",
      },
      error: {
        noConnection: "浏览器连接服务不可用。",
        transport: "无法访问宿主插件（可能尚未挂载或正在热重载）",
        unknown: "宿主返回了无法识别的失败。",
      },
    };

    const en = {
      nav: "MCP servers",
      title: "MCP servers",
      subtitle:
        "Connect external MCP servers and give the model their tools. Every change is written to the profile's cordis.patch.yml and hot-applied.",
      refresh: "Refresh",
      add: "Add server",
      empty: "No MCP server is configured yet.",
      emptyHint: "Add a stdio or streamable-http server; its tools appear as mcp__<name>__<tool>.",
      servers: "Servers",
      enabled: "Enabled",
      connected: "Connected",
      tools: "Tools",
      configFile: "Config file",
      configMissing: "(not found)",
      rowId: "Row id",
      save: "Save",
      cancel: "Cancel",
      edit: "Edit",
      remove: "Remove",
      start: "Enable",
      stop: "Disable",
      retry: "Retry",
      details: "Tools",
      hideDetails: "Hide",
      test: "Test connection",
      testing: "Connecting…",
      confirmRemove: "Remove server “{name}”? It disappears from the config file and from the live tool list.",
      status: {
        connected: "Connected",
        connecting: "Connecting",
        error: "Failed",
        idle: "Idle",
        disabled: "Disabled",
      },
      field: {
        name: "Name (tool namespace)",
        nameHint: "1-32 chars of letters, digits, underscore, hyphen; tools become mcp__<name>__<tool>.",
        transport: "Transport",
        enabled: "Enabled",
        command: "Command",
        args: "Arguments (one per line)",
        cwd: "Working directory (optional)",
        env: "Environment (KEY=VALUE per line)",
        envHint: "A value of env.NAME or ${NAME} is read from the process environment (including $DSH_HOME/.env) at connect time.",
        url: "Endpoint URL (streamable-http)",
        headers: "Headers (KEY: VALUE per line)",
        timeout: "Per-call timeout (ms)",
      },
      form: {
        addTitle: "Add server",
        editTitle: "Edit server {name}",
        invalid: "Complete the required fields first.",
      },
      notice: {
        saved: "Written to cordis.patch.yml; hot-reloading the configuration…",
        reloaded: "Configuration hot-reloaded.",
        refreshed: "Tool list refreshed.",
        probed: "Connection test succeeded: {count} tool(s) found.",
        started: "{name} enabled.",
        stopped: "{name} disabled.",
        removed: "{name} removed.",
      },
      error: {
        noConnection: "The browser connection service is unavailable.",
        transport: "Cannot reach the host plugin (not mounted yet, or hot-reloading)",
        unknown: "The host returned an unrecognisable failure.",
      },
    };
    //#endregion

    //#region styles
    const CSS = `
.dsh-mcp { display: flex; flex-direction: column; gap: 14px; max-width: 860px; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dsh-mcp-head { display: flex; flex-direction: column; gap: 6px; }
.dsh-mcp-title { margin: 0; font-size: 15px; font-weight: 600; }
.dsh-mcp-subtitle { margin: 0; color: var(--dsw-alias-label-secondary); }
.dsh-mcp-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-mcp-summary { display: flex; gap: 12px; flex-wrap: wrap; color: var(--dsw-alias-label-secondary); }
.dsh-mcp-summary b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.dsh-mcp-spacer { flex: 1 1 auto; }
.dsh-mcp-btn { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; cursor: pointer; }
.dsh-mcp-btn:hover { border-color: var(--dsw-alias-brand-primary); }
.dsh-mcp-btn:disabled { opacity: .5; cursor: default; }
.dsh-mcp-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 600; }
.dsh-mcp-btn.danger { color: var(--dsw-alias-state-error-primary); }
.dsh-mcp-btn.ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.dsh-mcp-btn.ghost:hover { color: var(--dsw-alias-label-primary); }
.dsh-mcp-banner { padding: 8px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.dsh-mcp-banner.error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsh-mcp-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.dsh-mcp-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-mcp-name { font-weight: 600; font-size: 14px; }
.dsh-mcp-chip { padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsh-mcp-state { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); }
.dsh-mcp-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-label-secondary); }
.dsh-mcp-dot.connected { background: var(--dsw-alias-state-success-primary); }
.dsh-mcp-dot.connecting { background: var(--dsw-alias-state-warn-primary); }
.dsh-mcp-dot.error { background: var(--dsw-alias-state-error-primary); }
.dsh-mcp-target { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.dsh-mcp-error { color: var(--dsw-alias-state-error-primary); overflow-wrap: anywhere; }
.dsh-mcp-tools { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.dsh-mcp-tools li { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); }
.dsh-mcp-tools code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.dsh-mcp-tools span { color: var(--dsw-alias-label-secondary); }
.dsh-mcp-form { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1); }
.dsh-mcp-fields { display: flex; flex-direction: column; gap: 10px; }
.dsh-mcp-field { display: flex; flex-direction: column; gap: 4px; }
.dsh-mcp-field > label { font-weight: 600; }
.dsh-mcp-field > small { color: var(--dsw-alias-label-secondary); }
.dsh-mcp-field input[type=text], .dsh-mcp-field input[type=number], .dsh-mcp-field select, .dsh-mcp-field textarea {
  width: 100%; box-sizing: border-box; padding: 5px 8px; border-radius: 6px; font: inherit;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
}
.dsh-mcp-field textarea { min-height: 58px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.dsh-mcp-field input:focus, .dsh-mcp-field select:focus, .dsh-mcp-field textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-mcp-inline { display: flex; align-items: center; gap: 6px; }
.dsh-mcp-footer { color: var(--dsw-alias-label-secondary); font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
.dsh-mcp-footer code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
`;
    //#endregion

    //#region helpers
    /**
     * Page language. `"zh"` keeps every string on this page Chinese regardless of
     * the GUI language; set it to `"auto"` to follow the locale service again.
     */
    const PAGE_LOCALE = "zh";

    /** Look one dotted key up in a dictionary. */
    function lookup(dictionary, key) {
      let value = dictionary;
      for (const part of String(key).split(".")) {
        if (value === undefined || value === null) break;
        value = value[part];
      }
      return typeof value === "string" ? value : undefined;
    }

    /**
     * Build the page translator.
     *
     * The dictionaries are still registered with the locale service, so the
     * strings stay available to anything that reads this namespace, but the page
     * itself renders `PAGE_LOCALE`.
     */
    function makeTranslator(ctx) {
      const dictionaries = { zh, en };
      let bound = null;
      try {
        const locale = ctx.get("locale");
        if (locale !== undefined) {
          ctx.effect(() => locale.register(NS, dictionaries), "dsh-mcp-manager: dictionaries");
          const candidate = locale.bind(NS);
          if (typeof candidate === "function") bound = candidate;
        }
      } catch {
        /* the page still works on the built-in dictionaries */
      }
      return (key) => {
        if (PAGE_LOCALE === "auto" && bound !== null) {
          const localized = bound(key);
          if (typeof localized === "string" && localized !== key) return localized;
        }
        return lookup(zh, key) ?? key;
      };
    }

    /** Interpolate `{name}` placeholders. */
    function fill(text, values) {
      return String(text).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
    }

    /** Split a textarea into trimmed, non-empty lines. */
    function lines(text) {
      return String(text ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    }

    /** Split `KEY=VALUE` lines into a map. */
    function linesToMap(text) {
      const result = {};
      for (const line of lines(text)) {
        const index = line.indexOf("=") >= 0 ? line.indexOf("=") : line.indexOf(":");
        if (index <= 0) continue;
        result[line.slice(0, index).trim()] = line.slice(index + 1).trim();
      }
      return result;
    }

    /** Render a map as `KEY=VALUE` lines. */
    function mapToLines(map) {
      if (map === undefined || map === null) return "";
      return Object.keys(map)
        .map((key) => `${key}=${String(map[key])}`)
        .join("\n");
    }

    /** Empty draft for a new server. */
    function emptyDraft() {
      return {
        name: "",
        transport: "stdio",
        enabled: true,
        command: "",
        argsText: "",
        cwd: "",
        envText: "",
        url: "",
        headersText: "",
        timeout: "60000",
      };
    }

    /** Draft values for editing an existing server definition. */
    function draftFromDefinition(definition) {
      const draft = emptyDraft();
      if (definition === undefined || definition === null) return draft;
      draft.name = String(definition.name ?? "");
      draft.transport = definition.transport === "streamable-http" ? "streamable-http" : "stdio";
      draft.enabled = definition.enabled !== false;
      draft.command = String(definition.command ?? "");
      draft.argsText = Array.isArray(definition.args) ? definition.args.join("\n") : "";
      draft.cwd = String(definition.cwd ?? "");
      draft.envText = mapToLines(definition.env);
      draft.url = String(definition.url ?? "");
      draft.headersText = mapToLines(definition.headers);
      draft.timeout = String(definition.toolCallTimeoutMs ?? 60000);
      return draft;
    }

    /** Build the RPC definition payload from draft values. */
    function definitionFromDraft(draft) {
      const timeout = Number(draft.timeout);
      const base = {
        name: draft.name.trim(),
        enabled: draft.enabled !== false,
        transport: draft.transport,
        toolCallTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.trunc(timeout) : 60000,
      };
      if (draft.transport === "streamable-http") {
        return { ...base, url: draft.url.trim(), headers: linesToMap(draft.headersText) };
      }
      return {
        ...base,
        command: draft.command.trim(),
        args: lines(draft.argsText),
        env: linesToMap(draft.envText),
        cwd: draft.cwd.trim(),
      };
    }

    /** Client-side completeness check so the form can refuse an obviously invalid submit. */
    function draftProblem(draft, t) {
      if (!/^[A-Za-z0-9_-]{1,32}$/.test(draft.name.trim())) return t("field.nameHint");
      if (draft.transport === "streamable-http") {
        if (draft.url.trim() === "") return t("field.url");
        return "";
      }
      if (draft.command.trim() === "") return t("field.command");
      return "";
    }

    /**
     * Map the editor currently on screen to the RPC call that saves it.
     *
     * The editor is `null` when no form is open, and `{ server: null }` while the
     * *add* form is open — only a form opened on an existing card carries a
     * server, so the discriminator is `editing.server`, never `editing` itself.
     * Getting that wrong sends an empty `name` and the host answers
     * `没有名为 "" 的服务器`.
     *
     * @param editing - the section's editor state, or null.
     * @param definition - the definition built from the form.
     * @returns `{ endpoint, payload }` for `add` or `update`.
     */
    function saveAction(editing, definition) {
      const server = editing === null || editing === undefined ? null : editing.server ?? null;
      if (server === null) return { endpoint: "add", payload: { definition } };
      return { endpoint: "update", payload: { name: server.name, definition } };
    }

    /** Status text key for one server row. */
    function statusKey(server) {
      if (server.enabled === false) return "disabled";
      if (server.state === "connected") return "connected";
      if (server.state === "connecting") return "connecting";
      if (server.state === "error") return "error";
      return "idle";
    }
    //#endregion

    //#region components
    /** One labelled form field. */
    function Field(props) {
      return h(
        "div",
        { className: "dsh-mcp-field" },
        h("label", null, props.label),
        props.hint === undefined ? null : h("small", null, props.hint),
        props.children,
      );
    }

    /** Connection state badge. */
    function StateBadge(props) {
      const key = statusKey(props.server);
      return h(
        "span",
        { className: "dsh-mcp-state" },
        h("span", { className: `dsh-mcp-dot ${key}`, "aria-hidden": "true" }),
        props.t(`status.${key}`),
      );
    }

    /** One server card: identity, live state, and its actions. */
    function ServerCard(props) {
      const { server, t, busy, expanded, onToggle, onEdit, onRemove, onRefresh, onToggleDetails } = props;
      const key = statusKey(server);
      return h(
        "div",
        { className: "dsh-mcp-card" },
        h(
          "div",
          { className: "dsh-mcp-card-head" },
          h("span", { className: "dsh-mcp-name" }, server.name),
          h("span", { className: "dsh-mcp-chip" }, server.transport),
          h(StateBadge, { server, t }),
          h("span", { className: "dsh-mcp-chip" }, `${t("tools")} ${String(server.toolCount)}`),
          h("span", { className: "dsh-mcp-spacer" }),
          h(
            "button",
            {
              type: "button",
              className: "dsh-mcp-btn",
              disabled: busy !== "",
              onClick: () => onToggle(server),
            },
            server.enabled === false ? t("start") : t("stop"),
          ),
          h(
            "button",
            {
              type: "button",
              className: "dsh-mcp-btn",
              disabled: busy !== "",
              onClick: () => onEdit(server),
            },
            t("edit"),
          ),
          h(
            "button",
            {
              type: "button",
              className: "dsh-mcp-btn ghost",
              disabled: busy !== "",
              onClick: () => onRefresh(server),
            },
            t("refresh"),
          ),
          h(
            "button",
            {
              type: "button",
              className: "dsh-mcp-btn danger",
              disabled: busy !== "",
              onClick: () => onRemove(server),
            },
            t("remove"),
          ),
        ),
        h("div", { className: "dsh-mcp-target" }, server.target),
        server.error === "" || server.error === undefined ? null : h("div", { className: "dsh-mcp-error" }, server.error),
        server.toolCount === 0
          ? null
          : h(
              "div",
              null,
              h(
                "button",
                { type: "button", className: "dsh-mcp-btn ghost", onClick: () => onToggleDetails(server.name) },
                expanded ? t("hideDetails") : `${t("details")} (${String(server.toolCount)})`,
              ),
            ),
        expanded
          ? h(
              "ul",
              { className: "dsh-mcp-tools" },
              (server.tools ?? []).map((tool) =>
                h(
                  "li",
                  { key: tool.publicName },
                  h("code", null, tool.publicName),
                  h("span", null, tool.description === "" ? tool.rawName : tool.description),
                ),
              ),
            )
          : null,
      );
    }

    /** Add / edit form for one server definition. */
    function ServerForm(props) {
      const { t, original, onCancel, onSubmit, onProbe } = props;
      const [draft, setDraft] = useState(() => draftFromDefinition(original));
      const [problem, setProblem] = useState("");
      const [probe, setProbe] = useState(null);
      const [probing, setProbing] = useState(false);

      const update = useCallback((patch) => {
        setDraft((current) => ({ ...current, ...patch }));
        setProbe(null);
      }, []);

      const input = (key) => ({
        type: "text",
        value: draft[key],
        onChange: (event) => update({ [key]: event.target.value }),
      });

      const submit = useCallback(() => {
        const issue = draftProblem(draft, t);
        if (issue !== "") {
          setProblem(issue);
          return;
        }
        setProblem("");
        onSubmit(definitionFromDraft(draft));
      }, [draft, onSubmit, t]);

      const runProbe = useCallback(() => {
        const issue = draftProblem(draft, t);
        if (issue !== "") {
          setProblem(issue);
          return;
        }
        setProblem("");
        setProbing(true);
        void Promise.resolve(onProbe(definitionFromDraft(draft)))
          .then((result) => setProbe(result))
          .catch((error) => setProbe({ error: String((error && error.message) || error) }))
          .finally(() => setProbing(false));
      }, [draft, onProbe, t]);

      return h(
        "div",
        { className: "dsh-mcp-form" },
        h("div", { className: "dsh-mcp-name" }, original === null ? t("form.addTitle") : fill(t("form.editTitle"), { name: original.name })),
        problem === "" ? null : h("div", { className: "dsh-mcp-banner error" }, problem),
        h(
          Field,
          { label: t("field.name"), hint: t("field.nameHint") },
          h("input", { ...input("name"), type: "text" }),
        ),
        h(
          Field,
          { label: t("field.transport") },
          h(
            "select",
            {
              value: draft.transport,
              onChange: (event) => update({ transport: event.target.value }),
            },
            h("option", { value: "stdio" }, "stdio"),
            h("option", { value: "streamable-http" }, "streamable-http"),
          ),
        ),
        h(
          "label",
          { className: "dsh-mcp-inline" },
          h("input", {
            type: "checkbox",
            checked: draft.enabled,
            onChange: (event) => update({ enabled: event.target.checked }),
          }),
          t("field.enabled"),
        ),
        draft.transport === "stdio"
          ? h(
              "div",
              { className: "dsh-mcp-fields" },
              h(Field, { label: t("field.command") }, h("input", input("command"))),
              h(Field, { label: t("field.args") }, h("textarea", { value: draft.argsText, onChange: (event) => update({ argsText: event.target.value }) })),
              h(Field, { label: t("field.cwd") }, h("input", input("cwd"))),
              h(
                Field,
                { label: t("field.env"), hint: t("field.envHint") },
                h("textarea", { value: draft.envText, onChange: (event) => update({ envText: event.target.value }) }),
              ),
            )
          : h(
              "div",
              { className: "dsh-mcp-fields" },
              h(Field, { label: t("field.url") }, h("input", input("url"))),
              h(
                Field,
                { label: t("field.headers") },
                h("textarea", { value: draft.headersText, onChange: (event) => update({ headersText: event.target.value }) }),
              ),
            ),
        h(
          Field,
          { label: t("field.timeout") },
          h("input", { ...input("timeout"), type: "number", min: "1", step: "1000" }),
        ),
        probe === null
          ? null
          : h(
              "div",
              { className: probe.error === undefined ? "dsh-mcp-banner" : "dsh-mcp-banner error" },
              probe.error === undefined
                ? fill(t("notice.probed"), { count: probe.toolCount })
                : probe.error,
            ),
        h(
          "div",
          { className: "dsh-mcp-bar" },
          h("button", { type: "button", className: "dsh-mcp-btn primary", onClick: submit }, t("save")),
          h(
            "button",
            { type: "button", className: "dsh-mcp-btn", disabled: probing, onClick: runProbe },
            probing ? t("testing") : t("test"),
          ),
          h("button", { type: "button", className: "dsh-mcp-btn ghost", onClick: onCancel }, t("cancel")),
        ),
      );
    }

    /** The settings page itself. */
    function McpServersSection(props) {
      const call = props.call;
      const t = props.t;
      const [snapshot, setSnapshot] = useState(null);
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");
      const [busy, setBusy] = useState("");
      const [editing, setEditing] = useState(null);
      const [expanded, setExpanded] = useState("");
      const reloadTimer = useRef(null);
      const generationRef = useRef(0);

      const load = useCallback(async () => {
        try {
          const next = await call("state", {});
          setSnapshot(next);
          generationRef.current = next.generation;
          setError("");
          return next;
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
          return null;
        }
      }, [call]);

      useEffect(() => {
        void load();
        const timer = setInterval(() => {
          void load();
        }, POLL_MS);
        return () => {
          clearInterval(timer);
          if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
        };
      }, [load]);

      /**
       * Pick up the hot-swapped snapshot after a persisted change.
       *
       * The host has already applied the change to the running generation, so a
       * missing reload is not a failure: this only refreshes the cards (and notes
       * the reload when one actually lands), and it retries quietly while a hot
       * swap has the channel unregistered for a moment.
       */
      const settleAfterSave = useCallback(() => {
        if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
        let tries = 0;
        const tick = () => {
          tries += 1;
          void call("state", {})
            .then((next) => {
              reloadTimer.current = null;
              setSnapshot(next);
              setError("");
              if (next.generation !== generationRef.current) {
                generationRef.current = next.generation;
                setNotice(t("notice.reloaded"));
              }
            })
            .catch(() => {
              if (tries < RELOAD_POLL_TRIES) reloadTimer.current = setTimeout(tick, RELOAD_POLL_MS);
              else reloadTimer.current = null;
            });
        };
        reloadTimer.current = setTimeout(tick, RELOAD_POLL_MS);
      }, [call, t]);

      const mutate = useCallback(
        (endpoint, payload, message) => {
          setBusy(endpoint);
          setError("");
          setNotice("");
          return Promise.resolve()
            .then(() => call(endpoint, payload))
            .then((value) => {
              if (value && value.snapshot) setSnapshot(value.snapshot);
              if (value && typeof value.generation === "number") generationRef.current = value.generation;
              setNotice(message);
              settleAfterSave();
              return value;
            })
            .catch((failure) => {
              setError(String((failure && failure.message) || failure));
            })
            .finally(() => setBusy(""));
        },
        [call, settleAfterSave],
      );

      const onToggle = useCallback(
        (server) => {
          const enabled = server.enabled === false;
          mutate(
            enabled ? "start" : "stop",
            { name: server.name },
            fill(enabled ? t("notice.started") : t("notice.stopped"), { name: server.name }),
          );
        },
        [mutate, t],
      );

      const onRemove = useCallback(
        (server) => {
          if (typeof window !== "undefined" && !window.confirm(fill(t("confirmRemove"), { name: server.name }))) return;
          mutate("remove", { name: server.name }, fill(t("notice.removed"), { name: server.name }));
        },
        [mutate, t],
      );

      const onRefresh = useCallback(
        (server) => {
          setBusy("refresh");
          setError("");
          setNotice("");
          void Promise.resolve()
            .then(() => call("refresh", server === undefined ? {} : { name: server.name }))
            .then((next) => {
              if (next && Array.isArray(next.servers)) setSnapshot(next);
              setNotice(t("notice.refreshed"));
            })
            .catch((failure) => setError(String((failure && failure.message) || failure)))
            .finally(() => setBusy(""));
        },
        [call, t],
      );

      const onSubmitDraft = useCallback(
        (definition) => {
          const action = saveAction(editing, definition);
          mutate(action.endpoint, action.payload, t("notice.saved"));
          setEditing(null);
        },
        [editing, mutate, t],
      );

      const onProbeDraft = useCallback((definition) => call("probe", { definition }), [call]);

      const servers = snapshot === null ? [] : snapshot.servers ?? [];
      const totals = snapshot === null ? { servers: 0, enabled: 0, connected: 0, tools: 0 } : snapshot.totals ?? {};

      return h(
        "div",
        { className: "dsh-mcp" },
        h(
          "div",
          { className: "dsh-mcp-head" },
          h("h2", { className: "dsh-mcp-title" }, t("title")),
          h("p", { className: "dsh-mcp-subtitle" }, t("subtitle")),
        ),
        h(
          "div",
          { className: "dsh-mcp-bar" },
          h(
            "span",
            { className: "dsh-mcp-summary" },
            h("span", null, t("servers"), " ", h("b", null, String(totals.servers ?? 0))),
            h("span", null, t("enabled"), " ", h("b", null, String(totals.enabled ?? 0))),
            h("span", null, t("connected"), " ", h("b", null, String(totals.connected ?? 0))),
            h("span", null, t("tools"), " ", h("b", null, String(totals.tools ?? 0))),
          ),
          h("span", { className: "dsh-mcp-spacer" }),
          h(
            "button",
            {
              type: "button",
              className: "dsh-mcp-btn",
              disabled: busy !== "",
              onClick: () => onRefresh(undefined),
            },
            t("refresh"),
          ),
          h(
            "button",
            {
              type: "button",
              className: "dsh-mcp-btn primary",
              disabled: busy !== "" || editing !== null,
              onClick: () => {
                setNotice("");
                setEditing({ server: null });
              },
            },
            t("add"),
          ),
        ),
        error === "" ? null : h("div", { className: "dsh-mcp-banner error" }, error),
        notice === "" ? null : h("div", { className: "dsh-mcp-banner" }, notice),
        editing === null
          ? null
          : h(ServerForm, {
              t,
              original: editing.server === null ? null : editing.server.definition ?? { name: editing.server.name },
              onCancel: () => setEditing(null),
              onSubmit: onSubmitDraft,
              onProbe: onProbeDraft,
            }),
        servers.length === 0
          ? h(
              "div",
              { className: "dsh-mcp-banner" },
              h("div", null, t("empty")),
              h("div", { className: "dsh-mcp-subtitle" }, t("emptyHint")),
            )
          : servers.map((server) =>
              h(ServerCard, {
                key: server.name,
                server,
                t,
                busy,
                expanded: expanded === server.name,
                onToggle,
                onRemove,
                onRefresh,
                onEdit: (target) => {
                  setNotice("");
                  setEditing({ server: target });
                },
                onToggleDetails: (name) => setExpanded((current) => (current === name ? "" : name)),
              }),
            ),
        snapshot === null
          ? null
          : h(
              "div",
              { className: "dsh-mcp-footer" },
              h("span", null, t("configFile"), ": ", h("code", null, snapshot.patchFile === "" ? t("configMissing") : snapshot.patchFile)),
              h("span", null, t("rowId"), ": ", h("code", null, snapshot.rowId ?? "mcp-manager")),
            ),
      );
    }
    //#endregion

    //#region plugin
    /**
     * Services this browser plugin requires. Slots are declared by the settings
     * shell; this plugin waits for the slot through `slots.inject()`.
     */
    const inject = ["slots", "connection", "locale"];

    /**
     * Register the stylesheet and the `settings.section` page.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        if (typeof document === "undefined") return () => {};
        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => {
          style.remove();
        };
      }, "dsh-mcp-manager: styles");

      const t = makeTranslator(ctx);
      const connection = ctx.get("connection");
      const call = async (endpoint, payload) => {
        if (connection === undefined || connection === null) throw new Error(t("error.noConnection"));
        let result;
        try {
          result = await connection.rpc.call(CHANNEL, endpoint, payload ?? {});
        } catch (failure) {
          throw new Error(`${t("error.transport")}: ${String((failure && failure.message) || failure)}`);
        }
        if (result === undefined || result === null || result.ok !== true) {
          const message = result && result.error ? result.error.message : t("error.unknown");
          throw new Error(message);
        }
        return result.value;
      };

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: "mcp-servers",
            order: 25,
            label: () => t("nav"),
            locale: NS,
            inject: () => ({ call, t }),
          },
          McpServersSection,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    /** Offline authoring surface: `test/check-client.mjs` renders these without a browser. */
    exports.__components = { McpServersSection, ServerCard, ServerForm, StateBadge };
    /** Pure helpers the offline check asserts directly. */
    exports.__helpers = { saveAction, definitionFromDraft, draftFromDefinition, draftProblem, statusKey };
    exports.__dictionaries = { zh, en };
    return module.exports;
  },
});
