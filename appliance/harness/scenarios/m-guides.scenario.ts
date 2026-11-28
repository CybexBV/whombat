/**
 * (m) Guided setup in a person's Chat with the agent and Google connect on the managed stack (contracts ≥ 0.11.0;
 * Whombat assistant-guides.md AG-03, AG-04, AG-08, AG-14, AG-21, one-agent.md OA-01, OA-04; managed-runtime.md
 * MR-62…MR-65; IN-49, IN-394).
 *
 * The environment's runtime runs with `WHOMBAT_GOOGLE=fake` for this file (IN-49): when it doesn't, the scenario
 * switches it, restarts the runtime and puts the previous setting back afterwards. It never does that on a public
 * environment (one that runs real Google): there it is blocked unless the instance already runs the fake.
 *
 * In the person's Chat the agent starts the email guide (`start_guide`, AG-01; the harness takes the runner's place
 * for that one turn, IN-64), after a Google connection an earlier run left is removed, so the guide begins with the
 * provider choice. The person acts on it over the session (`guides.act`): “Google” → the connect card, whose
 * `returnTo` is their Chat with its guide marker; a second act on the answered card is `guide_closed`.
 * `connections.startGoogle` answers the box's own page's `/connect/google` with `code` and `state` (the fake Google skips the
 * consent screen); `connections.finishGoogle` (what the app's `/connect/google` route sends) connects their account and
 * answers the Chat's path with `connected=google`. The Chat then holds the locked connect card (“Connected as …”) and
 * the result card; a second `finishGoogle` with the used state (a reload) posts nothing. The state never appears in any
 * service log of the environment. It stops the environment's runner for the one turn, so it never runs on a public
 * instance.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv, saveEnv } from '../src/dev/env.ts';
import { restartService, startService, stopService } from '../src/dev/restart.ts';
import { paths, ports, publicUrls } from '../src/lib/paths.ts';
import { sleep } from '../src/lib/proc.ts';
import { contractsAtLeast } from '../src/manifest/version.ts';
import { harnessRunner, type ToolResult } from '../src/scenario-kit/agent-turn.ts';
import { type ApplianceSession, sessionOps } from '../src/scenario-kit/app-client.ts';
import { blocked, note } from '../src/scenario-kit/report.ts';
import { ensureSlice, ownerSession, type SliceState } from '../src/scenario-kit/slice.ts';
import { api, ensureWorkspace } from '../src/scenario-kit/work.ts';

const enabled = contractsAtLeast('0.11.0');

// Sign-ins come back to the box's own page (Whombat whombat-link.md LNK-S07, LNK-S08): its loopback page here, its
// HTTPS address on a real box. Not the account site.
const appOrigin = `http://localhost:${ports.direct}`;

interface GuideCard {
  kind: 'guide';
  guide: string;
  node: string;
  title: string;
  state: 'open' | 'done' | 'expired';
  answer: { actionId: string; label: string } | null;
  blocks: {
    type: string;
    id?: string;
    options?: { id: string; disabled?: boolean }[];
    provider?: string;
    services?: string[];
    returnTo?: string;
  }[];
}
interface Msg {
  id: string;
  authorId: string;
  text: string;
  card: ({ kind: string } & Partial<GuideCard>) | null;
}

let slice: SliceState;
/** The person's session: only a Chat's own person may act on its cards. */
let owner: ApplianceSession;
let runnerStopped = false;
/** The Google setting to put back after the file (`undefined`: nothing to restore). */
let restoreGoogle: { previous: 'real' | 'fake' | 'off' | undefined } | undefined;
let publicBlock: string | null = null;

async function reopenOwner(): Promise<void> {
  try {
    owner?.close('closed');
  } catch {
    // already closed
  }
  owner = (await ownerSession(slice)).session;
}

