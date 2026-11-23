/**
 * The managed runtime (MA-10; docs/decisions/managed-runtime.md): trust, durable commands, the allowlisted
 * dispatcher, the session event log, resources and the live sessions, built once per server process in
 * `WHOMBAT_MODE=managed` (and in tests). The session endpoint (`session/endpoint.ts`) feeds it connections.
 */
import { existsSync } from 'node:fs';
import type { Edition } from '@whombat/protocol';
import type { DirectAddresses } from '@whombat/protocol/session';
import { HostPower } from '../desk/power';
import type { DeskService } from '../desk/service';
import { type DropTimings, FeedbackDropService } from '../feedback/drop/index';
import type { Services } from '../services';
import type { BackupPort } from './backup';
import { ownNameOf } from './backup-key';
import { changesBurrows, namesTheBox } from './console-burrows';
import { RuntimeCounters } from './counters';
import { DiagnosticsService } from './diagnostics';
import type { TailscaleService } from './direct/tailscale';
import { SessionDispatcher } from './dispatcher';
import { setSessionDispatcherFor } from './dispatcher-ref';
import { SessionEventLog } from './events';
import { bluetoothFor, HostBluetoothService } from './host-bluetooth';
import { HostDiskAlerts } from './host-disk-alerts';
import { HostHardwareService } from './host-hardware';
import { HostMetricsService } from './host-metrics';
import { HostNetworkService } from './host-network';
import { type LicenceOptions, LicenceService } from './licence';
import { followLinkNotices, registerLinkSource } from './link/notices';
import { registeredAtControl } from './link/origin';
import { PushTokens } from './link/push-tokens';
import { LinkService, setLinkFor } from './link/service';
import { BoxNetworkWatch } from './network-watch';
import { ClaimLinkHandover } from './own-address/claim-handover';
import { pushForeign, registerOwnAddressSource } from './own-address/notices';
import { OwnAddressService } from './own-address/state';
import type { ManagerPort } from './ports';
import { ControlPush } from './push';
import { CommandReceipts } from './receipts';
import { RemoteHelpService, remoteHelpPasskeys, supportFor } from './remote-help';
import { SessionUploads } from './resources';
import { type SessionLimits, SessionRegistry } from './session/registry';
import type { RelayStatus } from './session/relay-client';
import { bestWayPage, TrustService } from './trust';
import { ensureBoxVapid } from './vapid';

/** The box's direct ways and its Tailscale, as the boot built them (direct-connection.md DC-12, DC-13). */
export interface DirectWays {
  tailscale: TailscaleService;
  /** The ways in to tell an enrolled session (`welcome.direct`); null while the listener isn't up. */
  addresses(): DirectAddresses | null;
}

export interface ManagedRuntimeOptions {
  manager: ManagerPort;
  /** The appliance content PeerId (from the content key; `identity.ts`). */
  appliancePeerId: string;
  /** The backup service's local API (`WHOMBAT_BACKUP_SOCKET`). */
  backup?: BackupPort;
  /** Event log retention (defaults from config). */
  events?: { maxAgeMs?: number; maxCount?: number; sweepMs?: number };
  /** Session capacity and unenrolled timeouts (tests shorten them; MR-28). */
  sessions?: Partial<SessionLimits>;
  /** The licence's key set and dev overrides; default from `WHOMBAT_LICENCE_*` (MR-55). */
  licence?: LicenceOptions;
  /** The feedback drop's timers (tests shorten them). */
  feedbackDrop?: Partial<DropTimings>;
  /** The own address's label draws and timers (tests). */
  ownAddress?: { randomInt?: (n: number) => number; timers?: boolean };
  /** The content key's signature of the box's registration, for turning Whombat Link on (the boot gives it). */
  contentProof?: () => Promise<string | null>;
  /** Whombat Link's poll timer (tests: off). */
  link?: { timers?: boolean };
}

