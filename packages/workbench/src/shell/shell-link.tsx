import React from 'react';

import { formatWorkbenchLocation, type WorkbenchLocation } from './workbench-location.ts';

export type ShellLinkProps = Readonly<{
  readonly location: WorkbenchLocation;
  /** Absent when the host has no router (a static render): the anchor is then a plain `href`. */
  readonly onNavigate?: (location: WorkbenchLocation) => void;
}> & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>;

/** A shell link: a real `href` for middle-click and copy, the router for a plain click. */
export const ShellLink = ({ location, onNavigate, ...anchor }: ShellLinkProps): React.ReactNode =>
  <a
    {...anchor}
    href={formatWorkbenchLocation(location)}
    onClick={onNavigate === undefined ? undefined : (event) => { event.preventDefault(); onNavigate(location); }}
  />;
