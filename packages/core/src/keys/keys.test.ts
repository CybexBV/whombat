import { describe, expect, it } from 'vitest';
import { dusty, GRANTS, mara } from '../__fixtures__/world.js';
import type { Grant } from '../domain/grant.js';
import {
  ACCOUNT_KEYS,
  ACCOUNT_TIER_KEYS,
  AGENT_DEFAULT_KEYS,
  ALL_KEY_OPTIONS,
  ALWAYS_ASKS_KEYS,
  ALWAYS_ON_EXCEPTIONS,
  ALWAYS_ON_KEYS,
  actionKey,
  agentDefaultGrants,
  agentMaxTier,
  alwaysAllowLabel,
  branchWriteKey,
  canonicalKey,
  clampGrants,
  clampTier,
  DEPLOY_NO_WORKFLOW_HINT,
  decide,
  describeAction,
  describeAsk,
  describeBlocked,
  describeDecision,
  describeGrantChange,
  diffGrants,
  formatKeysSummary,
  globMatch,
  grantLabel,
  impliedBy,
  impliedKeyRows,
  isAlwaysOnKey,
  isRetiredKey,
  KEY_CATALOG,
  KEY_IDS,
  KEY_LIST,
  KEY_RISK_ROWS,
  KEY_TIER_CHOICES,
  KEY_TIER_LABELS,
  KEY_TIER_ROW_KEYS,
  KEY_TIER_ROWS,
  KeyId,
  keyChain,
  keyLabel,
  keyNoteFor,
  keyOrder,
  keyRows,
  keyRowTier,
  keysSummary,
  keyTierRowLabel,
  keyTierRowOf,
  lockedNote,
  PEOPLE_ONLY_KEYS,
  RETIRED_KEYS,
  RISK_KEY_OPTIONS,
  RISK_ROW_KEYS,
  type Tier,
  validateGrants,
  withKeyRowTier,
} from './index.js';

/** Every key string in the mocks: AG0 can/ask/cannot, the log keys and the run page. */
const MOCK_KEY_STRINGS = [
  'Read all connected repos',
  'Write canvases',
  'Write code',
  'Deploy',
  'Read and write feat/* branches',
  'Run tests',
  'Open pull requests',
  'Push to shared branches',
  'Merge into main',
  'Search messages, canvases and runs',
  'Read connected repos',
  'Browse the web',
  'Message people outside your Whombat',
  'Comment on pull requests',
  'Request changes',
  'Approve pull requests',
  'Merge',
  'Run CI',
  'Run scheduled jobs',
  'Retry failed pipelines',
  'Deploy to staging',
  'Deploy to production',
  'Change code',
  'Read customer accounts',
  'Reply in the help widget',
  'Tag tickets',
  'Issue refunds',
  'Change billing data',
  'Write to feat/* branches',
  'Run tests and CI',
];

const agentActor = (a: { id: string }) => ({ id: a.id, kind: 'agent' as const });

/** Dusty's grants, written out: `[keyId, tier]` pairs. */
const held = (...rows: [KeyId, Tier][]): Grant[] =>
  rows.map(([keyId, tier]) => ({ agentId: dusty.id, keyId, tier }));

/** Narrow grant sets the engine tests need (the mock's AG0 sets, held by Dusty). */
const DEVELOPER = held(
  ['branch.feature.readwrite', 'can'],
  ['tests.run', 'can'],
  ['pr.open', 'can'],
  ['branch.shared.push', 'ask'],
  ['merge.main', 'cannot'],
  ['deploy', 'cannot'],
);
const ARCHITECT = held(
  ['repos.read_all', 'can'],
  ['canvas.write', 'can'],
  ['code.write', 'cannot'],
  ['deploy', 'cannot'],
);
const REVIEWER = held(
  ['pr.comment', 'can'],
  ['pr.approve', 'can'],
  ['merge', 'cannot'],
  ['code.write', 'cannot'],
);
const OPERATOR = held(
  ['ci.run', 'can'],
  ['pipelines.retry', 'can'],
  ['deploy.staging', 'ask'],
  ['deploy.production', 'ask'],
  ['code.change', 'cannot'],
);
const SUPPORT = held(['customers.read', 'can'], ['refunds.issue', 'ask'], ['billing.write', 'cannot']);

