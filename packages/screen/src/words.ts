import { EN, NL, resolveScreenLanguage, screenFormatLocale } from './i18n/catalog';

type Word = (key: keyof typeof EN) => string;

/**
 * Every word the screen draws itself (the views bring the rest). Plain English, curly quotes, the middle dot; the words
 * Settings shows too (`DESK_SCREEN_WORDS` in core) are the same, which a test keeps so.
 */
function screenCatalog(word: Word) {
  return {
    /** Whombat's own widgets, as Settings lists them. */
    own: {
      clock: { name: word('own.clock.name') },
      status: { name: word('own.status.name') },
      now: { name: word('own.now.name') },
      strip: { name: word('own.strip.name') },
      work: { name: word('own.work.name') },
      coming: { name: word('own.coming.name') },
      done: { name: word('own.done.name') },
      weather: { name: word('own.weather.name') },
      news: { name: word('own.news.name') },
    },
    widget: {
      server: word('widget.server'),
      figures: word('widget.figures'),
      panel: word('widget.panel'),
      widget: word('widget.widget'),
    },
    pill: { one: word('pill.one'), many: word('pill.many') },
    locked: { ask: word('locked.ask'), hidden: word('locked.hidden') },
    now: {
      doneOne: word('now.doneOne'),
      doneMany: word('now.doneMany'),
      empty: word('now.empty'),
    },
    strip: {
      done: word('strip.done'),
      next: word('strip.next'),
      more: word('strip.more'),
      off: word('strip.off'),
    },
    server: {
      processor: word('server.processor'),
      memory: word('server.memory'),
      disk: word('server.disk'),
      /** The meters' short names, as the server cards wrote them. */
      keys: {
        cpu: word('server.keys.cpu'),
        memory: word('server.keys.memory'),
        disk: word('server.keys.disk'),
      },
      /** Under the big figure of the smallest form. */
      cpu: word('server.cpu'),
      chart: word('server.chart'),
      ranges: {
        '1h': word('server.ranges.1h'),
        '24h': word('server.ranges.24h'),
        '7d': word('server.ranges.7d'),
      },
      bad: word('server.bad'),
      off: word('server.off'),
    },
    work: { steps: word('work.steps'), now: word('work.now'), next: word('work.next') },
    done: { empty: word('done.empty') },
    list: { empty: word('list.empty'), count: word('list.count') },
    /** The weather widget's own words (the forecast's own come in its view: the place, what the sky does, the credit). */
    weather: {
      now: word('weather.now'),
      today: word('weather.today'),
      highLow: word('weather.highLow'),
      short: word('weather.short'),
      feels: word('weather.feels'),
      rain: word('weather.rain'),
      rainChance: word('weather.rainChance'),
      sun: word('weather.sun'),
      polarDay: word('weather.polarDay'),
      polarNight: word('weather.polarNight'),
      /** Core `WEATHER_WORDS`, kept equal by a test. */
      problem: word('weather.problem'),
      noPlace: word('weather.noPlace'),
    },
    /** The news widget's (core `NEWS_WORDS`, kept equal by a test). */
    news: { empty: word('news.empty'), problem: word('news.problem') },
    modal: {
      since: word('modal.since'),
      asks: word('modal.asks'),
      of: word('modal.of'),
      previous: word('modal.previous'),
      next: word('modal.next'),
      fix: word('modal.fix'),
      open: word('modal.open'),
      answer: word('modal.answer'),
      notNow: word('modal.notNow'),
      close: word('modal.close'),
      pin: word('modal.pin'),
      looking: word('modal.looking'),
      fixing: word('modal.fixing'),
      fixed: word('modal.fixed'),
      /** A screen elsewhere never answers or takes a step (DK-138). */
      elsewhereAsk: word('modal.elsewhereAsk'),
      elsewhereLook: word('modal.elsewhereLook'),
    },
    ago: {
      now: word('ago.now'),
      min: word('ago.min'),
      hour: word('ago.hour'),
      hourMin: word('ago.hourMin'),
      day: word('ago.day'),
    },
    back: word('back'),
    trying: word('trying'),
    /** A widget taking over for a moment, by why (the contract's `DESK_SCREEN_WORDS.spotlight`). */
    spotlight: { doorbell: word('spotlight.doorbell') },
    pages: word('pages'),
    page: word('page'),
    editing: { empty: word('editing.empty'), emptyMore: word('editing.emptyMore') },
  } as const;
}

