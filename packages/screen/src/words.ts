/**
 * Every word the screen draws itself (the views bring the rest). Plain English, curly quotes, the middle dot; the words
 * Settings shows too (`DESK_SCREEN_WORDS` in core) are the same, which a test keeps so.
 */
export const SCREEN_WORDS = {
  /** Whombat's own widgets, as Settings lists them. */
  own: {
    clock: { name: 'Clock' },
    status: { name: 'How things are' },
    now: { name: 'What’s going on' },
    strip: { name: 'Servers' },
    work: { name: '{assistant}’s work' },
    coming: { name: 'Coming up' },
    done: { name: 'Done today' },
  },
  pill: { one: '1 thing needs you', many: '{n} things need you' },
  locked: { ask: '{assistant} has a question', hidden: 'Unlock to see it' },
  now: {
    doneOne: '{assistant} did 1 thing today',
    doneMany: '{assistant} did {n} things today',
    empty: 'Nothing going on right now',
  },
  strip: { done: '✓ done', next: 'next', more: '+{n}', off: 'off' },
  server: {
    processor: 'Processor',
    memory: 'Memory',
    disk: 'Disk',
    /** The meters' short names, as the server cards wrote them. */
    keys: { cpu: 'CPU', memory: 'MEM', disk: 'DISK' },
    /** Under the big figure of the smallest form. */
    cpu: 'processor',
    chart: 'Processor · {range}',
    ranges: { '1h': '1 h', '24h': '24 h', '7d': '7 d' },
    bad: 'Not answering',
    off: 'Off',
  },
  work: { steps: '{done} of {n} done', now: 'now', next: 'next' },
  done: { empty: 'Nothing done yet today' },
  list: { empty: 'Nothing here right now', count: '{n} in all' },
  modal: {
    since: 'Since {clock} · {ago}',
    asks: '{assistant} asks · {clock}',
    of: '{i} of {n}',
    previous: 'Previous',
    next: 'Next',
    fix: 'Ask {assistant} to fix it',
    open: 'Open {name}',
    answer: 'Answer',
    notNow: 'Not now',
    close: 'Close',
    pin: 'Your PIN first.',
    looking: '{assistant} is looking into it.',
    fixing: '{assistant} is fixing it.',
    fixed: 'Fixed.',
    /** A screen elsewhere never answers or takes a step (DK-138). */
    elsewhereAsk: 'Answer it on your phone, or on Whombat’s own screen.',
    elsewhereLook: 'Fix it from your phone, or on Whombat’s own screen.',
  },
  ago: { now: 'just now', min: '{n} min', hour: '{n} h', hourMin: '{h} h {m} min', day: '{n} d' },
  back: 'Back',
  trying: 'Trying a layout from Settings · {s} s',
  /** A widget taking over for a moment, by why (the contract's `DESK_SCREEN_WORDS.spotlight`). */
  spotlight: { doorbell: 'Someone’s at the door' },
  pages: 'Pages',
  page: '{name}, page {i} of {n}',
  editing: { empty: 'An empty page.', emptyMore: 'Drag widgets here, or press + on one.' },
} as const;

/**
 * A server widget's parts (`opts.show`, DK-153) as *Add a widget* lists them and their views are titled: the runtime's
 * catalogue and the apps' fixture worlds say them alike.
 */
export const SERVER_SHOW_WORDS = {
  overview: { name: 'Overview', line: 'Processor, memory and disk, with a chart when it’s wide' },
  cpu: { name: 'Processor', line: 'How busy it is, now and over time' },
  memory: { name: 'Memory', line: 'How much memory is in use, now and over time' },
  network: { name: 'Network', line: 'What goes in and out, now and over time' },
  storage: { name: 'Storage', line: 'How full each disk and pool is' },
  guests: { name: 'VMs and containers', line: 'What runs on it and how busy it is' },
  temp: { name: 'Temperature', line: 'How hot it runs, its hottest sensor first' },
  alerts: { name: 'Alerts', line: 'What’s wrong with it right now' },
} as const;

/** `text` with each `{key}` replaced. */
export function fillWords(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));
}

/** How long ago, as the modal's “since” says it: “4 min”, “2 h 10 min”, “3 d”. */
export function agoText(sinceMs: number, nowMs: number): string {
  const min = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
  if (min < 1) return SCREEN_WORDS.ago.now;
  if (min < 60) return fillWords(SCREEN_WORDS.ago.min, { n: min });
  const h = Math.floor(min / 60);
  if (h < 24)
    return min % 60 === 0
      ? fillWords(SCREEN_WORDS.ago.hour, { n: h })
      : fillWords(SCREEN_WORDS.ago.hourMin, { h, m: min % 60 });
  return fillWords(SCREEN_WORDS.ago.day, { n: Math.floor(h / 24) });
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(timeZone: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone ?? ''}|${JSON.stringify(opts)}`;
  let f = formats.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone });
    } catch {
      // An unknown zone draws the device's own time rather than nothing.
      f = new Intl.DateTimeFormat('en-GB', opts);
    }
    formats.set(key, f);
  }
  return f;
}

/** “14:34”, in the Whombat's time zone. */
export function clockText(ms: number, timeZone?: string): string {
  return format(timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}

/** “Tuesday 27 October”. */
export function dateText(ms: number, timeZone?: string): string {
  const parts = format(timeZone, { weekday: 'long', day: 'numeric', month: 'long' }).formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}`;
}
