/**
 * An Unraid server's parts on the phone (Whombat incus-unraid.md IU-05, IU-08, IU-09; incus-unraid-mobile.md
 * AP-1634…AP-1638, dashboards-mobile.md AP-2130): the array card (state, use, what is wrong, the parity line with its
 * progress, Start or Stop, Check parity, Pause, Resume and Cancel), the unread notifications with Archive; the Array
 * segment (the actions, the notifications, every disk as Unraid's Main page groups them, the parity history and
 * schedule) and the Plugins segment (the Unraid version, Check for updates, Update all, each plugin's Update). The
 * pools are on the Summary (`serverDashboard`), the containers' updates on Guests. Unraid's own settings, shares and
 * OS updates stay in Unraid's page, and the screens say so.
 */

import {
  parityView,
  unraidAbilities,
  unraidArrayView,
  unraidChangeWords,
  unraidPageUrl,
  unraidVersionView,
} from '@whombat/client/hosts';
import {
  type DiskRowView,
  diskSections,
  type NotificationRow,
  notificationRows,
  type PluginRow,
  parityHistoryRows,
  pluginPhoneRows,
  spinnable,
} from '@whombat/client/hosts/mobile';
import type { HostGuest, HostServerDetail, HostUnraidDetail } from '@whombat/core';
import { useState } from 'react';
import { Linking, View } from 'react-native';
import { useI18n, useMobileT } from '../../i18n';
import { Meter } from '../../managed/HostCharts';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Dot, OneCard, OneRow, ToneBadge } from '../../ui/assistant';
import { Button } from '../../ui/primitives';
import { WebLine } from '../guest/IncusSettings';
import { CardQuiet, RowAction, SettingLine } from '../guest/parts';
import {
  CancelParitySheet,
  CheckParitySheet,
  DiskSheet,
  NotificationSheet,
  PluginUpdateSheet,
  StopArraySheet,
  useUnraidOp,
} from './UnraidSheets';

type Tone = 'ok' | 'warn' | 'bad' | 'mut';
const dotTone = (t: Tone | null | undefined) => (t === 'mut' || !t ? null : t);

export interface UnraidBase {
  serverId: string;
  serverName: string;
  /** The server's page (its address for Unraid's own page). */
  detail: Pick<HostServerDetail, 'server'>;
  unraid: HostUnraidDetail;
  now: number;
  timeZone: string;
  /** Manage on and this Whombat's runtime can (`hosts.unraid`). */
  canChange: boolean;
}

type Ask = 'stop' | 'parity' | 'cancel' | null;

