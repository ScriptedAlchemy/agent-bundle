---
pageType: home
description: '用一份带类型的配置描述技能、钩子、MCP 服务器与脚本，编译为可直接安装到 Claude Code、Codex 与 Cursor 的产物。'
titleSuffix: ' - 面向 Claude Code、Codex 与 Cursor 的 Agent 插件编译器'

hero:
  name: agent-bundle
  text: 一份带类型的配置，适配所有 Agent 宿主
  tagline: 一次性描述技能、钩子、MCP 服务器与脚本，编译出可直接安装到 Claude Code、Codex 与 Cursor 的产物。
  image:
    src: /logo.svg
    alt: agent-bundle 徽标
  actions:
    - theme: brand
      text: 介绍
      link: /zh/guide/start/
    - theme: alt
      text: 快速开始
      link: /zh/guide/start/quick-start

features:
  - icon: 🧩
    title: 一份带类型的配置
    details: 单个 agent-bundle.config.ts 即可描述整个插件，配置没说的部分由 src/ 约定补齐。编译器为每个宿主生成清单与包装脚本，宿主专属的目录结构不会渗入你的源码。
    link: /zh/guide/authoring/
    span: 6
  - icon: 🛠️
    title: 技能、钩子、MCP、脚本与包入口
    details: 在同一份配置表面上编写技能、生命周期钩子、MCP 服务器与 MCP App、脚本与静态资源，以及 CLI 或库的包入口。
    link: /zh/guide/authoring/skills
    span: 6
  - icon: 🖥️
    title: 本地 Workbench 开发
    details: 运行开发者 Workbench 检查编译后的捆绑包、演练输出的包装脚本，在交付之前看清每个宿主将如何加载你的插件。
    link: /zh/guide/development/workbench
    span: 6
  - icon: 🔬
    title: 以证据驱动的测试
    details: 路由、协议、CLI、包与宿主安装等各级证明，把“能构建”变成产物确实可用的可复核证据——而且某一级别的通过绝不会被当作另一级别的收据来报告。
    link: /zh/guide/development/testing
    span: 6
  - icon: 📦
    title: 每个 target 都能独立交付
    details: 已构建的 target 目录就是你复制、发布或交给宿主 CLI 的那个单位。它自带一份使用捆绑包真实名称的 INSTALL.md，以及一份记录每个输出文件及其 SHA-256 的清单。
    link: /zh/guide/distribution/
    span: 6
  - icon: 🧭
    title: 四个可运行的示例
    details: 按约定发现的 Skill、钩子与脚本轨迹、交互式 MCP App，以及一个完整的媒体管理插件——都是可以构建、运行与阅读的真实产品，且不需要 API key。
    link: /zh/examples/
    span: 6
---
