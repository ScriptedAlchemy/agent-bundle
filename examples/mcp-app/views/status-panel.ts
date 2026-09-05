import { createAppClient } from 'agent-bundle/app';
import { name, version } from 'agent-bundle/meta';

const serviceHeading = document.querySelector<HTMLHeadingElement>('#service')!;
const statusIndicator = document.querySelector<HTMLElement>('#status-indicator')!;
const status = document.querySelector<HTMLElement>('#status')!;
const summary = document.querySelector<HTMLParagraphElement>('#summary')!;
const checks = document.querySelector<HTMLUListElement>('#checks')!;
const bridgeOutcome = document.querySelector<HTMLParagraphElement>('#bridge-outcome')!;

type StatusState = 'checking' | 'healthy' | 'degraded' | 'unknown';

interface ServiceCheck {
  readonly label?: string;
  readonly status?: string;
}

interface ServiceStatus {
  readonly checks?: readonly ServiceCheck[];
  readonly service?: string;
  readonly status?: string;
  readonly summary?: string;
}

interface StatusToolInput {
  readonly service: string;
}

/**
 * Config-declared Apps have no generated `AgentBundleRoutes`. This structural
 * map types `createAppClient` through the public `AppRegister` seam.
 */
type StatusPanelRouteContracts = {
  readonly 'tool:status/show-status': {
    readonly input: StatusToolInput;
    readonly result: ServiceStatus;
  };
  readonly 'tool:status/refresh-status': {
    readonly input: StatusToolInput;
    readonly result: ServiceStatus;
  };
};

declare module 'agent-bundle/app' {
  interface AppRegister {
    readonly routes: StatusPanelRouteContracts;
  }
}

const showStatusRoute = 'tool:status/show-status';
const refreshStatusRoute = 'tool:status/refresh-status';
const readinessPolicyUri = 'ui://mcp-app-example/readiness-policy';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const resourceText = (value: unknown): string | undefined => {
  if (!isRecord(value) || !Array.isArray(value.contents)) return undefined;
  const content = value.contents[0];
  return isRecord(content) && typeof content.text === 'string' ? content.text : undefined;
};

const statusState = (value: string | undefined): StatusState => {
  if (value === 'checking' || value === 'healthy' || value === 'degraded') return value;
  return 'unknown';
};

const checkState = (value: string | undefined): StatusState => {
  if (value === 'passing') return 'healthy';
  if (value === 'failing') return 'degraded';
  return 'unknown';
};

const setStatus = (value: string | undefined) => {
  const state = statusState(value);
  statusIndicator.dataset.state = state;
  status.textContent = state;
};

const renderChecks = (items: readonly ServiceCheck[]) => {
  checks.replaceChildren(...items.map((check) => {
    const item = document.createElement('li');
    const label = document.createElement('span');
    const result = document.createElement('strong');
    label.textContent = check.label ?? 'Unnamed check';
    result.textContent = check.status ?? 'unknown';
    item.dataset.state = checkState(check.status);
    item.append(label, result);
    return item;
  }));
};

const client = createAppClient({
  appInfo: { name, version },
});

client.onToolInput(showStatusRoute, (input) => {
  const service = typeof input.service === 'string' ? input.service : 'service';
  serviceHeading.textContent = service;
  setStatus('checking');
  summary.textContent = `Checking readiness for ${service}.`;
  renderChecks([]);
});

client.onToolResult(showStatusRoute, (result) => {
  serviceHeading.textContent = result.service ?? 'No service selected';
  setStatus(result.status);
  summary.textContent = result.summary ?? 'No readiness summary was returned.';
  renderChecks(result.checks ?? []);
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

document.querySelector('#refresh-status')!.addEventListener('click', async () => {
  try {
    await client.call(refreshStatusRoute, {
      service: serviceHeading.textContent ?? 'service',
    });
    bridgeOutcome.textContent = 'Status refreshed.';
  } catch {
    bridgeOutcome.textContent = 'Refresh unavailable.';
  }
});

await client.connect();
