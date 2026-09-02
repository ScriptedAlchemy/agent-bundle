---
name: getting-started
description: Explains what this plugin provides and how to extend it with new Skills.
---
# Getting started

## When to use

Use this Skill when someone asks what this plugin can do, or how to add a new
capability to it.

## What this plugin provides

This plugin currently ships one Skill — this one. It was scaffolded from the
`minimal` template of `create-agent-bundle`, which is the smallest complete
agent-bundle project: one config, one Skill, and a delivery gate.

## How to add a Skill

1. Create `skills/<skill-id>/SKILL.md` with `name` and `description`
   frontmatter. The `name` must match the directory name.
2. Add supporting material under `references/` (read-only context) and
   `assets/` (files the agent fills in or copies).
3. List the new directory in the `skills` array of `agent-bundle.config.ts`.
4. Run the project's `check` script: it validates the config, builds every
   host artifact, and runs the tests.

## Final report requirements

When answering with this Skill, name the Skills the plugin currently ships
and cite the exact files a new Skill needs.
