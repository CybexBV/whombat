/** Inputs shared by step handlers; no runtime dependencies or command registrations. */
import type { AutomationStep } from '@whombat/core';
import type { ApplyContext } from '../../commit/types';
import type { PrincipalRow } from '../../read/principals';
import type { AutomationRunRow, AutomationStepRow } from '../store';

/** The state written when this attempt starts, before any external effect. */
export type StepStart = {
  attempt: number;
  startedAt: Date;
  deadlineAt: Date;
  idempotencyKey: string;
  error: null;
  wakeAt: null;
};

/** The command has already checked the lease, publisher and content rooms before calling a handler. */
export type StepExecution<Kind extends AutomationStep['kind']> = {
  ctx: ApplyContext;
  run: AutomationRunRow;
  steps: readonly AutomationStepRow[];
  idx: number;
  attempt: number;
  scope: Record<string, unknown>;
  publisher: PrincipalRow;
  base: StepStart;
  step: Extract<AutomationStep, { kind: Kind }>;
};

/** PR handlers request a notice without importing the facade or its tracker fix-tracking dependency. */
export type PrAnnouncer = (
  ctx: ApplyContext,
  run: AutomationRunRow,
  repo: string,
  number: number,
  alreadyOpen: boolean,
  idx: number,
) => Promise<string | null>;
