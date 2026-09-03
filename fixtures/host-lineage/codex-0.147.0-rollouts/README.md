# Codex 0.147.0 rollout heads for the lineage capture

One file per thread of the `codex-0.147.0.ndjson` capture, named exactly as the
hook payloads name them in `transcript_path` / `agent_transcript_path`
(`rollout-<timestamp>-<thread id>.jsonl`). Each holds the `session_meta` line
Codex writes first, followed by one redacted `response_item` line so readers
prove they stop at the first newline.

Provenance: the ids, paths, timestamps, `agent_path` values (the
`spawn_agent` `PostToolUse` `tool_response.task_name` of the capture, rows 16
and 27), and git commit are the capture's own. The `session_meta` field set and
nesting (`source.subagent.thread_spawn.{parent_thread_id, depth, agent_path,
agent_nickname, agent_role}`, `thread_source`, `forked_from_id`,
`parent_thread_id`, `subagent_history_start_ordinal`, `context_window`) are
copied from real cli 0.147.0 rollouts on the capturing machine
(`~/.codex/sessions`, 1,191 thread-spawn rollouts at that version; every one of
the 8,049 thread-spawn rollouts across 0.130.0 → 0.152.0 carries
`parent_thread_id` and `depth`). The capture's own rollout files under the
isolated `CODEX_HOME` were not retained, so `base_instructions.text`,
`agent_nickname`, the repository URL, and the `context_window.window_id`
values are redacted placeholders, not observations.
