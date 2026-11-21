import type { TurnEvent } from '@whombat/agent-runtime';
import { describeActivity } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import {
  ActivityRecorder,
  boundEvidence,
  classifyTool,
  EVIDENCE_INPUT_MAX,
  EVIDENCE_OUTPUT_MAX,
  isWhombatMcpCall,
  shortenPaths,
} from './activity';
import { REPEAT_REFUSED_LINE } from './commands/repeats';

const CWD = '/home/runner/ws/dusty/billing';
const HOME = '/home/runner';
const recorder = (extra: Partial<ConstructorParameters<typeof ActivityRecorder>[0]> = {}) =>
  new ActivityRecorder({
    attempt: 2,
    cwd: CWD,
    home: HOME,
    now: () => new Date('2026-09-26T10:00:00Z'),
    ...extra,
  });

const copy = (r: ReturnType<ActivityRecorder['rows']>[number]) => describeActivity(r).title;

describe('shortenPaths', () => {
  it('makes workdir paths relative and the home directory ~', () => {
    expect(shortenPaths(`${CWD}/src/a.ts and ${CWD} and ${HOME}/.npmrc`, { cwd: CWD, home: HOME })).toBe(
      'src/a.ts and . and ~/.npmrc',
    );
    // A sibling that only shares a prefix is not inside the workdir.
    expect(shortenPaths(`${CWD}-old/x`, { cwd: CWD, home: null })).toBe(`${CWD}-old/x`);
  });
});

