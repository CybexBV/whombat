Visual regression suite (`pnpm visual`): every desktop screen and state against the HTML references,
light and dark, plus baselines for unmocked screens and Storybook stories. How to run, update and
extend it: `tools/visual/README.md`. Shared helpers: `support/harness.ts`. The HTML references are in
`docs/design-handoff/design/`.

- `*.spec.ts` — one spec per area (see the coverage table in tools/visual/README.md).
- `mock*.ts` — the mock's data at a given moment (run tick, approval, audit log), patched into the
  fixture app's query cache.
- `cards.html` / `avatars.html` — dev-only harness pages served by Vite at `/visual/…`.
- `__screenshots__/` — baselines (`toHaveScreenshot`), one set for every platform.
