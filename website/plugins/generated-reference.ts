import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RspressPlugin } from '@rspress/core';

/**
 * Build-time reference pages rendered from repository sources of truth:
 *
 * - the pinned host capability tables under
 *   `packages/agent-bundle/src/adapters/capabilities/*.json` become the host,
 *   event-route, and notice-delivery matrices;
 * - `docs/diagnostics.md` becomes the diagnostics code reference.
 *
 * The output is written into every locale root before route scanning, so the
 * pages take part in sidebar metadata, dead-link checks, search, and the LLM
 * artifacts exactly like authored pages, while never being committed.
 */

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface CapabilityRow {
  readonly state?: string;
  readonly reason?: string;
  readonly nativeEvent?: string;
  readonly evidence?: readonly string[];
  readonly availability?: Readonly<Record<string, { readonly state?: string; readonly reason?: string }>>;
}

interface HostCapabilityTable {
  readonly fileName: string;
  readonly host: string;
  readonly version: string;
  readonly data: JsonObject;
}

export interface GeneratedReferenceLocale {
  /** Locale key, such as `en` or `zh`. */
  readonly lang: 'en' | 'zh';
  /** Docs-root-relative locale directory, such as `en` or `zh`. */
  readonly dir: string;
}

export interface GeneratedReferenceOptions {
  /** Absolute repository root; capability tables and `docs/diagnostics.md` resolve beneath it. */
  readonly repoRoot: string;
  readonly locales: readonly GeneratedReferenceLocale[];
}

export const generatedReferencePages = ['hosts', 'events', 'notices', 'diagnostics'] as const;

const capabilitiesDir = ['packages', 'agent-bundle', 'src', 'adapters', 'capabilities'];
const diagnosticsSource = ['docs', 'diagnostics.md'];
const repositoryUrl = 'https://github.com/ScriptedAlchemy/agent-bundle/blob/main';

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asObject = (value: JsonValue | undefined): JsonObject => (isObject(value) ? value : {});

