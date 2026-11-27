/**
 * Android push: FCM HTTP v1. Authenticates as a Google service account (`FCM_SERVICE_ACCOUNT_JSON`, the
 * whole key file's JSON as one env value) via the OAuth2 JWT-bearer flow, signed with `node:crypto`
 * (no extra JWT library needed). Skipped, with a log line, when the env var is unset — dev and CI run
 * without Android push configured.
 */
import { createSign } from 'node:crypto';
import { liveActivityRef, type PushPayload } from '@whombat/core';
import { guardPreview } from './preview-off';
import type { PushOutcome, PushTransport } from './types';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export function parseServiceAccount(json: string): ServiceAccount | null {
  try {
    const obj = JSON.parse(json) as Partial<ServiceAccount>;
    if (
      typeof obj.client_email === 'string' &&
      typeof obj.private_key === 'string' &&
      typeof obj.project_id === 'string'
    ) {
      return { client_email: obj.client_email, private_key: obj.private_key, project_id: obj.project_id };
    }
  } catch {
    // fall through
  }
  return null;
}

/** The FCM HTTP v1 message body. Data-only (no `notification` block): the app builds the shown
 *  notification and, for `run_progress` / `approval_updated`, updates the live activity from the data. */
export function buildFcmMessage(handed: PushPayload, token: string) {
  // Previews off: only generic words go to Google, in the data fields and in the payload copy alike.
  const payload = guardPreview(handed);
  return {
    message: {
      token,
      data: {
        kind: payload.kind,
        title: payload.title,
        body: payload.body,
        path: payload.path,
        notificationId: payload.notificationId ?? '',
        // FCM data is strings only; present only when previews are off.
        ...(payload.preview === false ? { preview: 'false' } : {}),
        payload: JSON.stringify(payload),
      },
      android: {
        priority: 'high' as const,
        // Coalesce rapid live-activity updates for the same run/approval (each one carries the full state),
        // without one run's update replacing another's.
        collapseKey: payload.liveActivity ? liveActivityRef(payload.liveActivity.activity) : undefined,
      },
    },
  };
}

/**
 * Development only (`FCM_RELAY_URL`, refused in production): the same FCM message goes to a local relay
 * instead of Google, which hands it to an emulator (`apps/mobile/scripts/push.mjs relay`), so the whole
 * push path — broadcaster, audience, devices, message — runs without a Firebase project.
 */
async function relayFcm(
  url: string,
  log: Parameters<PushTransport>[1],
  device: Parameters<PushTransport>[2],
  payload: PushPayload,
): Promise<PushOutcome> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildFcmMessage(payload, device.token)),
    });
    return res.ok ? 'sent' : 'failed';
  } catch (err) {
    log.warn({ deviceId: device.id, err: String(err) }, 'FCM relay request failed');
    return 'failed';
  }
}

let cachedToken: { accessToken: string; expiresAt: number; forEmail: string } | null = null;

async function accessTokenFor(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.forEmail === account.client_email && cachedToken.expiresAt > now + 30) {
    return cachedToken.accessToken;
  }
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claims}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key);
  const assertion = `${unsigned}.${base64url(signature)}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    accessToken: data.access_token,
    expiresAt: now + data.expires_in,
    forEmail: account.client_email,
  };
  return data.access_token;
}

export const sendFcm: PushTransport = async (config, log, device, payload) => {
  if (config.FCM_RELAY_URL) return relayFcm(config.FCM_RELAY_URL, log, device, payload);
  if (!config.FCM_SERVICE_ACCOUNT_JSON) {
    log.info('FCM push skipped: FCM_SERVICE_ACCOUNT_JSON is not configured (see docs/push-setup.md)');
    return 'skipped';
  }
  const account = parseServiceAccount(config.FCM_SERVICE_ACCOUNT_JSON);
  if (!account) {
    log.warn('FCM_SERVICE_ACCOUNT_JSON is set but is not a valid Google service account key');
    return 'skipped';
  }
  let outcome: PushOutcome;
  try {
    const accessToken = await accessTokenFor(account);
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(buildFcmMessage(payload, device.token)),
    });
    if (res.ok) {
      outcome = 'sent';
    } else {
      const body = await res.text().catch(() => '');
      outcome = res.status === 404 || body.includes('UNREGISTERED') ? 'prune' : 'failed';
      if (outcome === 'failed')
        log.warn({ deviceId: device.id, status: res.status, body }, 'FCM request rejected');
    }
  } catch (err) {
    log.warn({ deviceId: device.id, err: String(err) }, 'FCM request failed');
    outcome = 'failed';
  }
  return outcome;
};
