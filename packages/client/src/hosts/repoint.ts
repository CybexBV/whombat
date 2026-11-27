/**
 * Point them here (contracts 0.117, CT-910…CT-914; Whombat backup-file.md BF-15, BF-16; app backup-file.md AP-4415…):
 * what the dialog Needs you's “Point them here” opens shows (`/things/servers?repoint=1`, which goes to Connections) —
 * this Whombat's address changed and these servers haven't found it (`hosts.addressChange`) — and, once the person
 * says so, the repoint job's progress per server (`hosts.repoint`, `hosts.getRepoint`): Pointed here, or Needs a
 * password with “Point it here”, which opens Add a server filled in with its address. Every word is the contracts'
 * (`HOST_REPOINT_WORDS`, `hostsAddressChangeText`) except the few in `REPOINT_TEXT`. Pure: the web's dialog and Android's
 * screen read the same.
 */
import { backupServersSummaryLines } from '@whombat/core/backup';
import {
  HOST_REPOINT_MAX,
  type HostAddressChange,
  type HostRepoint,
  type HostRepointServerState,
  hostInstallErrorText,
  hostRepointWords,
  hostsAddressChangeText,
} from '@whombat/core/domain';
import { clientTree } from '../i18n/catalog';
import { HOSTS_REPOINT_WORDS } from '../i18n/messages/connectionsHosts/hostsBasics';

/** The query that opens the dialog (BF-16's Needs you item: `/things/servers?repoint=1`). */
export const REPOINT_QUERY = 'repoint' as const;

/** Whether an address's query asks for the dialog (`?repoint=1`). */
export function repointRequested(search: Record<string, unknown>): boolean {
  const v = search[REPOINT_QUERY];
  return v === '1' || v === 1 || v === true;
}

/**
 * Words the contracts leave to the app: `nothing` when every server found it (or the change is old), `hide` to close
 * the dialog while the job runs (Whombat carries on), `done`.
 */
export function repointText(locale?: string | null) {
  return { ...clientTree(locale, HOSTS_REPOINT_WORDS) };
}

export const REPOINT_TEXT = repointText('en');

export type RepointTone = 'ok' | 'warn' | 'bad' | 'mut';

/** One server in the dialog: its name and address, then how pointing it went. */
export interface RepointRow {
  id: string;
  name: string;
  /** Its own address as people read it; null when the hosts service doesn't know it. */
  address: string | null;
  /** Its state in the job; null before Point them here. */
  state: HostRepointServerState | null;
  /** “Pointing it here…”, “Pointed here”, “Needs a password”, “Didn’t work”; null before Point them here. */
  stateText: string | null;
  tone: RepointTone | null;
  /** Under it: what to do without a key (“Your Vault has no key for it. …”), or why it didn't work. */
  line: string | null;
  /**
   * “Point it here” (AP-4416): Add a server filled in with its address (empty when unknown), for a server without a Vault
   * key for it or whose sign-in didn't work; null otherwise.
   */
  addServer: { address: string } | null;
}

const TONES: Record<HostRepointServerState, RepointTone> = {
  waiting: 'mut',
  pointing: 'mut',
  pointed: 'ok',
  no_key: 'warn',
  failed: 'bad',
};

/** The servers as the dialog lists them: the job's when there is one, else the address change's waiting ones. */
export function repointRows(
  change: Pick<HostAddressChange, 'waiting'> | null | undefined,
  job: Pick<HostRepoint, 'servers'> | null | undefined,
  locale?: string | null,
): RepointRow[] {
  const words = hostRepointWords(locale);
  if (job)
    return job.servers.map((s) => {
      const byHand = s.state === 'no_key' || s.state === 'failed';
      return {
        id: s.id,
        name: s.name,
        address: s.address,
        state: s.state,
        stateText: words.states[s.state],
        tone: TONES[s.state],
        line:
          s.state === 'no_key'
            ? words.noKey
            : s.state === 'failed'
              ? s.error?.message ||
                (s.error
                  ? hostInstallErrorText(s.error.code, { address: s.address ?? s.name, name: s.name }, locale)
                  : null)
              : null,
        addServer: byHand ? { address: s.address ?? '' } : null,
      };
    });
  return (change?.waiting ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    address: s.address,
    state: null,
    stateText: null,
    tone: null,
    line: null,
    addServer: null,
  }));
}

/**
 * What the dialog shows: `loading` (the address change is being read), `nothing` (no server is waiting any more),
 * `ask` (the change and its servers, with Point them here · Leave them), `running` (the job, server by server), `done`.
 */
export type RepointStep = 'loading' | 'nothing' | 'ask' | 'running' | 'done';

export interface RepointView {
  step: RepointStep;
  /** “Point them here”, “Point it here” for one server. */
  title: string;
  /** BF-16's sentence (“Your Whombat’s address changed from … to …, and 5 servers haven’t found it yet.”); null if unknown. */
  lead: string | null;
  rows: RepointRow[];
  /** When the job is done and pointed some: “Pointed 3 servers here.” (the restore summary's words); null otherwise. */
  outcome: string | null;
  /** The servers Point them here sends (`HostRepointBody.servers`, at most `HOST_REPOINT_MAX`). */
  servers: string[];
}

/**
 * The dialog from the address change (`undefined` while it is read, null when there is nothing to say) and the job
 * started from it (null before).
 */
export function repointView(
  change: HostAddressChange | null | undefined,
  job: HostRepoint | null | undefined,
  locale?: string | null,
): RepointView {
  const rows = repointRows(change, job, locale);
  const words = hostRepointWords(locale);
  const count = job ? job.servers.length : (change?.waiting.length ?? 0);
  const title = count === 1 ? words.pointItHere : words.pointThemHere;
  const lead = change && change.waiting.length > 0 ? hostsAddressChangeText(change, locale) : null;
  const servers = (change?.waiting ?? []).slice(0, HOST_REPOINT_MAX).map((s) => s.id);
  if (job) {
    const done = job.state === 'done';
    const pointed = job.servers.filter((s) => s.state === 'pointed').length;
    return {
      step: done ? 'done' : 'running',
      title,
      lead,
      rows,
      outcome: done ? (backupServersSummaryLines({ back: 0, pointed }, locale)[0] ?? null) : null,
      servers,
    };
  }
  if (change === undefined) return { step: 'loading', title, lead: null, rows, outcome: null, servers };
  if (!change || change.waiting.length === 0)
    return {
      step: 'nothing',
      title,
      lead: repointText(locale).nothing,
      rows: [],
      outcome: null,
      servers: [],
    };
  return { step: 'ask', title, lead, rows, outcome: null, servers };
}

/** A screen reader's name for a server row: “pve-01, 10.100.1.20. Needs a password. Your Vault has no key for it. …”. */
export function repointRowLabel(row: RepointRow): string {
  return [[row.name, row.address].filter(Boolean).join(', '), row.stateText, row.line]
    .filter((part): part is string => !!part)
    .join('. ');
}
