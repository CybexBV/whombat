/**
 * Settings → This Whombat → Backups as the web and the phone show it (Whombat docs/decisions/backup-options.md; app
 * docs/app/decisions/backup-options.md): the top card that answers “am I safe?”, the list of backups grouped by day,
 * the options dialog with its plain-terms costs, one backup's page, the backups left on the box's own disk, and the
 * words of keeping a way back in and bringing a Whombat back. Pure and shared, so both apps say the same.
 */
import { placeOfDisplay } from '@whombat/core';
import { formatBytes } from '@whombat/core/text';
import {
  BACKUP_KEEP_90_DAYS,
  BACKUP_KEEP_YEAR,
  type BackupBringBack,
  type BackupCheckpoint,
  type BackupCheckpointsOutput,
  type BackupFrequency,
  type BackupKeep,
  type BackupPolicy,
  type BackupRestoreState,
  type BackupServiceStatus,
  type BackupStatus,
} from '@whombat/protocol/session';
import { ago } from './status-copy';

/* Words ------------------------------------------------------------------------------------------------------- */

export const BACKUP_OPTIONS_TEXT = {
  backedUp: (when: string) => `Backed up ${when}`,
  /** Right after Back up now finished. */
  justNow: 'Backed up just now',
  /** A backup is being made now (Back up now, or the schedule's). */
  running: 'Backing up now…',
  notYet: 'No backup yet',
  /** The box's last attempts failed: the title, then its own reason and when the last one finished. */
  failing: 'The last backup didn’t work',
  /** No backup finished for longer than the schedule allows. */
  behind: 'Backups are behind',
  /** The backup service isn't answering and nothing says when the last backup was (the notice says why). */
  unknown: 'Can’t see your backups right now',
  lastFinished: (when: string) => `The last one finished ${when}.`,
  noneFinished: 'None has finished yet.',
  /** The Inbox's *Ask {assistant} to fix it*, here on the card itself. */
  askFix: (agent: string) => `Ask ${agent} to fix it`,
  on: (place: string) => `On ${place}`,
  next: (time: string) => `next one at ${time}`,
  oldest: (date: string) => `the oldest is from ${date}`,
  backUpNow: 'Back up now',
  backingUp: 'Backing up…',
  options: 'Options',
  /** The chips' list, for screen readers (not “Options”, the button's name). */
  chipsLabel: 'How backups are set up',
  chips: {
    frequency: { nightly: 'Every night', '6h': 'Every 6 hours', hourly: 'Every hour' } as Record<
      BackupFrequency,
      string
    >,
    keptYear: 'Kept up to a year',
    kept90: 'Kept 90 days',
    keptFor: (span: string) => `Kept up to ${span}`,
    space: (used: string, free: string | null) => (free ? `${used} used · ${free} free` : `${used} used`),
    checked: (day: string) => `Checked ${day}`,
    checkFailed: (day: string) => `The check ${day} failed`,
  },
  /** Bringing this Whombat back, as part of being backed up (Whombat backup-passkey.md BPK-08). */
  wayBack: {
    ready: 'Can be brought back with your passkey',
    paper: 'Can be brought back with the paper copy',
    /** Backups use the same passkey setup as sign-in and appliance access. */
    ask: 'Set up your passkey',
    askMeta: 'One passkey to sign in, open all your Whombats and unlock your backups.',
    use: 'Set up my passkey',
    using: 'Waiting for your passkey…',
    /** The box's own page has no passkeys: they belong to the app's address. */
    elsewhere: 'Open Whombat on your phone or computer and set up your passkey there.',
  },
  /** What the last backup left out, when it was made with a gap (its plain reason follows). */
  leftOut: 'The last backup left something out.',
  /** What it left out when the service's own words aren't for people (a path, an error): said from what is known. */
  leftOutWhy: {
    servers: 'The servers couldn’t be backed up this time; everything else was.',
    files: (n: number) =>
      `${n} file${n === 1 ? ' wasn’t' : 's weren’t'} on this Whombat any more, so ${n === 1 ? 'it isn’t' : 'they aren’t'} in it; everything else was.`,
    other: 'Part of it couldn’t be backed up this time; everything else was.',
  },
  needsYou: 'Needs you',
  local: {
    title: (n: number) => `${n} older backup${n === 1 ? ' is' : 's are'} still on this Whombat`,
    meta: (range: string, size: string, place: string | null) =>
      `From before ${place ?? 'the place'} (${range}, ${size}). If this Whombat breaks, they go with it.`,
    move: (place: string | null) => (place ? `Move to ${place}` : 'Move them'),
    moving: 'Moving…',
    moved: (n: number) => `Moved ${n} backup${n === 1 ? '' : 's'}.`,
    remove: 'Remove',
    removeTitle: 'Remove the older backups?',
    removeLead: (size: string) =>
      `They’re deleted from this Whombat and ${size} is freed. You can’t go back to them afterwards.`,
    removeConfirm: 'Remove them',
  },
  list: {
    label: (n: number) => `Backups · ${n}`,
    newestFirst: 'Newest first',
    today: 'TODAY',
    yesterday: 'YESTERDAY',
    later: 'LATER ON',
    thinned: (keep: BackupKeep) => thinnedLine(keep),
    showAll: 'Show all',
    empty: 'No backups here yet.',
    reasons: {
      scheduled: 'Scheduled',
      manual: 'You asked',
      'pre-migration': 'Before an update',
      test: 'Test',
      unknown: 'Backup',
    },
    beforeUpdate: (version: string) => `Before the update to ${version}`,
    first: 'First backup',
    checkedOk: 'Checked: it restores',
    checkedBad: 'The check failed',
    /** A backup made with a gap (what it left out is on its page). */
    leftOut: 'Left something out',
    earlier: (name: string) => `From ${name}`,
    /** Under the list: the backups made on the places used before stay there (the list shows the place in use). */
    earlierPlaces: (places: string) =>
      `Older backups stay on ${places}. They show here again if backups go back there.`,
  },
  dusty: (agent: string) => `You can also tell ${agent} “back up now” or “keep backups longer”.`,
  dialog: {
    title: 'Backup options',
    cancel: 'Cancel',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Saved.',
    summary: (span: string, size: string | null, place: string | null, free: string | null) =>
      `Backups are kept ${span}.${size ? ` That takes about ${size}${place ? ` on ${place}` : ''}` : ''}${
        size && free ? `, which has ${free} free.` : size ? '.' : ''
      }`,
    howOften: 'How often',
    frequency: { nightly: 'Every night', '6h': 'Every 6 hours', hourly: 'Every hour' } as Record<
      BackupFrequency,
      string
    >,
    frequencyHint: {
      nightly: 'Once a night in the quiet hours. At most a day of work can be lost.',
      '6h': 'Recommended. Each one takes about 15 seconds and you won’t notice it. At most 6 hours of work can be lost.',
      hourly: 'Each one takes about 15 seconds. At most an hour of work can be lost.',
    } as Record<BackupFrequency, string>,
    howLong: 'How long to keep them',
    keepYear: 'Up to a year',
    keepYearMeta:
      'All of the last 2 days, one a day for 2 weeks, one a week for 2 months, one a month for a year.',
    keep90: 'Everything for 90 days',
    keep90Meta: 'Every backup, then nothing older.',
    keepChoose: 'Choose…',
    keepFields: {
      allDays: 'Every backup for (days)',
      dailyDays: 'One a day for (days)',
      weeklyWeeks: 'One a week for (weeks)',
      monthlyMonths: 'One a month for (months)',
    },
    timeline: { yearAgo: 'a year ago', months: '2 months', weeks: '2 weeks', now: 'now' },
    recommended: 'RECOMMENDED',
    space: 'Space',
    limit: 'Limit the space',
    /** The limit off: the place's real free space when it says it, else nothing more. */
    limitOff: (place: string | null, free: string | null) =>
      free ? `Off. ${place ?? 'The place'} has ${free} free.` : 'Off.',
    limitOffPlain: 'Off.',
    limitOn: (size: string) => `Use at most ${size}. The oldest backups go first, never the last 7 days.`,
    limitGb: 'GB',
    checking: 'Checking',
    weeklyCheck: 'Check a backup every week',
    weeklyCheckMeta: (last: string | null) =>
      `Whombat restores one on the side to prove it works.${last ? ` Last: ${last}.` : ''}`,
    lastGood: (day: string) => `${day}, all good`,
    lastBad: (day: string) => `${day}, it failed`,
    clearedByNone:
      'This place doesn’t let Whombat delete anything, so old backups stay until you clear them there.',
  },
  detail: {
    back: 'Backups',
    meta: (reason: string, added: string | null, place: string | null) =>
      [reason, added ? `${added} new` : null, place ? `on ${place}` : null].filter(Boolean).join(' · '),
    checked: (day: string) => `Checked ${day}: it restores`,
    checkFailed: (day: string) => `The check ${day} failed`,
    inIt: 'What’s in it',
    /** “What’s in it”'s lines, from the backup's own coverage (`backupContents`). */
    lines: {
      conversations: 'Conversations, your assistant’s memory and skills',
      files: 'Files and photos',
      filesMissing: (n: number) =>
        `${n} file${n === 1 ? ' wasn’t' : 's weren’t'} on this Whombat any more, so ${n === 1 ? 'it isn’t' : 'they aren’t'} in it`,
      projects: 'Projects and code',
      projectsNote: 'Including work not pushed yet',
      servers: 'Servers and what your assistant may do on them',
      serversMissing: 'Left out of this backup',
      settings: 'Settings, keys and the Vault',
      signIns: 'Sign-ins (Claude, Codex, GitHub, Google)',
      signInsNote: 'Some may ask you to sign in again',
      network: 'Wi-Fi and Bluetooth',
      networkNote: 'Set up again on a new Whombat',
      voices: 'Voices',
      voicesNote: 'They download again in the background',
      notIncluded: 'Not included',
      included: 'Included',
    },
    checkNow: 'Check this backup now',
    checkQueued: 'Checking it now. This takes a few minutes.',
    checking: 'Checking…',
  },
  /** Backups' less-used details, folded under “Details”. */
  details: {
    show: 'Details',
    hide: 'Hide details',
    where: (where: string) => `Kept at ${where}`,
    clears: {
      place: (place: string | null) => `${place ?? 'The place'} clears old backups the way your options say.`,
      box: 'This Whombat clears old backups the way your options say.',
      none: 'Nothing clears old backups there: they stay until you clear them yourself.',
    },
    /** One phrase for a place that refuses the box's deletes. */
    noDelete: 'Can’t be deleted from here',
    checkNewest: 'Check the newest backup now',
  },
  /** The paper copy, optional (Whombat backup-passkey.md BPK-07): only what opens the backups, printed any time. */
  paper: {
    title: 'Paper copy',
    meta: 'Optional. With it, a new Whombat opens these backups without your passkey. Anyone who has it can read them.',
    saved: (date: string) => `Saved ${date}. You can print it again whenever you like.`,
    print: 'Print it',
    file: 'Save as a file',
    making: 'Making it…',
    failed: 'The paper copy couldn’t be made. Try again.',
    printTitle: (name: string) => `Backup details for ${name}`,
    printLead:
      'Keep this page somewhere safe and offline. With it, a new Whombat can open this one’s backups. Anyone who has it can read them.',
    printScan: 'Scan this on a new Whombat',
  },
  /** Bringing back a Whombat you had, later (on a box that started fresh). */
  later: {
    title: 'Bring back a Whombat you had',
    meta: 'If you meant to bring one back, you still can: with your passkey or the paper copy.',
    button: 'Bring back',
    confirmTitle: 'Replace what’s on this Whombat?',
    confirmLead: (name: string) =>
      `Bringing back a Whombat you had puts everything of it on ${name}. What’s on ${name} now is set aside, and its own backups stay where they are.`,
    confirm: 'Choose the Whombat',
    cancel: 'Cancel',
  },
  kit: {
    title: 'Keep a way back in',
    lead: (name: string) =>
      `If ${name} ever breaks, this lets a new Whombat open its backups. Choose one or more.`,
    passkey: 'Your passkey',
    passkeyMeta: 'One touch on any phone or computer that has it. Locked so only your passkey can open it.',
    print: 'Print it too',
    printMeta: 'For the day you can’t reach your passkey. Keep it with your papers.',
    file: 'Save as a file',
    fileMeta: 'For a password manager or a USB stick.',
    usePasskey: 'Use my passkey',
    noPasskey: (name: string) => `No passkey yet? This adds one for ${name} first.`,
    saved: 'Saved. Whombat asks again only when the kit changes.',
    lockedWith: (when: string) => `Locked with your passkey ${when}`,
    noPrf:
      'This passkey can’t lock the kit (its password manager doesn’t offer it). Print the kit or save it as a file instead.',
    printTitle: (name: string) => `Recovery kit for ${name}`,
    printLead:
      'Keep this page somewhere safe and offline. With it, a new Whombat can open this one’s backups. Anyone holding it can read them, so treat it like a key.',
    printScan: 'Scan this on a new Whombat',
    kicker: 'RECOVERY KIT',
    tip: 'Your passkey opens the kit on any device that has it. The printed page works even without Whombat’s servers.',
    save: 'Save',
    saving: 'Saving…',
    printAgain: 'Print again',
    downloadAgain: 'Download again',
    done: 'Done',
    /** Settings → This Whombat → Backups: the quiet row saying how the kit is kept. */
    row: 'Recovery kit',
    printed: 'printed',
    asFile: 'saved as a file',
    savedPlain: 'Saved',
    saveAgain: 'Save again',
  },
  bringBack: {
    question: 'Is this a new Whombat?',
    questionLead: 'Start with an empty one, or bring back everything from one you had.',
    fresh: 'Start fresh',
    freshMeta: 'A new Whombat with nothing in it yet.',
    back: 'Bring back a Whombat',
    backMeta:
      'From its backups: conversations, your assistant’s memory, files, projects, servers and settings.',
    found: (name: string, when: string) => `Your passkey can bring back ${name} (its backups from ${when}).`,
    /** A Whombat to bring back without a name of its own (never its device id). */
    yourWhombat: 'your Whombat',
    continue: 'Continue',
    /** The web has no camera: the paper copy's file or its text. */
    noKitHintWeb: 'No passkey? Use the paper copy’s file or its text.',
    /** The phone scans the printed paper copy too. */
    noKitHintPhone: 'No passkey? Scan the paper copy, or use its file or text.',
    openTitle: (name: string) => `Open ${name}’s backups`,
    openLead: (name: string) => `${capital(name)}’s backups are locked with your passkey.`,
    unlock: 'Unlock with passkey',
    /** No passkey's backups at the account: look next to the backups on this network (it can take a minute). */
    findTitle: 'Find your Whombat’s backups',
    findLead: 'Look for them on this network, or use the paper copy.',
    look: 'Look on my network',
    looking: 'Looking on your network. This can take about a minute.',
    lookAgain: 'Look again',
    nothingNear: 'No backups locked with a passkey were found on this network.',
    foundNear: (date: string) => `Found on your network · saved ${date}`,
    paperTitle: 'Or use the paper copy',
    scan: 'Scan the paper copy',
    openFile: 'Open the paper copy’s file',
    pasteTitle: 'Paste the paper copy',
    wrongKit: 'That isn’t a paper copy Whombat can read. Check it’s the whole text.',
    unlockFailed: 'That passkey didn’t open them. Try another passkey, or the paper copy.',
    noPrf:
      'This passkey can’t open backups (its password manager doesn’t offer it). Use the paper copy instead.',
    opening: 'Opening the backups…',
    adoptFailed:
      'Whombat couldn’t reach those backups. Is the place they’re on switched on and on this network?',
    chooseTitle: (name: string) => `${capital(name)}’s backups`,
    chooseLead: (place: string | null) =>
      `${place ? `Found on ${place}. ` : ''}The newest is usually the one you want.`,
    newest: 'NEWEST',
    /** A backup the old Whombat made after another took its place (never picked first). */
    afterReplaced: 'Made by the old Whombat after you replaced it',
    olderBackups: 'Older backups…',
    restore: (name: string) => `Bring ${name} back`,
    restoreHint: 'Takes about 5 minutes. What’s on this Whombat now is set aside, not deleted.',
    workingTitle: (name: string) => `Bringing ${name} back`,
    workingLead: 'You can put this down. We’ll tell you when it’s ready.',
    steps: {
      check: 'Checking the backup is whole',
      copy: (place: string | null) => (place ? `Copying it from ${place}` : 'Copying it'),
      put: 'Putting everything back',
      servers: 'Reconnecting your servers',
    },
    workingFoot: (place: string | null) =>
      `If something goes wrong, nothing is lost: the backup stays${place ? ` on ${place}` : ''} and you can try again.`,
    failedTitle: 'It didn’t finish',
    failedLead:
      'Nothing was lost: the backup is untouched and this Whombat is as it was. Try again, or start over.',
    tryAgain: 'Try again',
    startOver: 'Start over',
    almostTitle: 'Almost there',
    almostLead: (name: string, time: string) =>
      `${capital(name)} is back as it was at ${time}. One question before it starts working again:`,
    oldGone: 'Is the old Whombat gone?',
    oldGoneMeta: 'So it can’t act on your accounts or add to these backups any more.',
    /** The backups are on a place only the person can give a new password: nothing promised about them. */
    oldGoneMetaYou: 'So it can’t act on your accounts any more.',
    oldWiped: 'It’s broken or wiped',
    oldLost: 'Lost or stolen',
    oldLostMeta:
      'Whombat gives the backups a new password so it can’t add to them. Also sign out of Claude, Codex, GitHub and Google everywhere, so its sign-ins stop working.',
    /** Lost or stolen, on a place set up by hand or typed in: Whombat can't change that password, the person can. */
    oldLostMetaYou: (place: string | null) =>
      `Whombat can’t change the password of the backups on ${place ?? 'that place'}, so change it there afterwards: the Inbox says how. Also sign out of Claude, Codex, GitHub and Google everywhere, so its sign-ins stop working.`,
    start: (name: string) => `Start ${name}`,
    starting: 'Starting…',
    doneTitle: (name: string) => `${capital(name)} is back`,
    doneLead: (agent: string, time: string) => `${agent} remembers everything up to ${time}.`,
    doneServers: (n: number | null) =>
      n === null ? 'Your servers find it again' : `${n} server${n === 1 ? '' : 's'} found it again`,
    doneBackups: (place: string | null) => (place ? `Backups carry on to ${place}` : 'Backups carry on'),
    doneVoices: 'Voices download again in the background',
    /** The old Whombat is switched off at Whombat's servers once this one says where it came from. */
    doneOldOff: (name: string) => `The old ${name.replace(/^your /, '')} can’t reach your account any more`,
    /** Lost or stolen on a place Whombat can't give a new password. */
    donePassword: (place: string | null) =>
      `Change the backup password on ${place ?? 'that place'}: the Inbox says how`,
    /** The last line: a passkey for this Whombat, whose touch makes it the key to its backups. */
    doneKey: (name: string) => `Make your passkey the key to ${name}’s backups`,
    doneKeyButton: 'Add my passkey',
    /** Once that touch made the passkey the key. */
    doneKeyDone: (name: string) => `Your passkey is the key to ${name}’s backups`,
    openChat: 'Open Chat',
    doneFoot: (agent: string, time: string) =>
      `Ask ${agent} in Chat to look in GitHub and your accounts for anything after ${time}.`,
    kicker: 'BRING BACK',
    tip: 'Your passkey opens the old Whombat’s backups. Nothing in them changes until you choose one.',
    goBack: 'Back',
    pasteLabel: 'The paper copy’s text',
    openIt: 'Open the backups',
    checkedLower: 'checked: it restores',
    reconnecting: 'Waiting for this Whombat to answer again…',
    savedOn: (date: string) => `Saved ${date}`,
  },
} as const;

