import { type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';

import type { McpAppConsentChallenge } from './mcp-app-client.ts';
import type { RuntimeConsentDecision } from './runtime-consent-queue.ts';

export interface RuntimeConsentDialogProps {
  readonly challenge: McpAppConsentChallenge;
  readonly onResolve: (decision: RuntimeConsentDecision) => void;
}

const summaryFor = (challenge: McpAppConsentChallenge): string => {
  const request = challenge.request;
  if (request === null || typeof request !== 'object' || Array.isArray(request) || !Object.hasOwn(request, 'summary')) {
    return 'Allow this Runtime App action?';
  }
  return typeof request.summary === 'string' ? request.summary : 'Allow this Runtime App action?';
};

/** Workbench-owned modal boundary for one visible action-consent queue entry. */
export const RuntimeConsentDialog = ({ challenge, onResolve }: RuntimeConsentDialogProps): ReactNode => {
  const allow = useRef<HTMLButtonElement>(null);
  const deny = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLElement>();

  useLayoutEffect(() => {
    const active = document.activeElement;
    restoreFocus.current = active instanceof HTMLElement ? active : undefined;
    return () => {
      const prior = restoreFocus.current;
      queueMicrotask(() => {
        if (prior?.isConnected && !prior.closest('[inert]')) prior.focus();
      });
    };
  }, []);
  useLayoutEffect(() => { deny.current?.focus(); }, [challenge.id]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onResolve('deny');
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = [deny.current, allow.current].filter((control): control is HTMLButtonElement => control !== null && !control.disabled);
      if (controls.length === 0) return;
      const currentIndex = controls.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex = event.shiftKey
        ? currentIndex <= 0 ? controls.length - 1 : currentIndex - 1
        : currentIndex === controls.length - 1 ? 0 : currentIndex + 1;
      event.preventDefault();
      controls[nextIndex]?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onResolve]);

  return <div className="runtime-consent-backdrop">
    <section aria-describedby="runtime-consent-summary" aria-label="Runtime App consent" aria-modal="true" className="runtime-consent-dialog" role="dialog">
      <h2 id="runtime-consent-title">Runtime App permission request</h2>
      <p id="runtime-consent-summary">{summaryFor(challenge)}</p>
      <button onClick={() => { onResolve('deny'); }} ref={deny} type="button">Deny</button>
      <button onClick={() => { onResolve('allow-once'); }} ref={allow} type="button">Allow once</button>
    </section>
  </div>;
};