beforeAll(async () => {
  if (!enabled) return;
  slice = await ensureSlice();
  const state = loadEnv();
  if (!state) throw new Error('no environment');
  if (state.google !== 'fake') {
    if (publicUrls) {
      publicBlock = `this environment is public (${publicUrls.web}) and runs Google ${state.google ?? 'real'}; run scenario m in a harness environment of its own`;
    } else {
      restoreGoogle = { previous: state.google };
      state.google = 'fake';
      saveEnv(state);
      await restartService('runtime');
    }
  }
  if (!publicBlock) await reopenOwner();
}, 300_000);

afterAll(async () => {
  if (!enabled) return;
  if (runnerStopped) await startService('runner').catch(() => {});
  try {
    owner?.close('closed');
  } catch {
    // already closed
  }
  if (!restoreGoogle) return;
  const state = loadEnv();
  if (!state) return;
  if (restoreGoogle.previous) state.google = restoreGoogle.previous;
  else delete state.google;
  saveEnv(state);
  await restartService('runtime');
}, 300_000);

const guide = (m: Msg | undefined): GuideCard | null =>
  m?.card?.kind === 'guide' ? (m.card as unknown as GuideCard) : null;

/**
 * The person's message that asked for help: the agent answers in its thread (the Chat is threaded), so the guide's
 * cards are there.
 */
let asked: string | null = null;

async function dmMessages(burrow: string, conversationId: string): Promise<Msg[]> {
  const page = await api<{ messages: Msg[] }>(owner, 'messages.list', 'GET', {
    params: { burrow, conversationId },
    query: { limit: 50 },
  });
  if (!asked) return page.messages;
  const thread = await api<{ replies: Msg[] }>(owner, 'messages.thread', 'GET', {
    params: { burrow, messageId: asked },
  });
  return [...page.messages, ...thread.replies];
}

/** Polls the Chat until `pick` finds a message (the guide posts after its commit). */
async function waitForMessage(
  burrow: string,
  conversationId: string,
  pick: (all: Msg[]) => Msg | undefined,
  what: string,
  timeoutMs = 30_000,
): Promise<{ message: Msg; all: Msg[] }> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const all = await dmMessages(burrow, conversationId);
    const message = pick(all);
    if (message) return { message, all };
    if (Date.now() > until)
      throw new Error(
        `${what}: not in the Chat after ${timeoutMs} ms: ${JSON.stringify(all.map((m) => [m.text.slice(0, 40), guide(m)?.guide, guide(m)?.node, guide(m)?.state])).slice(0, 600)}`,
      );
    await sleep(500);
  }
}

const act = (burrow: string, messageId: string, body: { actionId: string; optionIds?: string[] }) =>
  api<{ ok: boolean }>(owner, 'guides.act', 'POST', { params: { burrow, messageId }, body });

/** A field of a Whombat tool's answer (`structuredContent`, else the JSON of its text). */
function toolField(r: ToolResult, field: string): unknown {
  if (r.structuredContent && field in r.structuredContent) return r.structuredContent[field];
  try {
    return (JSON.parse(r.content?.[0]?.text ?? '{}') as Record<string, unknown>)[field];
  } catch {
    return undefined;
  }
}

/** Every service log of the environment (`env/logs/*.log*`) that contains `needle`. */
function logsContaining(needle: string): string[] {
  if (!existsSync(paths.logs)) return [];
  return readdirSync(paths.logs)
    .filter((f) => f.includes('.log'))
    .filter((f) => readFileSync(join(paths.logs, f), 'latin1').includes(needle));
}

