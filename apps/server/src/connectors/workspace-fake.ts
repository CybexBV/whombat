/**
 * The fake `GoogleWorkspace` (`WHOMBAT_GOOGLE=fake`: tests and the scripted demo; docs/decisions/connectors.md
 * CN-08): an in-memory mailbox, calendar, drive and contacts for `you@example.com`, seeded with a few
 * believable items dated around now. State is kept per access token (one per connection in fake mode), so
 * tests can read what a tool changed (`stateFor`) and make a service fail (`disable`).
 */
import {
  type CalendarEvent,
  type CalendarEventInput,
  type CalendarEventPatch,
  type ConnectionCheck,
  type ConnectorBinary,
  type ConnectorService,
  type ContactCard,
  type DocEdit,
  type DriveFile,
  EVENT_TIMES_MISMATCH_TEXT,
  eventsWindowStart,
  eventTimesMatch,
  FILE_CONTENT_CAP,
  type FileContent,
  GOOGLE_SCOPES,
  googleEnableApisUrl,
  isReservedMailLabel,
  MAIL_BODY_CAP,
  type MailDraftInput,
  type MailMessage,
  type MailSummary,
  type McpToolInput,
  RESERVED_MAIL_LABEL_TEXT,
  type ShareRole,
  type SheetCell,
  serviceLabel,
} from '@whombat/core';
import { badRequest } from '../lib/errors';
import { attachmentDigest, checkAttachmentTotal } from './binary';
import { capText, htmlToText, replySubject } from './mime';
import {
  type CalendarEventsInput,
  type FilesCreateInput,
  GoogleApiError,
  type GoogleWorkspace,
  type InboxUnread,
  type MailChangesOptions,
  type MailChangesResult,
  type MailDraftView,
  type MailHeader,
  type MailOrganizeInput,
  type MailProviderCursor,
  type MailSearchInput,
} from './types';

export const FAKE_GOOGLE_EMAIL = 'you@example.com';

export interface FakeMail {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** Plain text, or HTML when `html` is set (read as text). */
  body: string;
  html?: boolean;
  date: Date;
  /** Label ids: system (`INBOX`, `UNREAD`, `SENT`) and user labels (`Label_1`). */
  labelIds: string[];
  attachments: { id?: string; name: string; mimeType: string; size: number; contentBase64?: string }[];
  /** `In-Reply-To` of a reply. */
  inReplyTo?: string | null;
  /** Monotonic arrival sequence assigned for fake change-feed polling. */
  mailSeq?: number;
}

export interface FakeDraft {
  attachments?: ConnectorBinary[];
  id: string;
  threadId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  inReplyTo: string | null;
}

export interface FakeEvent extends CalendarEvent {}

export interface FakeFile {
  folderId?: string;
  contentBase64?: string;
  file: DriveFile;
  /** Markdown for docs, CSV for sheets, text for text files; null otherwise. */
  content: string | null;
  trashed: boolean;
  permissions: { email: string; role: ShareRole }[];
}

/** An email the calendar sent to guests (invites go out only after the person approved). */
export interface FakeCalendarMail {
  kind: 'invite' | 'update' | 'cancel';
  eventId: string;
  guests: string[];
}

