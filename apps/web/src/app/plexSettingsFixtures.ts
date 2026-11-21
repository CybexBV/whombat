/**
 * Plex's settings in fixture mode (Whombat service-settings.md SST-01…SST-10; mock service-dash-v2 screens 1–3), over
 * the service pages' Plex (`@whombat/fixtures`): the “Plex settings” tab as the server words it (a line, four cards
 * placed main and side in turn, “Something else?”), Ask on Now playing and Libraries, Scan all, and the verdict under
 * the name. A switch or a choice runs the `setting` action: the value changes, the toast says what Plex now says, and the
 * change is recorded with Put it back; putting one back that was changed again since is refused in the server's words.
 * “Quality outside your home” starts as the assistant changed it yesterday, from 4 Mbps, so the row's Put it back shows.
 */

import type { ChangeEntry, ThingPage, ThingPagePanel, ThingSetting } from '@whombat/core';
import type { ThingActionBody, ThingActionResponse, UndoChangeResponse } from '@whombat/core/contracts';
import { mara } from '@whombat/fixtures';
import { ASSISTANT_NAME } from './oneFixtures';

const PLEX = 'http://10.100.0.20:32400';
const PLEX_SETTINGS_URL = `${PLEX}/web/index.html#!/settings/server`;
const SETTING = 'setting';
const DAY = 86_400_000;

type Value = boolean | number | string;

interface Choice {
  value: number | string;
  label: string;
  note?: string;
}

interface Spec {
  id: string;
  group: 'away' | 'convert' | 'libraries' | 'upkeep';
  label: string;
  help: string;
  sheetHelp?: string;
  kind: 'switch' | 'choice' | 'elsewhere';
  choices?: Choice[];
  words: (v: Value) => string;
  /** The toast's words once Plex says the new value. */
  sentence?: (v: Value) => string;
  hint?: string;
}

const mbps = (kbps: number) => `${kbps / 1000} Mbps`;
const onOff = (v: Value) => (v ? 'On' : 'Off');
const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;
const hours = (v: Value) => {
  const [a, b] = String(v).split('-').map(Number);
  return `${hour(a ?? 0)} – ${hour(b ?? 0)}`;
};
const SCHEDULE: Choice[] = [
  { value: 0, label: 'Off' },
  { value: 3600, label: 'Every hour' },
  { value: 7200, label: 'Every 2 hours' },
  { value: 21600, label: 'Every 6 hours' },
  { value: 43200, label: 'Every 12 hours' },
  { value: 86400, label: 'Every day' },
];
const CONVERT: Record<string, string> = { '0': 'Automatic', '1': 'Faster', '2': 'Better picture' };

