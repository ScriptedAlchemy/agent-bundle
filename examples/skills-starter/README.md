# Skills Starter

From the repository root, launch this example with:

```bash
pnpm example:skills
```

The command validates and builds the project, starts the foreground development
server, and opens the Agent Bundle Workbench. No API key or native host login is
required.

## What is authored

- `agent-bundle.config.ts` declares the plugin, its Skill, and portable, Codex,
  and Claude targets.
- `skills/release-review/SKILL.md` is the source Skill document.
- `references/checklist.md` is supporting guidance loaded only when needed.
- `assets/report-template.md` is a reusable output template.

## Workbench walkthrough

1. Open **Overview** to see the active artifact epoch and its three targets.
2. Open **Skills**, select `release-review`, and compare the authored document
   with its generated target documents.
3. Open **Artifacts** to inspect the portable, Codex, and Claude output trees
   and provenance.
4. Edit the heading or instructions in `SKILL.md`, press **Rebuild**, and watch
   the active epoch and generated Markdown update.

## Noninteractive checks

After the repository-level `pnpm build` has built the local `agent-bundle`
workspace dependency, the package-local workflow is:

```bash
cd examples/skills-starter
pnpm validate
pnpm build
pnpm dev
```

Use `pnpm check` when you want validation and a build without starting the
Workbench. Generated output is written to `dist/`; its root contract is
`dist/agent-bundle.manifest.json`. The `.agent-bundle/` directory contains
development state and is not source material.
