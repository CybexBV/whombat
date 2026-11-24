/**
 * Development's stand-in 1Password (docs/decisions/onepassword-sync.md OPW-S19): the tests' in-memory 1Password
 * (`fake.ts`) with two made-up vaults, answering the tokens that start with `ops_dev_`, so a development box can link a
 * vault and keep it in step without a 1Password account. Every other token goes to the real worker, which starts only
 * when one is used.
 *
 * - `ops_dev_…`: both vaults, read and write (the form asks which).
 * - `ops_dev_one…`: only “Whombat” (taken without asking).
 * - `ops_dev_read…`: both vaults, read only.
 *
 * While the box runs, its items change through `/internal/dev/onepassword` (`routes.ts`, the runner's token;
 * `pnpm --filter @whombat/server onepassword:dev`), as a person would change them in 1Password's app. Its vaults are
 * kept in a file of the box's own folder (`$WHOMBAT_HOME/onepassword-standin.json`) after every change, so a restart
 * (a development server restarts at every saved file) finds the same vaults and items; delete it to start again.
 * Never in production: the config refuses `WHOMBAT_ONEPASSWORD=fake` there, and `onePasswordStandInOn` is false there
 * whatever it says.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OnePasswordItem, type OnePasswordNewItem } from '@whombat/core';
import { z } from 'zod';
import type { Config } from '../../../config';
import type { OnePasswordApi } from '../pool';
import { FakeOnePassword } from './fake';

/** The file's shape: the vaults with their items, as the fake holds them. */
const Kept = z.object({
  vaults: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      contentVersion: z.number().int(),
      items: z.array(OnePasswordItem),
      archived: z.array(OnePasswordItem),
    }),
  ),
});

/** What a token for the stand-in starts with (1Password's own start with `ops_`). */
export const ONEPASSWORD_DEV_TOKEN = 'ops_dev_';

/** Whether the stand-in answers `ops_dev_` tokens: in development unless `real`, with `fake` anywhere but production. */
export function onePasswordStandInOn(config: Pick<Config, 'NODE_ENV' | 'WHOMBAT_ONEPASSWORD'>): boolean {
  if (config.NODE_ENV === 'production') return false;
  return (config.WHOMBAT_ONEPASSWORD ?? (config.NODE_ENV === 'development' ? 'fake' : 'real')) === 'fake';
}

export class StandInOnePassword implements OnePasswordApi {
  readonly fake: FakeOnePassword;
  readonly #real: () => OnePasswordApi;
  readonly #file: string | null;
  readonly #whombat: string;
  readonly #team: string;

