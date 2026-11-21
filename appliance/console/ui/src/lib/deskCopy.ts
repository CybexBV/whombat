/**
 * The desk display's words (Whombat desk-display.md DK-13; appliance CG-40). `DESK_WORDS` are the contracts' shared
 * words (`@whombat/core` domain/desk.ts `DESK_WORDS`, contracts 0.123.0), the part the page shows, copied with the same
 * keys and `{holes}` because the page can't import the contracts; `deskCopy.test.ts` checks every one against the
 * contracts' source (`vendor/whombat-contracts/desk.ts`; `tasks` against task-card.ts, where desk.ts takes them). `DESK` are the page's own, in the same voice: short, plain,
 * the assistant in the first person, curly quotes, `·`, `…`. The assistant's real name always comes from the runtime.
 */
import type { DeskPhoneReason, DeskPower, GuestState, LookKind, TaskState } from './desk';

const NBSP = ' ';

/**
 * The screen of widgets' words the page says itself (copied from `DESK_SCREEN_WORDS`, `@whombat/core`
 * domain/desk-screens.ts, 3.6; checked by deskCopy.test.ts): the drawing (`@whombat/screen`) has its own.
 */
export const SCREEN_WORDS = {
  pill: { one: '1 thing needs you', many: '{n} things need you' },
  locked: { ask: '{assistant} has a question', hidden: 'Unlock to see it' },
};

