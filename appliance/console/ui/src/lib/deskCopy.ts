/**
 * The desk display's words (Whombat desk-display.md DK-13; appliance CG-40). `DESK_WORDS` are the contracts' shared
 * words (`@whombat/core` domain/desk.ts `DESK_WORDS`, contracts 0.123.0), the part the page shows, copied with the same
 * keys and `{holes}` because the page can't import the contracts; `deskCopy.test.ts` checks every one against the
 * contracts' source (`vendor/whombat-contracts/desk.ts`; `tasks` against task-card.ts, where desk.ts takes them). `DESK` are the page's own, in the same voice: short, plain,
 * the assistant in the first person, curly quotes, `·`, `…`. The assistant's real name always comes from the runtime.
 */

import { formatLocale } from '../i18n/locale';
import { english, localized, type Translate } from '../i18n/translate';
import type { DeskPhoneReason, DeskPower, GuestState, LookKind, TaskState } from './desk';

const NBSP = ' ';

/**
 * The screen of widgets' words the page says itself (copied from `DESK_SCREEN_WORDS`, `@whombat/core`
 * domain/desk-screens.ts, 3.6; checked by deskCopy.test.ts): the drawing (`@whombat/screen`) has its own.
 */
export const screenWordsCopy = localized((t) => ({
  pill: { one: t('desk.screen.pill.one'), many: t('desk.screen.pill.many') },
  locked: { ask: t('desk.screen.locked.ask'), hidden: t('desk.screen.locked.hidden') },
}));
export const SCREEN_WORDS = screenWordsCopy();

