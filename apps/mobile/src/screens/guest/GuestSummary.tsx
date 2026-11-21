/**
 * A guest's Summary on the phone (proxmox-mobile.md AP-1492): why it can't be changed here when Manage is off, its
 * four figures, CPU and memory over the last 24 hours (a finger on a chart reads a moment), its backups (the last
 * one and whether a job covers it), what waits for a restart with Restart to apply, its notes, the Proxmox hints of
 * this guest each with its way out (PX-07), and its facts.
 */
import { formatPct, formatPct1, formatTooltipTime, timeTicks } from '@whombat/client/hosts';
import {
  type GuestHintRow,
  type GuestWayOut,
  guestBackupLine,
  guestCharts,
  guestHints,
  guestSummaryFacts,
  guestTiles,
  pendingLines,
} from '@whombat/client/hosts/mobile';
import { useHostGuestMetrics } from '@whombat/client/hosts/react';
import type { HostGuestConfig, HostGuestDetail } from '@whombat/core';
import { type ReactNode, useState } from 'react';
import { View } from 'react-native';
import type { HostReadout } from '../../data/hostStatus';
import { LineChart, Readout } from '../../managed/HostCharts';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { BigButton, Dot, OneCard } from '../../ui/assistant';
import { Facts } from '../../ui/facts';
import { RowAction, SettingLine, Tile } from './parts';

