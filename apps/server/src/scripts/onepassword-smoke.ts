/**
 * A smoke test of the 1Password sync's worker against a real 1Password account (docs/decisions/onepassword-sync.md):
 * what the in-memory stand-in can't tell. A maintainer runs it by hand with a service account token for a test vault;
 * nothing runs it on its own.
 *
 *   ONEPASSWORD_SMOKE_TOKEN_FILE=/path/to/token [ONEPASSWORD_SMOKE_VAULT=<vault id or name>] \
 *     pnpm --filter @whombat/server exec tsx src/scripts/onepassword-smoke.ts
 *
 * The token is read from the file (never an argument or a variable's value). It works only on items it makes, each
 * titled “Whombat smoke test …”, through the worker exactly as the sync does: it makes a Login and an API Credential,
 * reads them back, writes a change (a new password, a one-time password and a custom field without a section), writes
 * again with the old version to see 1Password's refusal, archives both and lists the vault again to see them gone from
 * the list. It prints facts (ids, versions, field ids and types, outcomes, error words), never a value.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  applyOnePasswordProjection,
  newId,
  newOnePasswordItem,
  type OnePasswordItem,
  type OnePasswordProjection,
  onePasswordCanonical,
  onePasswordItemMarker,
  onePasswordItemProjection,
} from '@whombat/core';
import { consoleLogger } from '../services';
import { OnePasswordError, OnePasswordPool } from '../vault/onepassword/pool';

const say = (line: string) => process.stdout.write(`${line}\n`);

function tokenFromFile(): string {
  const file = process.env.ONEPASSWORD_SMOKE_TOKEN_FILE;
  if (!file) throw new Error('Set ONEPASSWORD_SMOKE_TOKEN_FILE to a file holding the service account token.');
  const token = readFileSync(file, 'utf8').trim();
  if (!token) throw new Error('The token file is empty.');
  return token;
}

/** An item's shape without its values: field ids, types and whether each is in a section. */
function shape(item: OnePasswordItem): string {
  const fields = item.fields
    .map(
      (f) =>
        `${f.id}:${f.fieldType}${f.sectionId ? `@${f.sectionId}` : ''}${f.value === '' ? '(empty)' : ''}`,
    )
    .join(' ');
  return `category=${item.category} version=${item.version} sections=[${item.sections
    .map((s) => s.id)
    .join(',')}] websites=${item.websites.length} fields=[${fields}]`;
}

