# Host lineage observations (2026-09-03)

Internal reference, scoped to conversation lineage only: which conversation a
hook belongs to, who its parent is, what its root is, and — for subagents —
the parent-of-subagent chain. Nothing here concerns operator or user identity;
agent-bundle does not surface it (#391, closed as not planned by the
maintainer on 2026-09-03).

Maintainer decision (2026-09-03): these observations are **not** submitted to
Cursor, Anthropic, or OpenAI. They are kept so the capability tables, the
lineage registry's inference rules, and any re-check against a newer host
build have a precise baseline. Each host section ends with what a future host
build would have to carry for the corresponding `lineage` rows to move from
`degraded` to `supported`; that is a description of the gap, not a request.

Evidence for every claim is in-repo: `docs/audits/2026-09-03-host-lineage-matrix.md`
(§1–§3 live captures, §9 desktop hooks-service logs) and
`fixtures/host-lineage/{claude-2.1.257,codex-0.147.0,cursor-3.18.25}.ndjson`.
Trackers: #422 (Claude), #423 (Codex), #424 (Cursor).

## Cursor (hooks, desktop 3.14.7 / 3.18.25 and cursor-agent CLI) — #424

Subagent hooks cannot be tied to their parent conversation by payload alone,
and `sessionStart` is never dispatched on the desktop.

Observed (Cursor 3.18.25 desktop plugin hooks, one `Task` subagent that
spawned a nested `Task`):

1. `subagentStart` / `subagentStop` are delivered to the **parent**
   conversation with `subagent_id` (= the parent's `Task` `tool_call_id`),
   `parent_conversation_id`, `subagent_type`, `is_parallel_worker` — but not
   the child's `conversation_id`.
2. Every hook fired **inside** the subagent carries a fresh `conversation_id`
   and nothing else: no `parent_conversation_id`, no `subagent_id`, no root,
   `transcript_path` empty. The nested subagent is the same.
3. MCP `tools/call` `_meta` carries only `progressToken` (client
   `cursor-vscode` 1.0.0), so an MCP server cannot tell which conversation is
   calling it except by pairing with the `preToolUse` `MCP:<tool>` hook that
   preceded it.
4. In 89,219 hook steps logged by the desktop hooks service (3.14.7 and
   3.18.25, `cursor.hooks.*.log`), `sessionStart` was requested 0 times while
   `sessionEnd` (6), `workspaceOpen` (12), `beforeSubmitPrompt` (7), and
   `stop` (8) were; the cursor-agent CLI with trusted project hooks does
   dispatch it. The docs list `sessionStart` as an Agent hook with an
   `additional_context` output, so this is a desktop dispatch gap rather than
   a documentation one.
5. `preToolUse` is sometimes delivered twice for the same `tool_use_id`
   (`Read`, `Grep`); the framework dedupes.

Consequence: when two subagents are pending at once (parallel workers, or two
windows), nothing in the payloads says which fresh `conversation_id` belongs
to which `subagentStart`. The registry binds by elimination (a lone pending
start in the same `workspace_roots`), refuses otherwise, and undoes a binding
when the bound conversation later carries a root-only event.

What would close the gap on the host side (not requested):

- the child `conversation_id` on `subagentStart` and `subagentStop`;
- `parent_conversation_id` (and ideally `root_conversation_id`) on every hook
  payload fired inside a subagent conversation;
- the calling `conversation_id` and the pre-tool `tool_use_id` in
  `tools/call` `_meta`, as Claude Code (`claudecode/toolUseId`) and Codex
  (`x-codex-turn-metadata`) carry;
- `sessionStart` dispatched on the desktop.

## Claude Code (hooks, 2.1.257) — #422

`SubagentStart` and a subagent's own hooks name no parent agent. Every hook
payload names the root (`session_id`) and, inside a subagent, the subagent
(`agent_id`, `agent_type`). What is missing is the edge: which agent spawned
this one.

Observed with `claude -p`, one `Agent` subagent that spawned a nested `Agent`:

1. `SubagentStart` / `SubagentStop` carry the child's `agent_id` and
   `agent_type` but no spawning `agent_id` and no spawning `tool_use_id`.
2. Hooks fired inside the subagent carry `session_id` (root) and `agent_id`
   (self); the nested subagent's hooks look the same, so depth is unknown.
3. `agent_transcript_path` is flat (`<session>/subagents/agent-<id>.jsonl`)
   and does not encode the parent.
4. `background_tasks[]` on `Stop`/`SubagentStop` lists running subagents as a
   flat set with no edges.
5. The parent's `Agent` `PostToolUse` `tool_response.agentId` names the child
   after the fact (live-model runs, matrix §8).
6. `PostToolUse.tool_response` for MCP tools is a plain string where the docs
   describe an object; the framework accepts both.

The registry infers the parent as the agent whose `Agent`/`Task` `PreToolUse`
is the newest unclaimed spawn when `SubagentStart` fires; that is exact for
sequential spawns and refused when two agents spawn concurrently.

What would close the gap on the host side (not requested): `parent_agent_id`
(or the spawning `tool_use_id`) on `SubagentStart` and `SubagentStop`, and the
same field on every hook payload fired inside a subagent, so a nested agent's
hooks name their parent and depth follows.

## Codex CLI (hooks, 0.147.0, `[features] multi_agent`) — #423

Hook payloads lag the MCP `_meta` lineage: `SubagentStart` names no parent
thread. The MCP side is complete — `tools/call`
`_meta["x-codex-turn-metadata"]` carries `session_id`, `thread_id`,
`parent_thread_id`, `forked_from_thread_id`, `thread_source`,
`subagent_kind`, `turn_id` — but the hook side does not carry the same edge.

Observed with `codex exec --json`, one `collaborationspawn_agent` thread that
spawned a nested thread:

1. `SubagentStart` carries `agent_id` (= thread id), `agent_type`, `turn_id`,
   and the root `session_id`, but no `parent_thread_id`.
2. Hooks inside a subagent carry `session_id` (root) and `agent_id` (self);
   only `SubagentStop` hints at the parent, through `transcript_path` being
   the parent's rollout while `agent_transcript_path` is the child's.
3. The `spawn_agent` `PreToolUse` `tool_input.message` arrives encrypted, and
   its `PostToolUse` (`{"task_name": …}`, no child id) fires *before*
   `SubagentStart`, so the spawn call cannot be matched to the child by id.

The registry infers the parent by claiming the newest unclaimed spawn call
under the same root and refuses when two parents have unclaimed spawns.

What would close the gap on the host side (not requested): `parent_thread_id`
(already in `x-codex-turn-metadata`) on `SubagentStart`, `SubagentStop`, and
every hook payload fired inside a subagent thread, so hooks and MCP calls
agree without inference; the child thread id on the `spawn_agent`
`PostToolUse` would close it equally.
