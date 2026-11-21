/**
 * Tests only: a T3 Code as Whombat meets it (docs/decisions/t3code.md), on 127.0.0.1, its shapes as a real T3 Code
 * 0.1.3 answered them: the descriptor (`/.well-known/t3/environment`), an outside agent's sign-in (`/oauth/mcp/register`,
 * `/decision` with a pairing code, `/token` as a form; PKCE S256, the resource checked against the request's own
 * origin), and its MCP server at `/mcp` (protocol 2025-06-18, a session per `initialize`, plain JSON answers, every
 * result as `structuredContent` and the same JSON as text, declared failures as `isError`). Its threads list newest
 * first, with the reviews they hand to another model as `subagent` children (`delegate`). Knobs play what happens to
 * a real one: a restart forgets every MCP session (404 to its id), a sign-in that ended answers 401, an old T3 Code has
 * no outside agents, and T3 Code before 0.1.5 uses up a code that can't give the access asked. Every request is kept.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const PAIRING = new RegExp(`^[${ALPHABET}]{12}$`, 'i');
const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

/** The descriptor a real T3 Code 0.1.3 answered (capabilities shortened). */
export const T3_DESCRIPTOR = {
  environmentId: '77d8990d-3960-4937-9ab5-1f65c3954ede',
  label: 'thetitan',
  platform: { os: 'linux', arch: 'x64', machine: 'desktop' },
  serverVersion: '0.1.3',
  orchestrationProtocolVersion: 2,
  capabilities: { repositoryIdentity: true, connectionProbe: true, threadStop: true },
};

type Access = 'read-only' | 'full-access';

interface ToolSpec {
  name: string;
  description: string;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean };
  inputSchema: Record<string, unknown>;
}

const tool = (name: string, readOnly: boolean, properties: Record<string, unknown> = {}): ToolSpec => ({
  name,
  description: `${name} in T3 Code.`,
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly },
  inputSchema: { type: 'object', properties, additionalProperties: true },
});

