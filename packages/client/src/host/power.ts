/**
 * The box's power in “How it’s doing” (Whombat desk-display.md DK-10; app desk-display-web.md AP-3020): one line from
 * the manager's `HostNow.power` — plugged in with the battery held at its limit, charging, or on battery with the time
 * left — in the contracts' words (`hostPowerText`), amber on battery and red from 15 %. Nothing on a machine without a
 * battery. Pure; the web and the phone draw it the same.
 */
import { DESK_BATTERY_LOW_PERCENT, HostPower, hostPowerText } from '../desk/contract';

export interface HostPowerLine {
  source: HostPower['source'];
  text: string;
  tone: 'ok' | 'warn' | 'bad';
}

/** From 15 % on battery the line is red: the assistant has said so, and Whombat shuts down at 10 % (DK-10). */
export const HOST_POWER_LOW_PCT = DESK_BATTERY_LOW_PERCENT;

/** The power line, or null without a battery. */
export function hostPowerLine(power: HostPower | null | undefined): HostPowerLine | null {
  if (!power) return null;
  const text = hostPowerText.line({ ...power, percent: Math.round(power.percent) });
  if (power.source === 'ac') return { source: 'ac', text, tone: 'ok' };
  return { source: 'battery', text, tone: power.percent <= HOST_POWER_LOW_PCT ? 'bad' : 'warn' };
}

/** `host.metrics`'s `now.power`, read on its own so a sample without it (or one this app can't read) has no line. */
export function hostPowerOf(now: object | null | undefined): HostPower | null {
  const parsed = HostPower.safeParse((now as { power?: unknown } | null | undefined)?.power);
  return parsed.success ? parsed.data : null;
}
