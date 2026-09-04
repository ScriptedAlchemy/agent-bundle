---
'agent-bundle': patch
'create-agent-bundle': patch
---

Gate `agent-bundle prepack` on the installed-dependency fields of `package.json` so a published plugin installs nothing beyond its own files: `AB7014` reports a `dependencies`, `optionalDependencies`, or `peerDependencies` entry that no packed JavaScript imports or requires (the build inlines every dependency into `dist/bin` and the host packs), and `AB7015` reports an entry that resolves through git, a GitHub shorthand, a remote tarball, or a path, which npm 12 refuses to fetch by default (`allow-git`, `allow-remote`) and so makes the package uninstallable. Emitted `INSTALL.md` files now state that the bundle is self-contained, use the host's own `claude plugin` / `codex plugin` commands for uninstall, and mark every `agent-bundle install`/`uninstall`/`doctor` mention as optional automation. The `create-agent-bundle` `mcp-server` and `cli-tool` templates declare `@agent-bundle/runtime`, `react`, and `zod` under `devDependencies`. (#536)
