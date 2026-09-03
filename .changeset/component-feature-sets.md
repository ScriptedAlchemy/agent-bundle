---
'agent-bundle': patch
---

Enforce per-host component feature sets for conventional `src/commands/*.md` and `src/rules/*.mdc` documents (#100). Every frontmatter field is judged against the target's `<kind>.<feature>` capability row: a command or rule that explicitly targets a host which cannot express a field it uses fails the build (`AB4927` commands, `AB4907` rules), while an implicitly selected host still receives the document minus the field and `agent-bundle validate` reports the omission as a warning with the host's reason (`AB4928`, `AB4908`). `agent-bundle inspect` lists the same omissions as `omittedFeatures` on the selected component (`--json`) and as `<kind> <name> omits <feature>: …` lines. Cursor's pinned commands surface is frontmatter-free Markdown, so a Cursor-required command must not carry `description`, `argumentHint`, `allowedTools`, `model`, or `disableModelInvocation`; Cursor rules keep `description`, `globs`, and `alwaysApply` (#427)
