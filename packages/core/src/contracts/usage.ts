/**
 * Subscription usage (CT-154): Settings → AI → Usage and the compact meter next to the AI provider: the person's own
 * subscriptions (`mine`; `everyone` went in 3.0, CT-1513). A refresh probes the person's subscription for one provider, at most once a minute
 * (`USAGE_REFRESH_MIN_INTERVAL_MS`); updates arrive as `usage.updated` on the `me` topic. Since 0.76 (CT-332) the
 * burrow's AI gateway's pool too (`gateway`, `usage.gateway_updated` on the `burrow` topic).
 */
import { z } from 'zod';
import { GatewayPool } from '../domain/gateway.js';
import { SubscriptionUsage, UsageProvider } from '../domain/usage.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

export const UsageListOutput = z.object({
  /** The person's sign-ins, one per provider they signed in to (none: an empty list). */
  mine: z.array(SubscriptionUsage).max(4),
  /**
   * The burrow's AI gateway (0.76, CT-332; Whombat ai-gateway.md AIG-13): a Fusebox's accounts with their limits, or
   * whether another gateway answers. Null: no
   * gateway connected (absent too). Changes arrive as `usage.gateway_updated` on the `burrow` topic.
   */
  gateway: GatewayPool.nullable().optional(),
});
export type UsageListOutput = z.infer<typeof UsageListOutput>;

export const UsageRefreshBody = z.strictObject({ provider: UsageProvider });
export type UsageRefreshBody = z.infer<typeof UsageRefreshBody>;

export const UsageRefreshOutput = z.object({ usage: SubscriptionUsage });
export type UsageRefreshOutput = z.infer<typeof UsageRefreshOutput>;

/**
 * `error.details` of a refresh asked for too soon (429 `rate_limited`): seconds until the next one is taken. Also
 * `not_found` when the caller has no sign-in for the provider.
 */
export const UsageRefreshTooSoon = z.object({ retryAfter: z.number().int().positive() });
export type UsageRefreshTooSoon = z.infer<typeof UsageRefreshTooSoon>;

export const usageEndpoints = {
  list: endpoint({
    id: 'usage.list',
    method: 'GET',
    path: '/burrows/:burrow/usage',
    summary:
      'Settings → AI → Usage: your Claude and ChatGPT sign-ins with their 5-hour and 7-day windows (`mine`).',
    params: B,
    response: UsageListOutput,
  }),
  refresh: endpoint({
    id: 'usage.refresh',
    method: 'POST',
    path: '/burrows/:burrow/usage/refresh',
    summary:
      'Read the caller’s own subscription usage for one provider now (through the CLI’s own flow). At most once a minute per subscription: sooner answers 429 `rate_limited` with `details.retryAfter` (seconds).',
    params: B,
    body: UsageRefreshBody,
    response: UsageRefreshOutput,
  }),
};
