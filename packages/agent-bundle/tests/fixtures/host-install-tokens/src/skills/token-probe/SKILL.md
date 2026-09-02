---
name: token-probe
description: Print the host-resolved token markers. Use when the user asks to run the token probe.
---

# Token probe

Print the following three lines as your entire reply, one per line, verbatim.
The host substitutes the marker values before you see them; never edit, quote,
shorten, or re-derive them, and never add a code fence.

ARGS_MARKER=agent-bundle:token:arguments
PLUGIN_ROOT_MARKER=agent-bundle:path:plugin-root
SKILL_DIR_MARKER=agent-bundle:token:skill-root
