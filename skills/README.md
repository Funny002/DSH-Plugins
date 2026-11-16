# Chrome DevTools skills

Agent skills for driving a live Chrome browser through the `chrome-mcp` MCP server row
(package `chrome-devtools-mcp`, v1.13.0).

## Contents

| Skill | Covers |
|---|---|
| `chrome-devtools` | Core loop: pages, accessible snapshots, uid-based input, screenshots, CSS, console, network, performance traces, Lighthouse, emulation, screencast, heap snapshots |
| `a11y-debugging` | Semantic HTML, ARIA, focus and keyboard behaviour, tap targets, color contrast |
| `cookie-debugging` | Cookies and session state, 401/403 diagnosis, `Set-Cookie`/`Cookie` headers, SameSite and partitioned cookies, consent banners |
| `debug-optimize-lcp` | Largest Contentful Paint breakdown and optimization (`references/` carry the snippets) |
| `memory-leak-debugging` | Heap snapshots, leak patterns, comparison workflow |
| `troubleshooting` | Connection and target failures: server row, Chrome launch, page loss |
| `chrome-devtools-cli` | Driving the browser from a shell with the `chrome-devtools` CLI |

## Source and license

Extracted from the `skills/` directory shipped with `chrome-devtools-mcp@1.13.0`
([ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)),
licensed Apache-2.0. Each `SKILL.md` keeps its original body and frontmatter.

## Harness adaptations

- Every MCP tool is called as `mcp__chrome-mcp__<tool>` in this profile, so each copied
  `SKILL.md` opens with a `DSH harness notes` block stating the prefix, pointing
  configuration edits at the `mcp-manager` block of the profile's `cordis.patch.yml`
  (Settings → MCP servers), and listing the server args in use
  (`npx -y chrome-devtools-mcp --no-usage-statistics --no-performance-crux`).
- `chrome-devtools/SKILL.md` is rewritten for the Harness: prefixed tool names, the tool
  selection table, the optional category flags, and the performance and debugging loops.
- The upstream bodies assume Claude/Cursor style client config files; the notes override
  that with the profile patch, so no upstream instruction points at a file that does not
  exist here.

## Install into a DSH profile

User-level skills live in `$DSH_HOME/skills` and apply to every profile and session. The
filesystem skill provider watches that directory, so the catalog refreshes without a
restart.

```powershell
Copy-Item .\skills\* "$env:DSH_HOME\skills" -Recurse -Force
```

## Updating

Re-extract the `skills/` directory from the same npm package version, then re-apply the
`DSH harness notes` block. Skills describe the tools of one server version; tool names and
parameters can change between releases.
