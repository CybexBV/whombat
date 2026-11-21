/**
 * Rich messages for fixture mode (`VITE_FIXTURE_RICH=1`, or `rich: true` in `createWebFixtureFetch`; AP-329). The shared
 * fixture world (`@whombat/fixtures`) has no HTML pages, so the mock's screens stay as drawn; this layer adds, only when
 * asked for, the agent's test messages of assignment item 8 in PR #482's branch room (the room with people's messages
 * that stays with one agent, one-agent.md OA-04):
 *
 * - a logo page as a fenced `html` block (inline SVG, `<style>`, a Google Fonts `<link>`, a small script animating it);
 * - the same page as an `.html` attachment;
 * - a heading, a table with alignment and a task list; a Mermaid diagram; highlighted code with a nested quote;
 * - three swatches (a gallery), a PDF brand sheet and a short chime (audio);
 * - a chart drawn with the page theme's variables, so it follows light and dark (visual-replies.md);
 * - a page set of invoice mockups (docs/decisions/page-sets.md): two linked pages, a stylesheet, pictures, a notes file
 *   and a link out, with the cover the Whombat makes of its first page.
 *
 * Attachment bytes are `blob:` URLs made in the page (fixture mode loads attachments by URL).
 */
import {
  type Attachment,
  attachmentThumbnailUrl,
  type Message,
  PAGES_CONTENT_TYPE,
  PAGES_MANIFEST,
  type PageSetManifest,
  zipStored,
} from '@whombat/core';
import { burrow, encodePng } from '@whombat/fixtures';
import { WHOMBAT_ID } from './oneFixtures';

const API_BASE = '/api/v1';
/** The seed clock is 11:22 in Amsterdam on Wednesday 23 September 2026 (UTC+2). */
const T = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 8, 23, (h ?? 0) - 2, m ?? 0)).toISOString();
};

/** The branch room the rich messages are in. */
export const RICH_ROOM = 'cnv_pr482';

/** The logo page the agent sends (a representative of the page on production, assignment item 8). */
export const LOGO_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Burrow Billing — logo</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&display=swap">
<style>
  body { margin: 0; background: #f6f1ea; color: #2b221d; font-family: 'Fraunces', Georgia, serif; }
  .stage { display: flex; align-items: center; justify-content: center; gap: 28px; padding: 48px 32px; }
  .mark { width: 128px; height: 128px; flex: none; }
  h1 { margin: 0; font-size: 44px; font-weight: 600; letter-spacing: -0.02em; }
  p { margin: 8px 0 0; color: #7d6353; font: 15px/1.4 system-ui, sans-serif; }
  .swatches { display: flex; gap: 8px; justify-content: center; padding: 0 0 36px; }
  .swatches span { width: 44px; height: 44px; border-radius: 10px; }
</style>
</head>
<body>
  <div class="stage">
    <svg class="mark" viewBox="0 0 120 120" role="img" aria-label="Burrow Billing mark">
      <circle cx="60" cy="60" r="56" fill="#2b221d"/>
      <path d="M26 84 Q60 26 94 84 Z" fill="#dcc6ab"/>
      <circle id="coin" cx="60" cy="58" r="10" fill="#e0b75e"/>
    </svg>
    <div>
      <h1>Burrow Billing</h1>
      <p id="tagline">Invoices that dig themselves out.</p>
    </div>
  </div>
  <div class="swatches">
    <span style="background:#2b221d"></span><span style="background:#7d6353"></span>
    <span style="background:#dcc6ab"></span><span style="background:#e0b75e"></span>
    <span style="background:#f6f1ea; box-shadow: inset 0 0 0 1px #0002"></span>
  </div>
  <script>
    const coin = document.getElementById('coin');
    let t = 0;
    (function bounce() {
      t += 0.05;
      coin.setAttribute('cy', String(58 - Math.abs(Math.sin(t)) * 14));
      requestAnimationFrame(bounce);
    })();
  </script>
</body>
</html>`;

const MERMAID = `flowchart LR
  brief[Brief from Mara] --> sketch[Three sketches]
  toffee --> review{Approved?}
  review -- yes --> files[Logo files + page]
  review -- no --> sketch
  files --> ship[In the brand folder]`;

/** A 480×360 swatch with a label: the agent's pictures, Files' screenshots (AP-779). */
export const swatchSvg = (fill: string, label: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"><rect width="480" height="360" fill="${fill}"/><text x="24" y="336" font-family="sans-serif" font-size="22" fill="#fff8">${label}</text></svg>`;

/** A one-page PDF (Helvetica, a heading and five swatches), with a correct cross-reference table. */
export function brandSheetPdf(): Uint8Array {
  const colors = ['0.17 0.13 0.11', '0.49 0.39 0.33', '0.86 0.78 0.67', '0.88 0.72 0.37', '0.96 0.95 0.92'];
  const content = [
    'BT /F1 30 Tf 64 760 Td (Burrow Billing) Tj ET',
    'BT /F1 13 Tf 64 736 Td (Brand sheet \\267 logo, colours, type) Tj ET',
    ...colors.map((c, i) => `${c} rg ${64 + i * 92} 600 80 80 re f`),
    '0 g BT /F1 11 Tf 64 570 Td (Burrow ink   Cocoa   Cream   Coin   Paper) Tj ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** A short two-note chime: 8-bit mono WAV at 8 kHz. */
function chimeWav(): Uint8Array {
  const rate = 8000;
  const samples = Math.round(rate * 0.7);
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[at + i] = s.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  text(36, 'data');
  view.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const f = t < 0.3 ? 660 : 880;
    const env = Math.exp(-((t < 0.3 ? t : t - 0.3) * 6));
    bytes[44 + i] = Math.round(128 + 90 * env * Math.sin(2 * Math.PI * f * t));
  }
  return bytes;
}

/** An object URL in the browser; under jsdom, which can't make one, the attachment's API path (nothing loads it). */
function blobUrl(id: string, bytes: Uint8Array, contentType: string): string {
  try {
    return URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType }));
  } catch {
    return `${API_BASE}/burrows/${burrow.slug}/attachments/${id}`;
  }
}

