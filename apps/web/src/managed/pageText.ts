/**
 * What the box's own page goes without, said plainly (HE-50; Whombat direct-connection.md DC-11; hermes-engine-app.md
 * AP-5325). The page reaches the box without Whombat's servers: passkeys belong to the hosted app's name and
 * notifications come through those servers, so neither works here — on the plain-HTTP local-network page nor on the
 * box's Tailscale page. Everything else, the end-to-end encrypted session included, is the same.
 */
export const BOX_PAGE_TEXT = {
  passkeys: 'Passkeys aren’t available on this page. Add one in the Whombat app or at app.whombat.com.',
  notificationsTitle: 'Not available on this page',
  notifications: 'Notifications come through the Whombat app or app.whombat.com.',
} as const;
