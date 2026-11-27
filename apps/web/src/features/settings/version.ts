/**
 * Which versions this is (docs/decisions/settings-simplify.md SS-06, SS-08): the web app's own (`VITE_WHOMBAT_VERSION`,
 * `apps/web/package.json`'s, and the build id `VITE_WHOMBAT_BUILD`, both set by `vite.config.ts`), the Whombat it talks
 * to (a managed box's `appliance.status` runtime version; a self-hosted server's `health.get` version), the Hermes Agent a
 * managed box runs (`ApplianceInfo.hermes`) and the contracts the app was built with (`VITE_WHOMBAT_CONTRACTS`). Settings → This Whombat's VERSION
 * and the account menu's line read it here, so both say the same.
 */
import { useQuery } from '@tanstack/react-query';
import { updateReady } from '@whombat/client/managed';
import { useHealth } from '@whombat/client/react';
import { type ApplianceStatus, sessionOps } from '@whombat/client/session';
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
  /**
   * Whether this Whombat is up to date or has an update waiting for the owner's yes; null where it can't be told (a
   * self-hosted server, no answer yet, an update on its way, failed or paused).
   */
  update?: UpdateState | null;
}

export type UpdateState = 'upToDate' | 'ready';

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

/** The whole line (SS-08): “Whombat 0.41.1 · app 0.36.0”, or “app 0.36.0” while the Whombat's is unknown. */
export function versionLine(v: Pick<WhombatVersions, 'app' | 'runtime'>): string {
  return v.runtime ? `Whombat ${v.runtime} · app ${v.app}` : `app ${v.app}`;
}

/**
 * A version without its build: “0.2.0” from “0.2.0-20261126200100.abcdef1” or “0.2.0+abcdef1”. The build is in the
 * tooltip; in a narrow menu it only cut the version off.
 */
export function shortVersion(version: string): string {
  return version.split(/[-+]/)[0] || version;
}

/** The account menu's footer: the short words it shows, and the whole line its tooltip says and a click copies. */
export function menuVersion(v: Pick<WhombatVersions, 'app' | 'runtime'>): { short: string; full: string } {
  return {
    short: v.runtime ? `Whombat ${shortVersion(v.runtime)}` : `app ${v.app}`,
    full: versionLine(v),
  };
}

/**
 * Up to date or an update ready, from a box's `appliance.status`: ready while a release waits for the owner's yes;
 * up to date only while it runs its release with nothing waiting. Anything in between says nothing rather than
 * something untrue.
 */
export function updateState(status: Pick<ApplianceStatus, 'update'> | null | undefined): UpdateState | null {
  if (updateReady(status)) return 'ready';
  const u = status?.update;
  return u && u.state === 'Healthy' && !u.waiting && !u.paused ? 'upToDate' : null;
}

const FIVE_MINUTES = 5 * 60_000;

/**
 * Every version this screen knows: the app's at once, the Whombat's once it answers. `read` false asks the Whombat
 * nothing yet (the account menu reads it once the pointer comes near, not while a Whombat opens).
 */
export function useWhombatVersions(read = true): WhombatVersions {
  const { managed, session } = useAppServices();
  const appliance = useQuery({
    queryKey: ['whombat', 'version', 'appliance.status'],
    queryFn: () => sessionOps.applianceStatus(session),
    enabled: read && Boolean(managed),
    staleTime: FIVE_MINUTES,
    retry: false,
  });
  const health = useHealth(read && !managed ? {} : null, { staleTime: FIVE_MINUTES, retry: false });
  const runtime = managed
    ? (appliance.data?.appliance.runtimeVersion ?? null)
    : (health.data?.version ?? null);
  // Shown once the box has answered: “Not known yet” is the box's word, not the wait for it.
  const hermes = managed && appliance.data ? (appliance.data.appliance.hermes?.version ?? null) : undefined;
  const update = managed ? updateState(appliance.data) : null;
  return { ...appVersions(), runtime, hermes, update };
}
