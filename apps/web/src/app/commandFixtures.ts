/**
 * The agent's commands in fixture mode (`VITE_FIXTURE_COMMANDS=1`, or `commands: true` in `createWebFixtureFetch`;
 * AP-626, one-person.md AP-5690). The shared fixture world (`@whombat/fixtures`) has no command approvals and no
 * always-allowed commands, so the mock's screens stay as drawn; this layer adds, only when asked for:
 *
 * - the agent's two always-allowed commands, removable;
 * - in PR #482's room, a thread under Mara's “Two changes. The first one matters.” with the agent's `run_command`
 *   approval (#13: an rsync to the production server web-1 and a restart over ssh);
 * - the Deploy key (`vaultSshDeployKey`) with web-1 marked Production (set in `fixtureFetch.ts`);
 * - with `containers: false` (`commands: 'no-containers'`), a Whombat without a container engine: `HostInfo.services`
 *   and `services.list` say it can't run containers (`SERVICES_NOT_HERE`, development without Podman; CT-1534).
 *
 * State lives in the closure (one world per fetch); every answer is built to the contracts' schemas.
 */

import { actionCopy } from '@whombat/core/approvals';
import type { CommandAllowance } from '@whombat/core/commands';
import {
  type AnyEndpoint,
  API_ENDPOINTS,
  type MessagePage,
  matchPath,
  SERVICES_NOT_HERE,
  type ThreadView,
} from '@whombat/core/contracts';
import { type Approval, IDLE_EXECUTION, type Message } from '@whombat/core/domain';
import { burrow, mara } from '@whombat/fixtures';
import { ASSISTANT_NAME, WHOMBAT_ID } from './oneFixtures';

const API_BASE = '/api/v1';
/** The seed clock is 11:22 in Amsterdam on Wednesday 23 September 2026. */
const T = (hhmm: string, day = '2026-09-23') => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(
    Date.UTC(
      Number(day.slice(0, 4)),
      Number(day.slice(5, 7)) - 1,
      Number(day.slice(8, 10)),
      (h ?? 0) - 2,
      m ?? 0,
    ),
  ).toISOString();
};

/** The thread the command card lives in (PR #482's room, Mara: “Two changes. The first one matters.”). */
export const COMMAND_THREAD_ROOT = 'msg_pr482-mara-1120';
const CONVERSATION = 'cnv_pr482';
export const RUN_COMMAND_APPROVAL = 13;
const APPROVAL_MESSAGE = 'msg_banjo_run_command';

/** A long command, so the card's code block shows how it wraps. */
export const FIXTURE_COMMAND =
  'rsync -az --delete --exclude node_modules dist/ deploy@web-1:/srv/billing/releases/2026-09-23 && ssh web-1 "ln -sfn /srv/billing/releases/2026-09-23 /srv/billing/current && sudo systemctl restart billing-api"';