export class ManagedRuntime {
  /**
   * Whether control registered this box before Whombat Link (whombat-link.md LNK-01): such a box keeps the claim it got
   * through control, its reports to control and links to the hosted app. Every other box is claimed on a page it served.
   * Link's features (the relay, the own address, phone push, remote help, website feedback) follow `link`, not this.
   */
  readonly registeredAtControl: boolean;
  /** Whombat Link as the manager last said it (whombat-link.md LNK-02). */
  readonly link: LinkService;
  /** Phones' own push tokens, registered at control while Link runs (LNK-36). */
  readonly pushTokens: PushTokens;
  readonly trust: TrustService;
  readonly receipts: CommandReceipts;
  readonly dispatcher: SessionDispatcher;
  readonly events: SessionEventLog;
  readonly uploads: SessionUploads;
  readonly sessions: SessionRegistry;
  readonly manager: ManagerPort;
  /** Connectivity and error counters for diagnostic bundles (MR-42). */
  readonly counters: RuntimeCounters;
  readonly diagnostics: DiagnosticsService;
  /** The appliance licence (LC-06…LC-11, MR-55…MR-61). */
  readonly licence: LicenceService;
  /** The manager's measurements of the box (docs/decisions/box-status.md BS-06). */
  readonly host: HostMetricsService;
  /** The box's hardware report and its network and Wi-Fi (hardware-support.md HD-03, HD-05…HD-07). */
  readonly hardware: HostHardwareService;
  readonly network: HostNetworkService;
  /** The box's Bluetooth (bluetooth.md BT-02…BT-08); null where the runtime has no Bluetooth service (BT-S02). */
  readonly bluetooth: HostBluetoothService | null;
  /** Remote help (remote-help.md RH-01…RH-13); null where the runtime has no support service (RH-S02). */
  readonly remoteHelp: RemoteHelpService | null;
  /** What owners hear about the box's network (network-move.md NM-09, NM-10); started by `startBoxNetworkWatch`. */
  readonly networkWatch: BoxNetworkWatch;
  /** The person's disk alerts (BS-09); started by `startHostDiskAlerts`. */
  readonly diskAlerts: HostDiskAlerts;
  /** The battery as a UPS (desk-display.md DK-10): the power line and the person's alerts; started by `startHostPower`. */
  readonly power: HostPower;
  /** The desk screen, when the boot runs the desk socket (desk-display.md DK-12); null otherwise. */
  desk: DeskService | null = null;
  /** Website feedback through the encrypted drop (docs/decisions/feedback-drop.md); started by `startFeedbackDrop`. */
  readonly feedbackDrop: FeedbackDropService;
  /** The relay connection's state (the session endpoint sets it; `stopped` without one). */
  relayStatus: () => RelayStatus = () => 'stopped';
  /**
   * The direct ways (direct-connection.md DC-12) and Tailscale (DC-13): the boot sets them; null where no boot did
   * (tests that build a runtime alone).
   */
  direct: DirectWays | null = null;
  /** Pushes through the manager to control (the restore notice sends its one push through it). */
  readonly controlPush: ControlPush;
  /** The box's own address (own-address.md): it has one while Whombat Link runs and gave it a label. */
  readonly ownAddress: OwnAddressService | null;
  /** Gives the manager the claim link for control (`own-address/claim-handover.ts`); null without an own address. */
  readonly claimHandover: ClaimLinkHandover | null = null;
  private offLink: (() => void) | null = null;
  private offLinkNotices: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private quarantineTimer: NodeJS.Timeout | null = null;
  private offBurrows: (() => void) | null = null;
  private readonly offRevoked: () => void;

