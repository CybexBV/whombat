/**
 * A Mac with Find My for `findmy.ts`'s tests, behind a stand-in for the hosts service's `call`: it answers the screen
 * steps (snake_case, as the hub does) the way Whombat Helper 1.1.0 and Find My do on a real Mac. The rows are Find My's
 * own shape: words joined by a middle dot between no-break spaces, a chosen row with its street; the People tab is
 * an `AXRadioButton`, the map the window's largest `AXImage`, the pins `AXGenericElement`s. Made-up people only.
 */
import { type HostsRequest, HostsUnavailable } from '../client';

type Json = Record<string, unknown>;

/** Find My's separator: a middle dot with a no-break space on each side. */
export const DOT = ' · ';

export interface FakePerson {
  name: string;
  /** The row's words after the name, as Find My shows them. */
  row: string[];
  /** The chosen row's words after the name (with the street), when Find My shows one. */
  chosen?: string[];
  /** A person's row also offers these own actions (Find My's custom actions). */
  actions?: string[];
}

/** The people on Find My's People tab of this fake (names made up). */
export const FAKE_PEOPLE: FakePerson[] = [
  {
    name: 'Mara Visser',
    row: ['Nearby', 'Home', 'Now'],
    chosen: ['Home', 'Nearby', 'Damrak 1, Amsterdam', '5 minutes ago'],
  },
  {
    // Further away: Find My says how far, with a decimal comma in Dutch.
    name: 'Ruben Visser',
    row: ['5,5 km', 'Lelystad', '5 min ago'],
    chosen: ['5,5 km', 'Stationsplein 2, Lelystad', '5 min ago'],
  },
  { name: 'Noor Visser', row: ['No location found'] },
];

const custom = (name: string) => `Name:${name}\nTarget:0x0\nSelector:(null)`;
const norm = (s: string) => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

export class FakeFindMyMac {
  /** Every step's body, in order. */
  readonly steps: Json[] = [];
  locked = false;
  /** Seconds since someone used the Mac; undefined: the status doesn't say (an agent from before Find My). */
  idle: number | null | undefined = 600;
  version = '1.1.0';
  ax = true;
  /** Find My runs already (before Whombat opens it). */
  running = false;
  /** Lists that answer without Find My's tabs after it opened (it's starting); Infinity: they never come. */
  slowLists = 1;
  /** `ui.open` doesn't find Find My. */
  noApp = false;
  /** The agent cuts the cropped look (an older one sends the whole screen). */
  crops = true;
  /** `unlock` unlocks but its answer never comes (the hosts service gives up waiting). */
  unlockTimesOut = false;
  /** `map.geocode` answers `unsupported` (an older helper). */
  geocodeUnsupported = false;
  people: FakePerson[] = FAKE_PEOPLE.map((p) => ({ ...p }));
  places: Record<string, { lat: number; lon: number; accuracy_m: number } | null> = {
    'Damrak 1, Amsterdam': { lat: 52.3765, lon: 4.8962, accuracy_m: 100 },
    'Stationsplein 2, Lelystad': { lat: 52.5085, lon: 5.4752, accuracy_m: 100 },
  };
  /** A step waits for this before it answers (one job at a time). */
  gate: Promise<void> | null = null;
  inFlight = 0;
  maxInFlight = 0;

  #tab = 'Devices';
  #chosen: string | null = null;
  #listsSinceOpen = 0;

  /** The ops of the steps, in order. */
  ops(): string[] {
    return this.steps.map((s) => String(s.op));
  }

