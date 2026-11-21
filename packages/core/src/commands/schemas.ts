/**
 * The commands the person always allows the agent (Whombat agent-computer.md AC-42; contracts 0.36.0, CT-221; since 3.0
 * the commands run on the person's Whombat, Whombat one-person.md OP-07, CT-1530).
 */
import { z } from 'zod';
import { Timestamp } from '../domain/common.js';
import { CommandAllowanceId, PrincipalId } from '../ids.js';
import { KeyId } from '../keys/catalog.js';
import { COMMAND_MAX, COMMAND_TARGET_MAX } from './commands.js';

/**
 * A command a person always allows an agent (AC-42, “Always allow for {Agent}”): the key it needs, the command
 * normalised (`normaliseCommand`) and its target. The guard runs a command without asking when an allowance has the
 * same key, normalised command and target. Shown and removable in the agent's Access settings.
 */
export const CommandAllowance = z.object({
  id: CommandAllowanceId,
  agentId: PrincipalId,
  keyId: KeyId,
  /** Normalised (`normaliseCommand`). */
  command: z.string().min(1).max(COMMAND_MAX),
  target: z.string().max(COMMAND_TARGET_MAX).nullable(),
  /** Who said “Always allow” (the person). */
  createdById: PrincipalId,
  createdAt: Timestamp,
});
export type CommandAllowance = z.infer<typeof CommandAllowance>;

/** The most allowances an agent keeps; the oldest goes when a new one would pass it. */
export const COMMAND_ALLOWANCES_MAX = 200;
