/**
 * `dev/stripe setup` — Stripe test mode for the dev environment (control BL-12, BL-20, IN-70; docs/runbooks/
 * dev-instance.md, “Switching to Stripe test mode”). Runs control's `pnpm stripe:setup` with the environment control
 * runs with and the key in `WB_MGD_STRIPE_SECRET_KEY_FILE`: products and prices from the plans table, the portal
 * configuration, and the webhook endpoint at `<public control>/v1/billing/stripe/webhook`, whose signing secret goes to
 * `WB_MGD_STRIPE_WEBHOOK_SECRET_FILE` (0600; an existing endpoint keeps its secret). Idempotent. Then set
 * `WB_MGD_BILLING_PROVIDER=stripe` and restart.
 *
 * Only test keys (`sk_test_…`, `rk_test_…`): the dev environment's control runs as CONTROL_ENV=local. The key is never
 * printed or copied.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, publicUrls } from '../lib/paths.ts';
import { baseEnv } from '../lib/proc.ts';
import { loadEnv } from './env.ts';
import { controlEnv } from './services.ts';

const need = (name: string): string => {
  const v = (process.env[name] ?? '').trim();
  if (!v) throw new Error(`set ${name} (the maintainers' dev-instance runbook)`);
  return expandHome(v);
};

if (import.meta.main) {
  const cmd = process.argv[2] ?? '';
  if (cmd !== 'setup') throw new Error('usage: dev/stripe setup');
  const state = loadEnv();
  const src = state?.sources['whombat-api'];
  if (!state?.control || !src) throw new Error('no control in this environment: dev/up first');
  if (!publicUrls)
    throw new Error(
      'Stripe sends webhooks to the public control URL: run it on a public instance (WB_MGD_PUBLIC_CONTROL)',
    );
  const key = need('WB_MGD_STRIPE_SECRET_KEY_FILE');
  const secretOut = need('WB_MGD_STRIPE_WEBHOOK_SECRET_FILE');
  if (!existsSync(key)) throw new Error(`${key} doesn't exist (a Stripe test secret key, one line, 0600)`);
  if (!/^(sk|rk)_test_[0-9A-Za-z]{8,}$/.test(readFileSync(key, 'utf8').trim()))
    throw new Error(
      `${key} is not a Stripe test key (sk_test_… or rk_test_…); the dev environment takes no live key`,
    );
  const env = {
    ...controlEnv(state, join(state.control.dir, '.local')),
    // The webhook secret doesn't exist before the first run; the setup reads the key itself (BL-20).
    BILLING_PROVIDER: 'manual',
    STRIPE_SECRET_KEY_FILE: key,
    STRIPE_WEBHOOK_SECRET_FILE: undefined,
  };
  process.stderr.write(
    `stripe:setup against ${key} (test mode); webhook ${publicUrls.control}/v1/billing/stripe/webhook → secret ${secretOut}\n`,
  );
  const r = spawnSync('pnpm', ['--silent', 'stripe:setup', '--webhook-secret-out', secretOut], {
    cwd: src.path,
    env: baseEnv(env),
    stdio: 'inherit',
  });
  if (r.status !== 0) throw new Error(`pnpm stripe:setup exited with ${r.status ?? r.signal}`);
  process.stderr.write(
    existsSync(secretOut)
      ? 'Next: WB_MGD_BILLING_PROVIDER=stripe in the env file, then restart (systemctl --user restart whombat-stack-dev).\n'
      : `No webhook secret at ${secretOut}: the endpoint existed already and keeps its secret (Stripe dashboard → Webhooks → Reveal).\n`,
  );
}
