---
"agent-bundle": patch
"create-agent-bundle": patch
---

Document that artifact output roots remain project-contained even when the CLI
overrides `output.distPath`. Omit generated installer bins from scaffolds that
select no installable host, and make the default template install examples use
a selected host.
