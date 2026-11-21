/**
 * The phone passkey device test's box side (DEV only, off unless switched on): it lets the device tests see who reads
 * the box's well-known files, turn `assetlinks.json` off to measure how long Google keeps it, and make and use a
 * passkey for this box's own host in a browser or the iPhone's sign-in sheet.
 *
 * The switch is one file, `$WHOMBAT_HOME/own-address-device-test`, read once at start. Its first word is `on` (log
 * the well-known requests, serve the test page) or `assetlinks-off` (the same, and `assetlinks.json` answers 404). It
 * is refused on a prod runtime (`WHOMBAT_ENV=prod`), it does nothing at an address outside the DEV zone, and it stops
 * by itself a week after the file was written, so a forgotten switch can't stay on.
 *
 * The page never shows or sends a PRF output: only the first 8 hex digits of its SHA-256, to compare two prompts.
 */
import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { OWN_ADDRESS_ZONES } from '@whombat/protocol/own-address';
import type { Logger } from '../../services';
import { CACHE_NONE, DIRECT_HEADERS, sendText } from '../direct/web';
import { OWN_ADDRESS_POLICY } from './server';

export const DEVICE_TEST_FILE = 'own-address-device-test';
/** How long the switch holds after the file was written. */
export const DEVICE_TEST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEVICE_TEST_PAGE = '/device-test/passkey';
const ASSET_LINKS_PATH = '/.well-known/assetlinks.json';

/** The PRF salt the page and the app's test screen both evaluate, so their digests can be compared. */
export const DEVICE_TEST_PRF_SALT_HEX = '64ef0e05b79d948aa717560015ce6f6661b0cb63ab321f939d367c208c5d8e82';

export interface DeviceTest {
  /** False: `assetlinks.json` answers 404. */
  readonly assetLinks: boolean;
  /** When the switch was written; it stops `DEVICE_TEST_MAX_AGE_MS` later. */
  readonly since: Date;
}

