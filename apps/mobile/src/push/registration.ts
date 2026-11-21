/**
 * Development only: the FCM "token" of a device whose pushes go through the local relay
 * (`FCM_RELAY_URL` + `scripts/push.mjs relay`) because there is no Firebase project on this machine.
 */
export function devRelayToken(deviceId: string): string {
  return `dev-relay:${deviceId.replace(/[^\w.-]/g, '_').slice(0, 100)}`;
}
