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
 * `pnpm --filter @whombat/server onepassword:dev`), as a person would change them in 1Password's app. Nothing is kept
 * across restarts. Never in production: the config refuses `WHOMBAT_ONEPASSWORD=fake` there, and `onePasswordStandInOn`
 * is false there whatever it says.
 */
import type { OnePasswordItem, OnePasswordNewItem } from '@whombat/core';
import type { Config } from '../../../config';
import type { OnePasswordApi } from '../pool';
import { FakeOnePassword } from './fake';

/** What a token for the stand-in starts with (1Password's own start with `ops_`). */
export const ONEPASSWORD_DEV_TOKEN = 'ops_dev_';

/** Whether the stand-in answers `ops_dev_` tokens: in development unless `real`, with `fake` anywhere but production. */
export function onePasswordStandInOn(config: Pick<Config, 'NODE_ENV' | 'WHOMBAT_ONEPASSWORD'>): boolean {
  if (config.NODE_ENV === 'production') return false;
  return (config.WHOMBAT_ONEPASSWORD ?? (config.NODE_ENV === 'development' ? 'fake' : 'real')) === 'fake';
}

export class StandInOnePassword implements OnePasswordApi {
  readonly fake = new FakeOnePassword();
  readonly #real: () => OnePasswordApi;
  readonly #whombat: string;
  readonly #team: string;

  constructor(real: () => OnePasswordApi) {
    this.#real = real;
    const { whombat, team } = seedStandIn(this.fake);
    this.#whombat = whombat;
    this.#team = team;
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
    return this.#to(token).create(token, item);
  }
  put(token: string, item: OnePasswordItem) {
    return this.#to(token).put(token, item);
  }
  archive(token: string, vaultId: string, itemId: string) {
    return this.#to(token).archive(token, vaultId, itemId);
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