  constructor(
    readonly services: Services,
    options: ManagedRuntimeOptions,
  ) {
    const config = services.config;
    this.registeredAtControl = registeredAtControl(config);
    this.manager = options.manager;
    this.counters = new RuntimeCounters(services.clock);
    this.link = new LinkService({
      services,
      manager: options.manager,
      registeredAtControl: this.registeredAtControl,
      contentProof: options.contentProof,
      name: () => ownNameOf(services),
      ...(options.link?.timers === false ? { timers: false } : {}),
    });
    setLinkFor(services, this.link);
    // Notifications become requests to control while control knows the box: opaque refs, a preview at most. Once the
    // owner turned Link off nothing goes, `security` pushes included; an ended Link still sends those. Browsers get web
    // push from the box itself on every box (its own key).
    const push = new ControlPush(services, options.manager, () => this.link.known());
    this.controlPush = push;
    services.push.control = async (principalIds, payload, extra) => {
      if (this.link.known()) await push.forPrincipals(principalIds, payload, extra);
    };
    this.pushTokens = new PushTokens(services, options.manager, this.link);
    this.trust = new TrustService(services, options.manager, options.appliancePeerId, push);
    // The own address follows Link (LNK-05): the manager answers it only while Link runs, with the label control gave.
    // A manager from before Link has no Link routes: then the runtime draws the label itself, as it did.
    this.ownAddress = new OwnAddressService({
      services,
      manager: options.manager,
      drawsLabel: () => this.link.view().assumed,
      ...options.ownAddress,
    });
    this.trust.ownAddress = this.ownAddress;
    const own = this.ownAddress;
    if (own) {
      // The console: letters without control inside A3, the claim link once the address serves its page (the local
      // page before), and the alert while a foreign certificate is valid.
      this.trust.ceremony.ownAddress = {
        local: () => own.sharedRouteOff,
        // Claimed: the address itself while it serves its page; unclaimed: the claim link. Otherwise (no certificate
        // yet, or the owner switched the address off) the best of its other ways, an HTTPS one first: a box whose
        // Tailscale name opens is used there, not on the network, and never at an address where nothing answers.
        url: () =>
          this.trust.ceremony.claimed
            ? own.serving()
              ? `https://${own.host()}/`
              : bestWayPage(this.trust.ways())
            : (own.claimUrl() ?? bestWayPage(this.trust.ways())),
        alert: () => own.alert(),
        // Under the claim link: the Tailscale page, else the address on the local network. Visitors on the internet
        // can keep the own address busy, never those.
        fallback: () =>
          !this.trust.ceremony.claimed && own.claimUrl() ? bestWayPage(this.trust.ways()) : null,
        newLink: () => own.claimLink.rotate(),
      };
      // The claim link goes to control for the account that links this box (`claim-handover.ts`): only while nobody
      // claimed the box and its address serves the page the link opens.
      const handover = new ClaimLinkHandover({
        manager: options.manager,
        current: () =>
          this.trust.ceremony.claimed === false && own.claimUrl() ? own.claimLink.current : null,
        log: services.log,
        ...(options.ownAddress?.timers === false ? { timers: false } : {}),
      });
      this.claimHandover = handover;
      own.claimLink.onRotate = () => void handover.sync();
      own.onReady = () => {
        this.trust.ceremony.refresh();
        void handover.sync();
      };
      // A certificate it didn't ask for: the screen, the Inbox and a push to the person's devices.
      own.onForeign = (found) => {
        this.trust.ceremony.refresh();
        void this.trust
          .personAccountId(services.db)
          .then((id) => (id ? pushForeign(services, push, [id], found) : undefined))
          .catch((err) => services.log.warn({ err: String(err) }, 'own address: the notice was not pushed'));
      };
      registerOwnAddressSource(() => this.ownAddress);
    }
    this.receipts = new CommandReceipts(services.db, services.clock);
    this.uploads = new SessionUploads(services);
    this.dispatcher = new SessionDispatcher(services, this.trust, this.receipts);
    // The assistant's settings tools run the person's ops through it (assistant-settings.md).
    setSessionDispatcherFor(services, this.dispatcher);
    this.dispatcher.backup = options.backup;
    this.dispatcher.manager = options.manager;
    this.dispatcher.link = this.link;
    this.dispatcher.pushTokens = this.pushTokens;
    this.events = new SessionEventLog(services, {
      maxAgeMs: options.events?.maxAgeMs ?? config.WHOMBAT_SESSION_EVENTS_MAX_AGE_HOURS * 3600_000,
      maxCount: options.events?.maxCount ?? config.WHOMBAT_SESSION_EVENTS_MAX_COUNT,
      ...(options.events?.sweepMs ? { sweepMs: options.events.sweepMs } : {}),
    });
    this.sessions = new SessionRegistry(services, options.sessions);
    // A browser with the claim link open: the screen says to type the letters there.
    this.trust.ceremony.pageOpen = () => this.sessions.claimPageOpen;
    this.sessions.onClaimPage = () => this.trust.ceremony.refresh();
    // New letters at the box also free the places devices nobody let in were holding.
    this.trust.onNewLetters = () => {
      void this.sessions
        .closeUnclaimedSetups()
        .catch((err) =>
          services.log.warn({ err: String(err) }, 'claim: the waiting sessions were not closed'),
        );
    };
    this.diagnostics = new DiagnosticsService({
      services,
      trust: this.trust,
      counters: this.counters,
      facts: () => this.dispatcher.facts,
      relay: () => this.relayStatus(),
      activeSessions: () => this.sessions.size,
    });
    this.dispatcher.diagnostics = this.diagnostics;
    this.licence = options.licence
      ? new LicenceService(services, options.manager, options.licence)
      : LicenceService.fromConfig(services, options.manager);
    this.dispatcher.licence = this.licence;
    this.host = new HostMetricsService(services, options.manager);
    this.dispatcher.host = this.host;
    this.hardware = new HostHardwareService(services, options.manager);
    this.dispatcher.hardware = this.hardware;
    this.network = new HostNetworkService(services, options.manager);
    this.dispatcher.network = this.network;
    const bluetooth = bluetoothFor(services);
    this.bluetooth = bluetooth ? new HostBluetoothService(services, bluetooth) : null;
    this.dispatcher.bluetooth = this.bluetooth ?? undefined;
    // Remote help is Whombat support's, through control (HE-25): a Link feature (LNK-07), its switches shown only while
    // Link is on or in grace (`remote-help.ts`).
    const support = supportFor(services);
    this.remoteHelp = support
      ? new RemoteHelpService(services, support, { ...remoteHelpPasskeys(this.trust), push: this.trust.push })
      : null;
    this.dispatcher.remoteHelp = this.remoteHelp ?? undefined;
    this.diskAlerts = new HostDiskAlerts(services, this.host);
    this.networkWatch = new BoxNetworkWatch(services, this.network);
    this.power = new HostPower(services, this.host);
    this.feedbackDrop = new FeedbackDropService(services, options.manager, {
      claimed: () => this.trust.isClaimed(),
      ...(options.feedbackDrop ? { timings: options.feedbackDrop } : {}),
    });
    services.feedback.drop = this.feedbackDrop;
    // The claim starts the licence state (grace `no_licence` until the manager's first token, LC-09), and the site
    // cards can be published from now on (FD-11).
    this.trust.onClaimed = async () => {
      await this.licence
        .claimed()
        .catch((err) => services.log.warn({ err: String(err) }, 'licence: claim not recorded'));
      if (this.link.active()) this.feedbackDrop.requestSync(0);
    };
    // Control hears about every revocation at once, whoever made it: a person's device, or a screen they removed.
    this.offRevoked = services.bus.onControl((c) => {
      if (c.type !== 'endpoint.revoked') return;
      void this.trust.reportPending();
      // A removed phone's push handle goes at control (LNK-36).
      void this.pushTokens
        .forget(c.endpointId)
        .catch((err) =>
          this.services.log.warn({ err: String(err) }, 'push: a removed device’s token stayed'),
        );
    });
  }

