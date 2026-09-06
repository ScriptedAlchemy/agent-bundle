import { createElement, isValidElement, type MouseEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from '@rstest/core';

import { ShellLink, type ShellLinkProps } from '../src/shell/shell-link.tsx';
import type { WorkbenchLocation } from '../src/shell/workbench-location.ts';

interface AnchorProps {
  readonly href: string;
  readonly onClick?: (event: Pick<MouseEvent<HTMLAnchorElement>, 'preventDefault'>) => void;
}

/** The anchor element the component returns, before React renders it. */
const anchorOf = (props: ShellLinkProps): AnchorProps => {
  const rendered = ShellLink(props);
  if (!isValidElement<AnchorProps>(rendered) || rendered.type !== 'a') throw new Error('ShellLink must render an anchor.');
  return rendered.props;
};

it('renders the formatted href and routes a plain click through the shell instead of reloading', () => {
  const navigated: WorkbenchLocation[] = [];
  const location: WorkbenchLocation = { area: 'trace', correlation: 'corr 1' };
  const props: ShellLinkProps = { children: 'Open in Trace', className: 'x', location, onNavigate: (next) => navigated.push(next) };

  expect(renderToStaticMarkup(createElement(ShellLink, props))).toBe('<a class="x" href="/trace?correlation=corr%201">Open in Trace</a>');
  let prevented = 0;
  anchorOf(props).onClick?.({ preventDefault: () => { prevented += 1; } });
  expect(prevented).toBe(1);
  expect(navigated).toEqual([location]);
});

it('stays a plain anchor when the host has no router', () => {
  const anchor = anchorOf({ children: 'x', location: { area: 'trace', invocationId: 'inv_1' } });
  expect(anchor.href).toBe('/trace/inv_1');
  expect(anchor.onClick).toBeUndefined();
});
