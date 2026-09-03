# Host lineage evidence matrix — what each host tells a plugin about conversations and subagents

Date: 2026-09-03. Probe: `examples/host-test` (this repository, built from the
same commit as this document) installed into isolated homes under
`/tmp/host-test/<host>-home` through `agent-bundle install <host>`; the real
`~/.claude`, `~/.codex`, and `~/.cursor` were never opened. Every number below
comes from the redacted capture logs checked in under `fixtures/host-lineage/`
(`claude-2.1.257.ndjson`, `codex-0.147.0.ndjson`, `cursor-3.18.25.ndjson`);
ids are quoted as recorded, e-mail addresses and the operator home directory
are redacted, and long tool payloads are clipped.

| Host | Binary observed | Session driver | Subagent mechanism exercised | Depth reached |
| --- | --- | --- | --- | --- |
| Claude Code | 2.1.257 (`claude -p`, `--dangerously-skip-permissions`) | Real Claude Code process; the model was a scripted stand-in behind `ANTHROPIC_BASE_URL` because this machine has no signed-in Claude account (`claude auth status` → `loggedIn: false`). Hooks, MCP, and subagent plumbing are the host's own. | `Agent` tool (`subagent_type: general-purpose`), subagent spawned a nested `Agent` | 2 |
| Codex CLI | 0.147.0 (`codex exec --json --dangerously-bypass-hook-trust`, `[features] multi_agent`, `[agents] max_depth = 3`) | Real model (`gpt-5.6-sol`) with the operator's `auth.json` copied byte-for-byte into the isolated `CODEX_HOME` | `collaborationspawn_agent` (`fork_turns: all`), the spawned thread spawned a nested thread | 2 |
| Cursor IDE | 3.18.25 desktop, isolated `--user-data-dir` on Xvfb, `cursorAuth/*` profile rows transplanted, driven over CDP in the Agents pane (`Auto` model) | Real model | `Task` tool (`subagent_type: general-purpose`), the subagent spawned a nested `Task` | 2 |
| Cursor CLI (`cursor-agent`) | 2026.08.31 build present | **Not driven**: `cursor-agent status` → `Not logged in`, and logging in requires a browser flow. | — | — |
| Portable (Agent Plugins 1.0.0) | — | No hooks surface exists in the contract, so nothing to capture. | — | — |

Terminology: "root" is the conversation the user typed into; "subagent" is a
child spawned by the root; "nested" is a child of that subagent. `*` marks a
field the framework already lifts into the request context.

## 1. Ids present per host × event (as delivered to plugin hooks)

### Claude Code 2.1.257

