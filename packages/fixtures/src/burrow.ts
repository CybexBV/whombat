/**
 * The burrow and its connected repos. `REPOS` in `Whombat Desktop.dc.html`:
 * `const REPOS = [{n:'whombat/billing',d:'TypeScript · updated 2 hours ago'},{n:'whombat/web',d:'TypeScript · updated today'},
 * {n:'whombat/infra',d:'HCL · updated Monday'},{n:'whombat/docs',d:'Markdown · updated last week'}];`
 */
import type { Burrow, Repo } from '@whombat/core/domain';
import { at } from './time.js';

export const BURROW_ID = 'bur_burrow-hq';

export const burrow: Burrow = {
  id: BURROW_ID,
  name: 'Burrow HQ',
  slug: 'burrow-hq',
  timeZone: 'Europe/Amsterdam',
  localModel: null,
  webSearch: null,
  createdAt: '2026-01-05T09:00:00.000Z',
};

export const rep_billing: Repo = {
  id: 'rep_billing',
  burrowId: BURROW_ID,
  fullName: 'whombat/billing',
  description: 'Billing service and invoicing.',
  language: 'TypeScript',
  defaultBranch: 'main',
  enabled: true,
  pushedAt: at('09:22'),
};

export const rep_web: Repo = {
  id: 'rep_web',
  burrowId: BURROW_ID,
  fullName: 'whombat/web',
  description: 'Customer-facing web app.',
  language: 'TypeScript',
  defaultBranch: 'main',
  enabled: true,
  pushedAt: at('08:00'),
};

export const rep_infra: Repo = {
  id: 'rep_infra',
  burrowId: BURROW_ID,
  fullName: 'whombat/infra',
  description: 'Infrastructure as code.',
  language: 'HCL',
  defaultBranch: 'main',
  enabled: true,
  pushedAt: at('09:00', -2),
};

export const rep_docs: Repo = {
  id: 'rep_docs',
  burrowId: BURROW_ID,
  fullName: 'whombat/docs',
  description: 'Team documentation.',
  language: 'Markdown',
  defaultBranch: 'main',
  enabled: false,
  pushedAt: at('09:00', -7),
};

export const REPOS: Repo[] = [rep_billing, rep_web, rep_infra, rep_docs];

export function repo(id: string): Repo | undefined {
  return REPOS.find((r) => r.id === id);
}
