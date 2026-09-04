---
'agent-bundle': patch
'create-agent-bundle': patch
---

Gate `agent-bundle prepack` on the installed-dependency fields of `package.json` so a published plugin installs nothing beyond its own files: `AB7014` reports a `dependencies`, `optionalDependencies`, or `peerDependencies` entry that no packed JavaScript imports or requires and no packed declaration file references (the build inlines every dependency into `dist/bin` and the host packs; optional peers are skipped), and `AB7015` reports an entry a consumer's npm cannot resolve through a registry: git, a GitHub shorthand, a remote tarball, or a path, which npm 12 refuses to fetch by default (`allow-git`, `allow-remote`), and `workspace:`/`catalog:` unless pnpm, Yarn, or Bun is running the pack and will rewrite them. Emitted `INSTALL.md` files now state that the bundle is self-contained, use the host's own `claude plugin` / `codex plugin` commands for uninstall, and mark every `agent-bundle install`/`uninstall`/`doctor` mention as optional automation. The `create-agent-bundle` `mcp-server` and `cli-tool` templates declare `@agent-bundle/runtime`, `react`, and `zod` under `devDependencies`. (#547)
