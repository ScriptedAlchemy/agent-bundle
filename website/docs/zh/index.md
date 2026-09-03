---
pageType: home

hero:
  name: agent-bundle
  text: 一份带类型的配置，适配所有 Agent 宿主
  tagline: 一次性描述技能、钩子、MCP 服务器与脚本，编译出可直接安装到 Claude Code、Codex 与 Cursor 的产物。
  actions:
    - theme: brand
      text: 类型 API
      link: /zh/api/
    - theme: alt
      text: GitHub
      link: https://github.com/ScriptedAlchemy/agent-bundle

features:
  - icon: 🧩
    title: 一份带类型的配置
    details: 单个 agent-bundle.config.ts 即可描述整个插件。编译器为每个宿主生成清单与包装脚本，宿主专属的目录结构不会渗入你的源码。
    span: 6
  - icon: 🛠️
    title: 技能、钩子、MCP、脚本与包入口
    details: 在同一份配置中编写技能、生命周期钩子、MCP 服务器与 MCP App、脚本与静态资源，以及 CLI 或库的包入口。
    span: 6
  - icon: 🖥️
    title: 本地 Workbench 开发
    details: 运行开发者 Workbench 检查编译后的产物、演练路由，在交付之前看清每个宿主将如何加载你的插件。
    span: 6
  - icon: 🔬
    title: 以证据驱动的测试
    details: 路由、协议、CLI、包与宿主安装等各级证明，把“能构建”变成产物确实可用的可复核证据。
    span: 6
---