/**
 * A server widget's parts (`opts.show`, DK-153) as *Add a widget* lists them and their views are titled: the runtime's
 * catalogue and the apps' fixture worlds say them alike.
 */
function serverShowCatalog(word: Word) {
  return {
    overview: { name: word('serverShow.overview.name'), line: word('serverShow.overview.line') },
    cpu: { name: word('serverShow.cpu.name'), line: word('serverShow.cpu.line') },
    memory: { name: word('serverShow.memory.name'), line: word('serverShow.memory.line') },
    network: { name: word('serverShow.network.name'), line: word('serverShow.network.line') },
    storage: { name: word('serverShow.storage.name'), line: word('serverShow.storage.line') },
    guests: { name: word('serverShow.guests.name'), line: word('serverShow.guests.line') },
    temp: { name: word('serverShow.temp.name'), line: word('serverShow.temp.line') },
    alerts: { name: word('serverShow.alerts.name'), line: word('serverShow.alerts.line') },
  } as const;
}

const english: Word = (key) => EN[key];
const dutch: Word = (key) => NL[key] ?? EN[key];

export const SCREEN_WORDS = screenCatalog(english);
export const SERVER_SHOW_WORDS = serverShowCatalog(english);
const dutchScreen = screenCatalog(dutch);
const dutchServerShow = serverShowCatalog(dutch);

export function screenWords(locale?: string | null): typeof SCREEN_WORDS {
  return resolveScreenLanguage(locale) === 'nl' ? dutchScreen : SCREEN_WORDS;
}

export function serverShowWords(locale?: string | null): typeof SERVER_SHOW_WORDS {
  return resolveScreenLanguage(locale) === 'nl' ? dutchServerShow : SERVER_SHOW_WORDS;
}

/** `text` with each `{key}` replaced. */
export function fillWords(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));
}

/** How long ago, as the modal's “since” says it: “4 min”, “2 h 10 min”, “3 d”. */
export function agoText(sinceMs: number, nowMs: number, locale?: string | null): string {
  const words = screenWords(locale).ago;
  const min = Math.max(0, Math.floor((nowMs - sinceMs) / 60_000));
  if (min < 1) return words.now;
  if (min < 60) return fillWords(words.min, { n: min });
  const h = Math.floor(min / 60);
  if (h < 24)
    return min % 60 === 0 ? fillWords(words.hour, { n: h }) : fillWords(words.hourMin, { h, m: min % 60 });
  return fillWords(words.day, { n: Math.floor(h / 24) });
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(
  locale: string | null | undefined,
  timeZone: string | undefined,
  opts: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const tag = screenFormatLocale(locale);
  const key = `${tag}|${timeZone ?? ''}|${JSON.stringify(opts)}`;
  let f = formats.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(tag, { ...opts, timeZone });
    } catch {
      // An unknown zone draws the device's own time rather than nothing.
      f = new Intl.DateTimeFormat(tag, opts);
    }
    formats.set(key, f);
  }
  return f;
}

/** “14:34”, in the Whombat's time zone. */
export function clockText(ms: number, timeZone?: string, locale?: string | null): string {
  return format(locale, timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}

/** A forecast's day (`YYYY-MM-DD`, the place's own) by its short name: “Wed”. */
export function weekdayText(date: string, locale?: string | null): string {
  const ms = Date.parse(`${date}T12:00:00Z`);
  return Number.isNaN(ms) ? date : format(locale, 'UTC', { weekday: 'short' }).format(ms);
}

/** “Tuesday 27 October”. */
export function dateText(ms: number, timeZone?: string, locale?: string | null): string {
  const parts = format(locale, timeZone, { weekday: 'long', day: 'numeric', month: 'long' }).formatToParts(
    ms,
  );
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}`;
}

const numbers = new Map<string, Intl.NumberFormat>();

/** A compact number for meters or weather, with the locale's decimal separator. */
export function screenNumberText(value: number, locale?: string | null): string {
  const tag = screenFormatLocale(locale);
  if (tag === 'en-GB') return String(value);
  let formatter = numbers.get(tag);
  if (!formatter) {
    formatter = new Intl.NumberFormat(tag, { useGrouping: false, maximumFractionDigits: 20 });
    numbers.set(tag, formatter);
  }
  return formatter.format(value);
}
