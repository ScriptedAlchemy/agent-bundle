# Host lineage evidence matrix — what each host tells a plugin about conversations and subagents

Date: 2026-09-03. Probe: `examples/host-test` (this repository, built from the
same commit as this document) installed into isolated homes under
`/tmp/host-test/<host>-home` through `agent-bundle install <host>`; the real
`~/.claude`, `~/.codex`, and `~/.cursor` were never written (Claude's sign-in
was seeded into the isolated home outside the harness; see the Claude row). Every
number below comes from the redacted capture logs checked in under
`fixtures/host-lineage/` (`claude-2.1.257.ndjson`,
`claude-2.1.257-foreground.ndjson`, `codex-0.147.0.ndjson`,
`cursor-3.18.25.ndjson`); ids are quoted as recorded, e-mail addresses and the
operator home directory are redacted, and long tool payloads are clipped.

| Host | Binary observed | Session driver | Subagent mechanism exercised | Depth reached |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.257 (`claude -p`, `--dangerously-skip-permissions`, `--model sonnet` → `claude-sonnet-5`) | **Live model, 2026-09-03, Claude Code 2.1.257.** `probe:install claude` copied the operator's `~/.claude/.credentials.json` byte-for-byte as documented, but that interactive session had expired (`claude auth status` on the real home → `loggedIn: false`; a turn in the isolated home → "Failed to authenticate: OAuth session expired and could not be refreshed"), so the isolated `CLAUDE_CONFIG_DIR`'s `.credentials.json` was re-seeded with the operator's long-lived `claude setup-token` token by a **one-off local step outside the checked-in harness** (an uncommitted local edit of `probe:install`, discarded afterwards; `docs/audits/2026-09-03-claude-live-session-proofs.md`). The harness itself is unchanged and reads no sign-in state beyond that copy; the real `~/.claude` was never written. `claude auth status` in the isolated home → `loggedIn: true`, `authMethod: claude.ai`, `subscriptionType: max`. Two sessions were captured: the primary fixture, where Claude Code ran the root's `Agent` in the background, and `-foreground`, where both spawns blocked. An earlier capture on the same day used a scripted Messages-API stand-in (PR #421); its findings are re-verified against the live runs in §8. | `Agent` tool (`subagent_type: general-purpose`), subagent spawned a nested `Agent` | 2 (`subagent_stats.max_depth: 2`, `spawned_by_subagents: 1`) |
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

Not observed in either scenario (the host did not emit them): `Notification`,
`PermissionRequest`/`PermissionDenied` (permissions were bypassed),
`PreCompact`/`PostCompact`, `FileChanged`, `ConfigChange`, `TaskCreated`/
`TaskCompleted`, `TeammateIdle`, `StopFailure`, `PostToolUseFailure`.

Payload excerpt (SubagentStart of the nested agent, row 32 — note the absence
of any parent field):

```json
{"session_id":"7f7a50ca-3609-4612-8db1-a34c8985088a","transcript_path":"…/-tmp-host-test-claude-workspace/7f7a50ca-….jsonl","cwd":"/tmp/host-test/claude-workspace","prompt_id":"a78d8bed-e865-426a-a3e4-ee9ce500493c","agent_id":"a9bc7270b816a535e","agent_type":"general-purpose","hook_event_name":"SubagentStart"}
```

Payload excerpt (root `Stop`, row 18, fired while the background subagent was
still running — the only Claude payload that names a live child other than
SubagentStart):

```json
{"session_id":"7f7a50ca-…","prompt_id":"a78d8bed-…","permission_mode":"bypassPermissions","effort":{"level":"high"},"hook_event_name":"Stop","stop_hook_active":false,"last_assistant_message":"Steps 1-5 are complete; the subagent is running in the background. …","background_tasks":[{"id":"aebe95b6e051369a4","type":"subagent","status":"running","description":"Host-test probe subagent","agent_type":"general-purpose"}],"session_crons":[]}
```

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
`preCompact`. §9 below shows that on a real desktop `workspaceOpen` and
`sessionEnd` *do* reach plugin-scoped hooks and only `sessionStart` never
does. `preToolUse` was delivered twice for some `Read`/`Grep` calls with the
same `tool_use_id` (pairs 3/4, 9/10, … in the fixture).

Payload excerpt (subagentStart — the only place the parent link exists, and it
does not name the child conversation):

```json
{"conversation_id":"b60ae0c1-2f85-4c4d-b3e5-b512f9b06e4c","generation_id":"b60ae0c1-2f85-4c4d-b3e5-b512f9b06e4c","model":"default","subagent_id":"call-2ec9530d-b502-4c4f-8a6e-63f0bf7ebc9a-29\nfc_49466487-df47-9fb4-8b10-079ee845fb97_0","subagent_type":"general-purpose","task":"…","parent_conversation_id":"b60ae0c1-2f85-4c4d-b3e5-b512f9b06e4c","tool_call_id":"call-2ec9530d-…\nfc_49466487-…_0","subagent_model":"default","is_parallel_worker":false,"session_id":"b60ae0c1-2f85-4c4d-b3e5-b512f9b06e4c","hook_event_name":"subagentStart","cursor_version":"3.18.25","workspace_roots":["/tmp/host-test/cursor-workspace"],"user_email":"…","transcript_path":"…/agent-transcripts/b60ae0c1-…/b60ae0c1-….jsonl"}
```

## 2. Which id a subagent's own events carry

| Host | Root events carry | Subagent events carry | Nested events carry | Parent named on the child's events? | Parent named on subagent start/stop? |
| --- | --- | --- | --- | --- | --- |
| Claude | `session_id` | root `session_id` + own `agent_id` | root `session_id` + own `agent_id` | no | no on SubagentStart/SubagentStop (only `agent_id` of the child); **yes, after the fact, on the parent's `Agent` PostToolUse** (`tool_response.agentId` = child, delivered with the parent's `agent_id` or none for the root) and on the root's `<task-notification>` UserPromptSubmit (`task-id` + `tool-use-id`) for background children |
| Codex | `session_id` (= root thread), `turn_id` | root `session_id` + own `agent_id` (= thread id) + own `turn_id` | same shape | no | not on start; **stop** carries the parent's rollout path in `transcript_path` |
| Cursor | `conversation_id` (= `session_id`) + `generation_id` | **a fresh `conversation_id`** with no marker | fresh `conversation_id` | **no** | yes — `parent_conversation_id` on start/stop, but the child's conversation id is absent, so the link is only closable by ordering |