describe.skipIf(!enabled)('m guides', () => {
  it('the policy has Google connect on, and the setup facts name the box’s own page’s /connect/google', async (ctx) => {
    if (publicBlock) blocked(ctx, 'whombat-appliance/public-instance', publicBlock);
    const status = (await sessionOps.applianceStatus(owner)) as {
      policy?: Record<string, { available: boolean; reason: string | null }>;
    };
    note(ctx, 'policy.googleConnect', { googleConnect: status.policy?.googleConnect });
    expect(status.policy?.googleConnect?.available).toBe(true);
    const connectors = await api<{
      mode: string;
      google: { setup: { redirectUri: string; authorizedDomain: string | null } };
    }>(owner, 'connectors.status', 'GET');
    note(ctx, 'connectors.status', { mode: connectors.mode, setup: connectors.google.setup });
    expect(connectors.mode).toBe('fake');
    expect(connectors.google.setup.redirectUri).toBe(`${appOrigin}/connect/google`);
  });

  it('the email guide → Google → connect: finishGoogle over the session posts the result in the Chat', async (ctx) => {
    if (publicBlock) blocked(ctx, 'whombat-appliance/public-instance', publicBlock);
    const ws = await ensureWorkspace(owner, `Guides ${randomBytes(3).toString('hex')}`);
    const burrow = ws.slug;
    const dm = { id: ws.conversationId };
    // Connected already, the guide would answer with the result (AG-05): an earlier run's Google connection goes first.
    const before = await api<{ connections: { id: string; provider: string }[] }>(
      owner,
      'connectors.status',
      'GET',
    );
    for (const c of before.connections.filter((x) => x.provider === 'google'))
      await api(owner, 'connections.remove', 'DELETE', { params: { connectionId: c.id } });

    // The agent starts the email guide in the person's Chat (AG-01): the harness takes the runner's place for the turn.
    const runtimeUrl = loadEnv()?.runtime?.url;
    if (!runtimeUrl) throw new Error('no runtime in this environment');
    await stopService('runner');
    runnerStopped = true;
    const runner = harnessRunner(runtimeUrl);
    const sent = await api<{ message: { id: string } }>(owner, 'messages.send', 'POST', {
      params: { burrow, conversationId: dm.id },
      body: { text: 'Can you help me set up my email?' },
    });
    asked = sent.message.id;
    const turn = await runner.claim(
      (c) =>
        c.dispatch.agentId === ws.agent.id &&
        (c.dispatch.messageId === sent.message.id || c.dispatch.threadRootId === sent.message.id),
      'the agent’s turn',
      90_000,
    );
    const started = await turn.mcp.callTool('start_guide', { topic: 'email' });
    await turn.complete('done');
    await startService('runner');
    runnerStopped = false;
    const startedId = toolField(started, 'messageId');
    note(ctx, 'start_guide', { isError: started.isError ?? false, messageId: startedId });
    expect(started.isError ?? false).toBe(false);
    expect(typeof startedId).toBe('string');

    // The provider choice (AG-05), posted by the agent.
    const intro = await waitForMessage(
      burrow,
      dm.id,
      (all) =>
        all.find((m) => m.id === startedId && guide(m)?.guide === 'email' && guide(m)?.node === 'intro'),
      'the provider choice',
    );
    const introCard = guide(intro.message) as GuideCard;
    note(ctx, 'provider choice', { title: introCard.title, node: introCard.node, state: introCard.state });
    expect(introCard.state).toBe('open');
    expect(intro.message.authorId).toBe(ws.agent.id);
    const providers = introCard.blocks.find((b) => b.type === 'choices' && b.id === 'provider');
    expect(providers?.options?.map((o) => o.id)).toContain('google');

    // Google → the connect card (the fake Google needs no OAuth client, AG-05 a).
    expect((await act(burrow, intro.message.id, { actionId: 'provider', optionIds: ['google'] })).ok).toBe(
      true,
    );
    // A second click on the answered card (another tab) is refused: guide_closed.
    const again = await owner.call(
      { id: 'guides.act', method: 'POST' },
      {
        params: { burrow, messageId: intro.message.id },
        query: {},
        body: { actionId: 'provider', optionIds: ['google'] },
      },
    );
    const againError = (again.body as { error?: { code?: string; details?: { code?: string } } }).error;
    note(ctx, 'second act on the provider choice', { status: again.status, error: againError });
    expect(againError?.details?.code).toBe('guide_closed');
    const connectMsg = await waitForMessage(
      burrow,
      dm.id,
      (all) =>
        all.find((m) => guide(m)?.node === 'connect' && guide(m)?.blocks.some((b) => b.type === 'connect')),
      'the connect card',
    );
    const connectCard = guide(connectMsg.message) as GuideCard;
    const connect = connectCard.blocks.find((b) => b.type === 'connect');
    note(ctx, 'connect card', { guide: connectCard.guide, connect });
    expect(connect?.provider).toBe('google');
    // The person's Chat, opened on the thread the guide is in, with the guide's marker (the apps' route for the Chat).
    expect(connect?.returnTo).toMatch(
      new RegExp(`^/${burrow}/[^?]+\\?thread=${asked}&guide=${connectMsg.message.id}$`),
    );

    // The app passes returnTo unchanged; Google (the fake) comes back to the box's own page's /connect/google.
    const start = await api<{ authorizeUrl: string }>(owner, 'connections.startGoogle', 'POST', {
      body: { services: connect?.services ?? ['mail'], returnTo: connect?.returnTo },
    });
    const back = new URL(start.authorizeUrl);
    const code = back.searchParams.get('code') ?? '';
    const state = back.searchParams.get('state') ?? '';
    note(ctx, 'authorize URL (fake Google)', {
      origin: back.origin,
      path: back.pathname,
      codeLength: code.length,
    });
    expect(`${back.origin}${back.pathname}`).toBe(`${appOrigin}/connect/google`);
    expect(code).not.toBe('');
    expect(state).not.toBe('');

    // What the app's /connect/google route sends over the session (AG-14, MR-63).
    const t0 = Date.now();
    const finished = await api<{ returnPath: string }>(owner, 'connections.finishGoogle', 'POST', {
      body: { code, state },
    });
    note(ctx, 'finishGoogle', { returnPath: finished.returnPath, ms: Date.now() - t0 });
    expect(finished.returnPath.startsWith(`${connect?.returnTo}`)).toBe(true);
    expect(finished.returnPath).toContain('connected=google');

    // The Chat: the connect card locked “Connected as …”, then the result card (AG-08, AG-21).
    const result = await waitForMessage(
      burrow,
      dm.id,
      (all) => all.find((m) => guide(m)?.node === 'result'),
      'the result card',
    );
    const resultCard = guide(result.message) as GuideCard;
    const lockedConnect = guide(result.all.find((m) => m.id === connectMsg.message.id));
    note(ctx, 'result', {
      lead: result.message.text,
      title: resultCard.title,
      state: resultCard.state,
      statusRows: resultCard.blocks.find((b) => b.type === 'status'),
      connectAnswer: lockedConnect?.answer?.label,
    });
    expect(resultCard.state).toBe('done');
    expect(resultCard.title).toContain('you@example.com');
    expect(lockedConnect?.state).toBe('done');
    expect(lockedConnect?.answer?.label).toBe('Connected as you@example.com');
    const after = await api<{ connections: { provider: string; email: string; status: string }[] }>(
      owner,
      'connectors.status',
      'GET',
    );
    const google = after.connections.find((c) => c.provider === 'google');
    note(ctx, 'their connection', { email: google?.email, status: google?.status });
    expect(google?.email).toBe('you@example.com');
    expect(google?.status).toBe('active');

    // A reload of /connect/google (the used state again) posts nothing.
    const count = result.all.length;
    const reload = await api<{ returnPath: string }>(owner, 'connections.finishGoogle', 'POST', {
      body: { code, state },
    });
    note(ctx, 'reload', { returnPath: reload.returnPath });
    await sleep(2000);
    expect((await dmMessages(burrow, dm.id)).length).toBe(count);

    // MR-65: the state (and so the code's pairing) is in no service log of the environment.
    const leaked = logsContaining(state);
    note(ctx, 'logs with the state', { leaked });
    expect(leaked).toEqual([]);
  });
});
