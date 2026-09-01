---
name: probe
description: Confirm that the host-install proof fixture was discovered.
targets:
  codex:
    interface:
      display_name: Host install probe
      short_description: Confirm the host-install proof fixture was discovered.
    policy:
      allow_implicit_invocation: true
    dependencies:
      tools:
        - type: mcp
          value: probe
---

# Probe

Report that the host-install proof fixture is available.
