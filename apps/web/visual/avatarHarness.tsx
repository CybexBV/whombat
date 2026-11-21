/**
 * Avatar harness (dev only, served by Vite at `/visual/avatars.html`): one `<WhombatAvatar>` at a size on the
 * surface the crew's reference (`docs/design-handoff/whombat-crew/reference/crew-reference.html`) draws it on
 * (`#f3ede3` light, `#2b221d` dark).
 *
 *   /visual/avatars.html?face=skipper&size=160&surface=dark
 */
import { isAvatarFace } from '@whombat/avatars';
import { WhombatAvatar } from '@whombat/avatars/react';
import { createRoot } from 'react-dom/client';

/** The reference's surfaces (its light and dark grids), fixed: they are the reference's, not the app's theme. */
const SURFACES = { light: '#f3ede3', dark: '#2b221d' } as const;

const params = new URLSearchParams(window.location.search);
const face = params.get('face') ?? 'banjo';
const size = Number(params.get('size') ?? 160);
const surface = params.get('surface') === 'dark' ? 'dark' : 'light';
if (!isAvatarFace(face)) throw new Error(`unknown face ${face}`);
document.body.style.background = SURFACES[surface];

const root = document.getElementById('root');
if (root) createRoot(root).render(<WhombatAvatar face={face} size={size} eager />);
