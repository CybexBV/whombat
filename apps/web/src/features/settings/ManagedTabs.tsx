/**
 * Settings of a managed Whombat (AP-22), shown only when the app runs over an appliance session, as sections of
 * Settings → This Whombat's parts (docs/decisions/this-whombat-sections.md AP-1228…AP-1232; was one page, SS-06):
 *
 * - **Backups** (`ManagedBackups`) — the top card, what needs you, the list of backups and their options
 *   (`BackupOverview`, backup-options.md AP-6800); a box from before or without a destination: backups (last success,
 *   coverage, age, failure; “Unprotected”; the destination and Back up now). Then the places and the recovery kit.
 * - **Devices** (`ManagedDevices`) — this browser and the person's other devices (`endpoints.list`) in one
 *   list, letting a new device in by the link or the code it shows: look it up (`enroll.pair.lookup`), show its name,
 *   kind and fingerprint to compare with the new device's screen, then approve with that fingerprint
 *   (`enroll.pair.approve`, CT-46); removing a device (`endpoints.revoke`: pending until the device is told, then
 *   applied); passkeys and removed devices not yet told (one-person.md AP-5671: no owners, no getting back in).
 * - **Turned off here** (`ManagedPolicy`, at the end of About) — what a managed Whombat turns off, with the reason.
 * - **About** (`ManagedAbout`, `DiagnosticsSection`) — updates, the plan, the connection and its fingerprint, and the
 *   diagnostic files. The AI providers' sign-ins are in Settings → AI, once (SS-03).
 *
 * Not in the mock: settings' own page shell, section labels and bordered-row cards.
 */
import { createLink, useLocation } from '@tanstack/react-router';
import { NeedsNewerAppError, SCREEN_NEEDS_NEWER_APP } from '@whombat/client';
import {
  addDeviceLink,
  ago,
  askFirstView,
  BACKUP_OPTIONS_TEXT,
  backupBlocksText,
  bringBackLaterOffered,
  CHANNEL_TEXT,
  type CheckedPreview,
  COMMUNITY_TEXT,
  COPY,
  channelErrorText,
  channelView,
  coverageGaps,
  DIAGNOSTIC_SCOPE_LIST,
  type DiagnosticScope,
  DiagnosticsIntegrityError,
  downloadDiagnostics,
  keepOnlyLivePasskeys,
  LINK_TEXT,
  linkErrorText,
  linkTimeLeft,
  MANAGED_TEXT,
  orderPasskeys,
  PAIRING_CODE,
  PASSKEY_COPY,
  PASSKEY_SETUP_TEXT,
  pairingErrorKey,
  passkeyEnrolledDevices,
  passkeyErrorText,
  passkeyMeta,
  passkeyRemove,
  platformName,
  previewDiagnostics,
  readOwnAddress,
  readUpdatesChannel,
  SCOPE_LABELS,
  THIS_WHOMBAT_TEXT,
  UPDATE_TEXT,
  updatePollMs,
  updateView,
} from '@whombat/client/managed';
import { useBackupCheckpoints } from '@whombat/client/react';
import {
  type ApplianceStatus,
  type DeviceLinkCreated,
  type DiagnosticBundleSummary,
  type EndpointSummary,
  OperationError,
  type OwnAddressSummary,
  type PairLookupOutput,
  type PasskeysList,
  sessionOps,
} from '@whombat/client/session';
import { formatBytes } from '@whombat/core/text';
import type { BackupBringBack, PasskeySummary } from '@whombat/protocol/session';
import { ChevronDown, CircleCheck } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useAppServices, useCommunity } from '../../app/providers';
import { Button, ButtonLink } from '../../components/Button';
import { copyText } from '../../components/CopyButton';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { QrCode } from '../../components/QrCode';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StatusDot } from '../../components/StatusDot';
import { Tag } from '../../components/Tag';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import { saveBlob } from '../../lib/saveBlob';
import { useBackupPasskeyTap } from '../../managed/backupPasskey';
import { BOX_PAGE_TEXT } from '../../managed/pageText';
import { FingerprintConfirm } from '../mobile/FingerprintConfirm';
import { AgentUpdatesSection, AgentUpdatesSwitch } from './AgentUpdatesSwitch';
import { BackupOverview, useBackupOptionsShown } from './BackupOverview';
import { BackupPlacesSection, CurrentPlaceRow } from './BackupPlaces';
import { BoxPasskeysSection } from './BoxPasskeysSection';
import dv from './Devices.module.css';
import { BackupActions } from './ManagedAccounts';
import styles from './SettingsScreen.module.css';
import tw from './ThisWhombat.module.css';

export { MANAGED_TEXT };

/**
 * A managed Whombat's `appliance.status` for This Whombat's parts (one ask for all of them; nothing elsewhere), with
 * `reload` for after a change.
 */
