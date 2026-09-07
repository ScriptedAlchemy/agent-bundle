---
"agent-bundle": patch
---

Document the `audiobook-curator` example's CLI migration accurately: since the `<tool>.cli.ts` projections replaced the `src/cli/` tree (#734), `inventory --report` and `convert --receipt` are optional, as they are on the tools, instead of required; a command run without one writes no receipt file, and exit codes, `--apply` gating, and error output are unchanged. (#738)
