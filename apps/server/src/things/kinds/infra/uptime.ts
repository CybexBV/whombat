import { UPTIME_HUB_NAME, UPTIME_HUB_RUNNER, UPTIME_KINDS, type UptimeHubCheck } from '@whombat/core';
import {
  checkInCommand,
  readUptimeCheck,
  uptimeHttpError,
  uptimeState,
  uptimeUnseen,
} from '../../../connections/uptime';
import { serverLabel } from '../../../hosts/self';
import { hostsFor } from '../../../hosts/service';
import { POINTS_KEEP_MS, RTT_KEY, readPoints } from '../../points';
import type { KindCheck, KindNotice } from '../../quiet/types';
import { clip, clock, dayMonth, figure, plural, when } from '../../words';
import type { KindModule, KindSeen } from '../registry';
import { daysWith, lastDays, liveList, pointsByDay, slotPanels, trend } from '../slots';
import type { KindCtx } from '../types';

const DAY_MS = 86_400_000;

export const UPTIME_CHECKS: readonly KindCheck[] = [
  { check: 'uptime.down', name: 'Whether it answers', nature: 'problem', perItem: false, startsOn: true },
  { check: 'uptime.checkin_late', name: 'A late check-in', nature: 'you', perItem: false, startsOn: true },
  {
    check: 'uptime.cert_expiring',
    name: 'A certificate ending soon',
    nature: 'problem',
    perItem: false,
    startsOn: true,
  },
  {
    check: 'uptime.unseen',
    name: 'When it can’t be checked',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
];

function certificateOf(check: UptimeHubCheck | null): Date | null {
  if (check?.kind !== 'http' || !/^https:\/\//i.test(check.target)) return null;
  const at = Date.parse(check.last?.certNotAfter ?? '');
  return Number.isFinite(at) ? new Date(at) : null;
}

export function uptimeNotices(
  check: UptimeHubCheck | null,
  heartbeat: boolean,
  label: string,
  now: Date,
  timeZone: string,
): KindNotice[] {
  if (!check || check.stale)
    return [
      {
        id: 'unseen',
        tone: 'info',
        icon: 'info',
        title: check?.last
          ? `Not checked since ${clock(new Date(check.last.at), timeZone)}`
          : 'Whombat can’t check it now',
        check: 'uptime.unseen',
        nature: 'fyi',
        ignore: { lifts: 'fixed', words: 'Until Whombat can check it again.' },
      },
    ];

  const out: KindNotice[] = [];
  const answered = uptimeHttpError(check);
  if (check.status === 'down')
    out.push(
      heartbeat
        ? {
            id: 'late',
            tone: 'bad',
            icon: 'clock',
            title: 'Check-in is late',
            check: 'uptime.checkin_late',
            nature: 'you',
            badge: 'Check-in is late',
            detail: check.lastPing
              ? `Last checked in ${when(new Date(check.lastPing), now, timeZone).toLowerCase()}.`
              : 'It hasn’t checked in yet.',
            ignore: { lifts: 'fixed', words: 'Until it checks in again.' },
          }
        : {
            id: 'down',
            tone: 'bad',
            icon: 'network',
            title: answered ? 'It answered with an error' : 'It isn’t answering',
            check: 'uptime.down',
            nature: 'problem',
            ...(!answered ? { offline: true } : {}),
            badge: answered ? 'Check failed' : 'Not answering',
            link: {
              kind: 'ask',
              label: 'Look into it',
              question: clip(`Why isn’t ${label} passing its check?`, 300),
            },
            ignore: {
              lifts: 'fixed',
              words: answered ? 'Until it passes its check.' : 'Until it answers again.',
            },
          },
    );

  const certificate = certificateOf(check);
  if (certificate && check.status !== 'disabled') {
    const left = (certificate.getTime() - now.getTime()) / DAY_MS;
    if (left <= 14) {
      out.push({
        id: 'cert-expiring',
        tone: left <= 3 ? 'bad' : 'warn',
        icon: 'certificate',
        title: left <= 0 ? 'Certificate expired' : `Certificate ends in ${plural(Math.ceil(left), 'day')}`,
        detail: `Ends ${dayMonth(certificate, timeZone)}.`,
        check: 'uptime.cert_expiring',
        nature: 'problem',
        link: {
          kind: 'ask',
          label: 'Look into it',
          question: clip(`How can I renew the certificate for ${label}?`, 300),
        },
        ignore: { lifts: 'fixed', words: 'Until the certificate is renewed.' },
      });
    }
  }
  return out;
}

export function uptimeSeen(
  check: UptimeHubCheck | null,
  row: Pick<KindCtx['row'], 'label' | 'fields'>,
  now: Date,
  timeZone: string,
): KindSeen {
  const heartbeat = row.fields.kind === 'heartbeat';
  const latency = check?.status === 'up' && !check.stale ? check.last?.latencyMs : null;
  const unseen = uptimeUnseen(check);
  return {
    glance: {
      line: uptimeState(check, heartbeat),
      facts: latency != null ? [{ label: 'Answer time', value: `${figure(latency)} ms` }] : [],
    },
    points: { [RTT_KEY]: latency ?? null },
    notices: uptimeNotices(check, heartbeat, row.label, now, timeZone),
    skipped: [
      ...(unseen ? ['uptime.down', 'uptime.checkin_late'] : []),
      ...(unseen || (check?.status === 'down' && !certificateOf(check)) ? ['uptime.cert_expiring'] : []),
    ],
  };
}

const timeSince = (at: string, now: Date, timeZone: string) => {
  const date = new Date(at);
  const displayed = when(date, now, timeZone);
  return displayed.startsWith('Today ') ? clock(date, timeZone) : displayed;
};

async function page(ctx: KindCtx) {
  const { services, row, now, timeZone } = ctx;
  const heartbeat = row.fields.kind === 'heartbeat';
  const canSeeCommand = heartbeat && ctx.viewer?.principal.kind === 'person';
  const [check, points, hub] = await Promise.all([
    readUptimeCheck(services, row, canSeeCommand),
    readPoints(services.db, row.id, [RTT_KEY], now, POINTS_KEEP_MS),
    canSeeCommand
      ? hostsFor(services)
          .hubInfo()
          .catch(() => null)
      : null,
  ]);
  const seen = uptimeSeen(check, row, now, timeZone);
  const latency = seen.points[RTT_KEY];
  const days = lastDays(now, timeZone);
  const values = pointsByDay(points.get(RTT_KEY) ?? [], days.keys, timeZone, 'mean');
  const measured = values.filter((v): v is number => v !== null);
  const certificate = certificateOf(check);
  const runner = row.fields.runner;
  const from = !runner || runner === UPTIME_HUB_RUNNER ? UPTIME_HUB_NAME : serverLabel(runner);
  const type = UPTIME_KINDS.find((kind) => kind.value === row.fields.kind)?.label ?? 'Address';
  const since = check?.stale ? check.last?.at : check?.since;
  const words = uptimeState(check, heartbeat);
  const command = canSeeCommand ? checkInCommand(check?.pingUrl, hub?.tls_pin) : null;
  const every = Number(row.fields.every) || 5;
  const publicUrl = row.fields.kind === 'http' ? row.fields.address : undefined;
  return {
    ...slotPanels({
      live: liveList({
        id: 'check',
        title: clip(words, 60),
        ...(since ? { meta: `Since ${timeSince(since, now, timeZone)}` } : {}),
        items: [
          {
            id: 'target',
            title: type,
            detail: clip(row.fields.address ?? 'A script or job reports when it runs.', 300),
          },
          { id: 'runner', title: `From ${from}`, detail: `Every ${plural(every, 'minute')}` },
          ...(latency != null
            ? [
                {
                  id: 'latency',
                  title: heartbeat ? 'Run time' : 'Answer time',
                  detail: `${figure(latency)} ms`,
                },
              ]
            : []),
          ...(certificate
            ? [
                {
                  id: 'certificate',
                  title: 'HTTPS certificate',
                  detail: new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'long' }).format(
                    certificate,
                  ),
                },
              ]
            : []),
        ],
      }),
      trend:
        daysWith(values) >= 2
          ? trend({
              id: 'answer-time',
              title: heartbeat ? 'Run time' : 'Answer time',
              meta: 'Daily average',
              days,
              values,
              label: heartbeat ? 'Run time' : 'Answer time',
              unit: 'ms',
              figure: { value: `${figure(measured.at(-1) ?? 0)} ms` },
            })
          : null,
      more: command
        ? [
            {
              kind: 'text',
              id: 'check-in',
              title: 'Check in from your script',
              body: command,
            },
            {
              kind: 'text',
              id: 'check-in-network',
              body: 'Works from your home network.',
            },
          ]
        : [],
    }),
    notices: seen.notices ?? [],
    ...(uptimeUnseen(check) ? { status: { status: 'unknown' as const, badge: clip(words, 60) } } : {}),
    tabs: [],
    facts: [],
    actions: [],
    readAt: check?.last ? new Date(check.last.at) : null,
    suggestions: [],
    ...(publicUrl ? { open: { label: 'Open website', url: publicUrl } } : {}),
  };
}

export const UPTIME_KIND: KindModule = { page, checks: UPTIME_CHECKS };
