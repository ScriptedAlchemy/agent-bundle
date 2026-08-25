import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'mcp-app-status-panel', version: '1.0.0' }, {});
const serviceHeading = document.querySelector<HTMLHeadingElement>('#service')!;
const statusIndicator = document.querySelector<HTMLElement>('#status-indicator')!;
const status = document.querySelector<HTMLElement>('#status')!;
const summary = document.querySelector<HTMLParagraphElement>('#summary')!;
const checks = document.querySelector<HTMLUListElement>('#checks')!;

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

app.addEventListener('toolinput', ({ arguments: toolArguments }) => {
  const service = typeof toolArguments?.service === 'string' ? toolArguments.service : 'service';
  serviceHeading.textContent = service;
  setStatus('checking');
  summary.textContent = `Checking readiness for ${service}.`;
  renderChecks([]);
});

app.addEventListener('toolresult', (result) => {
  const content = result.structuredContent as ServiceStatus | undefined;
  serviceHeading.textContent = content?.service ?? 'No service selected';
  setStatus(content?.status);
  summary.textContent = content?.summary ?? 'No readiness summary was returned.';
  renderChecks(content?.checks ?? []);
});

document.querySelector('#toggle-details')!.addEventListener('click', () => {
  document.querySelector('#details')!.toggleAttribute('hidden');
});

await app.connect(new PostMessageTransport(window.parent, window.parent));