function failure(err: unknown): string {
  if (err instanceof OnePasswordError) return `${err.kind}: ${err.message}`;
  return err instanceof Error ? `${err.name}: ${err.message.slice(0, 300)}` : 'failed';
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T | null> {
  const started = Date.now();
  try {
    const out = await run();
    say(`ok    ${name} (${Date.now() - started} ms)`);
    return out;
  } catch (err) {
    say(`FAIL  ${name} (${Date.now() - started} ms): ${failure(err)}`);
    return null;
  }
}

async function main(): Promise<number> {
  const token = tokenFromFile();
  const pool = new OnePasswordPool({ log: consoleLogger });
  const made: OnePasswordItem[] = [];
  let vaultId = '';
  try {
    const checked = await step('sign in and list the vaults', () => pool.check(token));
    if (!checked) return 1;
    say(`      vaults the token sees: ${checked.vaults.length}`);
    const wanted = process.env.ONEPASSWORD_SMOKE_VAULT?.trim();
    const vault = wanted
      ? checked.vaults.find((v) => v.id === wanted || v.title === wanted)
      : checked.vaults.length === 1
        ? checked.vaults[0]
        : undefined;
    if (!vault) {
      say('FAIL  choose a vault: set ONEPASSWORD_SMOKE_VAULT to its id or name');
      return 1;
    }
    vaultId = vault.id;
    say(`      vault ${vault.id}`);
    const before = await step('read the vault’s overview', () => pool.overview(token, vaultId));
    if (before)
      say(`      contentVersion=${before.contentVersion} activeItemCount=${before.activeItemCount}`);
    const listed = await step('list the vault’s items', () => pool.list(token, vaultId));
    if (listed) say(`      items listed: ${listed.length}`);

    const stamp = new Date().toISOString().slice(0, 19);
    const secret = () => randomBytes(18).toString('base64url');
    const login: OnePasswordProjection = {
      kind: 'login',
      name: `Whombat smoke test login ${stamp}`,
      url: 'https://example.com/login',
      username: 'smoke@example.com',
      secret: secret(),
      totp: null,
    };
    const apiToken: OnePasswordProjection = {
      kind: 'http',
      name: `Whombat smoke test API ${stamp}`,
      url: 'https://api.example.com',
      username: null,
      secret: secret(),
      totp: null,
    };
    for (const p of [login, apiToken]) {
      const entryId = newId('vaultEntry');
      const item = await step(`create ${p.kind === 'login' ? 'a Login' : 'an API Credential'}`, () =>
        pool.create(token, newOnePasswordItem({ vaultId, entryId, projection: p })),
      );
      if (!item) continue;
      made.push(item);
      say(`      ${item.id} ${shape(item)}`);
      const [read] = (await step('get it back', () => pool.get(token, vaultId, [item.id])))?.items ?? [];
      if (!read) continue;
      const reading = onePasswordItemProjection(read);
      const same =
        reading.ok &&
        JSON.stringify(onePasswordCanonical(reading.projection)) === JSON.stringify(onePasswordCanonical(p));
      say(
        `      marker read back: ${onePasswordItemMarker(read) === entryId}; reads as an entry: ${reading.ok}${
          reading.ok ? '' : ` (${reading.reason})`
        }; same values: ${same}`,
      );
    }

    const first = made.find((i) => i.category === 'Login');
    if (first) {
      const [current] = (await pool.get(token, vaultId, [first.id])).items;
      if (current) {
        const changed = applyOnePasswordProjection(current, {
          ...login,
          secret: secret(),
          totp: 'otpauth://totp/Whombat%20smoke?secret=JBSWY3DPEHPK3PXP',
        });
        const written = await step('put a new password and a one-time password', () =>
          pool.put(token, changed),
        );
        if (written) {
          say(`      version ${current.version} → ${written.version}; ${shape(written)}`);
          const otp = written.fields.find((f) => f.fieldType === 'Totp');
          say(
            `      one-time password kept: ${otp !== undefined}; in section: ${otp?.sectionId ?? '(none)'}`,
          );
          const extra: OnePasswordItem = {
            ...written,
            fields: [
              ...written.fields,
              { id: 'smokeextra', title: 'Smoke extra', fieldType: 'Text', value: 'x' },
            ],
          };
          const withField = await step('put a custom field without a section', () => pool.put(token, extra));
          if (withField) {
            const f = withField.fields.find((x) => x.id === 'smokeextra');
            say(
              `      kept: ${f !== undefined}; its section as 1Password keeps it: ${f?.sectionId ?? '(none)'}`,
            );
          }
          await step('put again with the old version (should be refused)', async () => {
            try {
              await pool.put(token, { ...changed, version: current.version });
            } catch (err) {
              say(`      refused as ${failure(err)}`);
              return;
            }
            throw new Error('the stale put was accepted');
          });
        }
      }
    }
    const after = await step('read the vault’s overview again', () => pool.overview(token, vaultId));
    if (after && before) say(`      contentVersion ${before.contentVersion} → ${after.contentVersion}`);
    // The SDK (0.5.0) says nothing of the limit's counters: only “too many requests” when it is hit.
    say('      rate-limit counters: not exposed by @1password/sdk 0.5.0');
    return 0;
  } finally {
    const archived = new Set<string>();
    for (const item of made)
      if (await step(`archive ${item.id}`, () => pool.archive(token, vaultId, item.id).then(() => true)))
        archived.add(item.id);
    if (archived.size) {
      // The sync takes an item missing from the list as gone from the vault: an archived one mustn't be listed active.
      const again = await step('list the vault’s items again', () => pool.list(token, vaultId));
      if (again) {
        const still = again.filter((o) => archived.has(o.id));
        say(
          `      archived items gone from the list: ${still.length === 0}${
            still.length ? `; still listed: ${still.map((o) => `${o.id} (${o.state})`).join(', ')}` : ''
          }`,
        );
      }
    }
    pool.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    say(`FAIL  ${failure(err)}`);
    process.exit(1);
  },
);
