/** The business services' kinds (service-dashboards.md SD-60…SD-65, GitHub Actions; brief `docs/implementation/service-dashboards/assignment.md`; T3 Code, t3code.md). */
import type { KindModule } from '../registry';
import { HUBSPOT_KIND, PIPEDRIVE_KIND } from './crm';
import { FORGEJO_KIND, GITLAB_KIND } from './git';
import { GITHUB_ACTIONS_KIND } from './github-actions';
import { MOLLIE_KIND } from './mollie';
import { MONEYBIRD_KIND } from './moneybird';
import { PLAUSIBLE_KIND } from './plausible';
import { T3CODE_KIND } from './t3code';
import { TODOIST_KIND } from './todoist';

export const BUSINESS_KINDS: Record<string, KindModule> = {
  mollie: MOLLIE_KIND,
  moneybird: MONEYBIRD_KIND,
  plausible: PLAUSIBLE_KIND,
  hubspot: HUBSPOT_KIND,
  pipedrive: PIPEDRIVE_KIND,
  gitlab: GITLAB_KIND,
  forgejo: FORGEJO_KIND,
  github_actions: GITHUB_ACTIONS_KIND,
  todoist: TODOIST_KIND,
  t3code: T3CODE_KIND,
};