/** “your Whombat” at the start of a sentence or a title. */
export function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A Whombat's device id (`wb-3fkq-8mzt-2049`): never said as its name. */
const DEVICE_ID = /^wb-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;

/**
 * The name a Whombat to bring back goes by: its own (the account's, the network copy's, the paper copy's), else “your
 * Whombat”, never its device id.
 */
export function bringBackName(name: string | null | undefined): string {
  const n = name?.trim();
  return n && !DEVICE_ID.test(n) ? n : BACKUP_OPTIONS_TEXT.bringBack.yourWhombat;
}

/** A place as people read it when it has no name (`10.0.2.2:8747`). */
export const placeShown = placeOfDisplay;

/* Dates ------------------------------------------------------------------------------------------------------- */

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** “3 November” (local). */
export function longDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** “Sun 25 Oct” (local). */
export function shortDay(iso: string): string {
  const d = new Date(iso);
  return `${DAYS[d.getDay()]?.slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()]?.slice(0, 3)}`;
}

/** “today”, “yesterday”, “Sunday” within a week, else “3 November”. */
export function relativeDay(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (dayKey(d) === dayKey(now)) return 'today';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (dayKey(d) === dayKey(y)) return 'yesterday';
  if (now.getTime() - d.getTime() < 6 * 86_400_000) return DAYS[d.getDay()] as string;
  return longDate(iso);
}