describe('boundEvidence', () => {
  it('redacts a complete private key before taking the output tail', () => {
    const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'private'.repeat(1000)}\n-----END OPENSSH PRIVATE KEY-----`;
    expect(boundEvidence('command', `before\n${key}\nafter`, { cwd: CWD })).toEqual({
      input: 'command',
      output: 'before\n[redacted]\nafter',
      truncated: false,
    });
  });

  it('keeps the head of the input and the tail of the output, and says it cut them', () => {
    const e = boundEvidence('i'.repeat(3000), `${'o'.repeat(9000)}END`, { cwd: CWD });
    expect(e?.input?.length).toBe(EVIDENCE_INPUT_MAX);
    expect(e?.output?.length).toBe(EVIDENCE_OUTPUT_MAX);
    expect(e?.output?.endsWith('END')).toBe(true);
    expect(e?.truncated).toBe(true);
    expect(boundEvidence(null, '  ', { cwd: CWD })).toBeNull();
    expect(boundEvidence('ls', null, { cwd: CWD })).toEqual({ input: 'ls', output: null, truncated: false });
  });
});

describe('classifyTool', () => {
  it.each([
    [
      { name: 'Read', category: 'read' },
      { kind: 'read', tool: 'Read', evidence: true },
    ],
    [{ name: 'Bash' }, { kind: 'command', tool: 'Bash', evidence: true }],
    [
      { name: 'shell', category: 'read' },
      { kind: 'read', tool: 'shell', evidence: true },
    ],
    [
      { name: 'post_message', category: 'mcp' },
      { kind: 'whombat', tool: 'whombat.post_message', evidence: false },
    ],
    [
      { name: 'mail_search', category: 'mcp' },
      { kind: 'tool', tool: 'mail.search', evidence: false },
    ],
    // Pack tools are gone (skill-store.md SST-09): a name shaped like one is just another MCP tool.
    [
      { name: 'pk_stripe__refund', category: 'mcp' },
      { kind: 'tool', tool: 'pk_stripe__refund', evidence: false },
    ],
    [
      { name: 'mcp__linear__create', category: 'mcp' },
      { kind: 'tool', tool: 'linear.create', evidence: false },
    ],
    [
      { name: 'Task', category: 'delegate' },
      { kind: 'delegate', tool: 'Task', evidence: false },
    ],
    [
      { name: 'WebFetch', category: 'web' },
      { kind: 'web', tool: 'WebFetch', evidence: true },
    ],
  ])('%o', (call, expected) => {
    expect(classifyTool(call)).toEqual(expected);
  });

  it.each([
    // A skill the agent read (hermes-engine.md HE-41).
    [
      { name: 'skill_view', category: 'other' },
      { kind: 'tool', tool: 'skill_view', evidence: false },
    ],
    // The browser's tools, whatever the provider called them (browser.md BT-03).
    [
      { name: 'browser_open', category: 'mcp' },
      { kind: 'web', tool: 'whombat.browser_open', evidence: true },
    ],
    [
      { name: 'mcp__whombat__browser_click', category: 'mcp' },
      { kind: 'web', tool: 'whombat.browser_click', evidence: true },
    ],
    [
      { name: 'browser_type', category: 'mcp' },
      { kind: 'web', tool: 'whombat.browser_type', evidence: false },
    ],
    [
      { name: 'browser_select', category: 'mcp' },
      { kind: 'web', tool: 'whombat.browser_select', evidence: false },
    ],
    // Filling a login is a Vault use: one neutral row (VT-53, HE-S141).
    [
      { name: 'browser_vault', category: 'mcp' },
      { kind: 'whombat', tool: 'whombat.vault_request', evidence: false },
    ],
    // Saving a login and adding a server hold a secret in their input: neutral rows too (Whombat vault-self-serve.md VS-14).
    [
      { name: 'mcp__whombat__vault_save', category: 'mcp' },
      { kind: 'whombat', tool: 'whombat.vault_request', evidence: false },
    ],
    [
      { name: 'vault_add_server', category: 'mcp' },
      { kind: 'whombat', tool: 'whombat.vault_request', evidence: false },
    ],
  ])('capabilities: %o', (call, expected) => {
    expect(classifyTool(call)).toEqual(expected);
  });

  it('a provider’s own tool named like one of Whombat’s is the provider’s (Hermes’s memory and browser)', () => {
    expect(classifyTool({ name: 'memory', category: 'other' })).toEqual({
      kind: 'tool',
      tool: 'memory',
      evidence: false,
    });
    expect(classifyTool({ name: 'browser_click', category: 'web' })).toEqual({
      kind: 'web',
      tool: 'browser_click',
      evidence: true,
    });
  });

  it('gives the provider’s own bookkeeping no row', () => {
    expect(classifyTool({ name: 'TodoWrite', category: 'other' })).toBeNull();
    // The task list of Claude Code 2.1 (RA-15); a sub-agent is a row of its own.
    for (const name of ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate'])
      expect(classifyTool({ name, category: 'other' }), name).toBeNull();
    expect(classifyTool({ name: 'Agent', category: 'delegate' })).toEqual({
      kind: 'delegate',
      tool: 'Agent',
      evidence: false,
    });
  });
});

describe('isWhombatMcpCall', () => {
  it.each([
    // Whombat's, the Vault's, the browser's and connector tools, as the providers name them.
    [{ name: 'post_message', category: 'mcp' }, true],
    [{ name: 'post_message' }, true],
    [{ name: 'mcp__whombat__post_message', category: 'other' }, true],
    [{ name: 'mcp__editor_whombat_1a2b3c4d__request_approval', category: 'other' }, true],
    [{ name: 'vault_save', category: 'mcp' }, true],
    [{ name: 'browser_preview', category: 'mcp' }, true],
    [{ name: 'mail_search', category: 'mcp' }, true],
    // Everything else is the runner's to report.
    [{ name: 'memory', category: 'other' }, false],
    [{ name: 'browser_click', category: 'web' }, false],
    [{ name: 'terminal', category: 'command' }, false],
    [{ name: 'mcp__linear__create', category: 'mcp' }, false],
    [{ name: 'Bash' }, false],
  ])('%o → %s', (call, expected) => {
    expect(isWhombatMcpCall(call)).toBe(expected);
  });
});

describe('ActivityRecorder', () => {
  it('one row per call, updated through its lifecycle, keyed by attempt and tool id', () => {
    const r = recorder();
    r.observe({
      type: 'tool_call',
      name: 'Edit',
      id: 'toolu_1',
      category: 'edit',
      input: { file_path: `${CWD}/src/invoice.ts` },
    });
    expect(r.rows()).toMatchObject([
      { key: '2:toolu_1', seq: 1, kind: 'edit', status: 'running', object: 'src/invoice.ts' },
    ]);
    expect(copy(r.rows()[0] as never)).toBe('Editing invoice.ts');
    r.observe({
      type: 'tool_result',
      name: 'Edit',
      id: 'toolu_1',
      ok: true,
      outcome: { output: 'file contents here' },
    });
    const [row] = r.rows();
    expect(row).toMatchObject({ key: '2:toolu_1', seq: 2, status: 'done' });
    // An edit's output (file contents) is never evidence; its input (the path) is.
    expect(row?.evidence).toEqual({ input: 'src/invoice.ts', output: null, truncated: false });
    expect(copy(row as never)).toBe('Edited invoice.ts');
  });

  it('commands: exit code and the redacted tail of their output, never text-inferred success', () => {
    const r = recorder();
    r.observe({
      type: 'tool_call',
      name: 'shell',
      id: 'c1',
      category: 'command',
      input: { command: `GH_TOKEN=abc ${CWD}/node_modules/.bin/vitest` },
    });
    r.observe({
      type: 'tool_result',
      name: 'shell',
      id: 'c1',
      ok: false,
      outcome: { exitCode: 1, error: 'error', output: 'using ghp_abcdefghijklmnopqrstuvwxyz0123\n1 failed' },
    });
    const [row] = r.rows();
    expect(row).toMatchObject({
      status: 'failed',
      exitCode: 1,
      failure: 'error',
      object: 'GH_TOKEN=[redacted] node_modules/.bin/vitest',
    });
    expect(row?.evidence).toEqual({
      input: 'GH_TOKEN=[redacted] node_modules/.bin/vitest',
      output: 'using [redacted]\n1 failed',
      truncated: false,
    });
    expect(describeActivity(row as never)).toMatchObject({ title: 'Command failed', detail: 'exit 1' });
  });

  it('a command Codex couldn’t start keeps Codex’s words as its evidence: the server reads them (RN-R4)', () => {
    const r = recorder();
    r.observe({
      type: 'tool_call',
      name: 'shell',
      id: 'c2',
      category: 'command',
      input: { command: 'npm run test:e2e', cwd: `${CWD}/copy/web` },
    });
    const codex = 'Failed to create unified exec process: No such file or directory (os error 2)';
    r.observe({
      type: 'tool_result',
      name: 'shell',
      id: 'c2',
      ok: false,
      outcome: { error: 'error', output: codex },
    });
    const [row] = r.rows();
    expect(row).toMatchObject({ kind: 'command', status: 'failed', failure: 'error', exitCode: null });
    expect(row?.evidence?.output).toBe(codex);
  });

  it('reads and searches keep no output (file contents)', () => {
    const r = recorder();
    r.observe({
      type: 'tool_call',
      name: 'Grep',
      id: 'g',
      category: 'search',
      input: { pattern: 'invoice', path: `${CWD}/src` },
    });
    r.observe({
      type: 'tool_result',
      name: 'Grep',
      id: 'g',
      ok: true,
      outcome: { output: 'src/a.ts: const secret = 1' },
    });
    expect(r.rows()[0]).toMatchObject({
      object: 'invoice',
      evidence: { input: 'invoice in src', output: null },
    });
  });

  it('Whombat’s own tools get no row here, whatever they answered: the server records them from the calls it ran', () => {
    const r = recorder();
    // ACP (Hermes): the bare name, an MCP call, the answer as text only.
    r.observe({
      type: 'tool_call',
      name: 'perform_action',
      id: 'w1',
      category: 'mcp',
      input: { secret: 'x' },
    });
    r.observe({
      type: 'tool_result',
      name: 'perform_action',
      id: 'w1',
      ok: true,
      outcome: { output: '{"status":"pending_approval","approvalId":"apr_12"}' },
    });
    // Hermes's name for the server, and a Vault and a browser tool.
    r.observe({ type: 'tool_call', name: 'mcp__editor_whombat_0a1b2c3d__post_message', id: 'w2', input: {} });
    r.observe({ type: 'tool_call', name: 'vault_save', id: 'w3', category: 'mcp', input: {} });
    r.observe({
      type: 'tool_call',
      name: 'browser_preview',
      id: 'w4',
      category: 'mcp',
      input: { dir: 'dist' },
    });
    for (const id of ['w2', 'w3', 'w4']) r.observe({ type: 'tool_result', name: 'x', id, ok: false });
    expect(r.rows()).toEqual([]);
    expect(r.hasPending).toBe(false);
    // Hermes's own tools are reported, by Hermes's category, else by name.
    r.observe({
      type: 'tool_call',
      name: 'terminal',
      id: 'h1',
      category: 'command',
      input: { command: 'ls' },
    });
    r.observe({ type: 'tool_call', name: 'memory', id: 'h2', category: 'other', input: { content: 'x' } });
    r.observe({ type: 'tool_result', name: 'memory', id: 'h2', ok: true, outcome: { output: 'saved' } });
    expect(r.rows().map((x) => [x.key, x.kind, x.tool, x.status, x.evidence])).toEqual([
      ['2:h1', 'command', 'terminal', 'running', { input: 'ls', output: null, truncated: false }],
      ['2:h2', 'tool', 'memory', 'done', null],
    ]);
  });

  it('a skill tool reports the skill as the object, without evidence (HE-41)', () => {
    const r = recorder();
    r.observe({
      type: 'tool_call',
      name: 'skill_view',
      id: 's1',
      category: 'other',
      input: { name: 'dcf-model', file_path: 'references/q3.md' },
    });
    r.observe({ type: 'tool_result', name: 'skill_view', id: 's1', ok: true, outcome: { output: 'Loaded' } });
    r.observe({
      type: 'tool_call',
      name: 'skill_manage',
      id: 's2',
      category: 'other',
      input: { operations: [{ action: 'patch', name: 'xlsx', old_string: 'a', new_string: 'b' }] },
    });
    const [viewed, changed] = r.rows();
    expect(viewed).toMatchObject({
      kind: 'tool',
      tool: 'skill_view',
      status: 'done',
      object: 'dcf-model',
      evidence: null,
    });
    expect(changed).toMatchObject({ tool: 'skill_manage', object: 'xlsx' });
  });

  it('a provider’s own browser tool keeps the browser’s rules: the page, never what was typed (BT-03)', () => {
    const r = recorder();
    r.observe({
      type: 'tool_call',
      name: 'browser_type',
      id: 'b1',
      category: 'web',
      input: { ref: '@e4', text: 'hunter2', submit: true },
    });
    r.observe({
      type: 'tool_result',
      name: 'browser_type',
      id: 'b1',
      ok: true,
      outcome: { output: 'typed hunter2' },
    });
    expect(r.rows()[0]).toMatchObject({
      kind: 'web',
      tool: 'browser_type',
      status: 'done',
      object: null,
      evidence: null,
    });
    expect(JSON.stringify(r.rows())).not.toContain('hunter2');
  });

  it('a denied permission is the action’s row, whichever comes first, and a later result doesn’t undo it', () => {
    const r = recorder();
    // Claude: the call, then the denial, then the error result.
    r.observe({
      type: 'tool_call',
      name: 'Read',
      id: 't1',
      category: 'read',
      input: { file_path: '/etc/shadow' },
    });
    r.observe({
      type: 'permission',
      tool: 'Read',
      allowed: false,
      reason: 'Only inside your workspace.',
      id: 't1',
    });
    r.observe({ type: 'tool_result', name: 'Read', id: 't1', ok: false, outcome: { error: 'error' } });
    // ACP: the denial before the call is announced again.
    r.observe({ type: 'permission', tool: 'Fetch', allowed: false, id: 't2' });
    r.observe({
      type: 'tool_call',
      name: 'Fetch',
      id: 't2',
      category: 'web',
      input: { url: 'https://x.test' },
    });
    // Allowed permissions add nothing.
    expect(r.observe({ type: 'permission', tool: 'Bash', allowed: true, id: 't3' })).toBe(false);
    const rows = r.rows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ key: '2:t1', kind: 'permission', status: 'failed', failure: 'denied' });
    expect(rows[0]?.evidence?.input).toBe('/etc/shadow\nOnly inside your workspace.');
    expect(copy(rows[0] as never)).toBe('Not allowed: Read');
    expect(rows[1]).toMatchObject({ key: '2:t2', kind: 'permission', status: 'failed' });
  });

  it('pairs results without ids to the oldest open call of the same name (sequence keys)', () => {
    const r = recorder();
    const call = (name: string, category?: 'mcp'): TurnEvent => ({
      type: 'tool_call',
      name,
      input: {},
      ...(category ? { category } : {}),
    });
    r.observe(call('Bash'));
    r.observe(call('Grep'));
    // A Whombat call without an id: its result takes its own place, never another call's row.
    r.observe(call('post_message', 'mcp'));
    r.observe(call('Bash'));
    r.observe({ type: 'tool_result', name: 'post_message', ok: false });
    r.observe({ type: 'tool_result', name: 'Bash', ok: true });
    r.observe({ type: 'tool_result', name: 'Grep', ok: false });
    expect(r.rows().map((x) => [x.key, x.status])).toEqual([
      ['2:s3', 'running'],
      ['2:s1', 'done'],
      ['2:s2', 'failed'],
    ]);
  });

  it('pending → ack: a report stays pending until the server took it, and a newer change stays pending', () => {
    const r = recorder();
    r.observe({ type: 'tool_call', name: 'Bash', id: 'a', category: 'command', input: { command: 'ls' } });
    r.observe({ type: 'tool_call', name: 'Bash', id: 'b', category: 'command', input: { command: 'pwd' } });
    const first = r.pending();
    expect(first.map((x) => [x.key, x.seq])).toEqual([
      ['2:a', 1],
      ['2:b', 2],
    ]);
    // A failed beat: nothing acknowledged, the same reports go again.
    expect(r.pending()).toEqual(first);
    // `a` finished while the beat was in flight: its newer report is still pending after the ack.
    r.observe({ type: 'tool_result', name: 'Bash', id: 'a', ok: true });
    r.ack(first);
    expect(r.pending().map((x) => [x.key, x.seq, x.status])).toEqual([['2:a', 3, 'done']]);
    r.ack(r.pending());
    expect(r.hasPending).toBe(false);
    // Nothing changes on a duplicate result.
    expect(r.observe({ type: 'tool_result', name: 'Bash', id: 'a', ok: false })).toBe(false);
  });

  it('a command the exec service didn’t run is a failed, blocked command, only after it said so (HC-05)', () => {
    const r = recorder();
    const call = (id: string, name: string, command: string, category: 'command' | 'read' = 'command') =>
      r.observe({ type: 'tool_call', name, id, category, input: { command } });
    // An agent printing the line itself: no refusal was made, so an ordinary failed command.
    call('c0', 'Bash', `echo '${REPEAT_REFUSED_LINE}'; exit 1`);
    r.observe({
      type: 'tool_result',
      name: 'Bash',
      id: 'c0',
      ok: false,
      outcome: { error: 'error', output: `Exit code 1\n${REPEAT_REFUSED_LINE}` },
    });
    expect(r.rows()[0]).toMatchObject({ status: 'failed', failure: 'error' });
    // Claude Code: two Bash calls, the second not run.
    r.notRun();
    call('c1', 'Bash', 'pnpm test');
    call('c2', 'Bash', 'pnpm build:widget');
    r.observe({
      type: 'tool_result',
      name: 'Bash',
      id: 'c1',
      ok: false,
      outcome: { error: 'error', output: 'Exit code 1\n1 failed' },
    });
    r.observe({
      type: 'tool_result',
      name: 'Bash',
      id: 'c2',
      ok: false,
      outcome: { error: 'error', output: `Exit code 1\n${REPEAT_REFUSED_LINE}` },
    });
    // Codex: a read it never ran is a command row naming the command.
    r.notRun();
    call('c3', 'shell', 'cat missing.txt', 'read');
    r.observe({
      type: 'tool_result',
      name: 'shell',
      id: 'c3',
      ok: false,
      outcome: { exitCode: 1, error: 'error', output: `${REPEAT_REFUSED_LINE}\n` },
    });
    const [, test, build, read] = r.rows();
    expect(test).toMatchObject({ status: 'failed', failure: 'error' });
    expect(build).toMatchObject({
      kind: 'command',
      status: 'failed',
      failure: 'blocked',
      keyNeeded: null,
      object: 'pnpm build:widget',
      evidence: { input: 'pnpm build:widget', output: `Exit code 1\n${REPEAT_REFUSED_LINE}` },
    });
    expect(read).toMatchObject({
      kind: 'command',
      status: 'failed',
      failure: 'blocked',
      exitCode: 1,
      object: 'cat missing.txt',
      evidence: { input: 'cat missing.txt', output: REPEAT_REFUSED_LINE },
    });
    // One refusal, one row: the next line printed by a command is its own output again.
    call('c4', 'Bash', `echo '${REPEAT_REFUSED_LINE}'; exit 1`);
    r.observe({
      type: 'tool_result',
      name: 'Bash',
      id: 'c4',
      ok: false,
      outcome: { error: 'error', output: `Exit code 1\n${REPEAT_REFUSED_LINE}` },
    });
    expect(r.rows()[4]).toMatchObject({ failure: 'error' });
  });

  it('a Feedback assessment reports kind and state only', () => {
    const r = recorder({ bare: true });
    r.observe({
      type: 'tool_call',
      name: 'Bash',
      id: 'x',
      category: 'command',
      input: { command: 'cat .env' },
    });
    r.observe({
      type: 'tool_result',
      name: 'Bash',
      id: 'x',
      ok: false,
      outcome: { exitCode: 2, output: 'SECRET' },
    });
    expect(r.rows()[0]).toMatchObject({
      kind: 'command',
      status: 'failed',
      object: null,
      evidence: null,
      exitCode: null,
    });
  });

  it('subagent calls are rows of their own; thinking and text never are', () => {
    const r = recorder();
    expect(r.observe({ type: 'thinking' })).toBe(false);
    expect(r.observe({ type: 'text_delta', text: 'I think the key is sk-abcdefghijklmnopqrs' })).toBe(false);
    r.observe({
      type: 'tool_call',
      name: 'Task',
      id: 'p',
      category: 'delegate',
      input: { prompt: 'secret plan' },
    });
    r.observe({
      type: 'tool_call',
      name: 'Grep',
      id: 'c',
      parentId: 'p',
      category: 'search',
      input: { pattern: 'x' },
    });
    expect(r.rows().map((x) => [x.kind, x.object, x.evidence])).toEqual([
      ['delegate', null, null],
      ['search', 'x', { input: 'x', output: null, truncated: false }],
    ]);
  });

  it('bounds long provider ids in the key', () => {
    const r = recorder();
    r.observe({ type: 'tool_call', name: 'Bash', id: 'x'.repeat(400), category: 'command', input: {} });
    r.observe({ type: 'tool_call', name: 'Bash', id: `${'x'.repeat(399)}y`, category: 'command', input: {} });
    const keys = r.rows().map((x) => x.key);
    expect(keys.every((k) => k.length <= 160)).toBe(true);
    expect(new Set(keys).size).toBe(2);
  });
});

describe('opening a skill with the file tools (all-skills.md SK-05, SK-06)', () => {
  it('a Claude Read of a skill’s SKILL.md is a done read row naming its path, which the server counts as a use', () => {
    const r = recorder();
    const path =
      '/tmp/whombat-runner-1000-skills/skills-0123456789abcdef01234567/whombat/skills/proxmox/SKILL.md';
    r.observe({ type: 'tool_call', name: 'Read', id: 's1', category: 'read', input: { file_path: path } });
    r.observe({ type: 'tool_result', name: 'Read', id: 's1', ok: true, outcome: {} });
    const [row] = r.rows();
    expect(row).toMatchObject({ kind: 'read', tool: 'Read', status: 'done' });
    // The server reads `whombat/skills/<name>/SKILL.md` at the end of the object (SST-07).
    expect(row?.object?.endsWith('whombat/skills/proxmox/SKILL.md')).toBe(true);
  });
});
