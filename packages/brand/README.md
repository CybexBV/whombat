# @whombat/brand

The Whombat logo. `assets/` is the logo package exactly as delivered (read `assets/README.md` for the colors,
files and rules); `src/` draws the same shapes for the apps.

```tsx
import { WhombatLogo } from '@whombat/brand/react';

<WhombatLogo height={16} />                                   // symbol, decorative; ≤ 32 px → small symbol
<WhombatLogo variant="lockup" height={24} label="Whombat" />  // horizontal logo, an image named “Whombat”
```

The logo is always one flat color, the `logo` theme token (`--logo`: burrow ink on light, paper on dark), so the
component has no color prop. Mobile: `apps/mobile/src/ui/WhombatLogo.tsx` renders the same tree with
react-native-svg.

Renderer-agnostic core (static files, other renderers):

```ts
import { buildLogo, renderLogoSvg, SYMBOL_SMALL_PATH } from '@whombat/brand';

renderLogoSvg(buildLogo({ variant: 'symbol', height: 64, color: brandColors.ink }));
```

## Icons

```sh
pnpm --filter @whombat/brand export-icons
```

writes `apps/web/public` (favicon.ico/.svg, apple-touch-icon, icon-192/512 + manifest.webmanifest, badge-96 for
web push, the Open Graph image) and `apps/mobile/assets` (icon, adaptive-icon, splash-icon(-dark),
notification-icon) plus the Android status-bar vector of `modules/whombat-live`. Tiles the package ships are
copied, transparent marks rendered with Playwright's Chromium. A test fails when the generated text files are
stale.

## Other companies' marks

Guide cards name providers with their marks (docs/decisions/assistant-guides.md AG-16): the Google “G”, the
Microsoft four squares, Claude, OpenAI, GitHub and a generic mail envelope (`BRAND_MARKS`, `src/marks.ts`).

```tsx
import { BrandMark } from '@whombat/brand/react';

<BrandMark mark="google" size={24} />   // always decorative (aria-hidden): the provider is named in the text
```

They are the owners' marks unchanged, and an explicit exception to “colors only through tokens” (like status dots
and avatar tones): Google, Microsoft and Claude keep their fixed colours; OpenAI and GitHub, which their owners
publish in flat black or white, and the envelope (Lucide `mail`) use `currentColor` so they follow the text.
Sources: Google's Sign-In branding “G”; Microsoft's logo; Claude, OpenAI and GitHub from Simple Icons (CC0 — the
trademarks stay their owners'); the envelope from Lucide (ISC). Mobile: `apps/mobile/src/ui/BrandMark.tsx`.
