# Whombat logo package

Mark: full-face symbol (Round 3). Wordmark: Bricolage Grotesque ExtraBold (96pt optical size), −3.5% tracking, outlined — no font install needed.

## Colors
- Burrow ink  #2B221D — logo on light grounds
- Paper       #F5F2ED — logo on dark grounds, light ground
- Night       #1C1815 — dark UI ground
- Cocoa       #7D6353 — alternate app icon tile
- Muzzle cream #DCC6AB — secondary light ground

## Files
- svg/        Master vector files. `-ink` for light backgrounds, `-paper` for dark backgrounds. Transparent.
  - whombat-logo-horizontal — primary logo
  - whombat-logo-stacked — square / centred formats
  - whombat-symbol — icon only, 48 px and up
  - whombat-symbol-small — icon only, 32 px and below (larger eyes and nose, no mouth or inner ears)
  - whombat-wordmark — when the symbol is already on screen
- png/        Transparent PNG exports of the above.
- app-icon/   Full-bleed square tiles (stores apply their own corner mask) in Ink, Cocoa and Paper; `-rounded` SVGs for previews and decks. apple-touch-icon-180, android-chrome-192.
- favicon/    favicon.ico (16/32/48), favicon.svg (switches ink/paper with the browser's colour scheme), PNGs.
- social/     Open Graph / link preview image, 1200 × 630.

## HTML snippet
```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon-180.png">
<meta property="og:image" content="/whombat-og-1200x630.png">
```

## Rules
- Clear space: the height of one ear on every side.
- Minimum size: symbol 16 px, horizontal logo 20 px tall.
- Switch to the small symbol at 32 px and below.
- One flat color only. Never recolor with agent accents, stretch, rotate or add effects.
