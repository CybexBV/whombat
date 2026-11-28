import { useLocation, useNavigate } from '@tanstack/react-router';
import { whombatSectionPlace } from '@whombat/client';
import { useDesk, useDeskScreens } from '@whombat/client/desk/react';
import {
  updateView,
  type WhombatAction,
  type WhombatOverview,
  type WhombatPart,
  whombatOverview,
  whombatPartLabel,
  whombatParts,
} from '@whombat/client/managed';
import { useBootstrap, useProtectedSupported, useTheAgent, useVaultNetworks } from '@whombat/client/react';
import { type ApplianceStatus, sessionOps } from '@whombat/client/session';
import { agentsReachLanOn, deskWords, protectedPageWords } from '@whombat/core';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppServices, useCommunity } from '../../app/providers';
import type { WhombatTabPart } from '../../app/routing/search';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StatusDot } from '../../components/StatusDot';
import { DESK_SCREENS_TEXT, HERMES_WORDS, THIS_WHOMBAT_TEXT } from '../../i18n/clientWords';
import { currentLocale } from '../../i18n/provider';
import { useLocaleWords } from '../../i18n/words';
import { useBackupPasskeyTap } from '../../managed/backupPasskey';
import { QuietHoursSection } from '../care/QuietHoursSection';
import { DeskUnlockRow } from '../desk/DeskSection';
import { ScreenTab } from '../desk/ScreenTab';
import { type ScreenPart, screenTabShown } from '../desk/screenTab';
import { useDeskHere, useDeskUnlockHere } from '../desk/useDeskHere';
import { useDeskNameSync } from '../desk/useDeskNameSync';
import { AppLink } from '../files/AppLink';
import { HostStatusSection } from '../host';
import { BluetoothSection, HardwareSection, MailSection, NetworkSection, TailscaleSection } from '../machine';
import { OwnAddressSection } from '../machine/OwnAddressSection';
import { ReachSection } from '../machine/ReachSection';
import { useReach } from '../machine/useReach';
import { ScreensTab } from '../screens/ScreensTab';
import { TeamReportsAbout } from '../teamReports/TeamReportsAbout';
import { VoiceSection } from '../voice/VoiceSection';
import { AgentUpdatesSection } from './AgentUpdatesSwitch';
import { BackupFileSection } from './BackupFileSection';
import { BackupOverview, useBackupOptionsShown } from './BackupOverview';
import { BackupPlacesSection } from './BackupPlaces';
import {
  ApplianceLoadError,
  ManagedAbout,
  ManagedBackups,
  ManagedPolicy,
  useApplianceStatus,
} from './ManagedTabs';
import { RemoteHelpSection } from './RemoteHelpSection';
import styles from './SettingsScreen.module.css';
import tw from './ThisWhombat.module.css';
import { usePartInView } from './usePartInView';
import { useWhombatVersions } from './version';

const T = THIS_WHOMBAT_TEXT;

type Appliance = ReturnType<typeof useApplianceStatus>;
type Go = (part: WhombatPart, hash?: string) => void;

/** Opens another part of This Whombat (replaces `&section=`), at a place in it when `hash` is given. */
export type GoToPart = (part: WhombatTabPart, hash?: string) => void;

/**
 * Settings → This Whombat (`?tab=appliance`; settings-groups.md; docs/decisions/this-whombat-sections.md
 * AP-1221…AP-1234): four parts under the Settings tabs, the open one at `&section=`.
 * - **Overview**: NEEDS YOU (what is wrong, each with its button; first the desk screen asking to unlock,
 *   desk-display-web.md AP-3009), HOW IT’S DOING (the tiles, the charts behind Show charts, the power line), VOICE
 *   TYPING (docs/decisions/dictation.md), NETWORK, BLUETOOTH and AT A GLANCE (one line per part, a link to it);
 *   `whombatOverview` decides. Its devices and the assistant's access are You's Devices and the assistant's What it may
 *   do now: their rows go there.
 * - **Backups** (a managed Whombat, or where the backup file is offered): the backups, their options and the list
 *   (backup-options.md AP-6800), ON YOUR NETWORK, RECOVERY KIT, BACKUP FILE; a box from before as it was.
 * - **Screen**, where the box has a screen (or one paired) or the runtime has screens of widgets: the box's screen as a
 *   desk display, or every screen (`&part=`, `&screen=`).
 * - **About**: which Whombat this is and whether it is up to date, the versions under Technical details, WHOMBAT TEAM
 *   (Report a problem or idea, where the person may send one or has some), the quiet hours, then on a
 *   managed Whombat UPDATES (with “Keep server agents up to date” where servers are), PLAN, HARDWARE (every part folded),
 *   REMOTE HELP and TURNED OFF HERE (what this Whombat doesn't do, with why). The audit log, the signing keys and the
 *   diagnostics file are Advanced's; where this Whombat is and the news it reads have a page of their own, Settings →
 *   News and weather.
 * A Whombat is one person's: every section is theirs to change (one-person.md AP-5671).
 */
