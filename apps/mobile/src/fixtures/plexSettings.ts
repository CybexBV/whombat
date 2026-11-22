/**
 * Plex's settings in the phone's demo world (Whombat service-settings.md SST-01…SST-10; mock service-dash-v2 screen 6):
 * the server's “Plex settings” tab after the Summary — its line, four groups of the settings that matter, each with its
 * Ask, and “Something else?” —, Ask on Now playing and Libraries, the verdict under the name, the `setting` action
 * (checked, recorded as a change that can be put back for 7 days) and `changes.undo` of those changes. Quality outside
 * your home starts as the assistant changed it yesterday, from 4 Mbps. The words are the server's
 * (`apps/server/src/things/kinds/settings.ts`, `media/plex-settings.ts`), shortened to what the demo needs.
 */
import type {
  ChangeEntry,
  ThingButtonValue,
  ThingPage,
  ThingPagePanel,
  ThingPageTab,
  ThingSetting,
} from '@whombat/core';
import type { ThingActionBody } from '@whombat/core/contracts';

type Value = string | number | boolean;

interface Choice {
  value: Value;
  label: string;
  note?: string;
}

interface Spec {
  id: string;
  group: string;
  label: string;
  help: string;
  kind: 'switch' | 'choice' | 'elsewhere';
  choices?: Choice[];
  /** The row's words (absent: the choice's label, or On/Off). */
  words?: (v: Value) => string;
  sentence?: (v: Value) => string;
  sheetHelp?: string;
  hint?: string;
}

const GROUPS = [
  {
    id: 'remote',
    title: 'Watching away from home',
    ask: ['Why does it buffer when I watch away?', 'Is it safe to turn on remote access?'],
  },
  {
    id: 'convert',
    title: 'Converting video',
    ask: ['Why is the iPad converting?', 'Can this machine convert two films at once?'],
  },
  { id: 'libraries', title: 'Libraries', ask: ['Why don’t new films show up straight away?'] },
  { id: 'upkeep', title: 'Upkeep' },
] as const;

const mbps = (kbps: number) => `${kbps / 1000} Mbps`;

const SPECS: Spec[] = [
  {
    id: 'remote_access',
    group: 'remote',
    label: 'Remote access',
    help: 'People can watch outside your home. Turning it off can cut off access from outside, so it stays in Plex.',
    kind: 'elsewhere',
    words: (v) => (v ? 'On' : 'Off'),
  },
  {
    id: 'remote_quality',
    group: 'remote',
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
    words: (v) => (v === 0 ? 'Original quality' : `Up to ${mbps(Number(v))}`),
    sentence: (v) =>
      v === 0
        ? 'Plex now sends original quality outside your home.'
        : `Plex now allows up to ${mbps(Number(v))} outside your home.`,
    hint: 'Your upload is about 40 Mbps, so 20 Mbps works for two people watching away at once.',
  },
  {
    id: 'secure_connections',
    group: 'remote',
    label: 'Secure connections',
    help: 'Whether Plex only accepts encrypted connections. Requiring encryption stops plain HTTP access on port 32400, so it stays in Plex.',
    kind: 'elsewhere',
    words: (v) => (Number(v) === 0 ? 'Required' : 'Preferred'),
  },
  {
    id: 'hardware_transcoding',
    group: 'convert',
    label: 'Use the graphics chip',
    help: 'Converting uses the graphics chip instead of the processor.',
    kind: 'switch',
  },
  {
    id: 'transcoder_quality',
    group: 'convert',
    label: 'Conversion quality',
    help: 'How hard Plex works when a device can’t play a file as it is.',
    kind: 'choice',
    choices: [
      { value: 0, label: 'Automatic' },
      { value: 1, label: 'Faster', note: 'lighter on the machine' },
      { value: 2, label: 'Better picture', note: 'busier machine' },
    ],
  },
  {
    id: 'transcode_limit',
    group: 'convert',
    label: 'Conversions at once',
    help: 'How many videos Plex converts at the same time.',
    kind: 'choice',
    choices: [
      { value: 0, label: 'No limit' },
      { value: 1, label: '1' },
      { value: 2, label: '2' },
      { value: 3, label: '3' },
      { value: 4, label: '4' },
      { value: 6, label: '6' },
      { value: 8, label: '8' },
    ],
  },
  {
    id: 'scan_on_change',
    group: 'libraries',
    label: 'Scan when files change',
    help: 'New files show up as soon as they land.',
    kind: 'switch',
  },
  {
    id: 'scan_schedule',
    group: 'libraries',
    label: 'Scan on a schedule',
    help: 'Plex looks for new files on its own now and then.',
    kind: 'choice',
    choices: [
      { value: 'off', label: 'Off' },
      { value: 1, label: 'Every hour' },
      { value: 2, label: 'Every 2 hours' },
      { value: 6, label: 'Every 6 hours' },
      { value: 12, label: 'Every 12 hours' },
      { value: 24, label: 'Every day' },
    ],
  },
  {
    id: 'upkeep_hours',
    group: 'upkeep',
    label: 'Quiet hours for upkeep',
    help: 'When Plex cleans up and optimises, while nobody watches.',
    kind: 'choice',
    choices: [
      { value: '0-3', label: '00:00 – 03:00' },
      { value: '2-5', label: '02:00 – 05:00' },
      { value: '3-6', label: '03:00 – 06:00' },
      { value: '4-7', label: '04:00 – 07:00' },
    ],
  },
  {
    id: 'updates',
    group: 'upkeep',
    label: 'Updates',
    help: 'Plex tells you when a new version is out.',
    kind: 'elsewhere',
    words: () => 'Ask me',
  },
];