export interface FakeGoogleState {
  email: string;
  labels: { id: string; name: string }[];
  messages: FakeMail[];
  drafts: FakeDraft[];
  events: FakeEvent[];
  calendarMail: FakeCalendarMail[];
  files: FakeFile[];
  contacts: ContactCard[];
  /** Services whose API is “turned off” (`disable`). */
  disabled: Set<ConnectorService>;
  /** Method names in call order. */
  calls: string[];
  nextId: number;
  /** Monotonic counter for fake mailbox change-feed cursors. */
  mailSeq: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function startOfDayUtc(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const isoAt = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const dateAt = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** A fresh mailbox, calendar, drive and address book, dated around `now`. */
export function seedFakeGoogle(now: Date): FakeGoogleState {
  const t = now.getTime();
  const day = startOfDayUtc(now);
  const me = FAKE_GOOGLE_EMAIL;
  const file = (
    id: string,
    name: string,
    mimeType: string,
    kind: DriveFile['kind'],
    content: string | null,
    modified: number,
    size: number | null = null,
  ): FakeFile => ({
    file: {
      id,
      name,
      kind,
      mimeType,
      modifiedAt: isoAt(modified),
      owners: [me],
      size,
      webUrl: `https://drive.google.com/file/d/${id}/view`,
    },
    content,
    trashed: false,
    permissions: [],
  });
  return {
    email: me,
    labels: [
      { id: 'INBOX', name: 'INBOX' },
      { id: 'UNREAD', name: 'UNREAD' },
      { id: 'SENT', name: 'SENT' },
      { id: 'STARRED', name: 'STARRED' },
      { id: 'IMPORTANT', name: 'IMPORTANT' },
      { id: 'DRAFT', name: 'DRAFT' },
      { id: 'CATEGORY_PROMOTIONS', name: 'CATEGORY_PROMOTIONS' },
      { id: 'Label_1', name: 'Receipts' },
    ],
    messages: [
      {
        id: 'msg_invoice1042',
        threadId: 'thr_invoice1042',
        from: 'Priya Shah <priya@northwind.example>',
        to: [me],
        cc: [],
        bcc: [],
        subject: 'Invoice 1042 for September',
        body: 'Hi,\n\nAttached is invoice 1042 for September’s design work (€2.400,00). Payment terms are 14 days as usual.\n\nThanks!\nPriya',
        date: new Date(t - 2 * HOUR),
        labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'],
        attachments: [{ name: 'invoice-1042.pdf', mimeType: 'application/pdf', size: 48_213 }],
      },
      {
        id: 'msg_lunch',
        threadId: 'thr_lunch',
        from: 'Joris de Vries <joris@example.org>',
        to: [me],
        cc: [],
        bcc: [],
        subject: 'Lunch on Thursday?',
        body: 'Are you free for lunch on Thursday at 12:30? The new place on the Kade has a terrace.\n\nJoris',
        date: new Date(t - 5 * HOUR),
        labelIds: ['INBOX', 'UNREAD'],
        attachments: [],
      },
      {
        id: 'msg_receipt',
        threadId: 'thr_receipt',
        from: 'Hetzner Online <billing@hetzner.example>',
        to: [me],
        cc: [],
        bcc: [],
        subject: 'Your receipt R0019284',
        body: '<html><body><h1>Thank you for your payment</h1><p>Receipt <b>R0019284</b> &middot; €38,68</p><p><a href="https://accounts.hetzner.example/invoices">View your invoices</a></p></body></html>',
        html: true,
        date: new Date(t - DAY - 3 * HOUR),
        labelIds: ['INBOX', 'Label_1'],
        attachments: [],
      },
      {
        id: 'msg_q3',
        threadId: 'thr_q3',
        from: 'Mara Okafor <mara@okafor.example>',
        to: [me],
        cc: ['joris@example.org'],
        bcc: [],
        subject: 'Q3 plan comments',
        body: 'I left a few comments on the Q3 plan. Could you look at the budget part before Friday?\n\nMara',
        date: new Date(t - 2 * DAY),
        labelIds: ['INBOX'],
        attachments: [],
      },
      {
        id: 'msg_newsletter',
        threadId: 'thr_newsletter',
        from: 'The Weekly Burrow <news@burrow.example>',
        to: [me],
        cc: [],
        bcc: [],
        subject: 'Five small tools that save an hour a week',
        body: 'This week: keyboard launchers, a better clipboard, and why your calendar needs buffers.',
        date: new Date(t - 3 * DAY),
        labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
        attachments: [],
      },
      {
        id: 'msg_invoice1041',
        threadId: 'thr_invoice1041',
        from: `You <${me}>`,
        to: ['priya@northwind.example'],
        cc: [],
        bcc: [],
        subject: 'Re: Invoice 1041',
        body: 'Paid today, thanks Priya!',
        date: new Date(t - 8 * DAY),
        labelIds: ['SENT'],
        attachments: [],
      },
    ],
    drafts: [],
    events: [
      {
        id: 'evt_standup',
        calendarId: 'primary',
        summary: 'Standup',
        description: '',
        location: '',
        start: isoAt(day + DAY + 9.5 * HOUR),
        end: isoAt(day + DAY + 9.75 * HOUR),
        allDay: false,
        guests: [
          { email: 'joris@example.org', name: 'Joris de Vries', response: 'accepted' },
          { email: 'priya@northwind.example', name: 'Priya Shah', response: 'needs_action' },
        ],
        organizer: me,
        webUrl: 'https://calendar.google.com/calendar/event?eid=evt_standup',
        meetUrl: 'https://meet.google.com/abc-defg-hij',
      },
      {
        id: 'evt_dentist',
        calendarId: 'primary',
        summary: 'Dentist',
        description: '',
        location: 'Tandartspraktijk Centrum',
        start: isoAt(day + 2 * DAY + 15 * HOUR),
        end: isoAt(day + 2 * DAY + 16 * HOUR),
        allDay: false,
        guests: [],
        organizer: me,
        webUrl: 'https://calendar.google.com/calendar/event?eid=evt_dentist',
        meetUrl: null,
      },
      {
        id: 'evt_q3',
        calendarId: 'primary',
        summary: 'Q3 planning',
        description: 'Go through the Q3 plan and the budget.',
        location: '',
        start: isoAt(day + 3 * DAY + 14 * HOUR),
        end: isoAt(day + 3 * DAY + 15 * HOUR),
        allDay: false,
        guests: [{ email: 'mara@okafor.example', name: 'Mara Okafor', response: 'accepted' }],
        organizer: me,
        webUrl: 'https://calendar.google.com/calendar/event?eid=evt_q3',
        meetUrl: 'https://meet.google.com/qrs-tuvw-xyz',
      },
      {
        id: 'evt_offsite',
        calendarId: 'primary',
        summary: 'Team offsite',
        description: '',
        location: 'Texel',
        start: dateAt(day + 10 * DAY),
        end: dateAt(day + 11 * DAY),
        allDay: true,
        guests: [],
        organizer: me,
        webUrl: 'https://calendar.google.com/calendar/event?eid=evt_offsite',
        meetUrl: null,
      },
    ],
    calendarMail: [],
    files: [
      file(
        'file_q3plan',
        'Q3 plan',
        'application/vnd.google-apps.document',
        'doc',
        '# Q3 plan\n\n## Goals\n\n- Ship invoices v2\n- Hire a second designer\n\n## Budget\n\nSee “Budget 2026”.\n',
        t - 2 * DAY,
      ),
      file(
        'file_budget',
        'Budget 2026',
        'application/vnd.google-apps.spreadsheet',
        'sheet',
        'Item,Q1,Q2,Q3\nDesign,4000,4500,5200\nHosting,320,340,360\nTravel,900,0,1200\n',
        t - 4 * DAY,
      ),
      file(
        'file_notes',
        'Meeting notes.txt',
        'text/plain',
        'text',
        'Kickoff with Northwind\n- invoices monthly\n- next check-in in October\n',
        t - 6 * DAY,
        68,
      ),
      file('file_invoice_pdf', 'Invoice 1042.pdf', 'application/pdf', 'pdf', null, t - 2 * HOUR, 48_213),
    ],
    contacts: [
      {
        name: 'Priya Shah',
        emails: ['priya@northwind.example'],
        phones: ['+31 20 555 0142'],
        organization: 'Northwind',
      },
      { name: 'Joris de Vries', emails: ['joris@example.org'], phones: [], organization: null },
      {
        name: 'Mara Okafor',
        emails: ['mara@okafor.example'],
        phones: ['+31 6 5550 1987'],
        organization: 'Okafor Studio',
      },
      {
        name: 'Hetzner billing',
        emails: ['billing@hetzner.example'],
        phones: [],
        organization: 'Hetzner Online',
      },
    ],
    disabled: new Set(),
    calls: [],
    nextId: 1,
    mailSeq: 0,
  };
}

/* Helpers --------------------------------------------------------------------------------------- */

function notFound(what: string): GoogleApiError {
  return new GoogleApiError(404, `${what} not found.`, 'not_found');
}

const SERVICE_OF: Partial<Record<keyof GoogleWorkspace, ConnectorService>> = {
  mailSearch: 'mail',
  inboxUnread: 'mail',
  mailBaseline: 'mail',
  mailChanges: 'mail',
  mailRead: 'mail',
  mailDraft: 'mail',
  mailGetDraft: 'mail',
  mailSendDraft: 'mail',
  mailOrganize: 'mail',
  mailTrash: 'mail',
  calendarEvents: 'calendar',
  calendarGetEvent: 'calendar',
  calendarCreateEvent: 'calendar',
  calendarUpdateEvent: 'calendar',
  calendarDeleteEvent: 'calendar',
  filesSearch: 'files',
  filesGet: 'files',
  filesRead: 'files',
  filesCreate: 'files',
  filesShare: 'files',
  filesTrash: 'files',
  docsEdit: 'docs',
  sheetsRead: 'sheets',
  sheetsWrite: 'sheets',
  contactsSearch: 'contacts',
};

function disabledError(service: ConnectorService): GoogleApiError {
  return new GoogleApiError(
    403,
    `${serviceLabel(service, 'google')} API has not been used in project 123456 before or it is disabled.`,
    'api_disabled',
    googleEnableApisUrl(),
  );
}

/** Gmail-ish search: `from:`, `to:`, `subject:`, `is:unread|read|starred`, `in:inbox|sent`, `label:`, `newer_than:Nd`, words. */
function matches(m: FakeMail, query: string, labels: FakeGoogleState['labels'], now: Date): boolean {
  const tokens = query.match(/(?:[^\s"]+:"[^"]*"|"[^"]*"|\S+)/g) ?? [];
  const text =
    `${m.from} ${m.to.join(' ')} ${m.subject} ${m.html ? htmlToText(m.body) : m.body}`.toLowerCase();
  for (const raw of tokens) {
    const token = raw.replace(/"/g, '').toLowerCase();
    const [op, ...rest] = token.split(':');
    const value = rest.join(':');
    if (!value) {
      if (!text.includes(token)) return false;
      continue;
    }
    switch (op) {
      case 'from':
        if (!m.from.toLowerCase().includes(value)) return false;
        break;
      case 'to':
        if (!m.to.some((a) => a.toLowerCase().includes(value))) return false;
        break;
      case 'subject':
        if (!m.subject.toLowerCase().includes(value)) return false;
        break;
      case 'is':
        if (value === 'unread' && !m.labelIds.includes('UNREAD')) return false;
        if (value === 'read' && m.labelIds.includes('UNREAD')) return false;
        if (value === 'starred' && !m.labelIds.includes('STARRED')) return false;
        break;
      case 'in':
        if (!m.labelIds.includes(value.toUpperCase())) return false;
        break;
      case 'label': {
        const label = labels.find((l) => l.name.toLowerCase() === value || l.id.toLowerCase() === value);
        if (!label || !m.labelIds.includes(label.id)) return false;
        break;
      }
      case 'newer_than': {
        const n = Number.parseInt(value, 10);
        const unit = value.endsWith('h') ? HOUR : DAY;
        if (Number.isFinite(n) && now.getTime() - m.date.getTime() > n * unit) return false;
        break;
      }
      default:
        if (!text.includes(token)) return false;
    }
  }
  return true;
}

/** Column letters → 0-based index (`A` → 0, `AA` → 26). */
function column(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** A1 range → 0-based bounds (`Sheet1!B2:C3`, `A1`, `A:C`). */
function a1Bounds(range: string): { r0: number; c0: number; r1: number; c1: number } {
  const ref = range.includes('!') ? range.slice(range.lastIndexOf('!') + 1) : range;
  const [a = 'A1', b] = ref.replace(/\$/g, '').split(':');
  const parse = (cell: string, end: boolean) => {
    const m = /^([A-Za-z]*)(\d*)$/.exec(cell) ?? [];
    return {
      c: m[1] ? column(m[1]) : end ? 199 : 0,
      r: m[2] ? Number(m[2]) - 1 : end ? 999 : 0,
    };
  };
  const start = parse(a, false);
  const end = b ? parse(b, true) : start;
  return { r0: start.r, c0: start.c, r1: end.r, c1: end.c };
}

function csvRows(csv: string): string[][] {
  return csv
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => (line ? line.split(',') : []));
}

function cellValue(v: string | undefined): SheetCell {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && v.trim() !== '' ? n : v;
}

/* The adapter ----------------------------------------------------------------------------------- */

export class FakeGoogleWorkspace implements GoogleWorkspace {
  private readonly states = new Map<string, FakeGoogleState>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** The account behind an access token (seeded on first use). */
  stateFor(accessToken: string): FakeGoogleState {
    let state = this.states.get(accessToken);
    if (!state) {
      state = seedFakeGoogle(this.now());
      this.states.set(accessToken, state);
    }
    return state;
  }

  /** Makes a service answer like Google with its API turned off (or on again). */
  disable(accessToken: string, service: ConnectorService, off = true): void {
    const state = this.stateFor(accessToken);
    if (off) state.disabled.add(service);
    else state.disabled.delete(service);
  }

  /** Forgets every account (a fresh seed on next use). */
  reset(): void {
    this.states.clear();
  }

  /** Test helper: delivers a new inbox message into a fake account and assigns it the next sequence number. */
  deliverMail(
    accessToken: string,
    mail: Omit<FakeMail, 'id' | 'threadId' | 'mailSeq' | 'cc' | 'bcc'> & {
      id?: string;
      threadId?: string;
      cc?: string[];
      bcc?: string[];
    },
  ): FakeMail {
    const state = this.stateFor(accessToken);
    this.assignMailSeqs(state);
    const id = mail.id ?? this.id(state, 'msg');
    const created: FakeMail = {
      ...mail,
      cc: mail.cc ?? [],
      bcc: mail.bcc ?? [],
      id,
      threadId: mail.threadId ?? `thr_${id}`,
      mailSeq: ++state.mailSeq,
    };
    state.messages.push(created);
    return created;
  }

  private assignMailSeqs(state: FakeGoogleState): void {
    for (const m of state.messages) {
      if (m.mailSeq === undefined) m.mailSeq = ++state.mailSeq;
    }
  }

  async mailBaseline(accessToken: string, _options?: MailChangesOptions): Promise<MailChangesResult> {
    const state = this.use(accessToken, 'mailBaseline');
    this.assignMailSeqs(state);
    return { cursor: { kind: 'fake', seq: state.mailSeq }, headers: [] };
  }

  async mailChanges(
    accessToken: string,
    cursor: MailProviderCursor,
    _options?: MailChangesOptions,
  ): Promise<MailChangesResult> {
    const state = this.use(accessToken, 'mailChanges');
    this.assignMailSeqs(state);
    if (cursor.kind !== 'fake') {
      return { cursor: { kind: 'fake', seq: state.mailSeq }, headers: [], reset: true };
    }
    const fresh = state.messages
      .filter(
        (m) =>
          (m.mailSeq ?? 0) > cursor.seq &&
          m.labelIds.includes('INBOX') &&
          !m.labelIds.includes('DRAFT') &&
          !m.labelIds.includes('TRASH') &&
          !m.labelIds.includes('SPAM'),
      )
      .sort((a, b) => (a.mailSeq ?? 0) - (b.mailSeq ?? 0));
    const headers: MailHeader[] = fresh.map((m) => {
      const text = m.html ? htmlToText(m.body) : m.body;
      return {
        id: m.id,
        threadId: m.threadId,
        from: m.from,
        to: m.to,
        subject: m.subject,
        snippet: text.replace(/\s+/g, ' ').trim().slice(0, 140),
        date: m.date.toISOString(),
        hasAttachments: m.attachments.length > 0,
        attachments: m.attachments.map((a, i) => ({
          id: a.id ?? `att_${i + 1}`,
          name: a.name,
          mimeType: a.mimeType,
          size: a.size,
        })),
      };
    });
    const maxSeq = fresh.reduce((n, m) => Math.max(n, m.mailSeq ?? 0), cursor.seq);
    return { cursor: { kind: 'fake', seq: Math.max(maxSeq, state.mailSeq) }, headers };
  }

  private use(accessToken: string, method: keyof GoogleWorkspace): FakeGoogleState {
    const state = this.stateFor(accessToken);
    state.calls.push(method);
    const service = SERVICE_OF[method];
    if (service && state.disabled.has(service)) throw disabledError(service);
    return state;
  }

  private id(state: FakeGoogleState, prefix: string): string {
    return `${prefix}_${String(state.nextId++).padStart(4, '0')}`;
  }

  async checkService(
    accessToken: string,
    service: ConnectorService,
    grantedScopes: readonly string[],
  ): Promise<ConnectionCheck> {
    const state = this.stateFor(accessToken);
    state.calls.push('checkService');
    if (!grantedScopes.includes(GOOGLE_SCOPES[service]))
      return { service, state: 'no_scope', message: `${serviceLabel(service, 'google')} wasn’t allowed.` };
    if (state.disabled.has(service))
      return {
        service,
        state: 'api_disabled',
        enableUrl: googleEnableApisUrl(),
        message: 'API turned off in your Google project',
      };
    return { service, state: 'ok' };
  }

  /* Mail --------------------------------------------------------------------------------------- */

  private labelName(state: FakeGoogleState, id: string): string {
    return state.labels.find((l) => l.id === id)?.name ?? id;
  }

  private summary(state: FakeGoogleState, m: FakeMail): MailSummary {
    const text = m.html ? htmlToText(m.body) : m.body;
    return {
      id: m.id,
      threadId: m.threadId,
      from: m.from,
      to: m.to,
      subject: m.subject,
      snippet: text.replace(/\s+/g, ' ').trim().slice(0, 140),
      date: m.date.toISOString(),
      unread: m.labelIds.includes('UNREAD'),
      labels: m.labelIds.map((id) => this.labelName(state, id)),
    };
  }

  private message(state: FakeGoogleState, m: FakeMail): MailMessage {
    const body = capText(m.html ? htmlToText(m.body) : m.body, MAIL_BODY_CAP);
    return {
      ...this.summary(state, m),
      cc: m.cc,
      body: body.text,
      bodyTruncated: body.truncated,
      attachments: m.attachments,
    };
  }

  async mailSearch(accessToken: string, input: MailSearchInput): Promise<MailSummary[]> {
    const state = this.use(accessToken, 'mailSearch');
    const now = this.now();
    return state.messages
      .filter((m) => !m.labelIds.includes('DRAFT'))
      .filter((m) => matches(m, input.query, state.labels, now))
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, input.limit)
      .map((m) => this.summary(state, m));
  }

  async inboxUnread(accessToken: string, input: { newest?: number } = {}): Promise<InboxUnread> {
    const state = this.use(accessToken, 'inboxUnread');
    const unread = state.messages
      .filter((m) => m.labelIds.includes('INBOX') && m.labelIds.includes('UNREAD'))
      .sort((a, b) => b.date.getTime() - a.date.getTime());
    return {
      count: unread.length,
      newest: unread.slice(0, Math.max(0, input.newest ?? 0)).map((m) => this.summary(state, m)),
    };
  }

  async mailRead(
    accessToken: string,
    input: { messageId?: string; threadId?: string },
  ): Promise<MailMessage[]> {
    const state = this.use(accessToken, 'mailRead');
    const found = input.threadId
      ? state.messages.filter((m) => m.threadId === input.threadId)
      : state.messages.filter((m) => m.id === input.messageId);
    if (found.length === 0) throw notFound(input.threadId ? 'Thread' : 'Message');
    return found.sort((a, b) => a.date.getTime() - b.date.getTime()).map((m) => this.message(state, m));
  }

  async mailDraft(accessToken: string, input: MailDraftInput): Promise<{ draftId: string }> {
    checkAttachmentTotal(input.attachments ?? []);
    const state = this.use(accessToken, 'mailDraft');
    let threadId: string | null = null;
    let subject = input.subject;
    let inReplyTo: string | null = null;
    if (input.replyToMessageId) {
      const original = state.messages.find((m) => m.id === input.replyToMessageId);
      if (!original) throw notFound('Message');
      threadId = original.threadId;
      inReplyTo = `<${original.id}@mail.example.com>`;
      if (!subject.trim()) subject = replySubject(original.subject);
    }
    const draft: FakeDraft = {
      ...(input.attachments ? { attachments: structuredClone(input.attachments) } : {}),
      id: this.id(state, 'draft'),
      threadId,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject,
      body: input.body,
      inReplyTo,
    };
    state.drafts.push(draft);
    return { draftId: draft.id };
  }

  async mailGetDraft(accessToken: string, draftId: string): Promise<MailDraftView> {
    const state = this.use(accessToken, 'mailGetDraft');
    const d = state.drafts.find((x) => x.id === draftId);
    if (!d) throw notFound('Draft');
    return {
      ...(d.attachments?.length ? { attachments: d.attachments.map(attachmentDigest) } : {}),
      draftId: d.id,
      threadId: d.threadId,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      body: d.body,
    };
  }

  async mailSendDraft(
    accessToken: string,
    draftId: string,
  ): Promise<{ messageId: string; threadId: string }> {
    const state = this.use(accessToken, 'mailSendDraft');
    const d = state.drafts.find((x) => x.id === draftId);
    if (!d) throw notFound('Draft');
    state.drafts = state.drafts.filter((x) => x !== d);
    const id = this.id(state, 'msg');
    const threadId = d.threadId ?? this.id(state, 'thr');
    state.messages.push({
      id,
      threadId,
      from: `You <${state.email}>`,
      to: d.to,
      cc: d.cc,
      bcc: d.bcc,
      subject: d.subject,
      body: d.body,
      date: this.now(),
      labelIds: ['SENT'],
      attachments: (d.attachments ?? []).map((a, i) => ({
        ...a,
        id: String(i),
        size: Buffer.from(a.contentBase64, 'base64').length,
      })),
      inReplyTo: d.inReplyTo,
    });
    return { messageId: id, threadId };
  }

  async mailOrganize(accessToken: string, input: MailOrganizeInput): Promise<{ updated: number }> {
    const state = this.use(accessToken, 'mailOrganize');
    const labelId = (name: string, create: boolean) => {
      if (isReservedMailLabel(name)) throw badRequest(RESERVED_MAIL_LABEL_TEXT);
      const found = state.labels.find(
        (l) => l.id === name || l.name.toLowerCase() === name.trim().toLowerCase(),
      );
      if (found || !create) return found?.id;
      const label = { id: this.id(state, 'Label'), name: name.trim() };
      state.labels.push(label);
      return label.id;
    };
    const add = input.addLabels.map((n) => labelId(n, true)).filter((x): x is string => !!x);
    const remove = input.removeLabels.map((n) => labelId(n, false)).filter((x): x is string => !!x);
    if (input.read === true) remove.push('UNREAD');
    if (input.read === false) add.push('UNREAD');
    if (input.archive === true) remove.push('INBOX');
    if (input.archive === false) add.push('INBOX');
    let updated = 0;
    for (const id of input.messageIds) {
      const m = state.messages.find((x) => x.id === id);
      if (!m) continue;
      m.labelIds = [...new Set([...m.labelIds.filter((l) => !remove.includes(l)), ...add])];
      updated += 1;
    }
    return { updated: add.length || remove.length ? updated : 0 };
  }

  async mailTrash(accessToken: string, input: { messageIds: string[] }): Promise<{ trashed: number }> {
    const state = this.use(accessToken, 'mailTrash');
    let trashed = 0;
    for (const id of input.messageIds) {
      const m = state.messages.find((x) => x.id === id);
      if (!m) continue;
      m.labelIds = [...m.labelIds.filter((l) => l !== 'INBOX'), 'TRASH'];
      trashed += 1;
    }
    return { trashed };
  }

  /* Calendar ----------------------------------------------------------------------------------- */

  private event(state: FakeGoogleState, calendarId: string, eventId: string): FakeEvent {
    const e = state.events.find((x) => x.id === eventId && x.calendarId === calendarId);
    if (!e) throw notFound('Event');
    return e;
  }

  async calendarEvents(accessToken: string, input: CalendarEventsInput): Promise<CalendarEvent[]> {
    const state = this.use(accessToken, 'calendarEvents');
    const from = new Date(eventsWindowStart(input, this.now())).getTime();
    const to = input.to ? new Date(input.to).getTime() : Number.POSITIVE_INFINITY;
    const q = input.query?.trim().toLowerCase();
    return state.events
      .filter((e) => e.calendarId === input.calendarId)
      .filter((e) => new Date(e.end).getTime() > from && new Date(e.start).getTime() < to)
      .filter((e) => !q || `${e.summary} ${e.description} ${e.location}`.toLowerCase().includes(q))
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
      .slice(0, input.limit)
      .map((e) => ({ ...e, guests: e.guests.map((g) => ({ ...g })) }));
  }

  async calendarGetEvent(
    accessToken: string,
    input: { calendarId: string; eventId: string },
  ): Promise<CalendarEvent> {
    const state = this.use(accessToken, 'calendarGetEvent');
    return structuredClone(this.event(state, input.calendarId, input.eventId));
  }

  async calendarCreateEvent(
    accessToken: string,
    input: { calendarId: string; event: CalendarEventInput; sendUpdates: boolean },
  ): Promise<CalendarEvent> {
    const state = this.use(accessToken, 'calendarCreateEvent');
    const id = this.id(state, 'evt');
    const e = input.event;
    const created: FakeEvent = {
      ...(e.recurrence ? { recurrence: [...e.recurrence] } : {}),
      id,
      calendarId: input.calendarId,
      summary: e.summary,
      description: e.description ?? '',
      location: e.location ?? '',
      start: e.start,
      end: e.end,
      allDay: !e.start.includes('T'),
      guests: e.guests.map((email) => ({ email, name: null, response: 'needs_action' })),
      organizer: state.email,
      webUrl: `https://calendar.google.com/calendar/event?eid=${id}`,
      meetUrl: e.addMeet ? `https://meet.google.com/${id.replace(/_/g, '-')}` : null,
    };
    state.events.push(created);
    if (input.sendUpdates && e.guests.length)
      state.calendarMail.push({ kind: 'invite', eventId: id, guests: [...e.guests] });
    return structuredClone(created);
  }

  async calendarUpdateEvent(
    accessToken: string,
    input: { calendarId: string; eventId: string; patch: CalendarEventPatch; sendUpdates: boolean },
  ): Promise<CalendarEvent> {
    const state = this.use(accessToken, 'calendarUpdateEvent');
    const e = this.event(state, input.calendarId, input.eventId);
    const p = input.patch;
    if (p.recurrence !== undefined) e.recurrence = [...p.recurrence];
    // As at Google: one end alone cannot switch the event between all-day and timed (IN-24).
    if (!eventTimesMatch({ start: p.start ?? e.start, end: p.end ?? e.end }))
      throw badRequest(EVENT_TIMES_MISMATCH_TEXT);
    if (p.summary !== undefined) e.summary = p.summary;
    if (p.description !== undefined) e.description = p.description;
    if (p.location !== undefined) e.location = p.location;
    if (p.start !== undefined) {
      e.start = p.start;
      e.allDay = !p.start.includes('T');
    }
    if (p.end !== undefined) e.end = p.end;
    if (p.addMeet && !e.meetUrl) e.meetUrl = `https://meet.google.com/${e.id.replace(/_/g, '-')}`;
    if (p.guests)
      e.guests = p.guests.map(
        (email) => e.guests.find((g) => g.email === email) ?? { email, name: null, response: 'needs_action' },
      );
    if (input.sendUpdates && e.guests.length)
      state.calendarMail.push({ kind: 'update', eventId: e.id, guests: e.guests.map((g) => g.email) });
    return structuredClone(e);
  }

  async calendarDeleteEvent(
    accessToken: string,
    input: { calendarId: string; eventId: string; sendUpdates: boolean },
  ): Promise<void> {
    const state = this.use(accessToken, 'calendarDeleteEvent');
    const e = this.event(state, input.calendarId, input.eventId);
    state.events = state.events.filter((x) => x !== e);
    if (input.sendUpdates && e.guests.length)
      state.calendarMail.push({ kind: 'cancel', eventId: e.id, guests: e.guests.map((g) => g.email) });
  }

  /* Drive -------------------------------------------------------------------------------------- */

  async mailAttachment(
    token: string,
    input: { messageId: string; attachmentId: string },
  ): Promise<ConnectorBinary> {
    const state = this.use(token, 'mailAttachment');
    const file = state.messages
      .find((m) => m.id === input.messageId)
      ?.attachments.find((a) => a.id === input.attachmentId);
    if (!file?.contentBase64) throw notFound('Attachment');
    return { name: file.name, mimeType: file.mimeType, contentBase64: file.contentBase64 };
  }

  async filesDownload(token: string, fileId: string): Promise<ConnectorBinary> {
    const file = this.file(this.use(token, 'filesDownload'), fileId);
    if (file.contentBase64 === undefined && file.content === null) throw notFound('File content');
    return {
      name: file.file.name,
      mimeType: file.file.mimeType,
      contentBase64: file.contentBase64 ?? Buffer.from(file.content ?? '').toString('base64'),
    };
  }

  async filesOrganize(token: string, input: McpToolInput<'files_organize'>): Promise<DriveFile> {
    const state = this.use(token, 'filesOrganize');
    if (input.folderId && this.file(state, input.folderId).file.kind !== 'folder')
      throw badRequest('The destination is not a folder.');
    if (input.action === 'folder') {
      const file: FakeFile = {
        file: {
          id: this.id(state, 'file'),
          name: input.name ?? '',
          kind: 'folder',
          mimeType: 'application/vnd.google-apps.folder',
          modifiedAt: this.now().toISOString(),
          owners: [state.email],
          size: null,
          webUrl: null,
        },
        content: null,
        trashed: false,
        permissions: [],
        ...(input.folderId ? { folderId: input.folderId } : {}),
      };
      state.files.push(file);
      return { ...file.file };
    }
    let file = this.file(state, input.fileId ?? '');
    if (input.action === 'copy') {
      file = structuredClone(file);
      file.file.id = this.id(state, 'file');
      state.files.push(file);
    }
    if (input.name) file.file.name = input.name;
    if (input.folderId) file.folderId = input.folderId;
    file.file.modifiedAt = this.now().toISOString();
    return { ...file.file };
  }

  private file(state: FakeGoogleState, fileId: string): FakeFile {
    const f = state.files.find((x) => x.file.id === fileId && !x.trashed);
    if (!f) throw notFound('File');
    return f;
  }

  async filesSearch(accessToken: string, input: { query: string; limit: number }): Promise<DriveFile[]> {
    const state = this.use(accessToken, 'filesSearch');
    const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    return state.files
      .filter((f) => !f.trashed)
      .filter((f) => words.every((w) => `${f.file.name} ${f.content ?? ''}`.toLowerCase().includes(w)))
      .slice(0, input.limit)
      .map((f) => ({ ...f.file }));
  }

  async filesGet(accessToken: string, fileId: string): Promise<DriveFile> {
    const state = this.use(accessToken, 'filesGet');
    return { ...this.file(state, fileId).file };
  }

  async filesRead(accessToken: string, fileId: string): Promise<FileContent> {
    const state = this.use(accessToken, 'filesRead');
    const f = this.file(state, fileId);
    const format =
      f.file.kind === 'doc'
        ? 'markdown'
        : f.file.kind === 'sheet'
          ? 'csv'
          : f.file.kind === 'text'
            ? 'text'
            : 'none';
    if (format === 'none' || f.content === null)
      return { file: { ...f.file }, format: 'none', content: null, truncated: false };
    const capped = capText(f.content, FILE_CONTENT_CAP);
    return { file: { ...f.file }, format, content: capped.text, truncated: capped.truncated };
  }

  async filesCreate(accessToken: string, input: FilesCreateInput): Promise<DriveFile> {
    const state = this.use(accessToken, 'filesCreate');
    const id = this.id(state, 'file');
    const mimeType = {
      doc: 'application/vnd.google-apps.document',
      sheet: 'application/vnd.google-apps.spreadsheet',
      text: 'text/plain',
    }[input.kind];
    const created: FakeFile = {
      file: {
        id,
        name: input.name,
        kind: input.kind,
        mimeType,
        modifiedAt: this.now().toISOString(),
        owners: [state.email],
        size: input.kind === 'text' ? Buffer.byteLength(input.content) : null,
        webUrl: `https://drive.google.com/file/d/${id}/view`,
      },
      content: input.content,
      trashed: false,
      permissions: [],
    };
    state.files.push(created);
    return { ...created.file };
  }

  async filesShare(
    accessToken: string,
    input: { fileId: string; email: string; role: ShareRole },
  ): Promise<void> {
    const state = this.use(accessToken, 'filesShare');
    const f = this.file(state, input.fileId);
    f.permissions = [
      ...f.permissions.filter((p) => p.email !== input.email),
      { email: input.email, role: input.role },
    ];
  }

  async filesTrash(accessToken: string, fileId: string): Promise<void> {
    const state = this.use(accessToken, 'filesTrash');
    this.file(state, fileId).trashed = true;
  }

  /* Docs and Sheets ---------------------------------------------------------------------------- */

  async docsEdit(
    accessToken: string,
    input: { documentId: string; edits: DocEdit[] },
  ): Promise<{ applied: number }> {
    const state = this.use(accessToken, 'docsEdit');
    const f = this.file(state, input.documentId);
    if (f.file.kind !== 'doc') throw new GoogleApiError(400, 'This file is not a document.', 'other');
    let text = f.content ?? '';
    let applied = 0;
    for (const e of input.edits) {
      if (e.op === 'append') {
        text += e.text;
        applied += 1;
      } else if (text.includes(e.find)) {
        text = text.split(e.find).join(e.text);
        applied += 1;
      }
    }
    f.content = text;
    f.file.modifiedAt = this.now().toISOString();
    return { applied };
  }

  private sheet(state: FakeGoogleState, spreadsheetId: string): FakeFile {
    const f = this.file(state, spreadsheetId);
    if (f.file.kind !== 'sheet') throw new GoogleApiError(400, 'This file is not a spreadsheet.', 'other');
    return f;
  }

  async sheetsRead(
    accessToken: string,
    input: { spreadsheetId: string; range: string },
  ): Promise<{ range: string; values: SheetCell[][] }> {
    const state = this.use(accessToken, 'sheetsRead');
    const rows = csvRows(this.sheet(state, input.spreadsheetId).content ?? '');
    const b = a1Bounds(input.range);
    const values = rows
      .slice(b.r0, b.r1 + 1)
      .map((row) => row.slice(b.c0, b.c1 + 1).map(cellValue))
      .map((row) => {
        while (row.length && row[row.length - 1] === null) row.pop();
        return row;
      });
    while (values.length && values[values.length - 1]?.length === 0) values.pop();
    return { range: input.range, values };
  }

  async sheetsWrite(
    accessToken: string,
    input: { spreadsheetId: string; range: string; values: SheetCell[][] },
  ): Promise<{ range: string; updatedCells: number }> {
    const state = this.use(accessToken, 'sheetsWrite');
    const f = this.sheet(state, input.spreadsheetId);
    const rows = csvRows(f.content ?? '');
    const b = a1Bounds(input.range);
    let updated = 0;
    input.values.forEach((row, i) => {
      const r = b.r0 + i;
      while (rows.length <= r) rows.push([]);
      const target = rows[r] as string[];
      row.forEach((v, j) => {
        if (v === null) return;
        const c = b.c0 + j;
        while (target.length <= c) target.push('');
        target[c] = String(v);
        updated += 1;
      });
    });
    f.content = `${rows.map((r) => r.join(',')).join('\n')}\n`;
    f.file.modifiedAt = this.now().toISOString();
    return { range: input.range, updatedCells: updated };
  }

  /* Contacts ----------------------------------------------------------------------------------- */

  async contactsSearch(accessToken: string, input: { query: string; limit: number }): Promise<ContactCard[]> {
    const state = this.use(accessToken, 'contactsSearch');
    const q = input.query.toLowerCase();
    return state.contacts
      .filter((c) => `${c.name} ${c.emails.join(' ')} ${c.organization ?? ''}`.toLowerCase().includes(q))
      .slice(0, input.limit)
      .map((c) => structuredClone(c));
  }
}