/** The person's hour and minute in `timeZone` at `at` (Intl; the device's own zone when it doesn't know it). */
function zonedHourMinute(at: Date, timeZone: string): { h: number; m: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const m = Number(parts.find((p) => p.type === 'minute')?.value);
    if (Number.isFinite(h) && Number.isFinite(m)) return { h, m };
  } catch {
    // an unknown zone: the device's own
  }
  return { h: at.getHours(), m: at.getMinutes() };
}

/** The hours a frequency backs up at, in the person's zone (the backup service's `-if-due` uses the same). */
export const BACKUP_SLOT_HOURS: Record<BackupFrequency, readonly number[]> = {
  nightly: [3],
  '6h': [3, 9, 15, 21],
  hourly: Array.from({ length: 24 }, (_, i) => i),
};

/** When the next scheduled backup starts (on the quarter hour after its slot at the latest). */
export function nextBackupAt(policy: Pick<BackupPolicy, 'frequency' | 'timeZone'>, now = new Date()): Date {
  const slots = BACKUP_SLOT_HOURS[policy.frequency];
  const t = new Date(now);
  t.setSeconds(0, 0);
  t.setMinutes(Math.ceil((t.getMinutes() + 1) / 15) * 15);
  for (let i = 0; i < 26 * 4; i++) {
    const { h, m } = zonedHourMinute(t, policy.timeZone);
    if (m === 0 && slots.includes(h)) return t;
    t.setMinutes(t.getMinutes() + 15);
  }
  return t;
}

