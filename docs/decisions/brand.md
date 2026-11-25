# Workstream: brand (the Whombat logo)

On 2026-09-24 the maintainer supplied the Whombat logo package (“Whombat Logo System”: the full-face symbol,
Round 3, and a Bricolage Grotesque ExtraBold wordmark) and asked for it everywhere: app icons, favicons and the
web UI. The package is committed verbatim in `packages/brand/assets/` (its README holds the colors, files and
usage rules).

## Decisions

- **BR-01 The logo replaces the mocks' ellipse.** The design reference draws the logo as a flat ellipse
  (sidebar 20 × 13, onboarding aside 22 × 14 + “Whombat” 19/700). That was a placeholder; the maintainer's
  logo wins over the mock there, the only place a mock is overridden. Visual diffs against the reference at
  those spots are expected.
  - Sidebar burrow button: the symbol, 16 px tall (≈ 20 px wide, the ellipse's width), decorative.
  - Onboarding and sign-in asides (web), mobile sign-in: the horizontal logo 23 px tall, the old row's
    height, so nothing below moves (its wordmark's cap height ≈ the old 19 px text), labelled “Whombat”.
- **BR-02 One package, one geometry.** `@whombat/brand` holds the package's shapes as data (`src/index.ts`) and a
  renderer-agnostic node tree (`buildLogo`), like `@whombat/avatars`. Web renders it with React DOM
  (`@whombat/brand/react`), mobile with react-native-svg (`apps/mobile/src/ui/WhombatLogo.tsx`), and the export
  script writes static files from it. Tests pin the shapes to the package's SVGs; the full symbol and the
  lockup render pixel-identical to them.
- **BR-03 The size rule is automatic.** At 32 px and below the small symbol is drawn (package rule): as one
  nonzero path (ears and head clockwise, eyes and nose counter-clockwise), so it works without masks (Android
  vector drawables). Above 32 px the full symbol uses the package's mask, with a per-instance id.
- **BR-04 Color is a token, not a prop.** `brandColors` (ink, paper, night, cocoa, cream) and the theme color
  `logo` (ink on light, paper on dark) live in `@whombat/tokens`; the components always draw in `logo`
  (`--logo` on web). The package forbids recoloring with accents, so there is no color prop.
- **BR-05 The Ink tile is the app icon.** Of the package's Ink, Cocoa and Paper tiles, Ink (paper face on
  burrow ink) is the icon everywhere: iOS/Expo `icon.png` (rendered, the face 60% of the tile: the package's
  two-thirds face looked too big on a home screen, John 2026-11-25), the Android adaptive icon (vectors under their own name `@mipmap/whombat_launcher`,
  `apps/mobile/plugins/with-launcher-icon.cjs`: the face 38 of 108 dp wide, half of the 72 dp launchers show, paper
  with its features in ink on `#2b221d`; the themed-icon layer is the small symbol. A Samsung phone kept showing the
  earlier bitmap `ic_launcher` after updates, while a vector icon changed at once), the web `apple-touch-icon.png`, `icon-192/512.png` (manifest, `any` and `maskable`: the face
  fits the maskable safe zone) and the package's `favicon.ico`.
- **BR-06 favicon.svg follows the color scheme.** The package's README says its `favicon.svg` switches ink/paper
  with the browser's scheme, but the file has no style rule; ours is generated from the small symbol with a
  `prefers-color-scheme: dark` rule.
- **BR-07 Notification icons are the small symbol, white on transparent**: the Android status-bar vector of
  `modules/whombat-live`, Expo push's `notification-icon.png` (tinted cocoa), the web push `badge-96.png`
  (the service worker pointed at a missing `/icon-192.png` before).
- **BR-08 Splash: the full symbol on the theme `bg`**, ink on light, paper on dark (`splash-icon.png`,
  `splash-icon-dark.png`), instead of Clover's head.
- **BR-09 Link previews** use the package's 1200 × 630 Open Graph image (`/whombat-og-1200x630.png`,
  relative: a self-hosted instance does not know its public URL at build time) and `twitter:card`
  `summary_large_image`. `theme-color` follows the light/dark `bg` tokens.
- **BR-10 Generated files are checked.** `pnpm --filter @whombat/brand export-icons` writes every web and mobile
  icon (copies the package's tiles, renders transparent marks with Playwright's Chromium, writes the SVG,
  manifest and vector XML); a test fails when the committed text files are stale. It replaces
  `apps/mobile/scripts/generate-icons.mjs`.
- **BR-11 `/brand` shows the logo package.** A public web route (no sign-in, no link from the app) with every
  logo on its light and dark ground, the colors (click a hex to copy), the symbol sizes, app icon tiles,
  favicons, link preview, type, rules and snippets, and a download for every file of the package (Vite bundles
  them from `packages/brand/assets`; a test checks each file is offered). The served `favicon.svg` stands in
  for the package's (BR-06). `brand` is a reserved burrow slug.