/** The contracts' words (copied). */
export const deskWordsCopy = localized(
  (t) =>
    ({
      locked: t('desk.locked'),
      unlockedAs: t('desk.unlockedAs'),
      /** While the camera sees someone (DK-28). */
      unlockedHere: t('desk.unlockedHere'),
      /** The camera mark's label (DK-30). */
      cameraOn: t('desk.cameraOn'),
      /** Unlocked until Lock (DK-74): no minutes. */
      unlockedStays: t('desk.unlockedStays'),
      /** The camera mark on the glance and the clock while the camera looks for someone (DK-73). */
      cameraLooking: t('desk.cameraLooking'),
      lock: t('desk.lock'),
      needsYou: t('desk.needsYou'),
      touchToAnswer: t('desk.touchToAnswer'),
      workingOn: t('desk.workingOn'),
      doneToday: t('desk.doneToday'),
      steps: { done: t('bluetooth.done'), now: t('desk.steps.now'), next: t('desk.steps.next') },
      cpu: 'CPU',
      memory: t('installer.check.memory'),
      temp: t('desk.temp'),
      moreServers: t('desk.moreServers'),
      /** A server card's three lines (0.115, DK-80); `open` is the card's button label (DK-83). */
      card: {
        cpu: 'CPU',
        memory: t('desk.card.memory'),
        disk: t('desk.card.disk'),
        none: '–',
        open: t('desk.card.open'),
      },
      /** Every server (DK-86); “+N more” under the glance's cards stays `moreServers`. */
      servers: { title: t('desk.servers.title'), more: t('desk.servers.more') },
      /** A server's own screen (DK-83…DK-85); its network line and the chart's scale are `box.network` and `box.scale`. */
      server: {
        back: t('bluetooth.back'),
        allFine: t('desk.server.allFine'),
        cores: t('desk.server.cores'),
        coresOne: t('desk.server.coresOne'),
        cpu: 'CPU',
        load: t('desk.server.load'),
        memory: t('installer.check.memory'),
        memoryOf: t('desk.server.memoryOf'),
        disk: t('installer.check.disk'),
        diskOf: t('desk.server.diskOf'),
        temperature: t('desk.server.temperature'),
        tempNote: t('desk.server.tempNote'),
        ranges: {
          '1h': t('desk.server.ranges.1h'),
          '24h': t('desk.server.ranges.24h'),
          '7d': t('desk.server.ranges.7d'),
        },
        rangeChips: {
          '1h': t('desk.server.rangeChips.1h'),
          '24h': t('desk.server.rangeChips.24h'),
          '7d': t('desk.server.rangeChips.7d'),
        },
        /** The chart's first time on 24 hours. */
        yesterday: t('desk.server.yesterday'),
        cpuPeak: t('desk.server.cpuPeak'),
        memoryAvg: t('desk.server.memoryAvg'),
        storage: t('desk.server.storage'),
        guests: t('desk.server.guests'),
        guestsCount: t('desk.server.guestsCount'),
        /** A guest's dot's label, and the word a guest shows without a processor figure. */
        guestStates: {
          running: t('desk.server.guestStates.running'),
          stopped: t('desk.server.guestStates.stopped'),
          unhealthy: t('desk.server.guestStates.unhealthy'),
          paused: t('desk.server.guestStates.paused'),
        } satisfies Record<GuestState, string>,
        alertsOne: t('desk.server.alertsOne'),
        alertsMany: t('desk.server.alertsMany'),
        ask: t('desk.server.ask'),
        off: t('desk.server.off'),
        unavailable: t('desk.server.unavailable'),
        noFigures: t('desk.server.noFigures'),
      },
      status: {
        fine: t('desk.status.fine'),
        needsYouOne: t('desk.status.needsYouOne'),
        needsYouMany: t('desk.status.needsYouMany'),
        look: t('desk.status.look'),
        down: t('desk.status.down'),
        /** The assistant's line for the first ask (DK-94). */
        decision: t('desk.status.decision'),
        allFine: t('desk.status.allFine'),
        somethingNeedsYou: t('desk.status.somethingNeedsYou'),
        /** A new box: nothing to show yet but itself (DK-23). */
        ready: t('desk.status.ready'),
        connectHint: t('desk.status.connectHint'),
      },
      nothingNeedsYou: t('desk.nothingNeedsYou'),
      nothingNeedsYouHint: t('desk.nothingNeedsYouHint'),
      /**
       * What needs a look (0.118, DK-93…DK-96): its title is `status.down` or `status.look`; `offer` follows it on the
       * assistant's line; the card's `noticed`, `kinds`, `noReason`, `fix`, `open` and `fine`; `question` what *Ask
       * {assistant} to look into it* sends when the look has no question of its own. 0.122 (QN-20): `fix` asks the
       * assistant to look into it (a problem only); `ignore` and `notNow` quiet the look, then the card says `ignored` or
       * `snoozed`.
       */
      looks: {
        offer: t('desk.looks.offer'),
        noticed: t('desk.looks.noticed'),
        kinds: {
          server: t('desk.looks.kinds.server'),
          connection: t('desk.looks.kinds.connection'),
          device: t('desk.looks.kinds.device'),
        } satisfies Record<LookKind, string>,
        noReason: t('desk.looks.noReason'),
        fix: t('desk.looks.fix'),
        open: t('desk.card.open'),
        fine: t('desk.looks.fine'),
        question: t('desk.looks.question'),
        questionBare: t('desk.looks.questionBare'),
        ignore: t('desk.looks.ignore'),
        notNow: t('desk.looks.notNow'),
        ignored: t('desk.looks.ignored'),
        snoozed: t('desk.looks.snoozed'),
        /** What the assistant found out (3.5, CG-374): while it finds out, while it takes the step, Ask once it said. */
        looking: t('desk.looks.looking'),
        lookingSoFar: t('desk.looks.lookingSoFar'),
        fixing: t('desk.looks.fixing'),
        ask: t('desk.looks.ask'),
      },
      /** This Whombat (DK-22): `free` and `used` hold the unit and the number the page draws big. */
      box: {
        title: t('desk.box.title'),
        lastHour: t('desk.server.ranges.1h'),
        processor: t('desk.box.processor'),
        memory: t('desk.box.memory'),
        storage: t('desk.server.storage'),
        free: t('desk.box.free'),
        used: t('desk.box.used'),
        ofTotal: t('desk.server.memoryOf'),
        temperature: t('desk.server.temperature'),
        tempNote: t('desk.box.tempNote'),
        tones: { ok: t('desk.box.tones.ok'), warn: t('desk.box.tones.warn'), bad: t('desk.box.tones.bad') },
        network: t('desk.box.network'),
        hourAgo: t('desk.box.hourAgo'),
        now: t('desk.box.now'),
        scale: `{n}${NBSP}%`,
        hint: t('desk.box.hint'),
        /** The agent's part is its name (`{assistant}`, CT-1140). */
        parts: { whombat: 'Whombat', agent: '{assistant}' },
      },
      asks: t('desk.asks'),
      notNow: t('desk.looks.notNow'),
      ask: t('desk.ask'),
      approve: t('desk.approve'),
      onPhone: t('desk.onPhone'),
      /** 0.108 (DK-61, DK-62). */
      deny: t('desk.deny'),
      approveWithPin: t('desk.approveWithPin'),
      approveOnPhone: t('desk.approveOnPhone'),
      /** 0.116 (TF-14): the PIN pad's line for one of an ask's wider choices, and the words for `not_offered`. */
      choiceWithPin: t('desk.choiceWithPin'),
      notOffered: t('desk.notOffered'),
      phoneReasons: {
        money: t('desk.phoneReasons.money'),
        release: t('desk.phoneReasons.release'),
        delete: t('desk.phoneReasons.delete'),
        keys: t('desk.phoneReasons.keys'),
        outside: t('desk.phoneReasons.outside'),
      } satisfies Record<DeskPhoneReason, string>,
      unlockAs: t('desk.unlockAs'),
      confirmOnPhone: t('desk.confirmOnPhone'),
      orConfirmOnPhone: t('desk.orConfirmOnPhone'),
      /** No PIN chosen yet (DK-18): the pad has only the phone. */
      noPinYet: t('desk.noPinYet'),
      checkPhone: t('desk.checkPhone'),
      phoneSaidNo: t('desk.phoneSaidNo'),
      wrongPin: t('desk.wrongPin'),
      wrongPinOne: t('desk.wrongPinOne'),
      tooManyPins: t('desk.tooManyPins'),
      cancel: t('bluetooth.cancel'),
      delete: t('desk.delete'),
      pairThisScreen: t('desk.pairThisScreen'),
      pairHint: t('desk.pairHint'),
      typeToAsk: t('desk.typeToAsk'),
      /** 3.3 (CG-359): Talk's mic is voice typing, its recording bar in the composers' words. */
      tapToTalk: t('desk.tapToTalk'),
      wordsFirst: t('desk.wordsFirst'),
      dictation: {
        cancel: t('bluetooth.cancel'),
        done: t('bluetooth.done'),
        preparing: t('installer.erasing'),
        recording: t('desk.dictation.recording'),
        transcribing: t('desk.dictation.transcribing'),
        send: t('desk.dictation.send'),
        nothing: t('desk.dictation.nothing'),
        busy: t('desk.dictation.busy'),
        badAudio: t('desk.dictation.badAudio'),
        tooLong: t('desk.dictation.tooLong'),
        failed: t('desk.dictation.failed'),
      },
      listening: t('desk.listening'),
      thinking: t('desk.thinking'),
      youAsked: t('desk.youAsked'),
      onThisWhombat: t('desk.onThisWhombat'),
      notHeard: t('desk.notHeard'),
      slow: t('desk.slow'),
      /** 0.116 (TF-16, TF-17): a talk that is working, and the conversation's working row without a `doing`. */
      working: t('desk.working'),
      /** 0.116 (TF-17): a task row's state (core's `TASK_CARD_WORDS.states`). */
      tasks: {
        running: t('desk.tasks.running'),
        ok: t('bluetooth.done'),
        warning: t('desk.tasks.warning'),
        error: t('desk.tasks.error'),
        lost: t('desk.tasks.lost'),
      } satisfies Record<TaskState, string>,
      voiceUnavailable: t('desk.voiceUnavailable'),
      talkFailed: t('desk.talkFailed'),
      /**
       * The calm glance (3.2, CG-352; DK-101…DK-124): the hero's buttons and age, the strip's work words, Welcome back, the
       * top bar's chips and its sheet, and *Try it on the screen*'s banner. The sentence by the clock and the rest of the
       * words come from the runtime.
       */
      calm: {
        since: t('desk.calm.since'),
        fix: t('desk.calm.fix'),
        open: t('desk.card.open'),
        answer: t('desk.calm.answer'),
        notNow: t('desk.looks.notNow'),
        /** A looked-into look's hero offers Ignore where it offered Not now (3.5, CG-374). */
        ignore: t('desk.looks.ignore'),
        look: t('desk.calm.look'),
        moreNeeds: t('desk.moreServers'),
        now: t('desk.steps.now'),
        doneOne: t('desk.calm.doneOne'),
        doneMany: t('desk.calm.doneMany'),
        pinned: t('desk.calm.pinned'),
        strip: {
          done: t('desk.calm.strip.done'),
          next: t('desk.calm.strip.next'),
          more: '+{n}',
        },
        welcome: {
          title: t('desk.calm.welcome.title'),
          away: t('desk.calm.welcome.away'),
          back: t('desk.calm.welcome.back'),
        },
        bar: {
          cable: t('desk.calm.bar.cable'),
          noNetwork: t('desk.calm.bar.noNetwork'),
          online: t('desk.calm.bar.online'),
          offline: t('desk.calm.bar.offline'),
          remoteOn: t('desk.calm.bar.remoteOn'),
          remoteLive: t('desk.calm.bar.remoteLive'),
          updates: {
            downloading: t('desk.calm.bar.updates.downloading'),
            installing: t('desk.calm.bar.updates.installing'),
            restarting: t('desk.calm.bar.updates.restarting'),
          },
          charge: `{n}${NBSP}%`,
          onBattery: t('desk.calm.bar.onBattery'),
          onBatteryNoTime: t('desk.calm.bar.onBatteryNoTime'),
          low: t('desk.calm.bar.low'),
        },
        sheet: {
          title: t('desk.box.title'),
          network: t('installer.check.network'),
          internet: t('desk.calm.sheet.internet'),
          battery: t('desk.calm.sheet.battery'),
          remoteHelp: t('desk.calm.sheet.remoteHelp'),
          updates: t('installer.check.reach-updates'),
          close: t('bluetooth.close'),
        },
        sample: t('desk.calm.sample'),
      },
      power: {
        pluggedKept: t('desk.power.pluggedKept'),
        pluggedCharging: t('desk.power.pluggedCharging'),
        plugged: t('desk.power.plugged'),
        onBattery: t('desk.power.onBattery'),
        onBatteryNoTime: t('desk.calm.bar.onBatteryNoTime'),
        outSince: t('desk.power.outSince'),
        outBanner: t('desk.power.outBanner'),
        outBannerNoTime: t('desk.power.outBannerNoTime'),
      },
      settings: {
        talkTo: t('desk.settings.talkTo'),
      },
    }) as const,
);
export const DESK_WORDS = deskWordsCopy();

