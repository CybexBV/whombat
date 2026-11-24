/**
 * Development's stand-in 1Password (docs/decisions/onepassword-sync.md OPW-S19): on in development, never in
 * production; it answers only `ops_dev_` tokens (their vaults and rights by name) and leaves every other token to the
 * worker; the development door changes its items as a person would in 1Password's app.
 */
import {
  ONEPASSWORD_SKIP_TEXT,
  type OnePasswordItem,
  type OnePasswordNewItem,
  onePasswordItemProjection,
} from '@whombat/core';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, productionIssues } from '../../config';
import type { OnePasswordApi } from './pool';
import { changeStandIn } from './testing/routes';
import { onePasswordStandInOn, StandInOnePassword } from './testing/standin';

describe('when the stand-in answers', () => {
  it('is on in development unless asked for the real one, and in tests only when asked', () => {
    expect(onePasswordStandInOn({ NODE_ENV: 'development' })).toBe(true);
    expect(onePasswordStandInOn({ NODE_ENV: 'development', WHOMBAT_ONEPASSWORD: 'real' })).toBe(false);
    expect(onePasswordStandInOn({ NODE_ENV: 'test' })).toBe(false);
    expect(onePasswordStandInOn({ NODE_ENV: 'test', WHOMBAT_ONEPASSWORD: 'fake' })).toBe(true);
  });

  it('is never on in production, and production refuses to start asked for it', () => {
    expect(onePasswordStandInOn({ NODE_ENV: 'production' })).toBe(false);
    expect(onePasswordStandInOn({ NODE_ENV: 'production', WHOMBAT_ONEPASSWORD: 'fake' })).toBe(false);
    const cfg = loadConfig({ NODE_ENV: 'test', WHOMBAT_ONEPASSWORD: 'fake' });
    expect(productionIssues({}, { ...cfg, NODE_ENV: 'production' })).toContain(
      'WHOMBAT_ONEPASSWORD: the stand-in 1Password is for development and tests',
    );
  });
});

/** A worker that records which tokens reached it. */
function realWorker() {
  const reached = vi.fn();
  const fail = async (token: string) => {
    reached(token);
    throw new Error('the real worker');
  };
  const api: OnePasswordApi = {
    check: fail,
    overview: fail,
    list: fail,
    get: fail,
    create: fail,
    put: fail,
    archive: fail,
  };
  return { api, reached };
}

describe('the stand-in 1Password', () => {
  it('answers development tokens with its vaults, and leaves every other token to the worker', async () => {
    const real = realWorker();
    const standIn = new StandInOnePassword(() => real.api);
    expect((await standIn.check('ops_dev_mara')).vaults.map((v) => v.title)).toEqual([
      'Whombat',
      'Team logins',
    ]);
    expect((await standIn.check('ops_dev_one')).vaults.map((v) => v.title)).toEqual(['Whombat']);
    await expect(standIn.check('ops_eyJhbGciOi')).rejects.toThrow('the real worker');
    expect(real.reached).toHaveBeenCalledTimes(1);
    expect(real.reached).not.toHaveBeenCalledWith(expect.stringMatching(/^ops_dev_/));
  });

  it('has items that come in and one of each kind that stays out, with the reason', async () => {
    const standIn = new StandInOnePassword(() => realWorker().api);
    const token = 'ops_dev_mara';
    const [whombat] = (await standIn.check(token)).vaults;
    const overviews = await standIn.list(token, whombat?.id ?? '');
    const { items } = await standIn.get(
      token,
      whombat?.id ?? '',
      overviews.map((o) => o.id),
    );
    const read = Object.fromEntries(
      items.map((item: OnePasswordItem) => {
        const r = onePasswordItemProjection(item);
        return [item.title, r.ok ? 'in' : ONEPASSWORD_SKIP_TEXT[r.reason]];
      }),
    );
    expect(read).toMatchObject({
      Grafana: 'in',
      'Router admin': 'in',
      Wiki: 'in',
      'Weather API': 'in',
      'Status page API': 'in',
      Forum: ONEPASSWORD_SKIP_TEXT.no_website,
      'Server key': ONEPASSWORD_SKIP_TEXT.ssh_key,
      'Recovery codes': ONEPASSWORD_SKIP_TEXT.other_kind,
    });
  });

  it('refuses a read-only token’s writes as 1Password does', async () => {
    const standIn = new StandInOnePassword(() => realWorker().api);
    const token = 'ops_dev_read';
    const [whombat] = (await standIn.check(token)).vaults;
    const item: OnePasswordNewItem = {
      title: 'New',
      category: 'Login',
      vaultId: whombat?.id ?? '',
      fields: [],
      sections: [],
      websites: [],
      notes: '',
      tags: [],
    };
    await expect(standIn.create(token, item)).rejects.toMatchObject({ kind: 'forbidden' });
  });
});

describe('the development door', () => {
  it('edits, adds and removes items as a person would in 1Password’s app', () => {
    const { fake } = new StandInOnePassword(() => realWorker().api);
    const edited = changeStandIn(fake, { action: 'edit', item: 'Grafana', password: 'changed-in-1password' });
    expect(edited).toMatchObject({ item: { title: 'Grafana', secret: 'changed-in-1password', version: 2 } });
    const added = changeStandIn(fake, {
      action: 'add',
      vault: 'Whombat',
      kind: 'api',
      title: 'Billing API',
      hostname: 'example.com',
      credential: 'stand-in-billing',
    });
    expect(added).toMatchObject({ item: { title: 'Billing API', category: 'ApiCredentials' } });
    expect(changeStandIn(fake, { action: 'remove', items: ['Wiki', 'Forum'] })).toMatchObject({
      removed: [expect.any(String), expect.any(String)],
    });
    const state = changeStandIn(fake, { action: 'state' }) as {
      vaults: { title: string; items: { title: string }[] }[];
    };
    const titles = state.vaults.find((v) => v.title === 'Whombat')?.items.map((i) => i.title);
    expect(titles).toContain('Billing API');
    expect(titles).not.toContain('Wiki');
    expect(() => changeStandIn(fake, { action: 'edit', item: 'Nothing like it' })).toThrow(/No item/);
  });
});
