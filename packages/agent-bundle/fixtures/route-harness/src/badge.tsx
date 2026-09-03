import type { ReactElement } from 'react';

/** A JSX helper shared by the fixture's plain `badge` script; not a route. */
export const Badge = ({ label }: { readonly label: string }): ReactElement => (
  <span className="badge">{label}</span>
);
