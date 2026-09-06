import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import React, { useEffect, useRef } from 'react';

import { errorMessage, isAbortError } from '../client-helpers.ts';
import type { HostSession, HostSessionSize } from '../../../agent-bundle/src/contracts/host-sessions.ts';
import type { HostSessionClient } from './host-session-client.ts';
import './terminal.css';

export interface SessionTerminalProps {
  readonly client: HostSessionClient;
  /** Only a running session receives `input` and `resize`; an ended one just replays. */
  readonly live: boolean;
  readonly onError: (message: string) => void;
  /** Every `state`/`end` frame of the stream. */
  readonly onSession: (session: HostSession) => void;
  /** The fitted size, for the next launch to start at the pane's real dimensions. */
  readonly onSize: (size: HostSessionSize) => void;
  readonly sessionId: string;
}

const resizeDebounceMs = 100;

/**
 * One xterm per mounted session id: opens the SSE stream, writes `output`
 * bytes straight into the terminal, forwards keystrokes as `input`, and fits
 * to its pane (debounced) before reporting the size as `resize`. The stream's
 * scrollback replay refills a remounted terminal.
 */
export const SessionTerminal = ({ client, live, onError, onSession, onSize, sessionId }: SessionTerminalProps): React.ReactNode => {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ live, onError, onSession, onSize });
  callbacks.current = { live, onError, onSession, onSize };

  useEffect(() => {
    const element = host.current!;
    const controller = new AbortController();
    const fail = (reason: unknown): void => {
      if (!controller.signal.aborted && !isAbortError(reason)) callbacks.current.onError(errorMessage(reason, 'The host session request failed.'));
    };
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      scrollback: 5_000,
      theme: { background: '#101822' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    const input = term.onData((data) => {
      if (callbacks.current.live) client.input(sessionId, data).catch(fail);
    });
    const resized = term.onResize(({ cols, rows }) => {
      const size = { cols, rows };
      callbacks.current.onSize(size);
      if (callbacks.current.live) client.resize(sessionId, size).catch(fail);
    });
    let pending: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(pending);
      pending = setTimeout(() => fit.fit(), resizeDebounceMs);
    });
    observer.observe(element);
    fit.fit();
    term.focus();
    client.stream(sessionId, (message) => {
      switch (message.type) {
        case 'output':
          term.write(message.bytes);
          break;
        case 'state':
        case 'end':
          callbacks.current.onSession(message.session);
          break;
        default: {
          const exhaustive: never = message;
          return exhaustive;
        }
      }
    }, controller.signal).catch(fail);
    return () => {
      controller.abort();
      clearTimeout(pending);
      observer.disconnect();
      input.dispose();
      resized.dispose();
      term.dispose();
    };
  }, [client, sessionId]);

  return <div className="session-terminal" data-session-id={sessionId} data-testid="sessions-terminal" ref={host} />;
};