/** An attachment whose bytes are a `blob:` URL made in the page. */
export function fixtureAttachment(
  id: string,
  name: string,
  contentType: string,
  kind: Attachment['kind'],
  data: Uint8Array | string,
  size?: { width: number; height: number },
): Attachment {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return {
    id,
    name,
    contentType,
    size: bytes.byteLength,
    url: blobUrl(id, bytes, contentType),
    kind,
    width: size?.width ?? null,
    height: size?.height ?? null,
  };
}

function message(id: string, hhmm: string, text: string, attachments: Attachment[] = []): Message {
  return {
    id,
    conversationId: RICH_ROOM,
    authorId: WHOMBAT_ID,
    createdAt: T(hhmm),
    editedAt: null,
    text,
    mentions: [],
    reactions: [],
    attachments,
    threadRootId: null,
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
    card: null,
    suggestions: [],
    more: null,
  } as Message;
}

/** A chart the way agents are asked to draw one: the theme's variables, no background of its own (VR-03). */
export const CHART_PAGE = `<title>Invoices paid</title>
<style>
  .row { display: grid; grid-template-columns: 72px 1fr 48px; align-items: center; gap: 10px; margin: 8px 0; }
  .bar { height: 22px; border-radius: 6px; background: var(--chart-1); }
  .label, .value { color: var(--muted-foreground); font-size: 13px; }
  .value { text-align: right; font-family: var(--font-mono); }
  h3 { margin: 0 0 12px; font-size: 15px; }
</style>
<h3>Invoices paid per month</h3>
<div class="row"><span class="label">July</span><div class="bar" style="width: 48%"></div><span class="value">24</span></div>
<div class="row"><span class="label">August</span><div class="bar" style="width: 62%; background: var(--chart-2)"></div><span class="value">31</span></div>
<div class="row"><span class="label">September</span><div class="bar" style="width: 88%; background: var(--chart-3)"></div><span class="value">44</span></div>`;

/* A page set ------------------------------------------------------------------------------------------ */

const SET_STYLE = `:root { color-scheme: light; --ink: #2b221d; --cocoa: #7d6353; --cream: #f6f1ea; --coin: #e0b75e; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--cream); color: var(--ink); font: 16px/1.55 Georgia, 'Times New Roman', serif; }
header { display: flex; align-items: center; justify-content: space-between; padding: 18px 48px; background: var(--ink); color: var(--cream); }
.brand { font-weight: 700; letter-spacing: 0.02em; }
nav a { margin-left: 22px; color: #dcc6ab; font: 14px/1 system-ui, sans-serif; text-decoration: none; }
nav a[aria-current] { color: var(--coin); }
main { max-width: 880px; margin: 0 auto; padding: 40px 48px 64px; }
h1 { margin: 0 0 8px; font-size: 36px; letter-spacing: -0.01em; }
.lede { margin: 0 0 28px; color: var(--cocoa); font: 17px/1.5 system-ui, sans-serif; }
.shots { display: grid; grid-template-columns: repeat(2, 1fr); gap: 24px; margin: 0 0 28px; }
figure { margin: 0; }
figure img { display: block; width: 100%; border-radius: 12px; box-shadow: 0 1px 0 #0001, 0 8px 24px #2b221d1f; }
figcaption { margin-top: 10px; color: var(--cocoa); font: 14px/1.4 system-ui, sans-serif; }
.next { display: inline-block; padding: 10px 16px; border-radius: 10px; background: var(--ink); color: var(--cream); font: 600 14px/1 system-ui, sans-serif; text-decoration: none; }
.small { margin-top: 28px; color: var(--cocoa); font: 13px/1.5 system-ui, sans-serif; }
.small a { color: var(--ink); }`;

