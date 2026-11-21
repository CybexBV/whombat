/**
 * The essentials' settings world for fixture mode (Whombat essentials items 4, 5, 6 and 12; AP-499): only when asked
 * for (`essentialsSettings: true`, or `VITE_FIXTURE_ESSENTIALS_SETTINGS=1`), so the mock's screens stay as drawn. It
 * decorates the shared fixture world with:
 *
 * - a failed turn: the agent's `turn_failed` card in Mara's Chat (not signed in to Claude) and two FAILED items in
 *   `work.overview` — that turn, and one whose sandbox didn't start with its technical detail — with `dispatches.retry`;
 * - two repos with a PR #1 each (whombat/web, whombat/infra) beside #482, their rooms, details and empty conversations;
 * - GitHub reached through Mara's own sign-in, as on a managed Whombat (`github.status` `via: 'signin'`), connecting
 *   once the fake AI side has her GitHub sign-in (device code or token);
 * - `Bootstrap.capabilities` (email and browser notifications).
 */
import type {
  Bootstrap,
  BranchRoomSummary,
  Conversation,
  ConversationDetail,
  Message,
  PullRequestDetail,
  Repo,
  WorkItem,
  WorkOverview,
} from '@whombat/core';
import { API_ENDPOINTS, matchPath } from '@whombat/core/contracts';
import { LOCAL_REPO_OWNER, LocalRepoName } from '@whombat/core/domain';
import { turnFailureText } from '@whombat/core/text';
import { at, burrow, cnv_pr482, mara, pr as pr482, REPOS } from '@whombat/fixtures';
import type { FakeAi } from '../managed/fake/ai';
import { ASSISTANT_NAME, DEFAULT_CHAT_ID, WHOMBAT_ID } from './oneFixtures';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/* Failed turns ------------------------------------------------------------------------------------------------ */

const SIGNIN_FAILED = 'dsp_agent-signin-failed';
const SANDBOX_FAILED = 'dsp_agent-sandbox-failed';
const FAILED_MESSAGE = 'msg_chat-agent-failed';

/** The agent's failure message in Mara's Chat: the card says why and offers Try again. */
function chatFailure(): Message {
  return {
    id: FAILED_MESSAGE,
    conversationId: DEFAULT_CHAT_ID,
    authorId: WHOMBAT_ID,
    createdAt: at('14:05'),
    editedAt: null,
    text: 'I couldn’t finish this.',
    mentions: [],
    reactions: [],
    attachments: [],
    clientId: null,
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    suggestions: [],
    more: null,
    card: {
      kind: 'turn_failed',
      dispatchId: SIGNIN_FAILED,
      agentId: WHOMBAT_ID,
      code: 'signin',
      reason: turnFailureText('signin', { provider: 'claude' }),
      retriedAt: null,
      retryDispatchId: null,
    },
  } as Message;
}

const SANDBOX_DETAIL = [
  'sandbox workspace-write --cd /var/lib/whombat/work/burrow-hq/agent',
  'Error: fs sandbox helper failed: Read-only file system (os error 30)',
  '  at createWorkspace (/opt/whombat/runner/workspace.js:212:11)',
  '  at runTurn (/opt/whombat/runner/turn.js:88:5)',
  'token=[redacted]',
].join('\n');

function failedItems(retried: Map<string, { at: string; id: string }>): WorkItem[] {
  const refs = (over: Partial<WorkItem['refs']>): WorkItem['refs'] => ({
    conversationId: DEFAULT_CHAT_ID,
    messageId: null,
    runNumber: null,
    runId: null,
    approvalNumber: null,
    approvalId: null,
    planId: null,
    stepId: null,
    automationRunNumber: null,
    automationRunId: null,
    dispatchId: null,
    ...over,
  });
  const failure = (dispatchId: string, code: 'signin' | 'sandbox', detail: string | null) => ({
    code,
    reason: turnFailureText(code, { provider: 'claude' }),
    detail,
    retriedAt: retried.get(dispatchId)?.at ?? null,
    retryDispatchId: retried.get(dispatchId)?.id ?? null,
  });
  return [
    {
      id: `dispatch:${SIGNIN_FAILED}`,
      kind: 'dispatch',
      section: 'failed',
      title: `${ASSISTANT_NAME} · what the PDF plan does with invoice numbers`,
      where: 'Chat',
      agentId: WHOMBAT_ID,
      ownerId: mara.id,
      status: { text: 'NOT SIGNED IN', tone: 'bad' },
      detail: 'Asked by you at 14:04.',
      since: at('14:05'),
      health: null,
      activity: null,
      link: { type: 'message', in: { type: 'dm', room: 'chat' }, messageId: FAILED_MESSAGE },
      actions: ['retry_turn', 'open'],
      refs: refs({ dispatchId: SIGNIN_FAILED, messageId: FAILED_MESSAGE }),
      failure: failure(SIGNIN_FAILED, 'signin', 'claude: Not logged in · Please run /login'),
    },
    {
      id: `dispatch:${SANDBOX_FAILED}`,
      kind: 'dispatch',
      section: 'failed',
      title: `${ASSISTANT_NAME} · round VAT before formatting`,
      where: 'Chat',
      agentId: WHOMBAT_ID,
      ownerId: mara.id,
      status: { text: 'SANDBOX DIDN’T START', tone: 'bad' },
      detail: 'Asked by you at 10:58.',
      since: at('10:59'),
      health: null,
      activity: null,
      link: { type: 'dm', room: 'chat' },
      actions: ['retry_turn', 'open'],
      refs: refs({ dispatchId: SANDBOX_FAILED }),
      failure: failure(SANDBOX_FAILED, 'sandbox', SANDBOX_DETAIL),
    },
  ] as WorkItem[];
}

