/**
 * The phone's backup options, the list of backups, the recovery kit locked with a passkey and bringing a Whombat back
 * (Whombat docs/decisions/backup-options.md; app docs/app/decisions/backup-options-android.md): what the screens decide,
 * kept pure so it is unit-tested in Node. The words are the shared `BACKUP_OPTIONS_TEXT`; the few the phone needs
 * beyond them are `BACKUP_PHONE_TEXT` (AP-6852).
 */
import {
  BACKUP_OPTIONS_TEXT,
  backupLabel,
  backupToBringBack,
  bringBackName,
  type ControlApi,
  firstBackups,
  keepChoice,
  longDate,
  madeAfterReplaced,
  type Passkey,
  relativeDay,
} from '@whombat/client/managed';
import {
  BACKUP_KEEP_90_DAYS,
  BACKUP_KEEP_YEAR,
  BACKUP_LIMIT_MIN_BYTES,
  type BackupCheckpoint,
  type BackupFrequency,
  type BackupKeep,
  type BackupPolicy,
  type BackupRestoreState,
  type BackupSetPolicyInput,
} from '@whombat/protocol/session';
import { encode } from 'uqr';

/** A passkey-locked kit as control keeps it. */
export type KitEnvelope = Awaited<ReturnType<ControlApi['kitEnvelopes']>>[number];

/** Words the phone needs that the shared text doesn't have (AP-6852). */
export const BACKUP_PHONE_TEXT = {
  back: 'Back',
  saved: (date: string) => `Saved ${date}`,
  keepFieldsError: 'Each number is a whole number; “Every backup for” is at least 1 day.',
  limitError: 'The space limit is at least 1 GB.',
  printFailed: 'The kit couldn’t be opened for printing. Save it as a file instead.',
  fileFailed: 'The kit couldn’t be saved. Try again.',
  waiting: (name: string) => `Waiting for ${name} to answer…`,
} as const;

/* The options dialog ------------------------------------------------------------------------------------------ */

export type KeepChoice = 'year' | 'days90' | 'custom';

/** What the options screen edits: numbers as typed, so a half-typed field isn't lost. */
export interface PolicyDraft {
  frequency: BackupFrequency;
  keep: KeepChoice;
  custom: { allDays: string; dailyDays: string; weeklyWeeks: string; monthlyMonths: string };
  limitOn: boolean;
  limitGb: string;
  weeklyCheck: boolean;
}

export function policyDraft(policy: BackupPolicy): PolicyDraft {
  const k = policy.keep;
  return {
    frequency: policy.frequency,
    keep: keepChoice(k),
    custom: {
      allDays: String(k.allDays),
      dailyDays: String(k.dailyDays),
      weeklyWeeks: String(k.weeklyWeeks),
      monthlyMonths: String(k.monthlyMonths),
    },
    limitOn: policy.limitBytes !== null,
    // Without a limit the field starts at what a year about takes, rounded (the person changes it).
    limitGb: policy.limitBytes === null ? '' : String(Math.round(policy.limitBytes / 1e9)),
    weeklyCheck: policy.weeklyCheck,
  };
}

