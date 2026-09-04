import type {
  AgentHostIdentity,
  AgentLineage,
  AgentNotice,
  AgentNoticesHandle,
  AgentPluginIdentity,
  AgentProviderRequest,
  AgentSessionIdentity,
  AgentStateHandle,
  AgentWorkspaceIdentity,
  Observed,
} from '@agent-bundle/runtime';
import { expect, it } from '@rstest/core';

import type {
  AgentProviderContext,
  AgentProviderHostIdentity,
  AgentProviderLineage,
  AgentProviderNotice,
  AgentProviderNoticesHandle,
  AgentProviderObserved,
  AgentProviderPluginRoot,
  AgentProviderSessionIdentity,
  AgentProviderStateHandle,
  AgentProviderWorkspaceIdentity,
} from '../src/index.ts';

/**
 * `agent-bundle`'s root declarations must not import `@agent-bundle/runtime`
 * (an optional peer a config-only consumer need not install), so the request
 * view a provider receives is spelled structurally in `routes/public.ts`
 * (#459). This test pins those mirrors to the runtime's own types: the
 * identity axes and lineage are exact copies, the notice record covers every
 * runtime field (with `content` opaque), and the read-only handles accept the
 * runtime's narrowed handles — so a runtime change that drifts from the mirror
 * fails to compile here instead of surprising a provider author.
 */

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Extends<A, B> = A extends B ? true : false;
type Assert<_T extends true> = true;

// Exact mirrors.
type _host = Assert<Equal<AgentHostIdentity, AgentProviderHostIdentity>>;
type _session = Assert<Equal<AgentSessionIdentity, AgentProviderSessionIdentity>>;
type _workspace = Assert<Equal<AgentWorkspaceIdentity, AgentProviderWorkspaceIdentity>>;
type _plugin = Assert<Equal<AgentPluginIdentity, AgentProviderPluginRoot>>;
type _lineage = Assert<Equal<AgentLineage, AgentProviderLineage>>;
// `Observed<T>` narrows `reason` to the runtime's reason union; the mirror admits any string.
type _observed = Assert<Extends<Observed<AgentLineage>, AgentProviderObserved<AgentProviderLineage>>>;

// The notice record: every runtime field is present, and every runtime notice is a provider notice.
type _noticeKeys = Assert<Equal<keyof AgentNotice, keyof AgentProviderNotice>>;
type _notice = Assert<Extends<AgentNotice, AgentProviderNotice>>;

// The read-only handles: the runtime's narrowed handles satisfy the mirrors …
type _state = Assert<Extends<Pick<AgentStateHandle, 'lifetime' | 'read'>, AgentProviderStateHandle>>;
type _notices = Assert<Extends<Pick<AgentNoticesHandle, 'inbox' | 'published'>, AgentProviderNoticesHandle>>;
// … and the runtime's whole request view, beside the surface invocation, is a provider context.
type _request = Assert<Extends<AgentProviderRequest & Pick<AgentProviderContext, 'invocation'>, AgentProviderContext>>;

// Type-level read-only: no write path is spelled on the provider context.
type StateKeys = keyof NonNullable<AgentProviderContext['state']>;
type NoticeKeys = keyof NonNullable<AgentProviderContext['notices']>;
type _stateReadOnly = Assert<Equal<StateKeys, 'lifetime' | 'read'>>;
type _noticesReadOnly = Assert<Equal<NoticeKeys, 'inbox' | 'published'>>;
type _noDispatch = Assert<Equal<Extends<'dispatch', StateKeys>, false>>;
type _noPublish = Assert<Equal<Extends<'publish' | 'acknowledge' | 'read', NoticeKeys>, false>>;

it('pins the provider context mirrors to the runtime types (#459)', () => {
  // The assertions above are compile-time; this keeps the file in the suite.
  const pinned: [
    _host, _session, _workspace, _plugin, _lineage, _observed,
    _noticeKeys, _notice, _state, _notices, _request,
    _stateReadOnly, _noticesReadOnly, _noDispatch, _noPublish,
  ] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
  expect(pinned.every(Boolean)).toBe(true);
});
