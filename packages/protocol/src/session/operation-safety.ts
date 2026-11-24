/**
 * Operation safety (CT-194, 0.29.1 CT-195): what a client may do by itself with a request whose answer it never got — the connection
 * dropped, the deadline passed, the session closed. Two separate facts about every operation, classified by hand here,
 * one entry per op of `API_OPERATIONS` and `SESSION_OPERATIONS` (a missing or extra entry fails typecheck and
 * `operation-safety.test.ts`), and copied onto each `OperationSpec`:
 *
 * - `destructive`: irreversible or high-impact — a removal, a revocation, a merge, a decision that acts, a cancelled run,
 *   a redaction, a replaced recovery key, another device let in. A client never sends one again by itself after an
 *   ambiguous delivery, whatever `retry` says: a person decides.
 * - `retry` (`OperationRetry`), what makes asking again safe:
 *   - `safe`: nothing durable happens (every op that doesn't mutate). Ask again, the same request.
 *   - `receipt`: a mutation the runtime's receipt covers (MA-09, MR-06): everything it does before its first
 *     commit-pipeline transaction is harmless to repeat, and that transaction marks the receipt `accepted`. After a lost
 *     answer ask `status` first: a finished receipt gives back the stored outcome, `accepted`/`executing` is waited for,
 *     and `not_found` means it never committed — but only within the receipt retention (finished receipts are swept after
 *     `WHOMBAT_COMMAND_RECEIPT_HOURS`, 7 days by default) and only for a request never seen acknowledged (`accepted`, or
 *     `status` saying `accepted`/`executing`; afterwards `not_found` means the receipt expired). Then the same request
 *     (same id, exact input) may be sent again, and the runtime runs it at most once. It proves no absence of effect for
 *     the few `receipt` ops that act, harmlessly to repeat, before their commit (a read-only probe, an idempotent install).
 *   - `never`: never sent again by itself. Either `not_found` proves nothing — the op acts outside its receipt's
 *     transaction before committing (GitHub, a provider's CLI, git on disk, the claim's one-time PAKE state), and a
 *     dropped session cancels the commit that would have recorded it — or there is no receipt a retry could meet
 *     (ephemeral ops, export ops, ops that never go over a session), or the receipt keeps no digest of the input and no
 *     result (secret ops, CT-44). The client reports the outcome as unknown and a person checks the current state.
 *
 * Client-local advice, never sent: it authorizes nothing (the appliance checks every request) and makes nothing
 * idempotent. The runtime's receipts — keyed by principal, op and request id and bound to `receiptDigest` — are what
 * make a same-id resend run at most once; this table only says where that guarantee covers everything an op does.
 * When in doubt an op is `never`. An op a client doesn't find here (a newer runtime's) is never resent by it either.
 */
import type { OperationName } from './operations.js';

/** What makes asking again after a lost answer safe (CT-194). */
export const OPERATION_RETRIES = ['safe', 'receipt', 'never'] as const;
export type OperationRetry = (typeof OPERATION_RETRIES)[number];

export interface OperationSafety {
  /** Irreversible or high-impact: never sent again by a client on its own; a person decides. */
  readonly destructive: boolean;
  readonly retry: OperationRetry;
}

/** The shared entries are frozen, like the table (0.29.1, CT-195): no consumer can loosen one op, or all. */
const entry = (destructive: boolean, retry: OperationRetry): OperationSafety =>
  Object.freeze({ destructive, retry });

/** Doesn't mutate: ask again. */
const READ = entry(false, 'safe');
/**
 * Covered by its receipt: after `status` answered `not_found`, the same request may be sent again — if it was never
 * acknowledged and within the receipt retention.
 */
const RECEIPT = entry(false, 'receipt');
/** Covered by its receipt, but destructive: a person decides whether to send it again. */
const DESTRUCTIVE = entry(true, 'receipt');
/** Never sent again by itself (secret, ephemeral, export, no session, or effects outside its receipt). */
const NEVER = entry(false, 'never');
const DESTRUCTIVE_NEVER = entry(true, 'never');

/**
 * Every operation's classification. Mutations are `receipt` unless a note says why not; `secret` ops (CT-44), ephemeral
 * ops and export ops are `never` by rule (`operation-safety.test.ts`).
 */
