---
pageType: home
description: 'Compile skills, hooks, MCP servers, and scripts from one typed config into installable Claude Code, Codex, and Cursor artifacts.'
titleSuffix: ' - Agent plugin compiler for Claude Code, Codex, and Cursor'

hero:
  name: agent-bundle
  text: One typed config, every agent host
  tagline: Describe skills, hooks, MCP servers, and scripts once. Compile installable artifacts for Claude Code, Codex, and Cursor.
  image:
    src: /logo.svg
    alt: agent-bundle logo
  actions:
    - theme: brand
      text: Introduction
      link: /guide/start/
    - theme: alt
      text: Quick start
      link: /guide/start/quick-start

features:
  - icon: 🧩
    title: One typed configuration
    details: A single agent-bundle.config.ts describes the whole plugin, and the src/ conventions fill in what it leaves silent. The compiler emits each host's manifests and wrappers, so host-specific layouts stay out of your source.
    link: /guide/authoring/
    span: 6
  - icon: 🛠️
    title: Skills, hooks, MCP, scripts, packages
    details: Author skills, lifecycle hooks, MCP servers and MCP Apps, scripts and assets, and CLI or library package entries from the same config surface.
    link: /guide/authoring/skills
    span: 6
  - icon: 🖥️
    title: Local Workbench development
    details: Run the developer Workbench to inspect the compiled bundle, exercise the emitted wrappers, and see how each host will load your plugin before you ship it.
    link: /guide/development/workbench
    span: 6
  - icon: 🔬
    title: Evidence-driven testing
    details: Route, protocol, CLI, package, and host-install proofs turn "it builds" into recorded evidence that the artifacts actually work — and a pass at one level is never reported as a receipt for another.
    link: /guide/development/testing
    span: 6
  - icon: 📦
    title: Every target ships on its own
    details: A built target directory is the unit you copy, publish, or hand to a host CLI. It carries a generated INSTALL.md with the bundle's real names and a manifest that records every emitted file with its SHA-256.
    link: /guide/distribution/
    span: 6
  - icon: 🧭
    title: Four runnable examples
    details: A Skills starter, hook and script traces, an interactive MCP App, and a complete media-management plugin — real products you can build, run, and read, with no API key required.
    link: /examples/
    span: 6
---