/** A mocked invoice: the coin marks it paid (`paid`) or the amount due. */
const invoiceSvg = (paid: boolean, accent: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300"><rect width="400" height="300" fill="#fff"/><rect x="28" y="28" width="120" height="14" rx="4" fill="#2b221d"/><rect x="28" y="52" width="80" height="8" rx="3" fill="#cdbba6"/><circle cx="348" cy="50" r="22" fill="${accent}"/>${paid ? '<path d="M337 50l8 8 15-16" stroke="#2b221d" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' : ''}<g fill="#e7dccd"><rect x="28" y="104" width="344" height="10" rx="3"/><rect x="28" y="130" width="344" height="10" rx="3"/><rect x="28" y="156" width="344" height="10" rx="3"/></g><g fill="#7d6353"><rect x="300" y="104" width="72" height="10" rx="3"/><rect x="300" y="130" width="72" height="10" rx="3"/><rect x="300" y="156" width="72" height="10" rx="3"/></g><rect x="220" y="214" width="152" height="40" rx="10" fill="${paid ? '#e8f1e4' : '#f8ead0'}"/><rect x="236" y="229" width="120" height="10" rx="3" fill="#2b221d"/></svg>`;

const page = (title: string, current: 1 | 2, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<header><span class="brand">Burrow Billing</span><nav><a href="index.html"${current === 1 ? ' aria-current="page"' : ''}>Round 1</a><a href="round-2.html"${current === 2 ? ' aria-current="page"' : ''}>Round 2</a></nav></header>
<main>
${body}
</main>
</body>
</html>`;

const SET_PAGES = {
  'index.html': page(
    'Round 1 · Paid or due',
    1,
    `<h1>Invoices, round 1</h1>
<p class="lede">Two ways to show whether an invoice is paid. The coin from the logo does the talking.</p>
<div class="shots">
<figure><img src="shots/paid.svg" alt="A paid invoice with a gold coin and a tick"><figcaption>A · Paid: the coin with a tick, a green total.</figcaption></figure>
<figure><img src="shots/due.svg" alt="An invoice that is due, with a cocoa coin"><figcaption>B · Due: the coin in cocoa, the total on cream.</figcaption></figure>
</div>
<a class="next" href="round-2.html">See round 2 →</a>
<p class="small">The colours are in <a href="brand-notes.txt">brand-notes.txt</a>. The headline font is <a href="https://fonts.google.com/specimen/Fraunces">Fraunces</a>.</p>`,
  ),
  'round-2.html': page(
    'Round 2 · The coin alone',
    2,
    `<h1>Invoices, round 2</h1>
<p class="lede">Mara liked A. This round keeps the coin and drops the coloured total.</p>
<div class="shots">
<figure><img src="shots/paid.svg" alt="A paid invoice with a gold coin and a tick"><figcaption>A · As in round 1.</figcaption></figure>
<figure><img src="shots/coin-only.svg" alt="A paid invoice with only the coin"><figcaption>A2 · The coin alone.</figcaption></figure>
</div>
<a class="next" href="index.html">← Back to round 1</a>`,
  ),
  'style.css': SET_STYLE,
  'shots/paid.svg': invoiceSvg(true, '#e0b75e'),
  'shots/due.svg': invoiceSvg(false, '#7d6353'),
  'shots/coin-only.svg': invoiceSvg(true, '#e0b75e').replace(/fill="#e8f1e4"/, 'fill="#fff"'),
  'brand-notes.txt': 'Burrow ink #2b221d · Cocoa #7d6353 · Cream #f6f1ea · Coin #e0b75e\n',
};

type Rgb = readonly [number, number, number];

/**
 * The cover the Whombat makes of a set's first page (its 1280 × 800 picture at 720 × 450), drawn here by hand: the
 * header, the heading and its line, the two invoices with their coins, the button.
 */
function setCover(): Uint8Array {
  const width = 720;
  const height = 450;
  const rgb = new Uint8Array(width * height * 3);
  const rect = (x: number, y: number, w: number, h: number, c: Rgb) => {
    for (let j = Math.max(0, y); j < Math.min(height, y + h); j++)
      for (let i = Math.max(0, x); i < Math.min(width, x + w); i++) rgb.set(c, (j * width + i) * 3);
  };
  const disc = (cx: number, cy: number, r: number, c: Rgb) => {
    for (let j = -r; j <= r; j++)
      for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r) rect(cx + i, cy + j, 1, 1, c);
  };
  const ink: Rgb = [43, 34, 29];
  const cocoa: Rgb = [125, 99, 83];
  const cream: Rgb = [246, 241, 234];
  const sand: Rgb = [220, 198, 171];
  const coin: Rgb = [224, 183, 94];
  const white: Rgb = [255, 255, 255];
  const line: Rgb = [231, 220, 205];
  const shadow: Rgb = [232, 224, 213];
  rect(0, 0, width, height, cream);
  rect(0, 0, width, 34, ink);
  rect(27, 13, 72, 8, cream);
  rect(594, 14, 40, 6, coin);
  rect(646, 14, 40, 6, sand);
  rect(140, 66, 196, 18, ink);
  rect(140, 96, 380, 7, cocoa);
  const invoice = (x: number, paid: boolean) => {
    rect(x + 2, 124, 216, 164, shadow);
    rect(x, 122, 216, 162, white);
    rect(x + 16, 138, 66, 8, ink);
    rect(x + 16, 152, 44, 5, sand);
    disc(x + 190, 150, 12, paid ? coin : cocoa);
    for (let k = 0; k < 3; k++) {
      rect(x + 16, 180 + k * 15, 186, 6, line);
      rect(x + 162, 180 + k * 15, 40, 6, cocoa);
    }
    rect(x + 118, 242, 84, 24, paid ? [232, 241, 228] : [248, 234, 208]);
    rect(x + 128, 251, 64, 6, ink);
  };
  invoice(140, true);
  invoice(366, false);
  rect(140, 300, 150, 6, cocoa);
  rect(366, 300, 160, 6, cocoa);
  rect(140, 328, 84, 22, ink);
  rect(150, 337, 64, 5, cream);
  return encodePng(width, height, rgb);
}

/** The set's file: the folder's files stored in a ZIP, with Whombat's manifest. */
export function invoiceMockupsSet(): Uint8Array {
  const encode = (text: string) => new TextEncoder().encode(text);
  const files = Object.entries(SET_PAGES).map(([path, text]) => ({ path, bytes: encode(text) }));
  const manifest: PageSetManifest = {
    v: 1,
    title: 'Invoice mockups',
    open: 'index.html',
    files: files.length,
    pages: 2,
    cover: false,
    problems: [],
  };
  const parts = zipStored(
    [...files, { path: PAGES_MANIFEST, bytes: encode(JSON.stringify(manifest)) }],
    new Date(T('11:14')),
  );
  const zip = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    zip.set(p, at);
    at += p.length;
  }
  return zip;
}

/** The set as a file of its message, served at its API path (fixture mode reads files through the session). */
const SET_ID = 'att_rich-mockups';
const SET_URL = `${API_BASE}/burrows/${burrow.slug}/attachments/${SET_ID}`;

let setBytes: Uint8Array | null = null;
let coverBytes: Uint8Array | null = null;
const setFile = () => (setBytes ??= invoiceMockupsSet());
const coverFile = () => (coverBytes ??= setCover());

function pageSetAttachment(): Attachment {
  return {
    id: SET_ID,
    name: 'Invoice mockups.zip',
    contentType: PAGES_CONTENT_TYPE,
    size: setFile().byteLength,
    url: SET_URL,
    kind: 'file',
    width: null,
    height: null,
    thumbnailUrl: attachmentThumbnailUrl(burrow.slug, SET_ID),
    thumbnailWidth: 720,
    thumbnailHeight: 450,
  };
}

/** The agent's rich messages (built in the page: attachments are object URLs). */
export function richMessages(): Message[] {
  return [
    message(
      'msg_pr482-rich-1101',
      '11:01',
      `Here’s the logo page for **Burrow Billing**. Open it full screen to see the coin bounce:\n\n\`\`\`html\n${LOGO_PAGE}\n\`\`\``,
    ),
    message('msg_pr482-rich-1102', '11:02', 'The same page as a file, for the brand folder.', [
      fixtureAttachment('att_rich-logo-html', 'burrow-billing-logo.html', 'text/html', 'text', LOGO_PAGE),
    ]),
    message(
      'msg_pr482-rich-1104',
      '11:04',
      [
        '## Logo checklist',
        '',
        '| Variant | Use | Size | Status |',
        '|:--|:--|--:|:-:|',
        '| Mark on paper | Invoices, letters | 128 px | ✓ |',
        '| Mark on night | Dark mode, the app icon | 128 px | ✓ |',
        '| Favicon | Browser tabs | 16 px | — |',
        '| Wordmark | Website header, `og:image` | 1200 px | ✓ |',
        '',
        '- [x] Mark on paper and on night',
        '- [x] Colours checked for contrast',
        '- [ ] Favicon at 16 px',
        '  - [ ] Try the coin without the arch',
        '- [ ] Hand the files to @Dusty for the style guide',
      ].join('\n'),
    ),
    message('msg_pr482-rich-1106', '11:06', `### How we got here\n\n\`\`\`mermaid\n${MERMAID}\n\`\`\``),
    message(
      'msg_pr482-rich-1108',
      '11:08',
      [
        'The colours as CSS variables:',
        '',
        '```css',
        ':root {',
        '  --burrow-ink: #2b221d; /* the mark */',
        '  --cocoa: #7d6353;',
        '  --coin: #e0b75e;',
        '}',
        '',
        '.logo:hover .coin {',
        '  transform: translateY(-4px);',
        '}',
        '```',
        '',
        '> Mara asked for something warmer.',
        '> > Warmer than the old blue, but still readable on paper.',
      ].join('\n'),
    ),
    message('msg_pr482-rich-1110', '11:10', 'Swatches, the brand sheet and the invoice-paid chime:', [
      fixtureAttachment(
        'att_rich-ink',
        'burrow-ink.svg',
        'image/svg+xml',
        'file',
        swatchSvg('#2b221d', 'Burrow ink'),
        {
          width: 480,
          height: 360,
        },
      ),
      fixtureAttachment(
        'att_rich-cocoa',
        'cocoa.svg',
        'image/svg+xml',
        'file',
        swatchSvg('#7d6353', 'Cocoa'),
        {
          width: 480,
          height: 360,
        },
      ),
      fixtureAttachment('att_rich-coin', 'coin.svg', 'image/svg+xml', 'file', swatchSvg('#e0b75e', 'Coin'), {
        width: 480,
        height: 360,
      }),
      fixtureAttachment('att_rich-sheet', 'brand-sheet.pdf', 'application/pdf', 'document', brandSheetPdf()),
      fixtureAttachment('att_rich-chime', 'invoice-paid.wav', 'audio/wav', 'file', chimeWav()),
    ]),
    message(
      'msg_pr482-rich-1112',
      '11:12',
      `September was the best month since the new logo went out:\n\n\`\`\`html\n${CHART_PAGE}\n\`\`\``,
    ),
    message('msg_pr482-rich-1114', '11:14', 'Two rounds of invoice mockups. Click through them:', [
      pageSetAttachment(),
    ]),
  ];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export interface RichFixtures {
  /** Adds the agent's rich messages to PR #482's room. */
  decorate(req: Request, response: Response): Promise<Response>;
}

export function createRichFixtures(): RichFixtures {
  let messages: Message[] | null = null;
  const roomPath = `${API_BASE}/burrows/${burrow.slug}/conversations/${RICH_ROOM}/messages`;
  return {
    async decorate(req, response) {
      const path = new URL(req.url, 'http://fixtures.local').pathname;
      // The page set and its cover, as the server serves a file and its thumbnail.
      if (req.method === 'GET' && path === SET_URL)
        return new Response(new Blob([setFile() as BlobPart]), {
          headers: { 'content-type': PAGES_CONTENT_TYPE },
        });
      if (req.method === 'GET' && path === attachmentThumbnailUrl(burrow.slug, SET_ID))
        return new Response(new Blob([coverFile() as BlobPart]), {
          headers: { 'content-type': 'image/png' },
        });
      if (req.method !== 'GET' || !response.ok) return response;
      if (path === roomPath) {
        messages ??= richMessages();
        const page = (await response.json()) as { messages: Message[] };
        const all = [...page.messages.filter((m) => !m.id.includes('-rich-')), ...messages].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
        return json({ ...page, messages: all });
      }
      return response;
    },
  };
}