const TABLE = {
  'health.get': READ,

  'me.get': READ,
  'me.getPreferences': READ,
  'me.updatePreferences': RECEIPT,
  'me.updateProfile': RECEIPT,
  // 0.47 (CT-265): the same photo again is a no-op.
  'me.setAvatar': RECEIPT,

  'burrows.slugCheck': READ,
  'burrows.create': RECEIPT,
  'burrows.get': READ,
  'burrows.update': RECEIPT,
  // 0.44 (RA-41): opening or closing the LAN to the agent's commands; the next command follows it.
  'burrows.setAgentsReachLan': RECEIPT,
  // 0.76 (AIG-05): a switch of the AI gateway; turns that start afterwards follow it.
  'burrows.setAiGateway': RECEIPT,
  // 0.124 (CT-1171): the model on the owner's network. Setting and testing carry its key (secret ops: no input digest,
  // `never`); setting and testing also call the model server outside the receipt. Removing it stops the agent replying
  // on it until it is set again: a person decides.
  'burrows.setLocalModel': NEVER,
  'burrows.testLocalModel': NEVER,
  'burrows.clearLocalModel': DESTRUCTIVE,
  // Web search (Whombat web-search.md): setting carries the Brave key (a secret op) and searches once before its
  // commit; a check searches once more, harmless to repeat; removing it stops the agent searching: a person decides.
  'burrows.setWebSearch': NEVER,
  'burrows.testWebSearch': RECEIPT,
  'burrows.clearWebSearch': DESTRUCTIVE,

  'onboarding.get': READ,
  // Installs the chosen AI clients only after its commit.
  'onboarding.update': RECEIPT,
  'onboarding.complete': RECEIPT,

  'repos.list': READ,
  'repos.update': RECEIPT,
  // GitHub reads before the commit, nothing else.
  'repos.add': RECEIPT,
  // Never: creates the bare repository on disk (git) before its commit.
  'repos.create': NEVER,
  'repos.sync': RECEIPT,

  'github.status': READ,
  'github.connect': RECEIPT,
  'github.repos': READ,
  'github.avatar': READ,

  'conversations.bootstrap': READ,
  'conversations.list': READ,
  'conversations.get': READ,
  'conversations.update': RECEIPT,
  'conversations.markRead': RECEIPT,
  'conversations.setNotify': RECEIPT,
  'conversations.pins': READ,
  'conversations.handoffs': READ,
  // An answer or a message reaches T3 Code, outside the receipt: sent again it could answer or say it twice.
  'conversations.handoffAnswer': NEVER,
  'conversations.handoffSend': NEVER,

  'messages.list': READ,
  // Agent turns, link previews and pushes start after the commit.
  'messages.send': RECEIPT,
  'messages.get': READ,
  'messages.thread': READ,
  'messages.react': RECEIPT,
  'messages.more': RECEIPT,
  'messages.edit': RECEIPT,
  'messages.delete': DESTRUCTIVE,
  'messages.pin': RECEIPT,
  // The answers reach T3 Code, outside the receipt: sent again it would be told twice.
  'messages.jobAnswers': NEVER,

  // A reservation; the bytes arrive later on an upload stream.
  'uploads.create': RECEIPT,
  'uploads.discard': DESTRUCTIVE,
  // A conversation's Files (0.49, CT-275): saving and moving the same file again end where they are, a rename to the
  // same name changes nothing; removing deletes a saved file or takes a message's file out of Files.
  'files.summary': READ,
  'files.list': READ,
  'files.save': RECEIPT,
  'files.update': RECEIPT,
  'files.remove': DESTRUCTIVE,

  'prs.list': READ,
  'prs.get': READ,
  'prs.file': READ,
  // Never: merges on GitHub inside its transaction, before the commit — a dropped session cancels the commit,
  // not the merge.
  'prs.merge': DESTRUCTIVE_NEVER,

  'runs.list': READ,
  'runs.get': READ,
  'runs.log': READ,
  'runs.pause': RECEIPT,
  'runs.resume': RECEIPT,
  'runs.retry': RECEIPT,
  'runs.takeOver': RECEIPT,

  'approvals.list': READ,
  'approvals.get': READ,
  // The approved action (a merge, a deploy, a key) runs after the decision commits.
  'approvals.decide': DESTRUCTIVE,
  'approvals.undo': RECEIPT,

  'plans.list': READ,
  'plans.get': READ,
  'plans.create': RECEIPT,
  'plans.update': RECEIPT,
  'plans.addStep': RECEIPT,
  'plans.updateStep': RECEIPT,
  'plans.removeStep': DESTRUCTIVE,
  'plans.startStep': RECEIPT,
  'plans.createCanvas': RECEIPT,

  'activity.list': READ,

  'work.overview': READ,
  // 0.55 (CT-302): the needs-you count alone.
  'work.needsYou': READ,

  'agent.get': READ,
  'agent.update': RECEIPT,
  'agent.setKeys': RECEIPT,
  // Commands always allowed (0.36, Whombat agent-computer.md AC-42).
  'agent.commandAllowances': READ,
  'agent.removeCommandAllowance': DESTRUCTIVE,

  'audit.list': READ,
  'audit.get': READ,
  'audit.export': READ,
  'audit.verify': READ,

  'search.query': READ,
  'search.ask': RECEIPT,
  'search.getAnswer': READ,
  'search.postAnswer': RECEIPT,

  'canvases.list': READ,
  'canvases.create': RECEIPT,
  'canvases.get': READ,
  // 0.55 (CT-303): a canvas as Markdown.
  'canvases.content': READ,
  // `secret` ops (CT-44, `SECRET_API_OPS`) are `never`: their receipt keeps no input digest and no result.
  'canvases.collabToken': NEVER,
  'canvases.addComment': RECEIPT,
  'canvases.resolveComment': RECEIPT,

  'notifications.inbox': READ,
  'notifications.markRead': RECEIPT,

  'devices.register': NEVER,
  'devices.update': NEVER,
  'devices.remove': DESTRUCTIVE,
  'devices.registerLiveActivity': RECEIPT,
  // Only lines in the box's log: an answer lost means the app sends the same notes again when it next opens.
  'devices.reportErrors': NEVER,
  'devices.vapidKey': READ,

  'host.info': READ,
  'host.agents': READ,
  // No commit: an in-memory flag, idempotent.
  'host.recheckAgents': RECEIPT,

  'signins.list': READ,
  // Sign-ins act on the runner (CLIs, credential homes) around their audit commit: only the in-memory ones (cancel,
  // resize) are `receipt`.
  'signins.loginStart': NEVER,
  'signins.loginStatus': READ,
  'signins.loginSubmit': NEVER,
  'signins.loginCancel': RECEIPT,
  // Never (0.29.1, CT-195): the runner signs out and removes the credential home before the audit commit; a repeat
  // later would sign out a sign-in made meanwhile.
  'signins.logout': DESTRUCTIVE_NEVER,
  // Never: starts `claude auth login` in a terminal, replacing the running one; no commit.
  'signins.consoleStart': NEVER,
  'signins.consoleRead': READ,
  'signins.consoleWrite': NEVER,
  'signins.consoleResize': RECEIPT,
  'signins.consoleCancel': RECEIPT,

  'clients.list': READ,
  // No commit: the manager answers the running or installed client (idempotent, `clientsInstall`).
  'clients.install': RECEIPT,
  // Never (0.29.1, CT-195): the manager removes the client, no commit; a repeat later would remove a reinstall.
  'clients.remove': DESTRUCTIVE_NEVER,

  'connectors.status': READ,
  // 0.97 (CT-483): finding a mailbox's servers looks things up and changes nothing; connecting it carries the password
  // (a secret op) and signs in to both servers before its commit.
  'connectors.imapDiscover': RECEIPT,
  'connectors.imapConnect': NEVER,
  'connectors.setMicrosoftApp': NEVER,
  'connectors.removeMicrosoftApp': DESTRUCTIVE,
  'connections.startMicrosoft': RECEIPT,
  'connections.finishMicrosoft': NEVER,
  'connectors.setGoogleApp': NEVER,
  'connectors.removeGoogleApp': DESTRUCTIVE,

  'connections.startGoogle': RECEIPT,
  'connections.finishGoogle': NEVER,
  // A token refresh and read-only probes before its commit.
  'connections.check': RECEIPT,
  // Never (0.29.1, CT-195): revokes the Google grant before its commit, and a reconnected connection keeps its id, so
  // a repeat later would revoke the new grant.
  'connections.remove': DESTRUCTIVE_NEVER,
  // The connections catalog (0.48, CT-272). Secret ops are never resent (no receipt digest). A create, a check and a
  // finished sign-in reach the service before their commit (a read-only check, like `vault.check`); a poll that connects
  // takes the one-time app password; a removal revokes tokens outside its receipt.
  'connections.catalog': READ,
  'connections.list': READ,
  'connections.create': NEVER,
  'connections.update': RECEIPT,
  'connections.setSecret': NEVER,
  'connections.recheck': RECEIPT,
  'connections.setRunsOn': RECEIPT,
  'connections.disconnect': DESTRUCTIVE_NEVER,
  'connections.tools': READ,
  'connections.setTool': RECEIPT,
  // 0.80 (CT-341): the owner's limits on a tool's arguments, a row.
  'connections.setToolLimits': RECEIPT,
  'connections.startOAuth': RECEIPT,
  'connections.finishOAuth': NEVER,
  'connections.startNextcloud': NEVER,
  'connections.pollNextcloud': NEVER,
  // 0.111 (CT-738): as Nextcloud's: a start asks the service for a flow before its row, a poll that connects takes the
  // one-time token.
  'connections.startServiceLogin': NEVER,
  'connections.pollServiceLogin': NEVER,
  'connections.probe': RECEIPT,
  // 0.61 (CT-314): what is at an address, and a scan of the home network; both only send unauthenticated probes.
  'connections.identify': RECEIPT,
  'connections.discover': RECEIPT,
  // 0.63 (CT-316): hiding or showing a found service again sets the same state each time.
  'connections.hideFound': RECEIPT,
  'connections.allowNetwork': RECEIPT,
  // A Find My connection's timeline: the days, whose and the map are reads. Choosing whose can delete someone's days,
  // and deleting every day can't be undone: neither is ever resent by itself.
  'connections.findMyTimeline': READ,
  'connections.findMyTimelineSet': NEVER,
  'connections.findMyTimelineDelete': DESTRUCTIVE_NEVER,
  'connections.findMyTimelineMap': READ,
  // A one-time watch's Cancel: a watch that already ended answers as it is, so a retry changes nothing more.
  'connections.findMyWatchCancel': RECEIPT,
  // A 1Password connection's sync: its page part is a read; Sync now only asks for a pass, which runs after its commit;
  // answering the guard can remove entries, so a person decides whether to send it again.
  'connections.onePassword': READ,
  'connections.onePasswordSync': RECEIPT,
  'connections.onePasswordRemovals': DESTRUCTIVE,
  'connectors.setApp': NEVER,
  'connectors.removeApp': DESTRUCTIVE,

  // 0.125 (CT-1200…CT-1206): the person's Hermes memory and the agent's notes. A write replaces the file with the same
  // text each time; forgetting is gone for good: a person decides.
  'memory.mine': READ,
  'memory.write': RECEIPT,
  'memory.clear': DESTRUCTIVE,
  'memory.notes': READ,
  'memory.setNotes': RECEIPT,

  // Settings → Skills on Hermes's skills (0.125, CT-1210…CT-1216; since 2.0 Hermes's hub, CT-1431). Writes go to the
  // runner's Hermes-home service before the commit and set the same state each time. Removing a skill is a person's
  // decision. A hub install or update fetches the skill from outside and writes it before its commit: never resent by a
  // client on its own (a second install of the same skill is `skill_exists`), and the person sees the row it made.
  'skills.library': READ,
  'skills.librarySkill': READ,
  'skills.librarySkillFile': READ,
  'skills.libraryEdit': RECEIPT,
  'skills.librarySwitch': RECEIPT,
  'skills.libraryRemove': DESTRUCTIVE,
  'skills.libraryRestore': RECEIPT,
  'skills.hubSearch': READ,
  'skills.hubPreview': READ,
  'skills.hubInstall': NEVER,
  'skills.hubUpdates': READ,
  'skills.hubUpdate': NEVER,

  'automations.list': READ,
  'automations.templates': READ,
  'automations.create': RECEIPT,
  'automations.get': READ,
  'automations.saveDraft': RECEIPT,
  'automations.discardDraft': DESTRUCTIVE,
  'automations.delete': DESTRUCTIVE,
  'automations.samples': READ,
  'automations.publish': RECEIPT,
  'automations.setEnabled': RECEIPT,
  'automations.setKeys': RECEIPT,
  // A `secret` op since 0.29.1 (its answer may be a new webhook secret, shown once; managed runtimes refuse it over a
  // session); rotating the secret breaks the senders using the old one: destructive.
  'automations.webhook': DESTRUCTIVE_NEVER,
  'automations.export': READ,
  'automations.runNow': RECEIPT,
  'automations.runs': READ,
  'automations.run': READ,
  'automations.pauseRun': RECEIPT,
  'automations.resumeRun': RECEIPT,
  // A cancelled run can't be resumed: destructive.
  'automations.cancelRun': DESTRUCTIVE,
  'automations.reviewStep': RECEIPT,
  // A plan turned on is a new version, as `publish`; not now sets it aside (3.9, Whombat automation-chat.md).
  'automations.acceptPlan': RECEIPT,
  'automations.declinePlan': RECEIPT,
  // A run's tracker report (0.69, CT-325, TA-14, TA-15): read live; a reply or a status emails the reporter through
  // the tracker before its commit and can't be taken back. The tracker replays a known
  // `requestId`, so a person's retry with the same one sends nothing twice.
  'tracker.item': READ,
  'tracker.update': DESTRUCTIVE,
  // The person's answer to a feature request (3.12, TA-45): it goes on to tell the customer, which can't be taken back.
  'tracker.decide': DESTRUCTIVE,

  'feedback.listIntegrations': READ,
  'feedback.getIntegration': READ,
  'feedback.createIntegration': RECEIPT,
  'feedback.updateIntegration': RECEIPT,
  'feedback.setIntake': RECEIPT,
  'feedback.setAssessment': RECEIPT,
  // 0.69 (CT-325, TA-20): the connection, the automation, the cursor and the intake in one commit; nothing reaches
  // the tracker before it (the poller checks the token later).
  'feedback.getReport': READ,
  'feedback.setReportStatus': RECEIPT,
  'feedback.retryAssessment': RECEIPT,
  'feedback.requestHandoff': RECEIPT,
  'feedback.decide': DESTRUCTIVE,
  // Emails a customer through the connected system (CT-288): can't be taken back.
  // Irreversible (the words are removed): destructive.
  'feedback.redactReport': DESTRUCTIVE,

  'guides.act': NEVER,

  'vault.list': READ,
  'vault.get': READ,
  'vault.create': NEVER,
  'vault.update': RECEIPT,
  'vault.setSecret': NEVER,
  'vault.setTotp': NEVER,
  'vault.remove': DESTRUCTIVE,
  // A read-only probe with the credential before its commit.
  'vault.check': RECEIPT,
  'vault.setTool': RECEIPT,
  'vault.giveKey': RECEIPT,
  'vault.takeKey': DESTRUCTIVE,
  'vault.uses': READ,
  // SSH keys (0.32.0, vault.md VT-S03…VT-S07). The old key stops working at once: a person decides.
  'vault.generateSshKey': DESTRUCTIVE,
  // A secret op (the imported private key).
  'vault.replaceSshKey': NEVER,
  // DNS and the destination check before the commit, nothing else.
  'vault.addSshServer': RECEIPT,
  'vault.updateSshServer': RECEIPT,
  'vault.removeSshServer': DESTRUCTIVE,
  // A read-only probe (host key, a sign-in that runs nothing) before its commit, like `vault.check`.
  'vault.checkSshServer': RECEIPT,
  // Fetches the host key again and trusts only the fingerprint the owner saw: the same request trusts the same key.
  'vault.trustSshHostKey': RECEIPT,
  'vault.setKeyServers': RECEIPT,
  // The variable an `http` entry is in for the agent's commands (0.125, CT-1240): nothing outside the commit.
  'vault.setKeyEnvName': RECEIPT,

  'vaultNetworks.list': READ,
  'vaultNetworks.add': RECEIPT,
  'vaultNetworks.remove': DESTRUCTIVE,

  // Backup files (0.79, CT-335). `create`, `inspect` and `restore` carry the password (secret ops): never resent, and a
  // restore isn't destructive (it only adds and updates) but its effects follow its start outside any one commit. The
  // removals delete files on disk after their commit (as `files.remove`).
  'backups.defaults': READ,
  'backups.setDefaults': RECEIPT,
  'backups.estimate': READ,
  'backups.list': READ,
  'backups.create': NEVER,
  'backups.get': READ,
  'backups.remove': DESTRUCTIVE,
  // A row and a reserved place on disk; a second stage of the same request is answered by its receipt.
  'backups.stage': RECEIPT,
  'backups.getUpload': READ,
  'backups.removeUpload': DESTRUCTIVE,
  'backups.inspect': NEVER,
  'backups.restore': NEVER,
  'backups.getRestore': READ,

  // One Whombat (0.80, CT-336…CT-343). Reads are reads. `changes.undo` runs the inverse through a connection or the
  // hosts service before its commit can record it, so a person decides; snoozes, widget moves and renames are rows.
  'home.overview': READ,
  'watch.list': READ,
  // A server alert's acknowledgement is a call to the hosts service outside the receipt (CT-339), so never resent.
  'watch.acknowledge': NEVER,
  'needsYou.snooze': RECEIPT,
  // A row of the caller's own view (0.80.3, CT-352).
  'needsYou.ignore': RECEIPT,
  'needsYou.discuss': RECEIPT,
  // The person's go-ahead and the assistant's wake, in one commit (3.5): the step is the assistant's turn after it.
  'looks.fix': RECEIPT,
  // The person's ask and the assistant's wake, in one commit (3.11); asked again while it looks, the same research.
  'looks.handle': RECEIPT,
  'looks.get': READ,
  // The quiet hours for changes (care-plan.md): one signed row, the same value when sent again.
  'changeWindow.get': READ,
  'changeWindow.set': RECEIPT,
  'changes.list': READ,
  'changes.undo': DESTRUCTIVE_NEVER,
  // Arranging the Overview (overview-arranged.md): one layout written whole; views and figures only read.
  'overview.arrange': RECEIPT,
  'overview.figures': READ,
  'overview.views': READ,
  'widgets.list': READ,
  'widgets.remove': DESTRUCTIVE,
  'widgets.move': RECEIPT,
  'chats.list': READ,
  'chats.threads': READ,
  'chats.unread': READ,
  'chats.runtime': READ,
  // A thread's choice, set to the same value again: harmless (0.96, CT-461).
  'chats.setThreadRuntime': RECEIPT,
  // Whombat's turn starts after the commit (as `messages.send`).
  'chats.start': RECEIPT,
  // 0.119 (CT-994): hides the room's top-level messages from its view; nothing is removed, every thread stays.
  'chats.clear': RECEIPT,
  'chats.settle': RECEIPT,
  'chats.settleFinished': RECEIPT,
  'chats.readThread': RECEIPT,
  // A private marker moved back (Whombat chat-inbox.md): the same thread again, the same marker.
  'chats.markUnread': RECEIPT,
  // For apps from before one Chat: answers the thread as it is, changing nothing (Whombat one-chat.md).
  'chats.place': RECEIPT,
  // Shared links (Whombat share-links.md): making one puts a copy at control, outside the receipt.
  'shares.preview': RECEIPT,
  'shares.list': READ,
  'shares.create': NEVER,
  'shares.stop': DESTRUCTIVE,
  'shares.stopAll': DESTRUCTIVE,
  // Kept sites (Whombat kept-sites.md): stopping one deletes its kept sign-in.
  'keptSites.list': READ,
  'keptSites.stop': DESTRUCTIVE,
  // The council's buttons (Whombat council.md): Go ahead, from before councils built through a checklist, is always
  // refused now (CNL-60); Stop stops every member's thread and its checklist's tasks.
  // The person's prompts (Whombat prompts.md). Using one posts a message and starts work: never sent twice.
  'prompts.list': READ,
  'prompts.create': NEVER,
  'prompts.save': RECEIPT,
  'prompts.remove': DESTRUCTIVE,
  'prompts.restore': DESTRUCTIVE,
  'prompts.projects': READ,
  'prompts.use': NEVER,
  'councils.goAhead': RECEIPT,
  'councils.stop': DESTRUCTIVE,
  // The person's council (council.md CNL-50): a read, the one row kept; forgetting it is the person's to resend.
  'councils.setup': READ,
  'councils.saveSetup': RECEIPT,
  'councils.resetSetup': DESTRUCTIVE,
  // The delegation card (Whombat delegate.md): a tick is the same tick again; handing over starts the tasks once (a
  // second press is refused); stopping stops threads on the person's computer. Choosing a task's AI is the same choice
  // again; the models are a read.
  'delegations.pick': RECEIPT,
  'delegations.setAi': RECEIPT,
  'delegations.models': READ,
  'delegations.start': RECEIPT,
  'delegations.stopTask': DESTRUCTIVE,
  'delegations.stop': DESTRUCTIVE,
  'chats.rename': RECEIPT,
  'chats.archive': DESTRUCTIVE,
  'chats.unarchive': RECEIPT,
  // Makes the device connection (and with `switchOn` its tools live) in one commit; a decision, so a person decides.
  'deviceSkills.decide': DESTRUCTIVE,
  'deviceSkills.decline': DESTRUCTIVE,
  'things.page': READ,
  /** Restarts the service itself, outside the receipt's transaction (CP-12). */
  'things.action': DESTRUCTIVE_NEVER,
  // 0.122 (CT-1063): quieting a server's alert or switching off its rule is a call to the hosts service outside the
  // receipt's transaction (QN-23), so neither is resent by a client; not destructive (Undo, Watch again).
  'things.quiet': NEVER,
  'things.watch': READ,
  'things.history': READ,
  'things.setWatch': NEVER,
  'things.setWatchLimit': NEVER,
  // Keeping a server quiet makes or ends a maintenance window in the hosts service outside the receipt's transaction
  // (Whombat monitoring.md MON-04), so neither is resent by a client; not destructive (End now, Undo).
  'things.keepQuiet': NEVER,
  'things.endQuiet': NEVER,
  // Servers (CT-339): every write is a call to the hosts service, which acts outside the receipt's transaction, so none
  // is resent by a client. `createEnrollment` (the install command's token) and `createConsole` (the console token)
  // are secret.
  'hosts.status': READ,
  'hosts.fleet': READ,
  'hosts.getServer': READ,
  'hosts.serverMetrics': READ,
  'hosts.serverSettings': READ,
  'hosts.updateServer': NEVER,
  'hosts.removeServer': DESTRUCTIVE_NEVER,
  'hosts.serverAction': DESTRUCTIVE_NEVER,
  // 0.99 (CT-514): the setting is the hosts service's; updating an agent restarts it on the server (as root for the one
  // last install), outside any receipt.
  'hosts.agentSettings': READ,
  'hosts.updateAgentSettings': NEVER,
  'hosts.updateAgent': NEVER,
  'hosts.listGuests': READ,
  'hosts.getGuest': READ,
  'hosts.guestMetrics': READ,
  'hosts.guestAction': DESTRUCTIVE_NEVER,
  'hosts.manage': DESTRUCTIVE_NEVER,
  'hosts.manageRead': READ,
  'hosts.getTask': READ,
  'hosts.listAlerts': READ,
  'hosts.ackAlert': NEVER,
  'hosts.unackAlert': DESTRUCTIVE_NEVER,
  'hosts.listMaintenance': READ,
  'hosts.createMaintenance': NEVER,
  'hosts.removeMaintenance': DESTRUCTIVE_NEVER,
  'hosts.listChecks': READ,
  'hosts.getCheck': READ,
  'hosts.createCheck': NEVER,
  'hosts.updateCheck': NEVER,
  'hosts.removeCheck': DESTRUCTIVE_NEVER,
  'hosts.createEnrollment': NEVER,
  'hosts.listEnrollments': READ,
  // Another machine let in.
  'hosts.approveEnrollment': DESTRUCTIVE_NEVER,
  'hosts.rejectEnrollment': DESTRUCTIVE_NEVER,
  // 0.85 (CT-377): signs in to a server and installs its agent outside any receipt; secret (the server's password).
  'hosts.startInstall': NEVER,
  'hosts.getInstall': READ,
  // 0.117 (CT-913): signs in to servers and updates their agents outside any receipt; the Vault's keys, no password.
  'hosts.addressChange': READ,
  'hosts.repoint': NEVER,
  'hosts.getRepoint': READ,
  'hosts.createConsole': NEVER,
  'hosts.closeConsole': DESTRUCTIVE_NEVER,
  'hosts.inspect': READ,
  // On-request disk usage scan on the agent outside a receipt: read-only, not automatically resent.
  'hosts.diskUsage': NEVER,
  // A Mac's screen (Whombat macos-servers.md): a click or a key acts at once on the Mac, outside any receipt, so it is
  // never resent; `account.set` carries the Mac's password (secret). The screenshot is a read.
  'hosts.screen': DESTRUCTIVE_NEVER,
  'hosts.screenLook': READ,
  // Find My on a Mac's page: a read or a picture unlocks and drives the Mac's screen, so it is never resent; what was
  // read, the map and the picture are reads.
  'hosts.findMy': READ,
  'hosts.findMyRefresh': NEVER,
  'hosts.findMyExact': NEVER,
  'hosts.findMyMap': READ,
  'hosts.findMyPicture': READ,

  'spend.overview': READ,
  'spend.week': READ,
  'spend.daily': READ,

  'usage.list': READ,
  // The CLIs are probed after its claim commits.
  'usage.refresh': RECEIPT,

  'dispatches.retry': RECEIPT,
  // 0.55 (CT-295): stopping the same turn again only answers how it ended; it can't stop anything else.
  'dispatches.cancel': RECEIPT,
  // 0.55 (CT-296): recorded deploys, read only.
  'deployments.list': READ,
  'deployments.environments': READ,

  // The agent's services (3.0, CT-1537; Whombat one-person.md OP-19), as the computer's stop and unpublish were: the
  // stop asks the container engine after its commit and stopping a stopped container changes nothing, but it takes away
  // what someone may be using: a person decides.
  'services.list': READ,
  'services.stop': DESTRUCTIVE,

  // 0.44 (RA-30): an agent's schedules. Removing one ends it for good.
  'schedules.list': READ,
  'schedules.pause': RECEIPT,
  'schedules.resume': RECEIPT,
  'schedules.remove': DESTRUCTIVE,

  // The enrollment channel's mutations are all `never`: ephemeral, secret, or (once the device is enrolled) their
  // receipt is kept under the new account while `status` asked as the unenrolled device.
  // Ephemeral: its PAKE state lives on the connection.
  'enroll.claim.begin': NEVER,
  // Never: consumes that one-time state, and its receipt moves from the device to the new owner.
  'enroll.claim': NEVER,
  // 1.1 (CT-1302): the claim on the box's own page, as the claim through control.
  'enroll.claim.local.start': NEVER,
  'enroll.claim.local.begin': NEVER,
  'enroll.claim.local.prove': NEVER,
  'enroll.claim.local': NEVER,
  'enroll.pair.request': NEVER,
  'enroll.pair.status': READ,
  'enroll.pair.lookup': READ,
  // Lets another device in: destructive.
  'enroll.pair.approve': DESTRUCTIVE,

  'recovery.kit.register': NEVER,
  // Replaces the recovery key: destructive.
  'recovery.kit.rotate': DESTRUCTIVE_NEVER,
  'recovery.kit.confirm': RECEIPT,
  // Never: its receipt moves from the device to the account it enrolls into, so `status` can't find it once it
  // committed.
  'recovery.enroll': NEVER,

  // 1.1 (CT-1305): device links carry their secret (never resent); accepting one lets a device in.
  'enroll.link.create': NEVER,
  'enroll.link.accept': NEVER,
  // Passkeys (0.50, CT-281). Never: its receipt moves from the device to the passkey's account, as `recovery.enroll`.
  'enroll.passkey': NEVER,
  // Ephemeral: its nonce lives on the connection.
  'passkey.register.begin': NEVER,
  // Never: consumes that one-time nonce, which a dropped session loses anyway.
  'passkey.register': NEVER,
  'passkey.link': NEVER,
  'passkeys.list': READ,
  // The passkey stops opening the Whombat.
  'passkey.remove': DESTRUCTIVE,
  'passkeys.policy': RECEIPT,
  // Box passkeys (4.3), as their namesakes: the begins are ephemeral, joining moves its receipt to the passkey's
  // account, registering consumes the begin's one-time nonce.
  'boxPasskey.enroll.begin': NEVER,
  'boxPasskey.enroll': NEVER,
  'boxPasskey.register.begin': NEVER,
  'boxPasskey.register': NEVER,
  // Only a line in the box's log: one lost on the way is a line less.
  'boxPasskey.failed': NEVER,
  // The own address (4.3). The switch is one commit. Looking up a link code only reads; linking acts at control before
  // anything commits here (the same code again for the same account is fine there, but a person checks).
  'ownAddress.status': READ,
  'ownAddress.reach.set': RECEIPT,
  'ownAddress.check': READ,
  // Acts at control before it commits: a lost answer is checked by reading the address again.
  'ownAddress.rename': NEVER,
  'account.link.lookup': READ,
  'account.link': NEVER,
  // Reach and Updates (4.4). Link on and off act at control before anything commits here, and a person checks the
  // result; the channel acts at the manager, like “Ask before updating”. A push token replaces the device's own.
  'reach.get': READ,
  'link.on': NEVER,
  'link.off': NEVER,
  // Sets both choices to a value: once committed it holds; telling control follows by itself.
  'link.mail.set': RECEIPT,
  'link.whombats': READ,
  'updates.channel.get': READ,
  'updates.channel.set': NEVER,
  'push.token.set': RECEIPT,
  'push.token.clear': RECEIPT,
  // Sign in at the box's screen (0.106, CT-622). Ephemeral: the sign-in and the PAKE state live in memory.
  'enroll.screen.request': NEVER,
  'enroll.screen.begin': NEVER,
  // Never: consumes that one-time state, and its receipt moves from the device to the account, as `enroll.claim`.
  'enroll.screen': NEVER,
  // A development runtime lets the device in (CT-1257): another device let in, never resent by itself.
  'enroll.dev': NEVER,

  'endpoints.list': READ,
  'endpoints.rename': RECEIPT,
  'endpoints.revoke': DESTRUCTIVE,

  'push.handles.set': RECEIPT,
  'push.handles.clear': RECEIPT,
  'push.resolve': READ,

  'appliance.status': READ,
  // The manager takes the setting and the approval outside any receipt: never resent by itself. Neither is destructive:
  // the switch can be turned back, and an approved update installs as any update does.
  'appliance.update.ask': NEVER,
  'appliance.update.install': NEVER,
  'host.metrics': READ,
  // The box's hardware and network (0.102, CT-570). A join and a forget act on the box outside any receipt (the manager
  // changes iwd's networks), so they are never resent by a client on its own; the join is secret. Neither is
  // destructive: the guard undoes a join that cuts the box off, and a forgotten network can be joined again.
  'host.hardware': READ,
  'host.network': READ,
  'host.wifi.scan': READ,
  'host.wifi.join': NEVER,
  'host.wifi.forget': NEVER,
  // Wi-Fi only or the cable again (3.13) changes the box's network outside any receipt: never resent by itself.
  'host.cable.set': NEVER,
  // The box's Bluetooth (0.109, CT-676). Looking is a read (asked again, it runs on). Pairing, answering it, stopping
  // it, connecting, disconnecting and forgetting act on BlueZ outside any receipt, so a client never resends them by
  // itself. A disconnect cuts off a device in use and a forget is a removal (it has to be paired again): destructive.
  'host.bluetooth': READ,
  'host.bluetooth.scan': READ,
  'host.bluetooth.pair': NEVER,
  'host.bluetooth.confirm': NEVER,
  'host.bluetooth.cancel': NEVER,
  'host.bluetooth.connect': NEVER,
  'host.bluetooth.disconnect': DESTRUCTIVE_NEVER,
  'host.bluetooth.forget': DESTRUCTIVE_NEVER,
  // Tailscale (CT-1254): the manager acts outside the receipt; turning it off ends connections over Tailscale.
  'host.tailscale': READ,
  'host.tailscale.on': NEVER,
  'host.tailscale.off': DESTRUCTIVE_NEVER,
  'host.tailscale.signIn': NEVER,
  // 1.1 (CT-1308): the mail server; `set` and `test` are secret, `test` sends a message outside any receipt.
  'host.mail': READ,
  'host.mail.set': NEVER,
  'host.mail.test': NEVER,
  'host.mail.remove': DESTRUCTIVE,

  'backup.status': READ,
  'backup.configureDestination': NEVER,
  'backup.recoveryMaterial': READ,
  'backup.sshPublicKey': READ,
  // Accepted (an audit commit) before the backup service is asked.
  'backup.runNow': RECEIPT,
  // Backup places: setting one up installs an app on the NAS and moves the destination, never repeated on its own;
  // removing one deletes the backups it kept when asked to.
  'backup.places': READ,
  'backup.usePlace': NEVER,
  'backup.placeByHand': READ,
  'backup.placeCheck': NEVER,
  'backup.forgetPlace': DESTRUCTIVE_NEVER,
  // Backup options (backup-options.md): reads; the options and a check are harmless to repeat; moving the old
  // backups copies once (restic copy skips what's there) and removes them from the box; adopting carries the kit;
  // a restore sets the box's state aside and is never repeated on its own.
  'backup.checkpoints': READ,
  'backup.policy': READ,
  'backup.setPolicy': RECEIPT,
  'backup.check': RECEIPT,
  'backup.moveLocal': DESTRUCTIVE,
  'backup.removeLocal': DESTRUCTIVE_NEVER,
  'backup.adopt': NEVER,
  'backup.restore': DESTRUCTIVE_NEVER,
  'backup.restoreState': READ,
  'backup.finishRestore': NEVER,
  // The Backups page in one read; the claim's “Let {assistant} set it up” keeps the person's yes (the same yes twice is
  // still one).
  'backup.overview': READ,
  'backup.letAssistantSetUp': RECEIPT,
  // The passkey backup key (backup-passkey.md): `set` is secret and hands the box a key it locks with at once, so a
  // client never resends it by itself; removing one takes a way back away (harmless to repeat); the paper copy's
  // confirmation is harmless to repeat; finding envelopes on the network reads.
  'backup.passkeyKey.set': NEVER,
  'backup.passkeyKey.verifyBegin': NEVER,
  'backup.passkeyKey.verifyConfirm': NEVER,
  'backup.passkeyKey.remove': DESTRUCTIVE,
  'backup.paperCopy.confirm': RECEIPT,
  'backup.findKits': READ,
  // Getting one thing back (backup-look.md): opening the same backup again answers the same look, listing reads;
  // bringing back only adds (a second time finds everything here already); closing is harmless to repeat.
  'backup.look': READ,
  'backup.lookContents': READ,
  'backup.lookBring': RECEIPT,
  'backup.lookClose': RECEIPT,

  'licence.status': READ,
  // No commit: a renewal the manager limits to one a minute, harmless to repeat.
  'licence.refresh': RECEIPT,

  'diagnostics.create': RECEIPT,
  'diagnostics.preview': READ,
  // Export op: no receipt.
  'diagnostics.download': NEVER,
  'diagnostics.list': READ,
  'diagnostics.delete': DESTRUCTIVE,

  // Remote help (0.120, CT-933). The begin is ephemeral (its nonce lives in the session). Turning it on lets someone
  // into the box (like `enroll.pair.approve`), acts on the support service before anything commits, consumes the begin's
  // one-time nonce and is secret (its answer holds the help code): never resent, a person decides. Stopping only ever
  // takes access away and is idempotent: harmless to repeat, though it acts on the service before its commit. The
  // transcript is an export op (mutating like `diagnostics.download`, so not `safe`): no receipt.
  'remoteHelp.get': READ,
  'remoteHelp.confirmBegin': NEVER,
  'remoteHelp.start': DESTRUCTIVE_NEVER,
  'remoteHelp.stop': RECEIPT,
  'remoteHelp.visits': READ,
  'remoteHelp.transcript': NEVER,

  // The desk screen (0.100, CT-524). The letters and the unlock live in the runtime's memory, outside any receipt; the
  // PIN ops are secret. The settings are one commit. Unpairing takes the screen from its person: a person decides.
  'desk.get': READ,
  'desk.startPairing': NEVER,
  'desk.pair': NEVER,
  'desk.setPin': NEVER,
  'desk.update': RECEIPT,
  'desk.unpair': DESTRUCTIVE,
  'desk.answerUnlock': NEVER,
  // 0.101 (CT-540): off ends the pairing and its PIN, as `desk.unpair`; on is one commit.
  'desk.setScreen': DESTRUCTIVE,
  // 0.105 (CT-612): *Listen* says a sentence and keeps nothing; reading it again is harmless.
  'desk.voiceSample': READ,
  // 3.2 (CT-1626…CT-1628): the preview reads; *Try it on the screen* lives a minute in the runtime's memory, outside
  // any receipt, like the pairing letters; the name is one commit.
  'desk.preview': READ,
  'desk.tryOnScreen': NEVER,
  'desk.setName': RECEIPT,
  // Screens of widgets (3.6): reads are safe; a screen's settings and layout are one commit; *Try on the screen* lives a
  // minute in memory; adding a device is a secret, once-only exchange; removing one revokes it, which a person decides.
  'desk.screens': READ,
  'desk.screen.get': READ,
  'desk.screen.update': RECEIPT,
  'desk.screen.views': READ,
  'desk.screen.try': NEVER,
  'desk.screen.add': NEVER,
  'desk.screen.remove': DESTRUCTIVE,
  'desk.widgets': READ,
  'enroll.display.request': NEVER,
  'enroll.display.status': READ,
  'screen.state': READ,
  'screen.unlock': NEVER,
  'screen.lock': NEVER,
  'screen.image': READ,

  // Voice typing (3.1). Settings are one commit each; a download asked twice is one download; removing a model deletes
  // its file (downloaded again on *Download*), which a person decides.
  'voice.get': READ,
  'voice.update': RECEIPT,
  'voice.fetchModel': RECEIPT,
  'voice.removeModel': DESTRUCTIVE,
  'voice.setDutchVoice': DESTRUCTIVE,
} satisfies Record<OperationName, OperationSafety>;

/** `TABLE`, frozen (0.29.1, CT-195). `satisfies` keeps typecheck failing on a missing or an extra op. */
export const OPERATION_SAFETY: Readonly<Record<OperationName, OperationSafety>> = Object.freeze(TABLE);

/** The classification of `op`; undefined for a name this build doesn't know (a newer runtime's): never resend that. */
export function operationSafety(op: string): OperationSafety | undefined {
  return Object.hasOwn(OPERATION_SAFETY, op) ? OPERATION_SAFETY[op as OperationName] : undefined;
}

/**
 * Whether a client may send the same request again by itself — same id, exact input — once `status` answered
 * `not_found` (CT-194): a `receipt` op that isn't destructive. Nothing else, and nothing this build doesn't know. It
 * knows only the op: the client also holds back a request the appliance already acknowledged (`accepted`, or `status`
 * saying `accepted`/`executing`), whose `not_found` means its receipt expired.
 */
export function resendAfterNotFound(op: string): boolean {
  const safety = operationSafety(op);
  return safety?.retry === 'receipt' && !safety.destructive;
}
