/**
 * A server's operating-system updates on the phone (Whombat server-updates.md SWU-07, SWU-12, SWU-14;
 * server-updates-app.md AP-2880…AP-2886): the Summary's Updates card — the Updates line with when the list was read,
 * and the restart it needs — which opens the Updates screen (`ServerUpdatesScreen`). What shows for whom is the web's
 * `serverUpdatesView` (`@whombat/client/hosts`): Full control, the runtime's `hosts.package_updates`, not on
 * Unraid (its Plugins have their own).
 */
import {
  isUnraidServer,
  type ServerUpdatesView,
  serverUpdatesView,
  UPDATES_WORDS,
} from '@whombat/client/hosts';
import type { HostServerDetail } from '@whombat/core';
import { Dot, OneCard, OneRow } from '../../ui/assistant';

/** The view of a server's updates (null until its page is read). */
export function useServerUpdatesView(
  d: HostServerDetail | null | undefined,
  name: string,
): ServerUpdatesView | null {
  if (!d) return null;
  return serverUpdatesView({
    server: name,
    system: d.health?.system ?? null,
    remoteControl: d.server.remoteControl,
    unraid: isUnraidServer(d),
    connected: d.server.agent.connected !== false && d.server.status !== 'offline',
    now: Date.parse(d.asOf),
  });
}

/** The Summary's card: the Updates line, when it was read, the restart it needs; it opens the Updates screen. */
export function UpdatesCard({ view, onOpen }: { view: ServerUpdatesView; onOpen: () => void }) {
  const restart = view.restart.tone === 'warn';
  return (
    <OneCard label={UPDATES_WORDS.title}>
      <OneRow
        leading={<Dot tone={view.line.tone === 'mut' ? null : view.line.tone} />}
        title={view.line.text}
        meta={view.line.checked}
        chevron
        label={`${UPDATES_WORDS.title}: ${view.line.text}${view.line.checked ? `, ${view.line.checked}` : ''}`}
        hint="Opens the updates"
        onPress={onOpen}
      />
      {restart ? (
        <OneRow
          leading={<Dot tone="warn" />}
          // The web's Restart line: “Restart” over “Needed: a new kernel”.
          title={UPDATES_WORDS.restartTitle}
          line={view.restart.text}
          chevron
          label={`${UPDATES_WORDS.restartTitle}: ${view.restart.text}`}
          hint="Opens the updates"
          onPress={onOpen}
        />
      ) : null}
    </OneCard>
  );
}
