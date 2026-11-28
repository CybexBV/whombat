import { defaultWhombatHome, sdNotifier } from '@whombat/agent-runtime/host';
import { buildApp } from './app';
import { updateAutomationsWords } from './automations/words';
import { backupsFor } from './backups/service';
import { startSettleRound } from './chats/settle';
import { aiClients } from './clients/service';
import { assertServer, loadConfig, loadDotEnv } from './config';
import { foundScansFor } from './connections/found-scans';
import { createDb } from './db/client';
import { migrationAuthority, prepareSchema, type SchemaStartup, StartupRefused } from './db/startup';
import { startDeviceReader } from './devices/index';
import { reconcilePlans } from './domain/plan-follow';
import { recoverMergeIntents } from './github/merge-intents';
import { hermesHousekeeping } from './hermes-home/housekeeping';
import { closeHermesHome } from './hermes-home/service';
import { homeJobsFor } from './home/jobs';
import { findMyBackgroundFor } from './hosts/findmy-background';
import { startHosts } from './hosts/index';
import { emailDigestFor } from './mail/digest';
import { type ManagedBoot, startManaged } from './managed/boot';
import { withStandIns } from './managed/dev-standins';
import { reconcileOutsidersMarks } from './runtime/outsiders-marks';
import { schedulesFor } from './schedules/ticker';
import { consoleLogger, createServices } from './services';
import { t3WatcherFor } from './t3code/watch';
import { protectEventsFor } from './things/kinds/home/protect-events';
import { moveMcpEntries } from './vault/move-mcp';
import { writeNetworksFile } from './vault/networks';
import { onePasswordSyncFor } from './vault/onepassword/sync';
import { voiceTypingFor } from './voice/service';

loadDotEnv();
// The server writes absolute links into the hosted UI (MR-45) and checks its licence: refuse to boot without them.
assertServer(loadConfig());
// Development and tests: the content identity made at the first start and the manager's socket stood in, no relay
// (hermes-engine.md HE-49). Production has both and is returned as it is.
const standIns = await withStandIns(loadConfig());
const config = standIns.config;
let { sql } = createDb(config.DATABASE_URL);
// The schema first (docs/decisions/managed-db.md MD-02): in production the appliance manager migrates and this boot
// only validates; in development this boot migrates (under the migration lock). A database this build can't use is
// refused with the reason and the way forward; one a newer build contracted past this build's writer floor is
// served read-only (MD-07).
let schema: SchemaStartup;
try {
  schema = await prepareSchema(sql, {
    authority: migrationAuthority(config),
    development: config.NODE_ENV !== 'production',
    onWait: (line) => consoleLogger.warn({}, `migrations: ${line}`),
  });
} catch (err) {
  if (!(err instanceof StartupRefused)) throw err;
  process.stderr.write(`${err.message}\n`);
  await sql.end({ timeout: 5 });
  process.exit(err.exitCode);
}
if (schema.access === 'read-only') {
  await sql.end({ timeout: 5 });
  ({ sql } = createDb(config.DATABASE_URL, { readOnly: true }));
}
const readOnly = schema.access === 'read-only';
const services = createServices({ config, sql, log: consoleLogger, schemaAccess: schema.access });
// The drivers of the report trackers, from the plugins folder (docs/decisions/report-trackers.md).
await services.tracker.drivers.load(defaultWhombatHome({ WHOMBAT_HOME: config.WHOMBAT_HOME }));
const app = await buildApp({ services });
if (readOnly)
  app.log.warn(
    { reason: schema.check.reason, action: schema.check.action },
    'read-only: this Whombat serves reads and refuses writes; no background work runs (docs/decisions/managed-db.md MD-07)',
  );
