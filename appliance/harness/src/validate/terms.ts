/**
 * The appliance terms gate (LC-17, IN-42): the public copy the hosted app renders at `/legal/appliance-terms`
 * (whombat-app `apps/web/src/legal/appliance-terms.md`) must equal the copy kept with the appliance
 * (`docs/legal/appliance-terms.md`) byte for byte, both at their pinned commits. From contracts 0.10.0 on (the terms
 * accepted at claim, LC-18); earlier pins have no terms.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { type Component, type Pins, sourceOf } from '../manifest/pins.ts';
import { contractsAtLeast } from '../manifest/version.ts';

export const APP_TERMS = 'apps/web/src/legal/appliance-terms.md';
export const APPLIANCE_TERMS = 'docs/legal/appliance-terms.md';

export interface TermsCheck {
  ok: boolean;
  summary: string;
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex').slice(0, 16);

/** Compares the two texts byte for byte; on a difference names the first differing line. */
export function compareTerms(app: Buffer | null, appliance: Buffer | null): TermsCheck {
  if (!appliance) return { ok: false, summary: `${APPLIANCE_TERMS} missing at the pinned appliance commit` };
  if (!app) return { ok: false, summary: `${APP_TERMS} missing at the pinned app commit` };
  if (app.equals(appliance))
    return { ok: true, summary: `identical (${appliance.length} bytes, sha256 ${sha(appliance)}…)` };
  const a = app.toString('utf8').split('\n');
  const b = appliance.toString('utf8').split('\n');
  let i = 0;
  while (i < Math.max(a.length, b.length) && a[i] === b[i]) i++;
  return {
    ok: false,
    summary: `differ from line ${i + 1} (app sha256 ${sha(app)}…, appliance ${sha(appliance)}…): app ${JSON.stringify((a[i] ?? '<end>').slice(0, 80))} vs appliance ${JSON.stringify((b[i] ?? '<end>').slice(0, 80))}`,
  };
}

/**
 * The file's exact bytes at a commit of the repository in `source` (null when it isn't there): below the component's
 * folder when that commit holds the component in one (the appliance is `appliance/` of the one repository), at the
 * top for a commit from before it moved.
 */
export function fileAtPin(
  source: string,
  commit: string,
  dir: string | undefined,
  path: string,
): Buffer | null {
  const at = (p: string): Buffer | null => {
    try {
      return execFileSync('git', ['-C', source, 'show', `${commit}:${p}`], {
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch {
      return null;
    }
  };
  return (dir ? at(`${dir}/${path}`) : null) ?? at(path);
}

const show = (c: Component, path: string) => fileAtPin(sourceOf(c), c.commit, c.dir, path);

/** The gate for a pin set, or null when it doesn't apply (contracts before 0.10.0). */
export function termsGate(pins: Pins): (TermsCheck & { app: Component; appliance: Component }) | null {
  if (!contractsAtLeast('0.10.0')) return null;
  const app = pins.components.find((c) => c.id === 'whombat-app');
  const appliance = pins.components.find((c) => c.repository === 'whombat-appliance');
  if (!app || !appliance) return null;
  return { ...compareTerms(show(app, APP_TERMS), show(appliance, APPLIANCE_TERMS)), app, appliance };
}