function whole(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** The keep a draft says (the custom fields only when they all read), or null. */
export function draftKeep(draft: PolicyDraft): BackupKeep | null {
  if (draft.keep === 'year') return BACKUP_KEEP_YEAR;
  if (draft.keep === 'days90') return BACKUP_KEEP_90_DAYS;
  const allDays = whole(draft.custom.allDays, 1, 3650);
  const dailyDays = whole(draft.custom.dailyDays, 0, 3650);
  const weeklyWeeks = whole(draft.custom.weeklyWeeks, 0, 520);
  const monthlyMonths = whole(draft.custom.monthlyMonths, 0, 240);
  if (allDays === null || dailyDays === null || weeklyWeeks === null || monthlyMonths === null) return null;
  return { allDays, dailyDays, weeklyWeeks, monthlyMonths };
}

/** Save's input, or what is wrong with the draft. */
export function draftInput(draft: PolicyDraft): { input: BackupSetPolicyInput } | { error: string } {
  const keep = draftKeep(draft);
  if (!keep) return { error: BACKUP_PHONE_TEXT.keepFieldsError };
  let limitBytes: number | null = null;
  if (draft.limitOn) {
    const gb = Number(draft.limitGb.trim().replace(',', '.'));
    if (!Number.isFinite(gb) || gb * 1e9 < BACKUP_LIMIT_MIN_BYTES)
      return { error: BACKUP_PHONE_TEXT.limitError };
    limitBytes = Math.round(gb * 1e9);
  }
  return {
    input: { frequency: draft.frequency, keep, limitBytes, weeklyCheck: draft.weeklyCheck },
  };
}

/* One backup -------------------------------------------------------------------------------------------------- */

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** “Today, 03:00”, “Yesterday, 21:00”, “Sunday, 03:00”, “25 October, 03:00”. */
export function backupTitle(iso: string, now = new Date()): string {
  const day = relativeDay(iso, now);
  return `${day.charAt(0).toUpperCase()}${day.slice(1)}, ${hhmm(new Date(iso))}`;
}

/** A row of the bringing-back list: title, its line (“7 hours ago · checked: it restores”, or why it was made). */
export function chooseRows(
  checkpoints: readonly BackupCheckpoint[],
  now = new Date(),
): { id: string; title: string; meta: string; newest: boolean; afterReplaced: boolean }[] {
  const firsts = firstBackups({ checkpoints, nextCursor: null });
  const late = madeAfterReplaced(checkpoints);
  const pick = backupToBringBack(checkpoints);
  return checkpoints.map((cp) => {
    const label = backupLabel(cp, firsts.has(cp.id) && checkpoints.length > 1);
    const ok = cp.check?.ok === true ? BACKUP_OPTIONS_TEXT.list.checkedOk.toLowerCase() : null;
    const why = cp.reason === 'scheduled' ? null : label;
    const replaced = late.has(cp.id) ? BACKUP_OPTIONS_TEXT.bringBack.afterReplaced : null;
    return {
      id: cp.id,
      title: backupTitle(cp.createdAt, now),
      meta: [why ?? agoAt(cp.createdAt, now), replaced, ok].filter(Boolean).join(' · '),
      // NEWEST marks the one picked first: never one the old Whombat made after it was replaced.
      newest: cp.id === pick,
      afterReplaced: late.has(cp.id),
    };
  });
}

function agoAt(iso: string, now: Date): string {
  const s = Math.max(0, (now.getTime() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

/** The backup brought back unless the person picks another: the newest (AP-6862). */
export function defaultCheckpoint(checkpoints: readonly BackupCheckpoint[]): string | null {
  return backupToBringBack(checkpoints);
}

/* The recovery kit -------------------------------------------------------------------------------------------- */

export interface KitWays {
  passkey: boolean;
  print: boolean;
  file: boolean;
}

/** The ticks at the start: your passkey and print (recommended together), the file off; no passkey without PRF. */
export function initialKitWays(prf: boolean): KitWays {
  return { passkey: prf, print: true, file: false };
}

/** The primary button: “Use my passkey” while it is ticked, else “Save”; null when nothing is ticked. */
export function kitPrimary(ways: KitWays): string | null {
  if (ways.passkey) return BACKUP_OPTIONS_TEXT.kit.usePasskey;
  if (ways.print || ways.file) return BACKUP_OPTIONS_TEXT.dialog.save;
  return null;
}

/** This Whombat's passkeys of this account at control (its credential ids, base64url). */
export function kitPasskeyIds(
  passkeys: readonly Pick<Passkey, 'id' | 'appliance'>[],
  appliance: string,
): string[] {
  return passkeys.filter((p) => p.appliance === appliance).map((p) => p.id);
}

/** “3 Nov”. */
export function shortDate(iso: string): string {
  const [day, month] = longDate(iso).split(' ');
  return `${day} ${month?.slice(0, 3) ?? ''}`.trim();
}

/** The account's kits a new Whombat can bring back, for “Is this a new Whombat?”'s note: the newest, by name and day. */
export function foundKitNote(envelope: Pick<KitEnvelope, 'whombatName' | 'createdAt'> | null): string | null {
  if (!envelope) return null;
  return BACKUP_OPTIONS_TEXT.bringBack.found(
    bringBackName(envelope.whombatName),
    longDate(envelope.createdAt),
  );
}

/* The printed kit --------------------------------------------------------------------------------------------- */

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** A QR code as SVG markup (error correction M, a four-module quiet zone), dark on white for printing. */
export function qrSvg(value: string, sizePx = 240): string {
  const qr = encode(value, { ecc: 'M', border: 0 });
  const quiet = 4;
  const total = qr.size + quiet * 2;
  let path = '';
  qr.data.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      path += `M${start + quiet} ${y + quiet}h${x - start}v1h${start - x}z`;
    }
  });
  // A printed page: fixed black on white whatever the phone's theme.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

/**
 * The page the phone shares for printing (AP-6857): the title, the lead, the kit's text and the QR code of its backup
 * section with the line under it. Self-contained HTML; the print dialog of whatever opens it prints it.
 */
export function kitPrintHtml(input: {
  name: string;
  kitText: string;
  qrPayload: string | null;
  /** The sheet's words: the recovery kit's, or the paper copy's (`BACKUP_OPTIONS_TEXT.paper`). */
  words?: { printTitle: (name: string) => string; printLead: string; printScan: string };
}): string {
  const K = input.words ?? BACKUP_OPTIONS_TEXT.kit;
  const qr = input.qrPayload
    ? `<figure>${qrSvg(input.qrPayload)}<figcaption>${escapeHtml(K.printScan)}</figcaption></figure>`
    : '';
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(K.printTitle(input.name))}</title>`,
    '<style>body{font:15px/1.5 system-ui,sans-serif;color:#000;background:#fff;margin:32px;max-width:720px}',
    'h1{font-size:24px;margin:0 0 8px}pre{font:12px/1.45 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;',
    'border:1px solid #999;border-radius:8px;padding:12px}figure{margin:24px 0;text-align:center}',
    'figcaption{font-size:13px;margin-top:8px}</style></head><body>',
    `<h1>${escapeHtml(K.printTitle(input.name))}</h1>`,
    `<p>${escapeHtml(K.printLead)}</p>`,
    qr,
    `<pre>${escapeHtml(input.kitText)}</pre>`,
    '</body></html>',
  ].join('');
}

/* Bringing a Whombat back ------------------------------------------------------------------------------------- */

/** Which screen a restore's state shows. */
export function restoreScreen(state: BackupRestoreState | null): 'working' | 'almost' | 'failed' | 'done' {
  switch (state?.phase) {
    case 'checking':
      return 'almost';
    case 'failed':
      return 'failed';
    case 'released':
      return 'done';
    default:
      return 'working';
  }
}

/** How often the working screen asks how the restore goes (BKO-12), and how long the box may be silent meanwhile. */
export const RESTORE_POLL_MS = 3_000;

/**
 * Where the flow opens on a box where a restore is under way (a reload, the Inbox's Finish or Try again): its screen.
 * From the app (`later`) only a restore that still waits (working, the answer, failed) resumes; right after a claim a
 * finished one is the done screen.
 */
export function bringBackResume(
  state: Pick<BackupRestoreState, 'phase'> | null,
  later: boolean,
): 'working' | 'almost' | 'failed' | 'done' | null {
  switch (state?.phase) {
    case 'restoring':
      return 'working';
    case 'checking':
      return 'almost';
    case 'failed':
      return 'failed';
    case 'released':
      return later ? null : 'done';
    default:
      return null;
  }
}

/** “03:00” of the restored backup (what “back as it was at …” names). */
export function restoredTime(state: BackupRestoreState | null): string {
  const at = state?.restored?.createdAt;
  return at ? hhmm(new Date(at)) : '';
}

/** The Whombat a kit's text names (`Whombat: Home`), or null. */
export function kitWhombatName(text: string): string | null {
  const m = text.match(/^Whombat: (.+)$/m);
  const name = m?.[1]?.trim();
  // A paper copy that names only the device id says no name: “your Whombat”.
  return name && bringBackName(name) === name ? name : null;
}