export function useApplianceStatus() {
  const { session, managed } = useAppServices();
  const [status, setStatus] = useState<ApplianceStatus | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(() => {
    if (!managed) return;
    setError(false);
    sessionOps.applianceStatus(session).then(setStatus, () => setError(true));
  }, [session, managed]);
  useEffect(load, [load]);
  // While an update moves or waits, the section follows it (AP-258): asked again every few seconds, quietly (a
  // failed ask keeps what is shown).
  const pollMs = updatePollMs(status?.update);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new status arms the next ask
  useEffect(() => {
    if (!pollMs) return;
    let live = true;
    const timer = setTimeout(() => {
      sessionOps.applianceStatus(session).then(
        (s) => live && setStatus(s),
        () => {},
      );
    }, pollMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [session, status, pollMs]);
  return { status, error, reload: load };
}

/** What control says a release brought (`rollout.releaseSummary`), for “Updated to … on …”; null while unknown. */
function useReleaseSummary(release: string | null): string | null {
  const { managed } = useAppServices();
  const [summary, setSummary] = useState<{ release: string; text: string } | null>(null);
  useEffect(() => {
    if (!release || !managed?.control) return;
    let live = true;
    managed.control.releaseSummary(release).then(
      (r) => live && setSummary(r?.summary ? { release, text: r.summary } : null),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [release, managed?.control]);
  return summary && summary.release === release ? summary.text : null;
}

const RouterButtonLink = createLink(ButtonLink);

function Row({
  dot,
  title,
  meta,
  action,
}: {
  dot?: 'ok' | 'warn' | 'bad' | 'mut';
  title: string;
  meta?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className={styles.row}>
      {dot && <StatusDot tone={dot} size={8} label={title} />}
      <div className={styles.rowMain}>
        <span className={styles.rowTitle}>{title}</span>
        {meta && <span className={styles.rowMeta}>{meta}</span>}
      </div>
      {action}
    </div>
  );
}

/** A security view this app can't read (AP-266): “This needs a newer version of the app. …” with Reload. */
function NeedsNewerAppRow() {
  return (
    <Row
      dot="warn"
      title={SCREEN_NEEDS_NEWER_APP}
      action={
        <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
          Reload
        </Button>
      }
    />
  );
}

function Section({ label, id, children }: { label: string; id?: string; children: React.ReactNode }) {
  return (
    <section className={styles.section} aria-label={label} id={id}>
      <SectionLabel as="h2">{label}</SectionLabel>
      <div className={styles.card}>{children}</div>
    </section>
  );
}

/** A managed Whombat's own state didn't load: the line and Try again, where a part's sections would be. */
export function ApplianceLoadError({ reload }: { reload: () => void }) {
  return (
    <div className={styles.card}>
      <Row
        title={MANAGED_TEXT.loadError}
        action={
          <Button variant="secondary" size="sm" onClick={reload}>
            {MANAGED_TEXT.retry}
          </Button>
        }
      />
    </div>
  );
}

/**
 * This Whombat → Backups (this-whombat-sections.md AP-1228), a managed Whombat's: on a Whombat that lists its backups
 * the top card, the list and Details (`BackupOverview`), ON YOUR NETWORK, and “Bring back a Whombat you had” while it
 * started fresh; else BACKUPS (state, the place that keeps them, coverage, the destination and Back up now; `setUp` opens
 * the destination form, from the Overview's “Set up backups”), ON YOUR NETWORK and, on a Whombat from before the
 * passkey, RECOVERY KIT. The BACKUP FILE follows them, from the part. The Inbox's Finish and Try again
 * (`&finish=restore`, `&restore=again`) open bringing it back where it stands.
 */
export function ManagedBackups({
  status,
  reload,
  setUp,
  agentName,
  burrow,
}: {
  status: ApplianceStatus;
  reload: () => void;
  setUp: boolean;
  agentName: string;
  burrow?: string;
}) {
  const { managed, session } = useAppServices();
  const [backupOpen, setBackupOpen] = useState(setUp);
  const shown = useBackupOptionsShown();
  const list = useBackupCheckpoints(session);
  const bringBackAsked = useLocation({
    select: (l) => {
      const q = l.search as { finish?: unknown; restore?: unknown };
      return q.finish === 'restore' || q.restore === 'again';
    },
  });
  useEffect(() => {
    if (setUp) setBackupOpen(true);
  }, [setUp]);
  const onBringBack = managed?.onBringBack;
  useEffect(() => {
    if (bringBackAsked) onBringBack?.(false);
  }, [bringBackAsked, onBringBack]);
  if (!managed) return null;
  const b = status.backup;
  // Bringing back a Whombat you had, later: a Whombat that knows the passkey (it says `bringBack`) takes `replace`.
  const later =
    onBringBack && b.bringBack !== undefined
      ? bringBackLaterOffered({ list: list.data ?? null, unprotected: b.state === 'unprotected' })
      : false;
  const laterRow = later && onBringBack ? <BringBackLater onBringBack={() => onBringBack(true)} /> : null;
  // The backups, their options and the list (backup-options.md AP-6800): where the box answers them and backups are
  // set up, also while its backup service isn't answering (the page says so and keeps what it knows). A box from
  // before, or one without backups, shows the part as before (with “Set up backups”).
  if (b.state !== 'unprotected' && shown === 'loading') return null;
  if (b.state !== 'unprotected' && (shown === 'yes' || shown === 'down'))
    return (
      <>
        <BackupOverview
          agentName={agentName}
          {...(burrow ? { burrow } : {})}
          lastKnownAt={b.lastSuccessAt}
          onChanged={reload}
        />
        {/* The passkey locks the backups again after every move: no new kit to save (backup-passkey.md BPK-03). */}
        <BackupPlacesSection
          onChanged={reload}
          {...(!b.bringBack && managed.onKit ? { onKit: managed.onKit } : {})}
        />
        {laterRow}
      </>
    );
  const { gaps, onPurpose } = coverageGaps(b.unprotected);
  const backupDot =
    b.state === 'protected' ? 'ok' : b.state === 'pending' ? 'mut' : b.state === 'stale' ? 'warn' : 'bad';
  // A Whombat from before the passkey keeps its recovery kit's row; on one that knows it the passkey is the key.
  const onKit = b.bringBack ? undefined : managed.onKit;
  return (
    <>
      <Section label={MANAGED_TEXT.backups} id="set-up">
        <Row
          dot={backupDot}
          title={MANAGED_TEXT.backup[b.state]}
          meta={
            b.state === 'unprotected'
              ? // What a missing destination blocks (UP-F1): breaking updates wait for a checkpoint.
                `${MANAGED_TEXT.backup.unprotectedMeta} ${backupBlocksText(status) ?? ''}`.trim()
              : [
                  b.lastSuccessAt ? MANAGED_TEXT.backup.last(ago(b.lastSuccessAt)) : MANAGED_TEXT.backup.none,
                  b.lastFailure?.reason,
                  b.recoverable ? MANAGED_TEXT.backup.recoverable : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
          }
        />
        {/* The NAS or server that keeps them, when one does (backup-places.md AP-6701). */}
        <CurrentPlaceRow />
        {b.coverage.length > 0 && (
          <Row
            title={MANAGED_TEXT.backup.covers}
            meta={`${b.coverage.map((c) => SCOPE_LABELS[c] ?? c).join(', ')}${b.relogin.length ? `. ${MANAGED_TEXT.backup.relogin}` : ''}`}
          />
        )}
        <BackupActions
          unprotected={b.state === 'unprotected'}
          onKit={onKit}
          open={backupOpen}
          onOpenChange={(open) => {
            setBackupOpen(open);
            if (!open) reload();
          }}
        />
        {/* A real gap warns; what the backup leaves out by design is a quiet line that says why. */}
        {gaps.length > 0 && (
          <Row
            dot="warn"
            title={MANAGED_TEXT.backup.notCovered}
            meta={gaps.map((c) => SCOPE_LABELS[c] ?? c).join(', ')}
          />
        )}
        {onPurpose.length > 0 && (
          <Row
            title={MANAGED_TEXT.backup.onPurpose}
            meta={MANAGED_TEXT.backup.onPurposeMeta(onPurpose.map((c) => SCOPE_LABELS[c] ?? c).join(', '))}
          />
        )}
      </Section>

      <BackupPlacesSection onChanged={reload} {...(onKit ? { onKit } : {})} />

      {laterRow}

      {onKit ? (
        <Section label={MANAGED_TEXT.kit}>
          {status.recovery.kitVerified ? (
            <Row dot="ok" title={MANAGED_TEXT.kitSaved} meta={MANAGED_TEXT.kitSavedMeta} />
          ) : (
            // No kit is not a warning (BX-01): a quiet row; you can make one for a box without a screen.
            <Row
              dot="mut"
              title={MANAGED_TEXT.kitMissing}
              meta={
                status.recovery.rotationPending
                  ? MANAGED_TEXT.kitRotationPending
                  : MANAGED_TEXT.kitMissingMeta
              }
              action={
                <Button variant="secondary" size="sm" onClick={onKit}>
                  {MANAGED_TEXT.kitMake}
                </Button>
              }
            />
          )}
        </Section>
      ) : null}
    </>
  );
}

/** “Bring back a Whombat you had”, while this one started fresh (backup-options.md BKO-29): its own flow asks first. */
function BringBackLater({ onBringBack }: { onBringBack: () => void }) {
  const L = BACKUP_OPTIONS_TEXT.later;
  return (
    <Section label={BACKUP_OPTIONS_TEXT.bringBack.kicker} id="bring-back">
      <Row
        title={L.title}
        meta={L.meta}
        action={
          <Button variant="secondary" size="sm" onClick={onBringBack}>
            {L.button}
          </Button>
        }
      />
    </Section>
  );
}

/**
 * This Whombat → About (AP-1231), a managed Whombat's: UPDATES (waiting for what and since when, failed and why, the
 * last update and what it brought, AP-258; the oldest app builds let in), with “Updates from” (Production or Development), and CONNECTION. An
 * update that waits for a backup destination offers “Set up backups”, which opens Backups with the form open. UPDATES
 * ends with “Keep server agents up to date” where the hosts service keeps it (agent-updates-app.md AP-2986).
 */
export function ManagedAbout({
  burrow,
  status,
  onSetUpBackups,
  onChanged,
  connection = true,
}: {
  burrow: string;
  status: ApplianceStatus;
  onSetUpBackups: () => void;
  /** The status changed here (Update now, Ask before updating): asks for it again. */
  onChanged?: () => void;
  /** CONNECTION with the box's fingerprint; false where it is Advanced's (the signing keys). */
  connection?: boolean;
}) {
  const { managed, session } = useAppServices();
  const toast = useToast();
  const updates = updateView(status);
  const summary = useReleaseSummary(updates.summaryOf);
  const [installing, setInstalling] = useState<string | null>(null);
  if (!managed) return null;
  // The owner's yes to the update waiting for them (ask-before-updating.md ABU-03).
  const install = (release: string) => {
    setInstalling(release);
    sessionOps.applianceUpdateInstall(session, release).then(
      () => {
        toast.show(UPDATE_TEXT.installing);
        onChanged?.();
      },
      (e) => {
        setInstalling(null);
        toast.show(e instanceof OperationError ? e.message : UPDATE_TEXT.failed);
        onChanged?.();
      },
    );
  };
  return (
    <>
      {status.update && (
        <Section label={MANAGED_TEXT.updates}>
          {updates.rows.map((row) => (
            <Row
              key={row.title}
              dot={row.dot}
              title={row.title}
              meta={row.lastUpdate && summary ? [row.meta, summary].filter(Boolean).join(' · ') : row.meta}
              action={
                row.action === 'backup' ? (
                  <Button variant="secondary" size="sm" onClick={onSetUpBackups}>
                    {UPDATE_TEXT.setUpBackups}
                  </Button>
                ) : row.action === 'install' && row.release ? (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={installing === row.release}
                    onClick={() => row.release && install(row.release)}
                  >
                    {UPDATE_TEXT.install}
                  </Button>
                ) : undefined
              }
            />
          ))}
          <AskFirstRow status={status} {...(onChanged ? { onChanged } : {})} />
          <ChannelRow />
          {floors(status).length > 0 && (
            <Row
              dot="mut"
              title={MANAGED_TEXT.clientFloor}
              meta={MANAGED_TEXT.clientFloorMeta(floors(status))}
            />
          )}
          {/* “Keep server agents up to date” (agent-updates-app.md AP-2986). */}
          <AgentUpdatesSwitch burrow={burrow} last={false} />
        </Section>
      )}
      {status.update ? null : <AgentUpdatesSection burrow={burrow} />}

      {connection ? (
        <Section label={MANAGED_TEXT.connection}>
          <Row
            dot="ok"
            title={managed.applianceName ?? 'Your Whombat'}
            // Its version is under VERSION at the top of the part (SS-06).
            meta={`${MANAGED_TEXT.connected} · ${MANAGED_TEXT.fingerprint(managed.applianceFingerprint)}`}
          />
        </Section>
      ) : null}
    </>
  );
}

/**
 * “Ask before updating” (ask-before-updating.md ABU-01): the owner's switch, kept by the box's manager; only where the
 * manager says it keeps it. Saved at once; shows the choice until the box's next status agrees.
 */
function AskFirstRow({ status, onChanged }: { status: ApplianceStatus; onChanged?: () => void }) {
  const ids = useId();
  const toast = useToast();
  const { session } = useAppServices();
  const view = askFirstView(status);
  const [wanted, setWanted] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = view?.on;
  useEffect(() => {
    if (shown !== undefined && shown === wanted) setWanted(null);
  }, [shown, wanted]);
  if (!view) return null;
  const on = wanted ?? view.on;
  const save = (next: boolean) => {
    setBusy(true);
    setWanted(next);
    sessionOps
      .applianceUpdateAsk(session, next)
      .then(
        (r) => {
          setWanted(r.askFirst);
          toast.show(UPDATE_TEXT.askSwitched(r.askFirst));
          onChanged?.();
        },
        (e) => {
          setWanted(null);
          toast.show(e instanceof OperationError ? e.message : UPDATE_TEXT.failed);
        },
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className={styles.row} data-row="ask-first">
      <span className={styles.rowMain}>
        <label className={styles.rowTitle} htmlFor={`${ids}-ask`}>
          {view.title}
        </label>
        <span className={styles.rowMeta} id={`${ids}-hint`}>
          {on ? UPDATE_TEXT.askOn : UPDATE_TEXT.askOff}
        </span>
      </span>
      <Toggle
        id={`${ids}-ask`}
        checked={on}
        disabled={busy}
        aria-describedby={`${ids}-hint`}
        onCheckedChange={(next) => save(next)}
      />
    </div>
  );
}

/**
 * “Updates from” (Whombat docs/decisions/whombat-link.md LNK-21): Production or Development, with one line on what
 * Development means, and, after a switch back to Production, that this Whombat keeps its newer version until Production
 * passes it. Only where the box can choose (4.4).
 */
function ChannelRow() {
  const ids = useId();
  const toast = useToast();
  const { session } = useAppServices();
  const [channel, setChannel] = useState<Awaited<ReturnType<typeof readUpdatesChannel>> | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    readUpdatesChannel(session).then(
      (c) => live && setChannel(c),
      () => live && setChannel(null),
    );
    return () => {
      live = false;
    };
  }, [session]);
  if (!channel) return null;
  const v = channelView(channel);
  const save = (next: 'production' | 'development') => {
    if (next === v.channel) return;
    setBusy(true);
    sessionOps
      .updatesChannelSet(session, next)
      .then(
        (c) => {
          setChannel(c);
          toast.show(CHANNEL_TEXT.switched(c.channel));
        },
        (e) => toast.show(channelErrorText(e)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className={styles.row} data-row="channel">
      <span className={styles.rowMain}>
        <span className={styles.rowTitle} id={`${ids}-title`}>
          {CHANNEL_TEXT.title}
        </span>
        <span className={styles.rowMeta} id={`${ids}-hint`}>
          {v.meta}
        </span>
      </span>
      <SegmentedControl
        size="sm"
        label={CHANNEL_TEXT.label}
        describedBy={`${ids}-hint`}
        disabled={busy}
        value={v.channel}
        onChange={save}
        options={[
          { value: 'production', label: CHANNEL_TEXT.production },
          { value: 'development', label: CHANNEL_TEXT.development },
        ]}
      />
    </div>
  );
}

/** This Whombat → About → TURNED OFF HERE (AP-1230): what a managed Whombat turns off, with the reason. */
export function ManagedPolicy({ status }: { status: ApplianceStatus }) {
  const policy = Object.entries(status.policy).filter(([, p]) => !p.available);
  if (policy.length === 0) return null;
  return (
    <Section label={THIS_WHOMBAT_TEXT.turnedOff}>
      {policy.map(([key, p]) => (
        <Row key={key} dot="mut" title={p.reason ?? key} />
      ))}
    </Section>
  );
}

/** This Whombat → Devices (AP-1229): DEVICES (one list, Add a device), PASSKEYS and REMOVED DEVICES. */
export function ManagedDevices({
  status,
  onChanged,
}: {
  status: ApplianceStatus | null;
  /** The box's state changed here (a passkey became the backups' key): read it again. */
  onChanged?: () => void;
}) {
  return (
    <>
      <DevicesTab bringBack={status?.backup.bringBack ?? null} onChanged={onChanged} />
      {status && (status.revocationsPending > 0 || status.revocationsApplied > 0) && (
        <Section label={MANAGED_TEXT.revocations}>
          {status.revocationsPending > 0 && (
            <Row dot="warn" title={MANAGED_TEXT.revocationsPending(status.revocationsPending)} />
          )}
          {status.revocationsApplied > 0 && (
            <Row dot="ok" title={MANAGED_TEXT.revocationsApplied(status.revocationsApplied)} />
          )}
        </Section>
      )}
    </>
  );
}

/** The platforms with a client security floor (CT-53), for This Whombat. */
function floors(status: ApplianceStatus): { platform: string; minBuild: number }[] {
  return Object.entries(status.clientFloor ?? {})
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .map(([platform, minBuild]) => ({ platform, minBuild: minBuild as number }));
}

/* Diagnostic bundles (CT-52) ------------------------------------------------------------------------ */

export function DiagnosticsSection() {
  const { session } = useAppServices();
  const t = COPY.diagnostics;
  const [list, setList] = useState<DiagnosticBundleSummary[] | null>(null);
  const [chosen, setChosen] = useState<Set<DiagnosticScope>>(() => new Set(['versions', 'health']));
  const [open, setOpen] = useState<CheckedPreview | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The “What to include” dialog is open (AP-1232). */
  const [choosing, setChoosing] = useState(false);
  const load = useCallback(() => {
    sessionOps.diagnosticsList(session).then(
      (r) => setList(r.bundles),
      () => setList([]),
    );
  }, [session]);
  useEffect(load, [load]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await work();
    } catch (error) {
      setNote(
        error instanceof DiagnosticsIntegrityError
          ? t.integrity
          : error instanceof OperationError && error.code === 'diagnostics_limit'
            ? t.limit
            : t.failed,
      );
    } finally {
      setBusy(false);
      load();
    }
  };
  const toggle = (scope: DiagnosticScope) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  const make = () =>
    void act(async () => {
      const order = DIAGNOSTIC_SCOPE_LIST.map((sc) => sc.scope).filter((sc) => chosen.has(sc));
      await sessionOps.diagnosticsCreate(session, { scopes: order });
      setChoosing(false);
    });
  const d = THIS_WHOMBAT_TEXT.diagnostics;
  return (
    <section className={styles.section} aria-label={t.label}>
      <SectionLabel as="h2">{t.label}</SectionLabel>
      <div className={styles.card}>
        {/* What to include is a dialog (this-whombat-sections.md AP-1232): the card says what it is and lists the files. */}
        <div className={styles.row}>
          <div className={styles.rowMain}>
            <span className={styles.rowMeta}>{t.intro}</span>
            {note && !choosing && (
              <span className={styles.rowMeta} role="status">
                {note}
              </span>
            )}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setNote(null);
              setChoosing(true);
            }}
          >
            {d.make}
          </Button>
        </div>
        <Modal open={choosing} onOpenChange={setChoosing} width="md">
          <div className={tw.dialog}>
            <div className={tw.dialogHead}>
              <ModalTitle className={tw.dialogTitle}>{d.dialogTitle}</ModalTitle>
              <ModalDescription className={tw.dialogLead}>{t.intro}</ModalDescription>
            </div>
            <fieldset className={tw.checklist}>
              <legend className={tw.checklistLegend}>{t.choose}</legend>
              {DIAGNOSTIC_SCOPE_LIST.map(({ scope, description }) => (
                <label key={scope} className={tw.checkItem}>
                  <input
                    type="checkbox"
                    className={tw.checkbox}
                    checked={chosen.has(scope)}
                    onChange={() => toggle(scope)}
                  />
                  <span className={tw.checkText}>
                    <span className={tw.checkName}>{t.scopeNames[scope] ?? scope}</span>
                    {/* The app's plain words; the contract's developer list only for a scope the app doesn't know. */}
                    <span className={tw.checkMeta}>{d.scopes[scope] ?? description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {note && (
              <span className={tw.dialogNote} role="status">
                {note}
              </span>
            )}
            <div className={tw.dialogActions}>
              <ModalClose asChild>
                <Button variant="secondary" size="lg">
                  {THIS_WHOMBAT_TEXT.cancel}
                </Button>
              </ModalClose>
              <Button variant="primary" size="lg" disabled={busy || chosen.size === 0} onClick={make}>
                {busy ? t.creating : t.create}
              </Button>
            </div>
          </div>
        </Modal>
        {list && list.length === 0 && <Row title={t.none} />}
        {list?.map((d) => (
          <div key={d.bundleId} data-testid="diagnostics-bundle">
            <Row
              dot="mut"
              title={d.scopes.map((sc) => t.scopeNames[sc] ?? sc).join(' · ')}
              meta={[ago(d.createdAt), formatBytes(d.size), t.downloads(d.downloads)].join(' · ')}
              action={
                <span style={{ display: 'flex', gap: 8 }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      open?.summary.bundleId === d.bundleId
                        ? setOpen(null)
                        : void act(async () => setOpen(await previewDiagnostics(session, d.bundleId)))
                    }
                  >
                    {open?.summary.bundleId === d.bundleId ? t.hide : t.show}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const file = await downloadDiagnostics(session, d);
                        // A download, never a navigation: a neutral type, then the file is the person's.
                        saveBlob(
                          new Blob([new Uint8Array(file.bytes)], { type: 'application/octet-stream' }),
                          file.name,
                        );
                      })
                    }
                  >
                    {t.download}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        if (open?.summary.bundleId === d.bundleId) setOpen(null);
                        await sessionOps.diagnosticsDelete(session, d.bundleId);
                      })
                    }
                  >
                    {t.remove}
                  </Button>
                </span>
              }
            />
            {open?.summary.bundleId === d.bundleId && (
              <div className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={styles.rowMeta}>
                    {t.checked} sha256 {open.summary.sha256.slice(0, 16)}…
                  </span>
                  <pre
                    data-testid="diagnostics-preview"
                    style={{
                      margin: 0,
                      maxHeight: 360,
                      overflow: 'auto',
                      font: '12px/1.5 var(--font-mono)',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {open.pretty}
                  </pre>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function DevicesTab({
  bringBack = null,
  onChanged,
}: {
  /** Where bringing this Whombat back stands, for PASSKEYS' “Passkey set”. */
  bringBack?: BackupBringBack | null;
  onChanged?: () => void;
} = {}) {
  const { session, managed } = useAppServices();
  // A community box adds a device with a QR code it makes; there's no hosted app to link to (CT-1305, AP-5424). So does
  // a box with its own address: it may take no code pairing (own-address.md), and its links carry the address.
  const community = useCommunity();
  const [own, setOwn] = useState<OwnAddressSummary | null>(null);
  const hasOwnAddress = own !== null;
  const linkFirst = community || hasOwnAddress;
  const [list, setList] = useState<EndpointSummary[] | null>(null);
  /** Devices a passkey let in during the last day (PK-09): said on their row. */
  const [byPasskey, setByPasskey] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const [code, setCode] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [asking, setAsking] = useState<(PairLookupOutput & { code: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which way to add a device is open under the list (AP-1229): the link, the code, or neither. */
  const [adding, setAdding] = useState<'link' | 'code' | null>(null);
  const codeId = useId();
  useEffect(() => {
    let live = true;
    if (!session) return;
    readOwnAddress(session).then(
      (a) => live && setOwn(a),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [session]);
  const codeInput = useRef<HTMLInputElement>(null);
  // “Have a code already?”: the field takes the typing at once (Add a computer starts with its steps instead).
  useEffect(() => {
    if (adding === 'code') codeInput.current?.focus();
  }, [adding]);
  const load = useCallback(() => {
    setError(null);
    sessionOps.endpointsList(session).then(
      (r) => {
        setList(r.endpoints);
        sessionOps.passkeysList(session).then(
          (p) => setByPasskey(new Set(passkeyEnrolledDevices(r.endpoints, p.passkeys).keys())),
          () => {},
        );
      },
      (e) => setError(e ?? new Error('failed')),
    );
  }, [session]);
  useEffect(load, [load]);

  // Which device shows this code: its name, kind and fingerprint, to compare before letting it in.
  const lookUp = async (e: FormEvent) => {
    e.preventDefault();
    setNote(null);
    setBusy(true);
    try {
      const found = await sessionOps.pairLookup(session, code.trim());
      setAsking({ ...found, code: code.trim() });
    } catch (error) {
      setNote(MANAGED_TEXT[pairingErrorKey(error)]);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (yes: boolean) => {
    if (!asking) return;
    setNote(null);
    setBusy(true);
    try {
      await sessionOps.pairApprove(session, {
        code: asking.code,
        approve: yes,
        fingerprint: asking.fingerprint,
      });
      setNote(yes ? MANAGED_TEXT.approved : MANAGED_TEXT.declined);
      setCode('');
      setAsking(null);
      setAdding(null);
      load();
    } catch (error) {
      const key = pairingErrorKey(error);
      setNote(MANAGED_TEXT[key]);
      // The code now belongs to another device (or is gone): start over with a fresh look-up.
      if (key !== 'failed' && key !== 'rateLimited') setAsking(null);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (d: EndpointSummary) => {
    if (!window.confirm(MANAGED_TEXT.removeConfirm)) return;
    await sessionOps.endpointsRevoke(session, d.endpointId).catch((e) => setError(e ?? new Error('failed')));
    load();
  };

  // Devices are a security view (AP-266): a device this app can't read would vanish from the list, so the list isn't
  // shown at all; the way out is a newer app.
  if (error instanceof NeedsNewerAppError) return <NeedsNewerAppRow />;
  if (error)
    return (
      <Row
        title={MANAGED_TEXT.loadError}
        action={
          <Button variant="secondary" size="sm" onClick={load}>
            {MANAGED_TEXT.retry}
          </Button>
        }
      />
    );
  if (!list) return null;
  const mine = list.find((d) => d.current);
  const others = list.filter((d) => !d.current);
  // “Add a computer” opens the link's steps and the code under them (step 3 types it there); “Have a code already?” only
  // the code. “Add a phone” is the Mobile app page's QR code (AP-523). On a community box its own QR code lets any
  // device in by itself: no code to type under it (AP-5424).
  const codeOpen = adding === 'code' || (adding === 'link' && !linkFirst) || asking !== null;
  const T = THIS_WHOMBAT_TEXT;
  return (
    <>
      {/* One list (this-whombat-sections.md AP-1229): this browser first, then the others, then Add a device. */}
      <Section label={T.devicesLabel}>
        {mine && (
          <Row
            dot="ok"
            title={`${mine.label} · ${MANAGED_TEXT.thisBrowser}`}
            meta={MANAGED_TEXT.seen(ago(mine.lastSeenAt))}
          />
        )}
        {others.map((d) => (
          <Row
            key={d.endpointId}
            dot={d.revocation === 'none' ? 'ok' : d.revocation === 'pending' ? 'warn' : 'mut'}
            title={d.label}
            meta={
              d.revocation === 'pending'
                ? MANAGED_TEXT.removedPending
                : d.revocation === 'applied'
                  ? MANAGED_TEXT.removedApplied
                  : byPasskey.has(d.endpointId)
                    ? `${PASSKEY_COPY.newDeviceMeta} · ${MANAGED_TEXT.seen(ago(d.lastSeenAt))}`
                    : MANAGED_TEXT.seen(ago(d.lastSeenAt))
            }
            action={
              d.revocation === 'none' ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void remove(d)}
                  aria-label={`Remove ${d.label}`}
                >
                  {MANAGED_TEXT.remove}
                </Button>
              ) : undefined
            }
          />
        ))}
        {/* Add a device (AP-66, AP-1229): a phone by the Mobile app page's QR code, a computer by a link and the code it
            shows, or a code a device already shows. */}
        <div className={styles.row} data-testid="add-device">
          <div className={styles.rowMain}>
            <span className={styles.rowTitle}>{linkFirst ? LINK_TEXT.device.section : T.addDevice}</span>
            <span className={styles.rowMeta}>{linkFirst ? LINK_TEXT.device.meta : T.addDeviceMeta}</span>
            <span className={styles.rowMeta}>
              <Button
                variant="link"
                className={dv.codeLink}
                aria-expanded={adding === 'code'}
                onClick={() => {
                  setAdding(adding === 'code' ? null : 'code');
                  setAsking(null);
                  setNote(null);
                }}
              >
                {T.enterCode}
              </Button>
            </span>
          </div>
          {linkFirst ? (
            <Button
              variant="primary"
              size="sm"
              aria-expanded={adding === 'link'}
              onClick={() => setAdding(adding === 'link' ? null : 'link')}
            >
              {LINK_TEXT.device.make}
            </Button>
          ) : (
            <>
              <RouterButtonLink variant="primary" size="sm" to="/settings" search={{ tab: 'phone' } as never}>
                {T.addPhone}
              </RouterButtonLink>
              <Button
                variant="secondary"
                size="sm"
                aria-expanded={adding === 'link'}
                onClick={() => {
                  setAdding(adding === 'link' ? null : 'link');
                  setAsking(null);
                  setNote(null);
                }}
              >
                {T.addComputer}
              </Button>
            </>
          )}
        </div>
        {adding === 'link' &&
          (linkFirst ? <DeviceLinkPanel onDone={() => setAdding(null)} /> : <AddDeviceLink />)}
        {asking ? (
          <FingerprintConfirm
            compact
            device={asking.platform === 'android' || asking.platform === 'ios' ? 'phone' : 'other'}
            label={T.confirmLabel}
            title={T.confirmTitle(asking.label)}
            platform={platformName(asking.platform)}
            meta={T.confirmInto}
            fingerprintLine={T.sameOnDevice}
            fingerprint={asking.fingerprint}
            hint={T.compareDevice}
            note={note}
            busy={busy}
            approveLabel={MANAGED_TEXT.approve}
            declineLabel={T.notMyDevice}
            onApprove={() => void decide(true)}
            onDecline={() => void decide(false)}
            more={
              <Button
                variant="ghost"
                size="lg"
                disabled={busy}
                onClick={() => {
                  setAsking(null);
                  setNote(null);
                }}
              >
                {MANAGED_TEXT.otherCode}
              </Button>
            }
            testId="pairing-device"
            fingerprintTestId="pairing-fingerprint"
            platformTestId="pairing-platform"
          />
        ) : codeOpen ? (
          <form className={cx(styles.row, dv.codeForm)} onSubmit={(e) => void lookUp(e)}>
            <div className={styles.rowMain}>
              <label className={styles.rowMeta} htmlFor={codeId}>
                {adding === 'link' && !linkFirst ? T.codeFromComputer : MANAGED_TEXT.addHelp}
              </label>
              <Input
                ref={codeInput}
                id={codeId}
                aria-label={MANAGED_TEXT.code}
                placeholder="1234-5678"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </div>
            <Button
              variant="primary"
              size="sm"
              type="submit"
              disabled={busy || !PAIRING_CODE.test(code.trim())}
            >
              {MANAGED_TEXT.lookUp}
            </Button>
          </form>
        ) : null}
        {/* What a decision did (“Let in.”, “Declined.”) or why a code didn't work, also once the form has closed. */}
        {note && !asking && (
          <div className={styles.row}>
            <span className={styles.rowMeta} role="status">
              {note}
            </span>
          </div>
        )}
      </Section>
      {/* On the box's own pages, a box with its own address has passkeys of its own (own-address.md). */}
      {own && managed?.page ? (
        <BoxPasskeysSection own={own} {...(onChanged && { onChanged })} />
      ) : (
        <PasskeysSection bringBack={bringBack} onChanged={onChanged} />
      )}
    </>
  );
}

/**
 * Devices → PASSKEYS: one setup status and action for access and backups. Credential records, removal and the
 * device-bound policy stay under details. A security view: unreadable records never disappear silently.
 */
function PasskeysSection({
  bringBack,
  onChanged,
}: {
  bringBack: BackupBringBack | null;
  onChanged?: () => void;
}) {
  const { session, managed } = useAppServices();
  const tap = useBackupPasskeyTap();
  const touching = tap?.busy ?? false;
  const said = tap?.note ?? null;
  const me = useMyAccountId();
  const community = useCommunity();
  const toast = useToast();
  const policyId = useId();
  const [list, setList] = useState<PasskeysList | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [details, setDetails] = useState(false);
  const detailsId = useId();
  const [note, setNote] = useState<string | null>(null);
  const appliance = managed?.appliancePeerId ?? null;
  const footerNote = touching ? said : (note ?? said);
  const signals = managed?.passkeys ?? null;
  const load = useCallback(() => {
    setError(null);
    sessionOps.passkeysList(session).then(
      (l) => {
        setList(l);
        // The browser stops offering passkeys this Whombat no longer takes (removed on another device).
        if (appliance) void keepOnlyLivePasskeys(signals, { appliance, accountId: me, passkeys: l.passkeys });
      },
      (e) => setError(e ?? new Error('failed')),
    );
  }, [session, appliance, signals, me]);
  useEffect(load, [load]);
  const view = tap?.view;
  const refresh = tap?.refresh;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed backup state refreshes the shared setup status
  useEffect(() => {
    void refresh?.();
  }, [refresh, bringBack?.state, bringBack?.setup, bringBack?.passkeys]);
  const t = PASSKEY_COPY;
  const head = <SectionLabel as="h2">{t.section}</SectionLabel>;
  if (!managed) return null;
  if (error instanceof NeedsNewerAppError)
    return (
      <section className={styles.section} aria-label={t.section}>
        {head}
        <div className={styles.card}>
          <NeedsNewerAppRow />
        </div>
      </section>
    );
  const platform = managed.passkeys ?? null;
  const add = async () => {
    if (!tap) return;
    setNote(null);
    try {
      setNote((await tap()).note);
      onChanged?.();
      load();
    } catch (e) {
      setNote(passkeyErrorText(e));
    }
  };
  const remove = async (p: PasskeySummary) => {
    if (!window.confirm(t.removeConfirm(p.name))) return;
    setNote(null);
    try {
      await passkeyRemove({
        session,
        control: managed.control,
        passkey: p,
        me,
        appliance: managed.appliancePeerId,
      });
      toast.show(t.removed);
    } catch (e) {
      setNote(passkeyErrorText(e));
    }
    load();
    await tap?.refresh();
    onChanged?.();
  };
  const setPolicy = async (deviceBoundOnly: boolean) => {
    try {
      await sessionOps.passkeysPolicy(session, deviceBoundOnly);
      toast.show(deviceBoundOnly ? t.policyOn : t.policyOff);
    } catch (e) {
      toast.show(passkeyErrorText(e) ?? t.errors.failed);
    }
    load();
  };
  const rows = list ? orderPasskeys(list.passkeys, me) : [];
  return (
    // Keep setup and credential details together at the Overview's passkey destination.
    <section className={styles.section} aria-label={t.section} id="passkeys">
      {head}
      <div className={styles.card} data-testid="passkeys">
        {error ? (
          <Row
            title={t.loadError}
            action={
              <Button variant="secondary" size="sm" onClick={load}>
                {MANAGED_TEXT.retry}
              </Button>
            }
          />
        ) : null}
        <div className={styles.row} data-passkey-set="">
          <span className={styles.passkeySet} aria-hidden="true">
            {view?.phase === 'ready' ? <Icon icon={CircleCheck} size={18} /> : <Icon name="key" size={18} />}
          </span>
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>
              {tap?.loadError
                ? PASSKEY_SETUP_TEXT.loadError
                : (view?.title ?? (tap ? PASSKEY_SETUP_TEXT.loading : PASSKEY_SETUP_TEXT.empty))}
            </span>
            <span className={styles.rowMeta}>{view?.meta ?? PASSKEY_SETUP_TEXT.intro}</span>
            {!platform ? (
              <span className={styles.rowMeta}>
                {managed.page
                  ? community
                    ? COMMUNITY_TEXT.passkeys
                    : BOX_PAGE_TEXT.passkeys
                  : t.unavailable}
              </span>
            ) : null}
            {footerNote ? (
              <span className={styles.rowMeta} role="status">
                {footerNote}
              </span>
            ) : null}
          </span>
          {view?.phase !== 'ready' || tap?.loadError ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={touching || !tap || !platform || !list || (!view && !tap.loadError)}
              onClick={() => void add()}
            >
              {tap?.label ?? PASSKEY_SETUP_TEXT.setup}
            </Button>
          ) : null}
        </div>
        {/* A row that opens what sits under it, like the Settings home's Theme: its words under the passkey's, its chevron
            down and up while open. */}
        <button
          type="button"
          className={cx(styles.row, dv.detailsRow)}
          aria-expanded={details}
          aria-controls={detailsId}
          // Named by its title alone; its line says what it holds.
          aria-labelledby={`${detailsId}-title`}
          aria-describedby={list ? `${detailsId}-meta` : undefined}
          onClick={() => setDetails(!details)}
        >
          <span className={dv.detailsSpacer} aria-hidden="true" />
          <span className={styles.rowMain}>
            <span className={styles.rowTitle} id={`${detailsId}-title`}>
              {PASSKEY_SETUP_TEXT.details}
            </span>
            {list ? (
              <span className={styles.rowMeta} id={`${detailsId}-meta`}>
                {PASSKEY_SETUP_TEXT.detailsMeta(list.passkeys.length)}
              </span>
            ) : null}
          </span>
          <span className={dv.detailsChevron} aria-hidden="true">
            <Icon icon={ChevronDown} size={16} />
          </span>
        </button>
        {details ? (
          <div id={detailsId} className={dv.details}>
            {rows.map((p) => {
              const title = p.name;
              return (
                <div key={p.id} className={styles.row}>
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>{title}</span>
                    <span className={styles.rowMeta}>{passkeyMeta(p, ago)}</span>
                  </span>
                  <Tag tone={p.synced ? 'brand' : 'mut'} title={p.synced ? t.syncedLabel : t.thisDeviceLabel}>
                    {p.synced ? t.synced : t.thisDevice}
                  </Tag>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void remove(p)}
                    aria-label={`${t.remove} ${title}`}
                  >
                    {t.remove}
                  </Button>
                </div>
              );
            })}
            {view?.phase === 'ready' && tap ? (
              <div className={styles.row}>
                <Button variant="secondary" size="sm" disabled={touching} onClick={() => void add()}>
                  {touching ? tap.label : PASSKEY_SETUP_TEXT.check}
                </Button>
              </div>
            ) : null}
            {list && (
              <div className={styles.row}>
                <span className={styles.rowMain}>
                  <label className={styles.rowTitle} htmlFor={policyId}>
                    {t.policy}
                  </label>
                  <span className={styles.rowMeta}>{t.policyMeta}</span>
                </span>
                <Toggle
                  id={policyId}
                  checked={list.policy.deviceBoundOnly}
                  onCheckedChange={(on) => void setPolicy(on)}
                />
              </div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * “Add a computer” (AP-66): three numbered steps, the first with the link to open on the other computer. The link names
 * this Whombat and the identity this browser pinned, so the new device never takes it from the directory; it lets
 * nothing in by itself (the code typed under the steps and its fingerprint do). Copy the link is the way to move it;
 * the link itself is folded away, for someone who wants to read or select it.
 */
function AddDeviceLink() {
  const { managed } = useAppServices();
  if (!managed) return null;
  const t = COPY.addLink;
  const steps = THIS_WHOMBAT_TEXT.addComputerSteps;
  const link = addDeviceLink(window.location.origin, managed.applianceId, managed.appliancePeerId);
  return (
    <div className={styles.row} data-testid="add-device-link">
      <div className={styles.rowMain}>
        <ol className={dv.steps}>
          {steps.map((step, i) => (
            <li key={step} className={dv.step}>
              <span className={dv.stepDot} aria-hidden="true">
                {i + 1}
              </span>
              <span className={dv.stepText}>
                <span>{step}</span>
                {i === 0 && (
                  <span className={dv.stepLink}>
                    <span>
                      <CopyLinkButton text={link} copied={t.copied}>
                        {t.copy}
                      </CopyLinkButton>
                    </span>
                    <details className={dv.linkFold}>
                      <summary>{THIS_WHOMBAT_TEXT.showLink}</summary>
                      <Input readOnly value={link} aria-label={t.copy} onFocus={(e) => e.target.select()} />
                    </details>
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
        <span className={styles.rowMeta}>{t.note}</span>
      </div>
    </div>
  );
}

/**
 * A device of your own by QR code on a community box (CT-1305; AP-5424): the box makes a link for this account
 * (`enroll.link.create`; a new one replaces the last), shown as a QR code and the link, for five minutes, counted down;
 * then New code. Scanning it on the phone, or opening the link on another computer, lets that device in.
 */
function DeviceLinkPanel({ onDone }: { onDone: () => void }) {
  const { session } = useAppServices();
  const t = LINK_TEXT.device;
  const [made, setMade] = useState<DeviceLinkCreated | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` makes a new code.
  useEffect(() => {
    let live = true;
    setMade(null);
    setNote(null);
    sessionOps.linkCreate(session).then(
      (r) => {
        if (!live) return;
        setNow(Date.now());
        setMade(r);
      },
      (error) => live && setNote(linkErrorText(error)),
    );
    return () => {
      live = false;
    };
  }, [session, round]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = made ? linkTimeLeft(made.expiresAt, now) : null;
  return (
    <div className={styles.row} data-testid="device-link">
      <div className={styles.rowMain}>
        {made && left ? (
          <LinkQr link={made.link} label={t.qrLabel} />
        ) : made ? (
          <span className={styles.rowTitle} role="status">
            {t.over}
          </span>
        ) : (
          <span className={styles.rowMeta} role="status">
            {note ?? t.making}
          </span>
        )}
        {made && left ? (
          <>
            <Input readOnly value={made.link} aria-label={t.copy} onFocus={(e) => e.target.select()} />
            <span className={styles.rowMeta} role="timer">
              {t.left(left)}
            </span>
          </>
        ) : null}
        <span className={tw.linkActions}>
          {made && left ? (
            <CopyLinkButton text={made.link} copied={t.copied}>
              {t.copy}
            </CopyLinkButton>
          ) : (
            <Button variant="secondary" size="sm" onClick={() => setRound((n) => n + 1)}>
              {t.again}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onDone}>
            {t.hide}
          </Button>
        </span>
      </div>
    </div>
  );
}

/** A link the box made as a QR code on its light plate (AP-5422, AP-5424). */
export function LinkQr({ link, label }: { link: string; label: string }) {
  return (
    <span className={tw.qrPlate} data-local-link={link}>
      <QrCode value={link} size={184} label={label} />
    </span>
  );
}

/** “Copy the link” under a one-time or add-a-device link: a secondary button that copies and says so. */
function CopyLinkButton({
  text,
  copied,
  children,
}: {
  text: string;
  copied: string;
  children: React.ReactNode;
}) {
  const toast = useToast();
  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={() =>
        void copyText(text).then((ok) =>
          toast.show(ok ? copied : 'Couldn’t copy. Your browser didn’t allow it.'),
        )
      }
    >
      {children}
    </Button>
  );
}

/** The session's account on a managed Whombat (the person's; one-person.md AP-5671), else null. */
export function useMyAccountId(): string | null {
  const { session, managed } = useAppServices();
  const s = managed ? session.state() : null;
  return s?.status === 'open' ? (s.info.account?.id ?? null) : null;
}
