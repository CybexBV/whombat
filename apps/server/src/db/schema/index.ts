/**
 * Drizzle schema. Run `pnpm --filter @whombat/server db:generate` to create a migration after changing it, then give it
 * its `compat.json` entry. It matches the baseline (`migrations/0000_baseline.sql`, one-agent.md OA-S84) except what
 * only SQL says: `events_append_only()` and its triggers on `events` and `appliance_events`, the INCLUDE columns of
 * `events_listed_kind_idx` and `messages_top_level_idx`, and `authz_generation_seq`.
 */
export * from './activity';
export * from './attachments';
export * from './automations';
export * from './backup-keys';
export * from './backup-places';
export * from './backups';
export * from './check-servers';
export * from './code';
export * from './collab';
export * from './commands';
export * from './connection-events';
export * from './connections-catalog';
export * from './connectors';
export * from './content';
export * from './conversations';
export * from './councils';
export * from './delegations';
export * from './deployments';
export * from './desk';
export * from './devices';
export * from './events';
export * from './exposure';
export * from './feedback';
export * from './findmy';
export * from './followed-tasks';
export * from './gateway';
export * from './github';
export * from './guides';
export * from './hermes';
export * from './home';
export * from './incidents';
export * from './kept-sites';
export * from './looks-ahead';
export * from './mail-triggers';
export * from './managed';
export * from './merges';
export * from './onepassword';
export * from './principals';
export * from './prompts';
export * from './quiet';
export * from './quiet-windows';
export * from './repo-manager';
export * from './repo-setup';
export * from './schedules';
export * from './server-asks';
export * from './server-cares';
export * from './server-names';
export * from './shares';
export * from './t3code';
export * from './team-reports';
export * from './tenancy';
export * from './thread-places';
export * from './tracker';
export * from './usage';
export * from './vault';
export * from './voice';
export * from './work';
