/**
 * `dsh-skill-manager` — browser half.
 *
 * Registers one `settings.section` page ("Skills") that lists every local skill
 * discovered under the single managed root, and creates, imports, edits,
 * enables, disables, copies, and deletes those files. It also lists the files
 * that look like skills but cannot be parsed, and can delete them. Every
 * mutation goes through the authenticated `/skill-manager` RPC channel owned by
 * the host half, which writes `SKILL.md` (or `<name>.md`) on disk; the profile's
 * filesystem skill provider picks the change up from its own watcher, so no
 * plugin restart is involved.
 *
 * This file is the package's built `./client` artifact: a lazy-CJS factory that
 * the shell's module loader registers during boot, exactly like the shipped
 * `@deepseek-ai/dsh-client-ui-*` bundles. It requires only baseline modules
 * (`react`), so it declares no `dsh.client.external` requests.
 */
window.__ModuleLoader__.load({
  id: "dsh-skill-manager",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useCallback, useEffect, useRef, useState } = React;
    const h = React.createElement;

    /** RPC channel registered by the host half. */
    const CHANNEL = "/skill-manager";
    /** Locale dictionary namespace owned by this plugin. */
    const NS = "skill-manager";
    /** Injected stylesheet element id. */
    const STYLE_ID = "dsh-skill-manager-style";
    /** Poll cadence for the catalog snapshot, in milliseconds. */
    const POLL_MS = 8000;
    /** How long a persisted-change status notice stays on screen, in milliseconds. */
    const NOTICE_MS = 4500;
    /**
     * Relative timestamps ("4 分钟前") tick on their own, slower cadence: a poll
     * that changed nothing must not re-render the whole catalog every 8 seconds.
     */
    const CLOCK_MS = 60000;
    /** How many opened bodies stay cached before the oldest are dropped. */
    const BODY_CACHE_LIMIT = 32;

    //#region dictionaries
    const zh = {
      nav: "技能",
      title: "技能",
      subtitle:
        "管理本地 SKILL.md 技能：新建、导入、编辑、启停、复制与删除；所有技能都在技能根目录里，保存后模型侧会在下一次目录刷新时看到。",
      versionHint: "插件版本",
      refresh: "刷新",
      create: "新建技能",
      importSkill: "导入",
      empty: "还没有发现本地技能。",
      emptyHint: "新建技能会写入技能根目录（{path}）；模型侧在下一次目录刷新时看到它。",
      emptyFiltered: "没有匹配的技能。",
      skills: "技能",
      modelVisible: "模型可见",
      userInvocable: "用户可调用",
      shadowed: "已遮蔽",
      issues: "异常",
      details: "详情",
      hideDetails: "隐藏详情",
      body: "正文",
      hideBody: "收起正文",
      bodyEmpty: "这个技能没有正文：加载后模型只会看到描述。",
      edit: "编辑",
      remove: "删除",
      copy: "复制",
      start: "启用",
      stop: "停用",
      save: "保存",
      cancel: "取消",
      check: "校验",
      checking: "校验中…",
      loading: "加载中…",
      rootPath: "技能根目录",
      workspace: "工作区",
      unrecognized: "{count} 个文件无法被识别（模型看不到它们）",
      legacyHost: "宿主仍在运行旧版技能管理器（v{version}）：本页已按技能根目录过滤并去重，重启 dsh web（或桌面应用）后完全生效。",
      showIssues: "查看",
      hideIssues: "收起",
      discard: "删除",
      searchPlaceholder: "筛选名称、描述或路径",
      confirmRemoveBundle: "删除技能 “{name}”？会删除整个目录 {path}，包括其中的资源文件，且无法撤销。",
      confirmRemoveFile: "删除技能 “{name}”？会删除文件 {path}，且无法撤销。",
      confirmDiscard: "删除这个无法识别的条目？会删除 {path}，且无法撤销。",
      chip: {
        shadowed: "已遮蔽",
        warning: "注意",
        modelOff: "模型不可见",
        userOff: "用户不可调",
        bundle: "目录",
        file: "单文件",
      },
      time: {
        secondsAgo: "{n} 秒前",
        minutesAgo: "{n} 分钟前",
        hoursAgo: "{n} 小时前",
        daysAgo: "{n} 天前",
      },
      status: {
        active: "生效",
        shadowed: "被遮蔽",
      },
      meta: {
        invocation: "调用策略",
        layout: "布局",
        path: "位置",
        directory: "目录",
        size: "正文大小",
        updated: "更新时间",
        metadata: "元数据",
        warnings: "警告",
        shadowedBy: "被以下文件遮蔽",
      },
      invocation: {
        both: "模型可见 · 用户可调用",
        modelOnly: "模型可见 · 用户不可调用",
        userOnly: "模型不可见 · 用户可调用",
        none: "模型不可见 · 用户不可调用",
      },
      filter: {
        all: "全部",
        shadowed: "已遮蔽",
        disabled: "已停用模型",
        warned: "有警告",
      },
      field: {
        name: "名称",
        nameHint: "小写字母、数字与单个连字符（kebab-case），例如 code-review。",
        description: "描述（决定模型是否加载它）",
        descriptionHint: "一句话说明这个技能做什么；它会进入模型可见的技能目录。",
        whenToUse: "使用时机（可选）",
        whenToUseHint: "补充说明什么时候该加载它。",
        layout: "磁盘布局",
        layoutHint: "目录布局为 <名称>/SKILL.md，可携带资源文件；单文件布局为 <名称>.md。",
        modelInvocable: "模型可见",
        modelInvocableHint: "关闭后模型目录与 skill 工具都不再列出它（frontmatter: disable-model-invocation）。",
        userInvocable: "用户可调用",
        userInvocableHint: "关闭后命令面板不再列出它（frontmatter: user-invocable）。",
        body: "正文（Markdown）",
        bodyHint: "frontmatter 之后的指令文本；保存时会自动加回 frontmatter。",
        copyName: "副本名称",
        copyNameHint: "新技能的名称；默认加 -copy 后缀。",
      },
      form: {
        addTitle: "新建技能",
        editTitle: "编辑技能 {name}",
        copyTitle: "复制技能 {name} 为可编辑副本",
        copyNote: "复制只带上 frontmatter 与正文；目录里的资源文件不会一起复制。",
        rootNote: "写入技能根目录：{path}",
        invalid: "请先补全必填项。",
        bundle: "目录（<名称>/SKILL.md）",
        file: "单文件（<名称>.md）",
        importTitle: "导入 SKILL.md",
        importNote: "粘贴完整的 SKILL.md（frontmatter 与正文）：先按磁盘文件的规则解析，通过后才写入技能根目录，未知 frontmatter 键原样保留。",
        importText: "SKILL.md 内容",
        importTextHint: "第一行必须是单独一行 ---，之后是 frontmatter，再以单独一行 --- 结束，正文写在后面。",
        importName: "技能名称（可选）",
        importNameHint: "留空则使用 frontmatter 里的 name；填写则按新名称保存并改写 frontmatter。",
        importEmpty: "请先粘贴 SKILL.md 内容。",
      },
      validate: {
        ok: "定义有效。",
        warnings: "定义有效，但有 {count} 条提醒。",
        target: "将写入 {path}",
        preview: "预览",
        issues: "定义无效。",
      },
      notice: {
        created: "已创建技能 {name}。",
        saved: "已保存技能 {name}。",
        removed: "已删除技能 {name}。",
        copied: "已复制为 {name}。",
        started: "已启用 {name}。",
        stopped: "已停用 {name}。",
        refreshed: "已重新扫描技能目录。",
        imported: "已导入技能 {name}。",
        discarded: "已删除异常条目 {name}。",
      },
      error: {
        noConnection: "浏览器连接服务不可用。",
        transport: "无法访问宿主插件（可能尚未挂载或正在热重载）",
        unknown: "宿主返回了无法识别的失败。",
        bodyLoad: "无法读取正文",
      },
    };

    const en = {
      nav: "Skills",
      title: "Skills",
      subtitle:
        "Manage local SKILL.md skills: create, import, edit, enable, disable, copy, and delete them; every skill lives in the skill root, and the model side sees a save on its next catalog refresh.",
      versionHint: "Plugin version",
      refresh: "Refresh",
      create: "New skill",
      importSkill: "Import",
      empty: "No local skill has been discovered yet.",
      emptyHint: "A new skill is written to the skill root ({path}); the model side sees it on the next catalog refresh.",
      emptyFiltered: "No matching skill.",
      skills: "Skills",
      modelVisible: "Model-visible",
      userInvocable: "User-invocable",
      shadowed: "Shadowed",
      issues: "Issues",
      details: "Details",
      hideDetails: "Hide details",
      body: "Body",
      hideBody: "Hide body",
      bodyEmpty: "This skill has no body: the model only sees the description.",
      edit: "Edit",
      remove: "Remove",
      copy: "Copy",
      start: "Enable",
      stop: "Disable",
      save: "Save",
      cancel: "Cancel",
      check: "Validate",
      checking: "Validating…",
      loading: "Loading…",
      rootPath: "Skill root",
      workspace: "Workspace",
      unrecognized: "{count} file(s) cannot be recognized (the model cannot see them)",
      legacyHost: "The host is still running an older skill manager (v{version}); this page already filters to the skill root and de-duplicates, and restarting dsh web (or the desktop app) makes it fully effective.",
      showIssues: "Show",
      hideIssues: "Hide",
      discard: "Delete",
      searchPlaceholder: "Filter by name, description, or path",
      confirmRemoveBundle: "Remove skill “{name}”? The whole directory {path} is deleted, including its resource files; this cannot be undone.",
      confirmRemoveFile: "Remove skill “{name}”? The file {path} is deleted; this cannot be undone.",
      confirmDiscard: "Delete this unreadable entry? {path} is deleted; this cannot be undone.",
      chip: {
        shadowed: "Shadowed",
        warning: "Warning",
        modelOff: "Model-hidden",
        userOff: "User-hidden",
        bundle: "Directory",
        file: "Single file",
      },
      time: {
        secondsAgo: "{n}s ago",
        minutesAgo: "{n}m ago",
        hoursAgo: "{n}h ago",
        daysAgo: "{n}d ago",
      },
      status: {
        active: "Active",
        shadowed: "Shadowed",
      },
      meta: {
        invocation: "Invocation",
        layout: "Layout",
        path: "Path",
        directory: "Directory",
        size: "Body size",
        updated: "Updated",
        metadata: "Metadata",
        warnings: "Warnings",
        shadowedBy: "Shadowed by",
      },
      invocation: {
        both: "model-visible · user-invocable",
        modelOnly: "model-visible · user-hidden",
        userOnly: "model-hidden · user-invocable",
        none: "model-hidden · user-hidden",
      },
      filter: {
        all: "All",
        shadowed: "Shadowed",
        disabled: "Model-hidden",
        warned: "Warned",
      },
      field: {
        name: "Name",
        nameHint: "Lowercase letters, digits, and single hyphens (kebab-case), e.g. code-review.",
        description: "Description (decides whether the model loads it)",
        descriptionHint: "One sentence about what the skill does; it enters the model-facing catalog.",
        whenToUse: "When to use (optional)",
        whenToUseHint: "Extra guidance about when the skill applies.",
        layout: "On-disk layout",
        layoutHint: "A directory layout is <name>/SKILL.md and can carry resources; a single-file layout is <name>.md.",
        modelInvocable: "Model-visible",
        modelInvocableHint: "When off, the model catalog and the skill tool stop listing it (frontmatter: disable-model-invocation).",
        userInvocable: "User-invocable",
        userInvocableHint: "When off, the command palette stops listing it (frontmatter: user-invocable).",
        body: "Body (Markdown)",
        bodyHint: "Instruction text after the frontmatter; the frontmatter is added back on save.",
        copyName: "Copy name",
        copyNameHint: "Name of the new skill; it defaults to a -copy suffix.",
      },
      form: {
        addTitle: "New skill",
        editTitle: "Edit skill {name}",
        copyTitle: "Copy skill {name} as an editable copy",
        copyNote: "A copy carries the frontmatter and body only; resource files in the directory are not copied.",
        rootNote: "Written to the skill root: {path}",
        invalid: "Complete the required fields first.",
        bundle: "Directory (<name>/SKILL.md)",
        file: "Single file (<name>.md)",
        importTitle: "Import a SKILL.md",
        importNote:
          "Paste a complete SKILL.md (frontmatter and body): it is parsed with the same rules as a file on disk, written only after it validates, and unknown frontmatter keys are preserved.",
        importText: "SKILL.md content",
        importTextHint: "The first line must be exactly ---, then the frontmatter, then a closing ---; the body follows.",
        importName: "Skill name (optional)",
        importNameHint: "Leave it empty to use the frontmatter name; fill it in to save under a new name and rewrite the frontmatter.",
        importEmpty: "Paste the SKILL.md content first.",
      },
      validate: {
        ok: "The definition is valid.",
        warnings: "The definition is valid with {count} warning(s).",
        target: "Will be written to {path}",
        preview: "Preview",
        issues: "The definition is invalid.",
      },
      notice: {
        created: "Created skill {name}.",
        saved: "Saved skill {name}.",
        removed: "Removed skill {name}.",
        copied: "Copied as {name}.",
        started: "{name} enabled.",
        stopped: "{name} disabled.",
        refreshed: "The skill root was re-scanned.",
        imported: "Imported skill {name}.",
        discarded: "Deleted the unreadable entry {name}.",
      },
      error: {
        noConnection: "The browser connection service is unavailable.",
        transport: "Cannot reach the host plugin (not mounted yet, or hot-reloading)",
        unknown: "The host returned an unrecognisable failure.",
        bodyLoad: "Cannot read the body",
      },
    };
    //#endregion

    //#region styles
    const CSS = `
.dsh-skm { display: flex; flex-direction: column; gap: 14px; max-width: 860px; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dsh-skm-head { display: flex; flex-direction: column; gap: 6px; }
.dsh-skm-title-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.dsh-skm-title { margin: 0; font-size: 15px; font-weight: 600; }
.dsh-skm-version { padding: 0 6px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; letter-spacing: .02em; }
.dsh-skm-subtitle { margin: 0; color: var(--dsw-alias-label-secondary); }
.dsh-skm-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-skm-summary { display: flex; gap: 12px; flex-wrap: wrap; color: var(--dsw-alias-label-secondary); }
.dsh-skm-summary b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.dsh-skm-summary-warn { color: var(--dsw-alias-state-warn-primary); }
.dsh-skm-summary-warn b { color: var(--dsw-alias-state-warn-primary); }
.dsh-skm-spacer { flex: 1 1 auto; }
.dsh-skm-btn { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; cursor: pointer; }
.dsh-skm-btn:hover { border-color: var(--dsw-alias-brand-primary); }
.dsh-skm-btn:disabled { opacity: .5; cursor: default; }
.dsh-skm-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-weight: 600; }
.dsh-skm-btn.danger { color: var(--dsw-alias-state-error-primary); }
.dsh-skm-btn.ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary); }
.dsh-skm-btn.ghost:hover { color: var(--dsw-alias-label-primary); }
.dsh-skm-banner { padding: 8px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); }
.dsh-skm-banner.error { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
.dsh-skm-banner.warn { border-color: var(--dsw-alias-state-warn-primary); }
.dsh-skm-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.dsh-skm-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-skm-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex: 0 0 auto; }
.dsh-skm-name { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 600; font-size: 13px; }
.dsh-skm-chip { padding: 1px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; }
.dsh-skm-chip.warn { color: var(--dsw-alias-state-warn-primary); border-color: currentColor; }
.dsh-skm-desc { color: var(--dsw-alias-label-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.dsh-skm-line { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-skm-note { color: var(--dsw-alias-state-warn-primary); font-size: 12px; overflow-wrap: anywhere; }
.dsh-skm-toolbar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.dsh-skm-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 6px 16px; }
.dsh-skm-meta-item { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.dsh-skm-meta-item > label { color: var(--dsw-alias-label-secondary); font-size: 11px; }
.dsh-skm-meta-item > span, .dsh-skm-meta-item > code { overflow-wrap: anywhere; }
.dsh-skm-meta-item > code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.dsh-skm-body { margin: 0; padding: 10px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto; }
.dsh-skm-body-empty { color: var(--dsw-alias-label-secondary); }
.dsh-skm-form { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1); }
.dsh-skm-fields { display: flex; flex-direction: column; gap: 10px; }
.dsh-skm-field { display: flex; flex-direction: column; gap: 4px; }
.dsh-skm-field > label { font-weight: 600; }
.dsh-skm-field > small { color: var(--dsw-alias-label-secondary); }
.dsh-skm-field input[type=text], .dsh-skm-field select, .dsh-skm-field textarea {
  width: 100%; box-sizing: border-box; padding: 5px 8px; border-radius: 6px; font: inherit;
  border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary);
}
.dsh-skm-field textarea { min-height: 58px; resize: vertical; }
.dsh-skm-field textarea.body { min-height: 220px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.dsh-skm-field input:focus, .dsh-skm-field select:focus, .dsh-skm-field textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-skm-inline { display: flex; align-items: center; gap: 6px; }
.dsh-skm-search { flex: 0 1 260px; min-width: 160px; box-sizing: border-box; padding: 5px 8px; border-radius: 6px; font: inherit; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-skm-search:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-skm-filter { flex: 0 0 auto; box-sizing: border-box; padding: 5px 8px; border-radius: 6px; font: inherit; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-skm-filter:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-skm-issues { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-bg-layer-1); }
.dsh-skm-issue-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow: auto; }
.dsh-skm-issue-list li { overflow-wrap: anywhere; }
.dsh-skm-issue-row { display: flex; align-items: flex-start; gap: 8px; }
.dsh-skm-issue-text { flex: 1 1 auto; min-width: 0; }
.dsh-skm-issue-row .dsh-skm-btn { flex: 0 0 auto; }
.dsh-skm-issue-list code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
.dsh-skm-validate { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.dsh-skm-preview { margin: 0; padding: 8px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.45; max-height: 180px; overflow: auto; white-space: pre-wrap; }
.dsh-skm-footer { color: var(--dsw-alias-label-secondary); font-size: 12px; display: flex; flex-direction: column; gap: 2px; }
.dsh-skm-footer code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
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
          ctx.effect(() => locale.register(NS, dictionaries), "dsh-skill-manager: dictionaries");
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

    /**
     * Relative "how long ago" text for a timestamp.
     * @param t - translator.
     * @param from - epoch milliseconds; `0`/absent yields an empty string.
     * @param now - the page's current clock.
     * @returns the relative time, or `""` when there is nothing to show.
     */
    function formatAgo(t, from, now) {
      const then = Number(from);
      if (!Number.isFinite(then) || then <= 0) return "";
      const seconds = Math.max(0, Math.round((Number(now) - then) / 1000));
      if (seconds < 60) return fill(t("time.secondsAgo"), { n: seconds });
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return fill(t("time.minutesAgo"), { n: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return fill(t("time.hoursAgo"), { n: hours });
      return fill(t("time.daysAgo"), { n: Math.floor(hours / 24) });
    }

    /**
     * Short, locale-neutral byte size: `0 B`, `812 B`, `12.4 KB`.
     * @param value - byte count.
     * @returns the formatted size.
     */
    function formatBytes(value) {
      const bytes = Number(value);
      if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
      if (bytes < 1024) return `${String(Math.round(bytes))} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    /**
     * The single managed skill root, from whichever snapshot field is present.
     * @param snapshot - catalog snapshot (new or older host shape).
     * @returns the absolute root path, or `""`.
     */
    function skillRootOf(snapshot) {
      if (snapshot === null || snapshot === undefined) return "";
      if (typeof snapshot.skillRoot === "string" && snapshot.skillRoot !== "") return snapshot.skillRoot;
      const roots = Array.isArray(snapshot.roots) ? snapshot.roots : [];
      const userRoot = roots.find((root) => root.id === "user-dsh");
      if (userRoot !== undefined) return String(userRoot.path ?? "");
      return roots.length > 0 ? String(roots[0].path ?? "") : "";
    }

    /**
     * Normalize one filesystem path for on-screen identity checks.
     *
     * Windows paths compare case-insensitively with forward slashes; other
     * paths keep their case so a case-sensitive filesystem is never collapsed.
     * @param path - path as reported by the host.
     * @returns the comparison key.
     */
    function pathKey(path) {
      const text = String(path ?? "").replace(/\\/g, "/");
      return /^[A-Za-z]:\//.test(text) ? text.toLowerCase() : text;
    }

    /**
     * Whether the page is currently in a hidden tab.
     *
     * A hidden settings page has nobody reading it, so its poll would cost a
     * full directory scan on the host for no visible benefit. The timer keeps
     * running and skips the request; becoming visible loads immediately.
     * @returns true when `document` reports a hidden page.
     */
    function isPageHidden() {
      return typeof document !== "undefined" && document.visibilityState === "hidden";
    }

    /**
     * A cheap identity for "the catalog the user is looking at".
     *
     * The page polls every eight seconds; replacing the snapshot state with an
     * equal-but-new object re-renders every card. This FNV-1a digest covers the
     * fields a card renders, so an unchanged catalog leaves React alone while a
     * real edit (including an external one, which bumps `updatedAt`) still lands.
     * @param snapshot - catalog snapshot from any host version.
     * @returns a short signature string; equal signatures mean "nothing to redraw".
     */
    function snapshotSignature(snapshot) {
      if (snapshot === null || snapshot === undefined) return "";
      let hash = 2166136261;
      const mix = (value) => {
        const text = String(value ?? "");
        for (let index = 0; index < text.length; index += 1) {
          hash ^= text.charCodeAt(index);
          hash = Math.imul(hash, 16777619);
        }
        hash ^= 10;
        hash = Math.imul(hash, 16777619);
      };
      const skills = Array.isArray(snapshot.skills) ? snapshot.skills : [];
      const issues = Array.isArray(snapshot.issues) ? snapshot.issues : [];
      mix(snapshot.generation);
      mix(snapshot.version);
      mix(skillRootOf(snapshot));
      mix(snapshot.channel === undefined || snapshot.channel === null ? "" : snapshot.channel.state);
      mix(skills.length);
      mix(issues.length);
      for (const skill of skills) {
        mix(skill.path);
        mix(skill.name);
        mix(skill.status);
        mix(skill.updatedAt);
        mix(skill.description);
        mix(skill.whenToUse);
        mix(skill.invocation === undefined || skill.invocation === null ? "" : `${skill.invocation.modelInvocable}${skill.invocation.userInvocable}`);
        mix(Array.isArray(skill.warnings) ? skill.warnings.length : 0);
      }
      for (const issue of issues) {
        mix(issue.path);
        mix(issue.message);
      }
      return `${skills.length}:${issues.length}:${hash >>> 0}`;
    }

    /**
     * Insert one cached body and keep the cache bounded.
     *
     * Only opened cards are cached, but a long session over a large catalog would
     * still grow without limit; the oldest entries are dropped, never the one the
     * caller is inserting.
     * @param cache - current `path -> body entry` map.
     * @param path - the skill path being stored.
     * @param entry - body state for that path.
     * @returns the next cache.
     */
    function withBodyEntry(cache, path, entry) {
      const next = { ...cache, [path]: entry };
      const keys = Object.keys(next);
      for (const key of keys.slice(0, Math.max(0, keys.length - BODY_CACHE_LIMIT))) {
        if (key !== path) delete next[key];
      }
      return next;
    }

    /**
     * The rows this page should render.
     *
     * The current host already enforces both invariants, but the page can be
     * running against an older host that scanned several roots: a project root
     * can coincide with the skill root, so the same file arrives twice, and the
     * second copy is `shadowed` by a winner whose path is its own. Filtering to
     * the managed root and de-duplicating by path keeps the page truthful until
     * the host is restarted.
     * @param snapshot - catalog snapshot from any host version.
     * @returns rows under the skill root, one per file, in host order.
     */
    function visibleSkills(snapshot) {
      if (snapshot === null || snapshot === undefined) return [];
      const rows = Array.isArray(snapshot.skills) ? snapshot.skills : [];
      const root = pathKey(skillRootOf(snapshot));
      const seen = new Set();
      const result = [];
      for (const skill of rows) {
        const key = pathKey(skill.path);
        if (key === "") continue;
        if (root !== "" && key !== root && !key.startsWith(root.endsWith("/") ? root : `${root}/`)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        if (skill.status === "shadowed" && pathKey(skill.shadowedBy) === key) continue;
        result.push(skill);
      }
      return result;
    }

    /**
     * Stable remount key for the open editor.
     *
     * The form seeds its draft from `initial` once, so switching from one
     * editor target to another must remount it; otherwise the fields would show
     * the previous skill while saving targets the new one.
     * @param editor - `{ mode, skill }`, or null.
     * @returns a key unique to the current editor target.
     */
    function editorKey(editor) {
      if (editor === null || editor === undefined) return "none";
      const path = editor.skill === null || editor.skill === undefined ? "" : String(editor.skill.path ?? "");
      return `${editor.mode}:${path}`;
    }

    /**
     * One-line invocation summary for a skill row.
     * @param t - translator.
     * @param invocation - `{ modelInvocable, userInvocable }`.
     * @returns the summary text.
     */
    function invocationLabel(t, invocation) {
      const model = invocation !== undefined && invocation !== null && invocation.modelInvocable !== false;
      const user = invocation !== undefined && invocation !== null && invocation.userInvocable !== false;
      if (model && user) return t("invocation.both");
      if (model) return t("invocation.modelOnly");
      if (user) return t("invocation.userOnly");
      return t("invocation.none");
    }

    /**
     * Case-insensitive filter over the name, description, whenToUse, source, and path.
     * @param skills - snapshot skill rows.
     * @param query - what the user typed.
     * @param filter - `all`, `shadowed`, `disabled`, or `warned`.
     * @returns the matching rows (everything for an empty query).
     */
    function filterSkills(skills, query, filter) {
      const list = Array.isArray(skills) ? skills : [];
      const needle = String(query ?? "")
        .trim()
        .toLowerCase();
      return list.filter((skill) => {
        if (filter === "shadowed" && skill.status !== "shadowed") return false;
        if (filter === "disabled" && (skill.status !== "active" || (skill.invocation !== undefined && skill.invocation.modelInvocable !== false))) {
          return false;
        }
        if (filter === "warned" && !(Array.isArray(skill.warnings) && skill.warnings.length > 0)) return false;
        if (needle === "") return true;
        return [skill.name, skill.description, skill.whenToUse, skill.path].some((value) =>
          String(value ?? "")
            .toLowerCase()
            .includes(needle),
        );
      });
    }

    /** Empty draft for a new skill. */
    function emptyDraft() {
      return {
        name: "",
        description: "",
        whenToUse: "",
        layout: "bundle",
        modelInvocable: true,
        userInvocable: true,
        body: "",
      };
    }

    /**
     * Empty draft for an import.
     * @returns `{ text, name, layout }` for {@link ImportForm}.
     */
    function emptyImportDraft() {
      return { text: "", name: "", layout: "bundle" };
    }

    /**
     * Draft values for editing, copying, or previewing one skill row.
     * @param skill - snapshot row.
     * @param detail - `get` payload with `body`, when it has been loaded.
     * @param mode - `edit` or `copy`.
     * @returns the form draft.
     */
    function draftFromSkill(skill, detail, mode) {
      const row = skill === null || skill === undefined ? {} : skill;
      const invocation = row.invocation === undefined || row.invocation === null ? {} : row.invocation;
      const detailBody = detail === undefined || detail === null ? "" : String(detail.body ?? "");
      const name = String(row.name ?? "");
      return {
        name: mode === "copy" ? `${name}-copy` : name,
        description: String(row.description ?? ""),
        whenToUse: String(row.whenToUse ?? ""),
        layout: row.layout === "file" ? "file" : "bundle",
        modelInvocable: invocation.modelInvocable !== false,
        userInvocable: invocation.userInvocable !== false,
        body: detailBody,
      };
    }

    /** Build the RPC definition payload from draft values. */
    function definitionFromDraft(draft) {
      return {
        name: String(draft.name ?? "").trim(),
        description: String(draft.description ?? "").trim(),
        whenToUse: String(draft.whenToUse ?? "").trim(),
        layout: draft.layout === "file" ? "file" : "bundle",
        modelInvocable: draft.modelInvocable !== false,
        userInvocable: draft.userInvocable !== false,
        body: String(draft.body ?? ""),
      };
    }

    /** Client-side completeness check so the form can refuse an obviously invalid submit. */
    function draftProblem(draft, t) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(draft.name ?? "").trim())) return t("field.nameHint");
      if (String(draft.description ?? "").trim() === "") return t("field.descriptionHint");
      return "";
    }

    /**
     * Map the editor currently on screen to the RPC call that saves it.
     * @param editor - `{ mode, skill }`, where `skill` is null for a create.
     * @param definition - the definition built from the form.
     * @returns `{ endpoint, payload }`.
     */
    function saveAction(editor, definition) {
      const mode = editor === null || editor === undefined ? "create" : editor.mode;
      const skill = editor === null || editor === undefined ? null : editor.skill ?? null;
      if (mode === "edit" && skill !== null) return { endpoint: "update", payload: { path: skill.path, definition } };
      if (mode === "copy" && skill !== null) return { endpoint: "copy", payload: { path: skill.path, definition } };
      return { endpoint: "create", payload: { definition } };
    }

    /**
     * Confirm text for deleting one skill, which depends on the layout.
     * @param t - translator.
     * @param skill - snapshot row.
     * @returns the confirmation message.
     */
    function removePrompt(t, skill) {
      const name = String(skill.name ?? "");
      if (skill.layout === "file") return fill(t("confirmRemoveFile"), { name, path: String(skill.path ?? "") });
      const directory = String(skill.directory ?? "");
      return fill(t("confirmRemoveBundle"), { name, path: directory });
    }
    //#endregion

    //#region components
    /** One labelled form field. */
    function Field(props) {
      return h(
        "div",
        { className: "dsh-skm-field" },
        h("label", null, props.label),
        props.hint === undefined ? null : h("small", null, props.hint),
        props.children,
      );
    }

    /**
     * One skill card.
     *
     * Progressive disclosure: the default card is the identity line, the
     * description, and the on-disk path, so a long catalog stays scannable.
     * `详情` reveals the policy/location grid and `正文` reveals the instruction
     * body — each independently, and both remembered by the section so a status
     * poll does not collapse them.
     */
    function SkillCard(props) {
      const { skill, t, busy, locked, now, detailsOpen, bodyOpen, body, onToggleEnabled, onEdit, onRemove, onCopy, onToggleDetails, onToggleBody } =
        props;
      const invocation = skill.invocation === undefined || skill.invocation === null ? {} : skill.invocation;
      const warnings = Array.isArray(skill.warnings) ? skill.warnings : [];
      const bodyText = body === undefined || body === null ? "" : String(body.text ?? "");
      const bodyError = body === undefined || body === null ? "" : String(body.error ?? "");
      const bodyLoading = body !== undefined && body !== null && body.loading === true;
      const metaItem = (labelKey, value) => h("span", { className: "dsh-skm-meta-item" }, h("label", null, t(labelKey)), value);
      const clock = typeof now === "number" ? now : Date.now();
      return h(
        "div",
        { className: "dsh-skm-card" },
        h(
          "div",
          { className: "dsh-skm-card-head" },
          h("code", { className: "dsh-skm-name" }, skill.name),
          skill.status === "shadowed" ? h("span", { className: "dsh-skm-chip warn" }, t("chip.shadowed")) : null,
          warnings.length > 0 ? h("span", { className: "dsh-skm-chip warn" }, t("chip.warning")) : null,
          invocation.modelInvocable === false ? h("span", { className: "dsh-skm-chip" }, t("chip.modelOff")) : null,
          invocation.userInvocable === false ? h("span", { className: "dsh-skm-chip" }, t("chip.userOff")) : null,
          h(
            "span",
            { className: "dsh-skm-actions" },
            h(
              "button",
              {
                type: "button",
                className: "dsh-skm-btn",
                disabled: busy !== "" || locked === true,
                onClick: () => onToggleEnabled(skill),
              },
              invocation.modelInvocable === false && invocation.userInvocable === false ? t("start") : t("stop"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "dsh-skm-btn",
                disabled: busy !== "" || locked === true,
                onClick: () => onEdit(skill),
              },
              t("edit"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "dsh-skm-btn ghost",
                disabled: busy !== "" || locked === true,
                onClick: () => onCopy(skill),
              },
              t("copy"),
            ),
            h(
              "button",
              {
                type: "button",
                className: "dsh-skm-btn danger",
                disabled: busy !== "" || locked === true,
                onClick: () => onRemove(skill),
              },
              t("remove"),
            ),
          ),
        ),
        h("div", { className: "dsh-skm-desc", title: skill.description }, skill.description),
        h("div", { className: "dsh-skm-line", title: skill.path }, skill.path),
        skill.status === "shadowed"
          ? h(
              "div",
              { className: "dsh-skm-note" },
              `${t("meta.shadowedBy")}: `,
              h("code", null, String(skill.shadowedBy ?? "")),
            )
          : null,
        h(
          "div",
          { className: "dsh-skm-toolbar" },
          h(
            "button",
            {
              type: "button",
              className: "dsh-skm-btn ghost",
              "aria-expanded": detailsOpen === true,
              onClick: () => onToggleDetails(skill),
            },
            detailsOpen ? t("hideDetails") : t("details"),
          ),
          h(
            "button",
            {
              type: "button",
              className: "dsh-skm-btn ghost",
              "aria-expanded": bodyOpen === true,
              onClick: () => onToggleBody(skill),
            },
            bodyOpen ? t("hideBody") : t("body"),
          ),
        ),
        detailsOpen
          ? h(
              "div",
              { className: "dsh-skm-meta" },
              metaItem("meta.invocation", h("span", null, invocationLabel(t, invocation))),
              metaItem("meta.layout", h("span", null, skill.layout === "file" ? t("chip.file") : t("chip.bundle"))),
              metaItem("meta.path", h("code", null, String(skill.path ?? ""))),
              metaItem("meta.directory", h("code", null, String(skill.directory ?? ""))),
              metaItem("meta.size", h("span", null, formatBytes(skill.bodyBytes))),
              metaItem("meta.updated", h("span", null, formatAgo(t, skill.updatedAt, clock))),
              skill.metadata === undefined || skill.metadata === null
                ? null
                : metaItem("meta.metadata", h("code", null, JSON.stringify(skill.metadata))),
              warnings.length === 0 ? null : metaItem("meta.warnings", h("span", null, warnings.join("；"))),
            )
          : null,
        bodyOpen
          ? h(
              "div",
              null,
              bodyLoading
                ? h("div", { className: "dsh-skm-line" }, t("loading"))
                : bodyError !== ""
                  ? h("div", { className: "dsh-skm-banner error" }, bodyError)
                  : bodyText === ""
                    ? h("div", { className: "dsh-skm-banner dsh-skm-body-empty" }, t("bodyEmpty"))
                    : h("pre", { className: "dsh-skm-body" }, bodyText),
            )
          : null,
      );
    }

    /**
     * Create / edit / copy form for one skill.
     *
     * The form owns its draft and validation notices; the section owns the RPC
     * call and the catalog. `mode` decides whether the layout select is
     * editable — moving a skill between layouts is a copy, not an edit.
     */
    function SkillForm(props) {
      const { t, mode, original, rootPath, initial, onCancel, onSubmit, onValidate } = props;
      const [draft, setDraft] = useState(() => initial);
      const [problem, setProblem] = useState("");
      const [validation, setValidation] = useState(null);
      const [validating, setValidating] = useState(false);
      const editableLayout = mode === "create";

      const update = useCallback((patch) => {
        setDraft((current) => ({ ...current, ...patch }));
        setValidation(null);
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

      const runValidate = useCallback(() => {
        const issue = draftProblem(draft, t);
        if (issue !== "") {
          setProblem(issue);
          return;
        }
        setProblem("");
        setValidating(true);
        void Promise.resolve(onValidate(definitionFromDraft(draft)))
          .then((result) => setValidation(result))
          .catch((error) => setValidation({ valid: false, issues: [String((error && error.message) || error)], warnings: [] }))
          .finally(() => setValidating(false));
      }, [draft, onValidate, t]);

      const title =
        mode === "create"
          ? t("form.addTitle")
          : mode === "copy"
            ? fill(t("form.copyTitle"), { name: original === null ? "" : original.name })
            : fill(t("form.editTitle"), { name: original === null ? "" : original.name });

      return h(
        "div",
        { className: "dsh-skm-form" },
        h("div", { className: "dsh-skm-title" }, title),
        mode === "copy" ? h("div", { className: "dsh-skm-subtitle" }, t("form.copyNote")) : null,
        h("div", { className: "dsh-skm-subtitle" }, fill(t("form.rootNote"), { path: rootPath === "" ? "—" : rootPath })),
        problem === "" ? null : h("div", { className: "dsh-skm-banner error" }, problem),
        h(
          Field,
          { label: t("field.name"), hint: t("field.nameHint") },
          h("input", { ...input("name"), type: "text" }),
        ),
        h(
          Field,
          { label: t("field.description"), hint: t("field.descriptionHint") },
          h("textarea", { value: draft.description, onChange: (event) => update({ description: event.target.value }) }),
        ),
        h(
          Field,
          { label: t("field.whenToUse"), hint: t("field.whenToUseHint") },
          h("input", input("whenToUse")),
        ),
        h(
          Field,
          { label: t("field.layout"), hint: editableLayout ? t("field.layoutHint") : undefined },
          h(
            "select",
            {
              value: draft.layout,
              disabled: !editableLayout,
              onChange: (event) => update({ layout: event.target.value }),
            },
            h("option", { value: "bundle" }, t("form.bundle")),
            h("option", { value: "file" }, t("form.file")),
          ),
        ),
        h(
          Field,
          { label: t("field.modelInvocable"), hint: t("field.modelInvocableHint") },
          h("input", {
            type: "checkbox",
            checked: draft.modelInvocable !== false,
            onChange: (event) => update({ modelInvocable: event.target.checked }),
          }),
        ),
        h(
          Field,
          { label: t("field.userInvocable"), hint: t("field.userInvocableHint") },
          h("input", {
            type: "checkbox",
            checked: draft.userInvocable !== false,
            onChange: (event) => update({ userInvocable: event.target.checked }),
          }),
        ),
        h(
          Field,
          { label: t("field.body"), hint: t("field.bodyHint") },
          h("textarea", {
            className: "body",
            value: draft.body,
            onChange: (event) => update({ body: event.target.value }),
          }),
        ),
        validation === null
          ? null
          : h(
              "div",
              { className: validation.valid === true ? "dsh-skm-banner" : "dsh-skm-banner error" },
              h(
                "div",
                { className: "dsh-skm-validate" },
                h(
                  "div",
                  null,
                  validation.valid === true
                    ? validation.warnings !== undefined && validation.warnings.length > 0
                      ? fill(t("validate.warnings"), { count: validation.warnings.length })
                      : t("validate.ok")
                    : t("validate.issues"),
                ),
                validation.issues === undefined || validation.issues.length === 0
                  ? null
                  : h(
                      "ul",
                      { className: "dsh-skm-issue-list" },
                      validation.issues.map((issue, index) => h("li", { key: index }, String(issue))),
                    ),
                validation.warnings === undefined || validation.warnings.length === 0
                  ? null
                  : h(
                      "ul",
                      { className: "dsh-skm-issue-list" },
                      validation.warnings.map((warning, index) => h("li", { key: index }, String(warning))),
                    ),
                validation.target === undefined || validation.target === "" ? null : h("div", null, fill(t("validate.target"), { path: validation.target })),
                validation.preview === undefined || validation.preview === "" ? null : h("pre", { className: "dsh-skm-preview" }, validation.preview),
              ),
            ),
        h(
          "div",
          { className: "dsh-skm-bar" },
          h("button", { type: "button", className: "dsh-skm-btn primary", onClick: submit }, t("save")),
          h(
            "button",
            { type: "button", className: "dsh-skm-btn", disabled: validating, onClick: runValidate },
            validating ? t("checking") : t("check"),
          ),
          h("button", { type: "button", className: "dsh-skm-btn ghost", onClick: onCancel }, t("cancel")),
        ),
      );
    }

    /**
     * Import a whole `SKILL.md` from pasted text.
     *
     * The form next door edits fields one at a time; this one is the paste path
     * for a skill copied from a chat, a gist, or another machine. Parsing and
     * validation happen on the host with the same rules as a file on disk, so an
     * import cannot create something the provider would ignore.
     */
    function ImportForm(props) {
      const { t, rootPath, initial, onCancel, onSubmit } = props;
      const [draft, setDraft] = useState(() => initial);
      const [problem, setProblem] = useState("");

      const update = useCallback((patch) => {
        setDraft((current) => ({ ...current, ...patch }));
      }, []);

      const submit = useCallback(() => {
        if (String(draft.text ?? "").trim() === "") {
          setProblem(t("form.importEmpty"));
          return;
        }
        setProblem("");
        onSubmit({
          text: String(draft.text ?? ""),
          name: String(draft.name ?? "").trim(),
          layout: draft.layout === "file" ? "file" : "bundle",
        });
      }, [draft, onSubmit, t]);

      return h(
        "div",
        { className: "dsh-skm-form" },
        h("div", { className: "dsh-skm-title" }, t("form.importTitle")),
        h("div", { className: "dsh-skm-subtitle" }, t("form.importNote")),
        h("div", { className: "dsh-skm-subtitle" }, fill(t("form.rootNote"), { path: rootPath === "" ? "—" : rootPath })),
        problem === "" ? null : h("div", { className: "dsh-skm-banner error" }, problem),
        h(
          Field,
          { label: t("form.importText"), hint: t("form.importTextHint") },
          h("textarea", {
            className: "body",
            value: draft.text,
            onChange: (event) => update({ text: event.target.value }),
          }),
        ),
        h(
          Field,
          { label: t("form.importName"), hint: t("form.importNameHint") },
          h("input", { type: "text", value: draft.name, onChange: (event) => update({ name: event.target.value }) }),
        ),
        h(
          Field,
          { label: t("field.layout"), hint: t("field.layoutHint") },
          h(
            "select",
            { value: draft.layout, onChange: (event) => update({ layout: event.target.value }) },
            h("option", { value: "bundle" }, t("form.bundle")),
            h("option", { value: "file" }, t("form.file")),
          ),
        ),
        h(
          "div",
          { className: "dsh-skm-bar" },
          h("button", { type: "button", className: "dsh-skm-btn primary", onClick: submit }, t("save")),
          h("button", { type: "button", className: "dsh-skm-btn ghost", onClick: onCancel }, t("cancel")),
        ),
      );
    }

    /**
     * The handful of files that look like skills but cannot be parsed.
     *
     * They are invisible to the model, so this panel is the only place a user
     * learns why a file they wrote does nothing — and the only place it can be
     * deleted again, because the page could not offer an edit form for a file it
     * cannot parse.
     */
    function IssuesPanel(props) {
      const { t, issues, open, onToggle, onDiscard } = props;
      if (!Array.isArray(issues) || issues.length === 0) return null;
      return h(
        "div",
        { className: "dsh-skm-issues" },
        h(
          "div",
          { className: "dsh-skm-bar" },
          h("strong", null, fill(t("unrecognized"), { count: issues.length })),
          h("span", { className: "dsh-skm-spacer" }),
          h(
            "button",
            { type: "button", className: "dsh-skm-btn ghost", "aria-expanded": open === true, onClick: onToggle },
            open ? t("hideIssues") : t("showIssues"),
          ),
        ),
        open
          ? h(
              "ul",
              { className: "dsh-skm-issue-list" },
              issues.map((issue, index) =>
                h(
                  "li",
                  { key: index, className: "dsh-skm-issue-row" },
                  h(
                    "div",
                    { className: "dsh-skm-issue-text" },
                    h("code", null, String(issue.path ?? "")),
                    " — ",
                    String(issue.message ?? ""),
                  ),
                  typeof onDiscard === "function"
                    ? h(
                        "button",
                        { type: "button", className: "dsh-skm-btn danger", onClick: () => onDiscard(issue) },
                        t("discard"),
                      )
                    : null,
                ),
              ),
            )
          : null,
      );
    }

    /** The settings page itself. */
    function SkillsSection(props) {
      const call = props.call;
      const t = props.t;
      const [snapshot, setSnapshot] = useState(null);
      const [error, setError] = useState("");
      const [notice, setNotice] = useState("");
      const [busy, setBusy] = useState("");
      const [editor, setEditor] = useState(null);
      const [detailsOpen, setDetailsOpen] = useState("");
      const [bodyOpen, setBodyOpen] = useState("");
      const [bodies, setBodies] = useState({});
      const [search, setSearch] = useState("");
      const [filter, setFilter] = useState("all");
      const [issuesOpen, setIssuesOpen] = useState(false);
      const signatureRef = useRef("");
      const noticeTimer = useRef(null);
      const [clock, setClock] = useState(() => Date.now());

      /** Clear the status notice and cancel its pending dismissal. */
      const dismissNotice = useCallback(() => {
        if (noticeTimer.current !== null) {
          clearTimeout(noticeTimer.current);
          noticeTimer.current = null;
        }
        setNotice("");
      }, []);

      /**
       * Show one status notice and schedule its own dismissal.
       *
       * A confirmation is only useful while the action is fresh: without this the
       * banner from the last save stayed on screen until the next mutation.
       */
      const showNotice = useCallback((message) => {
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
        setNotice(message);
        noticeTimer.current =
          typeof setTimeout === "function"
            ? setTimeout(() => {
                noticeTimer.current = null;
                setNotice("");
              }, NOTICE_MS)
            : null;
      }, []);

      useEffect(
        () => () => {
          if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
        },
        [],
      );

      const applySnapshot = useCallback((next, clock) => {
        const signature = snapshotSignature(next);
        if (signature === signatureRef.current) return false;
        signatureRef.current = signature;
        setSnapshot(next);
        setClock(clock);
        return true;
      }, []);

      const load = useCallback(async () => {
        try {
          const next = await call("state", {});
          /*
           * A poll that returns the catalog already on screen must not touch
           * state: replacing the snapshot object re-renders every card twice a
           * minute for nothing.
           */
          applySnapshot(next, Date.now());
          setError("");
          return next;
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
          return null;
        }
      }, [applySnapshot, call]);

      useEffect(() => {
        void load();
        /*
         * A hidden tab keeps polling out of politeness today, which costs the
         * host a directory scan nobody can see. Skip the request while hidden and
         * load as soon as the page is visible again.
         */
        const timer = setInterval(() => {
          if (!isPageHidden()) void load();
        }, POLL_MS);
        const clockTimer = setInterval(() => {
          if (!isPageHidden()) setClock(Date.now());
        }, CLOCK_MS);
        const onVisibility = () => {
          if (!isPageHidden()) void load();
        };
        if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
          document.addEventListener("visibilitychange", onVisibility);
        }
        return () => {
          clearInterval(timer);
          clearInterval(clockTimer);
          if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
            document.removeEventListener("visibilitychange", onVisibility);
          }
        };
      }, [load]);

      const mutate = useCallback(
        (endpoint, payload, message) => {
          setBusy(endpoint);
          setError("");
          dismissNotice();
          return Promise.resolve()
            .then(() => call(endpoint, payload))
            .then((value) => {
              if (value && value.snapshot) applySnapshot(value.snapshot, Date.now());
              setBodies({});
              setBodyOpen("");
              setEditor(null);
              // An import only learns its final name from the receipt, so a
              // message may be a function of the response.
              showNotice(typeof message === "function" ? message(value) : message);
              return value;
            })
            .catch((failure) => {
              setError(String((failure && failure.message) || failure));
            })
            .finally(() => setBusy(""));
        },
        [applySnapshot, call, dismissNotice, showNotice],
      );

      const loadBody = useCallback(
        (skill) => {
          const path = String(skill.path ?? "");
          if (path === "") return;
          setBodies((current) => withBodyEntry(current, path, { loading: true, text: "", error: "" }));
          void call("get", { path })
            .then((value) => setBodies((current) => withBodyEntry(current, path, { loading: false, text: String(value.body ?? ""), error: "" })))
            .catch((failure) =>
              setBodies((current) =>
                withBodyEntry(current, path, {
                  loading: false,
                  text: "",
                  error: `${t("error.bodyLoad")}: ${String((failure && failure.message) || failure)}`,
                }),
              ),
            );
        },
        [call, t],
      );

      const openEditor = useCallback(
        (mode, skill) => {
          if (mode === "create") {
            setEditor({ mode, skill: null, initial: emptyDraft() });
            return;
          }
          if (mode === "import") {
            setEditor({ mode, skill: null, initial: emptyImportDraft() });
            return;
          }
          setBusy("get");
          setError("");
          dismissNotice();
          void call("get", { path: skill.path })
            .then((value) => {
              const target = value.skill ?? skill;
              setEditor({ mode, skill: target, initial: draftFromSkill(target, value, mode) });
            })
            .catch((failure) => setError(String((failure && failure.message) || failure)))
            .finally(() => setBusy(""));
        },
        [call, dismissNotice],
      );

      const onToggleBody = useCallback(
        (skill) => {
          const path = String(skill.path ?? "");
          setBodyOpen((current) => (current === path ? "" : path));
          if (bodyOpen !== path && bodies[path] === undefined) loadBody(skill);
        },
        [bodyOpen, bodies, loadBody],
      );

      const onToggleEnabled = useCallback(
        (skill) => {
          const disable = !(skill.invocation !== undefined && skill.invocation.modelInvocable === false && skill.invocation.userInvocable === false);
          mutate(
            disable ? "stop" : "start",
            { path: skill.path },
            fill(disable ? t("notice.stopped") : t("notice.started"), { name: skill.name }),
          );
        },
        [mutate, t],
      );

      const onRemove = useCallback(
        (skill) => {
          if (typeof window !== "undefined" && !window.confirm(removePrompt(t, skill))) return;
          mutate("remove", { path: skill.path }, fill(t("notice.removed"), { name: skill.name }));
        },
        [mutate, t],
      );

      const onDiscardIssue = useCallback(
        (issue) => {
          const path = String(issue.path ?? "");
          if (path === "") return;
          if (typeof window !== "undefined" && !window.confirm(fill(t("confirmDiscard"), { path }))) return;
          mutate("discard", { path }, fill(t("notice.discarded"), { name: path }));
        },
        [mutate, t],
      );

      const onImport = useCallback(
        (payload) => {
          mutate("import", payload, (value) => fill(t("notice.imported"), { name: String((value && value.name) || payload.name || "") }));
        },
        [mutate, t],
      );

      const onRefresh = useCallback(() => {
        setBusy("refresh");
        setError("");
        dismissNotice();
        void Promise.resolve()
          .then(() => call("refresh", {}))
          .then((next) => {
            if (next && Array.isArray(next.skills)) applySnapshot(next, Date.now());
            showNotice(t("notice.refreshed"));
          })
          .catch((failure) => setError(String((failure && failure.message) || failure)))
          .finally(() => setBusy(""));
      }, [applySnapshot, call, dismissNotice, showNotice, t]);

      const onSubmitDraft = useCallback(
        (definition) => {
          const action = saveAction(editor, definition);
          const name = String(definition.name ?? "");
          const message =
            action.endpoint === "create"
              ? fill(t("notice.created"), { name })
              : action.endpoint === "copy"
                ? fill(t("notice.copied"), { name })
                : fill(t("notice.saved"), { name });
          mutate(action.endpoint, action.payload, message);
        },
        [editor, mutate, t],
      );

      const onValidateDraft = useCallback((definition) => call("validate", { definition }), [call]);

      const allSkills = visibleSkills(snapshot);
      const active = allSkills.filter((skill) => skill.status === "active");
      const summary = {
        skills: allSkills.length,
        model: active.filter((skill) => skill.invocation === undefined || skill.invocation.modelInvocable !== false).length,
        user: active.filter((skill) => skill.invocation === undefined || skill.invocation.userInvocable !== false).length,
        shadowed: allSkills.filter((skill) => skill.status === "shadowed").length,
      };
      const issues = snapshot === null ? [] : snapshot.issues ?? [];
      const version = snapshot === null || snapshot.version === undefined ? "" : String(snapshot.version);
      const rootPath = skillRootOf(snapshot);
      const legacyHost = snapshot !== null && snapshot.skillRoot === undefined;
      const visible = filterSkills(allSkills, search, filter);

      return h(
        "div",
        { className: "dsh-skm" },
        h(
          "div",
          { className: "dsh-skm-head" },
          h(
            "div",
            { className: "dsh-skm-title-row" },
            h("h2", { className: "dsh-skm-title" }, t("title")),
            version === "" ? null : h("span", { className: "dsh-skm-version", title: t("versionHint") }, `v${version}`),
          ),
          h("p", { className: "dsh-skm-subtitle" }, t("subtitle")),
        ),
        h(
          "div",
          { className: "dsh-skm-bar" },
          h(
            "span",
            { className: "dsh-skm-summary" },
            h("span", null, t("skills"), " ", h("b", null, String(summary.skills))),
            h("span", null, t("modelVisible"), " ", h("b", null, String(summary.model))),
            h("span", null, t("userInvocable"), " ", h("b", null, String(summary.user))),
            h("span", null, t("shadowed"), " ", h("b", null, String(summary.shadowed))),
            issues.length === 0
              ? null
              : h("span", { className: "dsh-skm-summary-warn" }, t("issues"), " ", h("b", null, String(issues.length))),
          ),
          h("span", { className: "dsh-skm-spacer" }),
          h(
            "button",
            { type: "button", className: "dsh-skm-btn", disabled: busy !== "", onClick: onRefresh },
            t("refresh"),
          ),
          h(
            "button",
            {
              type: "button",
              className: "dsh-skm-btn",
              disabled: busy !== "" || editor !== null,
              onClick: () => {
                dismissNotice();
                openEditor("import", null);
              },
            },
            t("importSkill"),
          ),
          h(
            "button",
            {
              type: "button",
              className: "dsh-skm-btn primary",
              disabled: busy !== "" || editor !== null,
              onClick: () => {
                dismissNotice();
                openEditor("create", null);
              },
            },
            t("create"),
          ),
        ),
        error === "" ? null : h("div", { className: "dsh-skm-banner error" }, error),
        notice === "" ? null : h("div", { className: "dsh-skm-banner" }, notice),
        legacyHost ? h("div", { className: "dsh-skm-banner warn" }, fill(t("legacyHost"), { version })) : null,
        h(IssuesPanel, { t, issues, open: issuesOpen, onToggle: () => setIssuesOpen((current) => !current), onDiscard: onDiscardIssue }),
        h(
          "div",
          { className: "dsh-skm-bar" },
          h("input", {
            type: "search",
            className: "dsh-skm-search",
            placeholder: t("searchPlaceholder"),
            value: search,
            onChange: (event) => setSearch(event.target.value),
          }),
          h(
            "select",
            {
              className: "dsh-skm-filter",
              value: filter,
              onChange: (event) => setFilter(event.target.value),
            },
            h("option", { value: "all" }, t("filter.all")),
            h("option", { value: "shadowed" }, t("filter.shadowed")),
            h("option", { value: "disabled" }, t("filter.disabled")),
            h("option", { value: "warned" }, t("filter.warned")),
          ),
        ),
        editor === null
          ? null
          : editor.mode === "import"
            ? h(ImportForm, {
                key: editorKey(editor),
                t,
                rootPath,
                initial: editor.initial,
                onCancel: () => setEditor(null),
                onSubmit: onImport,
              })
            : h(SkillForm, {
                key: editorKey(editor),
                t,
                mode: editor.mode,
                original: editor.skill,
                rootPath,
                initial: editor.initial,
                onCancel: () => setEditor(null),
                onSubmit: onSubmitDraft,
                onValidate: onValidateDraft,
              }),
        allSkills.length === 0
          ? h(
              "div",
              { className: "dsh-skm-banner" },
              h("div", null, t("empty")),
              h("div", { className: "dsh-skm-subtitle" }, fill(t("emptyHint"), { path: rootPath === "" ? "—" : rootPath })),
            )
          : visible.length === 0
            ? h("div", { className: "dsh-skm-banner" }, t("emptyFiltered"))
            : visible.map((skill) =>
                h(SkillCard, {
                  key: skill.path,
                  skill,
                  t,
                  busy,
                  locked: editor !== null,
                  now: clock,
                  detailsOpen: detailsOpen === skill.path,
                  bodyOpen: bodyOpen === skill.path,
                  body: bodies[skill.path],
                  onToggleEnabled,
                  onRemove,
                  onCopy: (target) => {
                    dismissNotice();
                    openEditor("copy", target);
                  },
                  onEdit: (target) => {
                    dismissNotice();
                    openEditor("edit", target);
                  },
                  onToggleDetails: (target) => setDetailsOpen((current) => (current === target.path ? "" : target.path)),
                  onToggleBody,
                }),
              ),
        snapshot === null
          ? null
          : h(
              "div",
              { className: "dsh-skm-footer" },
              h("span", null, t("rootPath"), ": ", h("code", null, rootPath === "" ? "—" : rootPath)),
              h("span", null, t("workspace"), ": ", h("code", null, snapshot.workspace === undefined ? "" : String(snapshot.workspace.cwd ?? ""))),
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
      }, "dsh-skill-manager: styles");

      const t = makeTranslator(ctx);
      const connection = ctx.get("connection");
      const call = async (endpoint, payload) => {
        /*
         * Resolve the service per request: the connection half can be reloaded
         * while this page stays open, and a captured instance would then be a
         * disposed service whose calls fail until the page is refreshed.
         */
        const live = ctx.get("connection") ?? connection;
        if (live === undefined || live === null) throw new Error(t("error.noConnection"));
        let result;
        try {
          result = await live.rpc.call(CHANNEL, endpoint, payload ?? {});
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
            id: "skills",
            order: 26,
            label: () => t("nav"),
            locale: NS,
            inject: () => ({ call, t }),
          },
          SkillsSection,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    /** Offline authoring surface: `test/check-client.mjs` renders these without a browser. */
    exports.__components = { SkillsSection, SkillCard, SkillForm, ImportForm, IssuesPanel, Field };
    /** Pure helpers the offline check asserts directly. */
    exports.__helpers = {
      saveAction,
      definitionFromDraft,
      draftFromSkill,
      emptyDraft,
      emptyImportDraft,
      draftProblem,
      filterSkills,
      formatAgo,
      formatBytes,
      invocationLabel,
      skillRootOf,
      visibleSkills,
      editorKey,
      removePrompt,
      fill,
      snapshotSignature,
      withBodyEntry,
      isPageHidden,
    };
    exports.__dictionaries = { zh, en };
    return module.exports;
  },
});
