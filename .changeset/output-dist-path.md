---
"agent-bundle": patch
---

Agent Bundle config now supports `output.distPath` to relocate the build
artifact root (the default `dist` is unchanged); CLI `--output` still takes
precedence. Invalid values report `AB4707`–`AB4709`.