/* Branch rooms of two repos ------------------------------------------------------------------------------------- */

interface Room {
  repo: string;
  repoId: string;
  branch: string;
  title: string;
  conversation: Conversation;
}

function room(repo: string, repoId: string, branch: string, title: string, slug: string): Room {
  return {
    repo,
    repoId,
    branch,
    title,
    conversation: {
      ...cnv_pr482,
      id: `cnv_${slug}`,
      slug,
      title: branch,
      topic: `PR #1 · ${title} · ${repo}`,
      prNumber: 1,
      repoId,
      createdAt: at('09:00'),
      lastMessageAt: null,
    },
  };
}

const ROOMS: Room[] = [
  room('whombat/web', 'rep_web', 'feat/dark-mode', 'Dark mode for the invoice pages', 'pr-1-web'),
  room('whombat/infra', 'rep_infra', 'chore/terraform-1-9', 'Terraform 1.9', 'pr-1-infra'),
];

function roomSummary(r: Room): BranchRoomSummary {
  return {
    id: r.conversation.id,
    kind: 'branch',
    slug: r.conversation.slug,
    title: r.branch,
    link: { type: 'pr', number: 1, repo: r.repo },
    unread: 0,
    mentions: 0,
    prNumber: 1,
    lastMessageAt: null,
    branch: r.branch,
    repo: r.repo,
    prStatus: 'ready',
    dot: 'ok',
  } as BranchRoomSummary;
}

function roomDetail(r: Room): ConversationDetail {
  return {
    conversation: r.conversation,
    summary: roomSummary(r),
    pr: prDetail(r).pr,
    lastReadMessageId: null,
  };
}

/** PR #482, reshaped into this room's PR #1: checks passed, nobody asked to review yet. */
function prDetail(r: Room): PullRequestDetail {
  return {
    pr: {
      ...pr482,
      id: `pr_1-${r.repoId}`,
      number: 1,
      repoId: r.repoId,
      repoFullName: r.repo,
      branch: r.branch,
      title: r.title,
      conversationId: r.conversation.id,
      checks: pr482.checks.map((c) => ({
        ...c,
        state: 'passed' as const,
        note: c.note === 'queued' ? '1m 12s' : c.note,
        tests: c.tests ? { passed: c.tests.total, total: c.tests.total } : null,
      })),
      reviewers: [],
    },
    status: 'ready',
    mergeBlock: null,
    staging: null,
  };
}

/* The layer ------------------------------------------------------------------------------------------------------- */

export interface EssentialsSettingsFixtures {
  /** Answers what only this world has (retry, the PR #1 rooms, GitHub); null otherwise. */
  handle(req: Request): Promise<Response | null>;
  /** Adds this world to what the shared fixture world answered. */
  decorate(req: Request, response: Response): Promise<Response>;
}

