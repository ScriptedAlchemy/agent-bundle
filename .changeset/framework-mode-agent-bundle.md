---
"agent-bundle": minor
---

Framework mode (RFC #63), compiler side. The `skills/<name>/` directory
convention gains a power tier and two migration nudges. Rendered skills: a
skill directory may hold `SKILL.tsx` (or `SKILL.ts`) instead of `SKILL.md` —
the module default-exports a component (sync or async) and exports a
`frontmatter` record, and the build renders the element tree to Markdown
through a dependency-free renderer covering a documented subset (`h1`–`h6`,
`p`, lists, `strong`/`em`/`code`, `pre`, `blockquote`, `a`, `hr`, `br`,
fragments; anything else is a named error, never a silent approximation). The
compiled `SKILL.md` is emitted as a generated write entry into every target
artifact. New nudges: `AB4734` when explicit `skills` configuration leaves a
conventional `skills/<name>/SKILL.md` uncovered (config wins, the shadowed
state is flagged), and `AB4735` when a hand-authored `SKILL.md` shadows a
rendered `SKILL.tsx`/`SKILL.ts` in the same directory (the authored file
wins). The `create-agent-bundle` minimal template now teaches the directory
convention: no `skills` field in its config at all.