/** Some of T3 Code's 66 tools: thread-only ones the entry hides, reads, a read it marks as a change, writes. */
export const T3_TOOLS: ToolSpec[] = [
  tool('t3_environment_read', true),
  tool('t3_project_list', true, { limit: { type: 'number' } }),
  tool('preview_open', false, { url: { type: 'string' } }),
  tool('delegate_task', false, { prompt: { type: 'string' } }),
  tool('t3_attachment_prepare_upload', false, { name: { type: 'string' } }),
  // T3 Code marks reading a thread neither a read nor destructive.
  {
    ...tool('t3_thread_read', false, { threadId: { type: 'string' } }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  tool('t3_pending_request', false, {
    action: { type: 'string', enum: ['list', 'read', 'respond'] },
    threadId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    requestId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    answers: { anyOf: [{ type: 'object' }, { type: 'null' }] },
  }),
  tool('t3_thread_interrupt', false, { threadId: { type: 'string' } }),
  tool('t3_thread_launch', false, { projectId: { type: 'string' }, title: { type: 'string' } }),
  tool('t3_thread_send', false, { threadId: { type: 'string' }, message: { type: 'string' } }),
  tool('t3_thread_wait', false, { threadId: { type: 'string' }, timeoutMs: { type: 'number' } }),
  tool('list_thread_pull_requests', true, { threadId: { type: 'string' } }),
  tool('t3_thread_organize', false, { threadId: { type: 'string' }, action: { type: 'string' } }),
];

/**
 * A thread on the stand-in, as T3 Code keeps it: its runs (one per piece of work), its state, the questions and the
 * permission request it waits on, its last answer, and whether work it delegated still runs.
 */
export interface T3StubThread {
  id: string;
  projectId: string;
  title: string;
  status: string;
  runs: string[];
  /** Questions waiting for an answer, by request. */
  asks: { requestId: string; questions: Record<string, unknown>[] }[];
  /** What a permission request waiting is about. */
  approval: string | null;
  answer: string | null;
  /** Work it delegated still runs: a wait until it settles times out. */
  delegating: boolean;
  items: number;
  /** Settled (`t3_thread_organize`); a message sent to it makes it active again. */
  settled: boolean;
  /**
   * Pull requests T3 Code watches for it (`watch_pull_request` inside the thread), by address: their checks or reviews
   * moving start a new run. Settling the thread ends them, as in T3 Code.
   */
  watching: string[];
  /** Pull requests linked to it that T3 Code doesn't watch (`link_pull_request`). */
  linked: string[];
  /** Pull requests of it that are merged, as T3 Code last saw them. */
  merged?: string[];
  /** Its run's own items (a command it runs, a file it changes), in the activity view. */
  steps: Record<string, unknown>[];
  /** The messages sent to it after its first (`t3_thread_send`, or someone in T3 Code itself), each starting a run. */
  sent?: {
    position: number;
    text: string;
    createdBy: 'user' | 'agent';
    creationSource: string;
    updatedAt: string;
  }[];
  /** The worktree and branch it works in (a launch with a `worktree` or `existing_worktree` strategy). */
  worktreePath?: string | null;
  branch?: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** When T3 Code made it (`t3_thread_list` gives it). */
  createdAt?: string;
  /** The model it runs, as T3 Code names it (default `gpt-5.5`). */
  model?: string;
  /** Its provider (`providerInstanceId`); default the model's own (`providerOfModel`). */
  provider?: string;
  /** The thread that handed it work (`delegate_task`): a review is that thread's `subagent` child. */
  parentThreadId?: string | null;
  relationshipToParent?: 'subagent' | null;
}

export interface T3Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface T3CodeStub {
  port: number;
  url: string;
  seen: T3Seen[];
  /** The client names Whombat registered with, in order. */
  registered: string[];
  /** The tokens T3 Code issued, in order, with their access. */
  issued: { token: string; access: Access }[];
  /** `initialize` requests `/mcp` answered (a new session each). */
  sessionsOpened: number;
  /** The tools called on `/mcp`, with their arguments. */
  calls: { name: string; args: Record<string, unknown>; token: string }[];
  /** The threads started on it (`t3_thread_launch`), by id. */
  threads: Map<string, T3StubThread>;
  /** A thread's run asks a question (`requestId`, one question `id` with two choices). */
  ask(threadId: string, requestId: string, question: string, choices: string[]): void;
  /** A thread's run waits for a permission. */
  askPermission(threadId: string, about: string): void;
  /** A thread's run ends with its answer (completed, or failed …), at `clock`'s time. */
  finish(threadId: string, answer: string | null, status?: string): void;
  /** T3 Code's own time, which a run's end is stamped with (`finish`): a test that moves its clock sets it to that. */
  clock: () => Date;
  /** A thread's run does something: an item of its own (`command_execution`, `file_change` …), running until the next. */
  step(threadId: string, item: { type: string; text: string; title?: string }): void;
  /** The thread's agent links a pull request it opened (`link_pull_request`), without watching it. */
  linkPullRequest(threadId: string, url: string): void;
  /** The thread's agent watches a pull request for it (`watch_pull_request`). */
  watchPullRequest(threadId: string, url: string): void;
  /** A pull request it watches moved (checks passed …): T3 Code starts a new run of the thread, unless it is settled. */
  pullRequestMoved(threadId: string): boolean;
  /** Work the thread left running ended (a background command): T3 Code starts a new run of the thread by itself. */
  runAgain(threadId: string): void;
  /** Someone writes to the thread in T3 Code itself (the person, on their phone): a new run starts with their message. */
  message(threadId: string, text: string): void;
  /** T3 Code stops watching its pull requests (merged, closed). */
  pullRequestsDone(threadId: string): void;
  /** A pull request of the thread is merged: T3 Code says so and stops watching it. */
  mergePullRequest(threadId: string, url: string): void;
  /** A thread started elsewhere (by a turn the test plays): ended, with `model` and `title`. */
  addThread(id: string, title: string, model: string): T3StubThread;
  /**
   * A thread hands work to another model (`delegate_task`, a review): its `subagent` child, titled `title`, run by
   * `model`, made at `createdAt`, ended with `answer` (null: no answer yet). Returns the child's id.
   */
  delegate(
    parentId: string,
    child: { title: string; model: string; answer: string | null; createdAt?: string },
  ): string;
  knobs: {
    /** Before outside agents: no `/oauth/mcp/*`. */
    old: boolean;
    /** Before 0.1.5: a code that can't give the access asked is used up all the same. */
    spendsShortCode: boolean;
    /** The next this many `t3_thread_interrupt` calls fail (the thread keeps running). */
    failInterrupts: number;
    /** Worktree bases the person's checkout doesn't have: a launch from one is refused, as T3 Code does. */
    missingBases: string[];
    /** The next this many `t3_thread_send` calls fail (T3 Code can't be reached for a moment). */
    failSends: number;
    /** The next this many settles are refused: the thread's run ended, but work it left running still goes on. */
    failSettles: number;
    /** `t3_thread_wait` holds the call until the thread ends or `timeoutMs` passed, as T3 Code does (default: answers at once). */
    holdsWaits: boolean;
    /** The projects `t3_project_list` answers. */
    projects: {
      id: string;
      title: string;
      workspaceRoot: string;
      /** The repository its checkout's origin is, as T3 Code tells it (`displayName`: `owner/name`). */
      repositoryIdentity?: { displayName: string };
    }[];
  };
  /** A new pairing code: full access, or one that can only look (`--scope orchestration:read`). */
  pairingCode(kind?: 'full' | 'read'): string;
  /** T3 Code restarted: every MCP session is forgotten. */
  restart(): void;
  /** A sign-in ended (30 days, or removed in Sharing & access): `/mcp` refuses its token. */
  end(token: string): void;
  close(): Promise<void>;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export async function startT3Code(): Promise<T3CodeStub> {
  let n = 0;
  const next = (prefix: string) => `${prefix}-${++n}`;
  const codes = new Map<string, { kind: 'full' | 'read'; used: boolean }>();
  const clients = new Map<string, { name: string; redirects: string[] }>();
  const grants = new Map<
    string,
    { clientId: string; redirect: string; challenge: string; resource: string; access: Access }
  >();
  const tokens = new Map<string, Access>();
  const sessions = new Map<string, string>();

  const stub: T3CodeStub = {
    port: 0,
    url: '',
    seen: [],
    registered: [],
    issued: [],
    sessionsOpened: 0,
    calls: [],
    threads: new Map(),
    ask(threadId, requestId, question, choices) {
      const t = stub.threads.get(threadId);
      if (!t) throw new Error(`no thread ${threadId}`);
      t.asks.push({
        requestId,
        questions: [
          {
            id: 'q1',
            header: 'Question',
            question,
            options: choices.map((label) => ({ label, description: '' })),
            multiSelect: false,
          },
        ],
      });
      t.items++;
    },
    askPermission(threadId, about) {
      const t = stub.threads.get(threadId);
      if (!t) throw new Error(`no thread ${threadId}`);
      t.approval = about;
      t.items++;
    },
    finish(threadId, answer, status = 'completed') {
      const t = stub.threads.get(threadId);
      if (!t) throw new Error(`no thread ${threadId}`);
      t.status = status;
      t.answer = answer;
      t.asks = [];
      t.approval = null;
      t.items += 2;
      t.completedAt = stub.clock().toISOString();
      for (const s of t.steps) s.status = 'completed';
    },
    step(threadId, item) {
      const t = stub.threads.get(threadId);
      if (!t) throw new Error(`no thread ${threadId}`);
      for (const s of t.steps) s.status = 'completed';
      t.steps.push({ itemId: `item-${t.items}`, position: t.items, status: 'running', title: null, ...item });
      t.items++;
    },
    linkPullRequest(threadId, url) {
      const t = stub.threads.get(threadId);
      if (!t) throw new Error(`no thread ${threadId}`);
      t.linked.push(url);
    },
    watchPullRequest(threadId, url) {
      const t = stub.threads.get(threadId);
      if (!t) throw new Error(`no thread ${threadId}`);
      t.watching.push(url);
    },
    pullRequestMoved(threadId) {
      const t = stub.threads.get(threadId);
      if (!t) throw new Error(`no thread ${threadId}`);
      if (t.settled || !t.watching.length) return false;
      newRun(t);
      return true;
    },
    runAgain(threadId) {
      const t = stub.threads.get(threadId);
      if (!t) throw new Error(`no thread ${threadId}`);
      newRun(t);
    },
    message(threadId, text) {
      const t = stub.threads.get(threadId);
      if (!t) throw new Error(`no thread ${threadId}`);
      t.settled = false;
      sendTo(t, text, 'user');
    },
    pullRequestsDone(threadId) {
      const t = stub.threads.get(threadId);
      if (!t) throw new Error(`no thread ${threadId}`);
      t.watching = [];
    },
    addThread(id, title, model) {
      const t = blankThread(id, 'mcp:project-1', title);
      Object.assign(t, { status: 'completed', model, createdAt: new Date().toISOString() });
      stub.threads.set(id, t);
      return t;
    },
    delegate(parentId, child) {
      if (!stub.threads.has(parentId)) throw new Error(`no thread ${parentId}`);
      const id = `mcp:subagent-${stub.threads.size + 1}`;
      const t = blankThread(id, stub.threads.get(parentId)?.projectId ?? 'mcp:project-1', child.title);
      Object.assign(t, {
        status: child.answer === null ? 'running' : 'completed',
        answer: child.answer,
        items: child.answer === null ? 1 : 2,
        model: child.model,
        createdAt: child.createdAt ?? new Date().toISOString(),
        parentThreadId: parentId,
        relationshipToParent: 'subagent',
      });
      stub.threads.set(id, t);
      return id;
    },
    mergePullRequest(threadId, url) {
      const t = stub.threads.get(threadId);
      if (!t) throw new Error(`no thread ${threadId}`);
      t.watching = t.watching.filter((u) => u !== url);
      if (!t.linked.includes(url)) t.linked.push(url);
      t.merged = [...(t.merged ?? []), url];
    },
    clock: () => new Date(),
    knobs: {
      old: false,
      spendsShortCode: false,
      failInterrupts: 0,
      missingBases: [],
      holdsWaits: false,
      failSends: 0,
      failSettles: 0,
      projects: [{ id: 'mcp:project-1', title: 'Demo site', workspaceRoot: '/srv/demo' }],
    },
    pairingCode(kind = 'full') {
      // Twelve letters and digits of T3 Code's alphabet, different for each code.
      let value = (codes.size + 1) * 7_919 + 104_729;
      let code = '';
      for (let i = 0; i < 12; i++) {
        code += ALPHABET[value % ALPHABET.length];
        value = Math.floor(value / ALPHABET.length) + i * 3;
      }
      codes.set(code, { kind, used: false });
      return code;
    },
    restart: () => sessions.clear(),
    end: (token) => {
      tokens.delete(token);
    },
    close: async () => {},
  };

  const approvalError = (res: http.ServerResponse, message: string) =>
    send(res, 400, { _tag: 'AuthMcpApprovalError', message });

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://t3');
    stub.seen.push({ method: req.method ?? '', path: url.pathname, headers: req.headers, body });
    // The issuer and resource are the request's own origin, as T3 Code reads them.
    const origin = `http://${req.headers.host}`;

    if (req.method === 'GET' && url.pathname === '/.well-known/t3/environment')
      return send(res, 200, T3_DESCRIPTOR);

    if (url.pathname.startsWith('/oauth/mcp/') && stub.knobs.old)
      return send(res, 404, { error: 'not found' });

    if (req.method === 'POST' && url.pathname === '/oauth/mcp/register') {
      const sent = JSON.parse(body) as { client_name?: string; redirect_uris?: string[] };
      const clientId = next('client');
      clients.set(clientId, { name: sent.client_name ?? '', redirects: sent.redirect_uris ?? [] });
      stub.registered.push(sent.client_name ?? '');
      return send(res, 201, {
        client_id: clientId,
        client_name: sent.client_name,
        redirect_uris: sent.redirect_uris,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    }

    if (req.method === 'POST' && url.pathname === '/oauth/mcp/decision') {
      const { authorization: a, decision: d } = JSON.parse(body) as {
        authorization: Record<string, string>;
        decision: { _tag: string; access: Access; code: string };
      };
      const client = clients.get(a.client_id ?? '');
      if (!client?.redirects.includes(a.redirect_uri ?? ''))
        return approvalError(res, 'This sign-in link names an unknown app. Start the sign-in again from it.');
      const back = new URL(a.redirect_uri as string);
      back.searchParams.set('iss', origin);
      if (a.state) back.searchParams.set('state', a.state);
      if (a.code_challenge_method !== 'S256' || (a.code_challenge ?? '').length !== 43) {
        back.searchParams.set('error', 'invalid_request');
        return send(res, 200, { redirectTo: back.toString() });
      }
      if (a.resource !== undefined && a.resource !== `${origin}/mcp`) {
        back.searchParams.set('error', 'invalid_target');
        return send(res, 200, { redirectTo: back.toString() });
      }
      const given = d.code.trim();
      const code = codes.get(PAIRING.test(given) ? given.toUpperCase() : given);
      if (!code || code.used)
        return approvalError(res, 'That pairing code is unknown, expired, or already used.');
      if (code.kind === 'read' && d.access !== 'read-only') {
        if (stub.knobs.spendsShortCode) {
          code.used = true;
          return approvalError(
            res,
            'That pairing code cannot grant this access, and it is now used up. Create one with the standard scopes, or choose Read only with a new code.',
          );
        }
        return approvalError(
          res,
          'That pairing code cannot grant this access. It has not been used, so choose an access level it grants, or create a code with the standard scopes.',
        );
      }
      code.used = true;
      const grant = next('grant');
      grants.set(grant, {
        clientId: a.client_id as string,
        redirect: a.redirect_uri as string,
        challenge: a.code_challenge as string,
        resource: `${origin}/mcp`,
        access: d.access,
      });
      back.searchParams.set('code', grant);
      return send(res, 200, { redirectTo: back.toString() });
    }

    if (req.method === 'POST' && url.pathname === '/oauth/mcp/token') {
      const form = new URLSearchParams(body);
      const grant = grants.get(form.get('code') ?? '');
      grants.delete(form.get('code') ?? '');
      if (
        !grant ||
        form.get('grant_type') !== 'authorization_code' ||
        form.get('client_id') !== grant.clientId ||
        form.get('redirect_uri') !== grant.redirect ||
        s256(form.get('code_verifier') ?? '') !== grant.challenge ||
        (form.get('resource') ?? grant.resource) !== grant.resource
      )
        return send(res, 400, {
          error: 'invalid_grant',
          error_description: 'The authorization code is invalid or expired.',
        });
      const token = `t3tok-${grant.access}-${++n}`;
      tokens.set(token, grant.access);
      stub.issued.push({ token, access: grant.access });
      return send(res, 200, {
        access_token: token,
        token_type: 'Bearer',
        expires_in: THIRTY_DAYS_S,
        scope: grant.access === 'read-only' ? 'orchestration:read' : 'orchestration:read orchestration:write',
      });
    }

    if (req.method === 'POST' && url.pathname === '/mcp') {
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const access = tokens.get(token);
      if (!access)
        return send(res, 401, { error: 'invalid_mcp_credential' }, { 'www-authenticate': 'Bearer' });
      const msg = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
      if (msg.method === 'initialize') {
        const sid = next('session');
        sessions.set(sid, token);
        stub.sessionsOpened++;
        return send(
          res,
          200,
          {
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'T3 Code', version: '0.1.3' },
            },
          },
          { 'mcp-session-id': sid },
        );
      }
      const sid = req.headers['mcp-session-id'];
      if (typeof sid !== 'string' || !sessions.has(sid))
        return send(res, 404, {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        });
      if (msg.id === undefined) {
        res.writeHead(202);
        return res.end();
      }
      if (msg.method === 'tools/list')
        return send(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: T3_TOOLS } });
      if (msg.method === 'tools/call') {
        const name = String(msg.params?.name);
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        stub.calls.push({ name, args, token });
        if (name === 't3_thread_wait' && stub.knobs.holdsWaits) {
          const until = Date.now() + (typeof args.timeoutMs === 'number' ? args.timeoutMs : 0);
          const waited = stub.threads.get(String(args.threadId));
          const over = () =>
            !waited ||
            (!WAITING.includes(waited.status) && !(args.untilDelegatedWorkSettled && waited.delegating));
          while (!over() && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
        }
        const unsent = name === 't3_thread_send' && stub.knobs.failSends > 0;
        if (unsent) stub.knobs.failSends--;
        const unsettled =
          name === 't3_thread_organize' && args.action === 'settle' && stub.knobs.failSettles > 0;
        if (unsettled) stub.knobs.failSettles--;
        const uninterrupted = name === 't3_thread_interrupt' && stub.knobs.failInterrupts > 0;
        if (uninterrupted) stub.knobs.failInterrupts--;
        const refused = unsent || unsettled || uninterrupted;
        const strategy = (args.workspaceStrategy ?? null) as Record<string, unknown> | null;
        const base = strategy?.type === 'worktree' ? String(strategy.baseRef ?? 'HEAD') : null;
        const missing =
          name === 't3_thread_launch' && base !== null && stub.knobs.missingBases.includes(base);
        const answer = refused
          ? failure('orchestration_error', 'The operation could not be completed.')
          : missing
            ? failure(
                'invalid_request',
                `Base ref '${base}' was not found in the project. No thread was created. Pass a branch, tag, or commit that exists there, or set startFromOrigin:true if it exists only on a remote.`,
              )
            : name === 't3_project_list'
              ? { failed: false, value: { projects: stub.knobs.projects, nextCursor: null } }
              : callTool(name, args, access, stub.threads);
        const text = JSON.stringify(answer.value);
        return send(res, 200, {
          jsonrpc: '2.0',
          id: msg.id,
          result: answer.failed
            ? { content: [{ type: 'text', text }], isError: true }
            : { content: [{ type: 'text', text }], structuredContent: answer.value },
        });
      }
      return send(res, 200, {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found' },
      });
    }

    send(res, 404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.port = (server.address() as AddressInfo).port;
  stub.url = `http://127.0.0.1:${stub.port}`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}

const failure = (code: string, message: string) => ({
  failed: true,
  value: { _tag: 'OrchestratorMcpFailure', code, message },
});

const WAITING = ['preparing', 'queued', 'starting', 'running', 'waiting'];

/**
 * The activity view's page after `afterPosition`, at most `limit` items, as T3 Code pages it (`nextPosition`, the last
 * item's position, and `hasMore`). A question or permission request waiting is the thread's latest item.
 */
function activityPage(
  t: T3StubThread,
  items: Record<string, unknown>[],
  args: Record<string, unknown>,
): { items: Record<string, unknown>[]; nextPosition: number | null; hasMore: boolean } {
  const positioned = items.map((i) => (typeof i.position === 'number' ? i : { ...i, position: t.items - 1 }));
  const after = typeof args.afterPosition === 'number' ? args.afterPosition : -1;
  const limit = typeof args.limit === 'number' ? args.limit : 100;
  const rest = positioned.filter((i) => (i.position as number) > after);
  const page = rest.slice(0, limit);
  const last = page.at(-1)?.position;
  return {
    items: page,
    nextPosition: typeof last === 'number' ? last : null,
    hasMore: rest.length > page.length,
  };
}

/** `t3_thread_read` of a stand-in thread, in T3 Code 0.1.3's shape. */
function threadRead(
  t: T3StubThread,
  view: unknown,
  args: Record<string, unknown> = {},
): Record<string, unknown> {
  const run = t.runs.at(-1) ?? null;
  const live = WAITING.includes(t.status);
  const pending = t.asks.length + (t.approval ? 1 : 0);
  const items: Record<string, unknown>[] = [
    {
      position: 0,
      type: 'user_message',
      status: 'completed',
      text: 'The task.',
      createdBy: 'agent',
      creationSource: 'mcp',
    },
  ];
  if (view === 'messages') {
    if (t.answer)
      items.push({ position: t.items - 1, type: 'assistant_message', status: 'completed', text: t.answer });
  } else {
    items.push(
      ...(t.sent ?? []).map((m) => ({ ...m, type: 'user_message', status: 'completed' })),
      ...t.steps,
      ...t.asks.map(() => ({
        type: 'user_input_request',
        status: 'waiting',
        text: 'A question',
        updatedAt: new Date().toISOString(),
      })),
    );
    if (t.approval)
      items.push({
        type: 'approval_request',
        status: 'waiting',
        text: t.approval,
        updatedAt: new Date().toISOString(),
      });
  }
  return {
    thread: {
      threadId: t.id,
      projectId: t.projectId,
      title: t.title,
      link: `[${t.title}](t3-thread://v1/${t.id})`,
      createdBy: 'agent',
      creationSource: 'mcp',
      status: t.status,
      latestRunId: run,
      activeRunId: live ? run : null,
      runCount: t.runs.length,
      itemCount: t.items,
      pendingRequestCount: pending,
      providerInstanceId: t.provider ?? providerOfModel(t.model ?? 'gpt-5.5'),
      model: t.model ?? 'gpt-5.5',
      worktreePath: t.worktreePath ?? null,
      branch: t.branch ?? null,
      ...(t.parentThreadId
        ? { parentThreadId: t.parentThreadId, relationshipToParent: t.relationshipToParent ?? null }
        : {}),
    },
    recentRuns: run
      ? [
          {
            runId: run,
            ordinal: t.runs.length,
            status: t.status,
            startedAt: t.startedAt,
            completedAt: live ? null : t.completedAt,
          },
        ]
      : [],
    ...(view === 'activity' ? activityPage(t, items, args) : { items }),
  };
}

/** A thread as T3 Code makes it, before its first run. */
function blankThread(id: string, projectId: string, title: string): T3StubThread {
  return {
    id,
    projectId,
    title,
    status: 'preparing',
    runs: [],
    asks: [],
    approval: null,
    answer: null,
    delegating: false,
    items: 0,
    settled: false,
    watching: [],
    linked: [],
    steps: [],
    startedAt: null,
    completedAt: null,
  };
}

/**
 * A message to the thread: a new run that starts with it, as its first item. T3 Code marks who wrote it: the person in
 * its app, or an agent through its tools.
 */
function sendTo(t: T3StubThread, text: string, by: 'user' | 'agent'): string {
  const position = t.items;
  const run = newRun(t);
  const creationSource = by === 'user' ? 'mobile' : 'mcp';
  const updatedAt = new Date().toISOString();
  t.sent = [...(t.sent ?? []), { position, text, createdBy: by, creationSource, updatedAt }];
  return run;
}

/** A thread starts another piece of work: a new run. */
function newRun(t: T3StubThread): string {
  const run = `run:thread:${encodeURIComponent(t.id)}:ordinal:${t.runs.length + 1}`;
  t.runs.push(run);
  t.status = 'running';
  t.answer = null;
  t.items++;
  t.steps = [];
  t.startedAt = new Date().toISOString();
  t.completedAt = null;
  return run;
}

/** The provider a model belongs to, as T3 Code names them (`claude-…` Claude, `muse-…` Muse, else Codex). */
export function providerOfModel(model: string): string {
  if (model.startsWith('claude')) return 'claudeAgent';
  if (model.startsWith('muse')) return 'muse';
  return 'codex';
}

/** The AI programs this T3 Code runs (`orchestrator_capabilities`): three that can run, one switched off. */
export const STUB_PROVIDERS = [
  {
    providerInstanceId: 'codex',
    displayName: 'Codex',
    models: [
      {
        id: 'gpt-6.1-sol',
        options: [
          { id: 'reasoningEffort', values: ['low', 'high', 'xhigh'] },
          { id: 'serviceTier', values: ['default', 'priority'], default: 'priority' },
        ],
      },
    ],
    constraints: [],
  },
  {
    providerInstanceId: 'claudeAgent',
    displayName: 'Claude',
    models: [
      {
        id: 'claude-opus-5-5',
        label: 'Claude Opus 5.5',
        options: [{ id: 'effort', values: ['high', 'xhigh'] }],
      },
    ],
    constraints: [],
  },
  {
    providerInstanceId: 'muse',
    displayName: 'Muse Code',
    models: [{ id: 'muse-wonder-full-1.0', label: 'Muse Wonder Full 1.0', options: [] }],
    constraints: [],
  },
  {
    providerInstanceId: 'cursor',
    displayName: 'Cursor',
    models: [],
    constraints: ['Provider instance is disabled.'],
  },
];

/** What T3 Code answers a tool call with, for the few tools the tests call. */
function callTool(
  name: string,
  args: Record<string, unknown>,
  access: Access,
  threads: Map<string, T3StubThread>,
): { failed: boolean; value: Record<string, unknown> } {
  const changes = ![
    't3_environment_read',
    'orchestrator_capabilities',
    't3_project_list',
    't3_thread_read',
    't3_thread_wait',
    't3_thread_list',
    'list_thread_pull_requests',
  ].includes(name);
  const reads = name === 't3_pending_request' && (args.action === 'list' || args.action === 'read');
  if (changes && !reads && access === 'read-only')
    return failure('orchestration_error', 'The operation could not be completed.');
  const thread = typeof args.threadId === 'string' ? threads.get(args.threadId) : undefined;
  switch (name) {
    case 't3_thread_launch': {
      const id = `mcp:thread-${threads.size + 1}`;
      const t = blankThread(id, String(args.projectId ?? 'mcp:project-1'), String(args.title ?? 'A thread'));
      const strategy = (args.workspaceStrategy ?? null) as Record<string, unknown> | null;
      if (strategy?.type === 'worktree') {
        t.branch = String(strategy.branch ?? 'work');
        t.worktreePath = `/srv/demo/.t3/worktrees/${t.branch.replace(/\//g, '-')}`;
      } else if (strategy?.type === 'existing_worktree') t.worktreePath = String(strategy.worktreePath);
      threads.set(id, t);
      const runId = newRun(t);
      return {
        failed: false,
        value: {
          threadId: id,
          link: `[${t.title}](t3-thread://v1/${id})`,
          projectId: t.projectId,
          runId,
          status: 'preparing',
        },
      };
    }
    case 't3_thread_read':
      if (thread) return { failed: false, value: threadRead(thread, args.view, args) };
      if (typeof args.threadId === 'string' && args.threadId.startsWith('mcp:thread-'))
        return failure('thread_not_found', 'Thread not found.');
      return { failed: false, value: { ok: true } };
    case 't3_thread_list': {
      // Newest first; reviews handed out (`subagent` children) only when asked for, as in T3 Code.
      const contains = typeof args.titleContains === 'string' ? args.titleContains.toLowerCase() : null;
      const listed = [...threads.values()]
        .filter(
          (t) =>
            (args.includeSubagents === true || t.relationshipToParent !== 'subagent') &&
            (typeof args.projectId !== 'string' || t.projectId === args.projectId) &&
            (!contains || t.title.toLowerCase().includes(contains)),
        )
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
      // Pages as T3 Code gives them: `cursor` is how many were listed before, `nextCursor` where the next page starts.
      const from = typeof args.cursor === 'number' ? args.cursor : 0;
      const size = typeof args.limit === 'number' ? args.limit : 50;
      const page = listed.slice(from, from + size);
      return {
        failed: false,
        value: {
          threads: page.map((t) => ({
            threadId: t.id,
            projectId: t.projectId,
            title: t.title,
            status: t.status,
            createdAt: t.createdAt ?? null,
            updatedAt: t.completedAt ?? t.createdAt ?? null,
            model: t.model ?? 'gpt-5.5',
            providerInstanceId: t.provider ?? providerOfModel(t.model ?? 'gpt-5.5'),
            itemCount: t.items,
            parentThreadId: t.parentThreadId ?? null,
            relationshipToParent: t.relationshipToParent ?? null,
          })),
          nextCursor: from + size < listed.length ? from + size : null,
        },
      };
    }
    case 't3_thread_wait': {
      if (!thread) return failure('thread_not_found', 'Thread not found.');
      const run = thread.runs.at(-1) ?? null;
      const ended =
        !WAITING.includes(thread.status) && !(args.untilDelegatedWorkSettled && thread.delegating);
      return {
        failed: false,
        value: { threadId: thread.id, runId: run, status: thread.status, timedOut: !ended },
      };
    }
    case 't3_thread_send': {
      if (!thread) return failure('thread_not_found', 'Thread not found.');
      thread.settled = false;
      return {
        failed: false,
        value: {
          threadId: thread.id,
          runId: sendTo(thread, String(args.message ?? ''), 'agent'),
          mode: 'auto',
        },
      };
    }
    case 't3_thread_organize': {
      if (!thread) return failure('thread_not_found', 'Thread not found.');
      if (args.action !== 'settle') return { failed: false, value: { sequence: 9 } };
      if (WAITING.includes(thread.status) || thread.asks.length || thread.approval)
        return failure(
          'orchestration_error',
          `Thread ${thread.id} is still running. Stop it before settling.`,
        );
      thread.settled = true;
      thread.watching = [];
      return { failed: false, value: { sequence: 9 } };
    }
    case 'list_thread_pull_requests': {
      if (!thread) return failure('thread_not_found', 'Thread not found.');
      return {
        failed: false,
        value: {
          pullRequests: [
            ...thread.watching.map((url) => ({ url, watching: true })),
            ...thread.linked.map((url) => ({ url, watching: false })),
          ].map(({ url, watching }) => ({
            host: 'github.com',
            repository: 'acme/site',
            number: Number(url.split('/').at(-1)),
            url,
            source: 'created',
            headBranch: thread.branch ?? null,
            baseBranch: 'main',
            watching,
            state: thread.merged?.includes(url) ? 'merged' : 'open',
          })),
          chains: [],
        },
      };
    }
    case 't3_thread_interrupt':
      if (thread) thread.status = 'interrupted';
      return { failed: false, value: { ok: true } };
    case 't3_environment_read':
      return { failed: false, value: { ...T3_DESCRIPTOR, preferences: {} } };
    case 'orchestrator_capabilities':
      return { failed: false, value: { providers: STUB_PROVIDERS } };
    case 't3_project_list':
      return {
        failed: false,
        value: {
          projects: [{ id: 'mcp:project-1', title: 'Demo site', workspaceRoot: '/srv/demo' }],
          nextCursor: null,
        },
      };
    case 't3_pending_request':
      if (typeof args.threadId !== 'string')
        return failure(
          'target_required',
          'Pass threadId: this MCP client is not running inside a T3 thread.',
        );
      if (thread) {
        if (args.action === 'list')
          return { failed: false, value: { requestIds: thread.asks.map((a) => a.requestId) } };
        const asked = thread.asks.find((a) => a.requestId === args.requestId);
        if (!asked) return failure('not_found', 'That request is not pending.');
        if (args.action === 'read')
          return { failed: false, value: { requestId: asked.requestId, questions: asked.questions } };
        thread.asks = thread.asks.filter((a) => a !== asked);
        return { failed: false, value: { sequence: 8 } };
      }
      return args.action === 'respond'
        ? { failed: false, value: { sequence: 7 } }
        : { failed: false, value: { requestIds: ['request-1'] } };
    default:
      return { failed: false, value: { ok: true } };
  }
}
