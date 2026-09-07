---
"agent-bundle": patch
---

Record ten more third-party clients of the emitted Agent Plugins artifact in the pinned portable capability table, each pinned to a live CLI run or its own dated documentation: GitHub Copilot CLI 1.0.83 installs the package with its manifest, skill, and MCP configuration resolved; VS Code, CodeWhale, Kiro Powers, and Hermes Agent read the root manifest with their documented narrowings recorded; Gemini CLI 0.58.0, OpenCode 1.18.29, Cline, the Zed Agent, and Pi 0.73.1 read the skill tree without the manifest. A record may now declare a `register` action for a client that reads the emitted tree where it lies instead of copying it, and `INSTALL.md` renders a narrowed `placeholders` row only for a build that carries the MCP document it narrows. (#723)
