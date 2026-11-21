/**
 * Messages in Mara's Chat with Dusty and in the PR #482 branch room, including cards, reactions and threads. Text
 * follows `CONVS`, `DMS` and `THREAD` in `Whombat Desktop.dc.html`, told with one agent: Dusty plans, researches,
 * builds, fixes and deploys; Mara reviews (one person, Whombat one-person.md OP-01). Mara's Chat is threaded (every
 * top-level message starts a thread); Mara and Dusty write in it and in the branch room. The research rows, the review diff and
 * comments and the commits footer are the mock's `research`, `diff` and card literals (`renderVals()`). See
 * `docs/decisions/fixtures.md` and `docs/decisions/cards.md`.
 */
import type { Message } from '@whombat/core/domain';
import { dusty, mara } from './principals.js';
import { SEARCH_QUERY } from './search.js';
import { at } from './time.js';
import { approval, plan, pr, run } from './work.js';

function msg(
  partial: Omit<
    Message,
    | 'editedAt'
    | 'attachments'
    | 'clientId'
    | 'card'
    | 'suggestions'
    | 'more'
    | 'reactions'
    | 'threadRootId'
    | 'replyCount'
    | 'lastReplyAt'
    | 'threadParticipantIds'
  > &
    Partial<
      Pick<
        Message,
        'card' | 'reactions' | 'threadRootId' | 'replyCount' | 'lastReplyAt' | 'threadParticipantIds'
      >
    >,
): Message {
  return {
    editedAt: null,
    attachments: [],
    clientId: null,
    card: null,
    suggestions: [],
    more: null,
    reactions: [],
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    ...partial,
  };
}

const CHAT = 'cnv_dm-dusty';
const PR482 = 'cnv_pr482';

/* ------------------------------------------------------------------- Mara's Chat: the plan ------------ */

export const msg_dm_dusty_mara_0912 = msg({
  id: 'msg_dm-dusty-mara-0912',
  conversationId: CHAT,
  authorId: mara.id,
  createdAt: at('09:12'),
  text: 'Morning. Finance wants PDF invoices by the 14th. Can you break this down?',
  mentions: [],
  replyCount: 1,
  lastReplyAt: at('09:13'),
  threadParticipantIds: [dusty.id],
});

export const msg_dm_dusty_dusty_0913 = msg({
  id: 'msg_dm-dusty-dusty-0913',
  conversationId: CHAT,
  authorId: dusty.id,
  createdAt: at('09:13'),
  text: 'Here’s the plan. Four steps, and a person signs off before anything leaves the burrow.',
  mentions: [],
  card: { kind: 'plan', plan },
  threadRootId: msg_dm_dusty_mara_0912.id,
});

/* ------------------------------------------------------- Mara's Chat: the research and its thread ------ */

/** Thread root: 5 replies (`THREAD` in the mock). */
export const msg_dm_dusty_dusty_0941 = msg({
  id: 'msg_dm-dusty-dusty-0941',
  conversationId: CHAT,
  authorId: dusty.id,
  createdAt: at('09:41'),
  text: 'Compared three PDF libraries. Short version: Typeset. Notes and sources are in the thread.',
  mentions: [],
  card: {
    kind: 'research',
    topic: 'PDF libraries',
    sourceCount: 14,
    testedCount: 3,
    rows: [
      { name: 'Typeset', verdict: 'pick', note: 'Fast, embeds fonts cleanly, MIT license' },
      { name: 'PaperKit', verdict: 'no', note: 'Per-seat license and a 40 MB install' },
      { name: 'Scribe', verdict: 'no', note: 'Unmaintained since 2024' },
    ],
  },
  replyCount: 5,
  lastReplyAt: at('10:06'),
  // Last 3 distinct reply authors, most recently active last (`apps/server/src/seed/load.ts`'s rolling window over
  // the replies below: Dusty, Mara, Dusty, Mara, Dusty).
  threadParticipantIds: [mara.id, dusty.id],
});

