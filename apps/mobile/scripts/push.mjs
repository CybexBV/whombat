#!/usr/bin/env node
// Development push for an Android emulator, without a Firebase project:
//
//   node scripts/push.mjs relay [--port 4498] [--serial emulator-5620]
//       A local stand-in for FCM. Start the server with FCM_RELAY_URL=http://127.0.0.1:4498/fcm and a debug
//       app with EXPO_PUBLIC_WHOMBAT_PUSH_RELAY=1 (it registers a `dev-relay:` token); every FCM message the
//       server sends is delivered to the emulator as FCM would deliver it — the app's native push handler
//       runs whether the app is open, in the background or killed.
//
//   node scripts/push.mjs inject <payload.json | -> [--serial emulator-5620]
//       Deliver one `PushPayload` (the FCM message's `data.payload`) from a file or stdin.
//
//   node scripts/push.mjs fcm [--port 4497] [--serial emulator-5610] [--log messages.jsonl]
//       A stand-in for FCM HTTP v1 itself, for control in `PUSH_MODE=live` (managed push, AP-29):
//       `POST /token` answers the service-account OAuth exchange, `POST /v1/projects/<p>/messages:send` delivers
//       the message's `data` (kind, ref, preview, tag, clear) to the emulator like FCM would, and appends every
//       message control sent to `--log`. Point control at it with FCM_ENDPOINT=http://127.0.0.1:<port> and a
//       service account whose token_uri is http://127.0.0.1:<port>/token (`push.mjs service-account` prints one).
//
//   node scripts/push.mjs service-account [--port 4497]
//       Prints a throwaway service-account JSON (fresh RSA key) for the stand-in.
//
// Delivery goes through the debug build's `DebugPushReceiver` (modules/whombat-live/android/src/debug),
// which calls the same handler as the FCM service.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const command = args[0];
const serial = flag('serial', process.env.ANDROID_SERIAL);
const adb = join(process.env.ANDROID_HOME || join(homedir(), 'Android/Sdk'), 'platform-tools/adb');
const PACKAGE = 'com.whombat.mobile';

/** Hands one PushPayload JSON to the app, as a foreground broadcast (FCM high priority behaves alike). */
function deliver(payloadJson) {
  JSON.parse(payloadJson); // must be JSON
  const b64 = Buffer.from(payloadJson, 'utf8').toString('base64');
  const result = spawnSync(
    adb,
    [
      ...(serial ? ['-s', serial] : []),
      'shell',
      'am',
      'broadcast',
      '-n',
      `${PACKAGE}/com.whombat.live.DebugPushReceiver`,
      '-a',
      'com.whombat.live.DEBUG_PUSH',
      '-f',
      '0x10000000',
      '--es',
      'payload64',
      b64,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`adb failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

/**
 * A managed push (control's FCM `data`: kind, opaque ref and, when present, the preview `title`/`body`, `tag` and
 * `clear`), as the FCM service would hand it to the app.
 */
function deliverGeneric(data) {
  const result = spawnSync(
    adb,
    [
      ...(serial ? ['-s', serial] : []),
      'shell',
      'am',
      'broadcast',
      '-n',
      `${PACKAGE}/com.whombat.live.DebugPushReceiver`,
      '-a',
      'com.whombat.live.DEBUG_PUSH',
      '-f',
      '0x10000000',
      '--es',
      'data64',
      Buffer.from(JSON.stringify(data)).toString('base64'),
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) throw new Error(`adb failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

function describe(payload) {
  const live = payload.liveActivity;
  return live
    ? `${live.event} ${live.display.key} · ${live.display.label} · ${live.display.text}`
    : `${payload.kind} · ${payload.title}`;
}

if (command === 'inject') {
  const source = args[1];
  if (!source) throw new Error('usage: push.mjs inject <payload.json | ->');
  const json = readFileSync(source === '-' ? 0 : source, 'utf8');
  console.log(describe(JSON.parse(json)));
  console.log(deliver(json));
} else if (command === 'relay') {
  const port = Number(flag('port', '4498'));
  // One delivery at a time, in the order the server sent them.
  let queue = Promise.resolve();
  createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const { message } = JSON.parse(body);
        const payloadJson = message?.data?.payload;
        if (!payloadJson) throw new Error('not an FCM message with a Whombat payload');
        queue = queue.then(() => {
          const at = new Date().toISOString().slice(11, 19);
          console.log(`${at} → ${message.token} · ${describe(JSON.parse(payloadJson))}`);
          deliver(payloadJson);
        });
        queue.catch((error) => console.error(String(error)));
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"name":"relayed"}');
      } catch (error) {
        res.writeHead(400).end(String(error));
      }
    });
  }).listen(port, '127.0.0.1', () => {
    console.log(`FCM relay on http://127.0.0.1:${port}/fcm → ${serial ?? 'the adb device'} (${PACKAGE})`);
  });
} else if (command === 'fcm') {
  const port = Number(flag('port', '4497'));
  const log = flag('log', null);
  let queue = Promise.resolve();
  createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const at = new Date().toISOString();
      if (req.method === 'POST' && req.url === '/token') {
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(
            JSON.stringify({ access_token: 'standin-access-token', expires_in: 3600, token_type: 'Bearer' }),
          );
        return;
      }
      if (req.method === 'POST' && /^\/v1\/projects\/[^/]+\/messages:send$/.test(req.url ?? '')) {
        try {
          const { message } = JSON.parse(body);
          if (log) appendFileSync(log, `${JSON.stringify({ at, message })}\n`);
          const { kind, ref } = message?.data ?? {};
          if (typeof kind !== 'string' || typeof ref !== 'string') throw new Error('no kind/ref in data');
          if (!String(message.token).startsWith('dev-relay:')) {
            res
              .writeHead(404)
              .end(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'UNREGISTERED' } }));
            return;
          }
          queue = queue.then(() => {
            console.log(
              `${at.slice(11, 19)} → ${message.token} · ${kind} · ${ref} · “${message.data.body ?? ''}”`,
            );
            deliverGeneric(message.data);
          });
          queue.catch((error) => console.error(String(error)));
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end('{"name":"projects/standin/messages/1"}');
        } catch (error) {
          res.writeHead(400).end(String(error));
        }
        return;
      }
      res.writeHead(404).end();
    });
  }).listen(port, '127.0.0.1', () => {
    console.log(`FCM stand-in on http://127.0.0.1:${port} → ${serial ?? 'the adb device'} (${PACKAGE})`);
  });
} else if (command === 'service-account') {
  const port = Number(flag('port', '4497'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  console.log(
    JSON.stringify({
      type: 'service_account',
      project_id: 'whombat-standin',
      client_email: 'standin@whombat-standin.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      token_uri: `http://127.0.0.1:${port}/token`,
    }),
  );
} else {
  console.log('usage: push.mjs relay [--port 4498] [--serial <emulator>] | inject <payload.json | ->');
  process.exit(command ? 1 : 0);
}
