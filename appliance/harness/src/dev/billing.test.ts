import { scryptSync } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPERATOR_PERMISSIONS } from '@whombat/control-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  billingEnv,
  DEFAULT_PANEL_ALLOWED,
  ensureOperatorPermissions,
  PASSWORD_HASH,
  panelAllowed,
  preparePanel,
  readCredentials,
  readPanelUsers,
  scryptHash,
  upsertPanelUser,
} from './billing.ts';
import type { EnvState } from './env.ts';

const tmp = () => mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'billing-'));
const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env))
    if (k.startsWith('WB_MGD_') && !(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});

describe('billing settings for control (IN-69)', () => {
  it('manual by default; Stripe needs both files; the signup mode is checked', () => {
    delete process.env.WB_MGD_BILLING_PROVIDER;
    delete process.env.WB_MGD_SIGNUP_MODE;
    expect(billingEnv()).toEqual({ BILLING_PROVIDER: 'manual' });
    process.env.WB_MGD_BILLING_PROVIDER = 'stripe';
    expect(() => billingEnv()).toThrow(/WB_MGD_STRIPE_SECRET_KEY_FILE and WB_MGD_STRIPE_WEBHOOK_SECRET_FILE/);
    const dir = tmp();
    writeFileSync(join(dir, 'key'), 'sk_test_x');
    writeFileSync(join(dir, 'hook'), 'whsec_x');
    process.env.WB_MGD_STRIPE_SECRET_KEY_FILE = join(dir, 'key');
    process.env.WB_MGD_STRIPE_WEBHOOK_SECRET_FILE = join(dir, 'hook');
    process.env.WB_MGD_SIGNUP_MODE = 'invite';
    expect(billingEnv()).toEqual({
      BILLING_PROVIDER: 'stripe',
      STRIPE_SECRET_KEY_FILE: join(dir, 'key'),
      STRIPE_WEBHOOK_SECRET_FILE: join(dir, 'hook'),
      SIGNUP_MODE: 'invite',
    });
    process.env.WB_MGD_SIGNUP_MODE = 'closed';
    expect(() => billingEnv()).toThrow(/open, waitlist or invite/);
    process.env.WB_MGD_BILLING_PROVIDER = 'paypal';
    expect(() => billingEnv()).toThrow(/manual or stripe/);
  });

  it('the allowlist is never empty: loopback unless WB_MGD_PANEL_ALLOWED_NETWORKS', () => {
    delete process.env.WB_MGD_PANEL_ALLOWED_NETWORKS;
    expect(panelAllowed()).toEqual(DEFAULT_PANEL_ALLOWED);
    process.env.WB_MGD_PANEL_ALLOWED_NETWORKS = ' 203.0.113.44/32 , 2001:db8:8355::/64 ,';
    expect(panelAllowed()).toEqual(['203.0.113.44/32', '2001:db8:8355::/64']);
  });
});

describe('panel users (BL-27, IN-70)', () => {
  it('hashes in control’s scrypt format', () => {
    const h = scryptHash('correct horse', 14);
    expect(h).toMatch(PASSWORD_HASH);
    const [, n, r, p, salt, key] = h.split('$');
    const again = scryptSync('correct horse', Buffer.from(salt ?? '', 'base64url'), 32, {
      N: 2 ** Number(n),
      r: Number(r),
      p: Number(p),
    });
    expect(again.toString('base64url')).toBe(key);
  });

  it('reads a credentials file without the password', () => {
    const f = join(tmp(), 'creds');
    writeFileSync(
      f,
      'username=john\npassword=hunter2-secret\nhash=scrypt$16$8$1$abc$def\nallowed=1.2.3.4/32,2001:db8::/64\n',
    );
    const c = readCredentials(f);
    expect(c).toEqual({
      username: 'john',
      hash: 'scrypt$16$8$1$abc$def',
      allowed: ['1.2.3.4/32', '2001:db8::/64'],
    });
    expect(JSON.stringify(c)).not.toContain('hunter2');
  });

  it('the users file is written 0600 and a user replaced by name', () => {
    const f = join(tmp(), 'users.json');
    upsertPanelUser(f, { username: 'john', passwordHash: 'a', operator: 'local-operator' });
    upsertPanelUser(f, { username: 'ann', passwordHash: 'b', operator: 'local-operator' });
    upsertPanelUser(f, { username: 'john', passwordHash: 'c', operator: 'local-operator' });
    expect(readPanelUsers(f).map((u) => [u.username, u.passwordHash])).toEqual([
      ['ann', 'b'],
      ['john', 'c'],
    ]);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('a local environment gets the harness user; a configured users file is used as is', () => {
    delete process.env.WB_MGD_PANEL_USERS_FILE;
    const dir = tmp();
    const state = { services: {} } as unknown as EnvState;
    const env = preparePanel(state, dir, () => {});
    expect(env.PANEL_USERS_FILE).toBe(join(dir, 'panel-users.json'));
    expect(env.PANEL_ALLOWED_NETWORKS).toBe(DEFAULT_PANEL_ALLOWED.join(','));
    expect(state.panel?.users).toEqual(['harness']);
    const password = readFileSync(state.panel?.harnessPasswordFile ?? '', 'utf8');
    expect(password.length).toBeGreaterThanOrEqual(24);
    const again = preparePanel(state, dir, () => {});
    expect(readFileSync(state.panel?.harnessPasswordFile ?? '', 'utf8')).toBe(password);
    expect(again.PANEL_USERS_FILE).toBe(env.PANEL_USERS_FILE);

    const mine = join(dir, 'mine.json');
    process.env.WB_MGD_PANEL_USERS_FILE = mine;
    const missing = preparePanel(state, dir, () => {});
    expect(missing.PANEL_USERS_FILE).toBe(join(dir, 'panel-users.none.json'));
    expect(state.panel?.users).toEqual([]);
    expect(state.panel?.harnessPasswordFile).toBeUndefined();
    upsertPanelUser(mine, { username: 'john', passwordHash: 'x', operator: 'local-operator' });
    expect(preparePanel(state, dir, () => {}).PANEL_USERS_FILE).toBe(mine);
    expect(state.panel?.users).toEqual(['john']);
  });
});

describe('the dev operator’s permissions (BL-28)', () => {
  it('adds the missing ones to local-operator only, once', () => {
    const dir = tmp();
    const f = join(dir, 'operators.json');
    writeFileSync(
      f,
      JSON.stringify({
        operators: [
          { id: 'local-operator', tokenSha256: 'a'.repeat(64), permissions: ['fleet.read', 'billing.write'] },
          { id: 'reader', tokenSha256: 'b'.repeat(64), permissions: ['fleet.read'] },
        ],
      }),
    );
    const lines: string[] = [];
    ensureOperatorPermissions(dir, (l) => lines.push(l));
    ensureOperatorPermissions(dir, (l) => lines.push(l));
    const doc = JSON.parse(readFileSync(f, 'utf8'));
    expect([...doc.operators[0].permissions].sort()).toEqual([...OPERATOR_PERMISSIONS].sort());
    expect(doc.operators[1].permissions).toEqual(['fleet.read']);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('customers.read');
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});