  /** The hosts service's `call`, as `screenStep` uses it. */
  async call<T>(req: HostsRequest): Promise<T> {
    const body = (req.body ?? {}) as Json;
    this.steps.push(body);
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.gate) await this.gate;
      return this.#answer(body) as T;
    } finally {
      this.inFlight--;
    }
  }

  #elements(): Json[] {
    const el = (role: string, desc: string, more: Json = {}): Json => ({
      id: `w0.${desc.length}`,
      role,
      desc,
      title: '',
      value: '',
      enabled: true,
      x: 0,
      y: 0,
      w: 40,
      h: 40,
      actions: ['AXPress'],
      app: 'Find My',
      window: 'Find My',
      ...more,
    });
    const tabs = ['People', 'Devices', 'Items', 'Me'].map((t) =>
      el('AXRadioButton', t, { value: this.#tab === t ? '1' : '0' }),
    );
    const rows =
      this.#tab === 'People'
        ? this.people.map((p) => {
            const words = this.#chosen === p.name && p.chosen ? p.chosen : p.row;
            return el('AXButton', [p.name, ...words].join(DOT), {
              w: 300,
              h: 56,
              actions: [
                'AXPress',
                ...(p.actions ?? ['Open Details', 'Directions · 0 min', 'Remove Friend']).map(custom),
              ],
            });
          })
        : [el('AXButton', `Studio${DOT}This Mac`)];
    const pins = this.people.map((p) => el('AXGenericElement', `${p.name},Map pin`));
    return [
      ...tabs,
      ...rows,
      el('AXImage', 'Avatar', { x: 20, y: 200, w: 48, h: 48 }),
      el('AXImage', 'Map', { x: 600, y: 120, w: 1800, h: 1200 }),
      ...pins,
      el('AXButton', 'Zoom in'),
      el('AXButton', 'Zoom out'),
    ];
  }

  #answer(b: Json): Json {
    const op = String(b.op);
    const ok = (more: Json = {}) => ({ server: 'studio', op, ok: true, ...more });
    const refuse = (code: string, message = '') => ({ server: 'studio', op, ok: false, code, message });
    if (op === 'status')
      return ok({
        status: { sharing: true, account: 'john', sign_in: 'ok', locked: this.locked, w: 3840, h: 2160 },
        helper: {
          installed: true,
          version: this.version,
          running: true,
          ax: this.ax,
          user: 'john',
          ...(this.idle === undefined ? {} : { idle_s: this.idle }),
        },
      });
    if (op === 'unlock') {
      this.locked = false;
      if (this.unlockTimesOut) throw new HostsUnavailable('timeout', 'No answer in time.');
      return ok({ status: { locked: false } });
    }
    if (op === 'keys') {
      if (b.keys === 'ctrl+cmd+q') this.locked = true;
      return ok();
    }
    if (op === 'map.geocode') {
      if (this.geocodeUnsupported) return refuse('unsupported', 'unknown op geocode');
      return ok({ places: (b.queries as string[]).map((q) => this.places[q] ?? null) });
    }
    if (op === 'map.snapshot') {
      const pins = (b.pins as { lat: number; lon: number }[] | undefined) ?? [];
      const scale = Number(b.scale ?? 1);
      return ok({
        image_b64: 'bWFw',
        format: 'jpeg',
        w: Number(b.w) * scale,
        h: Number(b.h) * scale,
        // The last pin falls outside the picture.
        points: pins.map((_, i) =>
          i === pins.length - 1 && pins.length > 1 ? null : { x: 10 + i, y: 20 + i },
        ),
        lat: 52.44,
        lon: 5.18,
        span_m: 30_000,
      });
    }
    if (this.locked && (op.startsWith('ui.') || op === 'look'))
      return refuse('locked', 'The screen is locked.');
    if (op === 'ui.apps')
      return ok({
        apps: [
          { name: 'Finder', bundle_id: 'com.apple.finder', pid: 401, windows: [] },
          ...(this.running
            ? [{ name: 'Find My', bundle_id: 'com.apple.findmy', pid: 900, windows: ['Find My'] }]
            : []),
        ],
      });
    if (op === 'ui.open') {
      if (this.noApp) return refuse('not_found', 'No app called “com.apple.findmy”.');
      if (!this.running) this.#listsSinceOpen = 0;
      this.running = true;
      return ok();
    }
    if (op === 'ui.quit') {
      if (!this.running) return refuse('not_found', 'Find My isn’t running.');
      this.running = false;
      this.#tab = 'Devices';
      this.#chosen = null;
      return ok();
    }
    if (!this.running) return refuse('not_found', 'Find My isn’t running.');
    if (op === 'ui.list') {
      if (this.#listsSinceOpen++ < this.slowLists) return ok({ elements: [] });
      return ok({ elements: this.#elements() });
    }
    if (op === 'ui.press') {
      const name = norm(String(b.name ?? ''));
      const role = b.role === 'radio' ? 'AXRadioButton' : 'AXButton';
      const of = this.#elements().filter((e) => e.role === role);
      const hit =
        of.find((e) => norm(String(e.desc)) === name) ?? of.find((e) => norm(String(e.desc)).includes(name));
      if (!hit) return refuse('not_found', `Nothing called “${String(b.name)}” in Find My.`);
      const desc = String(hit.desc);
      if (role === 'AXRadioButton') {
        this.#tab = desc;
        this.#chosen = null;
      } else {
        const person = this.people.find((p) => desc.startsWith(p.name));
        if (person) this.#chosen = person.name;
      }
      return ok({ element: hit });
    }
    if (op === 'look') {
      const crop = b.crop as { x: number; y: number; w: number; h: number } | undefined;
      const maxW = Number(b.max_w ?? 0);
      const [w, h] = crop && this.crops ? [crop.w, crop.h] : [3840, 2160];
      const outW = maxW > 0 ? Math.min(maxW, w) : w;
      return ok({
        image_b64: 'ZmluZG15',
        format: 'jpeg',
        w: outW,
        h: Math.round((h * outW) / w),
        screen_w: 3840,
        screen_h: 2160,
      });
    }
    return refuse('invalid_request', `Unknown op ${op}.`);
  }
}
