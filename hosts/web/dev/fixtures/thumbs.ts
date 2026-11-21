// Screens wall thumbnails (SVG, like the mockup tiles) and console
// screenshots (PNG) in fixture mode. Same permission rules as a console.

import { PNG } from 'pngjs';
import type { Guest } from '../../src/api/types.ts';
import { appendAudit } from './audit.ts';
import type { Ctx } from './ctx.ts';
import { guestState } from './guests.ts';
import { type FxResponse, problem } from './http.ts';
import { remoteTarget } from './remote.ts';
import { SCREEN_LINES, TERM_COLORS, type TermColor, type TermLine, WINDOW_SCREENS, type WindowScreen } from './screens-data.ts';
import { detectOs } from './shell.ts';

const W = 320;
const H = 200;
// Mockup tile metrics (in cqw = 1 % of the tile width).
const FONT = 1.7 * 3.2;
const LINE = FONT * 1.5;
const PAD_X = 2.8 * 3.2;
const PAD_Y = 2.4 * 3.2;
const CHAR_W = FONT * 0.6;
const MAX_CHARS = Math.floor((W - 2 * PAD_X) / CHAR_W);
const MAX_ROWS = Math.floor((H - 2 * PAD_Y) / LINE);
const BG = '#06080b';
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

type Screen = { kind: 'term'; lines: TermLine[] } | { kind: 'window'; win: WindowScreen };

const isWindows = (g: Guest): boolean => /windows/i.test(g.image) || /^win/i.test(g.name);

/** Boot-to-login console for guests the mockup has no tile for. */
function generatedLines(g: Guest): TermLine[] {
  const os = detectOs(g);
  if (os === 'opnsense') return (SCREEN_LINES['opnsense-fw'] ?? []).map(([c, t]) => [c, t.replace(/opnsense-fw/g, g.name)] as const);
  if (os === 'haos') return [...(SCREEN_LINES['haos-prod'] ?? [])];
  const issue = os === 'ubuntu' ? `Ubuntu 24.04.3 LTS ${g.name} tty1` : os === 'nixos' ? `<<< Welcome to NixOS 26.05 (Yarara) (tty1) >>>` : `Debian GNU/Linux 13 ${g.name} tty1`;
  return [
    ['fg', '[  OK  ] Started systemd-journald.service - Journal Service.'],
    ['fg', '[  OK  ] Reached target network-online.target - Network is Online.'],
    ['fg', '[  OK  ] Started ssh.service - OpenBSD Secure Shell server.'],
    ['fg', '[  OK  ] Started qemu-guest-agent.service - QEMU Guest Agent.'],
    ['fg', '[  OK  ] Started getty@tty1.service - Getty on tty1.'],
    ['fg', '[  OK  ] Reached target multi-user.target - Multi-User System.'],
    ['fg', ''],
    ['fg', issue],
    ['fg', ''],
    ['fg', `${g.name} login: `],
  ];
}

function screenFor(g: Guest, frame: number): Screen {
  if (isWindows(g)) return { kind: 'window', win: WINDOW_SCREENS[g.name] ?? WINDOW_SCREENS.default! };
  let lines = [...(SCREEN_LINES[g.name] ?? generatedLines(g))];
  // Small per-refresh variation: the build in nixbuild advances.
  lines = lines.map(([c, t]) => [c, t.replace(/\[(\d+)\/(\d+)\]/, (_m, a: string, b: string) => `[${Math.min(Number(b), Number(a) + frame * 3)}/${b}]`)] as const);
  return { kind: 'term', lines };
}

