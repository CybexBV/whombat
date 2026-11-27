/** Dutch for schedules, Live Activities, work, mail accounts, watches, step kinds and missing attachments. */
import { describe, expect, it } from 'vitest';
import { missingAttachmentsText } from '../automations/mail.js';
import { liveActivityPush, runLiveActivity } from '../contracts/live-activity.js';
import { STEP_KIND_LABELS, stepKindLabel, stepKindLabels } from '../domain/automation.js';
import {
  IMAP_PROVIDER_HINTS,
  imapConnectFailureText,
  imapProviderHint,
  imapServersLine,
  NEW_CLIENT_NEEDS_SECRET_TEXT,
  newClientNeedsSecretText,
  serviceLabel,
} from '../domain/connectors.js';
import { type FindMyWatchView, findMyWatchCardLines, findMyWatchEndText } from '../domain/findmy-watch.js';
import type { Run } from '../domain/run.js';
import {
  describeScheduleWhen,
  SCHEDULE_COPY,
  SCHEDULE_END_LABELS,
  SCHEDULE_STATUS_LABELS,
  scheduleCardTitle,
  scheduleCopy,
  scheduleCopyWords,
  scheduleEndLabels,
  scheduleStatusLabels,
} from '../domain/schedules.js';
import { type ThingWatchView, thingWatchCardLines, thingWatchStartText } from '../domain/thing-watch.js';
import { WORK_SECTIONS, workHealth, workSections } from '../domain/work.js';

const AMS = 'Europe/Amsterdam';
const NOW = '2026-10-03T10:00:00.000Z';

describe('word tables keep their English', () => {
  it('constants equal their functions in English', () => {
    expect(SCHEDULE_STATUS_LABELS).toEqual(scheduleStatusLabels('en'));
    expect(SCHEDULE_END_LABELS).toEqual(scheduleEndLabels('en'));
    expect(SCHEDULE_COPY).toEqual(scheduleCopyWords('en'));
    expect(WORK_SECTIONS).toEqual(workSections('en'));
    expect(STEP_KIND_LABELS).toEqual(stepKindLabels('en'));
    expect(NEW_CLIENT_NEEDS_SECRET_TEXT).toBe(newClientNeedsSecretText('en'));
    expect(WORK_SECTIONS.map((s) => s.title)).toContain('RECENTLY DONE');
  });

  it('known providers keep their English sentence', () => {
    for (const provider of IMAP_PROVIDER_HINTS) expect(imapProviderHint(provider).text).toBe(provider.text);
  });
});

describe('schedules in Dutch', () => {
  it('labels and copy', () => {
    expect(scheduleStatusLabels('nl').paused).toBe('Gepauzeerd');
    expect(scheduleCopy('Neo', 'nl').empty).toContain('Neo');
    expect(scheduleCopy('Neo', 'nl').cancel).toBe('Annuleren');
  });

  it('when it runs', () => {
    expect(describeScheduleWhen({ kind: 'every', minutes: 30 }, AMS, NOW, 'nl')).toBe('Elke 30 minuten');
    expect(describeScheduleWhen({ kind: 'every', minutes: 30 }, AMS, NOW)).toBe('Every 30 minutes');
    const once = describeScheduleWhen({ kind: 'at', at: '2026-10-04T09:00:00+02:00' }, AMS, NOW, 'nl');
    expect(once).toContain('Eenmalig');
    expect(once).toContain('om 09:00');
    expect(describeScheduleWhen({ kind: 'at', at: '2026-10-04T09:00:00+02:00' }, AMS, NOW)).toBe(
      'Once, Sun 4 Oct at 09:00',
    );
    const other = describeScheduleWhen(
      { kind: 'cron', expr: '0 16 * * 5', zone: 'America/New_York' },
      AMS,
      NOW,
      'nl',
    );
    expect(other).toContain('vrijdag');
    expect(other).toContain('tijd in New York');
  });

  it('card title', () => {
    expect(scheduleCardTitle('Neo', null, 'nl')).toContain('ingepland');
    expect(scheduleCardTitle('Neo', null)).toBe('Neo scheduled a task');
  });
});

describe('Live Activities in Dutch', () => {
  const run = {
    id: 'run_1',
    number: 7,
    burrowId: 'bur_1',
    agentId: 'agt_1',
    title: 'Export',
    branch: null,
    progress: 40,
    status: 'live',
    steps: [{ state: 'active', title: 'Tests draaien' }],
    tests: null,
  } as unknown as Run;

  it('run text and push title', () => {
    const state = runLiveActivity(run, 'Neo', 'nl');
    expect(state.display.text).toContain('Nu: Tests draaien');
    expect(runLiveActivity(run, 'Neo').display.text).toContain('Now: Tests draaien');
    expect(liveActivityPush(state, 'update', 'hq', 'nl').title).toContain('Uitvoering #7');
    expect(liveActivityPush(state, 'update', 'hq').title).toBe('Neo · Run #7');
  });
});

