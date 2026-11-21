/**
 * `whombat-diagnostics` — what the phone's system itself knows about how the app ended
 * (docs/app/decisions/phone-resilience.md). iOS: the crash and hang reports and the daily counts of endings it hands
 * the app through MetricKit, each kept as iOS's own JSON until the app has noted it (`src/errors/diagnostics.ts`).
 * Android 11+: the reasons its earlier runs ended (a crash, a native crash, an ANR, memory), with an ANR's and a native
 * crash's trace, each newer than the last one taken (`src/errors/androidExits.ts`). Without the module (tests, older
 * builds, Android 10 and older) there is nothing waiting.
 */
import { requireOptionalNativeModule } from 'expo';

export interface DiagnosticPayload {
  id: string;
  /** The payload as iOS wrote it, or the ending as the Android module describes it. */
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

/** These are noted (or not worth a note): they go from the phone, and the system handing them over again is ignored. */
export function removeDiagnostics(ids: string[]): void {
  if (ids.length) native?.remove(ids);
}

/** Calls `listener` when a payload arrived (iOS; Android's are read at the start); returns the unsubscribe. */
export function onDiagnostics(listener: () => void): () => void {
  const sub = native?.addListener('onPayload', listener);
  return () => sub?.remove();
}
