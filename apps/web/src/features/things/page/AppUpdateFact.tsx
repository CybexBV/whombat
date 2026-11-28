/**
 * A service's page, when it runs in a Docker Compose app on a server Whombat watches (Whombat app-updates.md): the
 * head's fact line says an update waits (“Update available: 2.4”) with Update, which asks through the approval card
 * as the server's apps list does, or how its last update went. Nothing when the app has nothing to say.
 */
import { appUpdateRow, appUpdateWords } from '@whombat/client/hosts';
import { useHostGuests, useHostsFleet } from '@whombat/client/hosts/react';
import { agentReportsApps, type ThingRunsOn } from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { useWebI18n } from '../../../i18n/provider';
import { useAppUpdate, useAppUpdatesOn } from '../manage/useAppUpdate';
import styles from './ThingPage.module.css';

/** Whether a page runs in a Docker container, so the fact can be asked for. */
export function runsInContainer(runsOn: ThingRunsOn | null | undefined): runsOn is ThingRunsOn {
  return !!runsOn?.guestId?.startsWith('docker:');
}

export function AppUpdateFact({ burrow, runsOn }: { burrow: string; runsOn: ThingRunsOn }) {
  return useAppUpdatesOn() ? <Fact burrow={burrow} runsOn={runsOn} /> : null;
}

function Fact({ burrow, runsOn }: { burrow: string; runsOn: ThingRunsOn }) {
  const { tag: locale } = useWebI18n();
  const guests = useHostGuests({
    params: { burrow },
    query: { server: runsOn.serverId, platform: 'docker', limit: 500 },
  });
  const fleet = useHostsFleet({ params: { burrow }, query: {} });
  const { ask, busy } = useAppUpdate(burrow, runsOn.serverId);
  const list = guests.data?.guests ?? [];
  const g = list.find((x) => x.id === runsOn.guestId);
  if (!g) return null;
  const manage = fleet.data?.servers.find((s) => s.id === runsOn.serverId)?.remoteControl.manage === true;
  const row = appUpdateRow(g, { agentHasApps: agentReportsApps(list), manage, now: Date.now(), locale });
  if (!row.line) return null;
  const w = appUpdateWords(locale);
  return (
    <span className={row.tone === 'bad' ? styles.appBad : row.tone === 'note' ? styles.appNote : undefined}>
      {row.line}
      {row.update ? (
        <>
          {' · '}
          <button
            type="button"
            className={styles.appUpdate}
            disabled={busy}
            title={row.asks ?? undefined}
            aria-label={interpolate(w.updateName, { name: g.name })}
            onClick={() => void ask([g.id])}
          >
            {w.update}
          </button>
        </>
      ) : null}
    </span>
  );
}