const asString = (value: JsonValue | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Which MCP fields accept path tokens, per host. Cursor and portable record
 * this directly as `mcp.pathTokens`; Claude records the same fact as the
 * `mcpStdio` and `mcpRemote` groups of its plugin path-substitution table,
 * so the reference derives the row from there rather than rendering `—`.
 */
const mcpPathTokenFields = (host: JsonObject): JsonObject => {
  const explicit = asObject(asObject(host.mcp).pathTokens);
  if (Object.keys(explicit).length > 0) {
    return explicit;
  }
  const substitution = asObject(asObject(asObject(host.plugin).packageLifecycle).pluginPathSubstitution);
  const tokens = substitution.tokens;
  if (!Array.isArray(tokens)) {
    return {};
  }
  const groups = asObject(substitution.fields);
  const derived: JsonObject = {};
  for (const group of ['mcpStdio', 'mcpRemote']) {
    const fields = groups[group];
    if (Array.isArray(fields)) {
      for (const field of fields) {
        if (typeof field === 'string') {
          derived[field] = tokens;
        }
      }
    }
  }
  return derived;
};

/**
 * A host whose table records no MCP token fields because the adapter lowers
 * the token instead of the host interpolating it says so in a dated
 * `mcp.pathTokenLowering` row; its `reason` is the cell text.
 */
const mcpPathTokenLoweringNote = (host: JsonObject): string | undefined =>
  asString(asObject(asObject(host.mcp).pathTokenLowering).reason);

const escapeProse = (text: string): string =>
  text
    .replaceAll('|', '\\|')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('{', '&#123;')
    .replaceAll('}', '&#125;')
    .replaceAll('\n', ' ');

const code = (text: string): string => `\`${text.replaceAll('|', '\\|')}\``;

const codeList = (values: readonly JsonValue[]): string =>
  values.map(value => code(String(value))).join(', ');

const detailValueCell = (value: JsonValue): string =>
  Array.isArray(value) ? codeList(value) : code(isObject(value) ? JSON.stringify(value) : String(value));

const table = (headers: readonly string[], rows: readonly (readonly string[])[]): string => {
  const line = (cells: readonly string[]) => `| ${cells.join(' | ')} |`;
  return [
    line(headers),
    line(headers.map(() => '---')),
    ...rows.map(row => line(row)),
  ].join('\n');
};

const messages = {
  en: {
    generatedFromCapabilities: (files: readonly string[]) =>
      `:::info Generated page\nThis page is rendered at documentation build time from the pinned host capability tables ${files.map(file => `[\`${file}\`](${repositoryUrl}/packages/agent-bundle/src/adapters/capabilities/${file})`).join(', ')}. Those JSON files are the source of truth every target adapter compiles against; change them, not this page.\n:::`,
    generatedFromDiagnostics:
      `:::info Generated page\nThis page is a build-time copy of [\`docs/diagnostics.md\`](${repositoryUrl}/docs/diagnostics.md), the repository's diagnostics contract. Change that file, not this page.\n:::`,
    hostsTitle: 'Host capability matrix',
    hostsDescription:
      'Pinned host capability tables for the Claude Code, Codex, Cursor, and portable targets: observed versions, manifest locations, install surfaces, path tokens, MCP transports, conversation lineage, and plugin components.',
    hostsIntro:
      'Every target adapter projects the normalized bundle against a pinned capability table: a JSON document recording the host version the evidence was observed against, the paths the host reads, and — for each capability — whether it is `supported`, `degraded`, or `unavailable` with a written reason. Nothing is inferred: a capability without evidence is unavailable, never a silent guess.',
    pinnedHosts: 'Pinned hosts',
    installSurface: 'Install surface',
    pathTokens: 'Path tokens',
    mcpTransports: 'MCP transports and token fields',
    lineage: 'Conversation lineage',
    lineageIntro:
      'The `lineage` section of each table: what the host tells the warm runtime about the conversation tree behind `request.lineage`. `subagent-events` says whether the host emits subagent start/stop hooks at all, `root` whether every payload names the root conversation, `parent` and `depth` how a subagent is placed under its parent (`supported` only when the child\'s own payload names it, `degraded` when the runtime registry places it from spawn-call ordering and any later host confirmation), and `mcp-correlation` how a generated MCP tool call is matched to the hook window that produced it. A degraded row records what the registry does and how certain it is; a supported row records the evidence. The `resolution` field on `request.lineage` reports which path answered (`native`, `registry`, `confirmed`, `inferred`).',
    lineageDetails: 'Lineage row details',
    pluginComponents: 'Plugin components',
    pluginComponentsIntro:
      'The `plugin` section of each table, flattened to dotted capability paths and grouped by top-level key. Boolean entries record a component the adapter emits; entries with a state carry the reason the host evidence supports or withholds it. Evidence notes stay in the JSON files.',
    headers: {
      lineageRow: 'Lineage row',
      host: 'Host',
      version: 'Observed version',
      manifest: 'Plugin manifest',
      marketplace: 'Marketplace manifest',
      hooksConfig: 'Hooks document',
      state: 'State',
      detail: 'Detail',
      method: 'Method / commands',
      scopes: 'Scopes',
      source: 'Source',
      token: 'Token',
      stdio: 'stdio',
      streamableHttp: 'Streamable HTTP',
      tokenFields: 'Fields accepting path tokens',
      canonicalEvent: 'Canonical event',
      configKey: 'Config key',
      selector: 'Selector',
      nativeEvent: 'Native event',
      reason: 'Reason',
      channel: 'Channel',
      hosts: 'Hosts',
    },
    unavailable: 'unavailable',
    notApplicable: '—',
    evidenceNotes: (count: number) => `${count} evidence note${count === 1 ? '' : 's'}`,
    eventsTitle: 'Event and hook matrix',
    eventsDescription:
      'Canonical event routes per host, config-declared hook events, canonical tool selectors mapped to native matchers, and the host-native events deliberately deferred.',
    eventsIntro:
      'Event routes under `src/events/**` and config-declared `hooks` both compile against the same per-host tables. A canonical event lowers to the host-native event named here. A host without that event has nothing to lower to, so a route or hook that still selects that host fails the build (`<target>.hook.event.*`, or `AB4204` for an explicit config-hook target): exclude the host through the route\'s `config.targets` or the hook\'s `targets`. A config hook with no explicit `targets` inherits only the selected hosts that support hooks, so unsupported hosts are skipped there without a diagnostic. Every unavailable cell records its reason rather than inferring one.',
    eventRoutes: 'Canonical event routes',
    eventRoutesIntro:
      'Rows are the canonical event families a `src/events/<family>/*.tsx` route may declare; columns are the pinned hosts. A cell names the native event the route lowers to.',
    unavailableRoutes: 'Why a route is unavailable',
    configHookEvents: 'Config-declared hook events',
    configHookEventsIntro:
      'The `hooks` block of `agent-bundle.config.ts` is keyed by these canonical names; each maps to the native event a target registers.',
    toolSelectors: 'Canonical tool selectors',
    toolSelectorsIntro:
      'A hook or event route that scopes `tools` uses these canonical selectors; each adapter emits the native matcher below. A selector a target cannot map is a per-target diagnostic, never an empty matcher.',
    deferredNativeEvents: 'Deferred host-native events',
    deferredNativeEventsIntro:
      'Native events each host publishes that have no canonical route family yet, with the recorded reason for deferring them.',
    noticesTitle: 'Notice delivery matrix',
    noticesDescription:
      'Which notice delivery channels each pinned host supports, with the recorded reason for every unavailable channel.',
    noticesIntro:
      'A notice is an entry in the journal-backed notice ledger co-mounted with project state (the reserved store id `@agent-bundle/runtime/agent-notice-ledger/v1`). It targets a recipient and moves only through evidenced states — `pending`, `attempted`, `acknowledged`, `expired`, `unavailable`, `withdrawn`; settled terminal notices are pruned and the journal compacted under the project\'s `notices.retention` policy, so history is bounded, not permanent. Delivery is attempted through the channels below, and a generated MCP server wires each cross-request route only where its host advertises it: the recipient-scoped inbox resource `agent-bundle://notices/inbox` is registered for stateful projects on hosts advertising `mcp-inbox` (every built-in host), and `resources/subscribe` plus one `notifications/resources/updated` per newly eligible pending notice is offered only where the host additionally advertises `mcp-resource-updated` and the state lifetime is workspace-durable — recorded on the ledger as an availability receipt, never a delivery claim. No host delivery is claimed without a supported channel.',
    recipientAxes: 'Recipient axes',
    recipientAxesIntro:
      'A recipient is the conjunction of the observed identity axes it names: every axis present must match the admitting request, and an axis the request cannot observe never matches. `conversation` and `root` are read from the request\'s `lineage`, so they address one agent thread — or every thread under one root — where `session` cannot: on Claude and Codex every subagent\'s hooks carry the root `session_id`, and a `conversation`-addressed notice is never admitted on a sibling\'s event. There is no push channel on any pinned host, so addressing a conversation still means publish plus admission on that conversation\'s next event.',
    recipientAxisRows: [
      ['`actor`', '`request.actor.id`', 'The HTTP-authenticated MCP client only; never mounted in event scopes.'],
      ['`host`', '`request.host.name`', 'Every request on that host.'],
      ['`session`', '`request.session.sessionId`', 'Every request in that host session — on Claude and Codex, every subagent under the root.'],
      ['`workspace`', '`request.workspace.root`', 'Every request whose observed workspace root (hook `cwd`) is that directory.'],
      ['`conversation`', '`request.lineage.conversation`', 'Exactly one agent thread: the root, or one subagent (Claude/Codex `agent_id`, Cursor child `conversation_id`).'],
      ['`root`', '`request.lineage.root`', 'The root conversation and every subagent whose lineage root it is — the publisher included when it is under that root.'],
    ],
    recipientAxisHeaders: ['Axis', 'Matched against', 'Reaches'],
    publisherView: 'Publisher view',
    publisherViewIntro:
      'A recipient never sees another recipient\'s notices, and a publisher does not see a recipient view either. What a publisher gets is `notices.published()`: the notices its own principal published, in every state, with their receipts. `publish()` records the publishing request\'s observed axes on the notice (`publisher`: `actor`, `host`, `session`, `workspace`, and `conversation` from `request.lineage`); a reader is the publisher when it resolves the same lineage conversation — so the hook that published and the MCP tool call that asks agree even though host name, session id, and cwd differ — or, for a publisher recorded without lineage, when every recorded axis matches. The view records nothing on the ledger, is judged per notice under authorization phase `published`, and discloses content under the default `internal` ceiling (`internal` secret-passed, `public` as authored, `secret` as the placeholder). A notice published by a request that observed no identity belongs to no view.',
    noticeChannels: 'Delivery channels',
    unavailableChannels: 'Why a channel is unavailable',
    sensitivityCeilings: 'Sensitivity ceilings',
    sensitivityIntro:
      'Every notice carries an author-declared `sensitivity` — `public`, `internal` (the default), or `secret`. A supported channel names the most sensitive class it carries in full, with the dated evidence for that ceiling; a channel without a named ceiling admits `internal`. A notice above a channel\'s ceiling is withheld from that channel and the refusal is recorded on the notice; `internal` content is passed through the runtime\'s secret pass (`flare-redact`, an exact-pinned dependency of `@agent-bundle/runtime`; every finding is replaced whole by `[REDACTED]`) before it leaves the store, `public` content travels as authored, and `secret` content travels as authored only where a channel admits it.',
    sensitivityEvidence: 'Ceiling evidence',
    diagnosticsTitle: 'Diagnostics reference',
    diagnosticsDescription:
      'Every agent-bundle diagnostic code family, severity, trigger, and recovery hint, copied at build time from the repository diagnostics contract.',
  },
  zh: {
    generatedFromCapabilities: (files: readonly string[]) =>
      `:::info 生成页面\n本页在文档构建时由固定版本的宿主能力表 ${files.map(file => `[\`${file}\`](${repositoryUrl}/packages/agent-bundle/src/adapters/capabilities/${file})`).join('、')} 渲染而成。这些 JSON 文件是每个目标适配器编译时依赖的唯一事实来源；请修改它们而不是本页。表格内容保留英文原文。\n:::`,
    generatedFromDiagnostics:
      `:::info 生成页面\n本页是仓库诊断契约 [\`docs/diagnostics.md\`](${repositoryUrl}/docs/diagnostics.md) 在构建时的副本，内容保留英文原文。请修改该文件而不是本页。\n:::`,
    hostsTitle: '宿主能力矩阵',
    hostsDescription:
      'Claude Code、Codex、Cursor 与 portable 目标的固定宿主能力表：观测版本、清单位置、安装方式、路径令牌、MCP 传输、会话谱系与插件组件。',
    hostsIntro:
      '每个目标适配器都会把归一化后的 bundle 投影到一份固定的能力表上：这份 JSON 文档记录了证据所对应的宿主版本、宿主读取的路径，以及每项能力是 `supported`、`degraded` 还是 `unavailable`，并附带书面原因。没有任何推断：缺少证据的能力即为不可用，绝不会默默猜测。',
    pinnedHosts: '固定宿主',
    installSurface: '安装方式',
    pathTokens: '路径令牌',
    mcpTransports: 'MCP 传输与令牌字段',
    lineage: '会话谱系',
    lineageIntro:
      '每张表的 `lineage` 部分：宿主向常驻运行时提供了哪些关于 `request.lineage` 背后会话树的信息。`subagent-events` 表示宿主是否发出子代理 start/stop 钩子，`root` 表示每个载荷是否都给出根会话，`parent` 与 `depth` 表示子代理如何被放到其父节点之下（只有当子代理自己的载荷给出父节点时才是 `supported`；由运行时注册表按 spawn 调用顺序放置、再由宿主事后确认时为 `degraded`），`mcp-correlation` 表示生成的 MCP 工具调用如何匹配到产生它的钩子窗口。degraded 行记录注册表的做法及其确定程度；supported 行记录证据。`request.lineage` 上的 `resolution` 字段报告是哪条路径给出了答案（`native`、`registry`、`confirmed`、`inferred`）。',
    lineageDetails: '谱系行详情',
    pluginComponents: '插件组件',
    pluginComponentsIntro:
      '每张表的 `plugin` 部分，按点分能力路径展开并按顶层键分组。布尔条目表示适配器会发出的组件；带状态的条目记录宿主证据支持或保留该能力的原因。证据说明保留在 JSON 文件中。',
    headers: {
      lineageRow: '谱系行',
      host: '宿主',
      version: '观测版本',
      manifest: '插件清单',
      marketplace: '市场清单',
      hooksConfig: '钩子文档',
      state: '状态',
      detail: '说明',
      method: '方式 / 命令',
      scopes: '作用域',
      source: '来源',
      token: '令牌',
      stdio: 'stdio',
      streamableHttp: 'Streamable HTTP',
      tokenFields: '接受路径令牌的字段',
      canonicalEvent: '规范事件',
      configKey: '配置键',
      selector: '选择器',
      nativeEvent: '宿主原生事件',
      reason: '原因',
      channel: '通道',
      hosts: '宿主',
    },
    unavailable: 'unavailable',
    notApplicable: '—',
    evidenceNotes: (count: number) => `${count} 条证据说明`,
    eventsTitle: '事件与钩子矩阵',
    eventsDescription:
      '各宿主的规范事件路由、配置声明的钩子事件、规范工具选择器到原生匹配器的映射，以及被有意推迟的宿主原生事件。',
    eventsIntro:
      '`src/events/**` 下的事件路由与配置声明的 `hooks` 都基于同一组按宿主固定的表编译。规范事件会降级为此处列出的宿主原生事件。不具备该事件的宿主没有可降级的目标，因此仍然选中该宿主的路由或 hook 会让构建失败（`<target>.hook.event.*`，显式配置 hook 目标则为 `AB4204`）：请通过路由的 `config.targets` 或 hook 的 `targets` 排除该宿主。未显式声明 `targets` 的配置 hook 只继承所选宿主中支持 hook 的那些，因此不受支持的宿主会在那里被跳过且不产生诊断。每个不可用单元格都记录其原因，而非推断。',
    eventRoutes: '规范事件路由',
    eventRoutesIntro:
      '行是 `src/events/<family>/*.tsx` 路由可以声明的规范事件族；列是固定宿主。单元格给出该路由降级到的原生事件。',
    unavailableRoutes: '路由不可用的原因',
    configHookEvents: '配置声明的钩子事件',
    configHookEventsIntro:
      '`agent-bundle.config.ts` 的 `hooks` 块以这些规范名称为键；每个键映射到目标注册的原生事件。',
    toolSelectors: '规范工具选择器',
    toolSelectorsIntro:
      '限定 `tools` 的钩子或事件路由使用这些规范选择器；每个适配器发出下表中的原生匹配器。目标无法映射的选择器会产生针对该目标的诊断，而不是空匹配器。',
    deferredNativeEvents: '推迟的宿主原生事件',
    deferredNativeEventsIntro:
      '各宿主公布但尚无规范路由族的原生事件，以及推迟它们的记录原因。',
    noticesTitle: '通知投递矩阵',
    noticesDescription:
      '每个固定宿主支持哪些通知投递通道，以及每个不可用通道的记录原因。',
    noticesIntro:
      '通知是与项目状态共同挂载、以日志为底的通知账本中的一条记录（保留的存储 id 为 `@agent-bundle/runtime/agent-notice-ledger/v1`）。它面向一个接收者，并且只会经历有证据的状态——`pending`、`attempted`、`acknowledged`、`expired`、`unavailable`、`withdrawn`；已结束的终态通知会按项目的 `notices.retention` 策略被清理、日志被压实，因此历史是有界的，而非永久保留。投递通过下列通道尝试，生成的 MCP 服务器只在宿主宣告了某条跨请求路由时才接线：按接收者限定的收件箱资源 `agent-bundle://notices/inbox` 会为宣告 `mcp-inbox` 的宿主（所有内置宿主）上的有状态项目注册；只有当宿主还宣告了 `mcp-resource-updated` 且 state 生命周期为工作区持久时，才提供 `resources/subscribe` 以及每条新近可用的待处理通知一次 `notifications/resources/updated`——它以可用性回执记录在账本上，绝不是投递声明。没有受支持的通道时，绝不声称已投递到宿主。',
    recipientAxes: '接收者轴',
    recipientAxesIntro:
      '接收者是它所命名的各个已观测身份轴的合取：出现的每个轴都必须与准入请求匹配，请求无法观测到的轴永不匹配。`conversation` 与 `root` 读取自请求的 `lineage`，因此能定向到单个代理线程——或某个根之下的全部线程——这是 `session` 做不到的：在 Claude 和 Codex 上，每个子代理的钩子都携带根 `session_id`，而以 `conversation` 定向的通知绝不会在兄弟代理的事件上被准入。任何固定宿主都没有推送通道，因此定向到某个会话仍然意味着发布，然后在该会话的下一个事件上准入。',
    recipientAxisRows: [
      ['`actor`', '`request.actor.id`', '仅指经 HTTP 认证的 MCP 客户端；事件作用域中永不挂载。'],
      ['`host`', '`request.host.name`', '该宿主上的每个请求。'],
      ['`session`', '`request.session.sessionId`', '该宿主会话中的每个请求——在 Claude 和 Codex 上即根之下的每个子代理。'],
      ['`workspace`', '`request.workspace.root`', '观测到的工作区根目录（钩子 `cwd`）为该目录的每个请求。'],
      ['`conversation`', '`request.lineage.conversation`', '恰好一个代理线程：根，或某一个子代理（Claude/Codex 的 `agent_id`，Cursor 子会话的 `conversation_id`）。'],
      ['`root`', '`request.lineage.root`', '根会话以及谱系根为它的每个子代理——发布者若位于该根之下，也包括在内。'],
    ],
    recipientAxisHeaders: ['轴', '匹配对象', '到达范围'],
    publisherView: '发布者视图',
    publisherViewIntro:
      '接收者永远看不到其他接收者的通知，发布者也不会获得接收者视图。发布者得到的是 `notices.published()`：其自身主体发布的通知，涵盖所有状态并附带回执。`publish()` 会把发布请求观测到的身份轴记录在通知上（`publisher`：`actor`、`host`、`session`、`workspace`，以及来自 `request.lineage` 的 `conversation`）；当读取方解析出相同的谱系会话时即为发布者——因此发布通知的钩子与发起查询的 MCP 工具调用即便宿主名、会话 id 与 cwd 各不相同也能对上——若发布者记录时没有谱系，则要求记录的每个轴都匹配。该视图不会在账本上记录任何内容，按通知逐条经授权阶段 `published` 判定，并且只在默认的 `internal` 上限下披露内容（`internal` 经过密钥脱敏，`public` 按原文，`secret` 为占位符）。由未观测到任何身份的请求发布的通知不属于任何视图。',
    noticeChannels: '投递通道',
    unavailableChannels: '通道不可用的原因',
    sensitivityCeilings: '敏感度上限',
    sensitivityIntro:
      '每条通知都带有作者声明的 `sensitivity`——`public`、`internal`（默认）或 `secret`。受支持的通道会声明它能完整承载的最高敏感类别，并附上该上限的带日期证据；未声明上限的通道接受 `internal`。高于通道上限的通知会被该通道拒绝，且拒绝会记录在通知上；`internal` 内容在离开存储前会经过运行时的密钥脱敏（`flare-redact`，`@agent-bundle/runtime` 精确锁定版本的依赖；每处命中整体替换为 `[REDACTED]`），`public` 内容按作者原文传递，`secret` 内容仅在通道允许时按原文传递。',
    sensitivityEvidence: '上限证据',
    diagnosticsTitle: '诊断参考',
    diagnosticsDescription:
      'agent-bundle 的全部诊断代码族、严重级别、触发条件与恢复提示，在构建时从仓库诊断契约复制而来。',
  },
} as const;

type Messages = (typeof messages)[keyof typeof messages];

const frontmatter = (title: string, description: string): string =>
  `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n`;

async function loadCapabilityTables(repoRoot: string): Promise<HostCapabilityTable[]> {
  const directory = path.join(repoRoot, ...capabilitiesDir);
  const entries = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
  const tables: HostCapabilityTable[] = [];
  for (const fileName of entries) {
    const parsed = JSON.parse(await readFile(path.join(directory, fileName), 'utf8')) as JsonValue;
    if (!isObject(parsed)) {
      throw new Error(`Capability table ${fileName} is not a JSON object.`);
    }
    const host = asString(parsed.host);
    if (host === undefined) {
      throw new Error(`Capability table ${fileName} has no "host" field.`);
    }
    const version =
      asString(parsed.observedCliVersion) ?? asString(parsed.observedSpecificationVersion) ?? 'unpinned';
    tables.push({ data: parsed, fileName, host, version });
  }
  if (tables.length === 0) {
    throw new Error(`No capability tables found under ${directory}.`);
  }
  return tables;
}

const hostHeader = (host: HostCapabilityTable): string => `${host.host} ${host.version}`;

const capabilityRow = (value: JsonValue | undefined): CapabilityRow | undefined =>
  isObject(value) ? (value as unknown as CapabilityRow) : undefined;

const stateCell = (row: CapabilityRow | undefined, m: Messages): string => {
  if (row === undefined) {
    return m.notApplicable;
  }
  if (row.state === 'supported') {
    const parts: string[] = [];
    if (row.nativeEvent !== undefined) {
      parts.push(code(row.nativeEvent));
    } else {
      parts.push('supported');
    }
    if (row.availability !== undefined) {
      const perSurface = Object.entries(row.availability)
        .map(([surface, availability]) => `${surface}: ${availability.state ?? 'unknown'}`)
        .join('; ');
      parts.push(`(${perSurface})`);
    }
    return parts.join(' ');
  }
  return row.state ?? m.unavailable;
};

const unionKeys = (hosts: readonly HostCapabilityTable[], select: (data: JsonObject) => JsonObject): string[] =>
  [...new Set(hosts.flatMap(host => Object.keys(select(host.data))))].sort();

const eventRoutesOf = (data: JsonObject): JsonObject => asObject(asObject(data.hooks).eventRoutes ?? data.eventRoutes);

interface FlattenedRow {
  readonly path: string;
  readonly state?: string;
  readonly detail?: string;
}

function flattenPlugin(value: JsonObject, prefix: string, m: Messages, rows: FlattenedRow[]): void {
  for (const [key, entry] of Object.entries(value)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    if (isObject(entry)) {
      if (typeof entry.state === 'string') {
        const details: string[] = [];
        if (typeof entry.reason === 'string') {
          details.push(escapeProse(entry.reason));
        }
        for (const [detailKey, detailValue] of Object.entries(entry)) {
          if (detailKey === 'state' || detailKey === 'reason' || detailKey === 'evidence') {
            continue;
          }
          // One line per object member; a stringified object is one unbreakable token.
          const members = isObject(detailValue)
            ? Object.entries(detailValue).map(([key, value]) => [`${detailKey}.${key}`, value] as const)
            : [[detailKey, detailValue] as const];
          for (const [key, value] of members) {
            details.push(`${code(key)}: ${detailValueCell(value)}`);
          }
        }
        if (Array.isArray(entry.evidence)) {
          details.push(m.evidenceNotes(entry.evidence.length));
        }
        rows.push({ detail: details.join(' · '), path: dotted, state: entry.state });
        continue;
      }
      flattenPlugin(entry, dotted, m, rows);
      continue;
    }
    if (Array.isArray(entry)) {
      rows.push({ detail: codeList(entry), path: dotted });
      continue;
    }
    if (typeof entry === 'boolean') {
      rows.push({ path: dotted, state: entry ? 'supported' : 'unavailable' });
      continue;
    }
    rows.push({ detail: code(String(entry)), path: dotted });
  }
}

const capabilityItem = ({ path, state, detail }: FlattenedRow): string =>
  `- ${code(path)}${state ? ` **${state}**` : ''}${detail ? ` — ${detail}` : ''}`;

function renderHosts(hosts: readonly HostCapabilityTable[], m: Messages): string {
  const sections: string[] = [];
  sections.push(frontmatter(m.hostsTitle, m.hostsDescription));
  sections.push(`# ${m.hostsTitle}\n`);
  sections.push(m.generatedFromCapabilities(hosts.map(host => host.fileName)));
  sections.push(m.hostsIntro);

  sections.push(`## ${m.pinnedHosts}\n`);
  sections.push(
    table(
      [m.headers.host, m.headers.version, m.headers.manifest, m.headers.marketplace, m.headers.hooksConfig],
      hosts.map(host => {
        const plugin = asObject(host.data.plugin);
        const hooks = asObject(host.data.hooks);
        return [
          code(host.host),
          code(host.version),
          asString(plugin.manifest) === undefined ? m.notApplicable : code(asString(plugin.manifest) ?? ''),
          asString(plugin.marketplace) === undefined ? m.notApplicable : code(asString(plugin.marketplace) ?? ''),
          asString(hooks.config) === undefined ? m.notApplicable : code(asString(hooks.config) ?? ''),
        ];
      }),
    ),
  );

  sections.push(`## ${m.installSurface}\n`);
  sections.push(
    table(
      [m.headers.host, m.headers.state, m.headers.method, m.headers.scopes, m.headers.source],
      hosts.map(host => {
        const install = asObject(host.data.install);
        const methods: string[] = [];
        for (const key of ['marketplaceAdd', 'pluginInstall', 'method', 'localRoot'] as const) {
          const value = asString(install[key]);
          if (value !== undefined) {
            methods.push(`${code(key)}: ${code(value)}`);
          }
        }
        const reason = asString(install.reason);
        if (reason !== undefined) {
          methods.push(escapeProse(reason));
        }
        const scopes = Array.isArray(install.scopes) ? codeList(install.scopes) : m.notApplicable;
        const source = asString(install.source);
        return [
          code(host.host),
          asString(install.state) ?? m.unavailable,
          methods.length > 0 ? methods.join('<br />') : m.notApplicable,
          scopes,
          source === undefined ? m.notApplicable : `[${source}](${source})`,
        ];
      }),
    ),
  );

  sections.push(`## ${m.pathTokens}\n`);
  const tokenKeys = unionKeys(hosts, data => asObject(data.tokens));
  sections.push(
    table(
      [m.headers.token, ...hosts.map(hostHeader)],
      tokenKeys.map(tokenKey => [
        code(tokenKey),
        ...hosts.map(host => {
          const value = asObject(host.data.tokens)[tokenKey];
          if (value === undefined || value === false) {
            return m.notApplicable;
          }
          return code(String(value));
        }),
      ]),
    ),
  );

  sections.push(`## ${m.mcpTransports}\n`);
  sections.push(
    table(
      [m.headers.host, m.headers.stdio, m.headers.streamableHttp, m.headers.tokenFields],
      hosts.map(host => {
        const mcp = asObject(host.data.mcp);
        const fields = Object.entries(mcpPathTokenFields(host.data))
          .map(([field, tokens]) => `${code(field)}: ${Array.isArray(tokens) ? codeList(tokens) : m.notApplicable}`)
          .join('<br />');
        return [
          code(host.host),
          mcp.stdio === true ? 'supported' : m.unavailable,
          mcp.streamableHttp === true ? 'supported' : m.unavailable,
          fields.length > 0 ? fields : mcpPathTokenLoweringNote(host.data) ?? m.notApplicable,
        ];
      }),
    ),
  );

  sections.push(`## ${m.lineage}\n`);
  sections.push(m.lineageIntro);
  const lineageRows = unionKeys(hosts, data => asObject(data.lineage));
  sections.push(
    table(
      [m.headers.lineageRow, ...hosts.map(hostHeader)],
      lineageRows.map(row => [
        code(row),
        ...hosts.map(host => stateCell(capabilityRow(asObject(host.data.lineage)[row]), m)),
      ]),
    ),
  );
  sections.push(`### ${m.lineageDetails}\n`);
  sections.push(
    table(
      [m.headers.lineageRow, m.headers.host, m.headers.state, m.headers.detail],
      lineageRows.flatMap(row =>
        hosts.flatMap(host => {
          const entry = capabilityRow(asObject(host.data.lineage)[row]);
          if (entry === undefined) {
            return [];
          }
          const details: string[] = [];
          if (entry.reason !== undefined) {
            details.push(escapeProse(entry.reason));
          }
          if (Array.isArray(entry.evidence)) {
            details.push(m.evidenceNotes(entry.evidence.length));
          }
          return [[code(row), code(host.host), entry.state ?? m.unavailable, details.length > 0 ? details.join('<br />') : m.notApplicable]];
        }),
      ),
    ),
  );

  sections.push(`## ${m.pluginComponents}\n`);
  sections.push(m.pluginComponentsIntro);
  for (const host of hosts) {
    const rows: FlattenedRow[] = [];
    flattenPlugin(asObject(host.data.plugin), '', m, rows);
    sections.push(`### ${hostHeader(host)}\n`);
    // One heading per top-level key, one list item per capability: a
    // 150-row three-column table scrolls sideways and has no anchors.
    const groups = Map.groupBy(rows, row => row.path.split('.')[0] ?? row.path);
    for (const [group, groupRows] of groups) {
      sections.push(`#### ${group}\n`);
      sections.push(groupRows.map(capabilityItem).join('\n'));
    }
  }

  return `${sections.join('\n\n')}\n`;
}

function renderEvents(hosts: readonly HostCapabilityTable[], m: Messages): string {
  const sections: string[] = [];
  sections.push(frontmatter(m.eventsTitle, m.eventsDescription));
  sections.push(`# ${m.eventsTitle}\n`);
  sections.push(m.generatedFromCapabilities(hosts.map(host => host.fileName)));
  sections.push(m.eventsIntro);

  sections.push(`## ${m.eventRoutes}\n`);
  sections.push(m.eventRoutesIntro);
  const eventKeys = unionKeys(hosts, eventRoutesOf);
  sections.push(
    table(
      [m.headers.canonicalEvent, ...hosts.map(hostHeader)],
      eventKeys.map(eventKey => [
        code(eventKey),
        ...hosts.map(host => stateCell(capabilityRow(eventRoutesOf(host.data)[eventKey]), m)),
      ]),
    ),
  );

  sections.push(`## ${m.unavailableRoutes}\n`);
  for (const host of hosts) {
    const routes = eventRoutesOf(host.data);
    const unavailable = Object.entries(routes)
      .map(([eventKey, value]) => [eventKey, capabilityRow(value)] as const)
      .filter(([, row]) => row !== undefined && row.state !== 'supported');
    const surfaceLimited = Object.entries(routes)
      .map(([eventKey, value]) => [eventKey, capabilityRow(value)] as const)
      .filter(([, row]) => row?.availability !== undefined);
    if (unavailable.length === 0 && surfaceLimited.length === 0) {
      continue;
    }
    sections.push(`### ${hostHeader(host)}\n`);
    const bullets: string[] = [];
    for (const [eventKey, row] of unavailable) {
      bullets.push(`- ${code(eventKey)} — ${escapeProse(row?.reason ?? m.unavailable)}`);
    }
    for (const [eventKey, row] of surfaceLimited) {
      for (const [surface, availability] of Object.entries(row?.availability ?? {})) {
        if (availability.state !== 'supported') {
          bullets.push(
            `- ${code(eventKey)} (${surface}) — ${escapeProse(availability.reason ?? availability.state ?? m.unavailable)}`,
          );
        }
      }
    }
    sections.push(bullets.join('\n'));
  }

  sections.push(`## ${m.configHookEvents}\n`);
  sections.push(m.configHookEventsIntro);
  const hookHosts = hosts.filter(host => Object.keys(asObject(asObject(host.data.hooks).events)).length > 0);
  const configKeys = unionKeys(hookHosts, data => asObject(asObject(data.hooks).events));
  sections.push(
    table(
      [m.headers.configKey, ...hookHosts.map(hostHeader)],
      configKeys.map(configKey => [
        code(configKey),
        ...hookHosts.map(host => {
          const native = asString(asObject(asObject(host.data.hooks).events)[configKey]);
          return native === undefined ? m.notApplicable : code(native);
        }),
      ]),
    ),
  );

  sections.push(`## ${m.toolSelectors}\n`);
  sections.push(m.toolSelectorsIntro);
  const matcherHosts = hosts.filter(host => Object.keys(asObject(asObject(host.data.hooks).matchers)).length > 0);
  const selectorKeys = unionKeys(matcherHosts, data => asObject(asObject(data.hooks).matchers));
  sections.push(
    table(
      [m.headers.selector, ...matcherHosts.map(hostHeader)],
      selectorKeys.map(selector => [
        code(selector),
        ...matcherHosts.map(host => {
          const matcher = asString(asObject(asObject(host.data.hooks).matchers)[selector]);
          return matcher === undefined ? m.notApplicable : code(matcher);
        }),
      ]),
    ),
  );

  sections.push(`## ${m.deferredNativeEvents}\n`);
  sections.push(m.deferredNativeEventsIntro);
  for (const host of hosts) {
    const deferred = asObject(host.data.deferredNativeEvents);
    const entries = Object.entries(deferred).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) {
      continue;
    }
    sections.push(`### ${hostHeader(host)}\n`);
    sections.push(
      table(
        [m.headers.nativeEvent, m.headers.state, m.headers.reason],
        entries.map(([nativeEvent, value]) => {
          const row = capabilityRow(value);
          return [code(nativeEvent), row?.state ?? m.unavailable, escapeProse(row?.reason ?? '')];
        }),
      ),
    );
  }

  return `${sections.join('\n\n')}\n`;
}