Depth: every host allowed depth 2 in this scenario (Codex configured
`max_depth = 3`; Claude reported `subagent_stats.max_depth: 2` and
`spawned_by_subagents: 1` in both live runs; Cursor ran a nested `Task`). None
emits a depth counter.

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
| Claude | `mcp__plugin_host-test_host-test__dump` | `toolu_…` | `{ progressToken, "claudecode/toolUseId": "<the same toolu_ id>" }` (live: rows 10↔12 `toolu_01BBNfLZrRqRXfVbbLRzaKQf`, 25↔26 `toolu_01Hojb1ZwFe73yWWxFcnGo4W`, 37↔38 `toolu_01Ga8ivarupF77BLsip9NMuH`, one per depth) | `claude-code` 2.1.257 | none (stdio) | **Yes** — `claudecode/toolUseId` equals the hook's `tool_use_id`; the hook supplies `session_id`/`agent_id`. The generated `dump` tool's `request.lineage` resolved through the registry at depth 0 and depth 1 (rows 11, 29, 43; *fg* 10, 26) with `generation` = the root turn's `prompt_id`; neither live nested agent called `dump`, so depth 2 is resolved only in the replay test |
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
| Claude | Yes, with the parent inferred | `SubagentStart` names the child (`agent_id`). The parent is not in the payload; it is the agent whose `Agent`/`Task` `PreToolUse` is open when `SubagentStart` fires (root when none is open) — re-verified live at depth 1 and 2 in both runs. The host then confirms the link on the parent's `Agent` `PostToolUse` (`tool_response.agentId` = the child, `status` `async_launched` or `completed`). `Stop`/`SubagentStop` list the children still running **in the background** in `background_tasks[]` (empty when every child ran in the foreground). |
| Codex | Yes | `SubagentStart` names the child thread; the parent is inferred from the open `collaborationspawn_agent` call and confirmed at `SubagentStop` by the parent rollout in `transcript_path`. MCP calls carry `parent_thread_id` directly. |
| Cursor | Yes for the spawn, weakly for the child's traffic | `subagentStart` carries `parent_conversation_id`, `subagent_id`/`tool_call_id`, `is_parallel_worker`. The child's own `conversation_id` is not in that payload, so the first event with an unseen conversation id after a `subagentStart` is bound to it (unambiguous when children start sequentially; ambiguous for parallel workers). |

**Can a plugin running under a subagent know its parent/root?**