export function ThisWhombatTab({
  burrow,
  section = 'overview',
  onSectionChange,
  screenPart,
  onScreenPartChange,
  screen: screenId,
  onScreenChange,
  onEditLayout,
}: {
  burrow: string;
  section?: WhombatTabPart;
  onSectionChange?: GoToPart;
  /** Screen: its part (`&part=`); What it shows by default. */
  screenPart?: ScreenPart | undefined;
  onScreenPartChange?: ((part: ScreenPart) => void) | undefined;
  /** Screens: a screen's own page (`&screen=`); the list without. */
  screen?: string | undefined;
  onScreenChange?: ((screen: string | undefined) => void) | undefined;
  onEditLayout?: ((screen: string) => void) | undefined;
}) {
  const DESK_WORDS = useLocaleWords(deskWords);
  const { managed } = useAppServices();
  const community = useCommunity();
  const navigate = useNavigate();
  const screen = useScreenPart(burrow, section === 'screen');
  const parts: WhombatTabPart[] = [
    'overview',
    ...(whombatParts({ managed: managed !== null, backupFile: true }).includes('backups')
      ? (['backups'] as const)
      : []),
    ...(screen.shown ? (['screen'] as const) : []),
    'about',
  ];
  // A part this Whombat doesn't have (an old link, AP-1222) shows the Overview.
  const part = parts.includes(section) ? section : 'overview';
  usePartInView(tw.parts ?? '', part);
  const hash = useLocation({ select: (l) => l.hash.replace(/^#/, '') });
  const appliance = useApplianceStatus();
  // The agent by its name (less-is-more.md AP-1806; one-agent.md AP-4905).
  const assistant = useTheAgent(burrow).words.name;
  const overview = useOverview(burrow, appliance.status, part, assistant);
  // The desk screen asking to unlock is one more thing on the Overview that needs you (AP-3009).
  const desk = useDeskUnlockHere(burrow);
  // Opening This Whombat gives its screen the Whombat's name when it has another.
  useDeskNameSync(burrow);
  const badges = desk.request
    ? { ...overview.badges, overview: (overview.badges.overview ?? 0) + 1 }
    : overview.badges;
  // The Overview's rows name the parts this Whombat had: Devices is You's now, the assistant's access its What it may do.
  const go: Go = (next, at) => {
    const moved = whombatSectionPlace(next);
    if (moved)
      void navigate({
        to: '/settings',
        search: { tab: moved.group === 'you' ? undefined : moved.group, part: moved.part },
        hash: at,
      } as never);
    else onSectionChange?.(next as WhombatTabPart, at);
  };
  const label = (p: WhombatTabPart) =>
    p === 'screen' ? (screen.screens ? DESK_SCREENS_TEXT.tab : DESK_WORDS.settings.tab) : null;
  return (
    <>
      <SegmentedControl
        variant="soft"
        label={T.partsLabel}
        className={tw.parts}
        value={part}
        onChange={(next) => onSectionChange?.(next)}
        options={parts.map((p) => ({
          value: p,
          label: label(p) ?? (
            <PartLabel part={p as WhombatPart} badge={badges[p as WhombatPart]} assistant={assistant} />
          ),
        }))}
      />
      {part === 'overview' ? (
        <OverviewPart burrow={burrow} overview={overview} appliance={appliance} desk={desk} go={go} />
      ) : part === 'backups' ? (
        // Empty only on a server that offers the backup file and then answers that it has none (AP-1201).
        <PartBody empty={T.nothingHere}>
          {managed ? <ApplianceSections appliance={appliance} /> : null}
          {!managed ? (
            // Outside a managed Whombat (fixture mode) the backups and the places, where a box answers them.
            <>
              <BackupOverview agentName={assistant} burrow={burrow} />
              <BackupPlacesSection />
            </>
          ) : appliance.status ? (
            <ManagedBackups
              status={appliance.status}
              reload={appliance.reload}
              setUp={hash === 'set-up'}
              agentName={assistant}
              burrow={burrow}
            />
          ) : null}
          <ProtectedLinkSection withBackups={managed ? !!appliance.status : null} />
          <BackupFileSection burrow={burrow} />
        </PartBody>
      ) : part === 'screen' ? (
        screen.screens ? (
          <ScreensTab
            burrow={burrow}
            {...(screenId ? { screen: screenId } : {})}
            onScreenChange={(next) => onScreenChange?.(next)}
            onEditLayout={(id) => onEditLayout?.(id)}
            {...(screenPart ? { part: screenPart } : {})}
            {...(onScreenPartChange ? { onPartChange: onScreenPartChange } : {})}
          />
        ) : (
          <ScreenTab burrow={burrow} part={screenPart} onPartChange={onScreenPartChange} />
        )
      ) : (
        <PartBody>
          <AboutHead status={appliance.status} />
          {/* Telling the Whombat Team about a problem or an idea (Whombat team-reports.md), where that is open. */}
          <TeamReportsAbout burrow={burrow} />
          {/* When the assistant may install updates and restart things (care-plan.md), before the updates themselves. */}
          <QuietHoursSection burrow={burrow} />
          {managed ? <ApplianceSections appliance={appliance} /> : null}
          {managed ? (
            appliance.status ? (
              <ManagedAbout
                burrow={burrow}
                status={appliance.status}
                onSetUpBackups={() => onSectionChange?.('backups', 'set-up')}
                onChanged={appliance.reload}
                connection={false}
              />
            ) : null
          ) : (
            // A self-hosted Whombat's UPDATES holds only the agents' switch (agent-updates-app.md AP-2986).
            <AgentUpdatesSection burrow={burrow} />
          )}
          {/* How it is reached: Whombat Link, its address and Tailscale (whombat-link.md LNK-42). */}
          {managed ? <ReachSection onTailscale={() => onSectionChange?.('overview', 'tailscale')} /> : null}
          {/* The box's own address, its switch and its certificate watch (it shows nothing without one). */}
          {managed ? <OwnAddressSection /> : null}
          {/* The machine's parts (hardware-support-web.md AP-3228), every part folded. */}
          <HardwareSection burrow={burrow} />
          {/* Letting Whombat support in for a while (remote-help.md AP-4448, RH-12): a Link feature (LNK-07). */}
          {managed ? <LinkedRemoteHelp community={community} /> : null}
          {/* What this Whombat doesn't do here, with why (a community box: website feedback, remote help…). */}
          {managed && appliance.status ? <ManagedPolicy status={appliance.status} /> : null}
        </PartBody>
      )}
    </>
  );
}

/**
 * Remote help is a Whombat Link feature (whombat-link.md LNK-07): shown while Link is on or ending. A box before Link
 * keeps the old rule (none on a community box, HE-58).
 */
function LinkedRemoteHelp({ community }: { community: boolean }) {
  const { session } = useAppServices();
  const { reach } = useReach(session);
  if (reach === undefined) return null;
  const state = reach?.link?.state;
  const shown = reach?.link ? state === 'on' || state === 'grace' : !community;
  return shown ? <RemoteHelpSection /> : null;
}

/**
 * Whether This Whombat has a Screen part, and of which kind: where the box has a screen (or one paired), or the runtime
 * answers `desk.screens` (screens of widgets, DK-149: a tablet can be one). While the screen is still being asked, an
 * address that opens it keeps it.
 */
export function useScreenPart(burrow: string, asked: boolean): { shown: boolean; screens: boolean } {
  const { desk: service } = useAppServices();
  const here = useDeskHere(burrow);
  const desk = useDesk(here.api);
  const screens = useDeskScreens(here.api);
  // No desk to ask is an answer; a desk not asked yet (the bootstrap still on its way) isn't.
  const known =
    service === null ||
    ((desk.isError || desk.data !== undefined) && (screens.isError || screens.data !== undefined));
  return {
    shown: screenTabShown(desk.data) || screens.data !== undefined || (asked && !known),
    screens: screens.data !== undefined,
  };
}

/** A part's name in the control, with how many things in it need you (AP-1226). */
function PartLabel({
  part,
  badge,
  assistant,
}: {
  part: WhombatPart;
  badge: number | undefined;
  assistant: string;
}) {
  return (
    <span className={tw.partLabel}>
      {whombatPartLabel(part, assistant, currentLocale())}
      {badge ? (
        <>
          <span className={tw.badge} aria-hidden="true">
            {badge}
          </span>
          <span className={tw.srOnly}>{T.partNeeds('', badge)}</span>
        </>
      ) : null}
    </span>
  );
}

/** Where a managed Whombat's own state couldn't be read, its line and Try again. */
function ApplianceSections({ appliance }: { appliance: Appliance }) {
  return appliance.error ? <ApplianceLoadError reload={appliance.reload} /> : null;
}

/**
 * A part's sections, spaced like the panel. With `empty`, a part whose sections all have nothing to show says so — after
 * a moment, so sections still loading don't flash it (Agents’ access, AP-1230).
 */
function PartBody({ children, empty }: { children: ReactNode; empty?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [nothing, setNothing] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !empty) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      if (el.childElementCount > 0) setNothing(false);
      else timer = setTimeout(() => setNothing(el.childElementCount === 0), 1_000);
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(el, { childList: true });
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [empty]);
  return (
    <>
      <div ref={ref} className={tw.partBody}>
        {children}
      </div>
      {empty && nothing ? <p className={tw.nothing}>{empty}</p> : null}
    </>
  );
}

/* Overview ---------------------------------------------------------------------------------------------------------- */

/**
 * What the Overview needs to know beyond `appliance.status` (AP-1223…AP-1225): the devices and your passkeys on a
 * managed Whombat; what the agent may reach and the versions everywhere. Asked again when another part opens, so what
 * was done there (a passkey added) shows on the way back.
 */
function useOverview(
  burrow: string,
  status: ApplianceStatus | null,
  /** The open part: asked again on the way back from another one. */
  part: string,
  assistant: string,
): WhombatOverview {
  const { session, managed } = useAppServices();
  const versions = useWhombatVersions();
  const access = useAccessSummary(burrow);
  const passkey = useBackupPasskeyTap();
  const refresh = passkey?.refresh;
  // biome-ignore lint/correctness/useExhaustiveDependencies: returning from a part refreshes the shared setup status
  useEffect(() => {
    void refresh?.();
  }, [refresh, part]);
  const [box, setBox] = useState<{ devices: number | null } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `part` asks again on the way back from another part
  useEffect(() => {
    if (!managed) return;
    let live = true;
    void sessionOps
      .endpointsList(session)
      .catch(() => null)
      .then((result) => {
        const endpoints = result?.endpoints;
        if (!live) return;
        setBox({
          devices: endpoints ? endpoints.filter((d) => d.revocation === 'none').length : null,
        });
      });
    return () => {
      live = false;
    };
  }, [session, managed, part]);
  return useMemo(
    () =>
      whombatOverview({
        status,
        devices: box?.devices ?? null,
        passkeys: passkey?.view ?? null,
        access,
        versions: { app: versions.app, runtime: versions.runtime },
        agent: assistant,
        locale: currentLocale(),
      }),
    [status, box, passkey?.view, access, versions.app, versions.runtime, assistant],
  );
}

/**
 * What the agent may reach, for AT A GLANCE (AP-1225): the local network (no browser, AP-5250). Its commands run on the
 * Whombat itself, so the switch is always there (Whombat one-person.md OP-07; AP-5671).
 */
function useAccessSummary(burrow: string): { lan: 'open' | number | null } {
  const networks = useVaultNetworks({});
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const lan = bootstrap
    ? agentsReachLanOn(bootstrap.burrow)
      ? 'open'
      : (networks.data?.networks.length ?? 0)
    : null;
  return useMemo(() => ({ lan }), [lan]);
}

function OverviewPart({
  burrow,
  overview,
  appliance,
  desk,
  go,
}: {
  burrow: string;
  overview: WhombatOverview;
  appliance: Appliance;
  desk: ReturnType<typeof useDeskUnlockHere>;
  go: Go;
}) {
  const { managed } = useAppServices();
  const community = useCommunity();
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const passkey = useBackupPasskeyTap();
  return (
    <PartBody>
      <ApplianceSections appliance={appliance} />
      {overview.needsYou.length > 0 || desk.request ? (
        <section className={styles.section} aria-labelledby="this-whombat-needs">
          <SectionLabel as="h2" id="this-whombat-needs">
            {T.needsYou}
          </SectionLabel>
          <div className={cx(styles.card, tw.needsCard)} data-needs-you="">
            {desk.request ? <DeskUnlockRow here={desk.here} request={desk.request} /> : null}
            {overview.needsYou.map((item, i) => (
              <div key={item.key} className={styles.row}>
                <StatusDot tone={item.dot} size={8} label={T.dotLabels[item.dot]} />
                <span className={styles.rowMain}>
                  <span className={styles.rowTitle}>{item.title}</span>
                  {item.meta ? <span className={styles.rowMeta}>{item.meta}</span> : null}
                  {item.action === 'setUpPasskey' && passkey?.note ? (
                    <span className={styles.rowMeta} role="status">
                      {passkey.note}
                    </span>
                  ) : null}
                </span>
                {item.action ? (
                  <NeedsButton action={item.action} primary={i === 0 && !desk.request} go={go} />
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <HostStatusSection burrow={burrow} />
      {/* Voice typing, heard by this Whombat (docs/decisions/dictation.md DT-06). */}
      <VoiceSection />
      {/* The cable and Wi-Fi (hardware-support-web.md AP-3223). */}
      <NetworkSection burrow={burrow} onHardware={() => go('about', 'hardware')} />
      {/* Reach this Whombat over Tailscale (HE-51; hermes-engine-app.md AP-5326): a box's session only. */}
      {managed ? <TailscaleSection /> : null}
      {/* The person's own mail server on a community box (HE-61; AP-5427). */}
      {managed && community ? <MailSection email={bootstrap?.me.email ?? ''} /> : null}
      {/* Keyboards, mice, speakers and headphones (bluetooth-web.md AP-3711). */}
      <BluetoothSection burrow={burrow} onHardware={() => go('about', 'hardware')} />
      {overview.glance.length > 0 ? (
        <section className={styles.section} aria-labelledby="this-whombat-glance">
          <SectionLabel as="h2" id="this-whombat-glance">
            {T.glance}
          </SectionLabel>
          <div className={styles.card} data-glance="">
            {overview.glance.map((item) => (
              <button
                key={item.key}
                type="button"
                className={cx(styles.row, tw.glanceRow)}
                data-part={item.part}
                onClick={() => go(item.part)}
              >
                {/* A row is a button named by its words; its dot adds nothing to the name. */}
                <StatusDot tone={item.dot} size={8} label={null} />
                <span className={styles.rowMain}>
                  <span className={styles.rowTitle}>{item.title}</span>
                  {item.meta ? <span className={styles.rowMeta}>{item.meta}</span> : null}
                </span>
                <span className={tw.chevron} aria-hidden="true">
                  <Icon icon={ChevronRight} size={16} />
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </PartBody>
  );
}

/**
 * Under this Whombat's backups: What's protected, for everything else that holds data (backup-trust.md). Only beside
 * backups of its own, so a Whombat without them still says there is nothing to set here. `withBackups` is a managed
 * Whombat's answer; `null` asks the backup service, as the backups above do.
 */
function ProtectedLinkSection({ withBackups }: { withBackups: boolean | null }) {
  const supported = useProtectedSupported();
  const shown = useBackupOptionsShown();
  if (!supported || !(withBackups ?? (shown === 'yes' || shown === 'down'))) return null;
  const words = protectedPageWords(currentLocale());
  return (
    <section className={styles.section} aria-label={words.link}>
      <div className={styles.card}>
        <AppLink
          href="/protected"
          className={cx(styles.row, tw.glanceRow, tw.linkRow)}
          data-protected-link=""
        >
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{words.link}</span>
            <span className={styles.rowMeta}>{words.linkHint}</span>
          </span>
          <span className={tw.chevron} aria-hidden="true">
            <Icon icon={ChevronRight} size={16} />
          </span>
        </AppLink>
      </div>
    </section>
  );
}

/**
 * A NEEDS YOU row's button (AP-1224): the first row's is primary. Saving a kit starts at once; the rest open their
 * part, at the place when there is one.
 */
function NeedsButton({ action, primary, go }: { action: WhombatAction; primary: boolean; go: Go }) {
  const { managed } = useAppServices();
  // Start setup from the person's click so the browser can open its passkey prompt.
  const tap = useBackupPasskeyTap();
  const variant = primary ? 'primary' : 'secondary';
  const label = action === 'setUpPasskey' && tap ? tap.label : T.actions[action];
  const step: Record<WhombatAction, () => void> = {
    setUpBackups: () => go('backups', 'set-up'),
    openBackups: () => go('backups'),
    saveKit: () => (managed?.onKit ? managed.onKit() : go('backups')),
    openDevices: () => go('devices'),
    setUpPasskey: () => {
      if (!tap) return go('devices', 'passkeys');
      void tap();
    },
  };
  return (
    <Button
      variant={variant}
      size="sm"
      disabled={action === 'setUpPasskey' && !!tap && (tap.busy || (!tap.view && !tap.loadError))}
      onClick={step[action]}
    >
      {label}
    </Button>
  );
}

/* Sections of every Whombat ----------------------------------------------------------------------------------------- */

/**
 * About's head: which Whombat this is in one line — “Whombat 0.2.0 · Up to date” where the update says so —
 * and every version (the app's build, the Whombat's, Hermes Agent's, the contracts') under Technical details.
 */
function AboutHead({ status }: { status: ApplianceStatus | null }) {
  const v = useWhombatVersions();
  const [open, setOpen] = useState(false);
  const ids = useId();
  const update = status ? updateView(status).rows[0] : undefined;
  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`} data-version="">
      <SectionLabel as="h2" id={`${ids}-label`}>
        VERSION
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row}>
          {update ? <StatusDot tone={update.dot} size={8} label={null} /> : null}
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>Whombat {v.runtime ?? v.app}</span>
            {update ? <span className={styles.rowMeta}>{update.title}</span> : null}
          </span>
          <Button
            variant="link"
            size="sm"
            aria-expanded={open}
            aria-controls={`${ids}-details`}
            onClick={() => setOpen((was) => !was)}
          >
            {open ? 'Hide technical details' : 'Technical details'}
          </Button>
        </div>
        {open ? (
          <div id={`${ids}-details`}>
            <VersionRow
              title="App"
              meta={
                v.build ? (
                  <>
                    Build <span className={styles.buildId}>{v.build}</span>
                  </>
                ) : (
                  'This web app'
                )
              }
              value={v.app}
            />
            {v.runtime ? (
              <VersionRow title="Whombat" meta="This Whombat’s software" value={v.runtime} />
            ) : null}
            {/* What the assistant runs on (chat-settle.md AP-6159; Whombat hermes-updates.md HU-02): a box says it. */}
            {v.hermes !== undefined ? (
              <VersionRow
                title={HERMES_WORDS.title}
                meta={HERMES_WORDS.meta}
                value={v.hermes ?? HERMES_WORDS.unknown}
                known={v.hermes !== null}
              />
            ) : null}
            {v.contracts ? (
              <VersionRow title="Contracts" meta="What the app speaks" value={v.contracts} />
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function VersionRow({
  title,
  meta,
  value,
  known = true,
}: {
  title: string;
  meta: ReactNode;
  value: string;
  /** False: the value is words (“Not known yet”), not a version in mono. */
  known?: boolean;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{title}</span>
        <span className={styles.rowMeta}>{meta}</span>
      </span>
      <span className={known ? styles.fingerprint : styles.rowMeta}>{value}</span>
    </div>
  );
}