export const msg_dm_dusty_dusty_0944 = msg({
  id: 'msg_dm-dusty-dusty-0944',
  conversationId: CHAT,
  authorId: dusty.id,
  createdAt: at('09:44'),
  text: 'Sources, weighted by how much I trusted them:',
  mentions: [],
  card: {
    kind: 'answer',
    query: null,
    receipts: [
      {
        n: 1,
        source: 'Typeset docs · rendering benchmarks',
        detail: 'typeset.dev',
        link: { type: 'external', url: 'https://typeset.dev/docs/benchmarks' },
        resultId: null,
      },
      {
        n: 2,
        source: 'Issue #1203 · font subsetting',
        detail: 'github.com',
        link: { type: 'external', url: 'https://github.com/whombat/billing/issues/1203' },
        resultId: null,
      },
      {
        n: 3,
        source: 'PaperKit trial notes',
        detail: 'Mar 2025',
        link: { type: 'search', q: 'PaperKit trial' },
        resultId: null,
      },
    ],
  },
  threadRootId: msg_dm_dusty_dusty_0941.id,
});

export const msg_dm_dusty_mara_0958 = msg({
  id: 'msg_dm-dusty-mara-0958',
  conversationId: CHAT,
  authorId: mara.id,
  createdAt: at('09:58'),
  text: 'Does Typeset handle Dutch number formatting? Comma decimals, dot thousands.',
  mentions: [],
  threadRootId: msg_dm_dusty_dusty_0941.id,
});

export const msg_dm_dusty_dusty_0959 = msg({
  id: 'msg_dm-dusty-dusty-0959',
  conversationId: CHAT,
  authorId: dusty.id,
  createdAt: at('09:59'),
  text: 'Yes, with the nl-NL locale. I rendered a test invoice and € 1.234,56 came out right. It doesn’t round for you, so rounding stays in our code.',
  mentions: [],
  threadRootId: msg_dm_dusty_dusty_0941.id,
});

export const msg_dm_dusty_mara_1005 = msg({
  id: 'msg_dm-dusty-mara-1005',
  conversationId: CHAT,
  authorId: mara.id,
  createdAt: at('10:05'),
  text: 'That was the March bug. I’ll check the rounding order in review.',
  mentions: [],
  threadRootId: msg_dm_dusty_dusty_0941.id,
});

export const msg_dm_dusty_dusty_1006 = msg({
  id: 'msg_dm-dusty-dusty-1006',
  conversationId: CHAT,
  authorId: dusty.id,
  createdAt: at('10:06'),
  text: 'Good. I’ll ask you to review the pull request when it’s up.',
  mentions: [],
  threadRootId: msg_dm_dusty_dusty_0941.id,
});

/** The research thread's replies, oldest first. */
export const THREAD_REPLIES: Message[] = [
  msg_dm_dusty_dusty_0944,
  msg_dm_dusty_mara_0958,
  msg_dm_dusty_dusty_0959,
  msg_dm_dusty_mara_1005,
  msg_dm_dusty_dusty_1006,
];

/* ---------------------------------------------------------- Mara's Chat: the cent-off invoice ---------- */

export const msg_dm_dusty_mara_1040 = msg({
  id: 'msg_dm-dusty-mara-1040',
  conversationId: CHAT,
  authorId: mara.id,
  createdAt: at('10:40'),
  text: 'Customer 8812 got an invoice that is €0,01 off. Have we seen this before?',
  mentions: [],
  replyCount: 2,
  lastReplyAt: at('10:43'),
  threadParticipantIds: [dusty.id, mara.id],
});

export const msg_dm_dusty_dusty_1041 = msg({
  id: 'msg_dm-dusty-dusty-1041',
  conversationId: CHAT,
  authorId: dusty.id,
  createdAt: at('10:41'),
  text: 'Yes, twice. Both times amounts were formatted before VAT was rounded. You fixed it for credit notes in March; regular invoices still format first.',
  mentions: [],
  card: {
    kind: 'answer',
    // The mock's answer has `search: true` ("Open in search").
    query: SEARCH_QUERY,
    receipts: [
      {
        n: 1,
        source: 'fix/credit-note-vat · 3 Mar 2026',
        detail: 'Mara Okafor',
        link: { type: 'pr', number: 311 },
        resultId: null,
      },
      {
        n: 2,
        source: 'PR #311 · round before format',
        detail: 'merged',
        link: { type: 'pr', number: 311 },
        resultId: null,
      },
      {
        n: 3,
        source: 'Run #1882 · ledger reconciliation',
        detail: 'Dusty',
        link: { type: 'run', number: 1882 },
        resultId: null,
      },
    ],
  },
  threadRootId: msg_dm_dusty_mara_1040.id,
});

