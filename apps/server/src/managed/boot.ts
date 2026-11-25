/**
 * Starting the runtime in the server process (MA-10): the content identity, the manager socket client, the runtime
 * (trust, dispatcher, events), the claim secret from provisioning, the session endpoint (relay, the direct listener and
 * the Noise responder; direct-connection.md), Tailscale, and the admin socket for the manager. `index.ts` calls it at
 * every start; in development the identity and the manager are stood in (`dev-standins.ts`) and there is no relay
 * (`relay: false`).
 */

import { readFileSync } from 'node:fs';
import { defaultWhombatHome } from '@whombat/agent-runtime/host';
import { z } from 'zod';
import { recordRuntimeRelease } from '../automations/release-gate';
import { startKeepPlaceRight } from '../backup-places/keep-right';
import { looksFor } from '../backups/look/service';
import { type Config, useBoxPageAsApp, webDistDir } from '../config';
import { setCouncilWays } from '../council/ways';
import { shotUploads } from '../delegate/upload';
import { DeskBluetoothRoutes } from '../desk/bluetooth';
import { createDeskCalmSources } from '../desk/calm-sources';
import { DeskClaimRoutes } from '../desk/claim-letters';
import { DeskNetworkRoutes } from '../desk/network';
import { DeskRemoteHelpRoutes } from '../desk/remote-help';
import { screenSessionsFor } from '../desk/screen-sessions';
import { DeskService } from '../desk/service';
import { DeskSocket } from '../desk/socket';
import { registerBoxBackupSource } from '../home/box-backup';
import type { Services } from '../services';
import { useShares } from '../shares/publish';
import { startShareRound } from '../shares/round';
import { useTeamReports } from '../team-reports/control';
import { startTeamReportsFollow } from '../team-reports/follow';
import { registerTeamReportsSource } from '../team-reports/inbox';
import { AdminSocket } from './admin-socket';
import { BackupSocketClient } from './backup';
import { startBackupKeys } from './backup-key';
import { registerBackupPasskeySource } from './backup-key-inbox';
import { useBoxBackup } from './box-backup';
import { type DirectInterfaceSpec, type InterfaceTable, lanIpv6Only } from './direct/network';
import { directAddresses } from './direct/routes';
import { directSettings } from './direct/settings';
import { setTailscaleFor, TAILSCALE_SIGNED_OUT_TEXT, TailscaleService } from './direct/tailscale';
import { directWeb } from './direct/web';
import { loadContentIdentity } from './identity';
import { contentProofSigner } from './link/origin';
import { followLinkWithRelay } from './link/relay-follow';
import { consoleReach } from './link/service';
import { ManagerSocketClient } from './manager-client';
import { registerBoxNetworkSource } from './network-watch';
import { readDeviceTest } from './own-address/device-test';
import type { ManagerPort, SecureResponder } from './ports';
import { providerLogins } from './providers/service';
import { listenSignInSocket } from './providers/signin-socket';
import { startRestoreNotice } from './restore-notice';
import { ManagedRuntime } from './runtime';
import { SessionEndpoint } from './session/endpoint';
import { secureResponder } from './session/secure';
import { tellThePerson } from './tell-person';
import { bestWayPage } from './trust';
import { registerUpdateOwnerSource } from './update-inbox';

/**
 * Provisioning's `claim.json` (the appliance's provisioning `ClaimFile`). `secretHash` is null for a self-registered
 * device without a card (`whombat-provision self`, CC-10): only the console code claims it.
 */
export const ClaimFile = z.object({
  v: z.literal(1),
  deviceId: z.string().min(1).max(128),
  secretHash: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .nullable(),
  algorithm: z.literal('sha256-b64url(whombat-claim-secret/1)'),
});

export interface ManagedBoot {
  runtime: ManagedRuntime;
  endpoint: SessionEndpoint;
  admin: AdminSocket;
  close(): Promise<void>;
}