/** The page's own words. */
export const deskCopy = localized(
  (t) =>
    ({
      /** A monitor's lock, which it only shows (the box's own display has the chip that locks). */
      monitorLocked: t('desk.chrome.monitorLocked'),
      monitorUnlocked: t('desk.chrome.monitorUnlocked'),
      more: t('desk.chrome.more'),
      answer: t('desk.calm.answer'),
      close: t('bluetooth.close'),
      back: t('bluetooth.back'),
      alreadyAnswered: t('desk.chrome.alreadyAnswered'),
      /** Under a locked ask's title beside the PIN pad (CG-50). */
      unlockToAnswer: t('desk.chrome.unlockToAnswer'),
      /** A locked question's button in the screen of widgets' pop-up (CG-397). */
      unlockButton: t('desk.chrome.unlockButton'),
      phoneHow: t('desk.chrome.phoneHow'),
      wrongPin: t('desk.chrome.wrongPin'),
      powerOut: t('desk.chrome.powerOut'),
      /** Before the m:ss countdown of the pairing letters. */
      pairFor: t('desk.chrome.pairFor'),
      talkPrompt: t('desk.chrome.talkPrompt'),
      talkMicrophone: t('desk.chrome.talkMicrophone'),
      talkBusy: t('desk.chrome.talkBusy'),
      playAgain: t('desk.chrome.playAgain'),
      /* Asks that come to you (DK-60, CG-194). */
      /** Beside the PIN pad when a new ask arrived on a screen that shows no titles while locked. */
      needsAnswer: t('desk.chrome.needsAnswer'),
      /** The card's place among the ones that came: “2 of 3”. */
      askOf: t('desk.chrome.askOf'),
      /* Talk as a conversation (DK-63, DK-64, CG-196). */
      closeConversation: t('desk.chrome.closeConversation'),
      newMessage: t('desk.chrome.newMessage'),
      moreInChat: t('desk.chrome.moreInChat'),
      earlierInChat: t('desk.chrome.earlierInChat'),
      askWaiting: t('desk.chrome.askWaiting'),
      askApproved: t('desk.chrome.askApproved'),
      askDenied: t('desk.chrome.askDenied'),
      you: t('desk.chrome.you'),
      /** Under a server's screen when there are too many servers for its dots: “5 of 24” (DK-83, CG-262). */
      serverOf: t('desk.chrome.askOf'),
      /** The conversation's working row when the runtime says what the assistant is doing (TF-17, CG-285). */
      workingDoing: t('desk.chrome.workingDoing'),
      /* Quieting a look (QN-20, CG-333, CG-334). */
      /** The assistant's line after an only-you look's title: it can't look into it. */
      youOffer: t('desk.chrome.youOffer'),
      /** `not_allowed`: the paired person may not manage the thing. */
      lookNotAllowed: t('desk.chrome.lookNotAllowed'),
      /** `not_found`: the look or its line went while the card was open. */
      lookChanged: t('desk.chrome.lookChanged'),
    }) as const,
);
export const DESK = deskCopy();

