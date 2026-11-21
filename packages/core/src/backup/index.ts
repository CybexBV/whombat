/**
 * `@whombat/core/backup` — backup files (contracts 0.79.0, CT-335; Whombat docs/decisions/backup-file.md): a file an
 * owner chooses the contents of, downloads, keeps, and uploads again to restore — on the same Whombat, another box, after
 * a reset, hosted ↔ box. Pure (no I/O, no Node APIs): the server, web, Android and the offline CLI share it.
 *
 * - `categories` — the eleven category ids (0.117), order, defaults, labels and the download panel's meta lines and
 *   sizes;
 * - `container` — the encrypted container: header, Argon2id, XChaCha20-Poly1305 STREAM chunks, incremental encoder and
 *   decoder;
 * - `tar` — the streaming ustar writer and reader of the body;
 * - `manifest` — the body's entries, `manifest.json`, the `.jsonl` reader, the file name;
 * - `records` — the directory and every category's record schemas;
 * - `notes` — notes about a file and its restore, with their words;
 * - `restore` — the restore preview, “When something is different”, the summary and their words, the servers' part;
 * - `remap` — rewriting source ids to target ids;
 * - `errors`, `copy` — error codes with their sentences, and the panels' words.
 *
 * The REST contract is `api.backups` (`@whombat/core/contracts`, `contracts/backups.ts`).
 */
export * from './categories.js';
export * from './container.js';
export * from './copy.js';
export * from './errors.js';
export * from './kit-envelope.js';
export * from './manifest.js';
export * from './notes.js';
export * from './records.js';
export * from './remap.js';
export * from './restore.js';
export * from './tar.js';
