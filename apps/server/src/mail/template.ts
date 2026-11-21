/**
 * The HTML version of every email (docs/decisions/email-templates.md): one Whombat layout — the logo on a burrow-ink
 * band, a paper card, the email's kind as a small label — with blocks for what the email carries (a button, a code,
 * a list of items). The plain text stays the sender's own; this adds `html` next to it. Mail clients ignore CSS
 * variables and `<style>` support varies, so styles are inline and the colors are the @whombat/tokens values
 * (light theme; dark mode where the client honours `prefers-color-scheme`).
 */
import { LOGO_CID, LOGO_HEIGHT, LOGO_WIDTH } from './logo';

export type EmailBlock =
  /** A paragraph. */
  | string
  | { button: { href: string; label: string } }
  /** A one-time code, large and spaced. */
  | { code: string; caption?: string }
  /** The raw link under a button, for clients that drop the button. */
  | { link: string }
  /** Small grey text. */
  | { note: string }
  /** Linked items, each with an optional quote (the notification email). */
  | { items: readonly { title: string; quote?: string | null; href: string }[] }
  /** Label/value rows. */
  | { facts: readonly (readonly [string, string])[] };

export interface EmailTemplate {
  /** What kind of email this is, shown in the header: “Sign in”, “Invitation”. */
  label: string;
  /** The inbox preview line. */
  preheader?: string;
  title: string;
  blocks: readonly EmailBlock[];
  /** Why this email came (under the card); a line may end in a link. */
  footer?: readonly (string | { text: string; link: { href: string; label: string } })[];
  /** Where it came from, under the footer: “Sent by the Whombat at acme.example”. */
  sender?: string;
}

