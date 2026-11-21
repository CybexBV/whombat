import { DispatchContext } from '@whombat/core/contracts';
import { KEY_CATALOG, type KeyId } from '@whombat/core/keys';
import { describe, expect, it } from 'vitest';
import { networkFor, toolKeyAccess } from '../persona/access';
import { base } from '../testing/contexts';
import {
  HERMES_POLICY_FILE,
  type HermesPolicy,
  hermesPolicy,
  hermesPolicyJson,
  keyOffText,
  WEB_EXTRACT_REFUSED,
} from './policy';

const key = (id: KeyId) => ({ id, label: KEY_CATALOG[id].label });

function turn(
  keys: { can?: KeyId[]; ask?: KeyId[]; cannot?: KeyId[] },
  over: { commands?: boolean; feedback?: boolean } = {},
) {
  const b = base();
  return DispatchContext.parse({
    ...b,
    dispatch: { ...b.dispatch, ...(over.feedback ? { trigger: 'feedback' } : {}) },
    agent: {
      ...b.agent,
      keys: {
        can: (keys.can ?? []).map(key),
        ask: (keys.ask ?? []).map(key),
        cannot: (keys.cannot ?? []).map(key),
      },
    },
    ...(over.commands === false
      ? {}
      : { outside: false, commands: { productionServers: [], homeNetworks: [], lan: true } }),
  });
}

/** What the plugin decides for one call (its first-match rule, without the path rules' file system). */
function decide(policy: HermesPolicy, tool: string, path?: string) {
  const glob = (p: string) => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  for (const rule of policy.rules) {
    if (!rule.tools.some((p) => glob(p).test(tool))) continue;
    if (rule.paths) {
      const inside = (root: string) => path && (path === root || path.startsWith(`${root}/`));
      if (!rule.paths.some(inside)) continue;
    }
    return rule;
  }
  return { action: policy.default };
}

describe('a look’s turn (Whombat look-research.md)', () => {
  it('hands nothing to a helper, which would run after the turn without Whombat’s tools', () => {
    const b = turn({});
    for (const trigger of ['look', 'look_fix'] as const) {
      const look = DispatchContext.parse({ ...b, dispatch: { ...b.dispatch, trigger } });
      for (const tool of ['delegate_task', 'Agent', 'Task'])
        expect(decide(hermesPolicy(look), tool)).toMatchObject({ action: 'block' });
      expect(decide(hermesPolicy(look), 'memory')).toMatchObject({ action: 'allow' });
    }
    expect(decide(hermesPolicy(b), 'delegate_task')).toMatchObject({ action: 'allow' });
  });
});