  /** Follows the quarantine marker (checked now and every 5 s). */
  watchQuarantine(file: string, everyMs = 5_000): void {
    const check = () => {
      const on = existsSync(file);
      if (on !== this.services.maintenance.quarantined) {
        this.services.maintenance.quarantined = on;
        this.services.log.warn(
          { quarantined: on },
          on
            ? 'quarantine: a restored replacement; no schedules, automations, turns or outbound effects'
            : 'quarantine released',
        );
      }
    };
    check();
    this.quarantineTimer = setInterval(check, everyMs);
    this.quarantineTimer.unref?.();
  }

  async start(): Promise<void> {
    await this.trust.loadClientFloor();
    // The person's mail server (HE-S224), and a community box's own web push key, made at its first start (HE-S220).
    await this.services.boxMail
      .load()
      .catch((err) => this.services.log.warn({ err: String(err) }, 'mail: the settings weren’t read'));
    // Every box keeps its own Web Push key for its HTTPS pages, with or without Link (LNK-05).
    this.services.push.useOwnVapid(
      await ensureBoxVapid(this.services).catch((err) => {
        this.services.log.warn({ err: String(err) }, 'web push: the box’s own key isn’t there');
        return null;
      }),
    );
    // Whombat Link's state before anything that follows it starts (LNK-02).
    await this.link.start().catch((err) => this.services.log.warn({ err: String(err) }, 'link: not started'));
    registerLinkSource(() => this.link);
    this.offLinkNotices = followLinkNotices(this.services, this.link, this.controlPush, async () => {
      const id = await this.trust.personAccountId(this.services.db).catch(() => null);
      return id ? [id] : [];
    });
    this.offLink = this.link.onChange((after, before) => this.linkMoved(after.link.state, before.link.state));
    // Whether the support service answers decides the `remote_help` feature of the first welcomes (RH-S09).
    await this.remoteHelp?.refresh();
    // Before any worker ticks: the licence gate knows the state (LC-10).
    await this.licence.load();
    this.licence.start();
    // Before a claim can start: whether this box is inside A3, its label and its certificate (own-address.md).
    await this.ownAddress
      ?.start()
      .catch((err) => this.services.log.warn({ err: String(err) }, 'own address: not started'));
    this.trust.ceremony.refresh();
    // Control keeps backup envelopes for the box passkeys it was told of: the set, at every start (own-address.md).
    this.trust.boxPasskeys.declareSoon();
    // The console's claim state (CC-08): claimed, waiting for a lookup lease, or in backoff from earlier failures.
    await this.trust.refreshClaimConsole();
    // Now that the claim state and the address are known: the claim link for control, while nobody claimed the box.
    await this.claimHandover?.start();
    // The claimed console shows the burrows (CT-116, MR-78): re-read them after every commit that creates, renames or
    // removes one (the bus carries committed frames only).
    this.offBurrows = this.services.bus.onFrame((frame) => {
      // The box's name is its oldest burrow's or the one the person's app gave the screen: control hears a new one
      // while Link runs, for the account site.
      if (namesTheBox(frame)) void this.link.tellName();
      if (!changesBurrows(frame)) return;
      this.trust
        .refreshConsoleBurrows()
        .catch((err) => this.services.log.warn({ err: String(err) }, 'console: burrows not refreshed'));
    });
    await this.trust.refreshLinks();
    await this.events.start();
    // Receipts retention and pending control reports, every few minutes.
    this.timer = setInterval(() => {
      const hours = this.services.config.WHOMBAT_COMMAND_RECEIPT_HOURS;
      this.receipts
        .sweep(hours * 3600_000)
        .catch((err) => this.services.log.warn({ err: String(err) }, 'command receipt sweep failed'));
      void this.trust.reportPending();
      // Phones' tokens Link couldn't register yet, and handles of removed devices (LNK-36).
      void this.pushTokens.sync().catch(() => {});
      // Diagnostic bundles older than 7 days go (a signed `diagnostics.expired` each).
      this.diagnostics
        .sweep()
        .catch((err) => this.services.log.warn({ err: String(err) }, 'diagnostics sweep failed'));
    }, 5 * 60_000);
    this.timer.unref?.();
    void this.trust.reportPending();
  }

