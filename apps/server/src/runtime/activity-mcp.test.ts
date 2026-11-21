import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import {
  type McpActivityCall,
  mcpActivityCall,
  mcpActivityOutcome,
  REASON_MAX,
  redactSecrets,
} from './activity-mcp';

/** An answer as `callTool` gives it: the structured value and its JSON text, or an error. */
const ok = (value: Record<string, unknown>, isError = false): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  structuredContent: value,
  ...(isError ? { isError } : {}),
});
const error = (code: string, message: string, extra: Record<string, unknown> = {}): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: `${code}: ${message}` }],
  structuredContent: { error: { code, message, ...extra } },
});
const outcome = (name: string, result: CallToolResult, args: unknown = {}) =>
  mcpActivityOutcome(mcpActivityCall(name, args), result);

describe('mcpActivityCall', () => {
  it.each<[string, unknown, McpActivityCall]>([
    ['post_message', { text: 'hi' }, { kind: 'whombat', tool: 'whombat.post_message', object: null }],
    ['mail_search', { query: 'invoice' }, { kind: 'tool', tool: 'mail.search', object: null }],
    // The browser's: the opened page without its query and fragment (BT-03), as Hermes names its tools.
    [
      'browser_navigate',
      { url: 'https://shop.example/cart?session=abc#top' },
      { kind: 'web', tool: 'whombat.browser_navigate', object: 'https://shop.example/cart' },
    ],
    ['browser_type', { text: 'hunter2' }, { kind: 'web', tool: 'whombat.browser_type', object: null }],
    // Every Vault tool is one neutral row (VT-53, VT-D33).
    ['vault_save', { entry: 'vte_1' }, { kind: 'whombat', tool: 'whombat.vault_request', object: null }],
    ['browser_vault', {}, { kind: 'whombat', tool: 'whombat.vault_request', object: null }],
    // A name the server doesn't know.
    ['nope', {}, { kind: 'tool', tool: 'nope', object: null }],
  ])('%s', (name, args, expected) => {
    expect(mcpActivityCall(name, args)).toEqual(expected);
  });
});

describe('mcpActivityOutcome', () => {
  it('pending_approval waits with its approval; request_approval’s ok waits too; blocked fails with the key', () => {
    expect(outcome('perform_action', ok({ status: 'pending_approval', approvalId: 'apr_12' }))).toEqual({
      status: 'waiting',
      failure: null,
      keyNeeded: null,
      approvalId: 'apr_12',
      evidence: null,
    });
    expect(outcome('request_approval', ok({ status: 'ok', approvalId: 'apr_13', number: 13 }))).toMatchObject(
      {
        status: 'waiting',
        approvalId: 'apr_13',
      },
    );
    // Not an approval id: no link.
    expect(
      outcome('perform_action', ok({ status: 'pending_approval', approvalId: 'x y' })).approvalId,
    ).toBeNull();
    expect(
      outcome(
        'merge_pull_request',
        ok({ status: 'blocked', keyNeeded: { id: 'merge.main', label: 'Merge into main' } }),
      ),
    ).toMatchObject({ status: 'failed', failure: 'blocked', keyNeeded: 'Merge into main', evidence: null });
    expect(outcome('post_message', ok({ status: 'ok', messageId: 'msg_1' }))).toMatchObject({
      status: 'done',
      evidence: null,
    });
  });

  it('the browser’s refusals fail without a reason; a Vault answer is neutral', () => {
    const refused = ok({ status: 'refused', code: 'busy', reason: 'The browser is busy.' }, true);
    expect(outcome('browser_open', refused)).toMatchObject({
      status: 'failed',
      failure: 'error',
      evidence: null,
    });
    expect(
      outcome('vt_abcdefgh__HassTurnOn', {
        content: [{ type: 'text', text: 'Mara’s lamp failed' }],
        isError: true,
      }),
    ).toMatchObject({ status: 'failed', failure: 'error', evidence: null });
    expect(
      outcome('vault_request', ok({ status: 'failed', reason: 'upstream', message: 'Stripe 500' })),
    ).toMatchObject({ status: 'done', evidence: null });
  });

  it('a failed Whombat call says why, in the words the agent got (RA-DS49)', () => {
    const say = 'Say which conversation the plan is for (conversationId).';
    expect(outcome('plan_create', error('bad_request', say, { details: { secret: 'x' } }))).toMatchObject({
      status: 'failed',
      failure: 'error',
      evidence: { input: null, output: say },
    });
    const fields = outcome(
      'plan_create',
      error('validation_failed', 'Some arguments are not valid.', {
        fields: { conversationId: ['Expected a cnv_ id'] },
      }),
    );
    expect(fields.evidence?.output).toContain('conversationId: Expected a cnv_ id');
    // Refusals and problems to fix are failed rows with their reason, not “done”.
    expect(
      outcome(
        'plan_update',
        ok({ status: 'refused', code: 'step_done', reason: 'That step is done already.' }),
      ),
    ).toMatchObject({ status: 'failed', evidence: { output: 'That step is done already.' } });
    expect(
      outcome('schedule', ok({ status: 'invalid', problems: ['when: past', 'prompt: missing'] })),
    ).toMatchObject({ status: 'failed', evidence: { output: 'when: past; prompt: missing' } });
    // A connector tool's failure keeps its content out.
    expect(outcome('mail_search', error('internal', 'Mail of mara@x.test failed'))).toMatchObject({
      status: 'failed',
      evidence: null,
    });
  });

  it('redacts the reason before bounding it', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
    expect(
      outcome('post_message', error('internal', `${'x'.repeat(900)} ${token}`)).evidence?.output,
    ).toHaveLength(REASON_MAX);
    expect(outcome('post_message', error('internal', `${'x'.repeat(480)} ${token}`)).evidence?.output).toBe(
      `${'x'.repeat(480)} [redacted]`,
    );
    expect(redactSecrets(`curl -H "Authorization: Bearer abc.def.ghi" x`)).toBe(
      'curl -H "Authorization: [redacted]',
    );
  });
});
