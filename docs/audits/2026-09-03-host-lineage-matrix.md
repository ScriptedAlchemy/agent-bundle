# Host lineage evidence matrix — what each host tells a plugin about conversations and subagents

Date: 2026-09-03. Probe: `examples/host-test` (this repository, built from the
same commit as this document) installed into isolated homes under
`/tmp/host-test/<host>-home` through `agent-bundle install <host>`; the real
`~/.claude`, `~/.codex`, and `~/.cursor` were never written (Claude's sign-in
was seeded into the isolated home outside the harness for the two 2.1.257
runs and copied by the unmodified harness for the 2.1.259 run; see the Claude
row). Every number below comes from the redacted capture logs checked in under
`fixtures/host-lineage/` (`claude-2.1.257.ndjson`,
`claude-2.1.257-foreground.ndjson`, `claude-2.1.259-orchestration.ndjson` with
its model-stream twin `claude-2.1.259-orchestration.stream.ndjson`,
`codex-0.147.0.ndjson`, `cursor-3.18.25.ndjson`); ids are quoted as recorded,
e-mail addresses and the operator home directory are redacted, and long tool
payloads are clipped.

| Host | Binary observed | Session driver | Subagent mechanism exercised | Depth reached |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.257 (`claude -p`, `--dangerously-skip-permissions`, `--model sonnet` → `claude-sonnet-5`) | **Live model, 2026-09-03, Claude Code 2.1.257.** `probe:install claude` copied the operator's `~/.claude/.credentials.json` byte-for-byte as documented, but that interactive session had expired (`claude auth status` on the real home → `loggedIn: false`; a turn in the isolated home → "Failed to authenticate: OAuth session expired and could not be refreshed"), so the isolated `CLAUDE_CONFIG_DIR`'s `.credentials.json` was re-seeded with the operator's long-lived `claude setup-token` token by a **one-off local step outside the checked-in harness** (an uncommitted local edit of `probe:install`, discarded afterwards; `docs/audits/2026-09-03-claude-live-session-proofs.md`). The harness itself is unchanged and reads no sign-in state beyond that copy; the real `~/.claude` was never written. `claude auth status` in the isolated home → `loggedIn: true`, `authMethod: claude.ai`, `subscriptionType: max`. Two sessions were captured: the primary fixture, where Claude Code ran the root's `Agent` in the background, and `-foreground`, where both spawns blocked. An earlier capture on the same day used a scripted Messages-API stand-in (PR #421); its findings are re-verified against the live runs in §8. **Third session, live model 2026-09-03, Claude Code 2.1.259** (`-orchestration`): after the operator signed in again, the **unmodified** harness's byte-for-byte copy of `~/.claude/.credentials.json` produced a signed-in isolated session (`claude auth status` in the isolated home → `loggedIn: true`); `probe:capture claude --scenario scenarios/claude-orchestration.json` drove four `claude -p --output-format stream-json --verbose` turns resumed into one session (§1, "orchestration run"). | `Agent` tool (`subagent_type: general-purpose`), subagent spawned a nested `Agent`; orchestration run: two parallel spawns (`Explore` + `general-purpose`, both backgrounded by the host), one sequential spawn that nested another, the `host-test:host-test` skill, a manual `/compact` | 2 (`subagent_stats.max_depth: 2`, `spawned_by_subagents: 1`; orchestration run: stream `task_started.spawn_depth: 2`) |
| Codex CLI | 0.147.0 (`codex exec --json --dangerously-bypass-hook-trust`, `[features] multi_agent`, `[agents] max_depth = 3`) | Real model (`gpt-5.6-sol`) with the operator's `auth.json` copied byte-for-byte into the isolated `CODEX_HOME` | `collaborationspawn_agent` (`fork_turns: all`), the spawned thread spawned a nested thread | 2 |
| Cursor IDE | 3.18.25 desktop, isolated `--user-data-dir` on Xvfb, `cursorAuth/*` profile rows transplanted, driven over CDP in the Agents pane (`Auto` model) | Real model | `Task` tool (`subagent_type: general-purpose`), the subagent spawned a nested `Task` | 2 |
| Cursor CLI (`cursor-agent`) | 2026.08.31 build present | **Not driven**: `cursor-agent status` → `Not logged in`, and logging in requires a browser flow. | — | — |
| Portable (Agent Plugins 1.0.0) | — | No hooks surface exists in the contract, so nothing to capture. | — | — |

Terminology: "root" is the conversation the user typed into; "subagent" is a
child spawned by the root; "nested" is a child of that subagent. `*` marks a
field the framework already lifts into the request context.

## 1. Ids present per host × event (as delivered to plugin hooks)

### Claude Code 2.1.257 (live model 2026-09-03, Claude Code 2.1.257)

Primary fixture `claude-2.1.257.ndjson` (48 records: 42 hook events, 6 MCP
calls): root session `7f7a50ca-3609-4612-8db1-a34c8985088a`, subagent
`aebe95b6e051369a4` (spawned by the root, run **in the background** by the
host), nested agent `a9bc7270b816a535e` (spawned by the subagent, foreground).
`claude-2.1.257-foreground.ndjson` (51 records) is a second live session,
root `b255be60-9740-46f5-a38c-730a98bc24e9`, whose two spawns both blocked
their caller; row numbers below are the primary fixture's unless marked *fg*.

| Event (native) | `session_id`* | `agent_id` | `agent_type` | `tool_use_id` | `prompt_id` | `transcript_path` / `agent_transcript_path` | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SessionStart | root | — | — | — | — | root transcript | `source: startup`, `cwd`; no `permission_mode`, no `effort` |
| UserPromptSubmit | root | — | — | — | yes | root | `prompt`, `permission_mode`; no `effort`. Fired twice: the operator prompt (row 2) and, after the background subagent finished, a host-generated `<task-notification>` prompt naming `task-id` = the child's `agent_id` and `tool-use-id` = the root's `Agent` call (row 46, new `prompt_id`) |
| PreToolUse / PostToolUse (root turn) | root | — | — | `toolu_…` | yes | root | `tool_name`, `tool_input`, `permission_mode`, `effort: {"level":"high"}`, `tool_response` + `duration_ms` (Post). Tool names seen: `Bash`, `Write`, `ToolSearch` (Claude defers MCP tools — `total_deferred_tools: 21` — and selects them by name before the first call), `mcp__plugin_host-test_host-test__dump`, `mcp__plugin_host-test_host-test-raw__probe`, `Agent` |
| PreToolUse / PostToolUse (inside a subagent) | **root** | **subagent's** (`aebe95b6e051369a4`) | `general-purpose` | `toolu_…` | root's | root transcript (not the subagent's) | same fields; the subagent also invoked the plugin's skill through the `Skill` tool (`tool_input: {"skill":"host-test:host-test"}`, `tool_response: {"success":true,"commandName":"host-test:host-test"}`) |
| PreToolUse / PostToolUse (inside the nested agent) | **root** | **nested's** (`a9bc7270b816a535e`) | `general-purpose` | | root's | root | no reference to `aebe9…` |
| PostToolUse of the spawning `Agent` call (on the parent) | parent's | parent's (absent on the root) | | the spawn's | | | `tool_response.agentId` **= the child's `agent_id`**, `resolvedModel`; background spawn (row 17, right after SubagentStart): `status: "async_launched"`, `isAsync: true`, `outputFile`, `canReadOutputFile`, `description`, `prompt`; foreground spawn (row 41; *fg* rows 47/49, after the child's SubagentStop): `status: "completed"`, `agentType`, `content[]`, `totalDurationMs`, `totalTokens`, `totalToolUseCount`, `usage`, `toolStats`, `harness*` |
| SubagentStart | root | the new agent | `general-purpose` | — | yes | root transcript | **no parent agent id**; no `permission_mode`, no `effort` |
| SubagentStop | root | the stopping agent | `general-purpose` | — | yes | root transcript + `agent_transcript_path` = `<session>/subagents/agent-<id>.jsonl` (flat; nested agent's path does not name its parent) | `permission_mode`, `effort`, `stop_hook_active`, `last_assistant_message`, `background_tasks[]` (every subagent the host is running in the background — `id`, `type: subagent`, `status: running`, `agent_type`, `description` — **including the stopping agent itself** when it was backgrounded, row 45; empty for foreground children, *fg* rows 46/48). Row 40, the nested agent's SubagentStop, lists `aebe95…` — which happens to be its parent — only because that parent was still running in the background; nothing marks the entry as a parent. `session_crons` |
| Stop | root | — | — | — | yes | root | `permission_mode`, `effort`, `stop_hook_active`, `last_assistant_message`, `background_tasks[]` (row 18 lists the still-running background subagent; row 47 and *fg* row 50 are empty), `session_crons` |
| SessionEnd | root | — | — | — | yes | root | `reason: "other"`; no `effort` |

`effort` (`{"level":"high"}`) is on 36 of the 42 hook payloads — every
PreToolUse, PostToolUse, SubagentStop, and Stop — and absent from SessionStart,
UserPromptSubmit, SubagentStart, and SessionEnd. `permission_mode:
"bypassPermissions"` is on every payload except SessionStart, SubagentStart,
and SessionEnd. The stand-in run of PR #421 showed neither field; the
framework already lifts both (`hook-contract.ts` `nativeHookInputFields`).

The `Agent` tool's `run_in_background` was **unset** on the root's spawn in
the primary run and the host chose to background it; it was `false` on the
nested spawn and on both *fg* spawns, which blocked. The result document
counts the choice: primary `subagent_stats.requested: {background: 0,
foreground: 1, unset: 1}`, `started_in_background: 1`, and its final `result`
document carries `origin: {"kind": "task-notification"}` because the last turn
was the host's own re-prompt; *fg* `{background: 0, foreground: 2, unset: 0}`,
`started_in_background: 0`.

Not observed in either 2.1.257 scenario (the host did not emit them):
`Notification`, `PermissionRequest`/`PermissionDenied` (permissions were
bypassed), `PreCompact`/`PostCompact`, `FileChanged`, `ConfigChange`,
`TaskCreated`/`TaskCompleted`, `TeammateIdle`, `StopFailure`,
`PostToolUseFailure`. The 2.1.259 orchestration run below did emit
`PreCompact`/`PostCompact` (manual `/compact`) and `PostToolUseFailure`; the
rest stayed unobserved.

Payload excerpt (2.1.257 fixture `claude-2.1.257.ndjson`, SubagentStart of the nested agent, row 32 — note the absence
of any parent field):

```json
{"session_id":"7f7a50ca-3609-4612-8db1-a34c8985088a","transcript_path":"…/-tmp-host-test-claude-workspace/7f7a50ca-….jsonl","cwd":"/tmp/host-test/claude-workspace","prompt_id":"a78d8bed-e865-426a-a3e4-ee9ce500493c","agent_id":"a9bc7270b816a535e","agent_type":"general-purpose","hook_event_name":"SubagentStart"}
```

Payload excerpt (2.1.257 fixture, root `Stop`, row 18, fired while the background subagent was
still running — the only Claude payload that names a live child other than
SubagentStart):

```json
{"session_id":"7f7a50ca-…","prompt_id":"a78d8bed-…","permission_mode":"bypassPermissions","effort":{"level":"high"},"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"Steps 1-5 are complete; the subagent is running in the background. …","background_tasks":[{"id":"aebe95b6e051369a4","type":"subagent","status":"running","description":"Host-test probe subagent","agent_type":"general-purpose"}],"session_crons":[]}
```

### Claude Code 2.1.259 orchestration run (live model 2026-09-03, multi-turn)

`claude-2.1.259-orchestration.ndjson` (141 records: 127 hook events, 14 MCP
calls) is one session, root `76bb405f-65e0-4f6f-9da4-a23a33014bb8`, driven
by `examples/host-test/scenarios/claude-orchestration.json` through
`probe:capture claude --scenario …`: four `claude -p --output-format
stream-json --verbose` processes, the last three with `--resume <session_id>`.
`claude-2.1.259-orchestration.stream.ndjson` is the model's own transcript of
the same four turns (202 envelopes after thinning), each tagged with its
`turn`. Every one of the 127 hook payloads and 202 stream envelopes carries
that single `session_id`.

| Turn | Prompt | Hook rows | What the host did |
| --- | --- | --- | --- |
| 1 | Orchestration: `pwd`, `dump`, two `Agent` calls in one message (`Explore` + `general-purpose`), then a sequential `general-purpose` spawn that nests another | 1–103 | Both parallel spawns were **backgrounded by the host** (`run_in_background` unset → `status: "async_launched"`, rows 13/17); the root `Stop` fired at row 34 with both children still running; the host re-prompted itself with a `<task-notification>` (row 58, new `prompt_id`); the sequential spawn (`run_in_background: false`, row 64) blocked and nested a depth-2 child (row 81). `SessionEnd` row 103 |
| 2 | Invoke the `host-test:host-test` skill at the root; run any other plugin command | 104–130 | `SessionStart source: resume` (row 104); `Skill` at the root (row 106); the skill's file-edit step wrote `probe-scratch.txt` (row 110); the model wrote `NO_PLUGIN_COMMAND` (row 125) — the pack ships no `commands/`, and the `system/init` envelope lists `host-test:host-test` as the plugin's only slash command |
| 3 | `/compact` as the `-p` prompt | 131–135 | `SessionStart source: resume` → `PreCompact` (`trigger: "manual"`, `custom_instructions: null`) → `SessionStart source: compact` (carries `model: "claude-sonnet-5"`) → `PostCompact` (`trigger`, `compact_summary`) → `SessionEnd`; **no `UserPromptSubmit`**, and the four compact-side payloads share a `prompt_id` that no `UserPromptSubmit` announced. The stream shows `system/status {status: "compacting"}` and `system/compact_boundary` (`compact_metadata.trigger: "manual"`, `pre_tokens: 43978`, `post_tokens: 5724`) |
| 4 | `pwd`, then `HOST_TEST_DONE` | 136–141 | `SessionStart source: resume`, `UserPromptSubmit`, one `Bash`, `Stop`, `SessionEnd` |

Agents (all four `SubagentStart` payloads carry the root `session_id`, their
own `agent_id`, `agent_type`, `prompt_id`, `cwd`, root `transcript_path` — and
no parent field):

| Agent | `agent_type` | Spawned by | Mode | Depth | Rows | Own hook payloads |
| --- | --- | --- | --- | --- | --- | --- |
| `aa618caf4dda3c6e7` | `Explore` | root, `toolu_01GxPPCab38aUmoupqtiwmPd` (row 12) | background | 1 | 14–57 | 18 (10 `Bash`, 2 `ToolSearch`, 2 `dump`, 2 `probe`, start/stop) |
| `aa75e336e8b0d3b74` | `general-purpose` | root, `toolu_016atrNxHkNGwWeGRNhwTns2` (row 15) | background | 1 | 16–61 | 18 (2 `Skill`, 2 `ToolSearch`, 8 `Bash`, 2 `dump`, 2 `probe`, start/stop) |
| `a5dc6534fe667e88c` | `general-purpose` | root, `toolu_01YDsqdXAwPCMJs8QUD8rWgf` (row 64) | foreground | 1 | 65–100 | 16 (2 `Skill`, 2 `Bash`, 2 `ToolSearch`, 2 `probe`, 4 `dump` incl. one failure, 2 `Agent`, start/stop) |
| `ac26f10e077adc16f` | `general-purpose` | `a5dc6534fe667e88c`, `toolu_01Pf4k3nYyroKWyHFA3VEKa4` (row 81) | foreground | 2 | 82–98 | 14 (2 `Skill`, 2 `Bash`, 2 `ToolSearch`, 2 `probe`, 4 `dump` incl. one failure, start/stop) |

Findings specific to this run:

- **Parallel spawns are serialised in the hook stream.** Two `Agent` calls in
  one assistant message arrived as `PreToolUse(Explore)` row 12 →
  `PostToolUse` row 13 (`async_launched`, `agentId` = `aa618…`) →
  `SubagentStart(aa618…)` row 14 → `PreToolUse(general-purpose)` row 15 →
  `SubagentStart(aa75e…)` row 16 → `PostToolUse` row 17. A `SubagentStart`
  never fired while two spawns from the same parent were unclaimed, so the
  registry attributed each child to its own `Agent` call with a certain
  `toolCallId` (no `siblingsUncertain` cohort); the replay test asserts the
  four `toolCallId`s against the host's own `tool_response.agentId` and the
  stream's `task_started` envelopes.
- **The `Explore` agent has the plugin's MCP tools.** It called `dump` and
  `probe` (rows 26–31) and reported them available; nothing distinguishes its
  hook payloads from a `general-purpose` agent's apart from `agent_type`.
- **Skill invocation shows up as a `Skill` tool call**, `tool_input:
  {"skill":"host-test:host-test"}`, `tool_response: {"success":true,
  "commandName":"host-test:host-test"}` — at the root (row 106, the scenario
  asked for it) and, unprompted, in all three `general-purpose` subagents
  (rows 20, 66, 83). No skill-specific hook event exists; the `Skill` call is
  the only trace.
- **`PostToolUseFailure`** (rows 77, 94, 116) carries `tool_name`,
  `tool_input`, `tool_use_id`, `error` (a string), `is_interrupt: false`,
  `duration_ms`, plus `agent_id`/`agent_type` when raised inside a subagent
  (rows 77, 94) — the same lineage carrier as `PostToolUse`. The registry
  treats it as the closing edge of the pre-tool window; nothing stayed open.
  All three failures were the probe's own `dump` tool exceeding the runtime's
  Agent Document node limit once the live log held ~180 records (`error:
  "Agent Document node count exceeds 10000"`); the model recovered by
  retrying with `limit`. Fixed in this PR: a bare `dump` now returns the
  newest 50 records (`DEFAULT_DUMP_LIMIT`), `matched` still counts the log.
- **New root-side fields.** `SessionStart source: resume` adds
  `seconds_since_last_response`, `context_tokens`,
  `prompt_cache_likely_expired`, `estimated_cache_write_usd`; `source:
  compact` adds `model`. The host's `ScheduleWakeup` tool appeared while the
  root waited for background children (rows 18, 59, 62; `tool_input:
  {delaySeconds, reason, prompt: "<<autonomous-loop-dynamic>>", noop: true}`,
  then `{stop: true}`). `permission_mode` is on 112 of 127 payloads (absent
  from SessionStart, SubagentStart, SessionEnd, PreCompact, PostCompact);
  `effort` on 108 (additionally absent from UserPromptSubmit);
  `PostToolUseFailure` carries both. `prompt_id` is on everything except the
  four non-compact SessionStart payloads — the `source: compact` one carries
  the compaction's `prompt_id`.
- **Turn boundaries.** Four `UserPromptSubmit` payloads (rows 2, 58, 105,
  137), four distinct `prompt_id`s; the sequential and nested spawns ran under
  the `<task-notification>` prompt (row 58), and the registry's `generation`
  on their lineage is that `prompt_id`. Each `-p` process produced exactly one
  `SessionEnd` (rows 103, 130, 135, 141), while `Stop` follows the prompt
  path: twice in turn 1 (row 34 before the re-prompt, row 102 after), once in
  turns 2 and 4 (rows 129, 140), never in the `/compact` turn; resuming
  re-registers nothing new — the root node stays the same and every resumed
  root-side hook still resolves `depth 0, resolution: native`.
- **MCP correlation held at every depth.** The five `probe` calls (rows 29,
  42, 74, 91, 120) carry `_meta["claudecode/toolUseId"]` equal to the open
  `PreToolUse` `tool_use_id` of the calling agent — depth 1 (three agents),
  depth 2 (row 91, the nested agent), depth 0 (row 120) — with client info
  `claude-code 2.1.259`. The generated `dump` tool's `request.lineage` resolved
  live at depth 0 (rows 8, 114, 118), depth 1 (27, 39, 75, 79) and, for the
  first time live, depth 2 (rows 92, 96). All 11 MCP `PostToolUse` payloads
  carry a string `tool_response`.
- **Model stream versus hooks.** `system/task_started` names each child as
  `task_id` = the hook `agent_id`, `tool_use_id` = the spawning `Agent`
  call, `subagent_type`, `is_backgrounded` (true for the parallel pair, false
  for the sequential and nested spawns) and **`spawn_depth`** (1, 1, 1, 2) —
  the only place Claude Code states a depth outright. Every `assistant`/`user`
  envelope produced inside a depth-1 child carries `parent_tool_use_id` = that
  `Agent` call; the 8 + 8 + 7 `tool_use` ids in those child streams all
  appear as `PreToolUse` under the matching `agent_id`. **The nested agent's
  traffic is not in the stream at all**: depth 2 is visible only through
  hooks. Turn 1 produced two `system/init` and two `result` envelopes from one
  process because the `<task-notification>` re-prompt ran inside it.
  `system/hook_started`/`hook_response` envelopes name each hook the host ran
  (`hook_name: "SessionStart:startup"`).
- **Compaction is inducible** by sending `/compact` as a resumed `-p` prompt;
  auto-compaction was not attempted (the session peaked at ~44k context
  tokens), so `trigger: "auto"` remains unobserved.

### Codex CLI 0.147.0

| Event (native) | `session_id`* | `agent_id` | `agent_type` | `turn_id` | `tool_use_id` | `transcript_path` / `agent_transcript_path` | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SessionStart | root thread | — | — | — | — | root rollout | `model`, `permission_mode`, `source` |
| UserPromptSubmit | root | — | — | root turn | — | root rollout | `prompt`, `model`, `permission_mode` |
| PreToolUse / PostToolUse (root turn) | root | — | — | root turn | `exec-<uuid>` (shell/patch/MCP) or `call_<id>` (collaboration tools) | root rollout | `tool_name` is `Bash`, `apply_patch`, `mcp__host_test__dump`, `collaborationspawn_agent`, `collaborationwait_agent`; `tool_response` is a string for shell/patch and an object for MCP |
| PreToolUse / PostToolUse (inside a subagent) | **root** | **subagent thread** (`01a06660-8faf-…`) | `default` | **subagent's own turn** | | **the subagent's own rollout** | |
| PreToolUse / PostToolUse (inside the nested thread) | **root** | **nested thread** (`01a06661-100a-…`) | `default` | nested turn | | nested rollout | no reference to the parent thread |
| SubagentStart | root | new thread | `default` | new thread's turn | — | **the new thread's own rollout** | `model`, `permission_mode`; **no parent id** |
| SubagentStop | root | stopping thread | `default` | its turn | — | `transcript_path` = **the parent thread's rollout**, `agent_transcript_path` = own rollout | `stop_hook_active`, `last_assistant_message` |
| Stop | root | — | — | root turn | — | root rollout | `last_assistant_message` |
| SessionEnd | root | — | — | — | — | root rollout | `reason: "other"`; delivered only after the MCP-hosted runtime had exited, so it ran through the standalone fallback |

The `message` argument of `collaborationspawn_agent` reaches hooks
**encrypted** (`gAAAA…` token), so a hook cannot read the child's task text.
Codex writes `Skill descriptions were shortened…` and hook-trust warnings as
`item.type: "error"` stream items; they are advisory.

Payload excerpt (SubagentStop of the nested thread — parent recoverable only
from the rollout filename in `transcript_path`):

```json
{"session_id":"01a06660-110e-7290-8d1c-8ef1b2b68fc2","turn_id":"01a06661-1086-75c0-abff-e27b0913fccf","transcript_path":"…/rollout-2026-09-03T08-26-39-01a06660-8faf-7122-80af-24ba2da81ad7.jsonl","agent_transcript_path":"…/rollout-2026-09-03T08-27-12-01a06661-100a-7ad3-a0f5-b0e6ffdb4b11.jsonl","cwd":"/tmp/host-test/codex-workspace","hook_event_name":"SubagentStop","model":"gpt-5.6-sol","permission_mode":"bypassPermissions","stop_hook_active":false,"agent_id":"01a06661-100a-7ad3-a0f5-b0e6ffdb4b11","agent_type":"default","last_assistant_message":"…"}
```

### Cursor 3.18.25 (desktop)

| Event (native) | `conversation_id`* | `session_id`* | `generation_id` | `subagent_id` / `tool_call_id` | `parent_conversation_id` | `is_parallel_worker` | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| beforeSubmitPrompt | root | = conversation_id | per generation | — | — | — | `prompt`, `attachments`, `model`, `model_id`, `composer_mode`, `cursor_version`, `workspace_roots`, `transcript_path: null` |
| preToolUse / postToolUse (root) | root | = conversation_id | per generation | `tool_use_id` (`call-<uuid>-<n>\nfc_<id>_<k>` for model tools, plain uuid for `Shell` and `MCP:*`) | — | — | `tool_name` (`Read`, `Grep`, `Shell`, `Write`, `Task`, `MCP:dump`, `MCP:probe`), `tool_input`, `tool_output` (JSON string, Post), `duration` (Post), `cwd: ""` on `Shell`, `model: ""` on `Task` |
| preToolUse / postToolUse (inside a subagent) | **a new conversation id** (`bf617dfd-…`) | = that new id | new | tool_use_id | **absent** | **absent** | **nothing in the payload names the parent** |
| preToolUse / postToolUse (inside the nested agent) | another new id (`46efda32-…`) | = id | new | | absent | absent | |
| subagentStart | **the parent's** conversation id | = parent | **equals the conversation id** (not a generation) | `subagent_id` = `tool_call_id` = the parent's `Task` `tool_use_id` (a two-line composite) | = conversation_id | `false` | `subagent_type`, `subagent_model`, `task` (full prompt), parent `transcript_path`; **the child's conversation id is not included** |
| subagentStop | parent's | = parent | = conversation id | `subagent_id` | = conversation_id | — | `status`, `duration_ms`, `message_count`, `tool_call_count`, `loop_count`, `task`, `description`, `agent_transcript_path: null` |
| stop | root | = root | root generation | — | — | — | `status`, `loop_count`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, root `transcript_path` |

Not delivered to the plugin in this run: `sessionStart` (never fired for the
plugin; the sibling raw-hooks probe on the same build saw none either),
`workspaceOpen` (fired to user-level hooks only), `sessionEnd` (nothing arrived
when the window was closed with the agent idle), `postToolUseFailure`,
`preCompact`. §9 below shows that on a real desktop `workspaceOpen`,
`sessionEnd`, and (on 3.18.25) `sessionStart` *do* reach plugin-scoped hooks,
while `subagentStart`/`subagentStop` — delivered in this isolated run — were
not dispatched at all on the maintainer's daily instance of the same build
(§9.1). `preToolUse` was delivered twice for some `Read`/`Grep` calls with the
same `tool_use_id` (pairs 3/4, 9/10, … in the fixture).

Payload excerpt (subagentStart — the only place the parent link exists, and it
does not name the child conversation):

```json
{"conversation_id":"b60ae0c1-2f85-4c4d-b3e5-b512f9b06e4c","generation_id":"b60ae0c1-2f85-4c4d-b3e5-b512f9b06e4c","model":"default","subagent_id":"call-2ec9530d-b502-4c4f-8a6e-63f0bf7ebc9a-29\nfc_49466487-df47-9fb4-8b10-079ee845fb97_0","subagent_type":"general-purpose","task":"…","parent_conversation_id":"b60ae0c1-2f85-4c4d-b3e5-b512f9b06e4c","tool_call_id":"call-2ec9530d-…\nfc_49466487-…_0","subagent_model":"default","is_parallel_worker":false,"session_id":"b60ae0c1-2f85-4c4d-b3e5-b512f9b06e4c","hook_event_name":"subagentStart","cursor_version":"3.18.25","workspace_roots":["/tmp/host-test/cursor-workspace"],"user_email":"…","transcript_path":"…/agent-transcripts/b60ae0c1-…/b60ae0c1-….jsonl"}
```

## 2. Which id a subagent's own events carry

| Host | Root events carry | Subagent events carry | Nested events carry | Parent named on the child's events? | Parent named on subagent start/stop? |
| --- | --- | --- | --- | --- | --- |
| Claude | `session_id` | root `session_id` + own `agent_id` | root `session_id` + own `agent_id` | no | no on SubagentStart/SubagentStop (only `agent_id` of the child); **yes, after the fact, on the parent's `Agent` PostToolUse** (`tool_response.agentId` = child, delivered with the parent's `agent_id` or none for the root) and on the root's `<task-notification>` UserPromptSubmit (`task-id` + `tool-use-id`) for background children. Outside hooks, the `stream-json` `system/task_started` envelope names child (`task_id`), spawn call (`tool_use_id`) and `spawn_depth` for depth-1 and depth-2 children alike (orchestration run) |
| Codex | `session_id` (= root thread), `turn_id` | root `session_id` + own `agent_id` (= thread id) + own `turn_id` | same shape | no | not on start; **stop** carries the parent's rollout path in `transcript_path` |
| Cursor | `conversation_id` (= `session_id`) + `generation_id` | **a fresh `conversation_id`** with no marker | fresh `conversation_id` | **no** | yes — `parent_conversation_id` on start/stop, but the child's conversation id is absent, so the link is only closable by ordering |

Depth: every host allowed depth 2 in this scenario (Codex configured
`max_depth = 3`; Claude reported `subagent_stats.max_depth: 2` and
`spawned_by_subagents: 1` in both 2.1.257 runs; Cursor ran a nested `Task`).
None emits a depth counter **to hooks**; Claude Code's `stream-json`
transcript does (`task_started.spawn_depth`, orchestration run), but that
stream goes to the operator's terminal, not to plugins.

## 3. Hook ↔ MCP ordering and what the MCP server can see

Ordering was identical on all three hosts: the pre-tool hook for the MCP call
fires, then the MCP server receives `tools/call`, then the post-tool hook
fires (fixture rows Claude 25→26→27 and 37→38→39, Codex 9→10→11, Cursor
81→82→83). The live Claude model also issued `dump` and `probe` **in
parallel** at the root (rows 9, 10 PreToolUse → 11, 12 `tools/call` → 13, 14
PostToolUse; *fg* rows 9, 11 → 10, 12 → 13, 14), so two pre-tool windows were
open at once; `claudecode/toolUseId` names the right one regardless.

| Host | Pre-tool hook `tool_name` for an MCP call | `tool_use_id` | MCP `tools/call` `_meta` | Client info | MCP session id | Can the server correlate without hooks? |
| --- | --- | --- | --- | --- | --- | --- |
| Claude | `mcp__plugin_host-test_host-test__dump` | `toolu_…` | `{ progressToken, "claudecode/toolUseId": "<the same toolu_ id>" }` (live: rows 10↔12 `toolu_01BBNfLZrRqRXfVbbLRzaKQf`, 25↔26 `toolu_01Hojb1ZwFe73yWWxFcnGo4W`, 37↔38 `toolu_01Ga8ivarupF77BLsip9NMuH`, one per depth; orchestration run: five probes at depths 1, 1, 1, 2, 0, rows 29, 42, 74, 91, 120) | `claude-code` 2.1.257 / 2.1.259 | none (stdio) | **Yes** — `claudecode/toolUseId` equals the hook's `tool_use_id`; the hook supplies `session_id`/`agent_id`. The generated `dump` tool's `request.lineage` resolved through the registry at depth 0 and depth 1 (rows 11, 29, 43; *fg* 10, 26) with `generation` = the root turn's `prompt_id`; the orchestration run's nested agent called `dump` twice, so depth 2 now resolves live as well (orchestration rows 92, 96) |
| Codex | `mcp__host_test__dump` | `exec-<uuid>` | `{ progressToken, plugin_id, threadId, "x-codex-turn-metadata": { session_id, thread_id, turn_id, parent_thread_id?, forked_from_thread_id?, thread_source: "user"|"subagent", subagent_kind?, sandbox, workspaces{…git commit…}, model, reasoning_effort, turn_started_at_unix_ms } }` | `codex-mcp-client` 0.147.0 | none | **Yes, fully** — lineage (thread, parent, root) is in `_meta` itself |
| Cursor | `MCP:dump` | plain uuid | `{ progressToken }` only | `cursor-vscode` 1.0.0 | none | **No** — only the pre-tool hook (tool name + ordering) can attach a conversation |

Claude's `PostToolUse` for MCP tools delivers `tool_response` as a **plain
string** (the tool's text content, here the JSON text of the result), not an
object; the framework's pinned validator rejected every such event (`native
tool_response must be an object`, confirmed in the host's `--debug hooks` log
and by a raw user-level hook that captured the payload verbatim). Fixed in PR
#421: presence is now the only host-independent rule, matching Codex. The live
model confirms the split — all 6 (*fg*: 5) MCP PostToolUse payloads carry a
string, all 10 (*fg*: 14) built-in-tool PostToolUse payloads (`Bash`, `Write`,
`ToolSearch`, `Skill`, `Agent`) carry an object — and every one of the 16
(*fg*: 19) `tool_use` blocks in the host's own transcripts has a matching
PreToolUse and PostToolUse record, so no live payload was rejected.

## 4. Environment variable names seen by plugin processes (names only)

| Host | Hook process (standalone wrapper) | MCP server process |
| --- | --- | --- |
| Claude | `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CONFIG_DIR`, `CLAUDE_ENV_FILE`, `CLAUDE_PID`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR` (the stand-in run additionally showed the `ANTHROPIC_*` variables it was given; the live run, authenticated from the isolated credentials file, shows none) | `AGENT_BUNDLE_PLUGIN_ROOT`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CONFIG_DIR`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR` |
| Codex | `CODEX_HOME`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `PLUGIN_DATA`, `PLUGIN_ROOT` (full operator environment inherited, e.g. `HOST_TEST_LOG_DIR`) | `AGENT_BUNDLE_PLUGIN_ROOT` only — Codex does **not** pass the operator environment to MCP servers |
| Cursor | `CURSOR_EXTENSION_HOST_ROLE`, `CURSOR_PLUGIN_ROOT`, `CURSOR_PROJECT_DIR`, `CURSOR_USER_EMAIL`, `CURSOR_VERSION`, `CURSOR_WORKSPACE_LABEL`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR` | `AGENT_BUNDLE_PLUGIN_ROOT` (+ the IDE's inherited environment) |

`CLAUDE_CODE_SESSION_ID` is the only per-conversation id any host exposes
through the environment, and it is the root session, not the subagent. Cursor
gives shell commands the agent runs `CURSOR_CONVERSATION_ID`/`CURSOR_REQUEST_ID`
(observed in this operator's own shell), but hook processes receive neither.

## 5. Answers to the maintainer's question

**Can the root plugin know its children?**

| Host | Answer | How |
| --- | --- | --- |
| Claude | Yes, with the parent inferred | `SubagentStart` names the child (`agent_id`). The parent is not in the payload; it is the agent whose `Agent`/`Task` `PreToolUse` is open when `SubagentStart` fires (root when none is open) — re-verified live at depth 1 and 2 in all three runs, including two spawns issued in one message (the host serialises them: each `SubagentStart` fires before the next `Agent` `PreToolUse` opens). The host then confirms the link on the parent's `Agent` `PostToolUse` (`tool_response.agentId` = the child, `status` `async_launched` or `completed`). `Stop`/`SubagentStop` list the children still running **in the background** in `background_tasks[]` (empty when every child ran in the foreground). |
| Codex | Yes | `SubagentStart` names the child thread and its rollout (`transcript_path`); the rollout's `session_meta` head records `source.subagent.thread_spawn.{parent_thread_id, depth, agent_path}` (§10), so the parent is read, not inferred. The `collaborationspawn_agent` call is matched to the child by `agent_path` (= the call's `PostToolUse` `tool_response.task_name`, rows 16/27). With the rollout unreadable, the parent is inferred from the newest unclaimed spawn call and corrected at `SubagentStop` — from the child's own rollout (`agent_transcript_path`) when readable by then, else from the parent rollout in `transcript_path`. MCP calls carry `parent_thread_id` directly. |
| Cursor | Yes for the spawn, weakly for the child's traffic | `subagentStart` carries `parent_conversation_id`, `subagent_id`/`tool_call_id`, `is_parallel_worker`. The child's own `conversation_id` is not in that payload, so the first event with an unseen conversation id after a `subagentStart` is bound to it (unambiguous when children start sequentially; ambiguous for parallel workers). |

**Can a plugin running under a subagent know its parent/root?**

| Host | Root | Parent |
| --- | --- | --- |
| Claude | Yes — `session_id` on every event is the root session (re-verified live: all 42 + 46 + 127 hook payloads across the three runs carry the root id — through resumed turns and a compaction too — and `CLAUDE_CODE_SESSION_ID` in every plugin process is the root id) | Only through the runtime's registry (placed at `SubagentStart`, confirmed by the parent's `Agent` PostToolUse); nothing in the child's payload |
| Codex | Yes — `session_id` is the root thread on every event, and `_meta.x-codex-turn-metadata.session_id` on MCP calls | Yes on MCP calls (`parent_thread_id`); on hooks from the thread's own rollout head, which every hook inside the thread names in `transcript_path` (§10) — even in a standalone hook process with no registry |
| Cursor | Only through the registry — a child's payload carries neither root nor parent | Only through the registry (ordering-bound) |

**Operator identity is out of scope.** The maintainer decided on 2026-09-03
(#391, closed as not planned) that agent-bundle will not derive or surface who
the human behind a host session is; the fields some hosts send for that are
passed through inside `native` unread, and `request.lineage` — parent session,
root, and the parent-of-subagent chain — is the only identity-adjacent surface.

## 6. Framework consequences landed with this audit

- `request.lineage` on `AgentRequestContext` (events, generated MCP tools,
  routed CLI, rendered scripts): `{ conversation, generation?, parent?, root,
  depth, subagent? }` resolved by the runtime-held registry described in
  `docs/entry-conventions.md`, or a typed `unavailable` reason
  (`no-subagent-events`, `id-not-resolvable`, `cloud-agent-no-user-hooks`,
  `no-shared-runtime`, `unsupported-surface`).
- Hook→MCP correlation: Codex from `_meta`, Claude from
  `claudecode/toolUseId`, Cursor from the open `MCP:<tool>` pre-tool hook.
- Claude `PostToolUse` string `tool_response` (MCP tools) accepted.
- Codex hook-side parent and depth read from the thread's own rollout head
  (§10; `resolution: 'transcript'`), with the spawn call matched by
  `agent_path`; `SubagentStop` corrects an inferred parent from the parent
  rollout it names; standalone Codex hooks resolve the same way
  (`resolveStandaloneLineage`). Landed after #444 for #423.

## 7. Gaps and host-blocked items

| Gap | Host | Evidence | Status |
| --- | --- | --- | --- |
| No parent id on `SubagentStart`; child events carry no parent | Claude | §1, §2 | Inferred from the newest unclaimed spawn call under the same root; refused when two parents have unclaimed spawns; filed as #422 |
| No parent id on `SubagentStart`; child events carry no parent | Codex | §1, §2, §10 | Ours: read from the thread's own rollout head (`thread_spawn.parent_thread_id`, `depth`), which every hook names in `transcript_path`; spawn call matched by `agent_path`; inferred parent corrected at `SubagentStop`. Remaining host-side: the payload itself carries no `parent_thread_id`, so a hook on a machine that cannot read `CODEX_HOME/sessions` (or a rollout not yet flushed) falls back to inference (#423) |
| Child conversation id absent from `subagentStart`; child events carry no parent/root | Cursor | §1, §2 | Bound by elimination in the registry (single pending start per workspace); refused while ambiguous for parallel workers; filed as #424 |
| `_meta` carries no conversation/tool-call id | Cursor | §3 | Hook-correlated only; filed |
| ~~`sessionStart` never dispatched on the desktop~~ | Cursor | §1, §9 | Closed 2026-09-04: 3.18.25 desktop dispatches `sessionStart` to plugin-scoped hooks for newly created root chats — not for resumed roots or `Task` children (§9.1); the 0× count came from 3.14.7 launches only. Lineage still treats it as one root-shaped event among several rather than a prerequisite, because roots are routinely first seen mid-conversation (§9) |
| `subagentStart`/`subagentStop` dispatch varies by instance on 3.18.25: delivered in the isolated §1 run, never requested on the maintainer's daily instance (six `Task` runs, §9.1) | Cursor | §1, §9.1 | Host-side; where the start is not delivered the child is first seen on its own tool hook with no pending start to bind to, so `request.lineage` reports `id-not-resolvable` for it rather than inferring a parent |
| Roots first seen on a tool hook (Cursor restart or plugin load mid-conversation) | Cursor | §9 | Ours: workspace-scoped child binding plus correction (subtree re-rooted) when a bound conversation later carries a root-only event (the registry's Cursor root set — in practice `sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `stop` or `preCompact`; see §9.1) |
| Cursor CLI not exercised | Cursor | table above | Needs a signed-in `cursor-agent`; not attempted on the operator's account |
| ~~Claude session used a scripted model~~ | Claude | §8 | Closed 2026-09-03: two live-model sessions replace the stand-in fixture; every stand-in claim held, see §8 |
| ~~Claude `PostToolUse(Agent).tool_response.agentId` not consumed by the registry~~ | Claude | §1, §2 | Closed 2026-09-03 (#422 follow-up PR): the registry now treats the parent's `Agent` PostToolUse as the host's word on the edge — it confirms the spawn-window match (`resolution: confirmed` once every edge to the root is host-named), fills in sibling `toolCallId`s claimed blind, places a `SubagentStart` no window could (an unplaced start keeps id/type/time/stop, and any confirmations it issued for its own children, until its edge is known), moves a child filed under the wrong parent and re-bases its descendants, and holds a child named before its start (orchestration row 13 → 14). Replays of the orchestration capture with row 64 or row 81 withheld recover the sequential agent and the depth-2 child from rows 99/101 alone |
| ~~Claude interactive OAuth session expired; refresh fails~~ | Claude | header table | Closed 2026-09-03: after the operator signed in again, the unmodified harness (`probe:install claude` byte-for-byte copy of `~/.claude/.credentials.json`) produced the signed-in 2.1.259 orchestration session. The two 2.1.257 runs had used a one-off re-seed of the isolated `.credentials.json` outside the harness (`docs/audits/2026-09-03-claude-live-session-proofs.md`); no credential-handling code was ever added |
| `stream-json` shows depth-1 subagent traffic only | Claude | §1 (orchestration run) | The nested agent's 7 tool calls appear in hooks (with its `agent_id`) but in no stream envelope; `task_started` still announces it with `spawn_depth: 2`. Hooks remain the only complete lineage source; recorded, no framework impact |
| Auto-compaction (`PreCompact trigger: "auto"`) not induced | Claude | §1 (orchestration run) | Manual `/compact` as a resumed `-p` prompt fires `PreCompact` → `SessionStart source: compact` → `PostCompact`; the automatic path would need a session near the context limit and was not attempted |
| ~~Probe `dump` fails on a large log~~ | Claude (probe) | §1 (orchestration run, `PostToolUseFailure` rows 77, 94, 116) | Fixed in this PR: `DEFAULT_DUMP_LIMIT = 50` newest records unless `limit` is given (`examples/host-test`) |

## 8. Stand-in versus live model (Claude, 2026-09-03)

PR #421 captured Claude Code 2.1.257 with a scripted Anthropic Messages API
behind `ANTHROPIC_BASE_URL` because the OAuth session on this machine had
expired. The three live sessions above were driven by the real model
(`claude-sonnet-5`) through the same probe, authenticated as described in the
header table. What changed and what did not:

| Claim from the stand-in run | Live result | Verdict |
| --- | --- | --- |
| Root knows children via `SubagentStart`/`SubagentStop` `agent_id` + root `session_id` | Rows 16/45 and 32/40 (primary), *fg* 16/48 and 38/46 | Held |
| Child events carry the root `session_id` and their own `agent_id`, never a parent | Every subagent and nested hook payload in both runs | Held |
| MCP correlation via `_meta["claudecode/toolUseId"]` = the open `PreToolUse` `tool_use_id` | Three probes per run, one per depth, all equal; still exact when two MCP calls ran in parallel | Held, strengthened |
| Depth 2 reachable; `subagent_stats.max_depth: 2` | Both runs | Held |
| `PostToolUse` `tool_response` is a string for MCP tools, an object otherwise | 6 strings / 10 objects (primary), 5 / 14 (*fg*) | Held |
| `SubagentStart` has no `permission_mode` | Held; **new**: `permission_mode` is on everything else except SessionStart/SessionEnd, and `effort: {"level":"high"}` is on every PreToolUse/PostToolUse/SubagentStop/Stop | Corrected (fields the stand-in never showed; both already lifted by the framework) |
| `background_tasks[]` "lists every running subagent" | Lists **background** subagents only (`status: running`), including the stopping agent on its own `SubagentStop`; empty when children run in the foreground | Corrected |
| Spawns return `status: "async_launched"`, the root `Stop` fires while children run, and `<task-notification>` prompts re-enter the root | Reproduced by the live host when `run_in_background` was unset (primary run); with `run_in_background: false` the `Agent` call blocks and returns `status: "completed"` with `agentType`, `content[]`, `usage`, `toolStats` (nested spawn; both *fg* spawns) | Held for the background path; the foreground path is new |
| Parent link only inferable from the open spawn call | `PostToolUse(Agent).tool_response.agentId` names the child in both paths | New host fact; registry unchanged |
| Model calls MCP tools directly | Live model first calls `ToolSearch` (`select:<tool names>`, `total_deferred_tools: 21`), and the subagent invoked the plugin's `Skill` (`host-test:host-test`) | New tool names in the hook stream; no framework impact |
| Hook process environment carries `ANTHROPIC_*` | Only the stand-in's injected variables; the live run shows none | Stand-in artefact |
| `PostToolUseFailure` "not observed" | Emitted by 2.1.259 for a failed MCP tool call, at the root and inside subagents, with the same `session_id`/`agent_id` carrier as `PostToolUse` (orchestration rows 77, 94, 116) | Corrected: observed; the registry already closed windows on `tool/failure` |
| `PreCompact`/`PostCompact` "not observed" | Fired by a manual `/compact` sent as a resumed `-p` prompt, bracketing a `SessionStart source: compact`; root-only, no `agent_id`, own `prompt_id` (orchestration rows 132–134) | Corrected: inducible on demand |
| Two spawns in one message would leave the registry's `toolCallId` uncertain (`siblingsUncertain`) | The host serialised them: `SubagentStart` for the first fired before the second `Agent` `PreToolUse` opened, so both claims were certain and agree with `tool_response.agentId` and the stream's `task_started` | Held stronger than assumed |
| Single-turn `-p` sessions only | Four `-p` turns resumed into one `session_id`; `SessionStart source: resume`, one `SessionEnd` per invocation while `Stop` follows the prompt path (two in turn 1 around the `<task-notification>` re-prompt, none in the `/compact` turn), root-side lineage unchanged across turns | New coverage; no framework impact |

No lineage or projection code change was needed: the registry replay test
(`packages/rsc-runtime/tests/lineage-registry.test.ts`) now runs against all
three live fixtures — the orchestration case additionally cross-checks every
registry claim against the model's `stream-json` transcript — and passes
unchanged apart from asserting the new host facts. The one product change is
in the probe itself (`dump` default limit, §7).

## 9. Cursor desktop hooks-service evidence (added 2026-09-03)

Cursor desktop keeps a per-window hooks log
(`~/.config/Cursor/logs/<launch>/<window>/output_*/cursor.hooks.workspaceId-*.log`)
that prints `Hook step requested: <event>` for **every** step before it looks
up declared hooks — 58,717 `preToolUse` steps appear with no hook declared for
them — so an absent step is non-dispatch, not a registration problem. The
retained logs on the maintainer's machine (89,219 steps: 89,218 from the
five 3.14.7 launches, 2026-08-13 → 2026-08-28 — every one of their 59,455
`cursor_version` stamps reads 3.14.7; the remaining steps are requests with
no matching hook, which log no payload — plus the first step of the
2026-09-03 3.18.25 launch; 35 conversations; a local plugin declaring `sessionStart`, `sessionEnd`,
`workspaceOpen`, `stop`, `postToolUse`, `preCompact`, `afterFileEdit`,
`afterShellExecution`) show:

| Step | Requested | Delivered to the plugin-scoped hook (`from claude-plugin config`) |
| --- | --- | --- |
| `preToolUse` | 58,717 | n/a (not declared) |
| `postToolUse` | 29,308 | yes |
| `afterShellExecution` | 887 | yes |
| `afterFileEdit` | 270 | yes |
| `workspaceOpen` | 12 | yes — sessionless envelope |
| `stop` | 8 | yes |
| `beforeSubmitPrompt` | 7 | yes — `prompt`, `attachments[]`, `composer_mode`, `generation_id` |
| `sessionEnd` | 6 | yes — `reason: window_close`, `final_status: none`, `duration_ms`, `is_background_agent: false`, `session_id` = `conversation_id`, `generation_id: ""`, `transcript_path: null` |
| `preCompact` | 4 | yes |
| **`sessionStart`** | **0** | — (superseded by §9.1: 3.18.25 does dispatch it) |

Consequences for lineage:

- `workspaceOpen` and `sessionEnd` are confirmed plugin-scoped deliveries on
  the desktop; the §1 run missed them because the Xvfb CLI session never
  closed a window. `sessionStart` was a 3.14.7 gap only (§9.1).
- Only 7 of the 35 conversations ever produced `beforeSubmitPrompt`; 28 were
  first seen on `postToolUse`/`preToolUse`/`afterShellExecution` (the log
  starts mid-conversation after a Cursor restart, or the plugin loaded
  mid-conversation). `transcript_path` is `null` on 98.5 % of desktop events,
  so it cannot mark roots either. A registry that binds the next unseen
  conversation to a lone pending `subagentStart` can therefore mis-bind a
  second chat tab; the registry now scopes binding to the same
  `workspace_roots` and undoes a binding when the bound conversation later
  receives `beforeSubmitPrompt`, which a subagent never does.
- No `Task` tool call appears in these desktop logs, so desktop
  `subagentStart`/`subagentStop` delivery is unobserved here; see §9.1, which
  closes that gap with a live `Task` run.

### 9.1 Re-check on Cursor desktop 3.18.25 (added 2026-09-04)

Same machine, same workspace (`19017dde…`), the maintainer's daily desktop
instance (`/usr/share/cursor`, workbench `280eca29`), hooks log
`~/.config/Cursor/logs/20260904T071544/window2_wb1/output_20260904T071550/cursor.hooks.workspaceId-19017dde….log`,
plugins `~/.cursor/plugins/local/tracedecay` (no matchers; `afterFileEdit`,
`afterShellExecution`, `postToolUse`, `preCompact`, `sessionEnd`,
`sessionStart`, `stop`, `workspaceOpen`) and `~/.cursor/plugins/local/cargo-hauler`
(an agent-bundle emitted `cursor` pack: `preToolUse`/`postToolUse` `^Shell$`,
`sessionStart`, `stop`). No `~/.cursor/hooks.json`, no project `hooks.json`.
Two root chats ran in the window, both resumed conversations rather than
newly created ones. Between them they launched six `Task` subagents — from
this chat a backgrounded `explore` (`d103df27-…`, 61 hook deliveries), a
foreground `general-purpose` (`300d51aa-…`, one `echo` step), a backgrounded
`ci-watcher` (`ba44c20f-…`, 643 deliveries over 17 minutes) and a
`change-risk-reviewer` (`025d6ca6-…`); the other root launched two more
(`217f76a2-…`, `228cecfe-…`) — which controls for subagent type,
backgrounding and lifetime. The service interleaves concurrent hook blocks
in the log, so every count below attributes a payload by the
`conversation_id` inside its own JSON block, never by proximity. Counts are
as of 2026-09-04T08:14Z.

| Fact | 3.14.7 record (§9) | 3.18.25 observed 2026-09-04 |
| --- | --- | --- |
| `sessionStart` to plugin-scoped hooks | 0× requested | **dispatched for newly created root chats**: 6× across the two earlier 3.18.25 launches (`20260903T041607`, `20260904T062311`; 2026-09-03T20:30Z → 2026-09-04T06:42Z), each the first event its conversation ever logged, `is_background_agent: false`, `composer_mode: "agent"`, every one `Found n hook(s) … from claude-plugin config`; payload `conversation_id` = `session_id`, `generation_id: ""`, `model`, `model_id`, `model_params`, `is_background_agent`, `composer_mode`, `cursor_version`, `workspace_roots`, `user_email`, `transcript_path: null`. **Not requested** for a resumed root (this window's two roots: 0×) nor for any of the six `Task` children. The §9 0× is a 3.14.7 result: 89,218 of those 89,219 steps came from the 3.14.7 launches; the one remaining step was the first of the 2026-09-03 3.18.25 launch |
| Tool events to plugin-scoped hooks | yes | yes — in this window: `preToolUse` 3,635, `postToolUse` 1,912, `afterShellExecution` 227, `afterFileEdit` 60, `stop` 7, `preCompact` 1, `workspaceOpen` 1 requested; the emitted pack's `^Shell$` hooks ran from the plugin root with `${CURSOR_PLUGIN_ROOT}` expanded |
| Duplicate `preToolUse` for one `tool_use_id` | seen for `Read`/`Grep` in the §1 capture | none among the delivered `preToolUse` (all `Shell`; `Read`/`Grep` had no `preToolUse` hook declared, so unobserved for those tools). A `postToolUse` appearing twice in the log is two plugins (`Found 2 hook(s)`), not a duplicate delivery |
| `subagentStart` / `subagentStop` | unobserved on the desktop (§9); delivered in the isolated §1 run | **not requested at all** for any of the six `Task` runs — no `Hook step requested: subagentStart`/`subagentStop`, and no `preToolUse`/`postToolUse` naming `tool_name: "Task"`, neither while the children ran nor after they finished. No retained desktop log on this machine (3.14.7 or 3.18.25, 95,674 steps) has ever requested either step. Same build as §1, so delivery of the subagent family varies by instance or account state |
| A subagent's own hooks | fresh `conversation_id`, nothing names the parent | same: all six children's events (`preToolUse`/`postToolUse`/`afterShellExecution`) carry their own `conversation_id` = `session_id`, their own `generation_id`, `transcript_path: null`, no parent/root field |
| Root-only events on a subagent | never | never — none of the six children produced `stop`, `preCompact` or `sessionStart`; the window's 7 `stop` requests (28 payloads across four hooks) all carry one of the two roots' `conversation_id`. The roots also carry a non-null `transcript_path`, but one root's earliest events had `transcript_path: null` before its transcript file existed, so null does not mark a child either |
| `cwd: ""` on `Shell` payloads | yes | yes |

Consequences: the `sessionStart` row in §7 is closed and #424 gap 4 with it.
`sessionStart` marks creation, not resumption: a resumed root still arrives
mid-conversation with no start, which is why lineage keeps treating it as one
root-shaped event among several rather than a prerequisite.
Where an instance does not deliver `subagentStart`, there is nothing for the
registry to bind a child to, so `request.lineage` for that child is
`id-not-resolvable` (`ensureRoot` finds no pending start and the event is not
root-shaped, so no node is created), which is the honest answer; nothing binds
blind. The root-only-event correction stays justified because a desktop child
still never carries any event in the registry's Cursor root set
(`CURSOR_ROOT_EVENTS` in `packages/rsc-runtime/src/lineage/registry.ts`:
canonical `session/start`, `session/end`, `prompt/submit`, `stop`,
`compact/before`, `compact/after`, `workspace/open` — on Cursor that means
`sessionStart`, `sessionEnd`, `beforeSubmitPrompt`, `stop` or `preCompact`,
since the host documents no post-compact hook and `workspaceOpen` is
sessionless). No framework code changes follow from this re-check.


## 10. Codex rollout heads: the parent the hook payloads omit (added 2026-09-03)

Every Codex hook payload names a rollout file. Inside a subagent thread it is
the thread's own (`transcript_path` on `SubagentStart` and on every tool hook,
fixture rows 17, 19–27, 28, 30–36; `agent_transcript_path` on `SubagentStop`,
rows 37 and 39, where `transcript_path` is the **parent's** rollout). The
rollout basename is `rollout-<YYYY-MM-DDTHH-MM-SS>-<thread id>.jsonl`, and its
first line is a `session_meta` item. For a spawned thread that line carries the
edge the hook payload does not:

```json
{"type":"session_meta","payload":{"id":"<thread>","session_id":"<root>","parent_thread_id":"<parent>","forked_from_id":"<parent>",
 "source":{"subagent":{"thread_spawn":{"parent_thread_id":"<parent>","depth":2,"agent_path":"/root/host_probe/nested_probe","agent_nickname":"…","agent_role":null}}},
 "thread_source":"subagent","agent_path":"/root/host_probe/nested_probe","cli_version":"0.147.0", …}}
```

Checked on the capturing machine's own `~/.codex/sessions` (8,567 rollouts,
cli 0.130.0 → 0.152.0): all 8,049 `thread_spawn` rollouts carry
`source.subagent.thread_spawn.parent_thread_id` and `depth`; `agent_path`
is present from 0.141.0 on (absent on 839 older rollouts, `null` inside
`thread_spawn` on ≤0.136.0); the top-level `parent_thread_id` copy appears
later than the nested one. Roots carry a string `source` (`exec`, `cli`,
`vscode`) and `thread_source: "user"`; host-internal helpers carry
`{"subagent":{"other":"guardian"}}` with no spawn lineage. First-line size:
13–43 KiB (`base_instructions` is inlined). The `agent_path` equals the
`spawn_agent` `PostToolUse` `tool_response.task_name` (`/root/host_probe`,
`/root/host_probe/nested_probe`, rows 16 and 27), which is how the spawning
call is matched to the child without relying on order.

`fixtures/host-lineage/codex-0.147.0-rollouts/` holds one head per thread of
the capture in this shape (ids, paths, agent paths, and commit from the
capture; long strings redacted — see its README). The registry reads the head
the payload names, verifies `payload.id` equals the payload's `agent_id`, and
places the thread with `resolution: 'transcript'`; the MCP `_meta` lineage
(§3) and the hook-side lineage therefore agree by construction. What stays
host-side: the payload itself still carries no `parent_thread_id`, so a hook
that cannot read `CODEX_HOME/sessions` (or a rollout not yet flushed) falls
back to spawn-ordering inference and is corrected at `SubagentStop` (from the
child's own rollout when readable by then, else from the parent rollout's
basename).
