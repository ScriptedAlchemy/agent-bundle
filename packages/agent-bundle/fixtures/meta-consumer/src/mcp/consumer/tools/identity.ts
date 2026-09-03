import { Agent } from '@agent-bundle/runtime';
import { createElement } from 'react';
import { z } from 'zod';

import { banner, identity } from '../../../lib/identity.ts';

export const config = {
  annotations: { readOnlyHint: true },
  description: 'Reports the identity agent-bundle/meta resolved to.',
  title: 'Identity',
};

export const inputSchema = z.object({});

export const resultSchema = z.object({
  banner: z.string(),
  name: z.string(),
  packageName: z.string().optional(),
  packageVersion: z.string().optional(),
  version: z.string(),
});

export default async function Identity() {
  // The document value is JSON; the optional npm axes are omitted when absent
  // rather than carried as `undefined`.
  const value = {
    banner,
    name: identity.name,
    ...(identity.packageName === undefined ? {} : { packageName: identity.packageName }),
    ...(identity.packageVersion === undefined ? {} : { packageVersion: identity.packageVersion }),
    version: identity.version,
  };
  return createElement(Agent.Result, { value }, createElement(Agent.Text, null, banner));
}