/** The server's Plex settings (apps/server `plex-settings.ts`), with the fixture's words. */
const SPECS: Spec[] = [
  {
    id: 'remote_access',
    group: 'away',
    label: 'Remote access',
    help: 'People can watch outside your home.',
    kind: 'switch',
    words: onOff,
    sentence: (v) => (v ? 'People can now watch Plex outside your home.' : 'Plex is now only for your home.'),
  },
  {
    id: 'remote_quality',
    group: 'away',
    label: 'Quality outside your home',
    help: 'The most one stream may use. Higher looks better, but needs a faster upload.',
    sheetHelp: 'The most one stream may use when someone watches away from home.',
    kind: 'choice',
    choices: [
      { value: 0, label: 'Original quality', note: 'no limit' },
      { value: 20000, label: '20 Mbps', note: '1080p, high' },
      { value: 12000, label: '12 Mbps', note: '1080p' },
      { value: 8000, label: '8 Mbps', note: '1080p' },
      { value: 4000, label: '4 Mbps', note: '720p' },
      { value: 2000, label: '2 Mbps', note: '720p, low' },
    ],
    words: (v) => (Number(v) === 0 ? 'Original quality' : `Up to ${mbps(Number(v))}`),
    sentence: (v) =>
      Number(v) === 0
        ? 'Plex now sends the original quality outside your home.'
        : `Plex now allows up to ${mbps(Number(v))} outside your home.`,
    hint: 'Your upload is about 40 Mbps, so 20 Mbps works for two people watching away at once.',
  },
  {
    id: 'secure_connections',
    group: 'away',
    label: 'Secure connections',
    help: 'Plex only accepts encrypted connections.',
    kind: 'choice',
    choices: [
      { value: 0, label: 'Required', note: 'only encrypted connections' },
      { value: 1, label: 'Preferred', note: 'encrypted when the player can' },
    ],
    words: (v) => (Number(v) === 0 ? 'Required' : 'Preferred'),
    sentence: (v) =>
      Number(v) === 0
        ? 'Plex now only accepts encrypted connections.'
        : 'Plex now prefers encrypted connections.',
  },
  {
    id: 'graphics_chip',
    group: 'convert',
    label: 'Use the graphics chip',
    help: 'Converts faster and keeps the processor free.',
    kind: 'switch',
    words: onOff,
    sentence: (v) =>
      v ? 'Plex now uses the graphics chip to convert video.' : 'Plex now converts video on the processor.',
  },
  {
    id: 'conversion_quality',
    group: 'convert',
    label: 'Conversion quality',
    help: 'How hard Plex works when a device can’t play a file as it is.',
    kind: 'choice',
    choices: [
      { value: 0, label: 'Automatic' },
      { value: 1, label: 'Faster', note: 'less work for the machine' },
      { value: 2, label: 'Better picture', note: 'more work for the machine' },
    ],
    words: (v) => CONVERT[String(v)] ?? String(v),
    sentence: (v) => `Plex now converts with ${(CONVERT[String(v)] ?? String(v)).toLowerCase()} quality.`,
  },
  {
    id: 'conversions_at_once',
    group: 'convert',
    label: 'Conversions at once',
    help: 'More lets more people watch, but makes the machine busier.',
    kind: 'choice',
    choices: [0, 1, 2, 3, 4, 6, 8].map((n) => ({ value: n, label: n === 0 ? 'No limit' : `At most ${n}` })),
    words: (v) => (Number(v) === 0 ? 'No limit' : `At most ${Number(v)}`),
    sentence: (v) =>
      Number(v) === 0
        ? 'Plex now converts as many streams at once as asked.'
        : `Plex now converts at most ${Number(v)} at once.`,
  },
  {
    id: 'scan_on_change',
    group: 'libraries',
    label: 'Scan when files change',
    help: 'New films show up within a minute.',
    kind: 'switch',
    words: onOff,
    sentence: (v) =>
      v ? 'Plex now scans as soon as files change.' : 'Plex no longer scans when files change.',
  },
  {
    id: 'scan_schedule',
    group: 'libraries',
    label: 'Scan on a schedule',
    help: 'Catches anything the first one missed.',
    kind: 'choice',
    choices: SCHEDULE,
    words: (v) => SCHEDULE.find((c) => c.value === Number(v))?.label ?? String(v),
    sentence: (v) =>
      Number(v) === 0
        ? 'Plex no longer scans on a schedule.'
        : `Plex now scans ${(SCHEDULE.find((c) => c.value === Number(v))?.label ?? '').toLowerCase()}.`,
  },
  {
    id: 'empty_trash',
    group: 'libraries',
    label: 'Empty the trash after a scan',
    help: 'Removed files leave Plex at once. It stays in Plex: a drive away for a moment could empty a library.',
    kind: 'elsewhere',
    words: onOff,
  },
  {
    id: 'quiet_hours',
    group: 'upkeep',
    label: 'Quiet hours for upkeep',
    help: 'When Plex optimises its database and makes previews.',
    kind: 'choice',
    choices: [0, 1, 2, 3, 4].map((h) => ({ value: `${h}-${h + 3}`, label: hours(`${h}-${h + 3}`) })),
    words: hours,
    sentence: (v) => `Plex now does its upkeep from ${hours(v).replace(' – ', ' to ')}.`,
  },
  {
    id: 'updates',
    group: 'upkeep',
    label: 'Updates',
    help: 'Installing a new version restarts Plex, so it stays in Plex.',
    kind: 'elsewhere',
    words: () => 'Ask me',
  },
];

const GROUPS: { id: Spec['group']; title: string; ask: string[] }[] = [
  {
    id: 'away',
    title: 'Watching away from home',
    ask: ['Why is Plex slow away from home?', 'What quality should I use outside my home?'],
  },
  {
    id: 'convert',
    title: 'Converting video',
    ask: ['Why does Plex convert so much?', 'Can Plex use my server’s graphics chip?'],
  },
  { id: 'libraries', title: 'Libraries', ask: ['Why doesn’t a new film show up in Plex?'] },
  { id: 'upkeep', title: 'Upkeep', ask: ['When does Plex do its upkeep?'] },
];

/** A recorded change of a setting, while it can be put back. */
interface Changed {
  changeId: string;
  setting: string;
  from: Value;
  to: Value;
  by: 'you' | 'assistant';
  at: number;
  /** Also in the world's changes list (Activity, Done recently): its Undo marks it there too. */
  listed: boolean;
}