export async function startManaged(
  services: Services,
  config: Config,
  overrides: {
    manager?: ManagerPort;
    responder?: SecureResponder;
    appliancePeerId?: string;
    /** Open the relay endpoint while Whombat Link runs (default); false: never (tests without a relay). */
    relay?: boolean;
    /** Tests: where the box's ways are read from (a stand-in network card) instead of the listener's interfaces. */
    ways?: { interfaces: DirectInterfaceSpec[]; table: () => InterfaceTable };
  } = {},
): Promise<ManagedBoot> {
  if (!config.WHOMBAT_ADMIN_SOCKET) throw new Error('WHOMBAT_ADMIN_SOCKET is required');
  let responder = overrides.responder;
  let appliancePeerId = overrides.appliancePeerId;
  // The content key signs the box's part of Whombat Link's registration (whombat-link.md LNK-03).
  let contentProof: (() => Promise<string | null>) | undefined;
  if (!responder || !appliancePeerId || config.WHOMBAT_CONTENT_KEY_FILE) {
    if (!config.WHOMBAT_CONTENT_KEY_FILE) throw new Error('WHOMBAT_CONTENT_KEY_FILE is required');
    const identity = loadContentIdentity(config.WHOMBAT_CONTENT_KEY_FILE);
    responder ??= secureResponder(identity);
    appliancePeerId ??= identity.peerId;
    contentProof = contentProofSigner(config, identity);
  }
  let manager = overrides.manager;
  if (!manager) {
    if (!config.WHOMBAT_MANAGER_SOCKET) throw new Error('WHOMBAT_MANAGER_SOCKET is required');
    manager = new ManagerSocketClient(config.WHOMBAT_MANAGER_SOCKET);
  }
  const runtime = new ManagedRuntime(services, {
    manager,
    appliancePeerId,
    ...(contentProof ? { contentProof } : {}),
    ...(config.WHOMBAT_BACKUP_SOCKET ? { backup: new BackupSocketClient(config.WHOMBAT_BACKUP_SOCKET) } : {}),
  });
  // Needs you's backup proposal and the assistant's backup tool reach the backup service through it (first-day.md).
  if (runtime.dispatcher.backup) {
    const backup = runtime.dispatcher.backup;
    useBoxBackup(services, { port: backup, status: () => runtime.dispatcher.facts.backup });
    registerBoxBackupSource();
  }
  // One job keeps the place in use right (backup-options.md): its address, its cleanup, the person's time zone, and
  // what is still to do or say about the box's backups; the places' hints say when cleanup or room needs a look.
  const stopPlaces = runtime.dispatcher.backup ? startKeepPlaceRight(services) : null;
  // A restored box tells the person it is back and waits for their answer (its one push in quarantine).
  const stopRestoreNotice = runtime.dispatcher.backup
    ? startRestoreNotice(services, runtime.dispatcher.backup, runtime.controlPush)
    : null;
  // The person's passkey locks the backup details again after every backup and move (backup-passkey.md).
  const stopKeys = runtime.dispatcher.backup
    ? startBackupKeys(services, { appliance: appliancePeerId, manager })
    : null;
  if (runtime.dispatcher.backup) registerBackupPasskeySource();
  // An update waiting for the owner's yes, in the Inbox (ask-before-updating.md ABU-05).
  registerUpdateOwnerSource(() => runtime.dispatcher.facts.update);
  // Which release the box would go back to says whether automations the release before them can't run may run here
  // (automations/release-gate.ts); this release says it knows them for the releases after it.
  services.newerAutomations.follow(() => runtime.dispatcher.facts.update);
  if (services.schemaAccess === 'read-write')
    await recordRuntimeRelease(services.db, config, services.clock()).catch((err) =>
      services.log.warn({ err: String(err) }, 'this release could not be recorded'),
    );
  // Shared links (share-links.md): the manager's share routes, and the round that keeps the links right.
  useShares(services, manager);
  startShareRound(services);
  // Reports to the Whombat Team (team-reports.md): a Link account's, so only while Link is on or in grace. A
  // development box has no Link: its manager stand-in has no Link routes and its stand-in team answers instead.
  const link = runtime.link;
  useTeamReports(
    services,
    manager,
    () => link.running() || (config.NODE_ENV === 'development' && link.view().assumed),
  );
  registerTeamReportsSource();
  startTeamReportsFollow(services);
  // A backup opened to bring one thing back closes when unused for two hours and when the box stops (backup-look.md).
  const looks = runtime.dispatcher.backup ? looksFor(services) : null;
  if (looks && runtime.dispatcher.backup) await looks.start(runtime.dispatcher.backup).catch(() => {});
  // The box's network in the owners' Inbox: a cable that stopped, the cable as the backup, connections that refuse
  // Whombat after its address changed (network-move.md NM-09, NM-10).
  registerBoxNetworkSource();
  // The console says `starting` until the claim state is known (CC-08).
  runtime.trust.ceremony.announceStarting();
  // Before any worker ticks: a restored replacement starts quarantined.
  if (config.WHOMBAT_QUARANTINE_FILE) runtime.watchQuarantine(config.WHOMBAT_QUARANTINE_FILE);
  let claimRecord: z.infer<typeof ClaimFile> | null = null;
  // A box control registered has provisioning's claim record; a box that made its identity itself is claimed on a page
  // it served (whombat-link.md LNK-01).
  const local = !runtime.registeredAtControl;
  if (config.WHOMBAT_CLAIM_FILE && !local) {
    try {
      claimRecord = ClaimFile.parse(JSON.parse(readFileSync(config.WHOMBAT_CLAIM_FILE, 'utf8')));
    } catch (err) {
      services.log.warn({ err: String(err) }, 'the claim record could not be read');
    }
  }
  // A backup restored onto a new box takes this box's device id before the licence loads.
  if (claimRecord) {
    try {
      const old = await runtime.trust.adoptDeviceId(claimRecord);
      if (old)
        services.log.warn({ from: old, to: claimRecord.deviceId }, 'restored onto a new box: new device id');
    } catch (err) {
      services.log.warn({ err: String(err) }, 'the device id could not be checked');
    }
  }
  await runtime.start();
  if (claimRecord && !(await runtime.trust.isClaimed())) {
    try {
      const outcome = await runtime.trust.provisionClaim(claimRecord);
      services.log.info({ outcome }, 'claim record loaded');
    } catch (err) {
      services.log.warn({ err: String(err) }, 'the claim record could not be stored');
    }
  }
  // The direct listener (HE-50, direct-connection.md): the local network and Tailscale, loopback in development.
  const direct = directSettings(config);
  // Tailscale for This Whombat (HE-51): the manager drives it (CT-1255).
  const tailscale = new TailscaleService(manager, services.log);
  runtime.dispatcher.tailscale = tailscale;
  // The agent's `tailnet_devices` reads the tailnet through it (tailnet-reach.md TN-06).
  setTailscaleFor(services, tailscale);
  // Signed out of the tailnet by Tailscale itself (its key ran out, removed there): the person hears it (TN-05).
  tailscale.onSignedOut = () => {
    void tellThePerson(services, TAILSCALE_SIGNED_OUT_TEXT).catch((err) =>
      services.log.warn({ err: String(err) }, 'tailscale: the sign-out wasn’t told'),
    );
  };
  const web = direct ? directWeb(webDistDir(config)) : null;
  if (direct && !web)
    services.log.info(
      { dir: webDistDir(config) },
      'direct listener: no web build here, so no page for browsers',
    );
  const endpoint = new SessionEndpoint(runtime, responder, manager, {
    // The own address's page (own-address.md): the box build, as on the local network. It serves while Link runs.
    ...(runtime.ownAddress
      ? {
          ownAddress: {
            web: web ?? directWeb(webDistDir(config)),
            ...(config.WHOMBAT_MANAGER_ACME_SOCKET ? { acmeSocket: config.WHOMBAT_MANAGER_ACME_SOCKET } : {}),
            // The phone passkey device test, DEV only and off unless its file is there (device-test.ts).
            deviceTest: readDeviceTest({
              home: defaultWhombatHome({ WHOMBAT_HOME: config.WHOMBAT_HOME }),
              env: process.env,
              log: services.log,
            }),
          },
        }
      : {}),
    ...(direct
      ? {
          direct: {
            ...direct,
            hostnames: () => [...direct.hostnames, ...tailscale.hostnames()],
            // The hosted web app tries the box's Tailscale route first (DC-04): only on a box control registered, whose
            // page that is. A box claimed on its own pages, or one that started with its own address only (A3,
            // own-address.md), is opened by no page Cybex serves.
            origins: () =>
              local || !config.WHOMBAT_APP_URL || runtime.ownAddress?.sharedRouteOff
                ? []
                : [new URL(config.WHOMBAT_APP_URL).origin],
            // Pages only over HTTPS (LNK-10, DC-19): a plain-HTTP visitor is told these.
            httpsAddresses: () => httpsAddresses(runtime),
            web,
            // A council's builder sends its pictures here (council.md CNL-31).
            posts: shotUploads(services),
            tls: (name) => tailscale.certificate(name),
          },
        }
      : {}),
  });
  runtime.direct = {
    tailscale,
    addresses: () =>
      direct && endpoint.direct?.status().listening
        ? directAddresses({
            port: endpoint.direct.boundPort(),
            interfaces: overrides.ways?.interfaces ?? direct.interfaces,
            tailscale: tailscale.last,
            ...(overrides.ways ? { interfaceTable: overrides.ways.table() } : {}),
          })
        : null,
  };
  // Links the box makes name its ways (CT-1304, HE-S208). Development has no way but loopback (DC-12): its page there
  // stands in, so links can be tried on this machine (HE-S221).
  runtime.trust.ways = () => {
    const routes = runtime.direct?.addresses()?.routes ?? [];
    if (routes.length || !direct?.development || !endpoint.direct?.status().listening) return routes;
    const port = endpoint.direct.boundPort();
    return [{ way: 'lan', socket: `ws://localhost:${port}/v1/direct`, web: `http://localhost:${port}/` }];
  };
  // A council's builder reaches the box by these to send its pictures (council.md CNL-31).
  setCouncilWays(services, () => runtime.trust.ways());
  const pages = local ? boxPages(services, config, runtime, endpoint, tailscale) : null;
  // The screen shows how the box is reached in any state (4.4 `ConsoleState.reach`): Link's code while it starts,
  // Tailscale's sign-in link when it needs one (whombat-link.md LNK-13, LNK-14, LNK-06a).
  runtime.trust.ceremony.reach = () =>
    consoleReach(runtime.link.view(), tailscale.managed ? tailscale.last : null);
  runtime.trust.ceremony.reachPending = () => !runtime.link.answered;
  // A network that gave the box only IPv6 addresses: the screen says an IPv4 address is another way, whichever those
  // addresses are (a link-local or a public one is no way to tell anyone, so the box names none).
  runtime.trust.ceremony.ipv6Only = () =>
    direct !== null && lanIpv6Only(overrides.ways?.interfaces ?? direct.interfaces, overrides.ways?.table());
  // The runtime started before these were set: the screen shows them now, not at its next change.
  runtime.trust.ceremony.refresh();
  tailscale.onChange = () => {
    pages?.refresh();
    runtime.trust.ceremony.refresh();
  };
  const admin = new AdminSocket({
    runtime,
    endpoint,
    ...(config.WHOMBAT_RELEASE_ID ? { releaseId: config.WHOMBAT_RELEASE_ID } : {}),
  });
  await admin.listen(config.WHOMBAT_ADMIN_SOCKET);
  // The desk screen (docs/decisions/desk-display.md DK-12): the console server's socket, beside the console file.
  const deskSocket = config.WHOMBAT_DESK_SOCKET
    ? await startDesk(services, runtime, config.WHOMBAT_DESK_SOCKET)
    : null;
  // The runner's sign-in executor talks to us only on this socket when it is configured (MR-34).
  const signIn =
    config.WHOMBAT_SIGNIN_SOCKET && providerLogins(services).bridge
      ? await listenSignInSocket(services, config.WHOMBAT_SIGNIN_SOCKET)
      : null;
  // The relay carries the box's sessions and its own address's door while Whombat Link runs (LNK-05), and only then.
  const relay = followLinkWithRelay({
    active: () => runtime.link.active(),
    start: () => endpoint.start(),
    close: () => endpoint.stopRelay(),
  });
  const followRelay = () => {
    if (overrides.relay !== false) relay.follow();
  };
  followRelay();
  const offRelay = runtime.link.onChange(() => {
    followRelay();
    pages?.refresh();
  });
  tailscale.start();
  if (await endpoint.startDirect()) {
    const port = endpoint.direct?.boundPort() ?? 0;
    services.log.info({ port, interfaces: direct?.interfaces }, 'direct listener started');
    pages?.refresh();
    // Development (HE-49): the page on this machine, where `enroll.dev` lets the browser in.
    if (direct?.development)
      services.log.info({}, `Open http://localhost:${port}/ to use this Whombat in a browser here.`);
  }
  return {
    runtime,
    endpoint,
    admin,
    async close() {
      await looks?.stop();
      stopPlaces?.();
      stopRestoreNotice?.();
      stopKeys?.();
      pages?.stop();
      tailscale.onChange = null;
      offRelay();
      relay.stop();
      tailscale.stop();
      await endpoint.stop();
      await deskSocket?.close();
      await signIn?.close();
      await admin.close();
      await runtime.close();
    },
  };
}

