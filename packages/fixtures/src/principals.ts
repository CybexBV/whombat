/**
 * The person whose Whombat it is, Mara (Whombat one-person.md OP-01), and its one agent, Dusty (Whombat one-agent.md
 * OA-01). Dusty holds the agent's default keys (`agentDefaultGrants`). Since contracts 3.0 (CT-1516) the world has no
 * other people.
 */
import { deriveSeedKeypair, fingerprintOf } from '@whombat/core/audit';
import { type Agent, DEFAULT_AGENT_RUNTIME, type Grant, type Person } from '@whombat/core/domain';
import { agentDefaultGrants } from '@whombat/core/keys';
import { BURROW_ID } from './burrow.js';

export function seedKeys(id: string) {
  const kp = deriveSeedKeypair(id);
  return { publicKey: kp.publicKey, fingerprint: fingerprintOf(kp.publicKey), secretKey: kp.secretKey };
}

/** Secret key for a seeded principal, for signing fixture audit events. Not part of any Zod schema. */
export function secretKeyOf(id: string): string {
  return seedKeys(id).secretKey;
}

function person(
  handle: string,
  name: string,
  initials: string,
  tone: string,
  extra: Partial<Person> = {},
): Person {
  const id = `prn_${handle}`;
  const { publicKey, fingerprint } = seedKeys(id);
  return {
    id,
    burrowId: BURROW_ID,
    kind: 'person',
    name,
    handle,
    publicKey,
    fingerprint,
    createdAt: '2026-01-05T09:00:00.000Z',
    initials,
    tone,
    email: `${handle}@burrowhq.example`,
    ...extra,
  };
}

/* The person (PP in the mock): Mara, whose Whombat it is. */
export const mara: Person = person('mara', 'Mara Okafor', 'MO', '#d9c3a9', {
  shortName: 'Mara',
  title: 'Engineering lead',
});

/** The agent: Dusty in Dusty's drawing, on the review fix for PR #482 at 11:22 (`run`). */
export const dusty: Agent = (() => {
  const id = 'prn_dusty';
  const { publicKey, fingerprint } = seedKeys(id);
  return {
    id,
    burrowId: BURROW_ID,
    kind: 'agent',
    name: 'Dusty',
    handle: 'dusty',
    publicKey,
    fingerprint,
    createdAt: '2026-01-05T09:00:00.000Z',
    face: 'dusty',
    status: 'working',
    doing: 'Rounding VAT before formatting on feat/invoice-pdf.',
    runtime: { ...DEFAULT_AGENT_RUNTIME },
  };
})();

/** The Whombat's one agent. */
export const AGENT: Agent = dusty;

export const PEOPLE: Person[] = [mara];
export const PRINCIPALS = [...PEOPLE, AGENT];

export function principal(id: string) {
  return PRINCIPALS.find((p) => p.id === id);
}

/** The agent's grants in the mock world: the agent's defaults (`AGENT_DEFAULT_KEYS`). */
export const GRANTS: Grant[] = agentDefaultGrants(AGENT.id);

/** The grants of `agentId`: the agent's, or none for anyone else. */
export function grantsFor(agentId: string): Grant[] {
  return GRANTS.filter((g) => g.agentId === agentId);
}
