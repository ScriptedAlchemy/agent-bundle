---
"create-agent-bundle": patch
---

Validate every tar header when probing local framework tarballs, not only entries before `package/package.json`. Document the `src/cli.ts` → `src/cli/**` migration in the cli-tool template README so adopters avoid `AB4801`.