/* The top card ------------------------------------------------------------------------------------------------ */

export interface BackupHeroChip {
  text: string;
  dot?: 'ok' | 'bad';
}

/**
 * Where the backups stand, which the card's title, tone and icon follow: `running` (one is being made), `failing` (the
 * service says so: its attempts failed), `behind` (none finished for longer than the schedule allows), `justNow`
 * (Back up now just finished), `ok` (backed up), `none` (nothing finished yet).
 */
export type BackupHeroState = 'ok' | 'justNow' | 'running' | 'behind' | 'failing' | 'none' | 'unknown';

export interface BackupHero {
  state: BackupHeroState;
  title: string;
  sub: string;
  chips: BackupHeroChip[];
  /** `bad` while failing, `warn` while behind, `mut` with nothing yet: the card says so instead of the reassuring shield. */
  tone: 'ok' | 'warn' | 'bad' | 'mut';
  /**
   * While failing or behind: the box's reason and when the last one finished; while the backup service isn't answering,
   * the page's notice; null otherwise.
   */
  problem: string | null;
  /** *Ask {assistant} to fix it* on the card (failing, behind, or the backup service not answering). */
  askFix: boolean;
  /** What the last backup left out, in the service's plain words; null when it was whole. */
  leftOut: string | null;
  /** Recovery status, including saving and waiting for verification. */
  wayBack: string | null;
  /** Only confirmed recovery gets the success check. */
  wayBackReady: boolean;
  /** The passkey's one calm line: no passkey holds the key to these backups yet. */
  askPasskey: boolean;
}

/** How far back a policy reaches, in words (“up to a year”, “90 days”, “up to 3 months”). */
export function keepSpan(keep: BackupKeep): string {
  if (sameKeep(keep, BACKUP_KEEP_YEAR)) return 'up to a year';
  if (sameKeep(keep, BACKUP_KEEP_90_DAYS)) return '90 days';
  const days = keepDays(keep);
  if (days >= 365 && days % 365 < 31) return `up to ${Math.round(days / 365)} year${days >= 730 ? 's' : ''}`;
  if (days >= 60) return `up to ${Math.round(days / 30.4)} months`;
  if (days >= 14 && days % 7 === 0) return `up to ${days / 7} weeks`;
  return `up to ${days} day${days === 1 ? '' : 's'}`;
}

/** The longest window of a policy, in days. */
export function keepDays(keep: BackupKeep): number {
  return Math.max(keep.allDays, keep.dailyDays, keep.weeklyWeeks * 7, Math.round(keep.monthlyMonths * 30.4));
}

export function sameKeep(a: BackupKeep, b: BackupKeep): boolean {
  return (
    a.allDays === b.allDays &&
    a.dailyDays === b.dailyDays &&
    a.weeklyWeeks === b.weeklyWeeks &&
    a.monthlyMonths === b.monthlyMonths
  );
}

/** Which of the dialog's choices a policy's keep is. */
export function keepChoice(keep: BackupKeep): 'year' | 'days90' | 'custom' {
  return sameKeep(keep, BACKUP_KEEP_YEAR)
    ? 'year'
    : sameKeep(keep, BACKUP_KEEP_90_DAYS)
      ? 'days90'
      : 'custom';
}

