/**
 * Subscription usage (docs/decisions/ui-improvements.md UI-R14; contracts CT-154): Settings → AI → Usage and the meter next
 * to the AI provider. The person's only (one-person.md OP-S74).
 */
import { api } from '@whombat/core';
import { route } from '../routes/define';

export const usageRoutes = [
  route(api.usage.list, async ({ access, services }) =>
    services.usage.list(access.principal, access.burrow.id),
  ),

  route(api.usage.refresh, async ({ access, body, services }) => ({
    usage: await services.usage.refresh(access.principal, access.burrow.id, body.provider),
  })),
];