/** Wrap to the tile width and keep the bottom rows (the terminal scrolls). */
function visualRows(lines: TermLine[]): TermLine[] {
  const rows: TermLine[] = [];
  for (const [c, t] of lines) {
    const chars = [...t];
    if (!chars.length) rows.push([c, '']);
    for (let i = 0; i < chars.length; i += MAX_CHARS) rows.push([c, chars.slice(i, i + MAX_CHARS).join('')]);
  }
  return rows.slice(-MAX_ROWS);
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Text content: escaped, with no-break spaces so column alignment survives (xml:space is not honored in <img>). */
const txt = (s: string): string => xml(s).replace(/ /g, '\u00a0');
const f = (n: number): string => String(Math.round(n * 100) / 100);

function textRow(color: TermColor, text: string, x: number, y: number): string {
  // systemd's "[  OK  ]" in green, like a real boot console.
  if (text.startsWith('[  OK  ]')) {
    return `<text x="${f(x)}" y="${f(y)}" fill="${TERM_COLORS[color]}">[<tspan fill="${TERM_COLORS.green}">${txt('  OK  ')}</tspan>]${txt(text.slice(8))}</text>`;
  }
  return `<text x="${f(x)}" y="${f(y)}" fill="${TERM_COLORS[color]}">${txt(text)}</text>`;
}

function terminalSvg(lines: TermLine[], frame: number): string {
  const rows = visualRows(lines);
  const parts = [`<rect width="${W}" height="${H}" fill="${BG}"/>`];
  rows.forEach(([c, t], i) => {
    if (t) parts.push(textRow(c, t, PAD_X, PAD_Y + i * LINE + LINE * 0.78));
  });
  // Blinking block cursor after the last line: on for even refreshes.
  const last = rows.length - 1;
  if (frame % 2 === 0 && last >= 0) {
    const x = PAD_X + [...(rows[last]?.[1] ?? '')].length * CHAR_W;
    parts.push(`<rect x="${f(x)}" y="${f(PAD_Y + last * LINE + LINE * 0.12)}" width="${f(CHAR_W)}" height="${f(LINE * 0.8)}" fill="${TERM_COLORS.fg}"/>`);
  }
  return parts.join('');
}

const TASKBAR_ICONS = ['#dfe3ea', '#3987e5', '#d95926', '#199e70', '#9085e9'];

function windowSvg(win: WindowScreen, frame: number, clockMs: number): string {
  const c = 3.2; // 1 cqw
  const wx = W * 0.09, wy = H * 0.09, ww = W * 0.64, wh = H * 0.66;
  const tb = 4 * c;
  const fs = 1.4 * c;
  const lh = fs * 1.6;
  const progress = Math.min(1, Math.max(0.05, win.progress + ((frame % 5) - 2) * 0.015));
  const t = new Date(clockMs + frame * 5000);
  const hhmm = `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
  const date = `${String(t.getUTCDate()).padStart(2, '0')}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${t.getUTCFullYear()}`;
  const parts = [
    `<defs><radialGradient id="desk" gradientUnits="userSpaceOnUse" cx="${W * 0.15}" cy="0" r="${W * 0.9}" gradientTransform="translate(${W * 0.15} 0) scale(1 ${f((H * 1.2) / (W * 0.9))}) translate(${-W * 0.15} 0)">`,
    `<stop offset="0" stop-color="#3b7cf0"/><stop offset="0.4" stop-color="#1f3f9c"/><stop offset="1" stop-color="#0b1233"/></radialGradient></defs>`,
    `<rect width="${W}" height="${H}" fill="url(#desk)"/>`,
    `<rect x="${f(wx)}" y="${f(wy)}" width="${f(ww)}" height="${f(wh)}" rx="${c}" fill="#1d1f25" stroke="rgba(255,255,255,0.14)" stroke-width="0.6"/>`,
    `<path d="M${f(wx)} ${f(wy + tb)}V${f(wy + c)}a${c} ${c} 0 0 1 ${c} ${-c}H${f(wx + ww - c)}a${c} ${c} 0 0 1 ${c} ${c}V${f(wy + tb)}Z" fill="#2a2d34"/>`,
    `<text x="${f(wx + 1.6 * c)}" y="${f(wy + tb * 0.68)}" fill="#dfe3ea" font-size="${f(fs)}">${txt(win.title)}</text>`,
  ];
  // CPU line varies a little per refresh.
  const lines = win.lines.map(([col, text]) => [col, text.replace(/(\d+\.\d)%/, (_m, v: string) => `${(Number(v) + ((frame * 7) % 9) / 10).toFixed(1)}%`)] as const);
  lines.forEach(([col, text], i) => {
    parts.push(`<text x="${f(wx + 2 * c)}" y="${f(wy + tb + 1.8 * c + i * lh + lh * 0.75)}" fill="${TERM_COLORS[col]}" font-size="${f(fs)}">${txt(text)}</text>`);
  });
  const by = wy + tb + 1.8 * c + lines.length * lh + 1.8 * c;
  const bw = ww - 4 * c;
  parts.push(`<rect x="${f(wx + 2 * c)}" y="${f(by)}" width="${f(bw)}" height="${f(1.1 * c)}" rx="${f(0.6 * c)}" fill="#2e323a"/>`);
  parts.push(`<rect x="${f(wx + 2 * c)}" y="${f(by)}" width="${f(bw * progress)}" height="${f(1.1 * c)}" rx="${f(0.6 * c)}" fill="#3987e5"/>`);
  const bar = 5.2 * c;
  parts.push(`<rect y="${f(H - bar)}" width="${W}" height="${f(bar)}" fill="rgba(16,18,24,0.9)"/>`);
  const icon = 2.8 * c;
  const gap = 1.3 * c;
  const x0 = (W - (TASKBAR_ICONS.length * icon + (TASKBAR_ICONS.length - 1) * gap)) / 2;
  TASKBAR_ICONS.forEach((col, i) => {
    parts.push(`<rect x="${f(x0 + i * (icon + gap))}" y="${f(H - bar + (bar - icon) / 2)}" width="${f(icon)}" height="${f(icon)}" rx="${f(0.7 * c)}" fill="${col}"/>`);
  });
  const cf = 1.2 * c;
  parts.push(`<text x="${f(W - 1.8 * c)}" y="${f(H - 0.7 * c - cf * 1.3 - cf * 0.2)}" fill="#dfe3ea" font-size="${f(cf)}" text-anchor="end">${hhmm}</text>`);
  parts.push(`<text x="${f(W - 1.8 * c)}" y="${f(H - 0.7 * c - cf * 0.2)}" fill="#dfe3ea" font-size="${f(cf)}" text-anchor="end">${date}</text>`);
  return parts.join('');
}

/** The thumbnail SVG of a running VM; `frame` counts refreshes (variation). */
export function thumbnailSvg(g: Guest, frame: number, clockMs: number): string {
  const s = screenFor(g, frame);
  const body = s.kind === 'term' ? terminalSvg(s.lines, frame) : windowSvg(s.win, frame, clockMs);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${MONO}" font-size="${f(FONT)}">` +
    `<title>${xml(g.name)}</title>${body}</svg>`
  );
}

