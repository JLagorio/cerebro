/** Discovery is not a sign-in check. Only the browser fixture has no executable path. */
export type CliReadinessCode = 'ipc' | 'timeout' | 'permission' | 'probe_failed' | 'output_limit';

export type CliReadinessProbe =
  | {
      state: 'available';
      path: string | null;
      version: string | null;
      backend: 'native' | 'browser_mock';
    }
  | { state: 'missing' }
  | { state: 'unavailable'; code: Exclude<CliReadinessCode, 'ipc'> };

export type CliReadiness =
  | { state: 'checking'; generation: number; observedAt: null }
  | (CliReadinessProbe & { generation: number; observedAt: string })
  | { state: 'unavailable'; code: 'ipc'; generation: number; observedAt: string };