const ENDPOINTS = API_ENDPOINTS.filter((e) =>
  [
    'services.list',
    'services.stop',
    'agent.commandAllowances',
    'agent.removeCommandAllowance',
    'approvals.get',
    'approvals.decide',
    'approvals.undo',
    'messages.thread',
  ].includes(e.id),
) as readonly AnyEndpoint[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function problem(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

function seedAllowances(): CommandAllowance[] {
  return [
    {
      id: 'cma_web1_status',
      agentId: WHOMBAT_ID,
      keyId: 'deploy.production',
      command: 'ssh web-1 systemctl status billing-api',
      target: 'web-1',
      createdById: mara.id,
      createdAt: T('16:20', '2026-09-22'),
    },
    {
      id: 'cma_push_docs',
      agentId: WHOMBAT_ID,
      keyId: 'branch.main.push',
      command: 'git push origin main',
      target: 'main',
      createdById: mara.id,
      createdAt: T('09:12'),
    },
  ];
}

function runCommandApproval(): Approval {
  const action = {
    type: 'run_command' as const,
    params: {
      command: FIXTURE_COMMAND,
      category: 'deploy_production' as const,
      target: 'web-1',
      reason: 'Deploy the invoice PDF change to the billing server.',
    },
  };
  // The agent asks (one-agent.md AP-4921).
  const names = (id: string) =>
    id === WHOMBAT_ID ? { name: ASSISTANT_NAME, shortName: ASSISTANT_NAME } : undefined;
  const copy = actionCopy(action, names, WHOMBAT_ID);
  return {
    id: 'apr_run_command',
    number: RUN_COMMAND_APPROVAL,
    burrowId: burrow.id,
    requesterId: WHOMBAT_ID,
    keyId: 'deploy.production',
    action,
    title: copy.title,
    question: copy.question,
    target: copy.target,
    whatHappens: [copy.runs],
    explainer: `web-1 is a production server: ${ASSISTANT_NAME}’s commands can’t reach it until you say yes. The command waits in ${ASSISTANT_NAME}’s turn.`,
    summary: `${copy.runs}.`,
    conditions: [
      {
        id: 'person',
        kind: 'person_approves',
        label: 'A person says yes',
        met: false,
        approverIds: [mara.id],
      },
    ],
    state: 'pending',
    decidedById: null,
    decidedAt: null,
    execution: IDLE_EXECUTION,
    executedAt: null,
    conversationId: CONVERSATION,
    messageId: APPROVAL_MESSAGE,
    involvedIds: [],
    eventId: 'evt_run_command',
    scope: null,
    createdAt: T('11:21'),
  };
}

function message(id: string, createdAt: string, text: string, card: Message['card']): Message {
  return {
    id,
    conversationId: CONVERSATION,
    authorId: WHOMBAT_ID,
    createdAt,
    editedAt: null,
    text,
    mentions: [],
    card,
    suggestions: [],
    more: null,
    attachments: [],
    reactions: [],
    threadRootId: COMMAND_THREAD_ROOT,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
  };
}

export interface CommandFixtures {
  /** Answers this layer's routes, or null for the rest of the world. */
  handle(req: Request): Promise<Response | null>;
  /** Says whether containers run (`HostInfo.services`), and adds the thread's replies to PR #482's room. */
  decorate(req: Request, response: Response): Promise<Response>;
}

export function createCommandFixtures(options: { containers?: boolean } = {}): CommandFixtures {
  const containers = options.containers ?? true;
  let allowances = seedAllowances();
  let approval = runCommandApproval();

  const replies = (): Message[] => [
    message(
      APPROVAL_MESSAGE,
      approval.createdAt,
      'Built it. Deploying to web-1 needs a yes: it’s a production server.',
      { kind: 'approval', approval },
    ),
  ];

  const routes: Record<
    string,
    (params: Record<string, string>, body: Record<string, unknown>) => Response | null
  > = {
    // Without a container engine nothing runs (CT-1534); with one, the shared world answers.
    'services.list': () =>
      containers ? null : json({ available: false, reason: SERVICES_NOT_HERE, services: [] }),
    'services.stop': () => (containers ? null : problem('not_found', 'No such service.', 404)),
    'agent.commandAllowances': () => json({ allowances }),
    'agent.removeCommandAllowance': (p) => {
      allowances = allowances.filter((a) => a.id !== p.allowanceId);
      return json({ allowances, eventId: `evt_allowance_${p.allowanceId}` });
    },
    'approvals.get': (p) =>
      Number(p.number) === RUN_COMMAND_APPROVAL ? json({ approval, eventId: approval.eventId }) : null,
    'approvals.decide': (p, body) => {
      if (Number(p.number) !== RUN_COMMAND_APPROVAL) return null;
      if (approval.state !== 'pending') return problem('conflict', 'This was already decided.', 409);
      const yes = body.decision === 'approve';
      const scope = (body.scope as Approval['scope']) ?? 'once';
      approval = {
        ...approval,
        state: yes ? 'approved' : 'declined',
        decidedById: mara.id,
        decidedAt: new Date().toISOString(),
        scope: yes ? scope : null,
        conditions: approval.conditions.map((c) => (c.kind === 'person_approves' ? { ...c, met: yes } : c)),
      };
      if (yes && scope === 'agent')
        allowances = [
          {
            id: 'cma_web1_deploy',
            agentId: WHOMBAT_ID,
            keyId: 'deploy.production',
            command: FIXTURE_COMMAND,
            target: 'web-1',
            createdById: mara.id,
            createdAt: new Date().toISOString(),
          },
          ...allowances,
        ];
      return json({ approval, eventId: 'evt_run_command_decided' });
    },
    'approvals.undo': (p) =>
      Number(p.number) === RUN_COMMAND_APPROVAL
        ? problem('conflict', 'The command already ran; it can’t be undone.', 409)
        : null,
  };

  const match = (req: Request) => {
    const url = new URL(req.url, 'http://fixtures.local');
    const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
    for (const ep of ENDPOINTS) {
      if (ep.method !== req.method) continue;
      const params = matchPath(ep.path, path);
      if (params && params.burrow === burrow.slug) return { ep, params, url };
    }
    return null;
  };

  return {
    async handle(req) {
      const m = match(req);
      if (!m) return null;
      const route = routes[m.ep.id];
      if (!route) return null;
      const text = req.method === 'GET' || req.method === 'DELETE' ? '' : await req.text();
      return route(m.params, text ? (JSON.parse(text) as Record<string, unknown>) : {});
    },
    async decorate(req, response) {
      if (req.method !== 'GET' || !response.ok) return response;
      const url = new URL(req.url, 'http://fixtures.local');
      const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
      if (path === `/burrows/${burrow.slug}/host` && !containers) {
        const data = (await response.json()) as Record<string, unknown>;
        return json({ ...data, services: { available: false, reason: SERVICES_NOT_HERE } });
      }
      if (path === `/burrows/${burrow.slug}/messages/${COMMAND_THREAD_ROOT}/thread`) {
        const thread = (await response.json()) as ThreadView;
        const own = replies();
        const root = {
          ...thread.root,
          replyCount: thread.replies.length + own.length,
          lastReplyAt: approval.createdAt,
          threadParticipantIds: [WHOMBAT_ID],
        };
        return json({
          ...thread,
          root,
          replies: [...thread.replies.filter((r) => !own.some((o) => o.id === r.id)), ...own],
        });
      }
      if (
        path === `/burrows/${burrow.slug}/conversations/${CONVERSATION}/messages` &&
        !url.searchParams.has('before')
      ) {
        const page = (await response.json()) as MessagePage;
        const count = replies().length;
        return json({
          ...page,
          messages: page.messages.map((m) =>
            m.id === COMMAND_THREAD_ROOT
              ? {
                  ...m,
                  replyCount: m.replyCount + count,
                  lastReplyAt: approval.createdAt,
                  threadParticipantIds: [WHOMBAT_ID],
                }
              : m,
          ),
        });
      }
      return response;
    },
  };
}