describe('work health in Dutch', () => {
  const now = new Date(NOW);
  const ago = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
  it('says what is going on', () => {
    expect(workSections('nl')[0]?.title).toBe('ACTIE NODIG');
    const quiet = workHealth({ now, heartbeatAt: ago(0), lastProgressAt: ago(6), leaseMs: 60_000 }, 'nl');
    expect(quiet.text).toContain('6 min geleden');
    expect(workHealth({ now, heartbeatAt: ago(0), lastProgressAt: ago(6), leaseMs: 60_000 }).text).toBe(
      'Working quietly · last step 6 min ago',
    );
    const stalled = workHealth({ now, heartbeatAt: ago(3), lastProgressAt: ago(3), leaseMs: 60_000 }, 'nl');
    expect(stalled.text).toContain('3 min');
    expect(stalled.text).toContain('runner');
  });
});

describe('mail accounts in Dutch', () => {
  it('servers, failures and hints', () => {
    expect(imapServersLine({ imapHost: 'imap.example.com', smtpHost: 'smtp.example.com' }, 'nl')).toContain(
      ' en ',
    );
    expect(imapServersLine({ imapHost: 'imap.example.com', smtpHost: 'smtp.example.com' })).toContain(
      ' and ',
    );
    expect(
      imapConnectFailureText('imap_unreachable', { host: 'imap.example.com', port: 993 }, 'nl'),
    ).toContain('op poort 993');
    expect(imapConnectFailureText('imap_unreachable', { host: 'imap.example.com', port: 993 })).toBe(
      'Whombat couldn’t reach imap.example.com on port 993.',
    );
    const gmail = IMAP_PROVIDER_HINTS.find((p) => p.id === 'google');
    expect(gmail && imapProviderHint(gmail, 'nl').text).toContain('app-wachtwoord');
    expect(serviceLabel('mail', 'imap', 'nl')).toBe(serviceLabel('mail', null, 'nl'));
  });
});

describe('watches in Dutch', () => {
  const findMy: FindMyWatchView = {
    id: 'fmw_1',
    name: 'Noor Visser',
    change: 'leaves',
    place: 'Keizersgracht',
    status: 'expired',
    startedAt: NOW,
    endsAt: NOW,
    endedAt: NOW,
    to: null,
  } as unknown as FindMyWatchView;

  it('Find My', () => {
    expect(findMyWatchEndText(findMy, 'nl')).toContain('24 uur');
    expect(findMyWatchEndText(findMy)).toContain('after 24 hours');
    expect(findMyWatchCardLines(findMy, AMS, NOW, 'nl').title).toContain('gestopt');
  });

  const thing: ThingWatchView = {
    id: 'thw_1',
    thing: 'host:pve-02',
    name: 'Plex',
    event: 'back',
    status: 'watching',
    startedAt: NOW,
    endsAt: '2026-10-05T12:00:00.000Z',
    endedAt: null,
  } as unknown as ThingWatchView;

  it('a thing', () => {
    expect(thingWatchStartText(thing, null, 'nl')).toContain('weer bereikbaar');
    expect(thingWatchStartText(thing)).toBe('I’ll tell you when Plex is back.');
    const lines = thingWatchCardLines(thing, AMS, NOW, 'nl');
    expect(lines.detail).toContain('Tot ');
    expect(lines.detail).toContain('om 14:00');
    expect(thingWatchCardLines(thing, AMS, NOW).detail).toBe('Until Mon 5 Oct at 14:00');
  });
});

describe('steps and attachments in Dutch', () => {
  it('step kinds', () => {
    expect(stepKindLabel('wait', 'nl')).toBe('Wachten');
    expect(stepKindLabel('gone_kind', 'nl')).toBe('Een eerdere stap');
    expect(stepKindLabel('gone_kind')).toBe('An earlier step');
  });

  it('missing attachments', () => {
    expect(missingAttachmentsText([{ name: 'a.pdf', reason: 'too_large' }], 0, 10, 'nl')).toContain(
      'te groot',
    );
    expect(missingAttachmentsText([], 1, 10, 'nl')).toContain('Nog 1 bijlage');
    expect(missingAttachmentsText([], 1)).toBe(
      '1 more attachment didn’t come along (attachment limit reached).',
    );
  });
});