export function createEssentialsSettingsFixtures(ai: FakeAi): EssentialsSettingsFixtures {
  const retried = new Map<string, { at: string; id: string }>();
  let githubConnected = false;
  let seq = 0;
  // Repositories created on the Whombat (`repos.create`, AP-548): kept here, switched on, first commit by Mara.
  const localRepos: Repo[] = [];
  const createInfo = () => ({
    allowed: true,
    reason: null,
    author: { name: mara.name, email: mara.email ?? 'mara@burrowhq.example' },
  });
  const allRepos = () => [...(githubConnected ? REPOS : []), ...localRepos];

  const endpointOf = (req: Request) => {
    const url = new URL(req.url, 'http://fixtures.local');
    const path = url.pathname.replace(/^\/api\/v1/, '');
    for (const ep of API_ENDPOINTS) {
      if (ep.method !== req.method) continue;
      const params = matchPath(ep.path, path);
      if (params) return { id: ep.id, params, query: url.searchParams };
    }
    return null;
  };

  const githubLogin = () => ai.githubLogin();

  function githubStatus() {
    const login = githubLogin();
    return {
      mode: 'gh',
      via: 'signin',
      connected: githubConnected,
      login: githubConnected ? login : null,
      error: null,
      fix: null,
      note: null,
      canConnect: !githubConnected && login !== null,
      signInNeeded: !githubConnected && login === null,
      polledAt: null,
    };
  }

  return {
    async handle(req) {
      const ep = endpointOf(req);
      if (!ep) return null;
      switch (ep.id) {
        case 'dispatches.retry': {
          const id = ep.params.dispatchId as string;
          if (id !== SIGNIN_FAILED && id !== SANDBOX_FAILED) return null;
          const done = retried.get(id) ?? { at: new Date().toISOString(), id: `dsp_retry-${++seq}` };
          retried.set(id, done);
          return json({ dispatchId: done.id });
        }
        case 'prs.get': {
          if (ep.params.number !== '1') return null;
          const repo = ep.query.get('repo');
          const r = ROOMS.find((x) => x.repo === repo) ?? ROOMS[0];
          if (!r) return null;
          return json(prDetail(r));
        }
        case 'conversations.get': {
          const r = ROOMS.find((x) => x.conversation.id === ep.params.conversationId);
          return r ? json(roomDetail(r)) : null;
        }
        case 'messages.list': {
          const r = ROOMS.find((x) => x.conversation.id === ep.params.conversationId);
          return r ? json({ messages: [], before: null, hasMore: false }) : null;
        }
        case 'github.status':
          return json(githubStatus());
        case 'github.connect': {
          if (!githubLogin())
            return json(
              { error: { code: 'forbidden', message: 'Sign in to GitHub first, then connect it.' } },
              403,
            );
          githubConnected = true;
          return json(githubStatus());
        }
        case 'github.repos':
          return json({ repos: [], hasMore: false });
        case 'repos.list':
          return json({ repos: allRepos(), githubConnected, create: createInfo() });
        case 'repos.create': {
          const body = (await req.clone().json()) as { name?: string; description?: string };
          const name = LocalRepoName.safeParse(body.name);
          const refuse = (message: string) =>
            json({ error: { code: 'validation_failed', message, fields: { name: [message] } } }, 400);
          if (!name.success) return refuse('Use only letters, digits, _ . and -.');
          const lower = name.data.toLowerCase();
          if (allRepos().some((r) => r.fullName.slice(r.fullName.indexOf('/') + 1).toLowerCase() === lower))
            return refuse(`This burrow already has a repository called ${name.data}.`);
          const now = new Date().toISOString();
          const repo: Repo = {
            id: `rep_local-${++seq}`,
            burrowId: burrow.id,
            fullName: `${LOCAL_REPO_OWNER}/${name.data}`,
            description: body.description?.trim().slice(0, 280) ?? '',
            language: null,
            defaultBranch: 'main',
            enabled: true,
            pushedAt: now,
            source: 'local',
            path: `~/.whombat/workspaces/.origins/${burrow.id}/${name.data}.git`,
            createdAt: now,
          };
          localRepos.push(repo);
          return json({ repo }, 201);
        }
        case 'repos.update': {
          const repo = localRepos.find((r) => r.id === ep.params.repoId);
          if (!repo) return null;
          const body = (await req.clone().json()) as { enabled: boolean };
          repo.enabled = body.enabled;
          return json({ repo });
        }
        default:
          return null;
      }
    },

    async decorate(req, response) {
      if (!response.ok) return response;
      const ep = endpointOf(req);
      if (!ep) return response;
      switch (ep.id) {
        case 'conversations.bootstrap': {
          const d = (await response.json()) as Bootstrap;
          const rooms = [
            ...d.sidebar.branchRooms.map((r) =>
              r.prNumber === 482
                ? {
                    ...r,
                    repo: 'whombat/billing',
                    link: { type: 'pr' as const, number: 482, repo: 'whombat/billing' },
                  }
                : r,
            ),
            ...ROOMS.map(roomSummary),
          ];
          return json({
            ...d,
            sidebar: { ...d.sidebar, branchRooms: rooms },
            capabilities: { emailNotifications: true, webPush: true },
          });
        }
        case 'messages.list': {
          const id = ep.params.conversationId;
          if (id !== DEFAULT_CHAT_ID) return response;
          const page = (await response.json()) as { messages: Message[] };
          const extra = chatFailure();
          const card = extra.card;
          const withRetry =
            card?.kind === 'turn_failed' && retried.has(card.dispatchId)
              ? {
                  ...extra,
                  card: {
                    ...card,
                    retriedAt: retried.get(card.dispatchId)?.at ?? null,
                    retryDispatchId: retried.get(card.dispatchId)?.id ?? null,
                  },
                }
              : extra;
          const messages = [...page.messages.filter((m) => m.id !== extra.id), withRetry].sort((a, b) =>
            a.createdAt.localeCompare(b.createdAt),
          );
          return json({ ...page, messages });
        }
        case 'work.overview': {
          const d = (await response.json()) as WorkOverview;
          const extra = failedItems(retried);
          const sections = d.sections.map((s) =>
            s.section === 'failed' ? { ...s, items: [...extra, ...s.items] } : s,
          );
          return json({ ...d, sections, counts: { ...d.counts, failed: d.counts.failed + extra.length } });
        }
        default:
          return response;
      }
    },
  };
}
