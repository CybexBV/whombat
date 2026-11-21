/**
 * The assistant's settings map (docs/decisions/assistant-settings.md): every operation of the session allowlist with
 * what the assistant may do with it and where a person finds it. Typecheck requires an entry per op (an op added
 * without one fails `pnpm check`), and `assistant-settings.test.ts` holds the rules: a read is never changed, a
 * destructive change always asks, a secret never goes through the assistant, the people-only places stay people's.
 */
import type { OperationName } from '../operations.js';
import { BOX_SETTINGS } from './box.js';
import { PEOPLE_SETTINGS } from './people.js';
import { type AssistantAccess, type AssistantSetting, accessForInput } from './types.js';
import { WORK_SETTINGS } from './work.js';

export * from './pages.js';
export * from './skill.js';
export * from './types.js';

export const ASSISTANT_SETTINGS = {
  ...PEOPLE_SETTINGS,
  ...BOX_SETTINGS,
  ...WORK_SETTINGS,
} as const satisfies Record<OperationName, AssistantSetting>;

const TABLE: Readonly<Record<string, AssistantSetting>> = ASSISTANT_SETTINGS;

/** The op's entry; an op the map doesn't know (a newer runtime's) is not a setting. */
export function assistantSetting(op: string): AssistantSetting {
  return Object.hasOwn(TABLE, op) ? (TABLE[op] as AssistantSetting) : { access: 'none' };
}

/** What the assistant may do with this op and this input: guarded parts the input sets raise it (`guarded`). */
export function assistantAccessFor(op: string, input: unknown): AssistantAccess {
  return accessForInput(assistantSetting(op), input);
}

/**
 * Ops a person can find in Settings (every access but `none`). `never` ones are in it: the assistant says where they
 * are and the person does them.
 */
export function settingsOps(): string[] {
  return Object.keys(TABLE)
    .filter((op) => TABLE[op]?.access !== 'none')
    .sort();
}

/**
 * Areas whose ops stay the person's whatever their entry says (the test holds every entry to it): the assistant's own
 * permissions and its approvals, the person's devices, passkeys, recovery and sign-ins, the Vault's secrets, remote
 * help and the licence.
 */
export const PEOPLE_ONLY_OPS: readonly (string | RegExp)[] = [
  'agent.setKeys',
  'agent.removeCommandAllowance',
  'automations.setKeys',
  // What the assistant may do with a connection's tools and the local network: its own permissions.
  'connections.setTool',
  'connections.setToolLimits',
  'connections.allowNetwork',
  'burrows.setAgentsReachLan',
  'approvals.decide',
  'approvals.undo',
  'deviceSkills.decide',
  'deviceSkills.decline',
  /^enroll\./,
  /^passkeys?\./,
  /^endpoints\./,
  /^recovery\./,
  /^devices\./,
  /^push\./,
  /^signins\./,
  /^remoteHelp\./,
  /^licence\./,
  /^vault\./,
  /^vaultNetworks\./,
  'backups.restore',
  'memory.clear',
];

export function peopleOnlyOp(op: string): boolean {
  return PEOPLE_ONLY_OPS.some((p) => (typeof p === 'string' ? p === op : p.test(op)));
}