/**
 * Found on your network (Whombat desk-found.md DF-09, verbatim; CG-231): the assistant's line, the panel's and the
 * strip's words. `{app}` is the console's `appUrl`, drawn in the mono face between `before` and `after`.
 */
export const foundCopy = localized(
  (t) =>
    ({
      /** The assistant's line while the first scan looks (DF-07), bold, then the muted part. */
      looking: t('desk.found.looking'),
      lookingNone: t('desk.found.lookingNone'),
      lookingSome: t('desk.found.lookingSome'),
      /** Done: what it found. */
      foundMany: t('desk.found.foundMany'),
      foundManyMore: t('desk.found.foundManyMore'),
      foundOne: t('desk.found.foundOne'),
      foundOneMore: t('desk.found.foundOneMore'),
      title: t('desk.found.title'),
      /** The panel's head on the right. */
      progress: t('desk.found.progress'),
      found: t('desk.found.found'),
      /** A result without its time (never from Whombat, which sends `finishedAt` with every result). */
      foundCount: t('desk.found.foundCount'),
      /** The panel's footer: “Connect them on your computer: app.whombat.com → Connections”. */
      connectMany: { before: t('desk.found.connectMany.before'), after: t('desk.found.connectMany.after') },
      connectOne: { before: t('desk.found.connectOne.before'), after: t('desk.found.connectMany.after') },
      notNow: t('desk.looks.notNow'),
      /** The strip beside servers and tiles (DF-06). */
      stripTitle: t('desk.found.stripTitle'),
      stripMore: t('desk.found.stripMore'),
      stripConnect: { before: t('desk.found.stripConnect.before'), after: '' },
    }) as const,
);
export const FOUND = foundCopy();

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
export function foundSay(found: { progress: unknown; count: number }, t: Translate = english): FoundSay {
  const FOUND = foundCopy(t);

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
  t: Translate = english,
): string {
  const FOUND = foundCopy(t);

  if (found.progress)
    return fill(FOUND.progress, {
      done: grouped(found.progress.done),
      total: grouped(found.progress.total),
    });
  const n = grouped(found.count);
  return found.finishedAt
    ? fill(FOUND.found, { n, ago: ago(found.finishedAt, now, undefined, t) })
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
export function unlockedText(
  name: string,
  minutes: number | null,
  present: boolean,
  t: Translate = english,
): string {
  const DESK_WORDS = deskWordsCopy(t);

  if (minutes === null) return fill(DESK_WORDS.unlockedStays, { name });
  return present
    ? fill(DESK_WORDS.unlockedHere, { name })
    : fill(DESK_WORDS.unlockedAs, { name, n: minutes });
}

/** “Wrong PIN. 3 tries left.”, “Wrong PIN. 1 try left.” (the contracts' `deskWrongPinText`). */
export function wrongPinText(triesLeft: number, t: Translate = english): string {
  const DESK_WORDS = deskWordsCopy(t);

  return triesLeft === 1 ? DESK_WORDS.wrongPinOne : fill(DESK_WORDS.wrongPin, { n: triesLeft });
}

/** “3 h 10 min”, “45 min”, “2 h”. */
export function duration(minutes: number, t: Translate = english): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return t('deskCopy.min', { r });
  return r === 0 ? t('deskCopy.h', { h }) : t('deskCopy.hMin', { h, r });
}