/** The array: state and use, what is wrong, parity, and its actions (`full`: the Array segment's spin and mover too). */
export function ArrayCard({
  serverId,
  serverName,
  unraid: u,
  now,
  canChange,
  guests = [],
  full = false,
}: UnraidBase & { guests?: readonly HostGuest[]; full?: boolean }) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  // The web's words and rules (`unraid.ts`): the state, the parity line, what may be done now.
  const a = unraidArrayView(u.array);
  const p = parityView(u.array, now);
  const can = unraidAbilities(u);
  const spin = spinnable(u);
  const { run, busy } = useUnraidOp(serverId, serverName);
  const [ask, setAsk] = useState<Ask>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const go = (id: string, op: Parameters<typeof run>[0], extra: Parameters<typeof run>[1] = {}) => {
    setBusyId(id);
    void run(op, extra).then((o) => {
      setBusyId(null);
      setError(o.ok || o.waiting ? null : o.message);
    });
  };
  const buttons: { id: string; label: string; primary?: boolean; onPress: () => void }[] = [];
  if (canChange) {
    if (can.start)
      buttons.push({
        id: 'start',
        label: 'Start the array',
        primary: true,
        onPress: () => go('start', 'array.start'),
      });
    if (can.pause) buttons.push({ id: 'pause', label: 'Pause', onPress: () => go('pause', 'parity.pause') });
    if (can.resume)
      buttons.push({
        id: 'resume',
        label: 'Resume',
        primary: true,
        onPress: () => go('resume', 'parity.resume'),
      });
    if (can.cancel)
      buttons.push({ id: 'cancel', label: 'Cancel the check', onPress: () => setAsk('cancel') });
    if (can.checkParity)
      buttons.push({ id: 'parity', label: 'Check parity', onPress: () => setAsk('parity') });
    if (full && can.spin && spin.up)
      buttons.push({
        id: 'up',
        label: 'Spin up all',
        onPress: () => go('up', 'disk.spin_up', { params: { disk: 'all' } }),
      });
    if (full && can.spin && spin.down)
      buttons.push({
        id: 'down',
        label: 'Spin down all',
        onPress: () => go('down', 'disk.spin_down', { params: { disk: 'all' } }),
      });
    if (full && can.mover)
      buttons.push({ id: 'mover', label: 'Run the mover', onPress: () => go('mover', 'mover.start') });
    if (can.stop) buttons.push({ id: 'stop', label: 'Stop the array', onPress: () => setAsk('stop') });
  }
  const why = full && canChange ? [can.checkReason, can.moverReason].filter(Boolean).join(' ') : '';
  return (
    <OneCard
      label={tMobile('screens.array')}
      right={<ToneBadge text={a.stateText} tone={a.tone === 'mut' ? 'mut' : a.tone} />}
    >
      <View
        accessible
        accessibilityLabel={[`Array ${a.stateText}`, a.trouble, a.useText].filter(Boolean).join(', ')}
        style={{ paddingHorizontal: 14, paddingBottom: 12, gap: 4 }}
      >
        {a.trouble ? (
          <Text size={14.5} weight={600} color={theme.colors.bad}>
            {a.trouble}
          </Text>
        ) : null}
        {a.usedPct != null ? <Meter pct={a.usedPct} /> : null}
        <Text size={13} color={theme.colors.mut}>
          {a.useText}
        </Text>
      </View>
      <View
        accessible
        accessibilityLabel={`${p.title}. ${p.detail}`}
        style={{
          paddingHorizontal: 14,
          paddingVertical: 11,
          gap: 4,
          borderTopWidth: 1,
          borderTopColor: theme.colors.line,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Dot tone={dotTone(p.tone)} />
          <Text size={15} weight={600} style={{ flex: 1 }}>
            {p.title}
          </Text>
        </View>
        <Text size={13} lh={1.4} color={p.tone === 'bad' ? theme.colors.bad : theme.colors.mut}>
          {p.detail}
        </Text>
        {p.pct != null ? <Meter pct={p.pct} /> : null}
        {u.array.moverRunning ? (
          <Text size={13} color={theme.colors.mut}>
            {tMobile('screens.the-mover-is-running')}
          </Text>
        ) : null}
      </View>
      {buttons.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 14, paddingTop: 4 }}>
          {buttons.map((b) => (
            <Button
              key={b.id}
              label={b.label}
              variant={b.primary ? 'primary' : 'secondary'}
              busy={busy && busyId === b.id}
              disabled={busy}
              onPress={b.onPress}
              style={{ flexGrow: 1, flexBasis: '45%' }}
            />
          ))}
        </View>
      ) : null}
      {why ? (
        <Text
          size={13}
          lh={1.4}
          color={theme.colors.mut}
          style={{ paddingHorizontal: 14, paddingBottom: 12 }}
        >
          {why}
        </Text>
      ) : null}
      {error ? (
        <Text size={13} color={theme.colors.bad} style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
          {error}
        </Text>
      ) : null}
      {ask === 'stop' ? (
        <StopArraySheet
          serverId={serverId}
          serverName={serverName}
          unraid={u}
          guests={guests}
          onClose={() => setAsk(null)}
        />
      ) : null}
      {ask === 'parity' ? (
        <CheckParitySheet serverId={serverId} serverName={serverName} onClose={() => setAsk(null)} />
      ) : null}
      {ask === 'cancel' ? (
        <CancelParitySheet serverId={serverId} serverName={serverName} onClose={() => setAsk(null)} />
      ) : null}
    </OneCard>
  );
}