// @whombat/tokens: brandColors and themeColors (light; `dark` in DARK_CSS). Lines are solid: rgba borders render
// differently across clients.
const C = {
  ground: '#f3eee6',
  card: '#fffdf9',
  line: '#e9e3da',
  band: '#2b221d',
  cream: '#dcc6ab',
  ink: '#221d18',
  ink2: '#3d352e',
  mut: '#6e655c',
  brand: '#7d6353',
  chip: '#f1ece4',
  btnfg: '#f5f2ed',
} as const;
const SANS =
  "'Bricolage Grotesque', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "'DM Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const DARK_CSS = `@media (prefers-color-scheme: dark) {
  .wb-ground { background: #171411 !important; }
  .wb-card { background: #24201c !important; border-color: #3a332d !important; }
  .wb-title { color: #f1ebe3 !important; }
  .wb-text { color: #d8cfc4 !important; }
  .wb-mut { color: #a0958a !important; }
  .wb-link { color: #d2b49a !important; }
  .wb-chip { background: #2e2925 !important; border-color: #3a332d !important; color: #f1ebe3 !important; }
  .wb-btn { background: #f1ebe3 !important; }
  .wb-btn a { color: #1c1815 !important; }
  .wb-rule { border-color: #3a332d !important; }
}`;

const esc = (t: string) =>
  t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function block(b: EmailBlock): string {
  if (typeof b === 'string')
    return `<p class="wb-text" style="margin:0 0 16px;font:15px/1.6 ${SANS};color:${C.ink2};">${esc(b)}</p>`;
  if ('button' in b)
    return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;"><tr><td class="wb-btn" bgcolor="${C.ink}" style="border-radius:10px;background:${C.ink};"><a href="${esc(b.button.href)}" target="_blank" style="display:inline-block;padding:12px 22px;font:600 15px/1.2 ${SANS};color:${C.btnfg};text-decoration:none;border-radius:10px;">${esc(b.button.label)}</a></td></tr></table>`;
  if ('code' in b)
    return `${b.caption ? `<p class="wb-mut" style="margin:0 0 8px;font:13px/1.5 ${SANS};color:${C.mut};">${esc(b.caption)}</p>` : ''}<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;"><tr><td class="wb-chip" style="padding:14px 22px;background:${C.chip};border:1px solid ${C.line};border-radius:12px;font:600 30px/1 ${MONO};letter-spacing:6px;color:${C.ink};">${esc(b.code)}</td></tr></table>`;
  if ('link' in b)
    return `<p class="wb-mut" style="margin:0 0 16px;font:12px/1.5 ${SANS};color:${C.mut};">If the button doesn’t work, paste this link into your browser:<br><a class="wb-link" href="${esc(b.link)}" target="_blank" style="color:${C.brand};word-break:break-all;">${esc(b.link)}</a></p>`;
  if ('note' in b)
    return `<p class="wb-mut" style="margin:0 0 16px;font:13px/1.55 ${SANS};color:${C.mut};">${esc(b.note)}</p>`;
  if ('items' in b)
    return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">${b.items
      .map(
        (i) =>
          `<tr><td class="wb-rule" style="padding:12px 0;border-top:1px solid ${C.line};"><a class="wb-title" href="${esc(i.href)}" target="_blank" style="font:600 15px/1.45 ${SANS};color:${C.ink};text-decoration:none;">${esc(i.title)}</a>${i.quote ? `<div class="wb-mut" style="margin-top:4px;font:14px/1.5 ${SANS};color:${C.mut};">${esc(i.quote)}</div>` : ''}<div style="margin-top:6px;"><a class="wb-link" href="${esc(i.href)}" target="_blank" style="font:600 13px/1.4 ${SANS};color:${C.brand};text-decoration:none;">Open →</a></div></td></tr>`,
      )
      .join('')}</table>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;">${b.facts
    .map(
      ([k, v]) =>
        `<tr><td class="wb-mut wb-rule" valign="top" style="padding:8px 12px 8px 0;border-top:1px solid ${C.line};font:12px/1.5 ${MONO};color:${C.mut};white-space:nowrap;">${esc(k)}</td><td class="wb-text wb-rule" style="padding:8px 0;border-top:1px solid ${C.line};font:14px/1.5 ${SANS};color:${C.ink2};word-break:break-word;">${esc(v)}</td></tr>`,
    )
    .join('')}</table>`;
}

function footerLine(l: NonNullable<EmailTemplate['footer']>[number]): string {
  const body =
    typeof l === 'string'
      ? esc(l)
      : `${esc(l.text)} <a class="wb-link" href="${esc(l.link.href)}" target="_blank" style="color:${C.brand};">${esc(l.link.label)}</a>`;
  return `<p class="wb-mut" style="margin:0 0 6px;font:12px/1.5 ${SANS};color:${C.mut};">${body}</p>`;
}

/** “Sent by the Whombat at acme.example”: a self-hosted Whombat's emails name it. */
export function sentBy(origin: string): string {
  try {
    return `Sent by the Whombat at ${new URL(origin).host}`;
  } catch {
    return 'Sent by your Whombat';
  }
}

/** The email's HTML. Images: only the logo, as `cid:` (the mailer attaches it). */
export function renderEmailHtml(t: EmailTemplate): string {
  const footer = [...(t.footer ?? []), ...(t.sender ? [t.sender] : [])];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${esc(t.title)}</title><style>${DARK_CSS}</style></head>
<body class="wb-ground" style="margin:0;padding:0;background:${C.ground};">
${t.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(t.preheader)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>` : ''}
<table role="presentation" class="wb-ground" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.ground}" style="background:${C.ground};"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
<tr><td bgcolor="${C.band}" style="background:${C.band};border-radius:16px 16px 0 0;padding:22px 28px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td valign="middle"><img src="cid:${LOGO_CID}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="Whombat" style="display:block;border:0;outline:none;color:${C.btnfg};font:700 20px ${SANS};"></td>
<td valign="middle" align="right" style="font:500 11px/1 ${MONO};letter-spacing:1.5px;text-transform:uppercase;color:${C.cream};">${esc(t.label)}</td>
</tr></table></td></tr>
<tr><td class="wb-card" bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.line};border-top:0;border-radius:0 0 16px 16px;padding:32px 28px 16px;">
<h1 class="wb-title" style="margin:0 0 16px;font:700 22px/1.3 ${SANS};color:${C.ink};">${esc(t.title)}</h1>
${t.blocks.map(block).join('\n')}
</td></tr>
${footer.length ? `<tr><td align="center" style="padding:20px 28px 0;">${footer.map(footerLine).join('')}</td></tr>` : ''}
</table></td></tr></table>
</body></html>`;
}