  /**
   * Starts publishing site cards and collecting drops (the server's `index.ts`, never in a read-only start; tests
   * drive `feedbackDrop` by hand or call this).
   */
  startFeedbackDrop(): void {
    // Website feedback goes through control's encrypted drop (FD-21): a Link feature (LNK-05).
    this.feedbackDropWanted = true;
    if (this.link.active()) this.startDropOnce();
  }

  private feedbackDropWanted = false;
  private feedbackDropStarted = false;

  private startDropOnce(): void {
    if (this.feedbackDropStarted || !this.feedbackDropWanted) return;
    this.feedbackDropStarted = true;
    this.feedbackDrop.start();
  }

  /**
   * What follows Link when it moves (LNK-05): the own address reads its state again (and keeps reading it every few
   * seconds for a while, so the address the person who just linked the box waits for is served soon), phones' tokens are registered,
   * remote help and the screen show it, and website feedback starts once Link runs. The relay endpoint follows it in
   * the boot.
   */
  private linkMoved(state: string, before: string): void {
    if (state === before) {
      this.trust.ceremony.refresh();
      return;
    }
    this.ownAddress?.soon();
    void this.ownAddress?.poll().catch(() => {});
    void this.pushTokens
      .sync()
      .catch((err) => this.services.log.warn({ err: String(err) }, 'push: tokens not synced'));
    void this.remoteHelp?.refresh();
    // Kit envelope copies at control follow Link (LNK-05): the set is declared again once Link runs.
    this.trust.boxPasskeys.declareSoon();
    if (this.link.active()) this.startDropOnce();
    this.trust.ceremony.refresh();
  }

