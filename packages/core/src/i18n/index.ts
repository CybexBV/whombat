/**
 * `@whombat/core/i18n` — catalog-free, zero-dependency localization runtime and formatters shared by
 * `@whombat/core`, `@whombat/client`, `apps/server`, `apps/web`, `apps/mobile` and `apps/widget`.
 *
 * Pure ES2023 (no DOM, no `localStorage`, no `eval`/`new Function`, no React). Message catalogs live
 * beside the packages that own them so Nix builds, contract releases and bundle sizes stay isolated.
 */
export * from './engine.js';
export * from './format.js';
export * from './locale.js';
