/**
 * The server's service container: database, key custody, realtime bus, typing, mail, the commit pipeline
 * and the approvals engine. Built once per process (or per test) by `createServices()`; the Fastify app
 * and scripts (seed, audit:verify) share it.
 */

import { runCommandExecutor } from './agent-commands/commands';
import { publishServicesChanged } from './agent-services/frames';
import { AgentServices } from './agent-services/service';
import { ApprovalEngine } from './approvals/engine';
import { registerApprovalExecutors } from './approvals/executors';
import { grantKeyExecutor } from './approvals/grant-key';
import { AutomationEngine, type EngineOptions } from './automations/engine';
import { knownRelease, NewerAutomationsGate, releaseSchema } from './automations/release-gate';
import { CollabService, type CollabTimings } from './collab/service';
import { registerCommands } from './commands/index';
import { Pipeline } from './commit/pipeline';
import type { Config } from './config';
import {
  connectionCallExecutor,
  connectionCallReconciler,
  registerConnectionApprovalReads,
} from './connections/approvals';
import { callConnectionTool } from './connections/call';
import { onConnectionLifecycle } from './connections/lifecycle';
import { evictConnection } from './connections/pool';
import { registerConnectorExecutors } from './connectors/executors';
import { createGoogleServices } from './connectors/index';
import type { GoogleServices } from './connectors/types';
import { type Database, drizzleFor, type Sql } from './db/client';
import { DemoDirector } from './demo/director';
import { LiveActivityBroadcaster } from './domain/live-activity';
import { FeedbackService } from './feedback/service';
import { AttachmentFiles } from './files/service';
import { GatewayService } from './gateway/service';
import { GitHubService } from './github/service';
import { GuideService } from './guides/service';
import { setUpHosts } from './hosts/index';
import { KeyCustody } from './keys/custody';
import { BackgroundWork } from './lib/background';
import { Housekeeping } from './lib/housekeeping';
import { LicenceGate, MaintenanceGate } from './lib/maintenance';
import { type Clock, systemClock } from './lib/time';
import { BoxMail } from './mail/box';
import { createMailer, type Mailer } from './mail/mailer';
import { MailTriggerService } from './mail-triggers/index';
import { PushSender } from './push/sender';
import { RealtimeBus } from './realtime/bus';
import { TypingService } from './realtime/typing';
import { RunnerRuntime, type RuntimeOptions } from './runtime/service';
import { reportUnregisteredChecks } from './things/quiet/defaults';
import { TrackerService } from './trackers/service';
import { UsageService } from './usage/service';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {}, debug() {} };

export const consoleLogger: Logger = {
  info: (o, m) => console.log(m ?? '', typeof o === 'string' ? o : JSON.stringify(o)),
  warn: (o, m) => console.warn(m ?? '', typeof o === 'string' ? o : JSON.stringify(o)),
  error: (o, m) => console.error(m ?? '', o),
  debug: () => {},
};

