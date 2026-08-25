import { App, PostMessageTransport } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'mcp-app-status-panel', version: '1.0.0' }, {});

app.addEventListener('toolresult', (result) => {
  const content = result.structuredContent as { service?: string; status?: string } | undefined;
  document.querySelector('#service')!.textContent = content?.service ?? 'No service selected';
  document.querySelector('#status')!.textContent = content?.status ?? 'unknown';
});

document.querySelector('#toggle-details')!.addEventListener('click', () => {
  document.querySelector('#details')!.toggleAttribute('hidden');
});

await app.connect(new PostMessageTransport(window.parent, window.parent));