export function GuestSummary({
  slug,
  serverId,
  serverName,
  guest: g,
  config,
  now,
  timeZone,
  canChange,
  jobs,
  manageOff,
  onWayOut,
  lead,
  extra,
}: {
  slug: string;
  serverId: string;
  serverName: string;
  guest: HostGuestDetail;
  config: HostGuestConfig | undefined;
  now: number;
  timeZone: string;
  /** The viewer may change it and Manage is on. */
  canChange: boolean;
  /** This Whombat has backup jobs (`hosts.backup_jobs`). */
  jobs: boolean;
  /** Why it can't be changed from here, or null. */
  manageOff: string | null;
  onWayOut: (to: GuestWayOut) => void;
  /** After the figures: a container's or VM's card (incus-unraid-mobile.md AP-1630). */
  lead?: ReactNode;
  /** After what waits for a restart: an Incus instance's hints, snapshots and backups (AP-1620). */
  extra?: ReactNode;
}) {
  const theme = useTheme();
  const on = g.state === 'running' || g.state === 'unhealthy';
  const m = useHostGuestMetrics(
    on
      ? {
          params: { burrow: slug, serverId, guestId: g.id },
          query: { range: '24h', series: 'cpu_pct,mem_mb' },
        }
      : null,
    { retry: false },
  );
  const charts = guestCharts(m.data, g.memoryLimitMb);
  const backup = guestBackupLine(g, now, timeZone);
  const pending = pendingLines(config);
  // What waits for a restart has its own card with Restart to apply; the hint would say it twice.
  const hints = guestHints(g, now, { jobs, pending: config ? pending.length : undefined }).filter(
    (h) => h.id !== 'pending_changes' || !pending.length,
  );
  const notes = config?.values.description?.trim();
  const pve = g.platform === 'pve';
  return (
    <>
      {manageOff ? (
        <Text size={14} lh={1.45} color={theme.colors.mut}>
          {manageOff}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        {guestTiles(g).map((t) => (
          <Tile key={t.key} label={t.label} value={t.value} note={t.note} />
        ))}
      </View>
      {lead}
      {charts ? (
        <>
          <ChartCard
            title="CPU"
            values={charts.cpu}
            max={charts.cpuMax}
            ticks={charts.cpuTicks}
            tickLabel={(v) => String(Math.round(v))}
            format={formatPct1}
            word="busy"
            timestamps={charts.timestamps}
            timeZone={timeZone}
            name={g.name}
          />
          {g.memoryLimitMb ? (
            <ChartCard
              title="Memory"
              values={charts.memPct}
              max={100}
              ticks={[0, 50, 100]}
              tickLabel={(v) => String(Math.round(v))}
              format={formatPct}
              word="used"
              timestamps={charts.timestamps}
              timeZone={timeZone}
              name={g.name}
            />
          ) : null}
        </>
      ) : null}
      {hints.length ? (
        <OneCard label="Needs a look">
          {hints.map((h, i) => (
            <HintLine key={h.id} hint={h} first={i === 0} canChange={canChange} onWayOut={onWayOut} />
          ))}
        </OneCard>
      ) : null}
      {pending.length ? (
        <OneCard label="Waiting for a restart">
          {pending.map((p, i) => (
            <SettingLine key={p.key} first={i === 0} label={p.label} value={`${p.now} → ${p.after}`} />
          ))}
          {canChange ? (
            <View style={{ padding: 14, paddingTop: 4 }}>
              <BigButton label="Restart to apply" variant="secondary" onPress={() => onWayOut('restart')} />
            </View>
          ) : null}
        </OneCard>
      ) : null}
      {extra}
      {pve ? (
        <OneCard label="Backups">
          <View
            accessible
            accessibilityLabel={`Last backup: ${backup.last}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingHorizontal: 14,
              paddingVertical: 10,
            }}
          >
            <Dot tone={backup.lastTone === 'mut' ? null : backup.lastTone === 'ok' ? 'ok' : 'bad'} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text size={12.5} color={theme.colors.mut}>
                Last backup
              </Text>
              <Text size={15} weight={500}>
                {backup.last}
              </Text>
            </View>
          </View>
          {backup.job ? <SettingLine label="Backup job" value={backup.job} /> : null}
          {canChange ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, padding: 14, paddingTop: 4 }}>
              <View style={{ flexGrow: 1, flexBasis: '45%' }}>
                <BigButton label="Back up now" variant="secondary" onPress={() => onWayOut('back_up')} />
              </View>
              {jobs && backup.inJob === false ? (
                <View style={{ flexGrow: 1, flexBasis: '45%' }}>
                  <BigButton
                    label="Add to a backup plan"
                    variant="secondary"
                    onPress={() => onWayOut('add_to_job')}
                  />
                </View>
              ) : null}
            </View>
          ) : null}
        </OneCard>
      ) : null}
      {notes ? (
        <OneCard label="Notes">
          <Text
            size={14.5}
            lh={1.5}
            color={theme.colors.ink2}
            style={{ paddingHorizontal: 14, paddingBottom: 14 }}
          >
            {notes}
          </Text>
        </OneCard>
      ) : null}
      <OneCard label="About it">
        <View style={{ paddingHorizontal: 14, paddingBottom: 14, paddingTop: 2 }}>
          <Facts facts={guestSummaryFacts(g, serverName)} />
        </View>
      </OneCard>
    </>
  );
}

function HintLine({
  hint,
  first,
  canChange,
  onWayOut,
}: {
  hint: GuestHintRow;
  first: boolean;
  canChange: boolean;
  onWayOut: (to: GuestWayOut) => void;
}) {
  const theme = useTheme();
  // Snapshots only opens a tab: anyone may look; the rest change the guest.
  const action = hint.action && (canChange || hint.action.to === 'snapshots') ? hint.action : null;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 11,
        paddingHorizontal: 14,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View
        accessible
        accessibilityLabel={`${hint.title}. ${hint.detail}`}
        style={{ flex: 1, flexDirection: 'row', gap: 12 }}
      >
        <View style={{ paddingTop: 6 }}>
          <Dot tone={hint.tone === 'warn' ? 'warn' : null} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text size={15} weight={600}>
            {hint.title}
          </Text>
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {hint.detail}
          </Text>
        </View>
      </View>
      {action ? (
        <RowAction label={action.label} spoken={action.label} onPress={() => onWayOut(action.to)} />
      ) : null}
    </View>
  );
}

/** CPU or memory over 24 hours; a finger (or TalkBack's swipe) reads a moment in the row above. */
function ChartCard({
  title,
  values,
  max,
  ticks,
  tickLabel,
  format,
  word,
  timestamps,
  timeZone,
  name,
}: {
  title: string;
  values: readonly (number | null)[];
  max: number;
  ticks: number[];
  tickLabel: (v: number) => string;
  format: (v: number | null) => string;
  word: string;
  timestamps: readonly string[];
  timeZone: string;
  name: string;
}) {
  const theme = useTheme();
  const [picked, setPicked] = useState<number | null>(null);
  const lastMeasured = (() => {
    for (let i = values.length - 1; i >= 0; i--) if (values[i] != null) return i;
    return null;
  })();
  const shown = picked ?? lastMeasured;
  const readout: HostReadout | null =
    shown == null
      ? null
      : {
          title: formatTooltipTime('24h', Date.parse(timestamps[shown] ?? ''), timeZone),
          lines: [{ swatch: 'chart1', value: format(values[shown] ?? null), rest: word }],
        };
  const step = Math.max(1, Math.round(values.length / 24));
  return (
    <OneCard
      label={title}
      right={
        <Text size={12} color={theme.colors.mut}>
          last 24 h
        </Text>
      }
    >
      <View style={{ paddingHorizontal: 14, paddingBottom: 12 }}>
        <Readout readout={readout} />
        <LineChart
          series={[{ key: title, values, swatch: 'chart1', area: true }]}
          max={max}
          ticks={ticks}
          tickLabel={tickLabel}
          // Times only (“14:35”): a weekday on every tick doesn't fit a phone's width.
          timeTicks={timeTicks(timestamps, '6h', timeZone)}
          height={130}
          label={`${name} ${title}, last 24 hours`}
          readout={readout}
          selected={picked}
          onPick={(i) => setPicked(Math.max(0, Math.min(values.length - 1, i)))}
          onStep={(d) =>
            setPicked(Math.max(0, Math.min(values.length - 1, (shown ?? values.length - 1) + d * step)))
          }
        />
      </View>
    </OneCard>
  );
}
