/**
 * Every server int test holds `OPERATION_SAFETY` to what it drives (docs/decisions/command-safety.md CS-08): an op seen
 * acting outside the database (not idempotently) before its commit must be `retry: never` or destructive in the
 * contract, or a client could resend it after a lost answer. Effects labelled `test.*` are a test's own stand-ins.
 */
import { operationSafety } from '@whombat/protocol/session';
import { afterAll, expect } from 'vitest';
import { observeExternalEffects } from '../commit/scope';

const violations = new Set<string>();
const stop = observeExternalEffects((e) => {
  if (!e.op || !e.beforeCommit || e.idempotent || e.label.startsWith('test.')) return;
  const safety = operationSafety(e.op);
  if (safety?.retry === 'never' || safety?.destructive === true) return;
  violations.add(
    `${e.op} runs ${e.label} before its commit, but OPERATION_SAFETY has ${JSON.stringify(safety ?? null)}`,
  );
});

afterAll(() => {
  stop();
  expect([...violations], 'ops acting before their commit that a client may resend').toEqual([]);
});