/** The switch as the file has it at start; null when it is off, refused or unreadable (said in the log). */
export function readDeviceTest(input: {
  home: string;
  env: Record<string, string | undefined>;
  log: Logger;
  now?: () => Date;
}): DeviceTest | null {
  const file = join(input.home, DEVICE_TEST_FILE);
  let text: string;
  let since: Date;
  try {
    since = statSync(file).mtime;
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  if (input.env.WHOMBAT_ENV?.trim() === 'prod') {
    input.log.warn({ file }, 'own address device test: refused on a prod box');
    return null;
  }
  const now = (input.now ?? (() => new Date()))();
  if (now.getTime() - since.getTime() > DEVICE_TEST_MAX_AGE_MS) {
    input.log.warn(
      { file, since },
      'own address device test: the switch is older than a week, so it stays off',
    );
    return null;
  }
  const word = text.trim().split(/\s+/)[0] ?? '';
  if (word !== 'on' && word !== 'assetlinks-off') {
    input.log.warn({ file, word }, 'own address device test: unknown switch word, so it stays off');
    return null;
  }
  const test: DeviceTest = { assetLinks: word === 'on', since };
  input.log.warn(
    { assetLinks: test.assetLinks, until: new Date(since.getTime() + DEVICE_TEST_MAX_AGE_MS) },
    'own address device test: on',
  );
  return test;
}

function isDevAddress(host: string | null): boolean {
  return Boolean(host?.endsWith(`.${OWN_ADDRESS_ZONES.dev}`));
}

function send(req: IncomingMessage, res: ServerResponse, type: string, body: string): void {
  res.writeHead(200, {
    ...DIRECT_HEADERS,
    'content-security-policy': OWN_ADDRESS_POLICY,
    'content-type': type,
    'cache-control': CACHE_NONE,
    'content-length': String(Buffer.byteLength(body)),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/**
 * The test's answers on the own address, ahead of the address's own: false for everything it leaves alone. Inactive
 * (always false) at an address outside the DEV zone and once the switch is a week old.
 */
export function deviceTestRoutes(
  test: DeviceTest,
  host: () => string | null,
  log: Logger,
  now: () => Date = () => new Date(),
): (req: IncomingMessage, res: ServerResponse, path: string) => boolean {
  let refusedSaid = false;
  return (req, res, path) => {
    if (now().getTime() - test.since.getTime() > DEVICE_TEST_MAX_AGE_MS) return false;
    if (!isDevAddress(host())) {
      if (!refusedSaid)
        log.warn({ host: host() }, 'own address device test: not a DEV address, so it stays off');
      refusedSaid = true;
      return false;
    }
    if (path.startsWith('/.well-known/')) {
      const off = !test.assetLinks && path === ASSET_LINKS_PATH;
      const agent = req.headers['user-agent'];
      log.info(
        {
          path,
          method: req.method,
          src: req.socket?.remoteAddress ?? null,
          userAgent: typeof agent === 'string' ? agent.slice(0, 300) : null,
          answer: off ? 404 : 'usual',
        },
        'own address device test: a well-known request',
      );
      if (off) {
        sendText(res, 404, 'Not found.');
        return true;
      }
      return false;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    if (path === DEVICE_TEST_PAGE) send(req, res, 'text/html; charset=utf-8', PAGE_HTML);
    else if (path === `${DEVICE_TEST_PAGE}.js`) send(req, res, 'text/javascript; charset=utf-8', PAGE_JS);
    else if (path === `${DEVICE_TEST_PAGE}.css`) send(req, res, 'text/css; charset=utf-8', PAGE_CSS);
    else return false;
    return true;
  };
}

/* The page ------------------------------------------------------------------------------------------------------- */

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Box passkey test</title>
<link rel="stylesheet" href="${DEVICE_TEST_PAGE}.css">
</head>
<body>
<main>
<h1>Box passkey test</h1>
<p id="host"></p>
<p>Only continue if you started this in your Whombat app, or were asked to test.</p>
<div class="row">
<button id="create" type="button">Create</button>
<button id="use" type="button">Use</button>
</div>
<dl id="out"></dl>
<p id="back" hidden><a id="back-link" href="${DEVICE_TEST_PAGE}">Back to the app</a></p>
</main>
<script src="${DEVICE_TEST_PAGE}.js"></script>
</body>
</html>
`;

const PAGE_CSS = `:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; background: Canvas; color: CanvasText; }
main { max-width: 32rem; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.4rem; }
.row { display: flex; gap: 12px; margin: 16px 0; }
button { min-height: 44px; min-width: 120px; font-size: 1rem; border-radius: 10px; }
button.wanted { font-weight: 700; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; word-break: break-all; }
dt { font-weight: 600; }
dd { margin: 0; font-family: ui-monospace, monospace; }
a { min-height: 44px; display: inline-flex; align-items: center; }
`;

// Plain script, no template strings, so it sits in this module as text. The fragment may carry
// `mode=create|use`, `return=1` (send the result to the app's sheet callback) and `opts=<base64url JSON>`: the box's
// registration options the app fetched over its session ({rpId, user, challenge, exclude}).
const PAGE_JS = `(function () {
  'use strict';
  var SALT_HEX = '${DEVICE_TEST_PRF_SALT_HEX}';
  var host = location.hostname;
  var params = new URLSearchParams(location.hash.slice(1));
  var wantReturn = params.get('return') === '1';
  var mode = params.get('mode');
  var opts = null;
  var $ = function (id) { return document.getElementById(id); };

  function b64url(buf) {
    var bytes = new Uint8Array(buf);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).split('+').join('-').split('/').join('_').split('=').join('');
  }
  function fromB64url(text) {
    var s = text.split('-').join('+').split('_').join('/');
    while (s.length % 4) s += '=';
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function hex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }
  function fromHex(h) {
    var out = new Uint8Array(h.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  }
  function random(n) {
    var b = new Uint8Array(n);
    crypto.getRandomValues(b);
    return b;
  }
  function digest8(buf) {
    return crypto.subtle.digest('SHA-256', buf).then(function (d) { return hex(new Uint8Array(d)).slice(0, 8); });
  }
  function originOf(cred) {
    try { return JSON.parse(new TextDecoder().decode(cred.response.clientDataJSON)).origin; } catch (e) { return '?'; }
  }
  function prfOf(cred) {
    var ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : {};
    var prf = ext && ext.prf;
    if (prf && prf.results && prf.results.first) return digest8(prf.results.first);
    return Promise.resolve(prf && prf.enabled ? 'enabled, no output here' : 'none');
  }

  try {
    if (params.get('opts')) opts = JSON.parse(new TextDecoder().decode(fromB64url(params.get('opts'))));
  } catch (e) {
    opts = null;
  }

  function show(r) {
    var out = $('out');
    out.textContent = '';
    var rows = [['Result', r.code], ['RP ID', r.rpId], ['Origin', r.origin || '-'], ['PRF', r.prf || '-'],
      ['Passkey', r.credential || '-']];
    if (r.message) rows.push(['Message', r.message]);
    rows.forEach(function (row) {
      var dt = document.createElement('dt');
      dt.textContent = row[0];
      var dd = document.createElement('dd');
      dd.textContent = row[1];
      out.appendChild(dt);
      out.appendChild(dd);
    });
  }
  function finish(r) {
    show(r);
    if (!wantReturn) return;
    var url = 'whombat://box-passkey-test#r=' + b64url(new TextEncoder().encode(JSON.stringify(r)));
    $('back-link').href = url;
    $('back').hidden = false;
    location.href = url;
  }
  function failed(r, e) {
    r.code = e && e.name ? e.name : 'failed';
    r.message = e && e.message ? String(e.message).slice(0, 200) : '';
    finish(r);
  }

  function create() {
    var given = opts && opts.challenge ? opts : null;
    var pk = {
      rp: { id: given ? given.rpId : host, name: 'Whombat' },
      user: given
        ? { id: fromB64url(given.user.id), name: given.user.name, displayName: given.user.displayName }
        : { id: random(32), name: 'Box passkey test', displayName: host + ' \\u00b7 test' },
      challenge: given ? fromB64url(given.challenge) : random(32),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      excludeCredentials: ((given && given.exclude) || []).map(function (id) {
        return { type: 'public-key', id: fromB64url(id) };
      }),
      timeout: 120000,
      extensions: { prf: { eval: { first: fromHex(SALT_HEX) } } },
    };
    var r = { mode: 'create', rpId: pk.rp.id };
    navigator.credentials.create({ publicKey: pk }).then(function (cred) {
      r.code = 'ok';
      r.origin = originOf(cred);
      r.credential = b64url(cred.rawId).slice(0, 8);
      if (given) {
        // Public parts only, for the box's own check (boxPasskey.register); never the PRF output.
        r.registration = {
          id: cred.id,
          rawId: b64url(cred.rawId),
          type: cred.type,
          response: {
            clientDataJSON: b64url(cred.response.clientDataJSON),
            attestationObject: b64url(cred.response.attestationObject),
            transports: cred.response.getTransports ? cred.response.getTransports() : [],
          },
          clientExtensionResults: {},
        };
      }
      return prfOf(cred).then(function (p) { r.prf = p; finish(r); });
    }).catch(function (e) { failed(r, e); });
  }

  function use() {
    var pk = {
      rpId: host,
      challenge: random(32),
      userVerification: 'required',
      timeout: 120000,
      extensions: { prf: { eval: { first: fromHex(SALT_HEX) } } },
    };
    var r = { mode: 'use', rpId: host };
    navigator.credentials.get({ publicKey: pk }).then(function (cred) {
      r.code = 'ok';
      r.origin = originOf(cred);
      r.credential = b64url(cred.rawId).slice(0, 8);
      return prfOf(cred).then(function (p) { r.prf = p; finish(r); });
    }).catch(function (e) { failed(r, e); });
  }

  $('host').textContent = host;
  $('create').addEventListener('click', create);
  $('use').addEventListener('click', use);
  if (mode === 'create') $('create').className = 'wanted';
  if (mode === 'use') $('use').className = 'wanted';
})();
`;
