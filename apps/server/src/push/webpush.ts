/**
 * Web push (VAPID). Uses the `web-push` library to build the encrypted request (payload encryption + the
 * VAPID JWT) and sends it through the SSRF-safe outbound helper (lib/outbound.ts): the endpoint is a URL the
 * user supplied, so only https endpoints of the browsers' push services are dialled, never a private
 * address, and redirects are not followed. Registration checks the same rule (`webPushEndpointProblem`).
 * Tests point subscriptions at a plain `http://127.0.0.1` mock with `WHOMBAT_OUTBOUND_ALLOW_PRIVATE`.
 */
import webPush from 'web-push';
import type { Config } from '../config';
import { checkOutboundUrl, OutboundError, type OutboundPolicy, outboundRequest } from '../lib/outbound';
import type { PushOutcome, PushTransport } from './types';

/** The push services browsers subscribe with (Chrome/Edge/Opera, Firefox, Safari, Windows). */
const PUSH_SERVICE_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^(?:[a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^(?:[a-z0-9-]+\.)*push\.apple\.com$/,
  /^(?:[a-z0-9-]+\.)*notify\.windows\.com$/,
];

export function isPushServiceHost(host: string): boolean {
  return PUSH_SERVICE_HOSTS.some((re) => re.test(host));
}

function pushPolicy(config: Config): OutboundPolicy {
  return {
    allowPrivate: config.WHOMBAT_OUTBOUND_ALLOW_PRIVATE,
    allowHost: isPushServiceHost,
    maxBytes: 64 * 1024,
    timeoutMs: 10_000,
  };
}

/** Why a web push endpoint may not be registered, or null when it may. */
export function webPushEndpointProblem(config: Config, endpoint: string): string | null {
  try {
    checkOutboundUrl(endpoint, pushPolicy(config));
    return null;
  } catch (err) {
    return err instanceof OutboundError ? err.message : 'Not a web push endpoint.';
  }
}

function headerStrings(headers: Record<string, string | number>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)]));
}

/** Gone: the browser unsubscribed or the push service forgot the subscription. Prune the device row. */
function isGone(status: number): boolean {
  return status === 404 || status === 410;
}

export const sendWebPush: PushTransport = async (config, log, device, payload) => {
  if (!config.VAPID_PUBLIC_KEY || !config.VAPID_PRIVATE_KEY) {
    log.info('web push skipped: VAPID keys are not configured (see docs/push-setup.md)');
    return 'skipped';
  }
  if (!device.webPush) {
    log.warn({ deviceId: device.id }, 'web push device is missing its p256dh/auth subscription keys');
    return 'prune';
  }
  const problem = webPushEndpointProblem(config, device.token);
  if (problem) {
    log.warn({ deviceId: device.id, problem }, 'web push endpoint refused');
    return 'prune';
  }
  const subscription = { endpoint: device.token, keys: device.webPush };
  let outcome: PushOutcome;
  try {
    const details = webPush.generateRequestDetails(subscription, JSON.stringify(payload), {
      vapidDetails: {
        subject: config.VAPID_SUBJECT,
        publicKey: config.VAPID_PUBLIC_KEY,
        privateKey: config.VAPID_PRIVATE_KEY,
      },
      TTL: 60 * 60 * 24,
    });
    const res = await outboundRequest(
      details.endpoint,
      {
        method: details.method,
        headers: headerStrings(details.headers as Record<string, string | number>),
        ...(details.body !== undefined && details.body !== null
          ? { body: details.body as Buffer | string }
          : {}),
      },
      pushPolicy(config),
    );
    if (res.status >= 200 && res.status < 300) outcome = 'sent';
    else if (isGone(res.status)) outcome = 'prune';
    else {
      log.warn({ deviceId: device.id, status: res.status }, 'web push request rejected');
      outcome = 'failed';
    }
  } catch (err) {
    if (err instanceof OutboundError && err.refused) {
      // Not a push service (or not a public address): this device row can never be delivered to.
      log.warn({ deviceId: device.id, reason: err.reason }, 'web push endpoint refused');
      return 'prune';
    }
    log.warn({ deviceId: device.id, err: String(err) }, 'web push request failed');
    outcome = 'failed';
  }
  return outcome;
};

export { webPush };