/** The contracts' words (copied). */
export const DESK_WORDS = {
  locked: 'Locked · touch to use',
  unlockedAs: 'Unlocked as {name} · locks in {n} min',
  /** While the camera sees someone (DK-28). */
  unlockedHere: 'Unlocked as {name} · stays unlocked while you’re here',
  /** The camera mark's label (DK-30). */
  cameraOn: 'The camera is on while the screen is unlocked',
  /** Unlocked until Lock (DK-74): no minutes. */
  unlockedStays: 'Unlocked as {name}',
  /** The camera mark on the glance and the clock while the camera looks for someone (DK-73). */
  cameraLooking: 'The camera is on to see when you’re here',
  lock: 'Lock',
  needsYou: 'Needs you',
  touchToAnswer: 'Touch to answer',
  workingOn: 'Working on',
  doneToday: 'Done today',
  steps: { done: 'Done', now: 'Now', next: 'Next' },
  cpu: 'CPU',
  memory: 'Memory',
  temp: 'Temp',
  moreServers: '+{n} more',
  /** A server card's three lines (0.115, DK-80); `open` is the card's button label (DK-83). */
  card: { cpu: 'CPU', memory: 'MEM', disk: 'DISK', none: '–', open: 'Open {name}' },
  /** Every server (DK-86); “+N more” under the glance's cards stays `moreServers`. */
  servers: { title: 'Servers', more: '{n} more in the app' },
  /** A server's own screen (DK-83…DK-85); its network line and the chart's scale are `box.network` and `box.scale`. */
  server: {
    back: 'Back',
    allFine: 'All fine',
    cores: '{n} cores',
    coresOne: '1 core',
    cpu: 'CPU',
    load: 'load {n}',
    memory: 'Memory',
    memoryOf: 'of {total}',
    disk: 'Disk',
    diskOf: '{used} of {total}',
    temperature: 'Temperature',
    tempNote: '{tone} · limit {n}°',
    ranges: { '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days' },
    rangeChips: { '1h': '1 h', '24h': '24 h', '7d': '7 d' },
    /** The chart's first time on 24 hours. */
    yesterday: 'yesterday {time}',
    cpuPeak: `CPU · peak {n}${NBSP}% at {time}`,
    memoryAvg: `Memory · avg {n}${NBSP}%`,
    storage: 'Storage',
    guests: 'Guests',
    guestsCount: '{running} running · {off} off',
    /** A guest's dot's label, and the word a guest shows without a processor figure. */
    guestStates: {
      running: 'running',
      stopped: 'off',
      unhealthy: 'needs a look',
      paused: 'paused',
    } satisfies Record<GuestState, string>,
    alertsOne: '1 thing to look at',
    alertsMany: '{n} things to look at',
    ask: 'Ask {assistant} about {server}',
    off: '{server} is off.',
    unavailable: 'I can’t reach your servers right now.',
    noFigures: 'No figures yet.',
  },
  status: {
    fine: 'Everything’s fine.',
    needsYouOne: '1 thing needs you.',
    needsYouMany: '{n} things need you.',
    look: '{server} needs a look.',
    down: '{server} is down.',
    /** The assistant's line for the first ask (DK-94). */
    decision: '{title} needs a decision.',
    allFine: 'All fine.',
    somethingNeedsYou: 'Something needs you.',
    /** A new box: nothing to show yet but itself (DK-23). */
    ready: 'All fine. I’m ready when you are.',
    connectHint: 'Connect a server or your home, and I’ll keep an eye on it here.',
  },
  nothingNeedsYou: 'Nothing needs you.',
  nothingNeedsYouHint: 'When I need a decision, it shows here.',
  /**
   * What needs a look (0.118, DK-93…DK-96): its title is `status.down` or `status.look`; `offer` follows it on the
   * assistant's line; the card's `noticed`, `kinds`, `noReason`, `fix`, `open` and `fine`; `question` what *Ask
   * {assistant} to look into it* sends when the look has no question of its own. 0.122 (QN-20): `fix` asks the
   * assistant to look into it (a problem only); `ignore` and `notNow` quiet the look, then the card says `ignored` or
   * `snoozed`.
   */
  looks: {
    offer: 'Shall I look into it?',
    noticed: '{assistant} noticed',
    kinds: {
      server: 'A server',
      connection: 'A connection',
      device: 'A device',
    } satisfies Record<LookKind, string>,
    noReason: 'I don’t know why yet.',
    fix: 'Ask {assistant} to look into it',
    open: 'Open {name}',
    fine: 'It looks fine again.',
    question: 'Please take a look at {name}: {reason}.',
    questionBare: 'Please take a look at {name}.',
    ignore: 'Ignore',
    notNow: 'Not now',
    ignored: 'Ignored. You’ll hear if it changes.',
    snoozed: 'I’ll remind you tomorrow.',
    /** What the assistant found out (3.5, CG-374): while it finds out, while it takes the step, Ask once it said. */
    looking: 'I’m looking into it.',
    lookingSoFar: 'I’m looking into it. So far: {reason}.',
    fixing: 'I’m on it.',
    ask: 'Ask {assistant}',
  },
  /** This Whombat (DK-22): `free` and `used` hold the unit and the number the page draws big. */
  box: {
    title: 'This Whombat',
    lastHour: 'Last hour',
    processor: 'Processor · {n} cores',
    memory: 'Memory · of {total}',
    storage: 'Storage',
    free: '{unit} free',
    used: `{n}${NBSP}% used`,
    ofTotal: 'of {total}',
    temperature: 'Temperature',
    tempNote: 'Processor · {tone}',
    tones: { ok: 'cool', warn: 'warm', bad: 'hot' },
    network: 'Network ↓ {down} · ↑ {up}',
    hourAgo: '1 h ago',
    now: 'now',
    scale: `{n}${NBSP}%`,
    hint: 'Your servers and home show here once you connect them.',
    /** The agent's part is its name (`{assistant}`, CT-1140). */
    parts: { whombat: 'Whombat', agent: '{assistant}' },
  },
  asks: '{assistant} asks',
  notNow: 'Not now',
  ask: 'Ask',
  approve: 'Approve',
  onPhone: 'Answer this on your phone.',
  /** 0.108 (DK-61, DK-62). */
  deny: 'Deny',
  approveWithPin: 'Type your PIN to approve this.',
  approveOnPhone: 'Approve this on your phone.',
  /** 0.116 (TF-14): the PIN pad's line for one of an ask's wider choices, and the words for `not_offered`. */
  choiceWithPin: 'Type your PIN for “{choice}”.',
  notOffered: 'That choice isn’t available here any more.',
  phoneReasons: {
    money: 'It’s about money.',
    release: 'It deploys or changes main.',
    delete: 'It deletes something.',
    keys: 'It gives {assistant} a key.',
    outside: 'It reaches people outside.',
  } satisfies Record<DeskPhoneReason, string>,
  unlockAs: 'Unlock as {name}',
  confirmOnPhone: 'Confirm on your phone',
  orConfirmOnPhone: 'or confirm on your phone',
  /** No PIN chosen yet (DK-18): the pad has only the phone. */
  noPinYet: 'Choose a PIN in Settings to unlock here.',
  checkPhone: 'Check your phone',
  phoneSaidNo: 'Not unlocked.',
  wrongPin: 'Wrong PIN. {n} tries left.',
  wrongPinOne: 'Wrong PIN. 1 try left.',
  tooManyPins: 'Too many wrong PINs. Try again in {m} min.',
  cancel: 'Cancel',
  delete: 'Delete',
  pairThisScreen: 'Pair this screen',
  pairHint: 'Type these letters in Settings → Screen.',
  typeToAsk: 'Type to ask {assistant}',
  /** 3.3 (CG-359): Talk's mic is voice typing, its recording bar in the composers' words. */
  tapToTalk: 'Tap to talk',
  wordsFirst: 'You see the words before they’re sent',
  dictation: {
    cancel: 'Cancel',
    done: 'Done',
    preparing: 'Starting…',
    recording: 'Recording {time}',
    transcribing: 'Turning speech into text…',
    send: 'Send',
    nothing: 'Nothing was heard.',
    busy: 'This Whombat is busy with another recording. Try again in a moment.',
    badAudio: 'That recording didn’t work. Try again.',
    tooLong: 'That was longer than 5 minutes. Try a shorter one.',
    failed: 'Couldn’t turn that into text. Try again.',
  },
  listening: 'Listening…',
  thinking: 'Thinking…',
  youAsked: 'You asked',
  onThisWhombat: 'Heard and spoken on this Whombat',
  notHeard: 'I didn’t catch that. Try again?',
  slow: '{assistant} is still working on it. The answer will be in Chat.',
  /** 0.116 (TF-16, TF-17): a talk that is working, and the conversation's working row without a `doing`. */
  working: '{assistant} is working on it…',
  /** 0.116 (TF-17): a task row's state (core's `TASK_CARD_WORDS.states`). */
  tasks: {
    running: 'Running',
    ok: 'Done',
    warning: 'Done with warnings',
    error: 'Didn’t work',
    lost: 'Lost track',
  } satisfies Record<TaskState, string>,
  voiceUnavailable: 'Talking doesn’t work right now. You can type instead.',
  talkFailed: 'That didn’t work. Try again?',
  /**
   * The calm glance (3.2, CG-352; DK-101…DK-124): the hero's buttons and age, the strip's work words, Welcome back, the
   * top bar's chips and its sheet, and *Try it on the screen*'s banner. The sentence by the clock and the rest of the
   * words come from the runtime.
   */
  calm: {
    since: 'Since {clock} · {ago}',
    fix: 'Ask {assistant} to fix it',
    open: 'Open {name}',
    answer: 'Answer',
    notNow: 'Not now',
    /** A looked-into look's hero offers Ignore where it offered Not now (3.5, CG-374). */
    ignore: 'Ignore',
    look: 'Look',
    moreNeeds: '+{n} more',
    now: 'Now',
    doneOne: '{assistant} did 1 thing today',
    doneMany: '{assistant} did {n} things today',
    pinned: 'Pinned',
    strip: {
      done: '✓ done',
      next: 'next',
      more: '+{n}',
    },
    welcome: {
      title: 'Welcome back.',
      away: 'You were away for {time}. Meanwhile:',
      back: 'Back to the glance in a minute',
    },
    bar: {
      cable: 'Cable',
      noNetwork: 'No network',
      online: 'Online',
      offline: 'No internet',
      remoteOn: 'Remote help on',
      remoteLive: 'Support is connected',
      updates: {
        downloading: 'Getting an update',
        installing: 'Updating',
        restarting: 'Restarting',
      },
      charge: `{n}${NBSP}%`,
      onBattery: 'On battery · {time}',
      onBatteryNoTime: `On battery · {n}${NBSP}%`,
      low: `{n}${NBSP}% · plug me in`,
    },
    sheet: {
      title: 'This Whombat',
      network: 'Network',
      internet: 'Internet',
      battery: 'Battery',
      remoteHelp: 'Remote help',
      updates: 'Updates',
      close: 'Close',
    },
    sample: 'Preview from Settings',
  },
  power: {
    pluggedKept: `Plugged in · battery kept at {n}${NBSP}%`,
    pluggedCharging: `Plugged in · charging · {n}${NBSP}%`,
    plugged: `Plugged in · {n}${NBSP}%`,
    onBattery: `On battery · {n}${NBSP}% · about {time} left`,
    onBatteryNoTime: `On battery · {n}${NBSP}%`,
    outSince: 'The power has been out since {clock}.',
    outBanner: `Whombat is on battery, about {time} left. {assistant} shuts it down safely at 10${NBSP}%.`,
    outBannerNoTime: `Whombat is on battery. {assistant} shuts it down safely at 10${NBSP}%.`,
  },
  settings: {
    talkTo: 'Talk to {assistant}',
  },
} as const;

