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
    details: A single agent-bundle.config.ts describes the whole plugin. The compiler emits each host's manifests and wrappers, so host-specific layouts stay out of your source.
    link: /guide/authoring/
    span: 6
  - icon: 🛠️
    title: Skills, hooks, MCP, scripts, packages
    details: Author skills, lifecycle hooks, MCP servers and MCP Apps, scripts and assets, and CLI or library package entries from the same config surface.
    link: /guide/authoring/skills
    span: 6
  - icon: 🖥️
    title: Local Workbench development
    details: Run the developer Workbench to inspect the compiled bundle, exercise routes, and see how each host will load your plugin before you ship it.
    link: /guide/development/workbench
    span: 6
  - icon: 🔬
    title: Evidence-driven testing
    details: Route, protocol, CLI, package, and host-install proofs turn "it builds" into recorded evidence that the artifacts actually work.
    link: /guide/development/testing
    span: 6
  - icon: 🧭
    title: Host capability matrices
    details: Pinned per-host tables for Claude Code, Codex, Cursor, and the portable standard, rendered from the compiler's own capability evidence on every build.
    link: /reference/hosts
    span: 6
  - icon: 📚
    title: Generated type API
    details: Every public package export documented from source with TypeDoc, mirrored across both locales, with Twoslash type hovers in the guide's examples.
    link: /api/
    span: 6
---