  /** `file`: where its vaults are kept between restarts (none: in memory only, as in tests). */
  constructor(real: () => OnePasswordApi, options: { file?: string } = {}) {
    this.#real = real;
    this.#file = options.file ?? null;
    const kept = this.#file ? readKept(this.#file) : null;
    // Its times go on from now, later than every kept one: the sync tells a change by a new time.
    const latest = Math.max(
      0,
      ...(kept?.vaults ?? []).flatMap((v) => [...v.items, ...v.archived].map((i) => Date.parse(i.updatedAt))),
    );
    this.fake = new FakeOnePassword({ clockStart: Math.max(Date.now(), latest) });
    if (kept) {
      for (const v of kept.vaults)
        this.fake.vaults.set(v.id, {
          id: v.id,
          title: v.title,
          contentVersion: v.contentVersion,
          items: new Map(v.items.map((i) => [i.id, i])),
          archived: new Map(v.archived.map((i) => [i.id, i])),
        });
    }
    const [whombat, team] = kept ? kept.vaults.map((v) => v.id) : [];
    if (whombat && team) {
      this.#whombat = whombat;
      this.#team = team;
    } else {
      this.fake.vaults.clear();
      ({ whombat: this.#whombat, team: this.#team } = seedStandIn(this.fake));
      this.save();
    }
  }

  /** Keeps the vaults in the file, when it has one (after every change). */
  save(): void {
    if (!this.#file) return;
    const kept = {
      vaults: [...this.fake.vaults.values()].map((v) => ({
        id: v.id,
        title: v.title,
        contentVersion: v.contentVersion,
        items: [...v.items.values()],
        archived: [...v.archived.values()],
      })),
    };
    mkdirSync(dirname(this.#file), { recursive: true });
    const next = `${this.#file}.next`;
    writeFileSync(next, JSON.stringify(kept), { mode: 0o600 });
    renameSync(next, this.#file);
  }

  check(token: string) {
    return this.#to(token).check(token);
  }
  overview(token: string, vaultId: string) {
    return this.#to(token).overview(token, vaultId);
  }
  list(token: string, vaultId: string) {
    return this.#to(token).list(token, vaultId);
  }
  get(token: string, vaultId: string, itemIds: readonly string[]) {
    return this.#to(token).get(token, vaultId, itemIds);
  }
  create(token: string, item: OnePasswordNewItem) {
    return this.#kept(this.#to(token).create(token, item));
  }
  put(token: string, item: OnePasswordItem) {
    return this.#kept(this.#to(token).put(token, item));
  }
  archive(token: string, vaultId: string, itemId: string) {
    return this.#kept(this.#to(token).archive(token, vaultId, itemId));
  }

  /** A write's answer, the vaults kept once it is made. */
  async #kept<T>(write: Promise<T>): Promise<T> {
    const out = await write;
    this.save();
    return out;
  }

  /** The stand-in for a development token (its vaults by the token's name), the real worker for any other. */
  #to(token: string): OnePasswordApi {
    if (!token.startsWith(ONEPASSWORD_DEV_TOKEN)) return this.#real();
    if (!this.fake.tokens.has(token)) {
      const rest = token.slice(ONEPASSWORD_DEV_TOKEN.length);
      this.fake.addToken(token, rest.startsWith('one') ? [this.#whombat] : [this.#whombat, this.#team], {
        readOnly: rest.startsWith('read'),
      });
    }
    // Only what a person would see in the app's own log: the calls aren't needed and would grow for ever.
    this.fake.calls.length = 0;
    return this.fake;
  }
}

/** The kept vaults, or null when there are none yet (or the file can't be read: the stand-in starts again). */
function readKept(file: string): z.infer<typeof Kept> | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = Kept.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The made-up vaults: “Whombat” with logins and API credentials that come in (their addresses resolve, as the pass
 * checks), and one each of what stays out (no website, an address that doesn't resolve, an SSH key, a note); “Team
 * logins” beside it, so the form asks which vault.
 */
export function seedStandIn(fake: FakeOnePassword): { whombat: string; team: string } {
  const whombat = fake.addVault('Whombat');
  const team = fake.addVault('Team logins');
  fake.addLogin(whombat, {
    title: 'Grafana',
    url: 'https://example.com/grafana',
    username: 'admin',
    password: 'stand-in-grafana-1',
  });
  fake.addLogin(whombat, {
    title: 'Router admin',
    url: 'https://example.net/router',
    username: 'admin',
    password: 'stand-in-router-1',
  });
  fake.addLogin(whombat, {
    title: 'Wiki',
    url: 'https://www.example.org/wiki',
    username: 'mara@example.com',
    password: 'stand-in-wiki-1',
    totp: 'otpauth://totp/Wiki:mara%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Wiki',
  });
  fake.addApiCredential(whombat, {
    title: 'Weather API',
    hostname: 'www.example.com',
    credential: 'stand-in-weather-token-1',
  });
  fake.addApiCredential(whombat, {
    title: 'Status page API',
    hostname: 'example.org',
    username: 'deploy',
    credential: 'stand-in-status-1',
  });
  fake.addLogin(whombat, { title: 'Forum', username: 'mara', password: 'stand-in-forum-1' });
  fake.addLogin(whombat, {
    title: 'NAS admin',
    url: 'https://nas.example.com',
    username: 'admin',
    password: 'stand-in-nas-1',
  });
  fake.addOther(whombat, 'Server key', 'SshKey');
  fake.addOther(whombat, 'Recovery codes', 'SecureNote');
  fake.addLogin(team, {
    title: 'Shared mailbox',
    url: 'https://example.com/mail',
    username: 'team@example.com',
    password: 'stand-in-mailbox-1',
  });
  return { whombat, team };
}