/** The page's own words. */
export const DESK = {
  /** A monitor's lock, which it only shows (the box's own display has the chip that locks). */
  monitorLocked: 'Locked',
  monitorUnlocked: 'Unlocked',
  more: 'and {n} more',
  answer: 'Answer',
  close: 'Close',
  back: 'Back',
  alreadyAnswered: 'This was answered somewhere else.',
  /** Under a locked ask's title beside the PIN pad (CG-50). */
  unlockToAnswer: 'Unlock to see what happens and answer.',
  /** A locked question's button in the screen of widgets' pop-up (CG-397). */
  unlockButton: 'Unlock',
  phoneHow: 'Tap Unlock on your phone.',
  wrongPin: 'Wrong PIN.',
  powerOut: 'The power is out.',
  /** Before the m:ss countdown of the pairing letters. */
  pairFor: 'They work for another',
  talkPrompt: 'What can I do for you?',
  talkMicrophone: 'The microphone isn’t working. You can type instead.',
  talkBusy: 'I’m still on your last question.',
  playAgain: 'Play the answer again',
  /* Asks that come to you (DK-60, CG-194). */
  /** Beside the PIN pad when a new ask arrived on a screen that shows no titles while locked. */
  needsAnswer: '{assistant} needs your answer.',
  /** The card's place among the ones that came: “2 of 3”. */
  askOf: '{n} of {m}',
  /* Talk as a conversation (DK-63, DK-64, CG-196). */
  closeConversation: 'Close conversation',
  newMessage: 'New message',
  moreInChat: 'There’s more of this in Chat.',
  earlierInChat: 'Earlier messages are in Chat.',
  askWaiting: 'Waiting for you',
  askApproved: 'Approved',
  askDenied: 'Denied',
  you: 'You',
  /** Under a server's screen when there are too many servers for its dots: “5 of 24” (DK-83, CG-262). */
  serverOf: '{n} of {m}',
  /** The conversation's working row when the runtime says what the assistant is doing (TF-17, CG-285). */
  workingDoing: '{assistant} is working… · {doing}',
  /* Quieting a look (QN-20, CG-333, CG-334). */
  /** The assistant's line after an only-you look's title: it can't look into it. */
  youOffer: 'Only you can sort this out.',
  /** `not_allowed`: the paired person may not manage the thing. */
  lookNotAllowed: 'Only someone who manages {name} can do that.',
  /** `not_found`: the look or its line went while the card was open. */
  lookChanged: 'This changed in the meantime.',
} as const;

