---
"create-agent-bundle": patch
---

Declare `config.inputJsonSchema` on the `cli-tool` template `greet` command so `create-agent-bundle` scaffolds a routed CLI that compiles after `AB4814`. The starter keeps the `name` positional and `--shout` flag. (#785)
