/**
 * Control's operator API (private listener, operator bearer token from control's dev-init): releases, rollouts,
 * cohorts, device flags, entitlements, emergency stop. Used by the update scenarios and to keep test orgs entitled.
 */
import { readFileSync } from 'node:fs';
import { controlApi } from './cloud.ts';
import { env } from './world.ts';

function op<T>(method: string, path: string, body?: unknown): Promise<T> {
  const e = env();
  const token = readFileSync(e.control?.operatorTokenFile ?? '', 'utf8').trim();
  return controlApi<T>(e.control?.adminUrl ?? '', method, `/v1/operator${path}`, {
    token,
    ...(body !== undefined ? { body } : {}),
  });
}

export const operator = {
  entitle: (org: string, devicesAllowed = 1000) =>
    op('PUT', `/orgs/${org}/entitlement`, { state: 'active', devicesAllowed }),
  cohorts: () => op<{ cohorts: { cohort: string; kind: string; devices: number }[] }>('GET', '/cohorts'),
  setInternal: (device: string, internal: boolean) => op('PUT', `/devices/${device}/internal`, { internal }),
  device: (device: string) => op<Record<string, unknown>>('GET', `/devices/${device}`),
  deviceAssignment: (device: string) => op<Record<string, unknown>>('GET', `/devices/${device}/assignment`),
  registerRelease: (tuple: unknown) =>
    op<{ release: string; tupleDigest: string }>('POST', '/releases', { tuple }),
  releases: () => op<{ releases: { release: string; state: string }[] }>('GET', '/releases'),
  createRollout: (release: string, cohort: string) =>
    op<{ rollout: string; state: string; counts: Record<string, number> }>('POST', '/rollouts', {
      release,
      waves: [
        {
          index: 0,
          cohorts: [cohort],
          basisPoints: 10_000,
          minObservationS: 0,
          failureThresholdBp: 10_000,
          minSample: 0,
        },
      ],
    }),
  rollout: (id: string) =>
    op<{ rollout: string; state: string; counts: Record<string, number>; pauseReason: string | null }>(
      'GET',
      `/rollouts/${id}`,
    ),
  stopRollout: (id: string, reason = 'harness-cleanup') => op('POST', `/rollouts/${id}/stop`, { reason }),
  rollouts: () => op<{ rollouts: { rollout: string; state: string; release: string }[] }>('GET', '/rollouts'),
};