/** How often a box reads its own page again (its addresses and Tailscale change without a restart). */
const PAGE_REFRESH_MS = 30_000;

/**
 * The box's HTTPS addresses for its page, best first (whombat-link.md LNK-10): its own address while it serves, then its
 * Tailscale name while that has HTTPS.
 */
export function httpsAddresses(runtime: ManagedRuntime): string[] {
  const out: string[] = [];
  const own = runtime.ownAddress;
  if (own?.serving()) out.push(`https://${own.host()}/`);
  // The Tailscale name's page is on the direct listener's port: its way says it exactly.
  for (const way of runtime.trust.ways())
    if (way.web?.startsWith('https://') && !out.includes(way.web)) out.push(way.web);
  return out;
}

/**
 * The address a box names for itself, the same choice on every box: an HTTPS address first (its own address while it
 * serves, then its Tailscale name while that has HTTPS), else the first of its ways in (its address on the local
 * network). Null while nobody can reach it. Loopback only where `trust.ways` offers it: a development box that listens
 * there, never a box in someone's home, where “localhost” would be the reader's own phone or computer.
 */
export function boxPage(runtime: ManagedRuntime): string | null {
  return httpsAddresses(runtime)[0] ?? bestWayPage(runtime.trust.ways());
}

/**
 * The page of a box claimed on its own pages (hermes-engine.md HE-S202, HE-S211, HE-S230; whombat-link.md LNK-01): with
 * no hosted app of its own, `boxPage` is where links, the console and the app's origin point, read again every 30 s and
 * after each Tailscale or Link change; passkeys run on its Tailscale name while that has HTTPS, and nowhere else.
 */
