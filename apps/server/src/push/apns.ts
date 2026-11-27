/**
 * iOS push: APNs, token-based auth (a `.p8` signing key, `APNS_KEY_ID` / `APNS_TEAM_ID`), HTTP/2. Behind
 * the same `PushTransport` interface as web push and FCM. Skipped, with a log line, when unconfigured —
 * this is built and wired up now (ARCHITECTURE "Notifications and live activities": "iOS … code in place,
 * built on macOS later") but has no APNs credentials or a real device to send to in dev/CI.
 *
 * Live activities use the same transport: `device.apnsPushToStart` selects the `.push-to-start-token`
 * topic suffix and the `liveactivity` push type (Apple's push-to-start / ActivityKit update contract);
 * `payload.liveActivity` carries the event (`start` / `update` / `end`) and the content state.
 */

import { createSign } from 'node:crypto';
import { connect, constants } from 'node:http2';
import { IOS_LIVE_ACTIVITY_ATTRIBUTES, liveActivityAttributes } from '@whombat/core';
import type { PushOutcome, PushTransport } from './types';

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

let cachedToken: { jwt: string; expiresAt: number; forKeyId: string } | null = null;

function providerToken(keyId: string, teamId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.forKeyId === keyId && cachedToken.expiresAt > now + 60) {
    return cachedToken.jwt;
  }
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = base64url(JSON.stringify({ iss: teamId, iat: now }));
  const unsigned = `${header}.${claims}`;
  // ES256 JWT signatures are the raw (r, s) pair, not the DER Node's default signature format produces.
  const signature = createSign('SHA256')
    .update(unsigned)
    .sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });
  const jwt = `${unsigned}.${base64url(signature)}`;
  cachedToken = { jwt, expiresAt: now + 55 * 60, forKeyId: keyId };
  return jwt;
}

/**
 * `apns-topic`: the bundle id for alerts; `<bundle id>.push-type.liveactivity` for every live-activity push,
 * whether it goes to an activity's update token or to the push-to-start token (`device.apnsPushToStart`).
 */
export function apnsTopic(bundleId: string, liveActivity: boolean): string {
  return liveActivity ? `${bundleId}.push-type.liveactivity` : bundleId;
}

/** One aps payload: a plain alert/data push, or (when `event` is set) a live activity push. */
export function buildApnsPayload(payload: {
  title: string;
  body: string;
  path: string;
  /** Alerts: the burrow slug and inbox row, so the app opens the screen and marks the row read. */
  burrow?: string;
  notificationId?: string | null;
  /** False when the recipient turned previews off: the app shows its own generic words in its own language. */
  preview?: boolean;
  event?: 'start' | 'update' | 'end';
  contentState?: unknown;
  attributesType?: string;
  attributes?: unknown;
}) {
  if (payload.event) {
    const now = Math.floor(Date.now() / 1000);
    return {
      aps: {
        timestamp: now,
        event: payload.event,
        'content-state': payload.contentState ?? {},
        // Push-to-start needs an alert; an ended activity stays on the Lock Screen for 30 minutes.
        ...(payload.event === 'start'
          ? {
              'attributes-type': payload.attributesType,
              attributes: payload.attributes,
              alert: { title: payload.title, body: payload.body },
            }
          : {}),
        ...(payload.event === 'end' ? { 'dismissal-date': now + 30 * 60 } : {}),
      },
      path: payload.path,
    };
  }
  return {
    aps: { alert: { title: payload.title, body: payload.body }, 'mutable-content': 1 },
    path: payload.path,
    ...(payload.burrow ? { burrow: payload.burrow } : {}),
    ...(payload.notificationId ? { notificationId: payload.notificationId } : {}),
    ...(payload.preview === false ? { preview: false } : {}),
  };
}

/**
 * What an APNs answer means for the token: `sent`, `prune` only when Apple says the token itself is gone (410
 * Unregistered or ExpiredToken, 400 BadDeviceToken), else `failed`. Apple's other 400s (BadTopic,
 * DeviceTokenNotForTopic, TopicDisallowed, PayloadTooLarge …) are about the request or this box's setup: removing the
 * device for them would remove every iPhone over one wrong setting.
 */
export function apnsOutcome(status: number, body: string): PushOutcome {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 410) return 'prune';
  if (status === 400) {
    let reason: unknown;
    try {
      reason = (JSON.parse(body) as { reason?: unknown } | null)?.reason;
    } catch {
      reason = undefined;
    }
    if (reason === 'BadDeviceToken') return 'prune';
  }
  return 'failed';
}

export const sendApns: PushTransport = async (config, log, device, payload) => {
  const { APNS_KEY_ID, APNS_TEAM_ID, APNS_PRIVATE_KEY, APNS_BUNDLE_ID } = config;
  if (!APNS_KEY_ID || !APNS_TEAM_ID || !APNS_PRIVATE_KEY || !APNS_BUNDLE_ID) {
    log.info('APNs push skipped: APNS_* is not configured (see docs/push-setup.md)');
    return 'skipped';
  }
  const privateKey = APNS_PRIVATE_KEY.includes('\\n')
    ? APNS_PRIVATE_KEY.replaceAll('\\n', '\n')
    : APNS_PRIVATE_KEY;
  const host = config.APNS_ENV === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
  const topic = apnsTopic(APNS_BUNDLE_ID, !!payload.liveActivity);
  const body = JSON.stringify(
    payload.liveActivity
      ? buildApnsPayload({
          title: payload.liveActivity.display.title,
          body: payload.liveActivity.display.text,
          path: payload.path,
          event: payload.liveActivity.event,
          // The widget renders the display (`WhombatLiveAttributes.ContentState` in the app's Swift code).
          contentState: payload.liveActivity.display,
          attributesType: IOS_LIVE_ACTIVITY_ATTRIBUTES,
          attributes: liveActivityAttributes(payload.liveActivity.activity, payload.burrow),
        })
      : buildApnsPayload(payload),
  );
  let outcome: PushOutcome;
  const session = connect(`https://${host}`);
  try {
    outcome = await new Promise<PushOutcome>((resolve, reject) => {
      session.on('error', reject);
      const jwt = providerToken(APNS_KEY_ID, APNS_TEAM_ID, privateKey);
      const req = session.request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${device.token}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': topic,
        'apns-push-type': payload.liveActivity ? 'liveactivity' : 'alert',
        'apns-priority': '10',
      });
      let status = 0;
      req.on('response', (headers) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      let responseBody = '';
      req.on('data', (chunk) => {
        responseBody += chunk;
      });
      req.on('end', () => {
        const outcome = apnsOutcome(status, responseBody);
        if (outcome === 'failed')
          log.warn({ deviceId: device.id, status, body: responseBody }, 'APNs request rejected');
        resolve(outcome);
      });
      req.on('error', reject);
      req.end(body);
    });
  } catch (err) {
    log.warn({ deviceId: device.id, err: String(err) }, 'APNs request failed');
    outcome = 'failed';
  } finally {
    session.close();
  }
  return outcome;
};