describe('key catalog', () => {
  it('has a stable id and a verbatim label for every key string in the mocks', () => {
    const labels = KEY_LIST.map((k) => k.label);
    for (const s of MOCK_KEY_STRINGS) expect(labels).toContain(s);
    expect(keyLabel('tests.run')).toBe('Run tests');
    // No channel keys any more (Whombat one-agent.md OA-04).
    const ids: readonly string[] = KEY_IDS;
    for (const gone of ['channels.read', 'channels.create', 'tasks.create']) expect(ids).not.toContain(gone);
  });

  it('has unique ids and labels, and consistent relations', () => {
    expect(new Set(KEY_IDS).size).toBe(KEY_IDS.length);
    expect(new Set(KEY_LIST.map((k) => k.label)).size).toBe(KEY_LIST.length);
    for (const def of KEY_LIST) {
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      if (def.sameAs) {
        expect(KEY_CATALOG[def.sameAs].sameAs).toBeUndefined();
        expect(def.parent).toBeUndefined();
      }
      if (def.parent) expect(KEY_IDS).toContain(def.parent);
      for (const implied of def.implies ?? []) expect(KEY_IDS).toContain(implied);
      // A key is never more permissive than its umbrella.
      const rank = { never: 0, ask: 1, can: 2 } as const;
      for (const k of keyChain(def.id))
        expect(rank[agentMaxTier(def.id)]).toBeLessThanOrEqual(rank[agentMaxTier(k)]);
    }
  });

  it('lets agents hold Merge into main, the deploy keys and Push to main at any tier (CT-211, CT-222)', () => {
    for (const keyId of ['merge', 'merge.main', 'deploy', 'deploy.staging', 'deploy.production'] as const) {
      expect(agentMaxTier(keyId), keyId).toBe('can');
      expect(lockedNote(keyId), keyId).toBeNull();
      expect(KEY_CATALOG[keyId].description, keyId).not.toMatch(/people|ask a person/i);
    }
    expect(KEY_CATALOG['merge.main'].description).toBe('Merge pull requests into the default branch.');
    expect(KEY_CATALOG.deploy.description).toBe('Deploy to any environment.');
    expect(PEOPLE_ONLY_KEYS).not.toContain('merge.main');
    expect(PEOPLE_ONLY_KEYS).toEqual(['agents.manage', 'approvals.decide', 'burrow.manage']);
    expect(ALWAYS_ASKS_KEYS).toEqual(['share.link', 'mail.send', 'calendar.invite', 'files.share']);
    expect(KEY_CATALOG['branch.main.push']).toMatchObject({ label: 'Push to main', group: 'code' });
    expect(KEY_CATALOG['branch.main.push'].parent).toBeUndefined();
    // Since 0.36 agents may hold Push to main (Whombat AC-41): Off · Ask · On like Merge and Deploy.
    expect(agentMaxTier('branch.main.push')).toBe('can');
    expect(lockedNote('branch.main.push')).toBeNull();
    expect(KEY_CATALOG['branch.main.push'].description).toBe(
      'Push commits straight to the default branch, without a pull request.',
    );
    expect(KEY_CATALOG['commands.destructive']).toMatchObject({
      label: 'Destructive commands on other machines',
      group: 'operations',
      agentMaxTier: 'can',
    });
    expect(lockedNote('mail.send')).toBe('always asks a person');
    expect(lockedNote('tests.run')).toBeNull();
  });

  it('resolves wordings and umbrellas', () => {
    expect(canonicalKey('repos.read_all')).toBe('repos.read');
    expect(canonicalKey('code.change')).toBe('code.write');
    expect(canonicalKey('branch.feature.write')).toBe('branch.feature.readwrite');
    expect(keyChain('deploy.staging')).toEqual(['deploy.staging', 'deploy']);
    expect(keyChain('merge.main')).toEqual(['merge.main', 'merge']);
    expect(keyChain('branch.feature.write')).toEqual(['branch.feature.readwrite', 'code.write']);
  });
});

