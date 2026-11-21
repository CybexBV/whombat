// Fixture-only evidence. Run capture.mjs before; no server or account is contacted.
import { readFile, writeFile } from 'node:fs/promises';
import { Approval, actionCopy, approvalView, approvalAnswer, KEY_CATALOG, IDLE_EXECUTION } from '../../../../packages/core/src/index.ts';
import { agentWords, theAgentOf, nextAt } from '../../../../packages/client/src/index.ts';
import { deployApproval } from '../../../../packages/fixtures/src/work.ts';
import { dusty } from '../../../../packages/fixtures/src/principals.ts';
import { avatarFile } from '../../../../packages/avatars/src/index.ts';

export async function buildFixtures(captured) {
  const get = (id) => captured.queries.find((q) => q.key[1] === id)?.data;
  const boot = get('conversations.bootstrap');
  const agent = theAgentOf(boot.principals);
  const assistant = agentWords(agent.name).name;
  const names = (id) => {
    const p = boot.principals.find((p) => p.id === id);
    return p ? { name: p.name, shortName: p.shortName ?? p.name } : undefined;
  };
  const now = '2026-09-23T09:22:00.000Z';
  const timeZone = 'Europe/Amsterdam';
  const ctx = { names, viewer: { id: boot.me.id, kind: 'person' }, now, timeZone };
  const everyday = Approval.parse(get('approvals.get').approval);
  const make = (action, keyId) => {
    const copy = actionCopy(action, names, agent.id);
    return Approval.parse({ ...everyday, action, keyId, title: copy.title, question: copy.question,
      target: copy.target, whatHappens: [copy.runs], summary: copy.runs, explainer: '' });
  };
  const command = make({ type: 'run_command', params: {
    command: 'rsync -az --delete --exclude node_modules dist/ deploy@web-1:/srv/billing/releases/2026-09-23 && ssh web-1 "ln -sfn /srv/billing/releases/2026-09-23 /srv/billing/current && sudo systemctl restart billing-api"',
    category: 'deploy_production', target: 'web-1', reason: 'Deploy the invoice PDF change to the billing server.',
  } }, 'deploy.production');
  const deploy = Approval.parse(deployApproval({ requesterId: agent.id,
    summary: deployApproval().summary.replaceAll(dusty.name, assistant),
    explainer: `${assistant} holds a staging key that only turns when you approve. If you approve now, the deploy waits for the other two conditions and goes out on its own.`,
  }));
  const body = ['Hi Priya,',
    'Invoice 1042 for September is paid; the transfer went out this morning and should reach you by Friday.',
    'I’ve attached the remittance advice. Let me know if the amount doesn’t match what you expected.',
    'Thanks,\nMara'].join('\n\n');
  const mail = make({ type: 'mail_send', params: { connectionEmail: 'mara@example.com',
    to: ['priya@northwind.example'], cc: [], bcc: [], subject: 'Invoice 1042',
    bodyPreview: body, body, draftId: 'd1' } }, 'mail.send');
  const key = make({ type: 'grant_key', params: { keyId: 'web.browse' } }, 'web.browse');
  const tonight = nextAt(now, timeZone, get('changeWindow.get')?.start ?? '03:00');
  const result = { assistant, face: agent.face, avatar: avatarFile(agent.face, 64), now, timeZone, tonight, worlds: {} };
  for (const [id, a] of Object.entries({ everyday, command, deploy, mail, key })) {
    const states = {};
    for (const state of ['pending', 'scheduled', 'running', 'done', 'declined', 'failed']) {
      const x = structuredClone(a);
      if (state !== 'pending') {
        x.state = state === 'declined' ? 'declined' : 'approved';
        x.decidedById = boot.me.id;
        x.decidedAt = '2026-09-23T07:46:00.000Z';
        x.conditions = x.conditions.map((c) => c.kind === 'person_approves' ? { ...c, met: state !== 'declined' } : c);
      }
      if (state === 'scheduled') x.executeAt = tonight;
      if (['running', 'done', 'failed'].includes(state)) x.execution = { ...IDLE_EXECUTION,
        state: state === 'done' ? 'succeeded' : state === 'failed' ? 'failed' : 'running',
        startedAt: '2026-09-23T07:46:00.000Z',
        finishedAt: state === 'running' ? null : '2026-09-23T07:46:00.000Z',
        error: state === 'failed' ? 'The server did not accept the command.' : null };
      if (state === 'done') x.executedAt = '2026-09-23T07:46:00.000Z';
      states[state] = { view: approvalView(x, ctx), answer: approvalAnswer(x, ctx) };
    }
    result.worlds[id] = { approval: a, keyLabel: KEY_CATALOG[a.keyId].label, states };
  }
  await writeFile(new URL('fixture-world.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1]?.endsWith('build-fixtures.mjs')) {
  await buildFixtures(JSON.parse(await readFile('.whombat/fixture-light.json', 'utf8')));
}
