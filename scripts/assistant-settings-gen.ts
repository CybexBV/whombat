/**
 * `pnpm assistant-settings:gen`: writes the assistant's `whombat:settings` skill into the Hermes plugin from the settings
 * map (docs/decisions/assistant-settings.md). Run it after changing `packages/protocol/src/session/assistant-settings/`;
 * `pnpm check` fails while the files differ (`apps/server/src/settings/skill-files.test.ts`).
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASSISTANT_SETTINGS,
  assistantSettingsSkill,
} from '../packages/protocol/src/session/assistant-settings/index.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(repo, 'packages/hermes-whombat/whombat_hermes/skills/settings');
rmSync(dir, { recursive: true, force: true });
for (const [path, text] of Object.entries(assistantSettingsSkill(ASSISTANT_SETTINGS))) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}
console.log(`assistant-settings:gen · ${dir}`);