/** unRAID's unread notifications: each opens its text with Archive; Archive all. */
export function NotificationsCard({ serverId, serverName, unraid: u, now, timeZone, canChange }: UnraidBase) {
  const { tClient } = useI18n();
  const { t: tMobile } = useMobileT();
  const rows = notificationRows(u, now, timeZone);
  const { run, busy } = useUnraidOp(serverId, serverName);
  const [open, setOpen] = useState<NotificationRow | null>(null);
  if (!rows.length) return null;
  return (
    <OneCard
      label={tClient('settings.you.notifications')}
      right={
        canChange && rows.length > 1 ? (
          <RowAction
            label={busy ? tMobile('screens.archiving') : tMobile('screens.archive-all')}
            spoken="Archive all notifications"
            onPress={() =>
              void run('notification.archive', {
                done: unraidChangeWords('notification.archive', serverName).finished,
              })
            }
          />
        ) : null
      }
    >
      {rows.map((r) => (
        <OneRow
          key={r.id}
          leading={<Dot tone={r.tone} />}
          title={r.title}
          line={r.line}
          meta={r.meta}
          chevron
          label={r.label}
          hint={canChange ? tMobile('screens.read-it-or-archive-it') : tMobile('screens.reads-it-whole')}
          onPress={() => setOpen(r)}
        />
      ))}
      {open ? (
        <NotificationSheet
          serverId={serverId}
          serverName={serverName}
          row={open}
          canChange={canChange}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </OneCard>
  );
}

/**
 * The Array segment: the card with every action, Unraid's unread notifications (Archive; the Summary only counts them,
 * dashboards-mobile.md AP-2130), the disks by group, the parity history and schedule.
 */
export function UnraidArray(props: UnraidBase & { guests: readonly HostGuest[]; manageOff: string | null }) {
  const { tClient } = useI18n();
  const { t: tMobile } = useMobileT();
  const { serverId, serverName, detail, unraid: u, now, timeZone, canChange, manageOff } = props;
  const theme = useTheme();
  const [disk, setDisk] = useState<DiskRowView | null>(null);
  const history = parityHistoryRows(u.array.parity.history, now, timeZone);
  return (
    <>
      {manageOff ? (
        <Text size={14} lh={1.45} color={theme.colors.mut}>
          {manageOff}
        </Text>
      ) : null}
      <ArrayCard {...props} full />
      <NotificationsCard {...props} />
      {diskSections(u).map((s) => (
        <OneCard
          key={s.id}
          label={s.title}
          right={
            s.sub ? (
              <Text size={12} mono color={theme.colors.mut}>
                {s.sub}
              </Text>
            ) : undefined
          }
        >
          {s.rows.map((r, i) => (
            <OneRow
              key={r.name}
              first={i === 0}
              leading={<Dot tone={dotTone(r.status.tone)} />}
              title={r.title}
              line={r.line}
              meta={r.meta || null}
              trailing={
                <Text size={12} weight={500} mono color={theme.colors.mut}>
                  {r.tempText}
                </Text>
              }
              chevron
              label={r.label}
              hint={
                canChange && r.canSpin
                  ? tMobile('screens.its-details-spin-it-up-or-down')
                  : tMobile('screens.its-details')
              }
              onPress={() => setDisk(r)}
            />
          ))}
        </OneCard>
      ))}
      <OneCard label={tMobile('screens.parity-checks')}>
        <SettingLine
          first
          label={tClient('automations.source.schedule')}
          value={u.array.parity.schedule?.trim() || 'No schedule'}
        />
        {history.length ? (
          history.map((h) => (
            <OneRow
              key={h.title}
              leading={<Dot tone={dotTone(h.tone)} />}
              title={h.title}
              line={h.line}
              label={h.label}
            />
          ))
        ) : (
          <CardQuiet>{tMobile('screens.no-checks-yet')}</CardQuiet>
        )}
      </OneCard>
      <WebLine
        text={tMobile('screens.shares-the-arrays-and-the-disks-settings-and')}
        url={unraidPageUrl(detail, 'Main')}
      />
      {disk ? (
        <DiskSheet
          serverId={serverId}
          serverName={serverName}
          row={disk}
          canChange={canChange && u.array.state === 'started'}
          onClose={() => setDisk(null)}
        />
      ) : null}
    </>
  );
}

/** The Plugins segment: the Unraid version, Check for updates, Update all, each plugin. */
export function UnraidPlugins({ serverId, serverName, detail, unraid: u, canChange }: UnraidBase) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const rows = pluginPhoneRows(u);
  const updates = rows.filter((r) => r.update).length;
  const { run, busy } = useUnraidOp(serverId, serverName);
  const [open, setOpen] = useState<PluginRow | 'all' | null>(null);
  const page = unraidPageUrl(detail, 'Tools/Update');
  const version = unraidVersionView(u);
  const os = version.update;
  return (
    <>
      <OneCard label="Unraid">
        <SettingLine
          first
          label={tMobile('screens.version')}
          value={version.text}
          sub={os}
          action={
            os && page ? (
              <RowAction
                label={tMobile('screens.update-in-unraid')}
                spoken="Update in Unraid"
                onPress={() => void Linking.openURL(page)}
              />
            ) : null
          }
        />
      </OneCard>
      {canChange ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Button
            label={tMobile('screens.check-for-updates')}
            variant="secondary"
            busy={busy}
            onPress={() => void run('plugin.check')}
            style={{ flexGrow: 1, flexBasis: '45%' }}
          />
          {updates ? (
            <Button
              label={`Update all (${updates})`}
              variant="primary"
              disabled={busy}
              onPress={() => setOpen('all')}
              style={{ flexGrow: 1, flexBasis: '45%' }}
            />
          ) : null}
        </View>
      ) : null}
      <OneCard label={tMobile('screens.plugins')}>
        {rows.length ? (
          rows.map((r) => (
            <OneRow
              key={r.file}
              leading={<Dot tone={r.update ? 'warn' : null} />}
              title={r.name}
              line={r.line}
              meta={r.author}
              trailing={
                r.update ? (
                  <Text size={12} weight={500} mono color={theme.colors.warn}>
                    {tMobile('screens.update-2')}
                  </Text>
                ) : undefined
              }
              {...(canChange && r.update
                ? { chevron: true, hint: `Updates ${r.name}`, onPress: () => setOpen(r) }
                : {})}
              label={r.label}
            />
          ))
        ) : (
          <CardQuiet>{tMobile('screens.no-plugins-installed')}</CardQuiet>
        )}
      </OneCard>
      <Text size={13} lh={1.45} color={theme.colors.mut}>
        {tMobile('screens.installing-plugins-and-apps-in-unraids-own-page')}
      </Text>
      {open ? (
        <PluginUpdateSheet
          serverId={serverId}
          serverName={serverName}
          plugin={open === 'all' ? null : open}
          count={updates}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </>
  );
}
