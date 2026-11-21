/**
 * Website feedback in a chat, in fixture mode (docs/decisions/feedback-chat.md AP-1838; Whombat less-is-more.md LM-01,
 * contracts 0.87.0 CT-383; one-agent.md OA-04, OA-16). The runtime posts an integration's reports in the person's
 * Feedback with the agent, so this layer answers as one does:
 *
 * - the billing portal integration with its chat (`chat`, `conversationId` the chat), assessed and fixed by Neo, and
 *   any integration made or saved with New integration / Save (each gets its own chat);
 * - the chat “Website feedback · Billing portal” in CONVERSATIONS, unread: a bug report from Safari with Neo's look at
 *   it and the choice it asks, and an older feature request already decided — each a thread under the report, as the
 *   runtime posts them (the report by Feedback, a short note that Neo is looking, Neo's answer with the assessment);
 * - those reports (`feedback.getReport`, `feedback.decide`, status), and the Feedback principal in the bootstrap.
 *
 * Outside the one-Whombat layer, whose chats list it adds to.
 */

import { lastOfMessage, localAt, theAgentOf } from '@whombat/client';
import type { Bootstrap, ConversationDetail } from '@whombat/core';
import {
  API_ENDPOINTS,
  type FeedbackIntegrationDetail,
  type FeedbackIntegrationHealth,
  matchPath,
} from '@whombat/core/contracts';
import {
  type Agent,
  type AssessmentCard,
  type ChatSummary,
  type ChatThread,
  type Conversation,
  FEEDBACK_DECISION_STATUS,
  type FeedbackIntegration,
  FeedbackIntegrationSettings,
  type FeedbackReport,
  FeedbackReportStatus,
  type Message,
  type ReportCard,
  type ThreadSettle,
} from '@whombat/core/domain';
import { newFeedbackSiteId } from '@whombat/core/feedback';
import {
  assessmentCardOf,
  burrow,
  dusty,
  feedbackHealth,
  feedbackIntegration,
  feedbackSnippets,
  mara,
  reportCardOf,
  reportFeature,
  reportLikelyBug,
} from '@whombat/fixtures';
import { ASSISTANT_NAME, WHOMBAT_ID } from './oneFixtures';

const API = '/api/v1';
const TZ = 'Europe/Amsterdam';

export const FEEDBACK_CHAT_ID = 'cnv_chat-feedback-billing';
/** The burrow's Feedback principal (Whombat FB-14): it posts each report, never assessed by it. */
export const FEEDBACK_PRINCIPAL_ID = 'prn_feedback';
export const PDF_REPORT_ID = 'fbr_chat-pdf-safari';
export const IDEAL_REPORT_ID = 'fbr_chat-ideal-links';
const PDF_ROOT = 'msg_fbc-pdf-safari';
const IDEAL_ROOT = 'msg_fbc-ideal-links';

const FEEDBACK_ENDPOINTS = API_ENDPOINTS.filter((e) => e.id.startsWith('feedback.'));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function error(code: string, message: string, status: number, fields?: Record<string, string[]>): Response {
  return json({ error: { code, message, ...(fields ? { fields } : {}) } }, status);
}

function message(
  over: Partial<Message> & Pick<Message, 'id' | 'authorId' | 'createdAt'>,
  conversationId: string,
): Message {
  return {
    conversationId: conversationId as Message['conversationId'],
    editedAt: null,
    text: '',
    mentions: [],
    card: null,
    suggestions: [],
    more: null,
    attachments: [],
    reactions: [],
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
    ...over,
  };
}

/** The agent's first message in a feedback chat, as the runtime words it (Whombat LM-F). */
function helloText(name: string): string {
  return `Reports from “${name}” will show up here. I’ll look at each one and tell you what I find.`;
}

/** The chat an integration's reports land in: “Website feedback · Billing portal”, Mara and Neo. */
function chatConversation(id: string, title: string, createdAt: string): Conversation {
  return {
    id: id as Conversation['id'],
    burrowId: burrow.id,
    kind: 'dm',
    slug: id,
    title: ASSISTANT_NAME,
    topic: '',
    actions: [],
    prNumber: null,
    repoId: null,
    createdAt,
    lastMessageAt: createdAt,
    chat: { title, subject: null, archivedAt: null },
  };
}