function boxPages(
  services: Services,
  config: Config,
  runtime: ManagedRuntime,
  endpoint: SessionEndpoint,
  tailscale: TailscaleService,
): { refresh(): void; stop(): void } {
  const page = () => boxPage(runtime);
  // Without an address the screen says to check the network, not where to go.
  runtime.trust.ceremony.hasWay = () => page() !== null;
  // Even where the image names the hosted app (`WHOMBAT_APP_URL`, every environment has one): this box's pages are its own.
  useBoxPageAsApp(config, page);
  if (services.config !== config) useBoxPageAsApp(services.config, page);
  runtime.trust.relyingParty = () => {
    const ts = tailscale.last;
    const port = endpoint.direct?.status().listening ? endpoint.direct.boundPort() : null;
    if (ts.state !== 'on' || !ts.name || !ts.https || !port) return null;
    return { rpId: ts.name, origins: [new URL(`https://${ts.name}:${port}`).origin] };
  };
  let last: string | null = null;
  let lastIpv6Only: boolean | null = null;
  let lastFallback: string | null = null;
  const refresh = () => {
    const now = page();
    // The screen also says when the network gave only IPv6, which can change while the box still names no address.
    const ipv6Only = runtime.trust.ceremony.ipv6Only?.() ?? false;
    // And the other way in it names under the claim link: the network can give the box a new address while its own
    // address stays.
    const fallback = runtime.trust.ceremony.ownAddress?.fallback() ?? null;
    if (now === last && ipv6Only === lastIpv6Only && fallback === lastFallback) return;
    const moved = now !== last;
    last = now;
    lastIpv6Only = ipv6Only;
    lastFallback = fallback;
    runtime.trust.ceremony.refresh();
    if (!moved) return;
    void runtime.trust
      .refreshLinks()
      .catch((err) => services.log.warn({ err: String(err) }, 'links: the box’s page wasn’t read'));
  };
  const timer = setInterval(refresh, PAGE_REFRESH_MS);
  timer.unref?.();
  return {
    refresh,
    stop: () => {
      clearInterval(timer);
    },
  };
}

