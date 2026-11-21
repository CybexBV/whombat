/**
 * `whombat://demo/version?who=client|appliance` (a demo build only; hermes-engine-app.md AP-5375): what a box on another
 * protocol major shows, without one — the demo box always speaks this app's.
 */
export function demoVersionGate(url: string | null): 'client' | 'appliance' | null {
  const m = url ? /^whombat:\/\/demo\/version\?who=(client|appliance)\b/.exec(url) : null;
  return (m?.[1] as 'client' | 'appliance' | undefined) ?? null;
}
