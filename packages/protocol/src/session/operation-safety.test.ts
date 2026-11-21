import { describe, expect, it } from 'vitest';
import {
  OPERATION_RETRIES,
  OPERATION_SAFETY,
  type OperationSafety,
  operationSafety,
  resendAfterNotFound,
} from './operation-safety.js';
import {
  API_OPERATIONS,
  createOperationAllowlist,
  type OperationName,
  type OperationSpec,
  receiptDigest,
  SESSION_EXCLUDED_API_OPS,
  SESSION_OPERATIONS,
} from './operations.js';

const specs: OperationSpec[] = [...API_OPERATIONS.values(), ...SESSION_OPERATIONS.values()];

/**
 * The op-name heuristic clients used before CT-194 (whombat-app `defaultIsDestructive`, contracts ≤ 0.28): every DELETE
 * and every action starting with one of these words. The classification may only be stricter.
 */
const LEGACY_DESTRUCTIVE =
  /(^|\.)(merge|deploy|decide|delete|remove|revoke|discard|archive|leave|disconnect|reset|transfer)/i;
const legacyDestructive = (spec: OperationSpec) =>
  spec.endpoint?.method === 'DELETE' || LEGACY_DESTRUCTIVE.test(spec.op.split('.').slice(1).join('.'));

describe('operation safety (CT-194)', () => {
  it('classifies every operation exactly once', () => {
    const ops = specs.map((s) => s.op).sort();
    expect(new Set(ops).size).toBe(ops.length);
    expect(Object.keys(OPERATION_SAFETY).sort()).toEqual(ops);
    for (const [op, safety] of Object.entries(OPERATION_SAFETY)) {
      expect(OPERATION_RETRIES, op).toContain(safety.retry);
      expect(typeof safety.destructive, op).toBe('boolean');
    }
  });

  it('a table missing an operation, or naming one that doesn’t exist, fails typecheck', () => {
    const { 'messages.send': _sent, ...missing } = OPERATION_SAFETY;
    // @ts-expect-error — every operation needs an entry.
    const incomplete: Record<OperationName, OperationSafety> = missing;
    const extra: Record<OperationName, OperationSafety> = {
      ...OPERATION_SAFETY,
      // @ts-expect-error — only operations of `API_OPERATIONS` and `SESSION_OPERATIONS`.
      'messages.teleport': { destructive: false, retry: 'receipt' },
    };
    expect(Object.keys(incomplete)).not.toContain('messages.send');
    expect(extra).toHaveProperty('messages.teleport');
  });

  it('every spec carries its entry', () => {
    for (const spec of specs) {
      expect({ destructive: spec.destructive, retry: spec.retry }, spec.op).toEqual(
        OPERATION_SAFETY[spec.op as OperationName],
      );
      expect(createOperationAllowlist().get(spec.op) ?? spec, spec.op).toMatchObject({
        destructive: spec.destructive,
        retry: spec.retry,
      });
    }
  });

  it('reads are asked again and never destructive; only reads are', () => {
    for (const spec of specs) {
      expect(spec.retry === 'safe', spec.op).toBe(!spec.mutating);
      if (!spec.mutating) expect(spec.destructive, spec.op).toBe(false);
    }
  });

  it('without a receipt a retry could meet, nothing is resent: ephemeral, export, secret, not over a session', () => {
    for (const spec of specs) {
      if (!spec.mutating) continue;
      const noReceipt =
        spec.ephemeral || spec.exportOp || spec.secret || SESSION_EXCLUDED_API_OPS.includes(spec.op);
      if (noReceipt) expect(spec.retry, spec.op).toBe('never');
    }
  });

  it('nothing on the enrollment channel is resent: its receipt moves to the account the device enrolls into', () => {
    const enroll = specs.filter((s) => s.channel === 'enroll' && s.mutating);
    expect(enroll.map((s) => s.op)).toContain('recovery.enroll');
    for (const spec of enroll) expect(spec.retry, spec.op).toBe('never');
  });

  it('`receipt` matches the runtime’s receipt rule: a mutation, not ephemeral, not an export op, not secret', () => {
    const receipt = specs.filter((s) => s.retry === 'receipt');
    expect(receipt.length).toBeGreaterThan(100);
    for (const spec of receipt) {
      expect(spec.mutating, spec.op).toBe(true);
      expect(spec.ephemeral, spec.op).toBe(false);
      expect(spec.exportOp, spec.op).toBe(false);
      expect(spec.secret, spec.op).toBe(false);
      expect(spec.transfer, spec.op).toBe('none');
    }
  });

  it('is at least as strict as the op-name heuristic it replaces: every DELETE, merge, decision, removal …', () => {
    const legacy = specs.filter((s) => s.mutating && legacyDestructive(s)).map((s) => s.op);
    expect(legacy).toContain('prs.merge');
    expect(legacy).toContain('endpoints.revoke');
    for (const op of legacy) expect(OPERATION_SAFETY[op as OperationName].destructive, op).toBe(true);
    // And more: a redaction, a cancelled run, a replaced recovery key, another device let in.
    for (const op of [
      'feedback.redactReport',
      'automations.cancelRun',
      'recovery.kit.rotate',
      'enroll.pair.approve',
    ])
      expect(OPERATION_SAFETY[op as OperationName].destructive, op).toBe(true);
  });

  it('never resends what acts outside its receipt, or what a lost enrollment can’t find again', () => {
    // A GitHub merge inside the transaction; a repository created on disk first; the claim's one-time PAKE state;
    // a recovery enrollment moves its receipt to the new account, so `status` can't find it.
    expect(OPERATION_SAFETY['prs.merge']).toEqual({ destructive: true, retry: 'never' });
    expect(OPERATION_SAFETY['repos.create'].retry).toBe('never');
    expect(OPERATION_SAFETY['enroll.claim'].retry).toBe('never');
    expect(OPERATION_SAFETY['recovery.enroll'].retry).toBe('never');
    // Work entirely inside the command's transaction, or first committed and then handed on.
    expect(OPERATION_SAFETY['messages.send']).toEqual({ destructive: false, retry: 'receipt' });
    expect(OPERATION_SAFETY['approvals.decide']).toEqual({ destructive: true, retry: 'receipt' });
    expect(OPERATION_SAFETY['backup.runNow']).toEqual({ destructive: false, retry: 'receipt' });
  });

  it('removals that act before their commit are never resent, destructive or not (0.29.1, CT-195)', () => {
    // A revoked Google grant, a runner's sign-out, a client the manager removed: `not_found` doesn't mean nothing
    // happened, and a repeat later would undo a reconnect, a sign-in or a reinstall made meanwhile.
    for (const op of ['connections.remove', 'signins.logout', 'clients.remove'] as const) {
      expect(OPERATION_SAFETY[op], op).toEqual({ destructive: true, retry: 'never' });
      expect(resendAfterNotFound(op), op).toBe(false);
    }
  });

  it('keeps a new webhook secret out of receipts: `automations.webhook` is a secret op (0.29.1, CT-195)', () => {
    const spec = API_OPERATIONS.get('automations.webhook');
    expect(spec?.secret).toBe(true);
    expect(spec?.retry).toBe('never');
    expect(receiptDigest(spec as OperationSpec, { body: { enabled: true } })).toBe(
      receiptDigest(spec as OperationSpec, { body: { enabled: false, rotateSecret: true } }),
    );
  });

  it('classifies the Vault’s SSH ops (0.32.0, vault.md VT-S03…VT-S07)', () => {
    const replace = API_OPERATIONS.get('vault.replaceSshKey');
    expect(replace?.secret).toBe(true);
    expect(replace?.retry).toBe('never');
    // Generating returns only the public half: an ordinary op, but the old key stops working, so a person decides.
    expect(API_OPERATIONS.get('vault.generateSshKey')?.secret).toBe(false);
    expect(OPERATION_SAFETY['vault.generateSshKey']).toEqual({ destructive: true, retry: 'receipt' });
    expect(OPERATION_SAFETY['vault.removeSshServer'].destructive).toBe(true);
    for (const op of [
      'vault.addSshServer',
      'vault.updateSshServer',
      'vault.checkSshServer',
      'vault.trustSshHostKey',
      'vault.setKeyServers',
    ] as const)
      expect(resendAfterNotFound(op), op).toBe(true);
  });

  it('is frozen: no consumer loosens one op, or every op sharing an entry (0.29.1, CT-195)', () => {
    expect(Object.isFrozen(OPERATION_SAFETY)).toBe(true);
    for (const [op, safety] of Object.entries(OPERATION_SAFETY))
      expect(Object.isFrozen(safety), op).toBe(true);
    expect(() => {
      (OPERATION_SAFETY['messages.delete'] as { destructive: boolean }).destructive = false;
    }).toThrow(TypeError);
    expect(() => {
      (OPERATION_SAFETY as Record<string, OperationSafety>)['messages.teleport'] =
        OPERATION_SAFETY['messages.send'];
    }).toThrow(TypeError);
    expect(OPERATION_SAFETY['messages.delete'].destructive).toBe(true);
    expect(operationSafety('messages.teleport')).toBeUndefined();
  });

  it('resends by itself only a known, non-destructive `receipt` op', () => {
    expect(resendAfterNotFound('messages.send')).toBe(true);
    expect(resendAfterNotFound('messages.delete')).toBe(false);
    expect(resendAfterNotFound('prs.merge')).toBe(false);
    expect(resendAfterNotFound('packs.setSecret')).toBe(false);
    expect(resendAfterNotFound('messages.list')).toBe(false);
    expect(resendAfterNotFound('messages.teleport')).toBe(false);
    expect(operationSafety('messages.teleport')).toBeUndefined();
    expect(operationSafety('toString')).toBeUndefined();
    expect(operationSafety('messages.send')).toBe(OPERATION_SAFETY['messages.send']);
  });

  it('classifies the agent’s services and commands (0.36, CT-225; 3.0, CT-1537)', () => {
    expect(OPERATION_SAFETY['services.list']).toEqual({ destructive: false, retry: 'safe' });
    expect(OPERATION_SAFETY['services.stop']).toEqual({ destructive: true, retry: 'receipt' });
    for (const op of [
      'computers.get',
      'members.list',
      'admins.grant',
      'enroll.invite.create',
      'presence.set',
    ])
      expect(op in OPERATION_SAFETY, op).toBe(false);
    expect(OPERATION_SAFETY['agent.commandAllowances'].retry).toBe('safe');
    expect(OPERATION_SAFETY['agent.removeCommandAllowance'].destructive).toBe(true);
    expect(OPERATION_SAFETY['vault.setKeyEnvName']).toEqual({ destructive: false, retry: 'receipt' });
  });

  it('classifies Hermes memory and skills (0.125, CT-1248)', () => {
    expect(OPERATION_SAFETY['memory.mine'].retry).toBe('safe');
    expect(OPERATION_SAFETY['memory.write']).toEqual({ destructive: false, retry: 'receipt' });
    expect(OPERATION_SAFETY['memory.clear'].destructive).toBe(true);
    expect(OPERATION_SAFETY['memory.setNotes'].retry).toBe('receipt');
    expect(OPERATION_SAFETY['skills.libraryRemove'].destructive).toBe(true);
    expect('skills.libraryShare' in OPERATION_SAFETY).toBe(false);
    expect('skills.shareRequest' in OPERATION_SAFETY).toBe(false);
  });

  it('classifies a run’s tracker report (0.69, CT-325)', () => {
    expect(OPERATION_SAFETY['tracker.item']).toEqual({ destructive: false, retry: 'safe' });
    // Emails the reporter before its commit: a person decides on sending it again (with the same `requestId`).
    expect(OPERATION_SAFETY['tracker.update']).toEqual({ destructive: true, retry: 'receipt' });
    expect(resendAfterNotFound('tracker.update')).toBe(false);
    expect(API_OPERATIONS.get('tracker.item')?.endpoint?.path).toBe(
      '/burrows/:burrow/trackers/runs/:runId/item',
    );
    expect(API_OPERATIONS.get('tracker.update')?.endpoint?.method).toBe('POST');
  });
});