/**
 * The desk (desk-display-server.md DK-S18): the service the session ops and the console share, and its socket. A socket
 * that can't be made leaves the box without a desk (logged): the runtime runs on, the console stays as it was.
 */
async function startDesk(
  services: Services,
  runtime: ManagedRuntime,
  path: string,
): Promise<DeskSocket | null> {
  const desk = new DeskService(services, {
    power: runtime.power,
    push: runtime.trust.push,
    remoteHelp: runtime.remoteHelp,
    // The top bar's *Updating* (DK-118) from what the manager last pushed about its update.
    calmSources: createDeskCalmSources(services, { updateFacts: () => runtime.dispatcher.facts.update }),
  });
  // The screen's network routes (hardware-support.md HD-07): the manager's network, the runtime's claim, the desk's lock.
  const network = new DeskNetworkRoutes({
    network: runtime.network,
    claimed: () => runtime.trust.isClaimed(),
    unlocked: () => desk.lock.unlocked(services.clock().getTime()),
    touch: () => void desk.lock.touch(services.clock().getTime()),
  });
  // The screen's Bluetooth routes (bluetooth.md BT-02): the Bluetooth service (none: `no_adapter`), the claim, the lock.
  const bluetooth = new DeskBluetoothRoutes({
    bluetooth: runtime.bluetooth,
    claimed: () => runtime.trust.isClaimed(),
    unlocked: () => desk.lock.unlocked(services.clock().getTime()),
    touch: () => void desk.lock.touch(services.clock().getTime()),
  });
  // Remote help's Stop on the screen (remote-help.md RH-04): no unlock, it only takes access away.
  const remoteHelp = new DeskRemoteHelpRoutes(
    { remoteHelp: runtime.remoteHelp, state: () => desk.state() },
    services.log,
  );
  // New letters on the claim screen (whombat-link.md): asked for at the box, where only the console reaches.
  const claim = new DeskClaimRoutes({ newLetters: () => runtime.trust.openClaimWindow() });
  const socket = new DeskSocket(services, desk, [network, bluetooth, remoteHelp, claim]);
  try {
    await socket.listen(path);
  } catch (err) {
    desk.close();
    services.log.warn({ err: String(err), path }, 'desk socket: not started; this box has no desk screen');
    return null;
  }
  runtime.desk = desk;
  runtime.dispatcher.desk = desk;
  // Screens elsewhere (desk-display.md DK-146): their lock and ops over the desk's screens.
  runtime.dispatcher.screens = screenSessionsFor(services, desk.screens, (pin) => desk.checkScreenPin(pin));
  // The screen pairs itself when it should (DK-17): only where the console can show it.
  desk.start();
  return socket;
}
