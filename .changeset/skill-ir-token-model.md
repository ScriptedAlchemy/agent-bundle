---
"agent-bundle": patch
---

Compile one Skill source into a canonical IR with a typed plugin-surface token registry and closed per-host lowering (#108).

Portable `SKILL.md` stays a byte-stable pass-through when no host extension or placeholder requires target-specific output. Claude, Cursor, and Codex receive only schema-legal documents (Claude frontmatter extensions, Cursor path/invocation fields, Codex `agents/openai.yaml`); unsupported tokens and unknown fields fail with AB3006–AB3010. Shared-vs-per-host `skills/` layout is an inspect-visible evidence decision for #101, not a hard-committed install tree. Rendered skills keep the existing `SKILL.tsx`/`SKILL.ts` build-time path — no live Flight client.