describe('the turn’s tool policy from the agent’s keys (HE-44)', () => {
  it('recovers an answer without letting the session redo work or change anything', () => {
    const policy = hermesPolicy(turn({ can: ['web.browse', 'browser.use'] }), { replyOnly: true });
    for (const tool of [
      'terminal',
      'execute_code',
      'memory',
      'web_search',
      'browser_navigate',
      'mcp__editor_whombat_12345678__connection_call',
      'mcp__vault_test__write',
    ])
      expect(decide(policy, tool).action).toBe('block');
    expect(policy.default).toBe('block');
  });
  it('Allowed runs, Ask asks a person with the key, Off blocks naming the key', () => {
    const policy = hermesPolicy(turn({ can: ['web.browse'], ask: ['browser.use'] }));
    for (const tool of ['web_search', 'WebFetch', 'WebSearch'])
      expect(decide(policy, tool)).toMatchObject({ action: 'allow' });
    // Search only (web-search.md): pages are read with the browser or curl.
    expect(decide(policy, 'web_extract')).toMatchObject({ action: 'block', message: WEB_EXTRACT_REFUSED });
    for (const tool of ['browser_navigate', 'browser_click', 'browser_vault'])
      expect(decide(policy, tool)).toMatchObject({ action: 'approve', key: 'browser.use' });
    const off = hermesPolicy(turn({ cannot: ['web.browse', 'browser.use'] }));
    expect(decide(off, 'WebFetch')).toMatchObject({ action: 'block', message: keyOffText('web.browse') });
    expect(decide(off, 'web_extract')).toMatchObject({ action: 'block', message: keyOffText('web.browse') });
    expect(keyOffText('web.browse')).toContain('Browse the web');
    expect(decide(off, 'browser_snapshot')).toMatchObject({ action: 'block' });
    // No key at all is Off.
    expect(decide(hermesPolicy(turn({})), 'web_search')).toMatchObject({ action: 'block' });
  });

  it('a browser key at Allowed covers the web as well, as the keys engine says', () => {
    const policy = hermesPolicy(turn({ can: ['browser.use'] }));
    expect(decide(policy, 'web_search')).toMatchObject({ action: 'allow' });
    expect(decide(policy, 'browser_navigate')).toMatchObject({ action: 'allow' });
    // Keeping a website signed in is the browser's too: with its key in a person's pod, not without the pod's browser.
    expect(decide(policy, 'browser_keep_site')).toMatchObject({ action: 'allow' });
    expect(
      decide(
        hermesPolicy(turn({ can: ['browser.use'] }), { pod: { browser: true, vault: [] } }),
        'browser_keep_site',
      ),
    ).toMatchObject({ action: 'allow' });
    expect(
      decide(
        hermesPolicy(turn({ can: ['browser.use'] }), { pod: { browser: false, vault: [] } }),
        'browser_keep_site',
      ),
    ).toMatchObject({ action: 'block' });
  });

  it('never Hermes’s browser_exec, whose Python runs beside the sign-ins, whatever the key (HE-S300)', () => {
    for (const ctx of [turn({ can: ['browser.use'] }), turn({ ask: ['browser.use'] })]) {
      expect(decide(hermesPolicy(ctx), 'browser_exec')).toMatchObject({ action: 'block' });
      expect(decide(hermesPolicy(ctx, { pod: { browser: true, vault: [] } }), 'browser_exec')).toMatchObject({
        action: 'block',
      });
    }
  });

  it('Ask only in a person’s turn with commands, never while assessing a report', () => {
    const elsewhere = turn({ ask: ['web.browse'] }, { commands: false });
    expect(toolKeyAccess(elsewhere, 'web.browse')).toBe('deny');
    expect(networkFor(elsewhere)).toBe(false);
    expect(decide(hermesPolicy(elsewhere), 'web_search')).toMatchObject({ action: 'block' });
    const person = turn({ ask: ['web.browse'] });
    expect(toolKeyAccess(person, 'web.browse')).toBe('ask');
    expect(networkFor(person)).toBe(true);
    const report = turn({ can: ['web.browse', 'browser.use'] }, { feedback: true });
    expect(decide(hermesPolicy(report), 'WebSearch')).toMatchObject({ action: 'block' });
    expect(decide(hermesPolicy(report), 'browser_navigate')).toMatchObject({ action: 'block' });
    expect(networkFor(report)).toBe(false);
  });

  it('Whombat’s tools, commands, files and the person’s own things run; anything else is blocked', () => {
    const policy = hermesPolicy(turn({ cannot: ['web.browse'] }));
    for (const tool of [
      'mcp__whombat__post_message',
      'mcp__editor_whombat_3f2a9c__vault_save',
      'mcp__vault_abcdefgh__HassTurnOn',
      'terminal',
      'execute_code',
      'Bash',
      'Read',
      'Edit',
      'memory',
      'session_search',
      'skill_manage',
      'delegate_task',
      'Agent',
    ])
      expect(decide(policy, tool), tool).toMatchObject({ action: 'allow' });
    for (const tool of ['cronjob_manage', 'kanban_create', 'send_message', 'computer_use', 'ha_call_service'])
      expect(decide(policy, tool), tool).toMatchObject({ action: 'block' });
  });

  it('keeps Claude Code’s file tools out of the profile and the CLI’s sign-in home, but lets learned skills be read', () => {
    const policy = hermesPolicy(turn({}), { privateDirs: ['$CLAUDE_CONFIG_DIR'] });
    expect(decide(policy, 'Read', '$HERMES_HOME/memories/MEMORY.md')).toMatchObject({ action: 'block' });
    expect(decide(policy, 'Write', `$HERMES_HOME/${HERMES_POLICY_FILE}`)).toMatchObject({ action: 'block' });
    expect(decide(policy, 'Read', '$CLAUDE_CONFIG_DIR/.credentials.json')).toMatchObject({ action: 'block' });
    expect(decide(policy, 'Read', '$HERMES_HOME/skills/deploy/SKILL.md')).toMatchObject({ action: 'allow' });
    expect(decide(policy, 'Edit', '$HERMES_HOME/skills/deploy/SKILL.md')).toMatchObject({ action: 'block' });
    expect(decide(policy, 'Read', '/work/app/README.md')).toMatchObject({ action: 'allow' });
  });

  it('keeps Hermes’s own file tools out of its home but its skills, and out of Whombat’s bookkeeping there (OP-07)', () => {
    const policy = hermesPolicy(turn({}), { privateDirs: ['$CLAUDE_CONFIG_DIR'] });
    for (const tool of ['read_file', 'write_file', 'patch', 'search_files']) {
      expect(decide(policy, tool, '$HERMES_HOME/auth.json'), tool).toMatchObject({ action: 'block' });
      expect(decide(policy, tool, '$HERMES_HOME/memories/MEMORY.md'), tool).toMatchObject({
        action: 'block',
      });
      expect(decide(policy, tool, '$CLAUDE_CONFIG_DIR/.credentials.json'), tool).toMatchObject({
        action: 'block',
      });
      expect(decide(policy, tool, '$HERMES_HOME/skills/.whombat/skills.json'), tool).toMatchObject({
        action: 'block',
      });
      expect(decide(policy, tool, '$HERMES_HOME/skills/ops/deploy/SKILL.md'), tool).toMatchObject({
        action: 'allow',
      });
      expect(decide(policy, tool, '/work/app/README.md'), tool).toMatchObject({ action: 'allow' });
    }
  });

  it('an assessment that may look at the reported website gets the browser’s looking tools only (FB-28)', () => {
    const report = turn({ can: ['browser.use'] }, { feedback: true });
    const looking = hermesPolicy(report, { assessorBrowser: { logins: false } });
    for (const tool of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_vault'])
      expect(decide(looking, tool), tool).toMatchObject({ action: 'allow' });
    for (const tool of [
      'browser_press',
      'browser_cdp',
      'browser_console',
      'browser_dialog',
      'browser_type',
      'browser_keep_site',
    ])
      expect(decide(looking, tool), tool).toMatchObject({ action: 'block' });
    // With a login of that website it types its username itself.
    const withLogin = hermesPolicy(report, { assessorBrowser: { logins: true } });
    expect(decide(withLogin, 'browser_type')).toMatchObject({ action: 'allow' });
    expect(decide(withLogin, 'browser_press')).toMatchObject({ action: 'block' });
    // Without a look, nothing of the browser; never the web.
    expect(decide(hermesPolicy(report), 'browser_navigate')).toMatchObject({ action: 'block' });
    expect(decide(looking, 'web_search')).toMatchObject({ action: 'block' });
  });

  it('is the plugin’s JSON', () => {
    const json = JSON.parse(hermesPolicyJson(hermesPolicy(turn({ ask: ['web.browse'] }))));
    expect(json.default).toBe('block');
    expect(json.rules.every((r: { tools: unknown[] }) => r.tools.length > 0)).toBe(true);
    expect(json.rules.find((r: { key?: string }) => r.key === 'web.browse')).toMatchObject({
      action: 'approve',
    });
  });
});