// ---------------------------------------------------------------- PNG screenshot

type RGB = readonly [number, number, number];

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

class Raster {
  readonly png: PNG;
  constructor(readonly w: number, readonly h: number) {
    this.png = new PNG({ width: w, height: h });
  }
  /** Fill a rectangle, blending with `alpha`. */
  rect(x: number, y: number, w: number, h: number, c: RGB, alpha = 1): void {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w)), y1 = Math.min(this.h, Math.round(y + h));
    const d = this.png.data;
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const i = (yy * this.w + xx) * 4;
        d[i] = Math.round(d[i]! * (1 - alpha) + c[0] * alpha);
        d[i + 1] = Math.round(d[i + 1]! * (1 - alpha) + c[1] * alpha);
        d[i + 2] = Math.round(d[i + 2]! * (1 - alpha) + c[2] * alpha);
        d[i + 3] = 255;
      }
    }
  }
  /** Text as blocks: one bar per non-blank character. */
  text(s: string, x: number, y: number, charW: number, lineH: number, c: RGB): void {
    [...s].forEach((ch, i) => {
      if (ch.trim()) this.rect(x + i * charW + charW * 0.12, y + lineH * 0.28, charW * 0.76, lineH * 0.5, c);
    });
  }
}

/** A 1024x640 PNG that looks like the guest's screen (blocks instead of glyphs). */
export function screenshotPng(g: Guest, clockMs: number): Buffer {
  const S = 3.2; // 320 -> 1024
  const r = new Raster(1024, 640);
  const s = screenFor(g, 0);
  if (s.kind === 'term') {
    r.rect(0, 0, r.w, r.h, hex(BG));
    visualRows(s.lines).forEach(([c, t], i) => r.text(t, PAD_X * S, (PAD_Y + i * LINE) * S, CHAR_W * S, LINE * S, hex(TERM_COLORS[c])));
  } else {
    // Desktop: the mockup's radial gradient, a window, a taskbar.
    const stops: [number, RGB][] = [[0, hex('#3b7cf0')], [0.4, hex('#1f3f9c')], [1, hex('#0b1233')]];
    const d = r.png.data;
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const t = Math.min(1, Math.hypot((x - r.w * 0.15) / (r.w * 0.9), y / (r.h * 1.2)));
        const k = t < 0.4 ? 0 : 1;
        const [a, ca] = stops[k]!;
        const [b, cb] = stops[k + 1]!;
        const u = (t - a) / (b - a);
        const i = (y * r.w + x) * 4;
        for (let ch = 0; ch < 3; ch++) d[i + ch] = Math.round(ca[ch]! + (cb[ch]! - ca[ch]!) * u);
        d[i + 3] = 255;
      }
    }
    const c = 3.2 * S;
    const wx = r.w * 0.09, wy = r.h * 0.09, ww = r.w * 0.64, wh = r.h * 0.66;
    r.rect(wx, wy, ww, wh, hex('#1d1f25'));
    r.rect(wx, wy, ww, 4 * c, hex('#2a2d34'));
    r.text(s.win.title, wx + 1.6 * c, wy, 1.4 * c * 0.6, 4 * c, hex('#dfe3ea'));
    const lh = 1.4 * c * 1.6;
    s.win.lines.forEach(([col, text], i) => r.text(text, wx + 2 * c, wy + 4 * c + 1.8 * c + i * lh, 1.4 * c * 0.6, lh, hex(TERM_COLORS[col])));
    const by = wy + 4 * c + 3.6 * c + s.win.lines.length * lh;
    r.rect(wx + 2 * c, by, ww - 4 * c, 1.1 * c, hex('#2e323a'));
    r.rect(wx + 2 * c, by, (ww - 4 * c) * s.win.progress, 1.1 * c, hex('#3987e5'));
    const bar = 5.2 * c;
    r.rect(0, r.h - bar, r.w, bar, hex('#101218'), 0.9);
    const icon = 2.8 * c, gap = 1.3 * c;
    const x0 = (r.w - (5 * icon + 4 * gap)) / 2;
    TASKBAR_ICONS.forEach((col, i) => r.rect(x0 + i * (icon + gap), r.h - bar + (bar - icon) / 2, icon, icon, hex(col)));
    const t = new Date(clockMs);
    r.text(`${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`, r.w - 1.8 * c - 5 * 1.2 * c * 0.6, r.h - bar, 1.2 * c * 0.6, bar / 2, hex('#dfe3ea'));
  }
  return PNG.sync.write(r.png);
}