function thinnedLine(keep: BackupKeep): string {
  const parts: string[] = [];
  if (keep.dailyDays > keep.allDays) parts.push(`one a day for ${spanOf(keep.dailyDays, 'day')}`);
  if (keep.weeklyWeeks * 7 > Math.max(keep.allDays, keep.dailyDays))
    parts.push(`then one a week for ${spanOf(keep.weeklyWeeks * 7, 'week')}`);
  if (keep.monthlyMonths * 30 > Math.max(keep.allDays, keep.dailyDays, keep.weeklyWeeks * 7))
    parts.push('then one a month');
  return parts.join(', ').replace(/^then /, '');
}

function spanOf(days: number, unit: 'day' | 'week'): string {
  if (unit === 'week' && days >= 56 && days % 28 === 0) return `${days / 28} months`;
  if (days >= 14 && days % 7 === 0) return `${days / 7} weeks`;
  return `${days} days`;
}

export interface BackupHeroInput {
  status: BackupServiceStatus | null;
  /** The summary (`appliance.status`'s or `backup.overview`'s): what the last backup left out, bringing it back. */
  summary?: Pick<BackupStatus, 'incomplete' | 'bringBack'> | null;
  policy: BackupPolicy | null;
  list: BackupCheckpointsOutput | null;
  /** The place's name (“BlackBox”), or the destination's display. */
  placeName: string | null;
  /** Back up now is running here (the service may not say so yet). */
  running?: boolean;
  /** Back up now just finished here: “Backed up just now”. */
  justNow?: boolean;
  /** The overview's plain sentence while the backup service isn't answering (`backup.overview`'s `notice`). */
  notice?: string | null;
  /** When the last backup finished as the Whombat last said it (`appliance.status`), for when the service can't say. */
  lastKnownAt?: string | null;
  now?: Date;
}

function sentence(text: string): string {
  const t = text.trim();
  return t && !/[.!?…]$/.test(t) ? `${t}.` : t;
}