/**
 * Found on your network (Whombat desk-found.md DF-09, verbatim; CG-231): the assistant's line, the panel's and the
 * strip's words. `{app}` is the console's `appUrl`, drawn in the mono face between `before` and `after`.
 */
export const FOUND = {
  /** The assistant's line while the first scan looks (DF-07), bold, then the muted part. */
  looking: 'I’m looking around your network.',
  lookingNone: 'Things I can look after show up here.',
  lookingSome: '{n} found so far.',
  /** Done: what it found. */
  foundMany: 'I found {n} things I can look after.',
  foundManyMore: 'Connect the ones you want, and I’ll keep an eye on them here.',
  foundOne: 'I found one thing I can look after.',
  foundOneMore: 'Connect it, and I’ll keep an eye on it here.',
  title: 'Found on your network',
  /** The panel's head on the right. */
  progress: 'Looked at {done} of {total} addresses',
  found: '{n} found · {ago}',
  /** A result without its time (never from Whombat, which sends `finishedAt` with every result). */
  foundCount: '{n} found',
  /** The panel's footer: “Connect them on your computer: app.whombat.com → Connections”. */
  connectMany: { before: 'Connect them on your computer: ', after: ' → Connections' },
  connectOne: { before: 'Connect it on your computer: ', after: ' → Connections' },
  notNow: 'Not now',
  /** The strip beside servers and tiles (DF-06). */
  stripTitle: 'Still on your network',
  stripMore: '+{k} more',
  stripConnect: { before: 'Connect on ', after: '' },
} as const;

