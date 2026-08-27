import type { Transport } from '@modelcontextprotocol/client';

import type { McpSessionFrame } from './mcp-session-types.ts';

type RawMcpFrame = Parameters<Transport['send']>[0];

export class RecordingTransport implements Transport {
  readonly #inner: Transport;
  readonly #record: (direction: McpSessionFrame['direction'], message: RawMcpFrame) => void;
  #onclose: Transport['onclose'];
  #onerror: Transport['onerror'];
  #onmessage: Transport['onmessage'];

  constructor(inner: Transport, record: (direction: McpSessionFrame['direction'], message: RawMcpFrame) => void) {
    this.#inner = inner;
    this.#record = record;
    this.#inner.onclose = () => this.#onclose?.();
    this.#inner.onerror = (error) => this.#onerror?.(error);
    this.#inner.onmessage = ((message, extra) => {
      this.#record('server', message);
      this.#onmessage?.(message, extra);
    }) as Transport['onmessage'];
  }

  get hasPerRequestStream(): boolean | undefined {
    return this.#inner.hasPerRequestStream;
  }

  get onclose(): Transport['onclose'] {
    return this.#onclose;
  }

  set onclose(next: Transport['onclose']) {
    this.#onclose = next;
  }

  get onerror(): Transport['onerror'] {
    return this.#onerror;
  }

  set onerror(next: Transport['onerror']) {
    this.#onerror = next;
  }

  get onmessage(): Transport['onmessage'] {
    return this.#onmessage;
  }

  set onmessage(next: Transport['onmessage']) {
    this.#onmessage = next;
  }

  get sessionId(): string | undefined {
    return this.#inner.sessionId;
  }

  setProtocolVersion(version: string): void {
    this.#inner.setProtocolVersion?.(version);
  }

  setSupportedProtocolVersions(versions: string[]): void {
    this.#inner.setSupportedProtocolVersions?.(versions);
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }

  async send(message: RawMcpFrame, options?: Parameters<Transport['send']>[1]): Promise<void> {
    this.#record('client', message);
    await this.#inner.send(message, options);
  }

  async start(): Promise<void> {
    await this.#inner.start();
  }
}