interface ChatState {
  conversation: Conversation;
  /** Top-level messages and thread replies, oldest first. */
  messages: Message[];
  unread: number;
}

export interface FeedbackChatFixtures {
  handle(req: Request): Promise<Response | null>;
  decorate(req: Request, response: Response): Promise<Response>;
}

export function createFeedbackChatFixtures(
  options: {
    /**
     * The billing portal in its chat, with its reports (`VITE_FIXTURE_FEEDBACK_SOURCES=1`). Without: only integrations
     * made here get a chat.
     */
    seed?: boolean;
    now?: () => number;
  } = {},
): FeedbackChatFixtures {
  const clock = options.now ?? (() => Date.now());
  const made = clock();
  const at = (day: number, hhmm: string) => localAt(made, TZ, hhmm, day);
  let seq = 0;

  const chatOf = (id: string) => ({ id }) as FeedbackIntegration['chat'];

  /** Integrations as a runtime with `feedback.chat` has them in the assistant shell. */
  const integrations = new Map<string, FeedbackIntegration>(
    options.seed
      ? [
          [
            feedbackIntegration.id,
            {
              ...feedbackIntegration,
              conversationId: FEEDBACK_CHAT_ID as FeedbackIntegration['conversationId'],
              chat: chatOf(FEEDBACK_CHAT_ID),
            },
          ],
        ]
      : [],
  );

  /* The reports in the chat ---------------------------------------------------------------------- */

  const inChat = (r: FeedbackReport): FeedbackReport => ({
    ...r,
    conversationId: FEEDBACK_CHAT_ID as FeedbackReport['conversationId'],
    intake: { ...r.intake, conversationId: FEEDBACK_CHAT_ID as FeedbackReport['intake']['conversationId'] },
  });

  const pdfResult = reportLikelyBug.assessment.result as NonNullable<FeedbackReport['assessment']['result']>;
  const reports = new Map<string, FeedbackReport>([
    [
      PDF_REPORT_ID,
      inChat({
        ...reportLikelyBug,
        id: PDF_REPORT_ID as FeedbackReport['id'],
        reference: 'FB-5TQX-8D2M',
        status: 'triaged',
        receivedAt: at(0, '13:48'),
        updatedAt: at(0, '13:56'),
        submitted: {
          ...reportLikelyBug.submitted,
          description: 'The Download PDF button on an invoice does nothing in Safari. In Chrome it works.',
          expected: 'The invoice downloads as a PDF.',
          steps: 'Open an invoice, press Download PDF.',
          reporter: { name: 'Lotte Jansen', email: 'lotte@jansen-bouw.example', verified: true },
          context: {
            ...reportLikelyBug.submitted.context,
            browser: { name: 'Safari 18 · macOS', language: 'nl-NL', viewport: null, timeZone: null },
          },
          attachments: reportLikelyBug.submitted.attachments.slice(0, 1),
        },
        rootMessageId: PDF_ROOT as FeedbackReport['rootMessageId'],
        assessment: {
          ...reportLikelyBug.assessment,
          updatedAt: at(0, '13:56'),
          result: {
            ...pdfResult,
            summary:
              'The export opens the PDF in a new window after the download finishes; Safari blocks that window, so nothing happens.',
            reproduction: {
              status: 'reproduced',
              notes: 'Opened an invoice in Safari on the website and pressed Download PDF: nothing opened.',
            },
            evidence: [
              {
                kind: 'observation',
                ref: 'Safari 18 on the invoice page',
                note: 'Download PDF does nothing; the console says a pop-up was blocked.',
                hypothesis: false,
              },
              {
                kind: 'file',
                ref: 'billing/pdf/download.ts:42',
                note: 'Calls window.open() after an await, which Safari treats as a pop-up.',
                hypothesis: false,
              },
            ],
            severity: { level: 'high', rationale: 'Safari customers can’t download their invoices.' },
            nextAction: 'Download the file in the same window instead of opening a new one.',
            missingInformation: [],
          },
          conclusion: {
            reply:
              'I opened an invoice in Safari and the Download PDF button really does nothing: Safari blocks the window the export opens. It works in Chrome, so it’s a bug in how we open the file.',
            bugVerdict: 'bug',
            decision: {
              question: 'Want me to look into a fix?',
              options: [
                { label: 'Yes, fix it', action: 'hand_off', recommended: true },
                { label: 'Leave it for now', action: 'keep_open', recommended: false },
              ],
            },
          },
          decided: null,
        },
        attempts: reportLikelyBug.attempts.map((a) => ({
          ...a,
          startedAt: at(0, '13:49'),
          finishedAt: at(0, '13:56'),
        })),
      }),
    ],
    [
      IDEAL_REPORT_ID,
      inChat({
        ...reportFeature,
        id: IDEAL_REPORT_ID as FeedbackReport['id'],
        reference: 'FB-H9XM-6VKT',
        status: 'triaged',
        receivedAt: at(-1, '09:12'),
        updatedAt: at(-1, '09:40'),
        rootMessageId: IDEAL_ROOT as FeedbackReport['rootMessageId'],
        assessment: {
          ...reportFeature.assessment,
          updatedAt: at(-1, '09:40'),
          conclusion: {
            reply:
              'Invoices only show your bank account and the reference today, so a payment link would be new. It’s doable, but your payment provider charges for every payment made that way.',
            bugVerdict: null,
            decision: {
              question: 'Do you want iDEAL payment links on invoices?',
              options: [
                { label: 'Build it', action: 'hand_off', recommended: false },
                { label: 'Not now', action: 'keep_open', recommended: true },
                { label: 'Won’t do', action: 'close', recommended: false },
              ],
            },
          },
          decided: {
            option: 1,
            label: 'Not now',
            action: 'keep_open',
            decidedById: mara.id,
            decidedAt: at(-1, '10:05'),
          },
        },
      }),
    ],
  ]);

  /* The chat ----------------------------------------------------------------------------------------- */

  const bot = WHOMBAT_ID as Message['authorId'];
  const feedback = FEEDBACK_PRINCIPAL_ID as Message['authorId'];
  const chats = new Map<string, ChatState>();
  // Every integration posts in the one Feedback room (CHT-03; AP-2411), whose threads `chats.threads?room=feedback` lists.
  const title = 'Feedback';

  /** A report's thread as the runtime posts it: the note that the assistant is looking, then its answer. */
  function threadOf(chatId: string, rootId: string, report: FeedbackReport, start: string, answered: string) {
    return [
      message(
        {
          id: `${rootId}-look` as Message['id'],
          authorId: feedback,
          createdAt: start,
          threadRootId: rootId as Message['id'],
          text: `${ASSISTANT_NAME} is having a look.`,
        },
        chatId,
      ),
      message(
        {
          id: `${rootId}-answer` as Message['id'],
          authorId: bot,
          createdAt: answered,
          threadRootId: rootId as Message['id'],
          text: report.assessment.conclusion?.reply ?? '',
          card: assessmentCardOf(report) as AssessmentCard,
        },
        chatId,
      ),
    ];
  }

  function rootOf(chatId: string, rootId: string, report: FeedbackReport): Message {
    const label = report.type === 'bug' ? 'Bug report' : 'Feature request';
    return message(
      {
        id: rootId as Message['id'],
        authorId: feedback,
        createdAt: report.receivedAt,
        // The header the runtime posts a report with (RR-04): fixed words, the visitor's only in the card.
        text: `${label} ${report.reference} · ${report.productLabel}`,
        card: reportCardOf(report) as ReportCard,
      },
      chatId,
    );
  }

  if (options.seed) {
    const pdf = reports.get(PDF_REPORT_ID) as FeedbackReport;
    const ideal = reports.get(IDEAL_REPORT_ID) as FeedbackReport;
    chats.set(FEEDBACK_CHAT_ID, {
      conversation: chatConversation(FEEDBACK_CHAT_ID, title, at(-1, '09:05')),
      messages: [
        // The agent says hello once, when the integration starts posting here (Whombat LM-01).
        message(
          {
            id: 'msg_fbc-hello' as Message['id'],
            authorId: bot,
            createdAt: at(-1, '09:05'),
            text: helloText(feedbackIntegration.name),
          },
          FEEDBACK_CHAT_ID,
        ),
        rootOf(FEEDBACK_CHAT_ID, IDEAL_ROOT, ideal),
        ...threadOf(FEEDBACK_CHAT_ID, IDEAL_ROOT, ideal, at(-1, '09:13'), at(-1, '09:40')),
        rootOf(FEEDBACK_CHAT_ID, PDF_ROOT, pdf),
        ...threadOf(FEEDBACK_CHAT_ID, PDF_ROOT, pdf, at(0, '13:49'), at(0, '13:56')),
      ],
      unread: 1,
    });
  }

  /** Settled reports (chat-settle.md CHS-01; app AP-6150…): by Mara, from a report's menu or Settle finished threads. */
  const settled = new Map<string, ThreadSettle>();

  /** Messages with their thread counts and cards from the reports as they are now. */
  function current(chat: ChatState): Message[] {
    const fresh = chat.messages.map((m) => {
      if (m.card?.kind === 'report') {
        const r = reports.get(m.card.reportId);
        return r ? { ...m, card: reportCardOf(r) as ReportCard } : m;
      }
      if (m.card?.kind === 'assessment') {
        const r = reports.get(m.card.reportId);
        return r ? { ...m, card: assessmentCardOf(r) as AssessmentCard } : m;
      }
      return m;
    });
    return fresh.map((n) => {
      if (n.threadRootId) return n;
      const settle = settled.get(n.id);
      const m = settle ? { ...n, settled: settle } : n;
      const replies = fresh.filter((r) => r.threadRootId === m.id);
      return replies.length
        ? {
            ...m,
            replyCount: replies.length,
            lastReplyAt: replies.at(-1)?.createdAt ?? null,
            threadParticipantIds: [...new Set(replies.map((r) => r.authorId))].slice(-3),
          }
        : m;
    });
  }

  function summaryOf(chat: ChatState): ChatSummary {
    const c = chat.conversation;
    const last = chat.messages.filter((m) => !m.threadRootId).at(-1);
    return {
      id: c.id,
      title: c.chat?.title ?? c.title,
      subject: null,
      lastAt: last?.createdAt ?? c.createdAt,
      ...(last?.text ? { lastText: last.text.slice(0, 200) } : {}),
      unread: chat.unread,
      default: false,
      archivedAt: c.chat?.archivedAt ?? null,
      room: 'feedback' as const,
    };
  }

  function detailOf(chat: ChatState): ConversationDetail {
    const c = chat.conversation;
    const top = chat.messages.filter((m) => !m.threadRootId);
    return {
      conversation: { ...c, lastMessageAt: top.at(-1)?.createdAt ?? c.createdAt },
      summary: {
        id: c.id,
        kind: 'dm',
        slug: c.slug,
        title: c.title,
        link: { type: 'chat', id: c.id },
        unread: chat.unread,
        mentions: 0,
        prNumber: null,
        lastMessageAt: top.at(-1)?.createdAt ?? c.lastMessageAt,
      },
      pr: null,
      // The newest report is unread: the “New” line sits above it.
      lastReadMessageId: (chat.unread ? top.at(-1 - chat.unread) : top.at(-1))?.id ?? null,
    };
  }

  /** A new integration's chat (the runtime makes it with the integration): empty until the first report. */
  function newChat(name: string): string {
    const now = new Date(clock()).toISOString();
    // The Chat shell has one Feedback room for every site (CHT-03): a new site says hello there.
    const existing = [...chats.keys()][0];
    if (existing) {
      const chat = chats.get(existing) as ChatState;
      chat.messages = [
        ...chat.messages,
        message(
          { id: `msg_fbc-${++seq}` as Message['id'], authorId: bot, createdAt: now, text: helloText(name) },
          existing,
        ),
      ];
      chat.unread += 1;
      return existing;
    }
    const id = `cnv_chat-feedback-${++seq}`;
    chats.set(id, {
      conversation: chatConversation(id, 'Feedback', now),
      messages: [
        message(
          { id: `msg_fbc-${++seq}` as Message['id'], authorId: bot, createdAt: now, text: helloText(name) },
          id,
        ),
      ],
      unread: 1,
    });
    return id;
  }

  const health = (i: FeedbackIntegration): FeedbackIntegrationHealth => {
    const known = i.id === feedbackIntegration.id;
    const warnings: FeedbackIntegrationHealth['warnings'] = [];
    if (i.intake === 'disabled')
      warnings.push({
        code: 'intake_disabled',
        message: 'Intake is off: the widget tells visitors feedback isn’t available.',
      });
    return {
      ...feedbackHealth,
      ...(known
        ? { reportsLast24h: 1, lastReportAt: at(0, '13:48') }
        : {
            reportsLast24h: 0,
            lastReportAt: null,
            assessments: { queued: 0, running: 0, failed: 0, blocked: 0 },
          }),
      warnings,
    };
  };

  const detail = (i: FeedbackIntegration): FeedbackIntegrationDetail => ({
    integration: i,
    snippets: feedbackSnippets(i),
    health: health(i),
    can: { manage: true },
  });

  function saved(i: FeedbackIntegration, status = 200): Response {
    integrations.set(i.id, i);
    return json({ status: 'ok', integration: i }, status);
  }

  async function body(req: Request): Promise<Record<string, unknown>> {
    const text = await req.text();
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  function refused(issues: readonly { path: readonly PropertyKey[]; message: string }[], prefix = '') {
    const fields: Record<string, string[]> = {};
    for (const issue of issues) {
      const key = prefix + issue.path.map(String).join('.');
      fields[key] = [...(fields[key] ?? []), issue.message];
    }
    return error('validation_failed', 'Check the highlighted fields.', 400, fields);
  }

  /** `feedback.*` in the assistant shell: integrations with their chats, the chat's reports. */
  async function feedbackAnswer(id: string, params: Record<string, string>, req: Request) {
    const integration = params.id ? integrations.get(params.id) : undefined;
    const report = params.id ? reports.get(params.id) : undefined;
    const now = new Date(clock()).toISOString();
    switch (id) {
      case 'feedback.getIntegration':
        return integration ? json(detail(integration)) : null;
      case 'feedback.createIntegration': {
        const parsed = FeedbackIntegrationSettings.safeParse(await body(req));
        if (!parsed.success) return refused(parsed.error.issues);
        // No channel: the integration gets its own chat (CT-383; one-agent.md AP-4936).
        const integrationId = `fbi_chat-${++seq}`;
        const chatId = newChat(parsed.data.name);
        return saved(
          {
            ...parsed.data,
            id: integrationId as FeedbackIntegration['id'],
            siteId: newFeedbackSiteId(),
            conversationId: chatId as FeedbackIntegration['conversationId'],
            intake: 'enabled',
            assessment: 'active',
            revision: 1,
            configHash: '0'.repeat(64),
            createdById: mara.id,
            createdAt: now,
            updatedById: mara.id,
            updatedAt: now,
            chat: chatOf(chatId),
          },
          201,
        );
      }
      case 'feedback.updateIntegration': {
        if (!integration) return null;
        const input = await body(req);
        const parsed = FeedbackIntegrationSettings.safeParse(input.settings);
        if (!parsed.success) return refused(parsed.error.issues, 'settings.');
        if (input.revision !== integration.revision)
          return error('conflict', 'Someone changed this integration since you opened it.', 409);
        return saved({
          ...integration,
          ...parsed.data,
          conversationId: integration.conversationId,
          revision: integration.revision + 1,
          updatedById: mara.id,
          updatedAt: now,
        });
      }
      case 'feedback.setIntake': {
        if (!integration) return null;
        const { enabled } = await body(req);
        return saved({
          ...integration,
          intake: enabled ? 'enabled' : 'disabled',
          revision: integration.revision + 1,
        });
      }
      case 'feedback.setAssessment': {
        if (!integration) return null;
        const { active } = await body(req);
        return saved({
          ...integration,
          assessment: active ? 'active' : 'paused',
          revision: integration.revision + 1,
        });
      }
      case 'feedback.getReport':
        return report
          ? json({
              report,
              can: {
                setStatus: true,
                retry: false,
                handoff: false,
                redact: true,
                decide: !!report.assessment.conclusion?.decision && !report.assessment.decided,
              },
            })
          : null;
      case 'feedback.setReportStatus': {
        if (!report) return null;
        const status = FeedbackReportStatus.safeParse((await body(req)).status);
        if (!status.success)
          return error('validation_failed', 'Choose a status.', 400, { status: ['Choose a status.'] });
        const next = { ...report, status: status.data, updatedAt: now };
        reports.set(report.id, next);
        return json({ status: 'ok', report: next });
      }
      case 'feedback.decide': {
        if (!report) return null;
        const { option } = await body(req);
        const decision = report.assessment.conclusion?.decision;
        if (!decision) return error('conflict', 'This assessment asks nothing to decide.', 409);
        if (report.assessment.decided) return error('conflict', 'This was already decided.', 409);
        const picked = typeof option === 'number' ? decision.options[option] : undefined;
        if (!picked || typeof option !== 'number')
          return error('validation_failed', 'Choose an option.', 400, { option: ['Choose an option.'] });
        const next: FeedbackReport = {
          ...report,
          updatedAt: now,
          ...(picked.action === 'hand_off' ? {} : { status: FEEDBACK_DECISION_STATUS[picked.action] }),
          assessment: {
            ...report.assessment,
            decided: {
              option,
              label: picked.label,
              action: picked.action,
              decidedById: mara.id,
              decidedAt: now,
            },
          },
        };
        reports.set(report.id, next);
        return json({ status: 'ok', report: next });
      }
    }
    return null;
  }

  /**
   * Mara's own assistant as the bootstrap names it: Neo, or Hazel where the assistant layer adds her first
   * (`VITE_FIXTURE_ASSISTANT=1`). The chat, the reports and the integration are its; answers name it.
   */
  let own = { id: WHOMBAT_ID as string, name: ASSISTANT_NAME };
  async function ownify(response: Response | null): Promise<Response | null> {
    if (!response || own.id === WHOMBAT_ID) return response;
    const text = (await response.text())
      .split(`"${WHOMBAT_ID}"`)
      .join(`"${own.id}"`)
      .split(`${ASSISTANT_NAME} is having a look.`)
      .join(`${own.name} is having a look.`);
    return new Response(text, { status: response.status, headers: response.headers });
  }

  /** A report thread's newest reply with words or files (`ChatThread.last`). */
  function lastOf(all: readonly Message[], rootId: string) {
    const replies = all.filter((r) => r.threadRootId === rootId);
    for (let i = replies.length - 1; i >= 0; i--) {
      const last = lastOfMessage(replies[i] as Message);
      if (last) return last;
    }
    return undefined;
  }

  /**
   * Which report threads have something new for Mara (`chats.unread`, thread-unread.md; chat-inbox.md CIB-06): the
   * newest reports the room counts as unread, less the ones she read, plus the ones she marked as unread.
   */
  const readRoots = new Set<string>();
  const markedRoots = new Set<string>();
  function newRoots(): string[] {
    const chat = [...chats.values()][0];
    if (!chat) return [];
    const roots = current(chat).filter((m) => !m.threadRootId);
    const newest = chat.unread > 0 ? roots.slice(-chat.unread).map((m) => m.id) : [];
    return [...new Set([...newest.filter((id) => !readRoots.has(id)), ...markedRoots])].filter(
      (id) => !settled.has(id),
    );
  }

  /** The Feedback room's threads, newest activity first. */
  function roomThreads(): ChatThread[] {
    const chat = [...chats.values()][0];
    const all = chat ? current(chat) : [];
    return all
      .filter((m) => !m.threadRootId)
      .map((m) => ({
        ...(lastOf(all, m.id) ? { last: lastOf(all, m.id) } : {}),
        conversationId: m.conversationId,
        room: 'feedback' as const,
        rootId: m.id,
        authorId: m.authorId,
        text: m.text.slice(0, 200),
        subject: null,
        createdAt: m.createdAt,
        replyCount: m.replyCount,
        lastAt: m.lastReplyAt ?? m.createdAt,
        working: false,
        waiting: false,
        settled: m.settled ?? null,
      }))
      .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt));
  }

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url, 'http://fixtures.local');
    const path = url.pathname.startsWith(API) ? url.pathname.slice(API.length) : url.pathname;
    const base = `/burrows/${burrow.slug}`;
    if (!path.startsWith(`${base}/`)) return null;
    if (path.startsWith(`${base}/feedback/`)) {
      for (const ep of FEEDBACK_ENDPOINTS) {
        if (ep.method !== req.method) continue;
        const params = matchPath(ep.path, path);
        if (!params) continue;
        const answer = await feedbackAnswer(ep.id, params, req);
        if (answer) return answer;
      }
      return null;
    }
    const rest = path.slice(base.length);

    const chatRoute = /^\/chats\/(cnv_[A-Za-z0-9_-]+)(\/archive|\/unarchive)?$/.exec(rest);
    const chatHere = chatRoute ? chats.get(chatRoute[1] as string) : undefined;
    if (chatRoute && chatHere) {
      const c = chatHere.conversation;
      if (req.method === 'PATCH' && !chatRoute[2]) {
        const { title: next } = (await body(req)) as { title: string };
        chatHere.conversation = { ...c, chat: { ...c.chat, title: next } as Conversation['chat'] };
      } else if (req.method === 'POST' && chatRoute[2]) {
        const archivedAt = chatRoute[2] === '/archive' ? new Date(clock()).toISOString() : null;
        chatHere.conversation = { ...c, chat: { ...c.chat, archivedAt } as Conversation['chat'] };
      } else return null;
      return json({ conversation: chatHere.conversation });
    }

    if (req.method === 'GET' && rest === '/chats/threads') {
      const url = new URL(req.url, 'http://fixtures.local');
      if (url.searchParams.get('room') !== 'feedback') return null;
      const state = url.searchParams.get('state');
      const all = roomThreads();
      const order = (t: ChatThread) =>
        Date.parse(state === 'settled' ? (t.settled?.at ?? t.lastAt) : t.lastAt);
      const threads = all
        .filter((t) => (state === 'open' ? !t.settled : state === 'settled' ? !!t.settled : true))
        .sort((a, b) => order(b) - order(a));
      return json({ threads, next: null, settledCount: all.filter((t) => t.settled).length });
    }
    // Settling a report's thread, or every finished one (CHS-01, CHS-09): nothing here works on one or waits.
    const settle = /^\/chats\/threads\/(msg_[A-Za-z0-9_-]+)\/settled$/.exec(rest);
    const settling =
      settle && req.method === 'PUT' ? roomThreads().find((t) => t.rootId === settle[1]) : undefined;
    if (settling) {
      const { settled: on } = (await body(req)) as { settled: boolean };
      if (on) settled.set(settling.rootId, { at: new Date(clock()).toISOString(), how: 'person' });
      else settled.delete(settling.rootId);
      return json({ thread: roomThreads().find((t) => t.rootId === settling.rootId) });
    }
    if (req.method === 'GET' && rest === '/chats/unread') {
      const chat = [...chats.values()][0];
      if (url.searchParams.get('room') !== 'feedback' || !chat) return null;
      return json({
        conversationId: chat.conversation.id,
        threads: newRoots().map((rootId) => ({ rootId, unread: 1 })),
      });
    }
    // Reading a report's thread, and marking it unread again (CIB-06): a report is someone else's, so it always can.
    const mark = /^\/chats\/threads\/(msg_[A-Za-z0-9_-]+)\/(read|unread)$/.exec(rest);
    const marking =
      mark && req.method === 'POST' ? roomThreads().find((t) => t.rootId === mark[1]) : undefined;
    if (mark && marking) {
      if (mark[2] === 'read') {
        readRoots.add(marking.rootId);
        markedRoots.delete(marking.rootId);
      } else markedRoots.add(marking.rootId);
      const unread = newRoots().includes(marking.rootId) ? 1 : 0;
      return json({
        conversationId: marking.conversationId,
        rootId: marking.rootId,
        unread,
        roomUnread: newRoots().length,
      });
    }
    if (req.method === 'POST' && rest === '/chats/settle') {
      const { room, onlyRead } = (await body(req)) as { room?: string; onlyRead?: boolean };
      const chat = [...chats.values()][0];
      if (room !== 'feedback' || !chat) return null;
      // “Settle everything read” leaves the reports with something new (CIB-07).
      const fresh = onlyRead ? new Set(newRoots()) : new Set<string>();
      const open = roomThreads().filter((t) => !t.settled && !fresh.has(t.rootId));
      for (const t of open) settled.set(t.rootId, { at: new Date(clock()).toISOString(), how: 'person' });
      return json({ room: 'feedback', conversationId: chat.conversation.id, settled: open.length });
    }

    const thread = /^\/messages\/(msg_[A-Za-z0-9_-]+)\/thread$/.exec(rest);
    if (thread && req.method === 'GET') {
      for (const chat of chats.values()) {
        const all = current(chat);
        const root = all.find((m) => m.id === thread[1] && !m.threadRootId);
        if (!root) continue;
        return json({
          root,
          replies: all.filter((m) => m.threadRootId === root.id),
          conversationId: chat.conversation.id,
          where: chat.conversation.chat?.title ?? chat.conversation.title,
          topic: null,
          more: null,
        });
      }
      return null;
    }
    const one = /^\/messages\/(msg_[A-Za-z0-9_-]+)$/.exec(rest);
    if (one && req.method === 'GET') {
      for (const chat of chats.values()) {
        const m = current(chat).find((x) => x.id === one[1]);
        if (m) return json({ message: m });
      }
      return null;
    }

    const conv = /^\/conversations\/(cnv_[A-Za-z0-9_-]+)(\/messages|\/read)?$/.exec(rest);
    const chat = conv ? chats.get(conv[1] as string) : undefined;
    if (!conv || !chat) return null;
    if (req.method === 'GET' && !conv[2]) return json(detailOf(chat));
    if (req.method === 'GET' && conv[2] === '/messages')
      return json({ messages: current(chat).filter((m) => !m.threadRootId), before: null, hasMore: false });
    if (req.method === 'POST' && conv[2] === '/messages') {
      const input = (await body(req)) as { text: string; clientId?: string; threadRootId?: string | null };
      const m = message(
        {
          id: `msg_fbc-${++seq}` as Message['id'],
          authorId: mara.id,
          createdAt: new Date(clock()).toISOString(),
          text: input.text,
          clientId: input.clientId ?? null,
          threadRootId: (input.threadRootId ?? null) as Message['threadRootId'],
        },
        chat.conversation.id,
      );
      chat.messages = [...chat.messages, m];
      // A new message opens a settled report's thread again (CHS-04).
      if (input.threadRootId) settled.delete(input.threadRootId);
      return json({ message: m, dispatches: [] }, 201);
    }
    if (req.method === 'POST' && conv[2] === '/read') {
      chat.unread = 0;
      return json({ unread: 0, mentions: 0 });
    }
    return null;
  }

  /** The integrations list with this shell's integrations and their chats. */
  async function listed(response: Response): Promise<Response> {
    const data = (await response.json()) as {
      integrations: { integration: FeedbackIntegration; health: FeedbackIntegrationHealth }[];
      can: { manage: boolean };
    };
    const rows = data.integrations.map((row) => {
      const ours = integrations.get(row.integration.id);
      return ours ? { integration: ours, health: health(ours) } : row;
    });
    const added = [...integrations.values()]
      .filter((i) => !rows.some((row) => row.integration.id === i.id))
      .map((i) => ({ integration: i, health: health(i) }));
    return json({ ...data, integrations: [...rows, ...added] });
  }

  async function decorate(req: Request, response: Response): Promise<Response> {
    if (req.method !== 'GET' || !response.ok) return response;
    const url = new URL(req.url, 'http://fixtures.local');
    const path = url.pathname.startsWith(API) ? url.pathname.slice(API.length) : url.pathname;
    const base = `/burrows/${burrow.slug}`;
    if (path === `${base}/chats`) {
      const data = (await response.json()) as { chats: ChatSummary[] };
      const archived = url.searchParams.get('archived') === 'true';
      if (url.searchParams.get('subjectKind')) return json(data);
      const ours = [...chats.values()]
        .map(summaryOf)
        .filter((c) => (archived ? !!c.archivedAt : !c.archivedAt));
      const list = [...data.chats.filter((c) => !chats.has(c.id)), ...ours].sort(
        (a, b) => Date.parse(b.lastAt ?? '0') - Date.parse(a.lastAt ?? '0'),
      );
      return json({ ...data, chats: list });
    }
    if (path === `${base}/bootstrap`) {
      const boot = (await response.json()) as Bootstrap;
      const mine = theAgentOf(boot.principals);
      if (mine) own = { id: mine.id, name: mine.name };
      if (boot.principals.some((p) => p.id === FEEDBACK_PRINCIPAL_ID)) return json(boot);
      const signer = {
        ...dusty,
        id: FEEDBACK_PRINCIPAL_ID as Agent['id'],
        name: 'Feedback',
        handle: 'feedback',
        role: 'operator',
        system: 'feedback',
        job: 'Receives reports from the feedback widget on your websites and posts each one as a thread.',
        doing: '',
        status: 'idle',
        channels: [],
      } as Agent;
      return json({ ...boot, principals: [...boot.principals, signer] } satisfies Bootstrap);
    }
    if (path === `${base}/feedback/integrations`) return (await ownify(await listed(response))) as Response;
    return response;
  }

  return {
    handle: async (req) => ownify(await handle(req)),
    decorate,
  };
}