/** The power chip in the top bar (DK-10): the contracts' short lines. */
export function powerChip(p: DeskPower, t: Translate = english): string {
  const DESK_WORDS = deskWordsCopy(t);

  const w = DESK_WORDS.power;
  if (p.source === 'battery') {
    return p.minutesLeft === null
      ? fill(w.onBatteryNoTime, { n: p.percent })
      : fill(w.onBattery, { n: p.percent, time: duration(p.minutesLeft, t) });
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
  t: Translate = english,
): { lead: string; rest: string } | null {
  const DESK_WORDS = deskWordsCopy(t);
  const DESK = deskCopy(t);

  if (p.source !== 'battery') return null;
  const w = DESK_WORDS.power;
  const since = p.since ? Date.parse(p.since) : Number.NaN;
  return {
    lead: Number.isFinite(since) ? fill(w.outSince, { clock: clockText(since, timeZone) }) : DESK.powerOut,
    rest:
      p.minutesLeft === null
        ? fill(w.outBannerNoTime, { assistant })
        : fill(w.outBanner, { assistant, time: duration(p.minutesLeft, t) }),
  };
}

const formats = new Map<string, Intl.DateTimeFormat>();
export function formatDeskDate(
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
  locale = 'en-GB',
): Intl.DateTimeFormat {
  const key = `${locale}|${timeZone}|${JSON.stringify(options)}`;
  let f = formats.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(formatLocale(locale), { ...options, timeZone });
    } catch {
      f = new Intl.DateTimeFormat(formatLocale(locale), { ...options, timeZone: 'UTC' });
    }
    formats.set(key, f);
  }
  return f;
}