| Event (native) | `session_id`* | `agent_id` | `agent_type` | `tool_use_id` | `prompt_id` | `transcript_path` / `agent_transcript_path` | Other |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SessionStart | root | — | — | — | — | root transcript | `source`, `cwd`, no `permission_mode` |
| UserPromptSubmit | root | — | — | — | yes | root | `prompt`, `permission_mode` |
| PreToolUse / PostToolUse (root turn) | root | — | — | `toolu_…` | yes | root | `tool_name`, `tool_input`, `tool_response`, `duration_ms` (Post) |
| PreToolUse / PostToolUse (inside a subagent) | **root** | **subagent's** (`aca96ce761c9f0cea`) | `general-purpose` | `toolu_…` | root's | root transcript (not the subagent's) | same |
| PreToolUse / PostToolUse (inside the nested agent) | **root** | **nested's** (`ac093bdad0566ffa7`) | `general-purpose` | | root's | root | no reference to `aca96…` |
| SubagentStart | root | the new agent | `general-purpose` | — | yes | root transcript | **no parent agent id** |
| SubagentStop | root | the stopping agent | `general-purpose` | — | yes | root transcript + `agent_transcript_path` = `<session>/subagents/agent-<id>.jsonl` (flat; nested agent's path does not name its parent) | `stop_hook_active`, `last_assistant_message`, `background_tasks[]` (lists every running subagent with `id`, `type: subagent`, `agent_type`, `description`), `session_crons` |
| Stop | root | — | — | — | yes | root | `background_tasks[]`, `session_crons` |
| SessionEnd | root | — | — | — | yes | root | `reason` |

Not observed in the scenario (the host did not emit them): `Notification`,
`PermissionRequest`/`PermissionDenied` (permissions were bypassed),
`PreCompact`/`PostCompact`, `FileChanged`, `ConfigChange`, `TaskCreated`/
`TaskCompleted`, `TeammateIdle`, `StopFailure`, `PostToolUseFailure`.

Payload excerpt (SubagentStart of the nested agent — note the absence of any
parent field):

```json
{"session_id":"a7f96472-e9d0-447a-826d-36da9b635fd6","transcript_path":"…/-tmp-host-test-claude-workspace/a7f96472-….jsonl","cwd":"/tmp/host-test/claude-workspace","prompt_id":"96a54da1-f00b-48ec-8f84-2d42b7de5ba4","agent_id":"ac093bdad0566ffa7","agent_type":"general-purpose","hook_event_name":"SubagentStart"}
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

| Event (native) | `conversation_id`* | `session_id`* | `generation_id` | `subagent_id` / `tool_call_id` | `parent_conversation_id` | `is_parallel_worker` | `user_email` | Other |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| beforeSubmitPrompt | root | = conversation_id | per generation | — | — | — | yes | `prompt`, `attachments`, `model`, `model_id`, `composer_mode`, `cursor_version`, `workspace_roots`, `transcript_path: null` |
| preToolUse / postToolUse (root) | root | = conversation_id | per generation | `tool_use_id` (`call-<uuid>-<n>\nfc_<id>_<k>` for model tools, plain uuid for `Shell` and `MCP:*`) | — | — | yes | `tool_name` (`Read`, `Grep`, `Shell`, `Write`, `Task`, `MCP:dump`, `MCP:probe`), `tool_input`, `tool_output` (JSON string, Post), `duration` (Post), `cwd: ""` on `Shell`, `model: ""` on `Task` |
| preToolUse / postToolUse (inside a subagent) | **a new conversation id** (`bf617dfd-…`) | = that new id | new | tool_use_id | **absent** | **absent** | yes | **nothing in the payload names the parent** |
| preToolUse / postToolUse (inside the nested agent) | another new id (`46efda32-…`) | = id | new | | absent | absent | yes | |
| subagentStart | **the parent's** conversation id | = parent | **equals the conversation id** (not a generation) | `subagent_id` = `tool_call_id` = the parent's `Task` `tool_use_id` (a two-line composite) | = conversation_id | `false` | yes | `subagent_type`, `subagent_model`, `task` (full prompt), parent `transcript_path`; **the child's conversation id is not included** |
| subagentStop | parent's | = parent | = conversation id | `subagent_id` | = conversation_id | — | yes | `status`, `duration_ms`, `message_count`, `tool_call_count`, `loop_count`, `task`, `description`, `agent_transcript_path: null` |
| stop | root | = root | root generation | — | — | — | yes | `status`, `loop_count`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, root `transcript_path` |

Not delivered to the plugin in this run: `sessionStart` (never fired for the
plugin; the sibling raw-hooks probe on the same build saw none either),
`workspaceOpen` (fired to user-level hooks only), `sessionEnd` (nothing arrived
when the window was closed with the agent idle), `postToolUseFailure`,
`preCompact`. `preToolUse` was delivered twice for some `Read`/`Grep` calls
with the same `tool_use_id` (pairs 3/4, 9/10, … in the fixture).

Payload excerpt (subagentStart — the only place the parent link exists, and it
does not name the child conversation):

```json
{"conversation_id":"b60ae0c1-2f85-4c4d-b3e5-b512f9b06e4c","generation_id":"b60ae0c1-2f85-4c4d-b3e5-b512f9b06e4c","model":"default","subagent_id":"call-2ec9530d-b502-4c4f-8a6e-63f0bf7ebc9a-29\nfc_49466487-df47-9fb4-8b10-079ee845fb97_0","subagent_type":"general-purpose","task":"…","parent_conversation_id":"b60ae0c1-2f85-4c4d-b3e5-b512f9b06e4c","tool_call_id":"call-2ec9530d-…\nfc_49466487-…_0","subagent_model":"default","is_parallel_worker":false,"session_id":"b60ae0c1-2f85-4c4d-b3e5-b512f9b06e4c","hook_event_name":"subagentStart","cursor_version":"3.18.25","workspace_roots":["/tmp/host-test/cursor-workspace"],"user_email":"probe@example.invalid","transcript_path":"…/agent-transcripts/b60ae0c1-…/b60ae0c1-….jsonl"}
```

## 2. Which id a subagent's own events carry

| Host | Root events carry | Subagent events carry | Nested events carry | Parent named on the child's events? | Parent named on subagent start/stop? |
| --- | --- | --- | --- | --- | --- |
| Claude | `session_id` | root `session_id` + own `agent_id` | root `session_id` + own `agent_id` | no | no (only `agent_id` of the child) |
| Codex | `session_id` (= root thread), `turn_id` | root `session_id` + own `agent_id` (= thread id) + own `turn_id` | same shape | no | not on start; **stop** carries the parent's rollout path in `transcript_path` |
| Cursor | `conversation_id` (= `session_id`) + `generation_id` | **a fresh `conversation_id`** with no marker | fresh `conversation_id` | **no** | yes — `parent_conversation_id` on start/stop, but the child's conversation id is absent, so the link is only closable by ordering |

Depth: every host allowed depth 2 in this scenario (Codex configured
`max_depth = 3`; Claude reported `subagent_stats.max_depth: 2`; Cursor ran a
nested `Task`). None emits a depth counter.

## 3. Hook ↔ MCP ordering and what the MCP server can see

Ordering was identical on all three hosts: the pre-tool hook for the MCP call
fires, then the MCP server receives `tools/call`, then the post-tool hook
fires (fixture rows Claude 5→6, Codex 9→10→11, Cursor 81→82→83).

| Host | Pre-tool hook `tool_name` for an MCP call | `tool_use_id` | MCP `tools/call` `_meta` | Client info | MCP session id | Can the server correlate without hooks? |
| --- | --- | --- | --- | --- | --- | --- |
| Claude | `mcp__plugin_host-test_host-test__dump` | `toolu_…` | `{ progressToken, "claudecode/toolUseId": "<the same toolu_ id>" }` | `claude-code` 2.1.257 | none (stdio) | **Yes** — `claudecode/toolUseId` equals the hook's `tool_use_id`; the hook supplies `session_id`/`agent_id` |
| Codex | `mcp__host_test__dump` | `exec-<uuid>` | `{ progressToken, plugin_id, threadId, "x-codex-turn-metadata": { session_id, thread_id, turn_id, parent_thread_id?, forked_from_thread_id?, thread_source: "user"|"subagent", subagent_kind?, sandbox, workspaces{…git commit…}, model, reasoning_effort, turn_started_at_unix_ms } }` | `codex-mcp-client` 0.147.0 | none | **Yes, fully** — lineage (thread, parent, root) is in `_meta` itself |
| Cursor | `MCP:dump` | plain uuid | `{ progressToken }` only | `cursor-vscode` 1.0.0 | none | **No** — only the pre-tool hook (tool name + ordering) can attach a conversation |

Claude's `PostToolUse` for MCP tools delivers `tool_response` as an **array of
content blocks**, not an object; the framework's pinned validator rejected
every such event (`native tool_response must be an object`, confirmed in the
host's `--debug hooks` log). Fixed in this change set.

## 4. Environment variable names seen by plugin processes (names only)

| Host | Hook process (standalone wrapper) | MCP server process |
| --- | --- | --- |
| Claude | `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CONFIG_DIR`, `CLAUDE_ENV_FILE`, `CLAUDE_PID`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR` (+ inherited `ANTHROPIC_*`) | `AGENT_BUNDLE_PLUGIN_ROOT`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CONFIG_DIR`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR` |
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
| Claude | Yes, with the parent inferred | `SubagentStart` names the child (`agent_id`). The parent is not in the payload; it is the agent whose `Agent`/`Task` `PreToolUse` is open when `SubagentStart` fires (root when none is open). `Stop`/`SubagentStop` also list every running child in `background_tasks[]`. |
| Codex | Yes | `SubagentStart` names the child thread; the parent is inferred from the open `collaborationspawn_agent` call and confirmed at `SubagentStop` by the parent rollout in `transcript_path`. MCP calls carry `parent_thread_id` directly. |
| Cursor | Yes for the spawn, weakly for the child's traffic | `subagentStart` carries `parent_conversation_id`, `subagent_id`/`tool_call_id`, `is_parallel_worker`. The child's own `conversation_id` is not in that payload, so the first event with an unseen conversation id after a `subagentStart` is bound to it (unambiguous when children start sequentially; ambiguous for parallel workers). |

**Can a plugin running under a subagent know its parent/root?**

| Host | Root | Parent |
| --- | --- | --- |
| Claude | Yes — `session_id` on every event is the root session | Only through the runtime's registry (inferred at `SubagentStart`); nothing in the child's payload |
| Codex | Yes — `session_id` is the root thread on every event, and `_meta.x-codex-turn-metadata.session_id` on MCP calls | Yes on MCP calls (`parent_thread_id`); on hooks only through the registry (or the parent rollout at `SubagentStop`) |
| Cursor | Only through the registry — a child's payload carries neither root nor parent | Only through the registry (ordering-bound) |

**Actor principal facts** (for #391): Cursor delivers `user_email` on every hook
payload and `CURSOR_USER_EMAIL` in the hook environment; Claude and Codex
deliver no user identity to hooks or MCP servers.

## 6. Framework consequences landed with this audit

- `request.lineage` on `AgentRequestContext` (events, generated MCP tools,
  routed CLI, rendered scripts): `{ conversation, generation?, parent?, root,
  depth, subagent? }` resolved by the runtime-held registry described in
  `docs/entry-conventions.md`, or a typed `unavailable` reason
  (`no-subagent-events`, `id-not-resolvable`, `cloud-agent-no-user-hooks`,
  `no-shared-runtime`, `unsupported-surface`).
- Hook→MCP correlation: Codex from `_meta`, Claude from
  `claudecode/toolUseId`, Cursor from the open `MCP:<tool>` pre-tool hook.
- Claude `PostToolUse` array `tool_response` accepted.

## 7. Gaps and host-blocked items

| Gap | Host | Evidence | Status |
| --- | --- | --- | --- |
| No parent id on `SubagentStart`; child events carry no parent | Claude, Codex | §1, §2 | Inferred from the open spawn tool call; filed as a host request |
| Child conversation id absent from `subagentStart`; child events carry no parent/root | Cursor | §1, §2 | Ordering-bound in the registry; ambiguous for parallel workers; filed |
| `_meta` carries no conversation/tool-call id | Cursor | §3 | Hook-correlated only; filed |
| `sessionStart`, `workspaceOpen`, `sessionEnd` not delivered to plugin hooks | Cursor | §1 | Recorded; owned by the Cursor installer/emitter lane for follow-up |
| Cursor CLI not exercised | Cursor | table above | Needs a signed-in `cursor-agent`; not attempted on the operator's account |
| Claude session used a scripted model | Claude | table above | Host plumbing is real; model text is not evidence of anything |