else {
  // Outbox rows older than a day go (server-efficiency.md SV-05): now and hourly on the housekeeping tick.
  const drained = await services.pipeline.drainOutbox();
  if (drained.deleted) app.log.info(drained, 'outbox rows older than a day removed');
  services.housekeeping.add('outbox prune', 3_600_000, () => services.pipeline.drainOutbox());
  // What outsiders' input wrote that the previous release or an earlier build left unmarked gets the mark, before any
  // device, runner or automation reads it (docs/decisions/outsiders-turns.md).
  const marked = await reconcileOutsidersMarks(services).catch((err: unknown) => {
    app.log.warn({ err: String(err) }, 'outsiders’ marks could not be brought up to date');
    return 0;
  });
  if (marked) app.log.info({ messages: marked }, 'outsiders’ messages marked');
}
// The appliance opens exactly the home network list for this server (vault.md VT-59): written at every boot.
if (
  await writeNetworksFile(services).catch((err: unknown) => {
    app.log.error({ err: String(err) }, 'could not write the Vault home network file');
    return false;
  })
)
  app.log.info({ file: config.WHOMBAT_VAULT_NETWORKS_FILE }, 'Vault home network file written');
if (schema.applied.length) app.log.info({ applied: schema.applied }, 'migrations applied');
if (schema.check.verdict === 'newer_compatible')
  app.log.warn({ reason: schema.check.reason }, 'newer schema');

let managed: ManagedBoot | null = null;
// systemd (NX-20, MR-37): READY once serving, watchdog pings while the event loop turns, STOPPING at shutdown.
const notify = sdNotifier(process.env, { log: (msg) => app.log.warn(msg) });
let stopWatchdog = () => {};
const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  stopWatchdog();
  await notify?.stopping();
  await managed?.close();
  await services.mailTriggers.stop();
  await (await aiClients(services).catch(() => null))?.stop();
  await standIns.manager?.close();
  await app.close();
  closeHermesHome(services);
  services.typing.close();
  emailDigestFor(services).close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.HOST, port: config.PORT });

// The runtime (MA-10): sessions through the relay, the admin socket for the manager; no host admin shell.
managed = await startManaged(services, config, { relay: standIns.relay });
app.log.info(
  {
    appliance: managed.runtime.trust.appliancePeerId,
    adminSocket: config.WHOMBAT_ADMIN_SOCKET,
    ...(standIns.manager
      ? { standIn: { manager: standIns.manager.path, identity: config.WHOMBAT_CONTENT_KEY_FILE } }
      : {}),
  },
  standIns.relay
    ? 'runtime started: sessions through the relay, admin socket for the manager'
    : 'runtime started for development: a stand-in manager, no relay (hermes-engine.md HE-49)',
);

