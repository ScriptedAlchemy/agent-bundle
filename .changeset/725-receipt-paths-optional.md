---
"agent-bundle": patch
---

Document the `audiobook-curator` example's CLI migration accurately: since the `<tool>.cli.ts` projections replaced the `src/cli/` tree (#734), every `--report` and `--receipt` option (thirteen of the sixteen commands, `inventory --report` and `convert --receipt` among them) is optional, as it is on the tools, instead of required; a command run without one writes no report or receipt file, and exit codes, `--apply` gating, and error output are unchanged. (#738)
