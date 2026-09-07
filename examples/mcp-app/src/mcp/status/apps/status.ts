import type { AppRouteConfig } from 'agent-bundle';
import { type AppClientError, type AppRouteInput, type AppRouteResult, createAppClient } from 'agent-bundle/app';
import { name, version } from 'agent-bundle/meta';

import { readinessPolicyUri } from '../../../readiness-policy.ts';

export const config = {
  resourceUri: 'ui://mcp-app-example/status.html',
  template: './status.html',
} satisfies AppRouteConfig;

const showStatusRoute = 'tool:status/show-status';

type Service = AppRouteInput<typeof showStatusRoute>['service'];
type ServiceStatus = AppRouteResult<typeof showStatusRoute>;

/** The service the host asked for, so refresh can retry a failed opening call. */
let currentService: Service | undefined;

const serviceHeading = document.querySelector<HTMLHeadingElement>('#service')!;
const statusIndicator = document.querySelector<HTMLElement>('#status-indicator')!;
const status = document.querySelector<HTMLElement>('#status')!;
const summary = document.querySelector<HTMLParagraphElement>('#summary')!;
const checks = document.querySelector<HTMLUListElement>('#checks')!;
const bridgeOutcome = document.querySelector<HTMLParagraphElement>('#bridge-outcome')!;

/**
 * `checking` while a call is in flight; `healthy`/`degraded` from the tool;
 * `unavailable` is the panel's own verdict when the opening call fails to
 * produce a status.
 */
type StatusState = 'checking' | ServiceStatus['status'] | 'unavailable';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const resourceText = (value: unknown): string | undefined => {
  if (!isRecord(value) || !Array.isArray(value.contents)) return undefined;
  const content = value.contents[0];
  return isRecord(content) && typeof content.text === 'string' ? content.text : undefined;
};

const setStatus = (state: StatusState) => {
  statusIndicator.dataset.state = state;
  status.textContent = state;
};

/**
 * The detail behind a failed opening call. An `isError` result carries the
 * whole tool result on `error.data`, so its text block explains the failure
 * in the tool's words; a malformed result or one without structured content
 * has no data, and the client's own message is the detail.
 */
const toolErrorDetail = (error: AppClientError): string => {
  const content = isRecord(error.data) && Array.isArray(error.data.content) ? error.data.content : [];
  const block: unknown = content.find((entry: unknown) => isRecord(entry) && entry.type === 'text');
  return isRecord(block) && typeof block.text === 'string' ? block.text : error.message;
};

const renderStatus = (result: ServiceStatus) => {
  serviceHeading.textContent = result.service;
  setStatus(result.status);
  summary.textContent = result.summary;
  checks.replaceChildren(...result.checks.map((check) => {
    const item = document.createElement('li');
    const label = document.createElement('span');
    const outcome = document.createElement('strong');
    label.textContent = check.label;
    outcome.textContent = check.status;
    item.dataset.state = check.status === 'passing' ? 'healthy' : 'degraded';
    item.append(label, outcome);
    return item;
  }));
};

const client = createAppClient({
  appInfo: { name, version },
});

client.onToolInput(showStatusRoute, ({ service }) => {
  currentService = service;
  serviceHeading.textContent = service;
  setStatus('checking');
  summary.textContent = `Checking readiness for ${service}.`;
  checks.replaceChildren();
});

client.onToolResult(showStatusRoute, renderStatus);

// A failed opening call — `isError: true`, a malformed result, or one without
// structured content — never reaches `onToolResult`. Leave the requested
// service in the heading, exit `checking`, and say why there is no status.
client.onToolError(showStatusRoute, (error) => {
  setStatus('unavailable');
  summary.textContent = `Readiness is unavailable: ${toolErrorDetail(error)}`;
  checks.replaceChildren();
});

client.onToolCancelled(({ reason }) => {
  setStatus('unavailable');
  summary.textContent = reason === undefined
    ? 'Readiness check cancelled.'
    : `Readiness check cancelled: ${reason}`;
  checks.replaceChildren();
});

document.querySelector('#toggle-details')!.addEventListener('click', () => {
  document.querySelector('#details')!.toggleAttribute('hidden');
});

document.querySelector('#read-policy')!.addEventListener('click', async () => {
  try {
    const text = resourceText(await client.request('resources/read', { uri: readinessPolicyUri }));
    bridgeOutcome.textContent = text ?? 'Readiness policy unavailable.';
  } catch {
    bridgeOutcome.textContent = 'Readiness policy unavailable.';
  }
});

// Refresh re-runs the opening tool for the service on screen.
document.querySelector('#refresh-status')!.addEventListener('click', async () => {
  if (currentService === undefined) return;
  try {
    renderStatus(await client.call(showStatusRoute, { service: currentService }));
    bridgeOutcome.textContent = 'Status refreshed.';
  } catch {
    bridgeOutcome.textContent = 'Refresh unavailable.';
  }
});

await client.connect();