// Background work writes; a read-only start runs none of it (MD-07).
if (!readOnly) {
  // The GitHub poller (docs/github.md): every WHOMBAT_GITHUB_POLL_MS, while this process runs.
  services.github.start();
  await recoverMergeIntents(services, true);
  services.housekeeping.add('merge outcomes', 15_000, () => recoverMergeIntents(services));
  // Uploads never sent and files nothing uses any more go (docs/decisions/bp-attachments.md): now and hourly.
  services.files.start();
  // Backup files (docs/decisions/backup-file.md BF-10): jobs a stop left running fail, expired files go every 10 minutes.
  backupsFor(services).start();
  // Dispatches no runner can take (provider not set up, no runner) get the agent's quiet reply.
  services.runtime.start();
  // Forgotten Hermes sessions, handed to the runner until it takes them (HN-K02; one-person.md OP-S47).
  hermesHousekeeping(services).start();
  // The Vault's MCP entries move to Connections (docs/decisions/vault-simplify.md VLT-30).
  void moveMcpEntries(services).catch((err: unknown) =>
    app.log.warn({ err: String(err) }, 'vault: moving MCP entries to Connections did not run'),
  );
  // Plan steps follow their linked work: whatever moved while no process listened shows up (WS-05).
  void reconcilePlans(services)
    .then((n) => n && app.log.info({ plans: n }, 'plan steps caught up with their linked work'))
    .catch((err) => app.log.warn({ err: String(err) }, 'plan reconcile failed'));
  // Turns agents scheduled for themselves (resourceful-agents.md RA-30): due ones queued every 30 seconds.
  schedulesFor(services).start();
  // Supervised automations (docs/decisions/bp-automations.md): active in one process (advisory lock); at boot
  // it also recovers approvals a crash left executing or approved-but-unexecuted.
  services.automations.start();
  // An automation that still has an earlier version's own words takes this version's.
  void updateAutomationsWords(services)
    .then((n) => n && app.log.info({ automations: n }, 'automations took this version’s wording'))
    .catch((err) => app.log.warn({ err: String(err) }, 'automations’ wording update failed'));
  // Whombat Feedback (docs/decisions/feedback.md): the assessment worker and the retention sweep.
  services.feedback.start();
  // Report trackers through automations (docs/decisions/report-trackers.md TA-05): the connections automations read.
  services.tracker.start();
  // Connected mailboxes watched by live mail-triggered automations.
  services.mailTriggers.start();
  // Find My read in the background where a connection asks or an automation listens (findmy-connection.md).
  findMyBackgroundFor(services).start();
  // A linked 1Password vault kept in step with the Vault: a pass now, every 10 minutes and after a change.
  onePasswordSyncFor(services).start();
  // The AI gateway (docs/decisions/ai-gateway.md AIG-11): each gateway connection read every minute, alerts to the
  // person.
  services.gateway.start();
  // Devices switched on (one-whombat-devices.md ONE-DD12): their readings every 5 minutes, reads only.
  startDeviceReader(services);
  // UniFi Protect's detections (service-dashboards.md SD-S20): each active Protect connection's event stream followed,
  // the last 24 hours kept for its page; older ones removed hourly.
  protectEventsFor(services).start();
  // Found on your network by itself (desk-found.md DF-02): each start, daily, and as soon as the person has an
  // assistant; the assistant says once what it found (DF-05).
  foundScansFor(services).start();
  // Site cards published and drops collected through the manager (docs/decisions/feedback-drop.md).
  managed.runtime.startFeedbackDrop();
  // The data disk checked every 10 minutes, the person told at 85 % and 95 % (docs/decisions/box-status.md BS-09).
  managed.runtime.startHostDiskAlerts();
  // The box's network read every minute: a cable that stopped, the cable as the backup, an address change (network-move.md).
  managed.runtime.startBoxNetworkWatch();
  // The power read every minute, the person told when it goes out, runs low and comes back (desk-display.md DK-10).
  managed.runtime.startHostPower();
  // Remote help's events followed, signed and told to the person (docs/decisions/remote-help-server.md RH-S05).
  managed.runtime.startRemoteHelp();
  // Voice typing's speech models (docs/decisions/dictation.md): what the settings want is asked for now and after
  // every change, and a download's progress is told to the person.
  voiceTypingFor(services).start();
  // The assistant's suggestions and old guide cards expiring (assistant-guides.md AG-11).
  services.guides.start();
  // One Whombat (one-whombat-assistant.md ONE-DW21): Approve later, widget refreshes, connection health.
  homeJobsFor(services).start();
  // Finished threads in Chat and Feedback settle by themselves, every 15 minutes (docs/decisions/chat-settle.md).
  startSettleRound(services);
  // T3 Code threads the agent handed work to wake it when they finish or ask something (docs/decisions/t3code.md).
  t3WatcherFor(services).start();
  // Subscription usage (docs/decisions/ui-improvements.md UI-R10): probes on schedule, snapshots and alerts.
  services.usage.start();
  // Notification email (docs/decisions/essentials-people.md EP-15): with SMTP only (HE-56).
  emailDigestFor(services).start();
  // Servers (docs/decisions/one-whombat-servers.md): the hosts service's events, realtime and the Servers connection.
  startHosts(services);
  // The AI clients (SUB-09): catch up with the manager.
  void aiClients(services)
    .then((clients) => clients.start())
    .catch((err) => app.log.warn({ err: String(err) }, 'AI clients: not started'));
}

if (config.WHOMBAT_DEMO && !readOnly) {
  // WHOMBAT_DEMO=1: the storyline plays (or picks up where it was) once the runner is around.
  setTimeout(() => {
    services.demo
      .autoplay()
      .then((r) => app.log.info(r, 'demo storyline'))
      .catch((err) => app.log.warn({ err: String(err) }, 'demo storyline did not start'));
  }, 2000).unref();
}

await notify?.ready(readOnly ? 'serving read-only' : 'serving');
stopWatchdog = notify?.watchdog() ?? (() => {});