export interface Services {
  config: Config;
  sql: Sql;
  db: Database;
  /**
   * `read-only`: a newer Whombat migrated the database past this build's writer floor (docs/decisions/
   * managed-db.md MD-07). The pool refuses writes, the app answers them `read_only` and no worker starts.
   */
  schemaAccess: 'read-write' | 'read-only';
  log: Logger;
  custody: KeyCustody;
  bus: RealtimeBus;
  typing: TypingService;
  mailer: Mailer;
  clock: Clock;
  pipeline: Pipeline;
  approvals: ApprovalEngine;
  /** Runner protocol: dispatch claims, leases, progress (runtime-server.md). */
  runtime: RunnerRuntime;
  /** The scripted demo storyline (play / rewind). */
  demo: DemoDirector;
  /** GitHub: the adapter (the host's gh or the fake), the poller, git credentials, deploys (docs/github.md). */
  github: GitHubService;
  /** Collaborative canvases: Hocuspocus at `/collab`, Yjs storage, awareness (collab-server.md). */
  collab: CollabService;
  /** Web push / FCM / APNs dispatch, with retry and device pruning (TODO 9.4). */
  push: PushSender;
  /** The person's own mail server (hermes-engine.md HE-61, HE-S224): where the box's email goes when one is set. */
  boxMail: BoxMail;
  /** Derives run/approval live activities and throttles their push updates (TODO 9.4). */
  liveActivity: LiveActivityBroadcaster;
  /**
   * The person's Google accounts (docs/decisions/connectors.md CN-08): sign-in, the service calls behind
   * the connector tools and the token store, for `WHOMBAT_GOOGLE=real|fake|off`.
   */
  google: GoogleServices;
  /** Attachment bytes, limits and the orphan sweep (docs/decisions/bp-attachments.md). */
  files: AttachmentFiles;
  /** Supervised automations: triggers, schedules and durable runs (docs/decisions/bp-automations.md). */
  automations: AutomationEngine;
  /** Whombat Feedback: intake limits, the assessment worker and retention (docs/decisions/feedback.md). */
  feedback: FeedbackService;
  /**
   * Tracker reports through automations (docs/decisions/report-trackers.md): the poller of the tracker connections a
   * live automation listens to, and the drivers the steps, tools and people's actions talk to each tracker through.
   */
  tracker: TrackerService;
  /** Watches connected mailboxes for live mail-triggered automations (IMAP IDLE or provider change feeds). */
  mailTriggers: MailTriggerService;
  /**
   * The AI gateway (docs/decisions/ai-gateway.md): the watcher that reads each gateway connection's pool every minute,
   * stores it, publishes changes and alerts the person.
   */
  gateway: GatewayService;
  /**
   * Guided setup in the personal assistant's DM (docs/decisions/assistant-guides.md): the welcome, the hooks for
   * Google connects, app saves and reauth, and suggestions.
   */
  guides: GuideService;
  /**
   * Subscription usage (docs/decisions/ui-improvements.md UI-R09…): snapshots from probes and turns, the probe schedule,
   * `usage.updated` frames and the assistant's alerts.
   */
  usage: UsageService;
  /** The drain gate (managed updates, MR-15): no new turns, executions or automation steps while draining. */
  maintenance: MaintenanceGate;
  /**
   * Work after a commit that doesn't hold its response (server-efficiency.md SV-02): unread badges, a message's
   * notification fan-out, push delivery. `settle()` waits for it (shutdown, tests).
   */
  background: BackgroundWork;
  /**
   * One tick for the small periodic jobs (server-efficiency.md SV-03): lease sweep, feedback sources, welcomes, the
   * realtime credential re-check, the usage schedule, the outbox prune.
   */
  housekeeping: Housekeeping;
  /**
   * The appliance licence (LC-10, MR-58): the managed runtime installs its state; a self-hosted server never does, so
   * nothing is refused there (LC-12).
   */
  licence: LicenceGate;
  /**
   * Managed (parity G-10, MR-45): where links the server writes point — the hosted UI (`WHOMBAT_APP_URL`) at this
   * appliance (`/appliances/<device id>`), set by the managed runtime; null elsewhere.
   */
  links: { managedBase: string | null };
  /** The agent's services: containers it keeps up (docs/decisions/one-person.md OP-19). */
  agentServices: AgentServices;
  /**
   * Whether automations the release before them can't run (started by mail, changing connected services) may be made,
   * turned on and run: only once the release the box would go back to knows them (automations/release-gate.ts).
   */
  newerAutomations: NewerAutomationsGate;
}

export interface ServiceDeps {
  config: Config;
  sql: Sql;
  /** Default `read-write`; `read-only` with a pool made by `createDb(url, { readOnly: true })`. */
  schemaAccess?: 'read-write' | 'read-only';
  log?: Logger;
  mailer?: Mailer;
  clock?: Clock;
  runtime?: Partial<RuntimeOptions>;
  collab?: Partial<CollabTimings>;
  automations?: Partial<EngineOptions>;
}

