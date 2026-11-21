/**
 * Rich messages in the app's demo world, only when asked for (`EXPO_PUBLIC_WHOMBAT_RICH=1`, AP-329): the agent in PR
 * #482's room with assignment item 8's test messages (the web's `app/richFixtures.ts`, text only): the logo page as a
 * fenced `html` block (inline SVG, `<style>`, a Google Fonts `<link>`, a small script), a heading with a table and a
 * task list, a Mermaid diagram and code with a nested quote. Pure, unit-tested.
 */
import type { Message, MessagePage } from '@whombat/core';
import { AGENT, at } from '@whombat/fixtures';

/** The room they are in: PR #482's (no channels, Whombat one-agent.md OA-04). */
export const RICH_ROOM = 'cnv_pr482';

export const LOGO_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Burrow Billing — logo</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&display=swap">
<style>
  body { margin: 0; background: #f6f1ea; color: #2b221d; font-family: 'Fraunces', Georgia, serif; }
  .stage { display: flex; align-items: center; justify-content: center; gap: 18px; padding: 36px 20px; flex-wrap: wrap; }
  .mark { width: 96px; height: 96px; }
  h1 { margin: 0; font-size: 34px; font-weight: 600; }
  p { margin: 6px 0 0; color: #7d6353; font: 14px/1.4 system-ui, sans-serif; }
</style>
</head>
<body>
  <div class="stage">
    <svg class="mark" viewBox="0 0 120 120" role="img" aria-label="Burrow Billing mark">
      <circle cx="60" cy="60" r="56" fill="#2b221d"/>
      <path d="M26 84 Q60 26 94 84 Z" fill="#dcc6ab"/>
      <circle id="coin" cx="60" cy="58" r="10" fill="#e0b75e"/>
    </svg>
    <div><h1>Burrow Billing</h1><p>Invoices that dig themselves out.</p></div>
  </div>
  <script>
    const coin = document.getElementById('coin');
    let t = 0;
    (function bounce() { t += 0.05; coin.setAttribute('cy', String(58 - Math.abs(Math.sin(t)) * 14)); requestAnimationFrame(bounce); })();
  </script>
</body>
</html>`;

function message(id: string, hhmm: string, text: string): Message {
  return {
    id,
    conversationId: RICH_ROOM,
    authorId: AGENT.id,
    createdAt: at(hhmm),
    editedAt: null,
    text,
    mentions: [],
    reactions: [],
    attachments: [],
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

export const RICH_MESSAGES: readonly Message[] = [
  message(
    'msg_rich-1101',
    '11:01',
    `Here’s the logo page for **Burrow Billing**:\n\n\`\`\`html\n${LOGO_PAGE}\n\`\`\``,
  ),
  message(
    'msg_rich-1104',
    '11:04',
    [
      '## Logo checklist',
      '',
      '| Variant | Size | Status |',
      '|:--|--:|:-:|',
      '| Mark on paper | 128 px | ✓ |',
      '| Mark on night | 128 px | ✓ |',
      '| Favicon | 16 px | — |',
      '',
      '- [x] Mark on paper and on night',
      '- [ ] Favicon at 16 px',
      '- [ ] Hand the files to @Mara',
    ].join('\n'),
  ),
  message(
    'msg_rich-1106',
    '11:06',
    '### How we got here\n\n```mermaid\nflowchart LR\n  brief[Brief] --> sketch[Sketches] --> review{Approved?}\n  review -- yes --> ship[Brand folder]\n```',
  ),
  message(
    'msg_rich-1108',
    '11:08',
    '```css\n:root {\n  --burrow-ink: #2b221d; /* the mark */\n  --coin: #e0b75e;\n}\n```\n\n> Mara asked for something warmer.\n> > Warmer than the old blue.',
  ),
];

/** PR #482's room with the agent's rich messages, in time order. */
export function withRichMessages(conversationId: string, page: MessagePage): MessagePage {
  if (conversationId !== RICH_ROOM) return page;
  const shown = new Set(page.messages.map((m) => m.id));
  const messages = [...page.messages, ...RICH_MESSAGES.filter((m) => !shown.has(m.id))].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  return { ...page, messages };
}