function renderNotices(hosts: readonly HostCapabilityTable[], m: Messages): string {
  const sections: string[] = [];
  sections.push(frontmatter(m.noticesTitle, m.noticesDescription));
  sections.push(`# ${m.noticesTitle}\n`);
  sections.push(m.generatedFromCapabilities(hosts.map(host => host.fileName)));
  sections.push(m.noticesIntro);

  sections.push(`## ${m.recipientAxes}\n`);
  sections.push(m.recipientAxesIntro);
  sections.push(table(m.recipientAxisHeaders, m.recipientAxisRows));

  sections.push(`## ${m.publisherView}\n`);
  sections.push(m.publisherViewIntro);

  sections.push(`## ${m.noticeChannels}\n`);
  const channels = unionKeys(hosts, data => asObject(data.noticeDelivery));
  sections.push(
    table(
      [m.headers.channel, ...hosts.map(hostHeader)],
      channels.map(channel => [
        code(channel),
        ...hosts.map(host => stateCell(capabilityRow(asObject(host.data.noticeDelivery)[channel]), m)),
      ]),
    ),
  );

  sections.push(`## ${m.sensitivityCeilings}\n`);
  sections.push(m.sensitivityIntro);
  sections.push(
    table(
      [m.headers.channel, ...hosts.map(hostHeader)],
      channels.map(channel => [
        code(channel),
        ...hosts.map(host => {
          const row = asObject(asObject(host.data.noticeDelivery)[channel]);
          if (row.state !== 'supported') return '—';
          return code(typeof row.sensitivity === 'string' ? row.sensitivity : 'internal');
        }),
      ]),
    ),
  );
  const ceilingEvidence = new Map<string, { readonly channel: string; readonly hosts: string[] }>();
  for (const host of hosts) {
    for (const [channel, value] of Object.entries(asObject(host.data.noticeDelivery))) {
      const row = asObject(value);
      if (row.state !== 'supported' || typeof row.sensitivityEvidence !== 'string') continue;
      const key = `${channel}\u0000${row.sensitivityEvidence}`;
      const existing = ceilingEvidence.get(key);
      if (existing !== undefined) {
        existing.hosts.push(host.host);
      } else {
        ceilingEvidence.set(key, { channel, hosts: [host.host] });
      }
    }
  }
  sections.push(`### ${m.sensitivityEvidence}\n`);
  sections.push(
    table(
      [m.headers.channel, m.headers.hosts, m.headers.reason],
      [...ceilingEvidence.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [
          code(entry.channel),
          entry.hosts.map(code).join(', '),
          escapeProse(key.split('\u0000')[1] ?? ''),
        ]),
    ),
  );

  sections.push(`## ${m.unavailableChannels}\n`);
  const reasons = new Map<string, { readonly channel: string; readonly hosts: string[] }>();
  for (const host of hosts) {
    for (const [channel, value] of Object.entries(asObject(host.data.noticeDelivery))) {
      const row = capabilityRow(value);
      if (row === undefined || row.state === 'supported') {
        continue;
      }
      const key = `${channel}\u0000${row.reason ?? ''}`;
      const existing = reasons.get(key);
      if (existing !== undefined) {
        existing.hosts.push(host.host);
      } else {
        reasons.set(key, { channel, hosts: [host.host] });
      }
    }
  }
  sections.push(
    table(
      [m.headers.channel, m.headers.hosts, m.headers.reason],
      [...reasons.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [
          code(entry.channel),
          entry.hosts.map(code).join(', '),
          escapeProse(key.split('\u0000')[1] ?? ''),
        ]),
    ),
  );

  return `${sections.join('\n\n')}\n`;
}

