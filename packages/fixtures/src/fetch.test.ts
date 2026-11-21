/**
 * `createFixtureFetch()` read responses validate against their contract's `.response` schema, and the send-message /
 * approve-decline-undo / agent writes behave as the mock's storyline describes.
 */

import { type AnyEndpoint, API_ENDPOINTS, api } from '@whombat/core/contracts';
import { describe, expect, it } from 'vitest';
import { createFixtureFetch } from './fetch.js';

const BASE = 'http://fixtures.local/api/v1';

function endpoint(id: string): AnyEndpoint {
  const ep = API_ENDPOINTS.find((e) => e.id === id);
  if (!ep) throw new Error(`No endpoint ${id}`);
  return ep;
}

async function getJson(fetchFn: typeof fetch, path: string): Promise<unknown> {
  const res = await fetchFn(`${BASE}${path}`);
  expect(res.status).toBeLessThan(400);
  return res.json();
}

describe('read endpoints validate against their contract response schema', () => {
  it('bootstrap, conversations, messages and the agent', async () => {
    const fetchFn = createFixtureFetch();
    const boot = endpoint('conversations.bootstrap').response.parse(
      await getJson(fetchFn, '/burrows/burrow-hq/bootstrap'),
    ) as {
      principals: { id: string; kind: string }[];
      sidebar: { branchRooms: { id: string }[]; dms: { id: string; link: unknown }[] };
    };
    expect(boot.principals.filter((p) => p.kind === 'agent').map((p) => p.id)).toEqual(['prn_dusty']);
    expect(boot.sidebar.branchRooms.map((r) => r.id)).toEqual(['cnv_pr482']);
    expect(boot.sidebar.dms.map((d) => [d.id, d.link])).toEqual([
      ['cnv_dm-dusty', { type: 'dm' }],
      ['cnv_feedback-mara', { type: 'dm', room: 'feedback' }],
    ]);
    const list = endpoint('conversations.list').response.parse(
      await getJson(fetchFn, '/burrows/burrow-hq/conversations'),
    ) as { conversations: { id: string }[] };
    for (const { id } of list.conversations) {
      endpoint('conversations.get').response.parse(
        await getJson(fetchFn, `/burrows/burrow-hq/conversations/${id}`),
      );
      endpoint('messages.list').response.parse(
        await getJson(fetchFn, `/burrows/burrow-hq/conversations/${id}/messages`),
      );
    }
    const agent = endpoint('agent.get').response.parse(
      await getJson(fetchFn, '/burrows/burrow-hq/agent'),
    ) as {
      agent: { id: string; face: string };
      currentRun: { number: number } | null;
    };
    expect(agent.agent).toMatchObject({ id: 'prn_dusty', face: 'dusty' });
    expect(agent.currentRun?.number).toBe(1907);
  });

  it('audit.export returns a CSV of the filtered events', async () => {
    const fetchFn = createFixtureFetch();
    const res = await fetchFn(`${BASE}/burrows/burrow-hq/audit/export?actor=everyone&kind=all`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv');
    const csv = await res.text();
    expect(() => endpoint('audit.export').response.parse(csv)).not.toThrow();
    const [header, ...rows] = csv.trim().split('\r\n');
    expect(header).toBe(
      'event,time,actor,actor_type,kind,type,text,where,key,key_note,on_behalf_of,decided,fingerprint,verified,seq,hash,signature,vault',
    );
    expect(rows.length).toBeGreaterThan(0);
  });

  it('search.query', async () => {
    const fetchFn = createFixtureFetch();
    const body = await getJson(fetchFn, '/burrows/burrow-hq/search?q=rounding+order+VAT+invoices');
    expect(() => endpoint('search.query').response.parse(body)).not.toThrow();
  });

  it('search.ask answers the seeded query and returns a none status for anything else', async () => {
    const fetchFn = createFixtureFetch();
    const asked = await fetchFn(`${BASE}/burrows/burrow-hq/search/answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'have we seen this invoice rounding error before?' }),
    });
    expect(asked.status).toBe(202);
    const askedBody = await asked.json();
    expect(() => endpoint('search.ask').response.parse(askedBody)).not.toThrow();
    expect(askedBody.answer.status).toBe('ready');

    const other = await fetchFn(`${BASE}/burrows/burrow-hq/search/answers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ q: 'something else entirely' }),
    });
    const otherBody = await other.json();
    expect(() => endpoint('search.ask').response.parse(otherBody)).not.toThrow();
    expect(otherBody.answer.status).toBe('none');
  });

  it('search.getAnswer and search.postAnswer', async () => {
    const fetchFn = createFixtureFetch();
    const got = await getJson(fetchFn, '/burrows/burrow-hq/search/answers/ans_vat-rounding');
    expect(() => endpoint('search.getAnswer').response.parse(got)).not.toThrow();

    const missing = await fetchFn(`${BASE}/burrows/burrow-hq/search/answers/ans_missing`);
    expect(missing.status).toBe(404);

    const posted = await fetchFn(`${BASE}/burrows/burrow-hq/search/answers/ans_vat-rounding/post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId: 'cnv_pr482' }),
    });
    expect(posted.status).toBe(201);
    const postedBody = await posted.json();
    expect(() => endpoint('search.postAnswer').response.parse(postedBody)).not.toThrow();
    expect(postedBody.message.authorId).toBe('prn_dusty');

    const list = await getJson(fetchFn, '/burrows/burrow-hq/conversations/cnv_pr482/messages');
    const texts = (list as { messages: { text: string }[] }).messages.map((m) => m.text);
    expect(texts).toContain(postedBody.message.text);
  });

  it('prs.file shows each file with its +add −del (CT-241)', async () => {
    const fetchFn = createFixtureFetch();
    const pr = (await getJson(fetchFn, '/burrows/burrow-hq/prs/482')) as {
      pr: { files: { path: string; add: number; del: number }[] };
    };
    for (const f of pr.pr.files) {
      const body = await getJson(
        fetchFn,
        `/burrows/burrow-hq/prs/482/file?path=${encodeURIComponent(f.path)}`,
      );
      const view = endpoint('prs.file').response.parse(body) as { add: number; del: number };
      expect([view.add, view.del]).toEqual([f.add, f.del]);
    }
    const missing = await fetchFn(`${BASE}/burrows/burrow-hq/prs/482/file?path=nope.ts`);
    expect(missing.status).toBe(404);
  });

  it('canvases.get', async () => {
    const fetchFn = createFixtureFetch();
    const body = await getJson(fetchFn, '/burrows/burrow-hq/canvases/invoice-pdf-export-plan');
    expect(() => endpoint('canvases.get').response.parse(body)).not.toThrow();
  });

  it('canvases.content, work.needsYou and deployments (contracts 0.55)', async () => {
    const fetchFn = createFixtureFetch();
    const content = await getJson(fetchFn, '/burrows/burrow-hq/canvases/invoice-pdf-export-plan/content');
    expect(endpoint('canvases.content').response.parse(content)).toMatchObject({
      markdown: expect.stringContaining('# Invoice PDF export'),
    });
    const needs = await getJson(fetchFn, '/burrows/burrow-hq/needs-you');
    expect(endpoint('work.needsYou').response.parse(needs)).toEqual({ count: 1 });
    const list = endpoint('deployments.list').response.parse(
      await getJson(fetchFn, '/burrows/burrow-hq/deployments?environment=Production&service=api'),
    ) as { deployments: { id: string }[] };
    expect(list.deployments.map((d) => d.id)).toEqual(['dpl_api-prod-3', 'dpl_api-prod-2', 'dpl_api-prod-1']);
    const board = endpoint('deployments.environments').response.parse(
      await getJson(fetchFn, '/burrows/burrow-hq/deployments/environments'),
    ) as {
      environments: { environment: string; services: { service: string; current: { id: string } }[] }[];
    };
    expect(board.environments.map((e) => e.environment)).toEqual(['production', 'staging']);
    expect(board.environments[0]?.services.map((s) => [s.service, s.current.id])).toEqual([
      ['api', 'dpl_api-prod-2'],
      ['web', 'dpl_web-prod-1'],
    ]);
  });
});

describe('unimplemented endpoints 404', () => {
  it('runs.log is out of scope', async () => {
    const fetchFn = createFixtureFetch();
    const res = await fetchFn(`${BASE}/burrows/burrow-hq/runs/1907/log`);
    expect(res.status).toBe(404);
  });
});

describe('writes', () => {
  it('a reply in Mara’s Chat wakes Dusty, and both bump the root’s reply count and heads', async () => {
    const fetchFn = createFixtureFetch();
    const res = await fetchFn(`${BASE}/burrows/burrow-hq/conversations/cnv_dm-dusty/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Thanks.', threadRootId: 'msg_dm-dusty-dusty-0941' }),
    });
    const sent = endpoint('messages.send').response.parse(await res.json()) as { dispatches: unknown[] };
    expect(sent.dispatches).toHaveLength(1);
    const thread = (await getJson(fetchFn, '/burrows/burrow-hq/messages/msg_dm-dusty-dusty-0941/thread')) as {
      root: { replyCount: number; threadParticipantIds: string[] };
      replies: { authorId: string }[];
      where: string;
      topic: string | null;
    };
    expect(thread.root.replyCount).toBe(7);
    expect(thread.root.threadParticipantIds).toEqual(['prn_mara', 'prn_dusty']);
    expect(thread.replies.slice(-2).map((r) => r.authorId)).toEqual(['prn_mara', 'prn_dusty']);
    expect(thread.where).toBe('Chat');
    expect(thread.topic).toBe('PDF libraries');
  });

  it('a message in the branch room wakes Dusty only when it mentions Dusty', async () => {
    const fetchFn = createFixtureFetch();
    const send = async (text: string) => {
      const res = await fetchFn(`${BASE}/burrows/burrow-hq/conversations/cnv_pr482/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      return ((await res.json()) as { dispatches: unknown[] }).dispatches.length;
    };
    expect(await send('Looks good to me.')).toBe(0);
    expect(await send('@Dusty can you rerun the snapshot check?')).toBe(1);
  });

  it('approve fast-forwards the run and PR to their finished state, and blocks undo once executed', async () => {
    const fetchFn = createFixtureFetch();
    const decide = await fetchFn(`${BASE}/burrows/burrow-hq/approvals/12/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(decide.status).toBe(200);
    const decideBody = await decide.json();
    expect(decideBody.approval.state).toBe('approved');
    expect(decideBody.approval.executedAt).not.toBeNull();

    const run = await getJson(fetchFn, '/burrows/burrow-hq/runs/1907');
    expect((run as { run: { status: string } }).run.status).toBe('done');

    const pr = await getJson(fetchFn, '/burrows/burrow-hq/prs/482');
    expect((pr as { pr: { headSha: string } }).pr.headSha).toBe('7be20f7');

    const undo = await fetchFn(`${BASE}/burrows/burrow-hq/approvals/12/undo`, { method: 'POST' });
    const undoBody = await undo.json();
    expect(undoBody.eventId).toBeNull();
    expect(undoBody.approval.state).toBe('approved');
  });

  it('merge answers 409 while blocked, then merges once checks and review pass', async () => {
    const fetchFn = createFixtureFetch();
    const merge = () =>
      fetchFn(`${BASE}/burrows/burrow-hq/prs/482/merge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
    const blocked = await merge();
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.details.mergeBlock).toBe('checks');

    await fetchFn(`${BASE}/burrows/burrow-hq/approvals/12/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    const merged = await merge();
    expect(merged.status).toBe(200);
    const body = endpoint('prs.merge').response.parse(await merged.json()) as {
      status: string;
      pr: { state: string };
    };
    expect(body.status).toBe('merged');
    expect(body.pr.state).toBe('merged');
    expect((await merge()).status).toBe(409);
  });

  it('pauses, resumes and takes over the run like the server does', async () => {
    const fetchFn = createFixtureFetch();
    const post = (action: string) =>
      fetchFn(`${BASE}/burrows/burrow-hq/runs/1907/${action}`, { method: 'POST' });

    const paused = await post('pause');
    expect(paused.status).toBe(200);
    const pausedBody = await paused.json();
    expect(() => endpoint('runs.pause').response.parse(pausedBody)).not.toThrow();
    expect(pausedBody.run).toMatchObject({ status: 'paused', pausedById: 'prn_mara' });
    expect((await post('pause')).status).toBe(409);

    const resumed = await (await post('resume')).json();
    expect(resumed.run).toMatchObject({ status: 'live', pausedById: null });

    const taken = await post('take-over');
    const takenBody = await taken.json();
    expect(() => endpoint('runs.takeOver').response.parse(takenBody)).not.toThrow();
    expect(takenBody.run).toMatchObject({ status: 'taken_over', takenOverById: 'prn_mara' });
    expect(takenBody.instructions).toBe('git fetch origin feat/invoice-pdf && git switch feat/invoice-pdf');
    expect((await post('take-over')).status).toBe(409);

    const log = await getJson(fetchFn, '/burrows/burrow-hq/audit');
    const events = (log as { events: { type: string; aboutId?: string | null }[] }).events;
    for (const type of ['run.paused', 'run.resumed', 'run.taken_over'])
      expect(events.find((e) => e.type === type)?.aboutId).toBe('prn_dusty');
  });

  it('only knows run #1907 and approval #12', async () => {
    const fetchFn = createFixtureFetch();
    expect((await fetchFn(`${BASE}/burrows/burrow-hq/runs/42`)).status).toBe(404);
    expect((await fetchFn(`${BASE}/burrows/burrow-hq/approvals/99`)).status).toBe(404);
    const decide = await fetchFn(`${BASE}/burrows/burrow-hq/approvals/99/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(decide.status).toBe(404);
    expect((await fetchFn(`${BASE}/burrows/burrow-hq/approvals/12`)).status).toBe(200);
  });

  it('decline then undo returns the approval to pending', async () => {
    const fetchFn = createFixtureFetch();
    const decide = await fetchFn(`${BASE}/burrows/burrow-hq/approvals/12/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'decline', note: 'not yet' }),
    });
    const declineBody = await decide.json();
    expect(declineBody.approval.state).toBe('declined');

    const undo = await fetchFn(`${BASE}/burrows/burrow-hq/approvals/12/undo`, { method: 'POST' });
    const undoBody = await undo.json();
    expect(undoBody.approval.state).toBe('pending');
    expect(undoBody.eventId).not.toBeNull();
  });

  it('agent.update renames the agent and changes its face, and refuses a reserved name', async () => {
    const fetchFn = createFixtureFetch();
    const patch = (body: unknown) =>
      fetchFn(`${BASE}/burrows/burrow-hq/agent`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const renamed = await patch({ name: 'Hazel', face: 'hazel' });
    expect(renamed.status).toBe(200);
    expect(endpoint('agent.update').response.parse(await renamed.json())).toMatchObject({
      agent: { id: 'prn_dusty', name: 'Hazel', face: 'hazel' },
    });
    const profile = (await getJson(fetchFn, '/burrows/burrow-hq/agent')) as { agent: { name: string } };
    expect(profile.agent.name).toBe('Hazel');
    const reserved = await patch({ name: 'Whombat' });
    expect(reserved.status).toBe(400);
    expect((await reserved.json()).error).toMatchObject({
      code: 'validation_failed',
      fields: { name: [expect.any(String)] },
    });
  });

  it('serves Mara’s memory and the notes, and writes them within Hermes’s limits (CT-1200…CT-1206)', async () => {
    const fetchFn = createFixtureFetch();
    const mine = api.memory.mine.response.parse(await getJson(fetchFn, '/burrows/burrow-hq/memory'));
    expect([mine.memory.limit, mine.user.limit]).toEqual([2200, 1375]);
    expect(mine.memory.used).toBeGreaterThan(0);
    const put = (file: string, body: unknown) =>
      fetchFn(`${BASE}/burrows/burrow-hq/memory/${file}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const written = await put('user', { text: 'Mara\n§\nPrefers tea', ifVersion: mine.user.version });
    expect(api.memory.write.response.parse(await written.json()).user.text).toBe('Mara\n§\nPrefers tea');
    expect((await put('user', { text: 'x', ifVersion: mine.user.version })).status).toBe(409);
    const long = await put('user', { text: 'y'.repeat(1400) });
    expect(((await long.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'too_long',
    );
    const cleared = await fetchFn(`${BASE}/burrows/burrow-hq/memory?file=memory`, { method: 'DELETE' });
    expect(api.memory.clear.response.parse(await cleared.json()).memory.used).toBe(0);
    const notes = api.memory.notes.response.parse(await getJson(fetchFn, '/burrows/burrow-hq/agent/notes'));
    expect(notes.limit).toBe(1500);
  });

  it('lists Mara’s skills in one list and removes a learned one (CT-1210…CT-1216, CT-1433, CT-1582)', async () => {
    const fetchFn = createFixtureFetch();
    const library = api.skills.library.response.parse(
      await getJson(fetchFn, '/burrows/burrow-hq/skills/library'),
    );
    const learned = library.items.filter((i) => i.origin === 'learned').map((i) => i.name);
    expect(learned).toEqual(['billing-deploy', 'grafana-billing-report']);
    expect(new Set(library.items.map((i) => i.origin))).toEqual(new Set(['builtin', 'hub', 'learned']));
    expect(library.items.find((i) => i.name === 'gif-search')?.status).toBe('removed');
    expect(library.items.find((i) => i.name === 'claude-code')?.status).toBe('off');
    expect(library.items.find((i) => i.name === 'notion')?.needs.env.map((e) => e.name)).toEqual([
      'NOTION_API_KEY',
    ]);
    expect(library.categories.map((c) => c.category)).toContain('productivity');
    const one = api.skills.librarySkill.response.parse(
      await getJson(fetchFn, '/burrows/burrow-hq/skills/library/skill?name=obsidian'),
    );
    expect([one.item.changed, one.original?.changes.length]).toEqual([true, 1]);
    const removed = await fetchFn(`${BASE}/burrows/burrow-hq/skills/library/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'grafana-billing-report' }),
    });
    expect(api.skills.libraryRemove.response.parse(await removed.json()).item).toBeNull();
    const shared = await fetchFn(`${BASE}/burrows/burrow-hq/skills/library/share`, { method: 'POST' });
    expect(shared.status).toBe(404);
  });

  it('browses Hermes’s hub, previews, installs a clean skill and refuses a blocked one (CT-1413…CT-1415)', async () => {
    const fetchFn = createFixtureFetch();
    const post = (path: string, body: unknown) =>
      fetchFn(`${BASE}/burrows/burrow-hq/skills/hub/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const browse = api.skills.hubSearch.response.parse(
      await getJson(fetchFn, '/burrows/burrow-hq/skills/hub/search'),
    );
    expect(browse.results.find((r) => r.name === 'canvas')?.installed).toBe(true);
    const official = api.skills.hubSearch.response.parse(
      await getJson(fetchFn, '/burrows/burrow-hq/skills/hub/search?source=official&q=hue'),
    );
    expect(official.results.map((r) => r.identifier)).toEqual(['official/smart-home/openhue']);
    const preview = api.skills.hubPreview.response.parse(
      await getJson(fetchFn, '/burrows/burrow-hq/skills/hub/preview?identifier=anthropics/skills/skills/pdf'),
    );
    expect([preview.scan.verdict, preview.policy.decision]).toEqual(['safe', 'allow']);
    const installed = await post('install', { identifier: 'anthropics/skills/skills/pdf' });
    expect(installed.status).toBe(201);
    const item = api.skills.hubInstall.response.parse(await installed.json()).item;
    expect([item.origin, item.hub?.source]).toEqual(['hub', 'github']);
    expect((await post('install', { identifier: 'anthropics/skills/skills/pdf' })).status).toBe(409);
    const blocked = await post('install', { identifier: 'skills-sh/someone/agent-tricks/clipboard-sync' });
    expect([
      blocked.status,
      ((await blocked.json()) as { error: { details: { code: string } } }).error.details.code,
    ]).toEqual([403, 'skill_blocked']);
    const updates = api.skills.hubUpdates.response.parse(
      await getJson(fetchFn, '/burrows/burrow-hq/skills/hub/updates'),
    );
    expect(updates.available).toEqual(['skill-creator']);
    const updated = api.skills.hubUpdate.response.parse(
      await (await post('update', { name: 'skill-creator' })).json(),
    );
    expect([updated.item.hub?.updateAvailable, updated.item.can.update]).toEqual([false, false]);
  });

  it('setKeys replaces the agent’s grants and writes one Keys event per change', async () => {
    const fetchFn = createFixtureFetch();
    const before = (await getJson(fetchFn, '/burrows/burrow-hq/agent')) as {
      grants: { keyId: string; tier: string; scope?: unknown }[];
    };
    const grants = before.grants
      .filter((g) => g.keyId !== 'merge')
      .map(({ keyId, tier, scope }) => ({ keyId, tier, ...(scope ? { scope } : {}) }));
    grants.push({ keyId: 'merge', tier: 'can' });

    const res = await fetchFn(`${BASE}/burrows/burrow-hq/agent/keys`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grants }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(() => endpoint('agent.setKeys').response.parse(body)).not.toThrow();
    expect(body.events.length).toBeGreaterThan(0);

    const after = (await getJson(fetchFn, '/burrows/burrow-hq/agent')) as {
      grants: { keyId: string; tier: string }[];
      keys: { keys: number; askFirst: number };
    };
    expect(after.grants.find((g) => g.keyId === 'merge')?.tier).toBe('can');
    expect(after.keys.keys).toBe(before.grants.filter((g) => g.tier === 'can').length + 1);
  });
});

describe('FixtureFetchOptions (TODO 16.4: forcing quiet loading/error states)', () => {
  it('failing 500s only the listed endpoint ids; everything else still serves fixture data', async () => {
    const fetchFn = createFixtureFetch({ failing: ['agent.get'] });
    const failed = await fetchFn(`${BASE}/burrows/burrow-hq/agent`);
    expect(failed.status).toBe(500);
    const body = (await failed.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('server_error');

    const ok = await getJson(fetchFn, '/burrows/burrow-hq/bootstrap');
    expect(() => endpoint('conversations.bootstrap').response.parse(ok)).not.toThrow();
  });

  it('failing is a fixed set: a retry of the same endpoint keeps failing', async () => {
    const fetchFn = createFixtureFetch({ failing: new Set(['audit.list']) });
    const first = await fetchFn(`${BASE}/burrows/burrow-hq/audit`);
    const second = await fetchFn(`${BASE}/burrows/burrow-hq/audit`);
    expect(first.status).toBe(500);
    expect(second.status).toBe(500);
  });

  it('with no options, behaves exactly like createFixtureFetch() (no latency, nothing failing)', async () => {
    const fetchFn = createFixtureFetch({});
    const res = await fetchFn(`${BASE}/burrows/burrow-hq/agent`);
    expect(res.status).toBe(200);
  });
});