describe('the agent’s default keys (OA-05)', () => {
  const agent = { id: 'prn_x', kind: 'agent' as const };
  const grants = agentDefaultGrants('prn_x');

  it('are a person’s accounts, everything else on and the six risk rows at Ask', () => {
    expect(validateGrants(grants)).toEqual({ ok: true });
    expect(grants.every((g) => g.agentId === 'prn_x')).toBe(true);
    const ids = grants.map((g) => g.keyId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(AGENT_DEFAULT_KEYS.cannot).toEqual([]);
    for (const k of ALWAYS_ON_KEYS) expect(AGENT_DEFAULT_KEYS.can, k).toContain(k);
    expect(AGENT_DEFAULT_KEYS.can).toContain('connections.write');
    expect(AGENT_DEFAULT_KEYS.can).toContain('mail.read');
    for (const k of RISK_ROW_KEYS) expect(AGENT_DEFAULT_KEYS.ask, k).toContain(k);
    for (const k of ALWAYS_ASKS_KEYS) expect(AGENT_DEFAULT_KEYS.ask, k).toContain(k);
    // Approving pull requests stays a person’s thing; people-only and retired keys are nobody’s.
    for (const k of ['pr.approve', ...PEOPLE_ONLY_KEYS, ...RETIRED_KEYS] as KeyId[])
      expect(ids, k).not.toContain(k);
    for (const row of KEY_TIER_ROWS) expect(keyRowTier(grants, row), row).toBe('ask');
    // The world's Dusty holds exactly these.
    expect(GRANTS).toEqual(agentDefaultGrants(dusty.id));
  });

  it('work without a person but for the rows, sending and approving pull requests', () => {
    expect(decide(agent, grants, 'web.browse').outcome).toBe('allow');
    expect(decide(agent, grants, 'code.write').outcome).toBe('allow');
    expect(decide(agent, grants, 'branch.shared.push', { branch: 'release/1' }).outcome).toBe('allow');
    expect(decide(agent, grants, 'branch.feature.readwrite', { branch: 'feat/a' }).outcome).toBe('allow');
    expect(decide(agent, grants, 'mail.read').outcome).toBe('allow');
    expect(decide(agent, grants, 'mail.send').outcome).toBe('ask');
    expect(decide(agent, grants, 'merge.main').outcome).toBe('ask');
    expect(decide(agent, grants, 'deploy.production').outcome).toBe('ask');
    expect(decide(agent, grants, 'billing.write').outcome).toBe('ask');
    expect(decide(agent, grants, 'packs.tool.write').outcome).toBe('deny');
    expect(decide(agent, grants, 'pr.approve').outcome).toBe('deny');
    expect(decide(agent, grants, 'agents.manage').outcome).toBe('deny');
  });

  it('render as key rows: can, then ask, each in catalog order', () => {
    const rows = keyRows(grants);
    const byOrder = (ids: readonly KeyId[]) => [...ids].sort((a, b) => keyOrder(a) - keyOrder(b));
    expect(rows.filter((r) => r.tier === 'can').map((r) => r.keyId)).toEqual(byOrder(AGENT_DEFAULT_KEYS.can));
    expect(rows.filter((r) => r.tier === 'ask').map((r) => r.keyId)).toEqual(byOrder(AGENT_DEFAULT_KEYS.ask));
    expect(rows.some((r) => r.tier === 'cannot')).toBe(false);
  });

  it('render a narrow set like the run page', () => {
    expect(keyRows(DEVELOPER).map((r) => [r.mark, r.label, r.note])).toEqual([
      ['✓', 'Read and write feat/* branches', ''],
      ['✓', 'Run tests', ''],
      ['✓', 'Open pull requests', ''],
      ['?', 'Push to shared branches', 'asks a person'],
      ['×', 'Merge into main', 'no key'],
      ['×', 'Deploy', 'no key'],
    ]);
  });

  it('summarise as “3 keys · 1 ask first”, without channels', () => {
    expect(formatKeysSummary(keysSummary(DEVELOPER))).toBe('3 keys · 1 ask first');
    expect(formatKeysSummary(keysSummary(OPERATOR))).toBe('2 keys · 2 ask first');
    expect(formatKeysSummary({ keys: 1, askFirst: 0 })).toBe('1 key · 0 ask first');
    expect(keysSummary(grants)).toEqual({
      keys: AGENT_DEFAULT_KEYS.can.length,
      askFirst: AGENT_DEFAULT_KEYS.ask.length,
    });
  });
});

describe('decide()', () => {
  it('allows keys an agent holds, within scope', () => {
    const d = decide(agentActor(dusty), DEVELOPER, 'branch.feature.readwrite', {
      branch: 'feat/invoice-pdf',
    });
    expect(d).toMatchObject({ outcome: 'allow', tier: 'can', reason: 'granted' });
    expect(decide(agentActor(dusty), DEVELOPER, 'tests.run').outcome).toBe('allow');
    expect(decide(agentActor(dusty), GRANTS, 'messages.search').outcome).toBe('allow');
  });

  it('fails closed outside the key’s inherent scope', () => {
    expect(
      decide(agentActor(dusty), DEVELOPER, 'branch.feature.readwrite', { branch: 'release/1.2' }),
    ).toMatchObject({
      outcome: 'deny',
      reason: 'out_of_scope',
    });
    expect(decide(agentActor(dusty), DEVELOPER, 'branch.feature.readwrite').reason).toBe('out_of_scope');
  });

  it('merges into main by the Merge key: allowed, asked or denied by its tier (CT-211)', () => {
    // The defaults ask before a merge into main.
    expect(decide(agentActor(dusty), GRANTS, 'merge.main')).toMatchObject({
      outcome: 'ask',
      reason: 'asks_first',
    });
    const d = decide(agentActor(dusty), DEVELOPER, 'merge.main');
    expect(d).toMatchObject({ outcome: 'deny', tier: 'cannot' });
    expect(d.reason).not.toBe('people_only');
    const at = (tier: Grant['tier']): Grant[] => held(['merge', tier]);
    expect(decide(agentActor(dusty), at('can'), 'merge.main')).toMatchObject({
      outcome: 'allow',
      reason: 'granted',
      grantKeyId: 'merge',
      clamped: false,
    });
    expect(decide(agentActor(dusty), at('ask'), 'merge.main')).toMatchObject({
      outcome: 'ask',
      reason: 'asks_first',
      grantKeyId: 'merge',
    });
    expect(decide(agentActor(dusty), at('cannot'), 'merge.main')).toMatchObject({
      outcome: 'deny',
      reason: 'denied',
    });
    expect(decide(agentActor(dusty), held(['merge.main', 'can']), 'merge.main').outcome).toBe('allow');
    // A stale narrower grant still decides over the umbrella: that is why the Merge row aligns it (`withKeyRowTier`).
    const stale = held(['merge.main', 'cannot'], ['merge', 'can']);
    expect(decide(agentActor(dusty), stale, 'merge.main')).toMatchObject({
      outcome: 'deny',
      reason: 'denied',
    });
    expect(decide(agentActor(dusty), stale, 'merge').outcome).toBe('allow');
    const row = withKeyRowTier(
      stale.map(({ agentId: _a, ...g }) => g),
      'merge',
      'can',
    ).map((g) => ({ agentId: dusty.id, ...g }));
    expect(decide(agentActor(dusty), row, 'merge.main').outcome).toBe('allow');
    // Push to main is the agent's own key since 0.36 (CT-222): its tier decides.
    expect(decide(agentActor(dusty), held(['branch.main.push', 'can']), 'branch.main.push')).toMatchObject({
      outcome: 'allow',
      reason: 'granted',
    });
    // People-only keys stay denied whatever an agent holds.
    expect(decide(agentActor(dusty), GRANTS, 'approvals.decide').reason).toBe('people_only');
  });

  it('deploys by the Deploy key: the defaults ask, and On deploys without asking (CT-211)', () => {
    expect(decide(agentActor(dusty), GRANTS, 'deploy.staging')).toMatchObject({
      outcome: 'ask',
      reason: 'asks_first',
      grantKeyId: 'deploy.staging',
    });
    expect(decide(agentActor(dusty), GRANTS, 'deploy.production').outcome).toBe('ask');
    expect(decide(agentActor(dusty), OPERATOR, 'deploy.production').outcome).toBe('ask');
    expect(decide(agentActor(dusty), held(['deploy.staging', 'can']), 'deploy.staging')).toMatchObject({
      outcome: 'allow',
      reason: 'granted',
      clamped: false,
    });
    expect(decide(agentActor(dusty), held(['deploy', 'can']), 'deploy.production')).toMatchObject({
      outcome: 'allow',
      grantKeyId: 'deploy',
    });
    // Mail is still capped at ask: a `can` grant asks (always_asks).
    expect(decide(agentActor(dusty), held(['mail.send', 'can']), 'mail.send')).toMatchObject({
      outcome: 'ask',
      reason: 'always_asks',
      clamped: true,
    });
  });

  it('applies umbrella cannot keys (Blocked outcomes)', () => {
    // Deploy at cannot → deploying to staging is blocked.
    expect(decide(agentActor(dusty), DEVELOPER, 'deploy.staging')).toMatchObject({
      outcome: 'deny',
      reason: 'denied',
      grantKeyId: 'deploy',
    });
    // Merge at cannot → merging into any branch is blocked.
    expect(decide(agentActor(dusty), REVIEWER, 'merge')).toMatchObject({ outcome: 'deny', reason: 'denied' });
    // Change code (= Write code) at cannot → feature branches are blocked.
    expect(
      decide(agentActor(dusty), OPERATOR, 'branch.feature.readwrite', { branch: 'feat/x' }),
    ).toMatchObject({
      outcome: 'deny',
      reason: 'denied',
      grantKeyId: 'code.write',
    });
    // Write code at cannot → shared branches are blocked.
    expect(decide(agentActor(dusty), ARCHITECT, 'branch.shared.push').reason).toBe('denied');
  });

  it('asks for ask-tier keys and denies keys the agent lacks', () => {
    expect(decide(agentActor(dusty), DEVELOPER, 'branch.shared.push').outcome).toBe('ask');
    expect(decide(agentActor(dusty), SUPPORT, 'refunds.issue').outcome).toBe('ask');
    expect(decide(agentActor(dusty), SUPPORT, 'tests.run')).toMatchObject({
      outcome: 'deny',
      reason: 'no_key',
    });
    expect(decide(agentActor(dusty), SUPPORT, 'billing.write').reason).toBe('denied');
  });

  it('treats other wordings as the same key', () => {
    expect(decide(agentActor(dusty), ARCHITECT, 'repos.read').outcome).toBe('allow');
    expect(decide(agentActor(dusty), GRANTS, 'repos.read_all').outcome).toBe('allow');
  });

  it('expands bundles, with explicit grants winning over bundle-derived ones', () => {
    const grants: Grant[] = [{ agentId: 'prn_nugget', keyId: 'tests_ci.run', tier: 'can' }];
    const nugget = { id: 'prn_nugget', kind: 'agent' as const };
    expect(decide(nugget, grants, 'tests.run').outcome).toBe('allow');
    expect(decide(nugget, grants, 'ci.run').outcome).toBe('allow');
    const withOverride: Grant[] = [...grants, { agentId: 'prn_nugget', keyId: 'tests.run', tier: 'cannot' }];
    expect(decide(nugget, withOverride, 'tests.run').outcome).toBe('deny');
    expect(decide(nugget, withOverride, 'ci.run').outcome).toBe('allow');
  });

  it('lets a specific grant override an umbrella, and picks the strictest at one level', () => {
    const nugget = { id: 'prn_nugget', kind: 'agent' as const };
    const grants: Grant[] = [
      { agentId: 'prn_nugget', keyId: 'deploy', tier: 'cannot' },
      { agentId: 'prn_nugget', keyId: 'deploy.staging', tier: 'ask' },
    ];
    expect(decide(nugget, grants, 'deploy.staging').outcome).toBe('ask');
    expect(decide(nugget, grants, 'deploy.production').outcome).toBe('deny');
    const both: Grant[] = [
      { agentId: 'prn_nugget', keyId: 'repos.read', tier: 'can' },
      { agentId: 'prn_nugget', keyId: 'repos.read_all', tier: 'cannot' },
    ];
    expect(decide(nugget, both, 'repos.read').outcome).toBe('deny');
  });

  it('respects repo scopes', () => {
    const nugget = { id: 'prn_nugget', kind: 'agent' as const };
    const repoScoped: Grant[] = [
      { agentId: 'prn_nugget', keyId: 'pr.open', tier: 'can', scope: { repos: ['whombat/web'] } },
    ];
    expect(decide(nugget, repoScoped, 'pr.open', { repo: 'whombat/web' }).outcome).toBe('allow');
    expect(decide(nugget, repoScoped, 'pr.open', { repo: 'whombat/billing' }).outcome).toBe('deny');
    expect(decide(nugget, repoScoped, 'pr.open').reason).toBe('out_of_scope');
  });

  it('ignores other agents’ grants', () => {
    expect(decide({ id: 'prn_other', kind: 'agent' }, GRANTS, 'tests.run').reason).toBe('no_key');
  });

  it('lets the person use every key (CT-1507)', () => {
    for (const keyId of ['merge.main', 'burrow.manage', 'agents.manage'] as const)
      expect(decide({ id: mara.id, kind: 'person' }, [], keyId), keyId).toMatchObject({
        outcome: 'allow',
        reason: 'person',
      });
  });

  it('denies unknown keys', () => {
    expect(decide(agentActor(dusty), GRANTS, 'nope' as never)).toMatchObject({
      outcome: 'deny',
      reason: 'unknown_key',
    });
  });

  it('explains decisions and writes audit key notes', () => {
    const blocked = decide(agentActor(dusty), DEVELOPER, 'merge.main');
    expect(keyNoteFor(blocked, 'Dusty')).toBe('not one of Dusty’s keys');
    expect(keyNoteFor(decide(agentActor(dusty), GRANTS, 'deploy.staging'), 'Dusty')).toBe(
      'asks a person first',
    );
    expect(keyNoteFor(decide(agentActor(dusty), GRANTS, 'tests.run'), 'Dusty')).toBeNull();
    expect(describeDecision(blocked, 'Dusty')).toBe('Dusty can’t use “Merge into main”.');
    expect(describeDecision(decide(agentActor(dusty), DEVELOPER, 'branch.main.push'), 'Dusty')).toBe(
      '“Push to main” is not one of Dusty’s keys.',
    );
    const peopleOnly = describeDecision(decide(agentActor(dusty), GRANTS, 'agents.manage'), 'Dusty');
    expect(peopleOnly).toContain(KEY_CATALOG['agents.manage'].label);
    expect(peopleOnly).toMatch(/for people/);
    expect(describeDecision(decide(agentActor(dusty), [], 'tests.run'), 'Dusty')).toBe(
      '“Run tests” is not one of Dusty’s keys.',
    );
  });
});

describe('clamping', () => {
  it('clamps tiers to the agent cap', () => {
    expect(clampTier('branch.main.push', 'can')).toBe('can');
    expect(clampTier('agents.manage', 'can')).toBe('cannot');
    expect(clampTier('agents.manage', 'ask')).toBe('cannot');
    expect(clampTier('mail.send', 'can')).toBe('ask');
    expect(clampTier('merge.main', 'can')).toBe('can');
    expect(clampTier('deploy', 'can')).toBe('can');
    expect(clampTier('deploy', 'cannot')).toBe('cannot');
    expect(clampTier('tests.run', 'can')).toBe('can');
    const { grants, clamped } = clampGrants([
      { keyId: 'agents.manage', tier: 'can' as const },
      { keyId: 'mail.send', tier: 'can' as const },
      { keyId: 'deploy.staging', tier: 'can' as const },
      { keyId: 'merge.main', tier: 'can' as const },
    ]);
    expect(grants.map((g) => g.tier)).toEqual(['cannot', 'ask', 'can', 'can']);
    expect(clamped).toEqual([
      { keyId: 'agents.manage', from: 'can', to: 'cannot' },
      { keyId: 'mail.send', from: 'can', to: 'ask' },
    ]);
  });

  it('validates grant sets', () => {
    expect(validateGrants([{ keyId: 'tests.run', tier: 'can' }])).toEqual({ ok: true });
    expect(
      validateGrants([
        { keyId: 'deploy', tier: 'can' },
        { keyId: 'merge.main', tier: 'can' },
      ]),
    ).toEqual({ ok: true });
    const bad = validateGrants([
      { keyId: 'agents.manage', tier: 'can' },
      { keyId: 'tests.run', tier: 'can' },
      { keyId: 'tests.run', tier: 'ask' },
    ]);
    expect(bad.ok).toBe(false);
  });
});

describe('Settings → Agent → Keys', () => {
  it('shows the six risk rows, Off · Ask · On, at Ask (RA-01)', () => {
    expect(KEY_TIER_ROWS).toEqual([
      'deploy',
      'merge',
      'branch.main.push',
      'commands.destructive',
      'messages.external',
      'refunds.issue',
    ]);
    expect(KEY_RISK_ROWS.map((r) => r.row)).toEqual([...KEY_TIER_ROWS]);
    expect(KEY_RISK_ROWS.map((r) => r.label)).toEqual([
      'Deploy',
      'Merge into main',
      'Push to main',
      'Destructive commands on other machines',
      'Message people outside your Whombat',
      'Money',
    ]);
    for (const r of KEY_RISK_ROWS) {
      expect(r.keys, r.row).toBe(KEY_TIER_ROW_KEYS[r.row]);
      expect(r.keys[0], r.row).toBe(r.row);
      expect(keyTierRowLabel(r.row)).toBe(r.label);
    }
    expect(RISK_ROW_KEYS).toEqual([
      'deploy',
      'deploy.staging',
      'deploy.production',
      'merge',
      'merge.main',
      'branch.main.push',
      'commands.destructive',
      'messages.external',
      'refunds.issue',
      'billing.write',
    ]);
    expect(keyTierRowOf('billing.write')).toBe('refunds.issue');
    expect(keyTierRowOf('merge.main')).toBe('merge');
    expect(keyTierRowOf('pr.open')).toBeNull();
    expect(alwaysAllowLabel('Dusty', 'merge')).toBe('Always allow Dusty to merge into main');
    expect(alwaysAllowLabel('Dusty', 'deploy')).toBe('Always allow Dusty to deploy');
    expect(alwaysAllowLabel('Dusty', 'refunds.issue')).toBe('Always allow Dusty to handle money');
    expect(RISK_KEY_OPTIONS).toEqual(
      KEY_TIER_ROWS.map((keyId) => ({
        keyId,
        defaultOn: false,
        locked: null,
        lockedTier: null,
        defaultTier: 'ask',
      })),
    );
    expect(KEY_TIER_CHOICES.map((t) => KEY_TIER_LABELS[t])).toEqual([
      'Just watch',
      'Ask me first',
      'Go ahead',
    ]);
    expect(DEPLOY_NO_WORKFLOW_HINT).toBe('No deploy workflow is set up on this Whombat yet.');
  });

  it('sets the rows at the tiers a person chose, aligning each row’s keys', () => {
    const agent = { id: 'prn_new', kind: 'agent' as const };
    let inputs = agentDefaultGrants('prn_new').map(({ agentId: _a, ...g }) => g);
    inputs = withKeyRowTier(inputs, 'merge', 'can');
    inputs = withKeyRowTier(inputs, 'deploy', 'cannot');
    inputs = withKeyRowTier(inputs, 'refunds.issue', 'can');
    const grants = inputs.map((g) => ({ agentId: 'prn_new', ...g }));
    expect(
      grants
        .filter((g) => keyTierRowOf(g.keyId))
        .sort((a, b) => RISK_ROW_KEYS.indexOf(a.keyId) - RISK_ROW_KEYS.indexOf(b.keyId))
        .map((g) => [g.keyId, g.tier]),
    ).toEqual([
      ['deploy', 'cannot'],
      ['deploy.staging', 'cannot'],
      ['deploy.production', 'cannot'],
      ['merge', 'can'],
      ['merge.main', 'can'],
      ['branch.main.push', 'ask'],
      ['commands.destructive', 'ask'],
      ['messages.external', 'ask'],
      ['refunds.issue', 'can'],
      ['billing.write', 'can'],
    ]);
    expect(decide(agent, grants, 'merge.main').outcome).toBe('allow');
    expect(decide(agent, grants, 'deploy.production').outcome).toBe('deny');
    expect(decide(agent, grants, 'billing.write').outcome).toBe('allow');
    expect(keyRowTier(grants, 'refunds.issue')).toBe('can');
    expect(validateGrants(grants)).toEqual({ ok: true });
  });

  it('lists every other key under All keys: always-on and account switches, approving off, changing connections in three states', () => {
    expect(ALL_KEY_OPTIONS.map((o) => o.keyId)).toEqual([
      'canvas.write',
      'branch.feature.readwrite',
      'tests.run',
      'pr.open',
      'branch.shared.push',
      'workspace.scratch',
      'messages.search',
      'repos.read',
      'web.browse',
      'browser.use',
      'pr.comment',
      'pr.request_changes',
      'pr.approve',
      'ci.run',
      'jobs.scheduled.run',
      'pipelines.retry',
      'customers.read',
      'helpwidget.reply',
      'tickets.tag',
      'code.write',
      'settings.change',
      ...ACCOUNT_KEYS,
      'connections.read',
      'connections.write',
    ]);
    // A person's accounts (OA-10): every key of group `personal`, all on.
    expect(ACCOUNT_KEYS).toEqual(KEY_IDS.filter((id) => KEY_CATALOG[id].group === 'personal'));
    expect(ACCOUNT_KEYS).toContain('mail.send');
    for (const k of ACCOUNT_KEYS)
      expect([...AGENT_DEFAULT_KEYS.can, ...AGENT_DEFAULT_KEYS.ask], k).toContain(k);
    expect(ALL_KEY_OPTIONS.filter((o) => !o.defaultOn).map((o) => o.keyId)).toEqual([
      'pr.approve',
      'settings.change',
      'mail.delete',
      'files.delete',
    ]);
    // Trashing mail and files: Off · Ask · On, at Ask; the person may let it go ahead.
    for (const keyId of ACCOUNT_TIER_KEYS)
      expect(ALL_KEY_OPTIONS.find((o) => o.keyId === keyId)).toMatchObject({
        defaultTier: 'ask',
        locked: null,
      });
    expect(ALL_KEY_OPTIONS.find((o) => o.keyId === 'pr.approve')).toEqual({
      keyId: 'pr.approve',
      defaultOn: false,
      locked: null,
      lockedTier: null,
    });
    expect(ALL_KEY_OPTIONS.find((o) => o.keyId === 'connections.write')).toEqual({
      keyId: 'connections.write',
      defaultOn: true,
      locked: null,
      lockedTier: null,
      defaultTier: 'can',
    });
    // The pack tools' keys are retired (CT-824): still key ids, never offered, left out of views.
    expect(RETIRED_KEYS).toEqual(['packs.tool.read', 'packs.tool.write']);
    for (const keyId of RETIRED_KEYS) {
      expect(isRetiredKey(keyId)).toBe(true);
      expect(KeyId.safeParse(keyId).success).toBe(true);
      expect(KEY_CATALOG[keyId].label + KEY_CATALOG[keyId].description).not.toMatch(/pack/i);
      expect(ALL_KEY_OPTIONS.some((o) => o.keyId === keyId)).toBe(false);
      expect(isAlwaysOnKey(keyId)).toBe(false);
    }
    expect(
      keyRows([
        { keyId: 'packs.tool.read', tier: 'can' },
        { keyId: 'web.browse', tier: 'can' },
      ]).map((r) => r.keyId),
    ).toEqual(['web.browse']);
    expect(keysSummary([{ keyId: 'packs.tool.read', tier: 'can' }]).keys).toBe(0);
    // No row of the six, no people-only key, no other wording.
    for (const o of ALL_KEY_OPTIONS) {
      expect(keyTierRowOf(o.keyId), o.keyId).toBeNull();
      expect(KEY_CATALOG[o.keyId].sameAs, o.keyId).toBeUndefined();
      expect(agentMaxTier(o.keyId), o.keyId).not.toBe('never');
    }
  });

  it('lets a browser key imply reading the web, and lists it on the profile (S2)', () => {
    expect(KEY_CATALOG['browser.use'].implies).toEqual(['web.browse']);
    const grants = [{ agentId: 'prn_new', keyId: 'browser.use', tier: 'can' }] as const satisfies Grant[];
    expect(impliedKeyRows(grants)).toEqual([
      { keyId: 'web.browse', label: 'Browse the web', impliedBy: 'browser.use', note: 'with the browser' },
    ]);
    expect(impliedBy('web.browse', ['browser.use'])).toBe('browser.use');
    expect(impliedBy('web.browse', ['tests.run'])).toBeNull();
  });

  it('labels grants by their key', () => {
    expect(grantLabel({ keyId: 'pr.open' })).toBe('Open pull requests');
  });
});

describe('the always-on keys (RA-02, RA-03)', () => {
  it('are every key an agent may hold but the personal keys, the risk rows, approving and a pack’s write tools', () => {
    expect(ALWAYS_ON_KEYS).toEqual([
      'canvas.write',
      'branch.feature.readwrite',
      'tests.run',
      'pr.open',
      'branch.shared.push',
      'workspace.scratch',
      'messages.search',
      'repos.read',
      'web.browse',
      'browser.use',
      'pr.comment',
      'pr.request_changes',
      'ci.run',
      'jobs.scheduled.run',
      'pipelines.retry',
      'customers.read',
      'helpwidget.reply',
      'tickets.tag',
      'code.write',
      'connections.read',
    ]);
    for (const keyId of ALWAYS_ON_KEYS) {
      expect(agentMaxTier(keyId), keyId).toBe('can');
      expect(keyTierRowOf(keyId), keyId).toBeNull();
      expect(KEY_CATALOG[keyId].group, keyId).not.toBe('personal');
    }
    expect(ALWAYS_ON_EXCEPTIONS).toEqual(['pr.approve', 'connections.write', 'settings.change']);
    expect(isAlwaysOnKey('repos.read_all')).toBe(true);
    expect(isAlwaysOnKey('code.change')).toBe(true);
    expect(isAlwaysOnKey('pr.approve')).toBe(false);
    expect(isAlwaysOnKey('merge.main')).toBe(false);
    expect(isAlwaysOnKey('mail.read')).toBe(false);
  });
});

describe('grant changes', () => {
  it('describes changes as Keys events, verbatim with the mock', () => {
    expect(describeGrantChange('Dusty', { keyId: 'tests.run', kind: 'added', from: null, to: 'can' })).toBe(
      'Gave Dusty a new key: Run tests',
    );
    expect(
      describeGrantChange('Dusty', {
        keyId: 'deploy.production',
        kind: 'tier_changed',
        from: 'can',
        to: 'ask',
      }),
    ).toBe('Moved Dusty’s “Deploy to production” key to ask first');
    expect(describeGrantChange('Dusty', { keyId: 'pr.open', kind: 'removed', from: 'can', to: null })).toBe(
      'Took Dusty’s “Open pull requests” key away',
    );
    expect(
      describeGrantChange('Dusty', {
        keyId: 'branch.shared.push',
        kind: 'tier_changed',
        from: 'ask',
        to: 'can',
      }),
    ).toBe('Let Dusty use “Push to shared branches” without asking');
    expect(describeGrantChange('Dusty', { keyId: 'deploy', kind: 'added', from: null, to: 'ask' })).toBe(
      'Gave Dusty a new key that asks first: Deploy',
    );
  });

  it('diffs grant sets in catalog order', () => {
    const before = GRANTS;
    const after = [
      ...before.filter((g) => g.keyId !== 'pipelines.retry'),
      { agentId: dusty.id, keyId: 'pr.approve' as const, tier: 'can' as const },
    ];
    expect(diffGrants(before, after)).toEqual([
      { keyId: 'pr.approve', kind: 'added', from: null, to: 'can' },
      { keyId: 'pipelines.retry', kind: 'removed', from: 'can', to: null },
    ]);
    expect(diffGrants(before, before)).toEqual([]);
  });
});

describe('actions and branches', () => {
  it('maps actions to keys', () => {
    expect(
      actionKey({
        type: 'deploy',
        params: { environment: 'staging', service: 'billing-api', ref: 'feat/invoice-pdf', sha: null },
      }),
    ).toBe('deploy.staging');
    expect(
      actionKey({
        type: 'deploy',
        params: { environment: 'production', service: 'x', ref: 'main', sha: null },
      }),
    ).toBe('deploy.production');
    expect(actionKey({ type: 'merge_pr', params: { prNumber: 479, base: 'main' } })).toBe('merge.main');
    expect(
      actionKey({ type: 'refund', params: { accountId: '3310', amountCents: 2400, currency: 'EUR' } }),
    ).toBe('refunds.issue');
  });

  it('writes Blocked and Asks texts like the log', () => {
    expect(
      describeBlocked(describeAction({ type: 'merge_pr', params: { prNumber: 479, base: 'main' } })),
    ).toBe('Tried to merge PR #479 into main. Blocked.');
    expect(
      describeAsk({
        type: 'deploy',
        params: { environment: 'staging', service: 'billing-api', ref: 'feat/invoice-pdf', sha: null },
      }),
    ).toBe('Asked to deploy feat/invoice-pdf to staging');
    expect(
      describeAsk({ type: 'refund', params: { accountId: '3310', amountCents: 2400, currency: 'EUR' } }),
    ).toBe('Asked to refund €24,00 on account 3310');
  });

  it('picks the branch key', () => {
    // Writing the default branch needs Push to main even for an agent that may merge into it (CT-211); since 0.36 an
    // agent may hold it (CT-222).
    expect(branchWriteKey('main')).toBe('branch.main.push');
    expect(branchWriteKey('feat/invoice-pdf')).toBe('branch.feature.readwrite');
    expect(branchWriteKey('release/1.2')).toBe('branch.shared.push');
    expect(branchWriteKey('trunk', 'trunk')).toBe('branch.main.push');
    expect(decide(agentActor(dusty), held(['merge', 'can']), branchWriteKey('main')).reason).toBe('no_key');
    expect(decide(agentActor(dusty), held(['branch.main.push', 'ask']), branchWriteKey('main')).outcome).toBe(
      'ask',
    );
  });

  it('matches branch globs', () => {
    expect(globMatch('feat/*', 'feat/invoice-pdf')).toBe(true);
    expect(globMatch('feat/*', 'feat/a/b')).toBe(false);
    expect(globMatch('feat/**', 'feat/a/b')).toBe(true);
    expect(globMatch('release-?', 'release-1')).toBe(true);
    expect(globMatch('v1.2', 'v1x2')).toBe(false);
  });
});
