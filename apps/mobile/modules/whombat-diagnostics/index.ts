/**
 * `whombat-diagnostics` — what iOS itself knows about how the app ended (docs/app/decisions/phone-resilience.md): the
 * crash and hang reports and the daily counts of endings it hands the app through MetricKit, each kept as iOS's own
 * JSON until the app has noted it (`src/errors/diagnostics.ts`). iOS only; without the module (Android, tests, older
 * builds) there is nothing waiting.
 */
import { requireOptionalNativeModule } from 'expo';

export interface DiagnosticPayload {
  id: string;
  /** The payload as iOS wrote it. */
  json: string;
}

interface NativeWhombatDiagnostics {
  pending(): DiagnosticPayload[];
  remove(ids: string[]): void;
  addListener(event: 'onPayload', listener: () => void): { remove(): void };
}

const native = requireOptionalNativeModule<NativeWhombatDiagnostics>('WhombatDiagnostics');

/** The payloads waiting, oldest first. */
export function pendingDiagnostics(): DiagnosticPayload[] {
  return native?.pending() ?? [];
}

/** These are noted: they go from the phone, and iOS handing them over again is ignored. */
export function removeDiagnostics(ids: string[]): void {
  if (ids.length) native?.remove(ids);
}

/** Calls `listener` when a payload arrived; returns the unsubscribe. */
export function onDiagnostics(listener: () => void): () => void {
  const sub = native?.addListener('onPayload', listener);
  return () => sub?.remove();
}
