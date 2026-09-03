# Cursor product feedback — Agent Plugins 1.0.0 `${PLUGIN_ROOT}` expansion (ready to submit)

Prepared 2026-09-03 for #426. Everything below was observed on the current
installed stable build and is reproducible with the plugin in "Minimal
repro" (one directory, three files, no dependencies). The maintainer submits
it; this repository cannot post on their behalf.

**Where to submit (pick one, template-compatible):**

- Bug report (preferred — every item below is a MUST violation with a
  deterministic repro): <https://forum.cursor.com/c/support/bug-report/6> →
  "New Topic" (direct link
  <https://forum.cursor.com/new-topic?category=support/bug-report>). The
  forum's bug template asks for product area, description, steps, expected
  behaviour, screenshots, and the About-dialog version block; all of it is
  filled in below. Reporting guidance: <https://cursor.com/help/troubleshooting/reporting-bugs>.
- Feature request, if triaged as "Agent Plugins §9 support" rather than a
  defect: <https://forum.cursor.com/c/ideas/feature-requests/5>.
- Email fallback named by the reporting guide: `hi@cursor.com`.

Attach the two screenshots from
`docs/assets/agent-plugins-cursor-proof/2026-09-03-plugin-detail-spec-shape-error.png`
and `…/2026-09-03-plugin-detail-cursor-placeholder-connected.png`.

---

## Bug report body

**Where does the bug appear:** Cursor IDE → MCP & tools (plugin loader for
Agent Plugins packages placed in `~/.cursor/plugins/local`).

**Version block (Menu → About Cursor):** Cursor 3.18.25, Linux x64 (deb,
`/usr/share/cursor`), commit `280eca2911f1774689696e5f1efa5a4f97a87af0`
(`realCommit` `280eca2911f1774689696e5f1efa5a4f97a87af3`). OS: Linux 7.0.0
(Xvfb display for the isolated instance; the behaviour does not depend on
the display).

**Summary.** Cursor discovers Agent Plugins 1.0.0 packages (root
`plugin.json` declaring
`https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`), lists their
Skills and MCP servers in Customize, and spawns the configured stdio
servers — but the spawn ignores every path rule in Agent Plugins §7.2.1 and
§9 (<https://agent-plugins.org/specification>). As a result **no
spec-conformant stdio server that refers to a file shipped in the plugin can
start on Cursor** — every such reference goes through `cwd`, `args`, `env`,
or a plugin-relative `command`, and none of those is resolved against the
plugin root. Only a server that names a globally installed executable and
needs nothing from the package (item 3's inline `node -e` probe) starts; it
still runs from the wrong directory without the §9.1 variables. The same
bundled server starts as soon as the spec placeholder is replaced by Cursor's
proprietary `${CURSOR_PLUGIN_ROOT}`. The standard's own stdio example
(`"cwd": "${PLUGIN_ROOT}"`) fails. Six concrete observations follow; 1–3 were
first recorded on 2026-09-02 and re-verified today, 4–6 were found while
widening the probe.

**Steps to reproduce (all items).**

1. Create `~/.cursor/plugins/local/ap-probe/` with the files in "Minimal
   repro" below: `plugin.json`, `mcp.json`, and `mcp/report.mjs` cover items
   1–5; item 6 additionally needs the executable `mcp/launch.sh` listed
   there. Swap the `probe` entry in `mcp.json` for the item's payload.
2. Reload the window (`Developer: Reload Window`) — local plugins are read on
   reload, not on first boot.
3. Open Customize → Plugins → "Ap Probe" (badge `Local`) → MCPs → `probe`
   → "Show Output", and read
   `<user-data-dir>/logs/<session>/window1/exthost/anysphere.cursor-mcp/MCP plugin-ap-probe-probe.log`.
4. For items 3–5 read the marker file the probe writes (`/tmp/ap-probe-launch.jsonl`).

### 1. `${PLUGIN_ROOT}` is not expanded in `cwd`

- **Spec:** §7.2.1 — "Clients MUST expand placeholders before resolving
  `cwd`." and "The `args`, `env`, and `cwd` fields in a stdio server
  configuration MUST support `${PLUGIN_ROOT}` and `${PLUGIN_DATA}`
  expansion." §9.2 — "Expansion applies to … the `cwd` string." The
  specification's stdio example uses `"cwd": "${PLUGIN_ROOT}"`.
- **Payload:**
  `{"type":"stdio","command":"node","args":["mcp/report.mjs"],"cwd":"${PLUGIN_ROOT}"}`
- **Observed:** `Connection failed: spawn node ENOENT` /
  `createClient completed … connected=false, statusType=error, error=spawn node ENOENT`.
  The literal string `${PLUGIN_ROOT}` is handed to the child process as its
  working directory; the spawn fails before the executable lookup, which is
  why an existing `node` reports ENOENT (the identical bare `node` spawns in
  items 2–3, which omit `cwd`). Customize shows the server as
  `Error - Show Output`.
- **Expected:** `cwd` resolved to
  `/home/<user>/.cursor/plugins/local/ap-probe`; the server starts and the
  marker records that directory as `cwd`.

### 2. `${PLUGIN_ROOT}` is not expanded in `args`

- **Spec:** §9.2 — "Clients that launch plugin subprocesses MUST expand
  `${PLUGIN_ROOT}` and `${PLUGIN_DATA}` in supported configuration fields.
  … Expansion applies to every string element of `args`".
- **Payload:**
  `{"type":"stdio","command":"node","args":["${PLUGIN_ROOT}/mcp/report.mjs"]}`
- **Observed:** node starts with the literal argument and exits:
  `Error: Cannot find module '/home/<user>/${PLUGIN_ROOT}/mcp/report.mjs'`
  (`code: 'MODULE_NOT_FOUND'`), followed by
  `Connection failed: MCP error -32000: Connection closed`. (The resolved
  path also shows the default working directory is the home directory —
  item 3.)
- **Expected:** `args[0]` =
  `/home/<user>/.cursor/plugins/local/ap-probe/mcp/report.mjs`; the server
  starts.

### 3. Omitted `cwd` defaults to the home directory, not the plugin root

- **Spec:** §7.2.1 — "When `cwd` is omitted, clients MUST use the plugin
  root as the subprocess working directory."
- **Payload:**
  `{"type":"stdio","command":"node","args":["-e","require('fs').appendFileSync('/tmp/ap-probe-launch.jsonl', JSON.stringify({cwd:process.cwd(),env:process.env})+'\\n'); process.stdin.resume();"]}`
- **Observed:** marker `cwd = /home/<user>` (the process `HOME`; in the
  isolated instance `/tmp/w426/iso/home`).
- **Expected:** `cwd = /home/<user>/.cursor/plugins/local/ap-probe`.

### 4. `${PLUGIN_ROOT}` / `${PLUGIN_DATA}` are not expanded in `env` values

- **Spec:** §9.2 — "Expansion applies to … every string value in `env`".
- **Payload:** item 3's entry plus
  `"env":{"PROBE_ROOT":"${PLUGIN_ROOT}","PROBE_DATA":"${PLUGIN_DATA}"}`
- **Observed:** marker `PROBE_ROOT = "${PLUGIN_ROOT}"`,
  `PROBE_DATA = "${PLUGIN_DATA}"` (literal). With
  `"PROBE_ROOT":"${CURSOR_PLUGIN_ROOT}"` the same variable arrives expanded,
  so the env-expansion pipeline exists but is keyed to the proprietary name.
- **Expected:** `PROBE_ROOT = /home/<user>/.cursor/plugins/local/ap-probe`,
  `PROBE_DATA` = the client-managed data directory for this plugin.

### 5. Reserved `PLUGIN_ROOT` / `PLUGIN_DATA` variables are not provided

- **Spec:** §9.1 — "Clients that launch plugin subprocesses (i.e., stdio MCP
  servers) MUST provide `PLUGIN_ROOT` and `PLUGIN_DATA` in each subprocess
  environment. … It MUST create the [`PLUGIN_DATA`] directory before
  launching a plugin subprocess".
- **Payload:** item 3's entry (no `env` needed).
- **Observed:** `process.env.PLUGIN_ROOT` and `process.env.PLUGIN_DATA` are
  `undefined` in the child.
- **Expected:** both set to absolute paths, `PLUGIN_DATA` created and
  writable.

### 6. Plugin-relative `./` commands resolve against the workspace folder

- **Spec:** §7.2.1 — "[`command`] MUST be either a bare executable name or a
  plugin-relative path beginning with `./`. Clients … MUST resolve
  plugin-relative paths against the plugin root." (No placeholder expansion
  applies to `command`, so this is the only portable way to launch a bundled
  executable.)
- **Payload:** `{"type":"stdio","command":"./mcp/launch.sh","args":[]}` with
  the executable `mcp/launch.sh` from "Minimal repro" in the plugin
  (`chmod +x`).
- **Observed:** `Connection failed: spawn /home/<user>/<workspace>/mcp/launch.sh ENOENT`
  (isolated instance: `spawn /tmp/w426/iso/ws/mcp/launch.sh ENOENT`) — the
  path is joined to the open workspace folder.
- **Expected:** `/home/<user>/.cursor/plugins/local/ap-probe/mcp/launch.sh`
  is executed.

### Control: the proprietary placeholder works

`{"type":"stdio","command":"node","args":["${CURSOR_PLUGIN_ROOT}/mcp/report.mjs"],"env":{"PROBE_ROOT":"${CURSOR_PLUGIN_ROOT}"}}`
starts, the marker shows `argv[1]` and `PROBE_ROOT` expanded to
`…/plugins/local/ap-probe`, and the connection reaches
`connection:connect_success` with a stable heartbeat. The fix is therefore a
mapping of `${PLUGIN_ROOT}`/`${PLUGIN_DATA}` (and the §9.1 variables, the
default `cwd`, and `./` command resolution) onto the pipeline that already
serves `${CURSOR_PLUGIN_ROOT}` when the package is an Agent Plugins package
(`$schema` under `https://agent-plugins.org/schemas/`).

### Why it matters

Any tool that emits spec-conformant Agent Plugins packages (this project's
`portable` target, and any other publisher following
<https://agent-plugins.org>) produces packs whose Skills load in Cursor but
whose bundled MCP servers — anything that ships its own script or binary and
therefore addresses it through `cwd`, `args`, `env`, or a `./` command —
cannot start there, with a misleading `spawn node ENOENT`. Publishers cannot
work around it without shipping a Cursor-specific copy, which defeats the
portable format.

---

## Minimal repro plugin

Four files, no dependencies beyond `node` on `PATH`; `mcp/launch.sh` is only
needed for item 6.

`~/.cursor/plugins/local/ap-probe/plugin.json`

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "ap-probe",
  "version": "1.0.0",
  "description": "Agent Plugins 1.0.0 placeholder-expansion probe."
}
```

`~/.cursor/plugins/local/ap-probe/mcp/report.mjs`

```js
import { appendFileSync } from 'node:fs';
appendFileSync('/tmp/ap-probe-launch.jsonl', JSON.stringify({
  argv: process.argv.slice(1),
  cwd: process.cwd(),
  env: {
    PLUGIN_DATA: process.env.PLUGIN_DATA ?? null,
    PLUGIN_ROOT: process.env.PLUGIN_ROOT ?? null,
    PROBE_DATA: process.env.PROBE_DATA ?? null,
    PROBE_ROOT: process.env.PROBE_ROOT ?? null,
  },
}) + '\n');
process.stdin.resume(); // stay alive like a stdio server; the handshake time-out is expected
```

`~/.cursor/plugins/local/ap-probe/mcp/launch.sh` (item 6 only; `chmod +x mcp/launch.sh`)

```sh
#!/usr/bin/env bash
# Records where the client started us, then runs the reporter next to this script.
export PROBE_LAUNCH_PWD="$PWD"
exec node "$(dirname "$0")/report.mjs"
```

A conformant client resolves `./mcp/launch.sh` against the plugin root and the
marker line appears; Cursor 3.18.25 reports
`spawn <workspace>/mcp/launch.sh ENOENT` and no line is written. (To confirm
the file itself is fine, `cd ~/.cursor/plugins/local/ap-probe && ./mcp/launch.sh`
writes the marker from a shell.)

`~/.cursor/plugins/local/ap-probe/mcp.json` — the specification's shape
(item 1); swap the `probe` entry for the payload of any other item.

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "probe": {
      "type": "stdio",
      "command": "node",
      "args": ["mcp/report.mjs"],
      "cwd": "${PLUGIN_ROOT}",
      "env": { "PROBE_ROOT": "${PLUGIN_ROOT}", "PROBE_DATA": "${PLUGIN_DATA}" }
    }
  }
}
```

Expected result of a conformant client: one line in
`/tmp/ap-probe-launch.jsonl` with `cwd` = the plugin root, `PROBE_ROOT` =
the plugin root, `PROBE_DATA` and `PLUGIN_DATA` = an existing writable
directory, `PLUGIN_ROOT` = the plugin root. Observed on 3.18.25: no line
(spawn fails on `cwd`).

---

## Evidence retained in this repository

- Re-verification run and log excerpts:
  [`2026-09-03-agent-plugins-cursor-ide-proof.md`](./2026-09-03-agent-plugins-cursor-ide-proof.md)
  (section 3 table) and the original observation
  [`2026-09-02-agent-plugins-cursor-ide-proof.md`](./2026-09-02-agent-plugins-cursor-ide-proof.md).
- Capability table: `packages/agent-bundle/src/adapters/capabilities/portable-1.0.0.json`
  (`mcp.evidence`).
- Cursor's own documentation of the proprietary placeholder:
  <https://cursor.com/docs/hooks> (`${CURSOR_PLUGIN_ROOT}` expansion in
  plugin-delivered commands) and <https://cursor.com/docs/plugins#test-plugins-locally>
  ("put either plugin format in `~/.cursor/plugins/local`").