| Host | Root | Parent |
| --- | --- | --- |
| Claude | Yes — `session_id` on every event is the root session (re-verified live: all 42 + 46 hook payloads across both runs carry the root id, `CLAUDE_CODE_SESSION_ID` in every plugin process is the root id) | Only through the runtime's registry (inferred at `SubagentStart`); nothing in the child's payload |
| Codex | Yes — `session_id` is the root thread on every event, and `_meta.x-codex-turn-metadata.session_id` on MCP calls | Yes on MCP calls (`parent_thread_id`); on hooks only through the registry (or the parent rollout at `SubagentStop`) |
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

## 7. Gaps and host-blocked items

| Gap | Host | Evidence | Status |
| --- | --- | --- | --- |
| No parent id on `SubagentStart`; child events carry no parent | Claude, Codex | §1, §2 | Inferred from the newest unclaimed spawn call under the same root; refused when two parents have unclaimed spawns; filed as #422 / #423 |
| Child conversation id absent from `subagentStart`; child events carry no parent/root | Cursor | §1, §2 | Bound by elimination in the registry (single pending start per workspace); refused while ambiguous for parallel workers; filed as #424 |
| `_meta` carries no conversation/tool-call id | Cursor | §3 | Hook-correlated only; filed |
| `sessionStart` never dispatched on the desktop (`workspaceOpen`/`sessionEnd` are) | Cursor | §1, §9 | Host-side (#424 gap 4); lineage never depends on it to establish a root |
| Roots first seen on a tool hook (Cursor restart or plugin load mid-conversation) | Cursor | §9 | Ours: workspace-scoped child binding plus correction (subtree re-rooted) when a bound conversation later carries a root-only event (`beforeSubmitPrompt`, `stop`, `sessionEnd`, `preCompact`) |
| Cursor CLI not exercised | Cursor | table above | Needs a signed-in `cursor-agent`; not attempted on the operator's account |
| ~~Claude session used a scripted model~~ | Claude | §8 | Closed 2026-09-03: two live-model sessions replace the stand-in fixture; every stand-in claim held, see §8 |
| Claude `PostToolUse(Agent).tool_response.agentId` not consumed by the registry | Claude | §1, §2 | The registry claims the newest unclaimed spawn under the root at `SubagentStart` and marks same-parent sibling cohorts `siblingsUncertain`; the parent's `Agent` PostToolUse could later firm those up. Not needed for either live run (spawns were sequential); left as an improvement |
| Claude interactive OAuth session expired; refresh fails | Claude | header table | The checked-in harness only copies `~/.claude/.credentials.json` byte-for-byte, so `probe:install claude` cannot start a signed-in isolated session until the operator signs in again. For the live runs the isolated `.credentials.json` was re-seeded, by a one-off local step outside the harness, with the operator's long-lived `claude setup-token` token; the opt-in proofs ran with `HOME` pointed at an isolated home seeded the same way (`docs/audits/2026-09-03-claude-live-session-proofs.md`). No credential-handling code was added to the harness |

## 8. Stand-in versus live model (Claude, 2026-09-03)

PR #421 captured Claude Code 2.1.257 with a scripted Anthropic Messages API
behind `ANTHROPIC_BASE_URL` because the OAuth session on this machine had
expired. The two live sessions above were driven by the real model
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

No lineage or projection code change was needed: the registry replay test
(`packages/rsc-runtime/tests/lineage-registry.test.ts`) now runs against both
live fixtures and passes unchanged apart from asserting the new
`tool_response.agentId` host fact.

## 9. Cursor desktop hooks-service evidence (added 2026-09-03)

Cursor desktop keeps a per-window hooks log
(`~/.config/Cursor/logs/<launch>/<window>/output_*/cursor.hooks.workspaceId-*.log`)
that prints `Hook step requested: <event>` for **every** step before it looks
up declared hooks — 58,717 `preToolUse` steps appear with no hook declared for
them — so an absent step is non-dispatch, not a registration problem. The
retained logs on the maintainer's machine (cursor_version 3.14.7 for
2026-08-14 → 2026-08-25, 3.18.25 on 2026-09-03; 89,219 steps; 35
conversations; a local plugin declaring `sessionStart`, `sessionEnd`,
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
| **`sessionStart`** | **0** | — |

Consequences for lineage:

- `workspaceOpen` and `sessionEnd` are confirmed plugin-scoped deliveries on
  the desktop; the §1 run missed them because the Xvfb CLI session never
  closed a window. Only `sessionStart` remains a host gap (#424 gap 4).
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
  `subagentStart`/`subagentStop` delivery is unobserved here; the §1 CLI
  capture remains the evidence for the subagent families.