/** “14:34” in the paired person's time zone, 24 hours. */
export function clockText(ms: number, timeZone: string): string {
  return formatDeskDate(timeZone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}

/** “Tue”: a day on the week's chart (DK-83). */
export function weekdayText(ms: number, timeZone: string, locale = 'en-GB'): string {
  return formatDeskDate(timeZone, { weekday: 'short' }, locale).format(ms);
}

/** The hour and minute on the person's clock (24 hours). */
export function localTime(ms: number, timeZone: string): { hour: number; minute: number } {
  const parts = formatDeskDate(timeZone, {
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(ms);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { hour: n('hour'), minute: n('minute') };
}

/** “Tuesday 20 October”. */
export function dateText(ms: number, timeZone: string, locale = 'en-GB'): string {
  return formatDeskDate(timeZone, { weekday: 'long', day: 'numeric', month: 'long' }, locale).format(ms);
}

function minutesSince(at: string, now: number): number {
  const when = Date.parse(at);
  return Number.isFinite(when) ? Math.floor((now - when) / 60_000) : 0;
}

export function elapsedText(at: string, now: number, t: Translate): string {
  const min = minutesSince(at, now);
  if (min < 1) return t('deskCopy.justNow');
  if (min < 60) return t('calm.min', { min });
  if (min < 24 * 60) return t('deskCopy.h', { h: Math.floor(min / 60) });
  return t('deskCopy.elapsed.days', { count: Math.floor(min / (24 * 60)) });
}

/** “3 min ago” (`long`: “3 minutes ago”), “2 h ago”, “just now”. */
export function ago(at: string, now: number, long = false, t: Translate = english): string {
  const min = minutesSince(at, now);
  if (min < 1) return t('deskCopy.justNow');
  if (min < 60)
    return long
      ? t('deskCopy.ago', { min, value: t(min === 1 ? 'deskCopy.minute' : 'deskCopy.minutes') })
      : t('deskCopy.minAgo', { min });
  const h = Math.floor(min / 60);
  if (h < 24)
    return long
      ? t('deskCopy.agoAlt', { h, value: t(h === 1 ? 'calm.hour' : 'calm.hours') })
      : t('deskCopy.hAgo', { h });
  const d = Math.floor(h / 24);
  return long
    ? t('deskCopy.agoAltAlt', { d, value: t(d === 1 ? 'calm.day' : 'calm.days') })
    : t('deskCopy.dAgo', { d });
}

/** “18 %” (a no-break space, never split from its number, as the contracts' power words). */
export const percent = (v: number) => `${Math.round(v)}${NBSP}%`;
/** “46°”. */
export const degrees = (v: number) => `${Math.round(v)}°`;
