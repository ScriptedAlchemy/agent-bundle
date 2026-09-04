---
'@agent-bundle/runtime': patch
'agent-bundle': patch
---

Resolve a Codex subagent's `request.lineage` parent and depth from the thread's own rollout instead of spawn ordering: the registry reads the `session_meta` head of the rollout every hook payload names in `transcript_path` (`agent_transcript_path` on `SubagentStop`), places the thread with the new `resolution: 'transcript'` (provenance `derived`), matches the `spawn_agent` call to the child by `agent_path`, and corrects an inferred parent at `SubagentStop` from the parent rollout it names. Standalone hooks gain `resolveStandaloneLineage` for the same read. The Codex capability table's `lineage.parent` and `lineage.depth` rows move to `supported`. Refs #423 (#480)
