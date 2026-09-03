---
pageType: home

hero:
  name: agent-bundle
  text: One typed config, every agent host
  tagline: Describe skills, hooks, MCP servers, and scripts once. Compile installable artifacts for Claude Code, Codex, and Cursor.
  actions:
    - theme: brand
      text: Type API
      link: /api/
    - theme: alt
      text: GitHub
      link: https://github.com/ScriptedAlchemy/agent-bundle

features:
  - icon: 🧩
    title: One typed configuration
    details: A single agent-bundle.config.ts describes the whole plugin. The compiler emits each host's manifests and wrappers, so host-specific layouts stay out of your source.
    span: 6
  - icon: 🛠️
    title: Skills, hooks, MCP, scripts, packages
    details: Author skills, lifecycle hooks, MCP servers and MCP Apps, scripts and assets, and CLI or library package entries from the same config surface.
    span: 6
  - icon: 🖥️
    title: Local Workbench development
    details: Run the developer Workbench to inspect the compiled bundle, exercise routes, and see how each host will load your plugin before you ship it.
    span: 6
  - icon: 🔬
    title: Evidence-driven testing
    details: Route, protocol, CLI, package, and host-install proofs turn "it builds" into recorded evidence that the artifacts actually work.
    span: 6
---