export interface PlexSettingsFixtures {
  /** The service pages' Plex page with its settings tab, Ask on its cards, Scan all and its verdict. */
  decorate(page: ThingPage): ThingPage;
  /** `things.action` for Plex's `setting` and Scan all; null for any other button (the service pages answer it). */
  action(body: ThingActionBody): { status: number; body: unknown } | null;
  /**
   * `changes.undo` of a Plex setting's change: puts it back. `answer` when this layer answers (a change only it knows,
   * or a refusal); `listed` when the world's changes list answers after it.
   */
  undo(changeId: string): { answer: { status: number; body: unknown } } | { listed: true } | null;
}

export function createPlexSettingsFixtures(options: {
  thing: string;
  now: () => number;
  addChange: (entry: ChangeEntry) => void;
}): PlexSettingsFixtures {
  const values = new Map<string, Value>([
    ['remote_access', true],
    ['remote_quality', 8000],
    ['secure_connections', 0],
    ['graphics_chip', true],
    ['conversion_quality', 0],
    ['conversions_at_once', 4],
    ['scan_on_change', true],
    ['scan_schedule', 21600],
    ['empty_trash', false],
    ['quiet_hours', '2-5'],
    ['updates', 'tells'],
  ]);
  let seq = 0;
  const made = options.now();
  // Every change, newest last; the assistant raised the quality yesterday (the mock's row), only on this page.
  const history: (Changed & { undone: boolean })[] = [
    {
      changeId: 'chg_fx_plex_quality',
      setting: 'remote_quality',
      from: 4000,
      to: 8000,
      by: 'assistant',
      at: made - DAY,
      listed: false,
      undone: false,
    },
  ];
  /** A setting's last change, while it can be put back. */
  const lastChange = (setting: string) => history.findLast((c) => c.setting === setting && !c.undone);

  const dayWords = (at: number) => {
    const days = Math.floor((options.now() - at) / DAY);
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  };

  const button = (target: string, label: string) => ({
    action: SETTING,
    target,
    label,
    allowed: true,
  });

  function row(spec: Spec): ThingSetting {
    const v = values.get(spec.id) as Value;
    const c = lastChange(spec.id);
    const base = {
      id: spec.id,
      label: spec.label,
      help: spec.help,
      value: spec.words(v),
      ...(c
        ? {
            changed: {
              text: `${c.by === 'assistant' ? ASSISTANT_NAME : 'You'} changed this ${dayWords(c.at)} from ${spec.words(c.from).replace(/^Up to /, '')}.`,
              short: `Changed by ${c.by === 'assistant' ? ASSISTANT_NAME : 'you'} ${dayWords(c.at)}`,
              changeId: c.changeId as NonNullable<ThingSetting['changed']>['changeId'],
            },
          }
        : {}),
    };
    if (spec.kind === 'switch') return { ...base, on: !!v, toggle: button(spec.id, spec.label) };
    if (spec.kind === 'elsewhere')
      return { ...base, elsewhere: { label: 'In Plex', url: PLEX_SETTINGS_URL } };
    return {
      ...base,
      choose: {
        button: button(spec.id, 'Change'),
        current: (spec.choices ?? []).find((x) => String(x.value) === String(v))?.value ?? null,
        help: spec.sheetHelp ?? spec.help,
        ...(spec.hint ? { hint: spec.hint } : {}),
        choices: spec.choices ?? [],
      },
    };
  }

  function settingsTab(): ThingPage['tabs'][number] {
    const panels: ThingPagePanel[] = [
      {
        kind: 'text',
        id: 'settings-intro',
        place: 'top',
        body: `The settings that matter most, in plain words. Change one here, or ask ${ASSISTANT_NAME} to do it for you.`,
        link: { kind: 'url', label: 'All settings in Plex', url: PLEX_SETTINGS_URL },
      },
      ...GROUPS.map(
        (g, i): ThingPagePanel => ({
          kind: 'settings',
          id: `settings-${g.id}`,
          place: i < Math.ceil(GROUPS.length / 2) ? 'main' : 'side',
          title: g.title,
          rows: SPECS.filter((s) => s.group === g.id).map(row),
          ask: { questions: g.ask },
        }),
      ),
      {
        kind: 'text',
        id: 'settings-more',
        place: 'bottom',
        title: 'Something else?',
        body: `${ASSISTANT_NAME} can change any other Plex setting for you. It asks you first.`,
        link: {
          kind: 'ask',
          label: `Ask ${ASSISTANT_NAME}`,
          question: 'I’d like to change another Plex setting.',
        },
      },
    ];
    return { key: 'service-settings', label: 'Plex settings', panels };
  }

  const ASKS: Record<string, string[]> = {
    now_playing: [
      'Why is Severance converting on iPad?',
      'Who watched the most this week?',
      'What did people watch today?',
    ],
    libraries: [
      'Why couldn’t Plex match some items?',
      'What was added this week?',
      'Which films take the most space?',
    ],
    recently_added: ['What was added this week?', 'Who asked for what?'],
    week: ['Why was Saturday so busy?', 'What did people watch most this week?'],
    machine: ['Is thetitan fast enough for Plex?', 'When will the disk be full?'],
  };

  function decorate(page: ThingPage): ThingPage {
    const summary = page.tabs[0];
    if (!summary) return page;
    let scanning: string | null = null;
    const panels = summary.panels.map((p): ThingPagePanel => {
      if (p.kind === 'list' && p.id === 'libraries') {
        const busy = p.items.find((i) => i.detail?.startsWith('Scanning'));
        scanning = busy?.title ?? null;
        return { ...p, ask: { questions: ASKS.libraries ?? [] } };
      }
      const ask = ASKS[p.id];
      return ask ? { ...p, ask: { questions: ask } } : p;
    });
    return {
      ...page,
      verdict: `Plex is fine: 3 people are watching and ${scanning ? `${scanning} is being scanned` : 'every library is up to date'}.`,
      tabs: [{ ...summary, panels }, settingsTab(), ...page.tabs.slice(1)],
    };
  }

  const refuse = (status: number, code: string, message: string) => ({
    status,
    body: { error: { code, message } },
  });

  function action(body: ThingActionBody): { status: number; body: unknown } | null {
    if (body.action === 'scan' && body.target === 'all')
      return {
        status: 202,
        body: { message: 'Plex is scanning every library.' } satisfies ThingActionResponse,
      };
    if (body.action !== SETTING) return null;
    const spec = SPECS.find((s) => s.id === body.target);
    if (!spec || spec.kind === 'elsewhere')
      return refuse(400, 'validation_failed', 'That isn’t a setting Whombat changes here.');
    const was = values.get(spec.id) as Value;
    const next = spec.kind === 'switch' ? body.value === true : body.value;
    if (next === undefined || next === null) return refuse(400, 'validation_failed', 'Which value?');
    if (spec.kind === 'choice' && !(spec.choices ?? []).some((c) => String(c.value) === String(next)))
      return refuse(400, 'validation_failed', `That isn’t one of the choices for ${spec.label}.`);
    if (String(next) === String(was))
      return {
        status: 202,
        body: { message: `${spec.label} is already ${spec.words(was)}.` } satisfies ThingActionResponse,
      };
    values.set(spec.id, next as Value);
    const changeId = `chg_fx_plex_${++seq}`;
    const at = options.now();
    history.push({
      changeId,
      setting: spec.id,
      from: was,
      to: next as Value,
      by: 'you',
      at,
      listed: true,
      undone: false,
    });
    options.addChange({
      id: changeId as ChangeEntry['id'],
      title: `Changed ${spec.label} in Plex from ${spec.words(was)} to ${spec.words(next as Value)}`,
      at: new Date(at).toISOString(),
      actor: { kind: 'person', id: mara.id, name: mara.name },
      undo: { state: 'available', until: new Date(at + 7 * DAY).toISOString() },
      thingId: options.thing,
      link: '/things/connection%3Acon_plex' as ChangeEntry['link'],
    });
    return {
      status: 202,
      body: {
        message: `${spec.sentence?.(next as Value) ?? `${spec.label} is now ${spec.words(next as Value)}.`} Checked with Plex.`,
        changeId: changeId as ThingActionResponse['changeId'],
        refresh: true,
        undoable: true,
      } satisfies ThingActionResponse,
    };
  }

  function undo(changeId: string) {
    const c = history.find((x) => x.changeId === changeId);
    if (!c || c.undone) return null;
    const spec = SPECS.find((s) => s.id === c.setting);
    if (!spec) return null;
    if (String(values.get(c.setting)) !== String(c.to))
      return {
        answer: refuse(
          409,
          'conflict',
          `${spec.label} was changed again since, so Whombat won’t put it back.`,
        ),
      };
    values.set(c.setting, c.from);
    c.undone = true;
    if (c.listed) return { listed: true as const };
    const entry: ChangeEntry = {
      id: c.changeId as ChangeEntry['id'],
      title: `Changed ${spec.label} in Plex from ${spec.words(c.from)} to ${spec.words(c.to)}`,
      at: new Date(c.at).toISOString(),
      actor: { kind: 'whombat', id: 'prn_neo' as ChangeEntry['actor']['id'], name: ASSISTANT_NAME },
      undo: { state: 'undone' },
      thingId: options.thing,
    };
    return { answer: { status: 200, body: { change: entry, state: 'undone' } satisfies UndoChangeResponse } };
  }

  return { decorate, action, undo };
}
