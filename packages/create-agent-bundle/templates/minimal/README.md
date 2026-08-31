# my-agent-plugin

A skills-only agent plugin built with [agent-bundle](https://github.com/ScriptedAlchemy/agent-bundle).
One `agent-bundle.config.ts` describes the plugin; the compiler emits installable
artifacts for Claude Code, Codex, and Cursor, plus a portable layout.

## Commands

```sh
npm run dev        # local workbench with live rebuilds
npm run build      # write host artifacts to artifact/
npm run check      # validate + build + typecheck + test
```

## Layout

- `agent-bundle.config.ts` — the one typed config.
- `skills/getting-started/` — a Skill: `SKILL.md` frontmatter plus optional
  `references/` and `assets/`.
- `tests/` — run with `npm run test`.

## The agent-bundle dependency

agent-bundle has no npm release yet; this project pins a
[pkg.pr.new](https://pkg.pr.new) preview tarball of it. To move to a newer
preview (or a real release once one exists), change the `agent-bundle` entry
in `devDependencies` — see
[Preview packages](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/docs/preview-packages.md)
for the URL forms.