  /**
   * The edition this box shows its pages and apps (`welcome.edition`, `DirectIdentity.edition`, CT-1300) while they
   * still read it (whombat-link.md LNK-01, phase 1): `commercial` for a box control registered (its pages are the hosted
   * app's), `community` for every other box, claimed and used on its own pages. Not the image's switch.
   */
  get edition(): Edition {
    return this.registeredAtControl ? 'commercial' : 'community';
  }

  /** Starts checking the disk for the person's alerts (the server's `index.ts`, never in a read-only start; BS-09). */
  startHostDiskAlerts(): void {
    this.diskAlerts.start();
  }

  /** Starts reading the box's network every minute for the owners' Inbox (`index.ts`, never read-only; NM-09). */
  startBoxNetworkWatch(): void {
    this.networkWatch.start();
  }

  /** Starts checking the power every minute for the person's alerts (`index.ts`, never read-only; DK-10). */
  startHostPower(): void {
    this.power.start();
  }

  /**
   * Starts following the support service's events (`index.ts`, never read-only; RH-S05): records them, keeps the state
   * fresh and tells the person.
   */
  startRemoteHelp(): void {
    this.remoteHelp?.follow();
  }

  async close(): Promise<void> {
    this.ownAddress?.stop();
    this.claimHandover?.stop();
    this.link.stop();
    this.offLink?.();
    this.offLinkNotices?.();
    this.trust.boxPasskeys.stop();
    this.diskAlerts.close();
    this.networkWatch.close();
    this.network.moves.close();
    this.power.close();
    this.bluetooth?.close();
    await this.remoteHelp?.close();
    this.desk?.close();
    await this.feedbackDrop.close();
    if (this.services.feedback.drop === this.feedbackDrop) this.services.feedback.drop = null;
    if (this.timer) clearInterval(this.timer);
    if (this.quarantineTimer) clearInterval(this.quarantineTimer);
    this.licence.close();
    this.offBurrows?.();
    this.offBurrows = null;
    this.offRevoked();
    this.trust.ceremony.close();
    this.services.push.control = null;
    this.controlPush.close();
    await this.sessions.closeAll('shutdown');
    this.sessions.close();
    this.events.close();
  }
}
