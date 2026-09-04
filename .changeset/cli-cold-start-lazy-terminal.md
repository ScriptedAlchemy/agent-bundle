---
"agent-bundle": patch
"create-agent-bundle": patch
---

Restore CLI cold-start time by loading the Effect terminal runtime lazily. `agent-bundle --version`, `--help`, and argv errors answer in about 60 ms again (they had regressed to about 300 ms) because the Effect `Terminal` / `Stdio` runtime is now built on a command's first write instead of before argv parsing; command output, `--json` documents, and diagnostics are unchanged. `create-agent-bundle --help` and flag errors no longer evaluate the scaffold bundle (Effect, the Node platform layer, Clack), about 70 ms → 40 ms.