/** Signs that a reason is an error for developers, not a sentence for people: a path, an error code, a tool's prefix. */
const RAW_REASON = [
  /(^|[\s(])\/[\w.-]+\/[\w./-]*/,
  /\bno such file\b/i,
  /\bpermission denied\b/i,
  /\bexit (status|code)\b/i,
  /\b(E[A-Z]{3,}|errno)\b/,
  /\bwhombat-[a-z-]+:/,
  /\b(stat|open|read|dial|lstat) [^\s]+:/,
  /\(\s*[a-z][\w-]*:/,
];

/**
 * What a backup left out, in plain words (a sentence, curly apostrophes). An older backup service says why with its raw
 * error (`whombat-hosts: stat /persist/hosts/hub.db: …`): then the sentence comes from what is known (the servers, the
 * files that weren't there), else a general one. Null when nothing was left out.
 */
export function plainLeftOut(
  gap: { reason?: string | null; attachments?: number; servers?: boolean } | null | undefined,
): string | null {
  if (!gap) return null;
  const T = BACKUP_OPTIONS_TEXT.leftOutWhy;
  const reason = gap.reason?.replace(/\s+/g, ' ').trim() ?? '';
  if (reason && !RAW_REASON.some((r) => r.test(reason))) return sentence(reason.replace(/'/g, '’'));
  if (gap.servers) return T.servers;
  if (gap.attachments) return T.files(gap.attachments);
  return reason ? T.other : null;
}

/** Where the backups stand (`BackupHeroState`), from the service's status and what this screen just did. */
export function backupHeroState(
  input: Pick<BackupHeroInput, 'status' | 'running' | 'justNow'>,
): BackupHeroState {
  const s = input.status;
  if (input.running || s?.running?.op === 'checkpoint') return 'running';
  if (s?.state === 'failing') return 'failing';
  if (s?.state === 'stale') return 'behind';
  if (input.justNow) return 'justNow';
  return s?.lastSuccess ? 'ok' : 'none';
}

/** “Can be brought back”: `ready`, or `paper_only` (a paper copy of the current details). */
export function canBeBroughtBack(
  bringBack: Pick<BackupBringBack, 'state' | 'setup'> | null | undefined,
): boolean {
  return (
    (bringBack?.state === 'ready' && (!bringBack.setup || bringBack.setup === 'verified')) ||
    bringBack?.state === 'paper_only'
  );
}

/**
 * Whether Backups and the Overview ask for the passkey's touch: while the Whombat has backups and no passkey holds their
 * key (`needs_passkey`). One rule for the web and the phone; a Whombat from before the passkey doesn't say, and nothing
 * is asked there.
 */
export function backupPasskeyAsked(summary: Pick<BackupStatus, 'bringBack'> | null | undefined): boolean {
  const b = summary?.bringBack;
  return b?.setup === 'verify' || (b?.state === 'needs_passkey' && b.setup !== 'saving');
}

/**
 * The top card: the answer to “am I safe?” and the settings in plain words. While the backup service isn't answering
 * the card keeps what it knows (the service's last word, else when the Whombat last said a backup finished), says the
 * notice and offers *Ask {assistant} to fix it*; without the service's word its shield says it can't tell.
 */
export function backupHero(input: BackupHeroInput): BackupHero {
  const T = BACKUP_OPTIONS_TEXT;
  const now = input.now ?? new Date();
  const notice = input.notice?.trim() ? sentence(input.notice) : null;
  const heroState = notice && !input.status && !input.running ? 'unknown' : backupHeroState(input);
  // A Whombat just brought back has made none of its own yet, but its list holds the backups it came back from: the
  // service says it has none, and nothing is wrong, so the card says when the newest of those was.
  const listed =
    heroState === 'none' && input.status ? (input.list?.checkpoints[0]?.createdAt ?? null) : null;
  const state: BackupHeroState = listed ? 'ok' : heroState;
  const last = input.status?.lastSuccess?.at ?? listed ?? (notice ? (input.lastKnownAt ?? null) : null);
  // A failing backup must not read as “Backed up 3 days ago” under a green shield: that is the one thing to know.
  const title =
    state === 'running'
      ? T.running
      : state === 'failing'
        ? T.failing
        : state === 'behind'
          ? T.behind
          : state === 'justNow'
            ? T.justNow
            : last
              ? T.backedUp(ago(last))
              : state === 'unknown'
                ? T.unknown
                : T.notYet;
  const reason = input.status?.lastFailure?.reason ?? '';
  const finished = last ? T.lastFinished(ago(last)) : T.noneFinished;
  const problem =
    [
      state === 'failing'
        ? [sentence(reason), finished].filter(Boolean).join(' ')
        : state === 'behind'
          ? finished
          : null,
      notice,
    ]
      .filter(Boolean)
      .join(' ') || null;
  const oldest = input.list?.checkpoints.at(-1)?.createdAt ?? null;
  const sub = [
    input.placeName ? T.on(input.placeName) : null,
    input.policy ? T.next(hhmm(nextBackupAt(input.policy, now))) : null,
    oldest ? T.oldest(longDate(oldest)) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const chips: BackupHeroChip[] = [];
  if (input.policy) {
    chips.push({ text: T.chips.frequency[input.policy.frequency] });
    const choice = keepChoice(input.policy.keep);
    chips.push({
      text:
        choice === 'year'
          ? T.chips.keptYear
          : choice === 'days90'
            ? T.chips.kept90
            : T.chips.keptFor(keepSpan(input.policy.keep).replace(/^up to /, '')),
    });
  }
  const used = input.list?.space?.usedBytes ?? null;
  if (used !== null) {
    const free = input.list?.space?.freeBytes ?? null;
    chips.push({ text: T.chips.space(formatBytes(used), free === null ? null : formatBytes(free)) });
  }
  const drill = input.status?.recoverability.lastDrill ?? null;
  if (drill) {
    const day = relativeDay(drill.at, now);
    chips.push(
      drill.ok ? { text: T.chips.checked(day), dot: 'ok' } : { text: T.chips.checkFailed(day), dot: 'bad' },
    );
  }
  const bringBack = input.summary?.bringBack ?? null;
  const incomplete = input.summary?.incomplete ?? input.status?.lastSuccess?.incomplete ?? null;
  return {
    state,
    title,
    sub,
    chips,
    tone:
      state === 'failing' ? 'bad' : state === 'behind' || notice ? 'warn' : state === 'none' ? 'mut' : 'ok',
    problem,
    askFix: state === 'failing' || state === 'behind' || notice !== null,
    leftOut: incomplete ? plainLeftOut(incomplete) : null,
    wayBackReady: canBeBroughtBack(bringBack),
    wayBack:
      bringBack?.setup === 'saving'
        ? 'Your backup details are being saved.'
        : bringBack?.setup === 'verify'
          ? 'Passkey setup isn’t finished.'
          : bringBack?.state === 'ready'
            ? T.wayBack.ready
            : bringBack?.state === 'paper_only'
              ? T.wayBack.paper
              : null,
    askPasskey: backupPasskeyAsked(input.summary),
  };
}

/**
 * Which Backups page a Whombat gets: `yes` where it lists its backups; `down` where it does but the backup service isn't
 * answering now (the overview's `notice`: the same page, saying so and keeping what it knows); `no` on a box from before
 * or one without backups (what it showed before); `loading` while that isn't known. `notice` is undefined until the
 * overview answered. One rule for the web and the phone.
 */
export type BackupPageShown = 'loading' | 'yes' | 'down' | 'no';
export function backupPageShown(input: {
  list: { pending: boolean; failed: boolean };
  policy: { pending: boolean; failed: boolean };
  notice: string | null | undefined;
}): BackupPageShown {
  const failed = input.list.failed || input.policy.failed;
  if (failed && input.notice === undefined) return 'loading';
  if (failed) return input.notice ? 'down' : 'no';
  if (input.list.pending || input.policy.pending) return 'loading';
  return input.notice ? 'down' : 'yes';
}

/** The quiet line under the list about older backups on the places used before; null when there were none. */
export function earlierPlacesLine(places: readonly { name: string }[] | null | undefined): string | null {
  const names = [...new Set((places ?? []).map((p) => p.name))];
  return names.length ? BACKUP_OPTIONS_TEXT.list.earlierPlaces(andList(names)) : null;
}

/** What *Ask {assistant} to fix it* on the card says: what is wrong, then the ask (as the Inbox's own button does). */
export function backupFixText(hero: Pick<BackupHero, 'title' | 'problem'>): string {
  return [hero.title, hero.problem, 'Can you fix it?'].filter(Boolean).join('\n');
}

/* The list ---------------------------------------------------------------------------------------------------- */

export interface BackupRow {
  id: string;
  /** “15:00” today and yesterday, “Sun 25 Oct” earlier. */
  time: string;
  label: string;
  /** “+41 MB”, or the whole size for the first backup. */
  size: string;
  check: 'ok' | 'bad' | null;
  /** It was made with a gap (what it left out is on its page). */
  leftOut: boolean;
  checkpoint: BackupCheckpoint;
}

export interface BackupGroup {
  key: 'today' | 'yesterday' | 'later';
  label: string;
  /** The thinning line under LATER ON. */
  note: string | null;
  rows: BackupRow[];
}

/** What a backup is, in words (“Scheduled”, “You asked”, “Before the update to 0.198”, “First backup”). */
export function backupLabel(cp: BackupCheckpoint, isFirst: boolean): string {
  const L = BACKUP_OPTIONS_TEXT.list;
  if (isFirst) return L.first;
  if (cp.reason === 'pre-migration') {
    const v = cp.releaseId?.match(/\d+\.\d+(?:\.\d+)?/)?.[0];
    return v ? L.beforeUpdate(v) : L.reasons['pre-migration'];
  }
  return L.reasons[cp.reason];
}

/**
 * The first backup of each Whombat in a list (its oldest), so one brought back still calls the earlier one's first backup
 * “First backup”. Only for a list read to its start: a page that goes on doesn't hold the first.
 */
export function firstBackups(list: {
  checkpoints: readonly Pick<BackupCheckpoint, 'id' | 'applianceId' | 'own'>[];
  nextCursor?: string | null;
}): Set<string> {
  const firsts = new Map<string, string>();
  if (list.nextCursor) return new Set();
  // This box's own apart from any earlier Whombat's, whatever ids they carry.
  for (const cp of list.checkpoints) firsts.set(cp.own ? '(own)' : cp.applianceId, cp.id);
  return new Set(firsts.values());
}

/** The list grouped as the page shows it (newest first); `limit` rows in all unless `all`. */
export function backupGroups(
  list: BackupCheckpointsOutput,
  keep: BackupKeep | null,
  options: { now?: Date; limit?: number } = {},
): BackupGroup[] {
  const now = options.now ?? new Date();
  const L = BACKUP_OPTIONS_TEXT.list;
  const today = dayKey(now);
  const yd = new Date(now);
  yd.setDate(yd.getDate() - 1);
  const yesterday = dayKey(yd);
  const firsts = firstBackups(list);
  const groups: BackupGroup[] = [
    { key: 'today', label: L.today, note: null, rows: [] },
    { key: 'yesterday', label: L.yesterday, note: null, rows: [] },
    { key: 'later', label: L.later, note: keep ? thinnedLine(keep) || null : null, rows: [] },
  ];
  let n = 0;
  for (const cp of list.checkpoints) {
    if (options.limit !== undefined && n >= options.limit) break;
    const d = new Date(cp.createdAt);
    const k = dayKey(d);
    const group = k === today ? groups[0] : k === yesterday ? groups[1] : groups[2];
    const isFirst = firsts.has(cp.id);
    const added = cp.bytesAdded;
    group?.rows.push({
      id: cp.id,
      time: group.key === 'later' ? shortDay(cp.createdAt) : hhmm(d),
      label: backupLabel(cp, isFirst),
      size: isFirst || added === null ? formatBytes(added ?? cp.bytes) : `+${formatBytes(added)}`,
      check: cp.check ? (cp.check.ok ? 'ok' : 'bad') : null,
      leftOut: !!cp.incomplete && (!!cp.incomplete.attachments || !!cp.incomplete.servers),
      checkpoint: cp,
    });
    n++;
  }
  return groups.filter((g) => g.rows.length > 0);
}

/* One backup's “What’s in it” ------------------------------------------------------------------------------------- */

export interface BackupContentsRow {
  key: string;
  text: string;
  note?: string;
  covered: boolean;
  /** Something of it was left out of this backup (a gap, said plainly in `note`). */
  gap?: boolean;
}

/** Each line and the coverage classes (`BackupScope`) behind it. */
const CONTENT_SCOPES: Record<string, readonly string[]> = {
  conversations: ['database', 'memory', 'packs'],
  files: ['attachments'],
  projects: ['workspaces', 'home'],
  servers: ['servers'],
  settings: ['configuration'],
  signIns: ['provider-sessions'],
};

/**
 * “What’s in it” from the backup's own coverage (`covered`, from its signed manifest) and what it left out
 * (`incomplete`). A backup service that doesn't list it yet: what every backup holds. The servers' line shows only where
 * the Whombat backs servers up. Wi-Fi, Bluetooth and voices are never in a backup, worded as the done screen says them.
 */
export function backupContents(cp: Pick<BackupCheckpoint, 'covered' | 'incomplete'>): BackupContentsRow[] {
  const L = BACKUP_OPTIONS_TEXT.detail.lines;
  const covered = cp.covered ? new Set(cp.covered) : null;
  const has = (key: string) => !covered || (CONTENT_SCOPES[key] ?? []).some((id) => covered.has(id));
  const missing = cp.incomplete?.attachments ?? 0;
  const rows: BackupContentsRow[] = [
    { key: 'conversations', text: L.conversations, covered: has('conversations') },
    missing > 0
      ? { key: 'files', text: L.files, note: L.filesMissing(missing), covered: has('files'), gap: true }
      : { key: 'files', text: L.files, covered: has('files') },
    { key: 'projects', text: L.projects, note: L.projectsNote, covered: has('projects') },
  ];
  if (cp.incomplete?.servers)
    rows.push({ key: 'servers', text: L.servers, note: L.serversMissing, covered: false, gap: true });
  else if (!covered || covered.has('servers')) rows.push({ key: 'servers', text: L.servers, covered: true });
  rows.push(
    { key: 'settings', text: L.settings, covered: has('settings') },
    { key: 'signIns', text: L.signIns, note: L.signInsNote, covered: has('signIns') },
    { key: 'network', text: L.network, note: L.networkNote, covered: false },
    { key: 'voices', text: L.voices, note: L.voicesNote, covered: false },
  );
  return rows;
}

/* Details --------------------------------------------------------------------------------------------------------- */

/**
 * Backups' less-used details, folded under “Details”: where they are kept, who clears old ones, and that they can't be
 * deleted from here (one phrase, for a place that refuses the box's deletes).
 */
export function backupDetailLines(input: {
  status: BackupServiceStatus | null;
  clearedBy: 'place' | 'box' | 'none' | null;
  placeName: string | null;
}): string[] {
  const D = BACKUP_OPTIONS_TEXT.details;
  const display = input.status?.destination.display?.trim() || null;
  const where =
    input.placeName && display && display !== input.placeName
      ? `${input.placeName} (${display})`
      : (input.placeName ?? display);
  return [
    where ? D.where(where) : null,
    input.clearedBy === 'place'
      ? D.clears.place(input.placeName)
      : input.clearedBy === 'box'
        ? D.clears.box
        : input.clearedBy === 'none'
          ? D.clears.none
          : null,
    input.status?.destination.appendOnly === 'verified' ? `${D.noDelete}.` : null,
  ].filter((l): l is string => l !== null);
}

/* Bringing back a Whombat you had, later ------------------------------------------------------------------------- */

/** How long a Whombat that started fresh still offers “Bring back a Whombat you had”. */
export const BRING_BACK_LATER_DAYS = 7;

/**
 * Whether Backups offers “Bring back a Whombat you had” (Whombat backup-options.md BKO-29): while this Whombat started
 * fresh — no backups set up, none of its own yet, or only a few days of them — and it didn't come back from one already.
 * A mistaken “Start fresh” isn't final.
 */
export function bringBackLaterOffered(input: {
  list: Pick<BackupCheckpointsOutput, 'checkpoints' | 'total' | 'nextCursor'> | null;
  /** No place set up: nothing listed yet. */
  unprotected: boolean;
  now?: Date;
}): boolean {
  if (input.unprotected) return true;
  const list = input.list;
  if (!list) return false;
  // Brought back already: its list holds the earlier Whombat's backups.
  if (list.checkpoints.some((c) => !c.own)) return false;
  if (list.nextCursor) return false;
  const own = list.checkpoints.filter((c) => c.own);
  const oldest = own.at(-1)?.createdAt;
  if (!oldest) return true;
  const now = input.now ?? new Date();
  return now.getTime() - Date.parse(oldest) < BRING_BACK_LATER_DAYS * 86_400_000;
}

/* The options dialog ------------------------------------------------------------------------------------------ */

/**
 * About how much the backups take with a policy: the newest backup's size once, plus what a day adds over the
 * policy's longest window (restic keeps a block once however many backups name it). Null without a week of history.
 */
export function estimateBytes(list: BackupCheckpointsOutput | null, keep: BackupKeep): number | null {
  if (!list || list.checkpoints.length < 2) return null;
  const own = list.checkpoints.filter((c) => c.own && c.bytesAdded !== null);
  if (own.length < 2) return null;
  const newest = own[0] as BackupCheckpoint;
  const oldest = own.at(-1) as BackupCheckpoint;
  const days = Math.max(1, (Date.parse(newest.createdAt) - Date.parse(oldest.createdAt)) / 86_400_000);
  const added = own.slice(0, -1).reduce((s, c) => s + (c.bytesAdded ?? 0), 0);
  const perDay = added / days;
  const base =
    (list.space?.usedBytes ?? 0) > 0 ? Math.min(list.space?.usedBytes ?? 0, newest.bytes) : newest.bytes;
  return Math.round(base + perDay * keepDays(keep));
}

/** The dialog's top line: how far back and about how much space. */
export function policySummary(
  keep: BackupKeep,
  list: BackupCheckpointsOutput | null,
  placeName: string | null,
): string {
  const est = estimateBytes(list, keep);
  const free = list?.space?.freeBytes ?? null;
  return BACKUP_OPTIONS_TEXT.dialog.summary(
    keepSpan(keep),
    est === null ? null : formatBytes(roundEstimate(est)),
    placeName,
    free === null ? null : formatBytes(free),
  );
}

/** “About 20 GB”, not “19.37 GB”. */
function roundEstimate(bytes: number): number {
  const gb = bytes / 1e9;
  if (gb >= 10) return Math.round(gb / 5) * 5e9;
  if (gb >= 1) return Math.round(gb) * 1e9;
  return Math.max(1e8, Math.round(bytes / 1e8) * 1e8);
}

/** The timeline's ticks, 0…1 left to right: denser towards now (the dialog's picture of thinning). */
export function keepTicks(keep: BackupKeep): { at: number; tall: boolean }[] {
  const ticks: { at: number; tall: boolean }[] = [];
  const seg = (a: number, b: number, n: number, tall = false) => {
    for (let i = 0; i < n; i++) ticks.push({ at: a + ((b - a) * (i + 0.5)) / n, tall });
  };
  if (keep.monthlyMonths > 2) seg(0, 0.38, Math.min(12, keep.monthlyMonths - 2));
  if (keep.weeklyWeeks > 2) seg(0.38, 0.62, Math.min(8, keep.weeklyWeeks - 2));
  if (keep.dailyDays > 2) seg(0.62, 0.86, Math.min(14, keep.dailyDays - 2));
  seg(0.86, 1, Math.min(8, Math.max(2, keep.allDays * 4)), true);
  return ticks;
}

/* Choosing the backup to bring back ------------------------------------------------------------------------------ */

/**
 * The backups in a list made by a Whombat after another took its place: a Whombat brought back from it backs up to the
 * same backups from then on, so its first backup there marks when the old one was replaced. What the old one made after
 * that came from a box that was lost, stolen or switched off. Ids, of a list in any order.
 */
export function madeAfterReplaced(
  checkpoints: readonly Pick<BackupCheckpoint, 'id' | 'applianceId' | 'createdAt'>[],
): Set<string> {
  const firstAt = new Map<string, number>();
  for (const cp of checkpoints) {
    const at = Date.parse(cp.createdAt);
    const had = firstAt.get(cp.applianceId);
    if (had === undefined || at < had) firstAt.set(cp.applianceId, at);
  }
  const out = new Set<string>();
  for (const cp of checkpoints) {
    const mine = firstAt.get(cp.applianceId) ?? 0;
    // Replaced when a Whombat that came after this one made its first backup here.
    let replaced = Number.POSITIVE_INFINITY;
    for (const at of firstAt.values()) if (at > mine && at < replaced) replaced = at;
    if (Date.parse(cp.createdAt) > replaced) out.add(cp.id);
  }
  return out;
}

/** The backup a bring back picks first: the newest one not made after its Whombat was replaced (else the newest). */
export function backupToBringBack(
  checkpoints: readonly Pick<BackupCheckpoint, 'id' | 'applianceId' | 'createdAt'>[],
): string | null {
  const late = madeAfterReplaced(checkpoints);
  const newest = [...checkpoints].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return (newest.find((cp) => !late.has(cp.id)) ?? newest[0])?.id ?? null;
}

/**
 * The done screen's lines about the old Whombat: switched off (it can't reach the account once this one said where it
 * came from); and after “lost or stolen” on a place Whombat can't give a new password, that the person changes it.
 */
export function oldWhombatDoneLines(
  state: Pick<BackupRestoreState, 'items' | 'oldApplianceId' | 'newPassword'> | null,
  name: string,
): string[] {
  const B = BACKUP_OPTIONS_TEXT.bringBack;
  const lost = state?.items.find((i) => i.id === 'old-appliance')?.resolution === 'credentials-rotated';
  return [
    ...(state?.oldApplianceId ? [B.doneOldOff(name)] : []),
    ...(lost && state?.newPassword?.by === 'you' ? [B.donePassword(state.newPassword.place)] : []),
  ];
}

/** The question's words about the old Whombat: they promise a new password only where Whombat can give one. */
export function oldWhombatMeta(
  answer: 'gone' | 'lost' | null,
  newPassword: BackupRestoreState['newPassword'] | null | undefined,
): string {
  const B = BACKUP_OPTIONS_TEXT.bringBack;
  const yours = newPassword?.by === 'you';
  if (answer === 'lost') return yours ? B.oldLostMetaYou(newPassword?.place ?? null) : B.oldLostMeta;
  return yours ? B.oldGoneMetaYou : B.oldGoneMeta;
}

/* The restore ------------------------------------------------------------------------------------------------- */

/** The steps of the “Bringing … back” screen and which is going. */
export function restoreSteps(
  state: BackupRestoreState | null,
  runtimeReachable: boolean,
  place: string | null,
): { text: string; state: 'done' | 'running' | 'queued' }[] {
  const S = BACKUP_OPTIONS_TEXT.bringBack.steps;
  const stage = state?.stage ?? null;
  const order = ['check', 'copy', 'put', 'servers'] as const;
  let at = 0;
  if (!runtimeReachable) at = 1;
  if (stage === 'prepare' || stage === 'check') at = 0;
  if (stage === 'restore') at = 1;
  if (stage === 'database' || stage === 'release') at = 2;
  if (stage === 'start' || state?.phase === 'checking' || state?.phase === 'released') at = 3;
  if (state?.phase === 'checking' || state?.phase === 'released') at = 4;
  return order.map((k, i) => ({
    text: k === 'copy' ? S.copy(place) : S[k],
    state: i < at ? 'done' : i === at ? 'running' : 'queued',
  }));
}

/** The providers to sign in to again, by name (“Claude and GitHub”). */
export function reloginNames(relogin: readonly string[]): string[] {
  const names: Record<string, string> = {
    claude: 'Claude',
    anthropic: 'Claude',
    codex: 'Codex',
    openai: 'Codex',
    github: 'GitHub',
    google: 'Google',
  };
  const out = new Set<string>();
  for (const r of relogin) {
    const provider = r.split('/').at(-1)?.toLowerCase() ?? '';
    out.add(names[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1));
  }
  return [...out];
}

/** “Claude and GitHub”, “Claude, Codex and GitHub”. */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}