const PLEX_URL = 'http://10.100.0.20:32400/web/index.html#!/settings/server';
const DAY = 86_400_000;
const UNDO_MS = 7 * DAY;

export interface PlexSettingsOptions {
  now: () => number;
  assistant: () => { id: string; name: string };
  /** The person pressing (Mara). */
  person: { id: string; name: string };
  thingId: string;
  /** Look only (every switch and Change disabled with its reason). */
  lookOnly?: () => boolean;
}

interface Made {
  change: ChangeEntry;
  setting: string;
  from: Value;
  to: Value;
  byAssistant: boolean;
  undone: boolean;
}

export function createPlexSettings(options: PlexSettingsOptions) {
  const { now, thingId } = options;
  const values = new Map<string, Value>([
    ['remote_access', true],
    ['remote_quality', 8000],
    ['secure_connections', 0],
    ['hardware_transcoding', true],
    ['transcoder_quality', 0],
    ['transcode_limit', 4],
    ['scan_on_change', true],
    ['scan_schedule', 6],
    ['upkeep_hours', '2-5'],
    ['updates', 'ask'],
  ]);
  const made: Made[] = [];
  let seq = 0;
  const record = (setting: Spec, from: Value, to: Value, at: number, byAssistant: boolean): Made => {
    seq += 1;
    const actor = byAssistant
      ? { kind: 'whombat' as const, ...options.assistant() }
      : { kind: 'person' as const, ...options.person };
    const m: Made = {
      setting: setting.id,
      from,
      to,
      byAssistant,
      undone: false,
      change: {
        id: `chg_plex-setting-${seq}`,
        title: `Changed ${setting.label} in Plex from ${short(setting, from)} to ${short(setting, to)}`,
        at: new Date(at).toISOString(),
        actor,
        undo: { state: 'available', until: new Date(at + UNDO_MS).toISOString() },
        thingId,
      },
    };
    made.unshift(m);
    return m;
  };
  // Yesterday the assistant raised Quality outside your home from 4 to 8 Mbps.
  const quality = SPECS.find((s) => s.id === 'remote_quality') as Spec;
  record(quality, 4000, 8000, now() - DAY - 2 * 3_600_000, true);

  const refusal = () =>
    options.lookOnly?.() ? 'Whombat only looks at Plex here. Change it in its Settings to Manage.' : null;
  const button = (spec: Spec, label: string) => {
    const reason = refusal();
    return { action: 'setting', target: spec.id, label, allowed: !reason, ...(reason ? { reason } : {}) };
  };

  function row(spec: Spec): ThingSetting {
    const v = values.get(spec.id) as Value;
    const last = made.find((m) => m.setting === spec.id && !m.undone);
    const base = {
      id: spec.id,
      label: spec.label,
      help: spec.help,
      value: words(spec, v),
      ...(last ? { changed: changedWords(last) } : {}),
    };
    if (spec.kind === 'elsewhere') return { ...base, elsewhere: { label: 'In Plex', url: PLEX_URL } };
    if (spec.kind === 'switch') return { ...base, on: v === true, toggle: button(spec, spec.label) };
    return {
      ...base,
      choose: {
        button: button(spec, 'Change'),
        current: (spec.choices ?? []).some((c) => c.value === v) ? (v as ThingButtonValue) : null,
        help: spec.sheetHelp ?? spec.help,
        ...(spec.hint ? { hint: spec.hint } : {}),
        choices: (spec.choices ?? []).map((c) => ({
          value: c.value as ThingButtonValue,
          label: c.label,
          ...(c.note ? { note: c.note } : {}),
        })),
      },
    };
  }

  function changedWords(m: Made) {
    const d = now() - new Date(m.change.at).getTime() < DAY * 0.9 ? 'today' : 'yesterday';
    const who = m.byAssistant ? options.assistant().name : 'You';
    const spec = SPECS.find((s) => s.id === m.setting) as Spec;
    const open = m.change.undo.state === 'available';
    return {
      text: `${who} changed this ${d} from ${short(spec, m.from)}.`,
      short: `Changed by ${m.byAssistant ? options.assistant().name : 'you'} ${d}`,
      ...(open ? { changeId: m.change.id } : {}),
    };
  }

  function tab(): ThingPageTab {
    const assistant = options.assistant().name;
    const panels: ThingPagePanel[] = [
      {
        kind: 'text',
        id: 'settings-intro',
        place: 'top',
        body: `The settings that matter most, in plain words. Change one here, or ask ${assistant} to do it for you.`,
        link: { kind: 'url', label: 'All settings in Plex', url: PLEX_URL },
      },
      ...GROUPS.map(
        (g, i): ThingPagePanel => ({
          kind: 'settings',
          id: `settings-${g.id}`,
          place: i % 2 === 0 ? 'main' : 'side',
          title: g.title,
          rows: SPECS.filter((s) => s.group === g.id).map(row),
          ...('ask' in g ? { ask: { questions: [...g.ask] } } : {}),
        }),
      ),
      {
        kind: 'text',
        id: 'settings-more',
        place: 'bottom',
        title: 'Something else?',
        body: `${assistant} can change any other Plex setting for you. It asks you first.`,
        link: {
          kind: 'ask',
          label: `Ask ${assistant}`,
          question: 'I’d like to change another Plex setting.',
        },
      },
    ];
    return { key: 'service-settings', label: 'Plex settings', panels };
  }

  /** Plex's page with its settings tab after the Summary, Ask on Now playing and Libraries, and its verdict. */
  function page(p: ThingPage): ThingPage {
    const asks: Record<string, string[]> = {
      'Now playing': [
        'Why is Severance converting on the iPad?',
        'Who watched the most this week?',
        'What did people watch today?',
      ],
      Libraries: ['Why couldn’t Plex match some items?', 'What was added this week?'],
    };
    const tabs = p.tabs.map((t, i) =>
      i > 0
        ? t
        : {
            ...t,
            panels: t.panels.map((x) => {
              const questions = 'title' in x && typeof x.title === 'string' ? asks[x.title] : undefined;
              return questions ? { ...x, ask: { questions } } : x;
            }),
          },
    );
    return {
      ...p,
      verdict: 'Plex is fine: 2 people are watching and every library is up to date.',
      tabs: [...tabs.slice(0, 1), tab(), ...tabs.slice(1)],
    };
  }

  type Answer = { status: number; body: unknown };
  const refused = (status: number, message: string): Answer => ({
    status,
    body: { error: { code: status === 409 ? 'conflict' : 'bad_request', message } },
  });

  /** `things.action` with `setting` (SST-02): only a value it offers, checked, recorded so it can be put back. */
  function action(body: ThingActionBody): Answer | null {
    if (body.action !== 'setting') return null;
    const reason = refusal();
    if (reason) return { status: 403, body: { error: { code: 'forbidden', message: reason } } };
    const spec = SPECS.find((s) => s.id === body.target && s.kind !== 'elsewhere');
    if (!spec) return refused(400, 'Plex has no such setting here.');
    const old = values.get(spec.id) as Value;
    const raw = body.value;
    const value =
      spec.kind === 'switch'
        ? typeof raw === 'boolean'
          ? raw
          : undefined
        : spec.choices?.find((c) => String(c.value) === String(raw))?.value;
    if (value === undefined) return refused(400, `Plex can’t set ${spec.label} to that from here.`);
    if (value === old)
      return { status: 200, body: { message: `${spec.label} is already ${words(spec, old)}.` } };
    values.set(spec.id, value);
    const m = record(spec, old, value, now(), false);
    const said = spec.sentence?.(value) ?? `${spec.label} is now ${words(spec, value)}.`;
    return {
      status: 200,
      body: { message: `${said} Checked with Plex.`, changeId: m.change.id, undoable: true, refresh: true },
    };
  }

  /** `changes.undo` of a setting's change (SST-03): refused once the setting was changed again since. */
  function undo(changeId: string): Answer | null {
    const m = made.find((x) => x.change.id === changeId);
    if (!m) return null;
    const spec = SPECS.find((s) => s.id === m.setting) as Spec;
    if (m.change.undo.state !== 'available') return refused(409, 'This can’t be put back any more.');
    if (values.get(m.setting) !== m.to)
      return refused(409, `${spec.label} was changed again since, so Whombat won’t put it back.`);
    values.set(m.setting, m.from);
    m.undone = true;
    m.change = { ...m.change, undo: { state: 'undone' } };
    return { status: 200, body: { change: m.change, state: 'undone' } };
  }

  return {
    page,
    action,
    undo,
    /** The changes made here, newest first (the page's Activity). */
    changes: () => made.map((m) => m.change),
  };
}

function words(spec: Spec, v: Value): string {
  if (spec.words) return spec.words(v);
  if (spec.kind === 'switch') return v ? 'On' : 'Off';
  return spec.choices?.find((c) => c.value === v)?.label ?? String(v);
}

function short(spec: Spec, v: Value): string {
  if (spec.id === 'remote_quality') return v === 0 ? 'original quality' : mbps(Number(v));
  return words(spec, v);
}
