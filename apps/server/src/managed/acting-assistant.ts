/**
 * Which assistant an op runs for (docs/decisions/service-settings.md SST-04): `SessionDispatcher.runForAssistant` runs
 * an op as the person, so the handler's principal is theirs; what it records may still say the assistant asked (a
 * changed setting's “Dusty changed this yesterday”). Only the dispatcher sets it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const acting = new AsyncLocalStorage<{ agentId: string }>();

/** Runs `work` with `agentId` as the assistant it is for. */
export function forAssistant<T>(agentId: string, work: () => Promise<T>): Promise<T> {
  return acting.run({ agentId }, work);
}

/** The assistant the running op is for, or null when a person's own device asked. */
export function actingAgentId(): string | null {
  return acting.getStore()?.agentId ?? null;
}
