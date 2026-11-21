/**
 * Which versions this is (docs/decisions/settings-simplify.md SS-06, SS-08): the web app's own (`VITE_WHOMBAT_VERSION`,
 * `apps/web/package.json`'s, and the build id `VITE_WHOMBAT_BUILD`, both set by `vite.config.ts`), the Whombat it talks
 * to (a managed box's `appliance.status` runtime version; a self-hosted server's `health.get` version), the Hermes Agent a
 * managed box runs (`ApplianceInfo.hermes`) and the contracts the app was built with (`VITE_WHOMBAT_CONTRACTS`). Settings → This Whombat's VERSION
 * and the account menu's line read it here, so both say the same.
 */
import { useQuery } from '@tanstack/react-query';
import { useHealth } from '@whombat/client/react';
import { sessionOps } from '@whombat/client/session';
import { useAppServices } from '../../app/providers';

export interface WhombatVersions {
  /** The web app's release version (“0.36.0”); “dev” for a build without one. */
  app: string;
  /** The build id (“0.36.0+1a2b3c4”) when it says more than the version; null otherwise. */
  build: string | null;
  /** The Whombat's (runtime or server) version, when it says it; null while unknown. */
  runtime: string | null;
  /** The contracts version the app was built with; null when the build didn't say. */
  contracts: string | null;
  /**
   * The Hermes Agent the assistant runs on (a managed box's `ApplianceInfo.hermes`, contracts 3.8; Whombat
   * hermes-updates.md HU-02): its version, null while no runner has said, undefined where there is no box to ask.
   */
  hermes?: string | null;
}

/** The app's own versions, read when asked (tests stub the env). */
export function appVersions(env: Partial<ImportMetaEnv> = import.meta.env): Omit<WhombatVersions, 'runtime'> {
  const build = env.VITE_WHOMBAT_BUILD?.trim() || null;
  const app = env.VITE_WHOMBAT_VERSION?.trim() || build?.split('+')[0] || 'dev';
  const contracts = env.VITE_WHOMBAT_CONTRACTS?.trim();
  return {
    app,
    build: build && build !== app ? build : null,
    contracts: contracts && contracts !== 'unknown' ? contracts : null,
  };
}

/** The account menu's line (SS-08): “Whombat 0.41.1 · app 0.36.0”, or “app 0.36.0” while the Whombat's is unknown. */
export function versionLine(v: Pick<WhombatVersions, 'app' | 'runtime'>): string {
  return v.runtime ? `Whombat ${v.runtime} · app ${v.app}` : `app ${v.app}`;
}

const FIVE_MINUTES = 5 * 60_000;

/** Every version this screen knows: the app's at once, the Whombat's once it answers. */
export function useWhombatVersions(): WhombatVersions {
  const { managed, session } = useAppServices();
  const appliance = useQuery({
    queryKey: ['whombat', 'version', 'appliance.status'],
    queryFn: () => sessionOps.applianceStatus(session),
    enabled: Boolean(managed),
    staleTime: FIVE_MINUTES,
    retry: false,
  });
  const health = useHealth(managed ? null : {}, { staleTime: FIVE_MINUTES, retry: false });
  const runtime = managed
    ? (appliance.data?.appliance.runtimeVersion ?? null)
    : (health.data?.version ?? null);
  // Shown once the box has answered: “Not known yet” is the box's word, not the wait for it.
  const hermes = managed && appliance.data ? (appliance.data.appliance.hermes?.version ?? null) : undefined;
  return { ...appVersions(), runtime, hermes };
}