export const msg_dm_dusty_mara_1043 = msg({
  id: 'msg_dm-dusty-mara-1043',
  conversationId: CHAT,
  authorId: mara.id,
  createdAt: at('10:43'),
  text: 'Good find. Fix it in the PDF work too, so it’s right in both places.',
  mentions: [],
  threadRootId: msg_dm_dusty_mara_1040.id,
});

/* ------------------------------------------------------------ Mara's Chat: invoice numbering ----------- */

export const msg_dm_dusty_mara_1402 = msg({
  id: 'msg_dm-dusty-mara-1402',
  conversationId: CHAT,
  authorId: mara.id,
  createdAt: at('14:02'),
  text: 'Quick one: what did we decide about invoice numbering last year?',
  mentions: [],
  replyCount: 3,
  lastReplyAt: at('14:04'),
  threadParticipantIds: [mara.id, dusty.id],
});

export const msg_dm_dusty_dusty_1402 = msg({
  id: 'msg_dm-dusty-dusty-1402',
  conversationId: CHAT,
  authorId: dusty.id,
  createdAt: at('14:02'),
  text: 'Yearly sequences with a prefix, like 2026-000142. You settled it on 12 Nov 2025. Dutch tax rules need an unbroken sequence per year, so numbers are never reused or skipped.',
  mentions: [],
  card: {
    kind: 'answer',
    query: null,
    receipts: [
      {
        n: 1,
        source: 'Thread · 12 Nov 2025',
        detail: '14 messages',
        link: { type: 'search', q: 'invoice numbering' },
        resultId: null,
      },
      {
        n: 2,
        source: 'Canvas · Invoicing rules v3',
        detail: 'section 2',
        link: { type: 'canvas', slug: 'invoicing-rules-v3' },
        resultId: null,
      },
      {
        n: 3,
        source: 'PR #311 · invoice-number service',
        detail: 'merged',
        link: { type: 'pr', number: 311 },
        resultId: null,
      },
    ],
  },
  threadRootId: msg_dm_dusty_mara_1402.id,
});

export const msg_dm_dusty_mara_1404 = msg({
  id: 'msg_dm-dusty-mara-1404',
  conversationId: CHAT,
  authorId: mara.id,
  createdAt: at('14:04'),
  text: 'Perfect. Does the PDF plan respect that?',
  mentions: [],
  threadRootId: msg_dm_dusty_mara_1402.id,
});

export const msg_dm_dusty_dusty_1404 = msg({
  id: 'msg_dm-dusty-dusty-1404',
  conversationId: CHAT,
  authorId: dusty.id,
  createdAt: at('14:04'),
  text: 'It does. Step 2 reads the number from the invoice-number service instead of generating one. I left a note on the plan canvas.',
  mentions: [],
  threadRootId: msg_dm_dusty_mara_1402.id,
});

/** Mara's Chat, top-level messages (thread roots) only, oldest first. */
export const DM_DUSTY_MESSAGES: Message[] = [
  msg_dm_dusty_mara_0912,
  msg_dm_dusty_dusty_0941,
  msg_dm_dusty_mara_1040,
  msg_dm_dusty_mara_1402,
];

/** Every reply in Mara's Chat, oldest first (the research thread's among them). */
export const DM_DUSTY_REPLIES: Message[] = [
  msg_dm_dusty_dusty_0913,
  ...THREAD_REPLIES,
  msg_dm_dusty_dusty_1041,
  msg_dm_dusty_mara_1043,
  msg_dm_dusty_dusty_1402,
  msg_dm_dusty_mara_1404,
  msg_dm_dusty_dusty_1404,
];

/* ------------------------------------------------------------------------- pr482 ------------------- */