/** A narrow no-break space: the thin space between a number's groups of three (“1 022”), never broken (CG-231). */
const THIN = ' ';

/** “412”, “1 022”, “12 345”: whole numbers grouped by thousands with a thin space (DF-09). */
export function grouped(n: number): string {
  const s = String(Math.max(0, Math.round(Number.isFinite(n) ? n : 0)));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
}

/** What the found view says (DF-09): looking (the first scan, DF-07) or done, how many, and since when. */
export interface FoundSay {
  text: string;
  more: string;
}

/**
 * The assistant's line for what it found (DF-09): while the first scan looks, “I’m looking around your network.” with
 * how many so far; after it, what it found, one or many.
 */
export function foundSay(found: { progress: unknown; count: number }): FoundSay {
  if (found.progress)
    return {
      text: FOUND.looking,
      more: found.count > 0 ? fill(FOUND.lookingSome, { n: grouped(found.count) }) : FOUND.lookingNone,
    };
  return found.count === 1
    ? { text: FOUND.foundOne, more: FOUND.foundOneMore }
    : { text: fill(FOUND.foundMany, { n: grouped(found.count) }), more: FOUND.foundManyMore };
}

/** The panel's head on the right: “Looked at 412 of 1 022 addresses”, else “8 found · just now”. */
export function foundHead(
  found: { progress: { done: number; total: number } | null; count: number; finishedAt: string | null },
  now: number,
): string {
  if (found.progress)
    return fill(FOUND.progress, {
      done: grouped(found.progress.done),
      total: grouped(found.progress.total),
    });
  const n = grouped(found.count);
  return found.finishedAt
    ? fill(FOUND.found, { n, ago: ago(found.finishedAt, now) })
    : fill(FOUND.foundCount, { n });
}

/** Fills `{name}`-style holes (the contracts' `fillDeskWords`); a hole without a value stays as it is. */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([a-z]+)\}/g, (hole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : hole,
  );
}

/**
 * The unlocked chip's words (DK-04, DK-28, DK-74): “Unlocked as John · locks in 2 min”; while the camera sees someone
 * “Unlocked as John · stays unlocked while you’re here”; unlocked until Lock (`minutes` null) “Unlocked as John”.
 */