export function createServices(deps: ServiceDeps): Services {
  const log = deps.log ?? silentLogger;
  const custody = new KeyCustody(deps.config.WHOMBAT_MASTER_KEY);
  if (custody.usingDevKey && deps.config.NODE_ENV !== 'test') {
    log.warn('WHOMBAT_MASTER_KEY is not set: using the public development master key (see .env.example).');
  }
  const bus = new RealtimeBus();
  const clock = deps.clock ?? systemClock;
  const services = {
    config: deps.config,
    sql: deps.sql,
    db: drizzleFor(deps.sql),
    schemaAccess: deps.schemaAccess ?? 'read-write',
    log,
    custody,
    bus,
    typing: new TypingService(bus, clock),
    mailer: deps.mailer,
    clock,
    maintenance: new MaintenanceGate(),
    background: new BackgroundWork(() => services.log),
    housekeeping: new Housekeeping(() => services.log),
    licence: new LicenceGate(),
    links: { managedBase: null },
    newerAutomations: new NewerAutomationsGate(
      deps.config,
      (id) => knownRelease(services.db, id),
      (id) => releaseSchema(services.db, id),
    ),
  } as Services;
  // The app swaps in its own logger later; mail resolves it when sending.
  // The person's own mail server (HE-61, HE-S225) takes the box's mail when one is set.
  services.boxMail = new BoxMail(services);
  services.mailer ??= createMailer(
    deps.config,
    () => services.log,
    undefined,
    () => services.boxMail.outgoing(),
  );
  services.files = new AttachmentFiles(services);
  services.pipeline = new Pipeline(services);
  registerCommands(services.pipeline);
  services.approvals = new ApprovalEngine(services);
  // What a yes carries out; nothing is simulated (docs/decisions/essentials-agents.md EA-02).
  registerApprovalExecutors(services.approvals);
  services.google = createGoogleServices(services);
  registerConnectorExecutors(services.approvals);
  services.approvals.setExecutor('grant_key', grantKeyExecutor);
  // `vault_use` has no executor any more (hermes-engine.md HE-43): nothing asks to use a Vault entry.
  // The person's yes to one of the agent's commands: once, for the task, or always (agent-computer.md AC-42).
  services.approvals.setExecutor('run_command', runCommandExecutor);
  // A yes to a connection tool call runs its deferred call once (connections-catalog.md CX-21).
  services.approvals.setExecutor('connection_call', connectionCallExecutor);
  // A crash while one ran: its own records say whether it never ran, finished, or may have reached the service.
  services.approvals.setReconciler(callConnectionTool.name, connectionCallReconciler(services.db));
  registerConnectionApprovalReads(services);
  // Servers (one-whombat-servers.md): the Servers tools' adapter, the Home sources and the undoers.
  setUpHosts();
  // A check no list registered starts off (watch-defaults.md): said once in the log so it gets its own decision.
  reportUnregisteredChecks((check) =>
    services.log.warn({ check }, 'a check without a watch decision starts off'),
  );
  // A connection removed, or its credential, address, sign-in or state changed: its pooled MCP client goes (CX-24).
  onConnectionLifecycle(services, (event) =>
    event.type === 'tiers' ? undefined : evictConnection(services, event.connectionId),
  );
  services.automations = new AutomationEngine(services, deps.automations);
  services.feedback = new FeedbackService(services);
  services.tracker = new TrackerService(services);
  services.mailTriggers = new MailTriggerService(services);
  services.gateway = new GatewayService(services);
  services.guides = new GuideService(services);
  services.usage = new UsageService(services);
  services.agentServices = AgentServices.fromConfig(deps.config);
  services.agentServices.onChange(() => void publishServicesChanged(services));
  services.runtime = new RunnerRuntime(services, deps.runtime);
  services.github = new GitHubService(services);
  if (services.github.adapter) services.runtime.gitHost = services.github;
  services.demo = new DemoDirector(services);
  services.collab = new CollabService(services, deps.collab);
  services.push = new PushSender(services.db, services.config, services.log);
  services.liveActivity = new LiveActivityBroadcaster(services.db, services.push, clock);
  return services;
}
