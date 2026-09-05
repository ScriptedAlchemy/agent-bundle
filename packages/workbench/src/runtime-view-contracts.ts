import type { ReactNode } from 'react';

import type {
  DevRuntimeInspectionEnvelope,
  DevRuntimeRun,
  DevRuntimeSurface,
} from '../../agent-bundle/src/contracts/runtime.ts';
import type { RuntimeProfileOption } from './runtime-model.ts';

export interface RuntimeAppPreviewLifecycle {
  close(): Promise<void>;
}

export type RuntimeAppPreviewLifecycleRegistrar = (
  handle: RuntimeAppPreviewLifecycle,
) => () => void;

export interface RuntimeAppPreviewProps {
  readonly profile: RuntimeProfileOption;
  readonly profileId: string;
  readonly registerLifecycle?: RuntimeAppPreviewLifecycleRegistrar;
  readonly run: DevRuntimeRun;
  readonly surface: DevRuntimeSurface;
}

export type RuntimeAppPreviewRenderer = (
  props: RuntimeAppPreviewProps,
) => ReactNode;

export interface RuntimeLiveMcpPageProps extends RuntimeAppPreviewProps {
  readonly mcpBinding:
    NonNullable<DevRuntimeInspectionEnvelope['app']>['mcpBinding'];
}

export type RuntimeLiveMcpPageRenderer = (
  props: RuntimeLiveMcpPageProps,
) => ReactNode;

export type RuntimeLiveMcpPageAdapter =
  | Readonly<{ readonly kind: 'disabled' }>
  | Readonly<{
      readonly kind: 'host-owned';
      readonly render: RuntimeLiveMcpPageRenderer;
    }>;