export const msg_pr482_dusty_1048 = msg({
  id: 'msg_pr482-dusty-1048',
  conversationId: PR482,
  authorId: dusty.id,
  createdAt: at('10:48'),
  text: 'Opened PR #482 · Invoice PDF export. Three commits, all behind the pdf_export flag.',
  mentions: [],
  card: {
    kind: 'commits',
    prNumber: 482,
    commits: pr.commits.map((c) => ({ sha: c.sha, message: c.message })),
    // The footer as the mock prints it when the PR opened ("+214 −12 · 6 files"), before later fixes.
    diff: { add: 214, del: 12, files: 6 },
    signedById: dusty.id,
  },
});

export const msg_pr482_dusty_1055 = msg({
  id: 'msg_pr482-dusty-1055',
  conversationId: PR482,
  authorId: dusty.id,
  createdAt: at('10:55'),
  text: 'Checks finished on e9f114.',
  mentions: [],
  card: { kind: 'pill', text: '38 of 41 passed · 3 failing in invoice_format_test', tone: 'warn' },
});

export const msg_pr482_mara_1120 = msg({
  id: 'msg_pr482-mara-1120',
  conversationId: PR482,
  authorId: mara.id,
  createdAt: at('11:20'),
  text: 'Two changes. The first one matters.',
  mentions: [],
  card: {
    kind: 'review',
    prNumber: 482,
    file: 'billing/pdf/format.ts',
    line: 42,
    changesRequested: 2,
    diff: [
      { kind: 'context', text: 'const net = lineTotal(item)' },
      { kind: 'del', text: 'const shown = formatEuro(net * vatRate)' },
      { kind: 'del', text: 'const vat = round(shown)' },
      { kind: 'add', text: 'const vat = roundVat(net * vatRate)' },
      { kind: 'add', text: 'const shown = formatAmount(vat, locale)' },
    ],
    comments: [
      {
        n: 1,
        text: 'Amounts are formatted before VAT is rounded. Round first, then format, or Dutch invoices come out a cent off. Same bug as March.',
      },
      { n: 2, text: 'Minor: `formatEuro` takes a locale now, so call it `formatAmount`.' },
    ],
  },
});

/** `run.messageId`: the run card. */
export const msg_pr482_dusty_1122 = msg({
  id: 'msg_pr482-dusty-1122',
  conversationId: PR482,
  authorId: dusty.id,
  createdAt: at('11:22'),
  text: 'Fixing both now. Watch along if you like.',
  mentions: [],
  card: { kind: 'run', run },
});

/** `approval.messageId`: the staging deploy's approval card. */
export const msg_pr482_dusty_1125 = msg({
  id: 'msg_pr482-dusty-1125',
  conversationId: PR482,
  authorId: dusty.id,
  createdAt: at('11:25'),
  text: 'I can put this on staging as soon as the fix is green. @Mara, I need your yes first.',
  mentions: [mara.id],
  card: { kind: 'approval', approval },
});

export const msg_pr482_mara_1130 = msg({
  id: 'msg_pr482-mara-1130',
  conversationId: PR482,
  authorId: mara.id,
  createdAt: at('11:30'),
  text: 'Thanks, Dusty. I’ll say yes to staging after lunch and merge once it looks right.',
  mentions: [],
  reactions: [{ value: '+1', count: 1, mine: false, principalIds: [dusty.id] }],
});

export const PR482_MESSAGES: Message[] = [
  msg_pr482_dusty_1048,
  msg_pr482_dusty_1055,
  msg_pr482_mara_1120,
  msg_pr482_dusty_1122,
  msg_pr482_dusty_1125,
  msg_pr482_mara_1130,
];

/** Every conversation's top-level messages, keyed by conversation id (thread replies separate). */
export const MESSAGES_BY_CONVERSATION: Record<string, Message[]> = {
  cnv_pr482: PR482_MESSAGES,
  'cnv_dm-dusty': DM_DUSTY_MESSAGES,
  'cnv_feedback-mara': [],
};

export const ALL_MESSAGES: Message[] = [...DM_DUSTY_MESSAGES, ...DM_DUSTY_REPLIES, ...PR482_MESSAGES];

export function message(id: string): Message | undefined {
  return ALL_MESSAGES.find((m) => m.id === id);
}

export function threadReplies(rootId: string): Message[] {
  return ALL_MESSAGES.filter((m) => m.threadRootId === rootId);
}