// ---------------------------------------------------------------- endpoints

const SCREENS_AUDIT_MS = 10 * 60_000;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** Checks shared by thumbnail and screenshot; returns the guest or an error response. */
function screenTarget(c: Ctx, serverId: string, guestId: string, onDeny: (code: string) => void): Guest | FxResponse {
  const t = remoteTarget(c, serverId, guestId, 'console');
  if ('code' in t) {
    onDeny(t.code);
    return problem(t.status, t.code, t.detail);
  }
  if (t.guest.kind !== 'vm') return problem(404, 'no_screen', 'Containers have no screen; show the terminal placeholder.');
  if (guestState(c.st, serverId, t.guest) === 'stopped') return problem(409, 'guest_not_running', 'The guest is powered off.');
  return t.guest;
}

const isResponse = (v: Guest | FxResponse): v is FxResponse => 'status' in v;

/** GET /servers/{id}/guests/{guestId}/thumbnail */
export function thumbnail(c: Ctx, serverId: string, guestId: string): FxResponse {
  const { store, st, req } = c;
  const throttled = (key: string): boolean => {
    const last = st.screensAudited.get(key);
    if (last !== undefined && store.now() - last < SCREENS_AUDIT_MS) return true;
    st.screensAudited.set(key, store.now());
    return false;
  };
  const g = screenTarget(c, serverId, guestId, (code) => {
    if (!throttled(`denied|${serverId}|${code}`)) {
      appendAudit(store, st, { event: 'screens.viewed', outcome: 'denied', code, server: serverId, guest: guestId }, req);
    }
  });
  if (isResponse(g)) return g;
  // screens.viewed: once per server per 10 minutes, not per thumbnail.
  if (!throttled(serverId)) appendAudit(store, st, { event: 'screens.viewed', server: serverId }, req);
  const key = `${serverId}|${guestId}`;
  const frame = st.thumbFrames.get(key) ?? 0;
  st.thumbFrames.set(key, frame + 1);
  return {
    status: 200,
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' },
    body: thumbnailSvg(g, frame, store.fxNow()),
  };
}

/** GET /servers/{id}/guests/{guestId}/screenshot */
export function screenshot(c: Ctx, serverId: string, guestId: string): FxResponse {
  const { store, st, req } = c;
  const g = screenTarget(c, serverId, guestId, (code) => {
    appendAudit(store, st, { event: 'console.screenshot', outcome: 'denied', code, server: serverId, guest: guestId }, req);
  });
  if (isResponse(g)) return g;
  appendAudit(store, st, { event: 'console.screenshot', server: serverId, guest: guestId, platform: g.platform }, req);
  return {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${slug(g.name)}-${stamp(store.fxNow())}.png"`,
    },
    body: screenshotPng(g, store.fxNow()),
  };
}
