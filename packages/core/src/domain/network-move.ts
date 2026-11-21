/**
 * What owners read in the Inbox about the box's network (Whombat docs/decisions/network-move.md NM-09, NM-10;
 * concise-replies.md): a cable that stopped while Wi-Fi carries the box, the cable back as the backup when Wi-Fi lost
 * Whombat, and a connection that stopped letting Whombat in after the box's address changed. With the Whombat's own
 * name (“Home”), else “Your Whombat”.
 */

/** The Whombat's name in a sentence: its own, else “Your Whombat” at the start and “your Whombat” inside. */
export function whombatNameIn(name: string | null | undefined, start: boolean): string {
  const own = name?.trim();
  if (own) return own;
  return start ? 'Your Whombat' : 'your Whombat';
}

export const NETWORK_MOVE_WORDS = {
  /** NM-09: the cable stopped (lost its link or address) while Wi-Fi carries the box. */
  cableStopped: (name: string | null | undefined) =>
    `${whombatNameIn(name, true)} is on Wi-Fi now: its cable stopped working.`,
  cableStoppedBody: 'Plug the cable back in. If you unplugged it on purpose, you can settle this.',
  /** NM-09: the box turned its cable back on by itself (NM-03). */
  cableBackup: (name: string | null | undefined) =>
    `Wi-Fi stopped reaching Whombat, so ${whombatNameIn(name, false)} uses its cable again.`,
  cableBackupBody: 'Wi-Fi only is off for now. You can choose it again once the Wi-Fi works.',
  /** Where Use Wi-Fi only and the cable are: Settings → This Whombat → Overview. */
  openNetwork: 'Open Network',
  /** NM-10: “Home Assistant stopped letting Whombat in after its address changed. It may only allow 10.100.1.81.” */
  addressRefused: (connection: string, from: string) =>
    `${connection} stopped letting Whombat in after its address changed. It may only allow ${from}.`,
  addressRefusedBody: (to: string) => `Let ${to} in there too, or give Whombat its old address back.`,
  openConnection: 'Open it',
} as const;
