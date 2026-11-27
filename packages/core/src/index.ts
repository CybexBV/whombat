/**
 * @whombat/core — domain types, Zod contracts and pure logic shared by server, web, mobile and runner.
 * No I/O, no Node-only APIs.
 *
 * Subpath exports: `@whombat/core/domain`, `/contracts`, `/keys`, `/skills`, `/approvals`, `/audit`, `/automations`,
 * `/feedback` (`/feedback/sanitize`, `/feedback/drop`, `/feedback/reporters`), `/text` (`/text/utf8`), `/vault`,
 * `/commands`, `/backup`, `/share`, `/ids`.
 */
export * from './approvals/index.js';
export * from './audit/index.js';
export * from './automations/index.js';
export * from './backup/index.js';
export * from './commands/index.js';
export * from './contracts/index.js';
export * from './domain/delegation-verification.js';
export * from './domain/index.js';
export * from './feedback/index.js';
export * from './i18n/index.js';
export * from './keys/index.js';
export * from './skills/index.js';
export * from './text/index.js';
export * from './vault/index.js';