export function unlockedText(name: string, minutes: number | null, present: boolean): string {
  if (minutes === null) return fill(DESK_WORDS.unlockedStays, { name });
  return present
    ? fill(DESK_WORDS.unlockedHere, { name })
    : fill(DESK_WORDS.unlockedAs, { name, n: minutes });
}

/** “Wrong PIN. 3 tries left.”, “Wrong PIN. 1 try left.” (the contracts' `deskWrongPinText`). */
export function wrongPinText(triesLeft: number): string {
  return triesLeft === 1 ? DESK_WORDS.wrongPinOne : fill(DESK_WORDS.wrongPin, { n: triesLeft });
}

/** “3 h 10 min”, “45 min”, “2 h”. */
export function duration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r} min`;
  return r === 0 ? `${h} h` : `${h} h ${r} min`;
}

/** The power chip in the top bar (DK-10): the contracts' short lines. */
export function powerChip(p: DeskPower): string {
  const w = DESK_WORDS.power;
  if (p.source === 'battery') {
    return p.minutesLeft === null
      ? fill(w.onBatteryNoTime, { n: p.percent })
      : fill(w.onBattery, { n: p.percent, time: duration(p.minutesLeft) });
  }
  if (p.charging) return fill(w.pluggedCharging, { n: p.percent });
  if (p.chargeLimit !== null && p.chargeLimit < 100) return fill(w.pluggedKept, { n: p.chargeLimit });
  return fill(w.plugged, { n: p.percent });
}

/** The on-battery banner (mockup 4): a strong first sentence, then the time left and the clean shutdown. */
export function powerBanner(
  p: DeskPower,
  assistant: string,
  timeZone: string,
): { lead: string; rest: string } | null {
  if (p.source !== 'battery') return null;
  const w = DESK_WORDS.power;
  const since = p.since ? Date.parse(p.since) : Number.NaN;
  return {
    lead: Number.isFinite(since) ? fill(w.outSince, { clock: clockText(since, timeZone) }) : DESK.powerOut,
    rest:
      p.minutesLeft === null
        ? fill(w.outBannerNoTime, { assistant })
        : fill(w.outBanner, { assistant, time: duration(p.minutesLeft) }),
  };
}

const formats = new Map<string, Intl.DateTimeFormat>();
function format(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let f = formats.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-GB', { ...options, timeZone });
    } catch {
      f = new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' });
    }
    formats.set(key, f);
  }
  return f;
}

/** “14:34” in the paired person's time zone, 24 hours. */
export function clockText(ms: number, timeZone: string): string {
  return format(timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}

/** “Tue”: a day on the week's chart (DK-83). */
export function weekdayText(ms: number, timeZone: string): string {
  return format(timeZone, { weekday: 'short' }).format(ms);
}

/** The hour and minute on the person's clock (24 hours). */
export function localTime(ms: number, timeZone: string): { hour: number; minute: number } {
  const parts = format(timeZone, { hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(ms);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { hour: n('hour'), minute: n('minute') };
}

/** “Tuesday 20 October”. */
export function dateText(ms: number, timeZone: string): string {
  return format(timeZone, { weekday: 'long', day: 'numeric', month: 'long' }).format(ms);
}

/** “3 min ago” (`long`: “3 minutes ago”), “2 h ago”, “just now”. */
export function ago(at: string, now: number, long = false): string {
  const t = Date.parse(at);
  const min = Number.isFinite(t) ? Math.floor((now - t) / 60_000) : 0;
  if (min < 1) return 'just now';
  if (min < 60) return long ? `${min} ${min === 1 ? 'minute' : 'minutes'} ago` : `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return long ? `${h} ${h === 1 ? 'hour' : 'hours'} ago` : `${h} h ago`;
  const d = Math.floor(h / 24);
  return long ? `${d} ${d === 1 ? 'day' : 'days'} ago` : `${d} d ago`;
}

/** “18 %” (a no-break space, never split from its number, as the contracts' power words). */
export const percent = (v: number) => `${Math.round(v)}${NBSP}%`;
/** “46°”. */
export const degrees = (v: number) => `${Math.round(v)}°`;
