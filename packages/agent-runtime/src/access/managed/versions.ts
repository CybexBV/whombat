/** Which provider versions a release pins, read from what the release sets in the environment. */

/** The pins (`WHOMBAT_PROVIDER_PINS`: `claude=2.1.282,codex=0.157.0`), set by the release (W3-PV). */
export function providerPins(value: string | undefined): Partial<Record<'claude' | 'codex', string>> {
  const out: Partial<Record<'claude' | 'codex', string>> = {};
  for (const part of (value ?? '').split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if ((k === 'claude' || k === 'codex') && v) out[k] = v;
  }
  return out;
}
