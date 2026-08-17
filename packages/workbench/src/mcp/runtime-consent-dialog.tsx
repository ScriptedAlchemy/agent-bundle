import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { RuntimeConsentDecision, RuntimeConsentQueueCurrent } from './runtime-consent-queue.ts';

export interface RuntimeConsentDialogProps {
  readonly current: RuntimeConsentQueueCurrent;
  readonly onResolve: (current: RuntimeConsentQueueCurrent, decision: RuntimeConsentDecision) => boolean;
}

const summaryFor = (current: RuntimeConsentQueueCurrent): string => {
  const request = current.challenge.request;
  if (request === null || typeof request !== 'object' || Array.isArray(request) || !Object.hasOwn(request, 'summary')) {
    return 'Allow this Runtime App action?';
  }
  return typeof request.summary === 'string' ? request.summary : 'Allow this Runtime App action?';
};

/** Workbench-owned modal boundary for one visible action-consent queue entry. */
export const RuntimeConsentDialog = ({ current, onResolve }: RuntimeConsentDialogProps): ReactNode => {
  const allow = useRef<HTMLButtonElement>(null);
  const deny = useRef<HTMLButtonElement>(null);
  const decisionCurrent = useRef(current);
  const decisionLatched = useRef(false);
  const restoreFocus = useRef<HTMLElement>();
  const [decisionPending, setDecisionPending] = useState(false);

  if (decisionCurrent.current !== current) {
    decisionCurrent.current = current;
    decisionLatched.current = false;
  }

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
  useLayoutEffect(() => {
    setDecisionPending(false);
    deny.current?.focus();
    const frame = requestAnimationFrame(() => { deny.current?.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [current]);
  const resolveOnce = useCallback((decision: RuntimeConsentDecision): void => {
    if (decisionLatched.current) return;
    decisionLatched.current = true;
    setDecisionPending(true);
    onResolve(current, decision);
  }, [current, onResolve]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (event.repeat) return;
        resolveOnce('deny');
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
  }, [resolveOnce]);

  return <div className="runtime-consent-backdrop">
    <section aria-describedby="runtime-consent-summary" aria-label="Runtime App consent" aria-modal="true" className="runtime-consent-dialog" role="dialog">
      <h2 id="runtime-consent-title">Runtime App permission request</h2>
      <p id="runtime-consent-summary">{summaryFor(current)}</p>
      <button disabled={decisionPending} onClick={(event) => {
        if (event.detail > 1) {
          event.preventDefault();
          deny.current?.focus();
          return;
        }
        resolveOnce('deny');
      }} onMouseDown={(event) => { if (event.detail > 1) event.preventDefault(); }} ref={deny} type="button">Deny</button>
      <button disabled={decisionPending} onClick={(event) => {
        if (event.detail > 1) {
          event.preventDefault();
          deny.current?.focus();
          return;
        }
        resolveOnce('allow-once');
      }} onMouseDown={(event) => { if (event.detail > 1) event.preventDefault(); }} ref={allow} type="button">Allow once</button>
    </section>
  </div>;
};