async function renderDiagnostics(repoRoot: string, m: Messages): Promise<string> {
  const source = await readFile(path.join(repoRoot, ...diagnosticsSource), 'utf8');
  const lines = source.split('\n');
  const headingIndex = lines.findIndex(line => line.startsWith('# '));
  if (headingIndex === -1) {
    throw new Error('docs/diagnostics.md has no top-level heading.');
  }
  const body = rewriteRepoDocLinks(lines.slice(headingIndex + 1).join('\n').trim());
  return `${frontmatter(m.diagnosticsTitle, m.diagnosticsDescription)}\n# ${m.diagnosticsTitle}\n\n${m.generatedFromDiagnostics}\n\n${body}\n`;
}

/**
 * `docs/diagnostics.md` links to sibling repository docs by relative path.
 * Those siblings are not site pages, so the copy points them at GitHub
 * instead of leaving dead links for Rspress to reject.
 */
function rewriteRepoDocLinks(markdown: string): string {
  return markdown.replaceAll(
    /\]\(([\w./-]+\.md)(#[\w-]*)?\)/g,
    (_match, target: string, fragment: string | undefined) =>
      `](${new URL(target, `${repositoryUrl}/docs/`).href}${fragment ?? ''})`,
  );
}

/** Render every generated reference page for one locale into `targetDir`. */
export async function writeGeneratedReference(
  options: GeneratedReferenceOptions,
  docsRoot: string,
): Promise<void> {
  const hosts = await loadCapabilityTables(options.repoRoot);
  for (const locale of options.locales) {
    const m = messages[locale.lang];
    const targetDir = path.join(docsRoot, locale.dir, 'reference');
    await mkdir(targetDir, { recursive: true });
    const pages: Record<(typeof generatedReferencePages)[number], string> = {
      diagnostics: await renderDiagnostics(options.repoRoot, m),
      events: renderEvents(hosts, m),
      hosts: renderHosts(hosts, m),
      notices: renderNotices(hosts, m),
    };
    for (const page of generatedReferencePages) {
      await writeFile(path.join(targetDir, `${page}.md`), pages[page], 'utf8');
    }
  }
}

/**
 * Registered after `pluginTypeDoc` and the locale mirror so every generated
 * page exists before Rspress scans routes and checks links.
 */
export function generatedReference(options: GeneratedReferenceOptions): RspressPlugin {
  return {
    name: 'agent-bundle/generated-reference',
    async config(config) {
      if (!config.root) {
        return config;
      }
      await writeGeneratedReference(options, config.root);
      return config;
    },
  };
}
