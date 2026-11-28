/**
 * Settings → This Whombat → Backups, the part that answers “am I safe?” (Whombat backup-options.md; app
 * backup-options.md AP-6800…, backup-v2.md AP-6880…; mock 1-backups-page): the top card (when, where, how far back,
 * Back up now, Options, the settings as chips) that says plainly when backups fail, are behind or are being made, with
 * *Ask {assistant} to fix it*, what the last backup left out, and whether this Whombat can be brought back — or the
 * passkey's one calm line while no passkey holds the key; NEEDS YOU (the older backups still on this Whombat with Move
 * and Remove), BACKUPS · N grouped by day with Show all, each opening its own page, the line that the assistant can do
 * it too, then Details (where they are kept, who clears old ones, checking the newest, the optional paper copy). The
 * words and views are `@whombat/client`'s (`backupHero`, `backupGroups`, `backupDetailLines`), so the phone says the
 * same. `useBackupOptionsShown` says whether the box answers the new ops at all: a box from before shows what it showed
 * before. While the backup service isn't answering, the same page says so on the top card (the overview's notice, with
 * *Ask {assistant} to fix it*) and keeps what it knows; under the list, one quiet line says where older backups on the
 * places used before are.
 */

import { startedChatPath } from '@whombat/client';
import {
  type BackupHero,
  type BackupPageShown,
  type BackupRow,
  backupDetailLines,
  backupFixText,
  backupGroups,
  backupHero,
  backupPageShown,
  earlierPlacesLine,
} from '@whombat/client/managed';
import {
  useBackupCheckpoints,
  useBackupLocal,
  useBackupPageNotes,
  useBackupPlaces,
  useBackupPolicy,
  useBackupServiceStatus,
  useCheckBackup,
  useReloadBackupOptions,
  useStartChat,
} from '@whombat/client/react';
import { sessionOps } from '@whombat/client/session';
import { formatBytes } from '@whombat/core/text';
import type { BackupCheckpoint } from '@whombat/protocol/session';
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CloudUpload,
  HardDrive,
  KeyRound,
  type LucideIcon,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldEllipsis,
  ShieldQuestionMark,
  ShieldX,
} from 'lucide-react';
import { useId, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { useNavigateHref } from '../../app/routing/navigation';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { BACKUP_OPTIONS_TEXT } from '../../i18n/clientWords';
import { currentLocale, useWebI18n } from '../../i18n/provider';
import { useBackupPasskeyTap } from '../../managed/backupPasskey';
import { backupErrorText } from './BackupDestination';
import { BackupDetail } from './BackupDetail';
import { BackupOptionsDialog } from './BackupOptionsDialog';
import styles from './BackupOverview.module.css';
import { PaperCopyRow } from './BackupPaperCopy';
import { localRange } from './backupOptionsModel';
import tw from './ThisWhombat.module.css';

const T = BACKUP_OPTIONS_TEXT;
/** The list's first rows; Show all lists the rest. */
export const BACKUP_ROWS_SHOWN = 9;
/** How long “Backed up just now” stands after Back up now. */
const JUST_NOW_MS = 90_000;

/** The top card's shield follows where the backups stand. */
const HERO_ICONS: Record<BackupHero['state'], LucideIcon> = {
  ok: ShieldCheck,
  justNow: ShieldCheck,
  running: ShieldEllipsis,
  behind: ShieldAlert,
  failing: ShieldX,
  none: Shield,
  unknown: ShieldQuestionMark,
};

/**
 * Whether Backups shows the new part (`backupPageShown`): `loading` while the box is asked, `down` while it lists its
 * backups but the backup service isn't answering, `no` on a box from before (`unknown_op`), one without backups set up,
 * or someone the box refuses.
 */
export function useBackupOptionsShown(): BackupPageShown {
  const { session } = useAppServices();
  const list = useBackupCheckpoints(session);
  const policy = useBackupPolicy(session);
  const notes = useBackupPageNotes(session);
  return backupPageShown({
    list: { pending: list.isPending, failed: list.isError },
    policy: { pending: policy.isPending, failed: policy.isError },
    notice: notes.isPending ? undefined : (notes.data?.notice ?? null),
  });
}

/** The place's name the words use (“BlackBox”), else the destination as the backup service says it. */
export function useBackupPlaceName(): string | null {
  const { session } = useAppServices();
  const places = useBackupPlaces(session);
  const status = useBackupServiceStatus(session);
  const current = places.data?.places.find((p) => p.id === places.data?.currentPlaceId);
  return current?.name ?? status.data?.status?.destination.display ?? null;
}

export function BackupOverview({
  agentName,
  burrow,
  lastKnownAt = null,
  onChanged,
}: {
  agentName: string;
  /** The burrow *Ask {assistant} to fix it* starts its thread in; absent: no such button. */
  burrow?: string;
  /** When the Whombat last said a backup finished (`appliance.status`), for while the backup service can't say. */
  lastKnownAt?: string | null;
  /** Something changed that `appliance.status` shows (a backup ran, the passkey armed it). */
  onChanged?: () => void;
}) {
  const { session } = useAppServices();
  const status = useBackupServiceStatus(session);
  const list = useBackupCheckpoints(session);
  const policy = useBackupPolicy(session);
  const notes = useBackupPageNotes(session);
  const reload = useReloadBackupOptions();
  const placeName = useBackupPlaceName();
  const [all, setAll] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [open, setOpen] = useState<BackupRow | null>(null);
  const [running, setRunning] = useState(false);
  const [justNowAt, setJustNowAt] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const notice = notes.data?.notice ?? null;
  // While the backup service isn't answering the page shows what it knows; otherwise it waits for the list and options.
  if (!notice && (!list.data || !policy.data)) return null;
  const known = list.data ?? null;
  const hero = backupHero({
    status: status.data?.status ?? null,
    summary: status.data?.summary ?? null,
    policy: policy.data?.policy ?? null,
    list: known,
    placeName,
    running,
    justNow: justNowAt !== null && Date.now() - justNowAt < JUST_NOW_MS,
    notice,
    lastKnownAt,
    locale: currentLocale(),
  });
  const groups = known
    ? backupGroups(
        known,
        policy.data?.policy.keep ?? null,
        all ? { locale: currentLocale() } : { limit: BACKUP_ROWS_SHOWN, locale: currentLocale() },
      )
    : [];
  const total = known?.checkpoints.length ?? 0;
  const earlier = earlierPlacesLine(notes.data?.earlierPlaces, currentLocale());

  // `backup.runNow` answers once the backup is made: the card says so then, not that it started.
  const runNow = async () => {
    setRunning(true);
    setNote(null);
    setJustNowAt(null);
    try {
      await sessionOps.backupRunNow(session);
      setJustNowAt(Date.now());
      await reload();
      onChanged?.();
    } catch (error) {
      setNote(backupErrorText(error));
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <BackupHeroCard
        hero={hero}
        agentName={agentName}
        burrow={burrow ?? null}
        running={running}
        note={note}
        onNote={setNote}
        onBackUpNow={() => void runNow()}
        onOptions={policy.data ? () => setOptionsOpen(true) : null}
        onArmed={() => {
          void reload();
          onChanged?.();
        }}
      />

      <BackupNeedsYou placeName={placeName} />

      {known ? (
        <section className={styles.listSection} aria-labelledby="backups-list-label" data-backup-list="">
          <div className={styles.listHead}>
            <SectionLabel as="h2" id="backups-list-label">
              {T.list.label(total)}
            </SectionLabel>
            {total > 0 ? <SectionLabel>{T.list.newestFirst}</SectionLabel> : null}
          </div>
          <div className={cx(styles.listCard)}>
            {total === 0 ? <p className={styles.empty}>{T.list.empty}</p> : null}
            {groups.map((g) => (
              <div key={g.key} className={styles.group} data-group={g.key}>
                <div className={styles.groupHead}>
                  <span className={styles.groupLabel}>{g.label}</span>
                  {g.note ? <span className={styles.groupNote}>{g.note}</span> : null}
                </div>
                {g.rows.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className={styles.backupRow}
                    data-backup={row.id}
                    onClick={() => setOpen(row)}
                  >
                    <span className={styles.time}>{row.time}</span>
                    <span className={styles.label}>
                      {row.label}
                      {row.check === 'ok' ? (
                        <span className={styles.checked}>✓ {T.list.checkedOk}</span>
                      ) : row.check === 'bad' ? (
                        <span className={styles.checkBad}>{T.list.checkedBad}</span>
                      ) : null}
                      {row.leftOut ? <span className={styles.leftOutTag}>{T.list.leftOut}</span> : null}
                    </span>
                    <span className={styles.size}>{row.size}</span>
                    <span className={tw.chevron} aria-hidden="true">
                      <Icon icon={ChevronRight} size={16} />
                    </span>
                  </button>
                ))}
              </div>
            ))}
            {!all && total > BACKUP_ROWS_SHOWN ? (
              <div className={styles.showAll}>
                <Button variant="link" onClick={() => setAll(true)}>
                  {`${T.list.showAll} ${total}`}
                </Button>
              </div>
            ) : null}
          </div>
          {earlier ? (
            <p className={styles.dusty} data-backup-earlier="">
              {earlier}
            </p>
          ) : null}
          <p className={styles.dusty}>{T.dusty(agentName)}</p>
        </section>
      ) : null}

      <BackupDetails
        clearedBy={policy.data?.clearedBy ?? null}
        placeName={placeName}
        newest={known?.checkpoints[0] ?? null}
        onPaper={() => {
          void reload();
          onChanged?.();
        }}
      />

      {policy.data && known ? (
        <BackupOptionsDialog
          open={optionsOpen}
          onOpenChange={setOptionsOpen}
          policy={policy.data}
          list={known}
          status={status.data?.status ?? null}
          placeName={placeName}
        />
      ) : null}
      <BackupDetail
        row={open}
        onClose={() => setOpen(null)}
        placeName={placeName}
        checkpoint={open ? (known?.checkpoints.find((c) => c.id === open.id) ?? null) : null}
      />
    </>
  );
}

/**
 * The top card: the title, icon and tone follow where the backups stand; failing or behind says why and offers *Ask
 * {assistant} to fix it*; what the last backup left out; then either “Can be brought back …” or the passkey's line.
 */
function BackupHeroCard({
  hero,
  agentName,
  burrow,
  running,
  note,
  onNote,
  onBackUpNow,
  onOptions,
  onArmed,
}: {
  hero: BackupHero;
  agentName: string;
  burrow: string | null;
  running: boolean;
  note: string | null;
  onNote: (note: string | null) => void;
  onBackUpNow: () => void;
  /** Options, once the options were read (null while the backup service isn't answering). */
  onOptions: (() => void) | null;
  onArmed: () => void;
}) {
  return (
    <section className={styles.hero} aria-label={hero.title} data-backup-hero="" data-state={hero.state}>
      <div className={styles.heroHead}>
        <span className={styles.heroIcon} data-tone={hero.tone} aria-hidden="true">
          <Icon icon={HERO_ICONS[hero.state]} size={22} />
        </span>
        <div className={styles.heroMain}>
          <h2 className={styles.heroTitle}>{hero.title}</h2>
          {hero.problem ? (
            <p className={styles.heroProblem} data-tone={hero.tone}>
              {hero.problem}
            </p>
          ) : null}
          {hero.sub ? <p className={styles.heroSub}>{hero.sub}</p> : null}
          {hero.askFix && burrow ? (
            <AskFix hero={hero} agentName={agentName} burrow={burrow} onNote={onNote} />
          ) : null}
        </div>
        <div className={styles.heroActions}>
          <Button variant="secondary" size="md" disabled={running} onClick={onBackUpNow}>
            {running ? T.backingUp : T.backUpNow}
          </Button>
          {onOptions ? (
            <Button variant="secondary" size="md" onClick={onOptions}>
              {T.options}
            </Button>
          ) : null}
        </div>
      </div>
      {note ? (
        <p className={styles.heroNote} role="status">
          {note}
        </p>
      ) : null}
      {hero.leftOut ? (
        <p className={styles.heroLine} data-tone="warn" data-backup-left-out="">
          <Icon icon={CircleAlert} size={16} />
          <span>{`${T.leftOut} ${hero.leftOut}`}</span>
        </p>
      ) : null}
      {hero.wayBack ? (
        <p className={styles.heroLine} data-tone={hero.wayBackReady ? 'ok' : 'mut'} data-backup-way-back="">
          <Icon icon={hero.wayBackReady ? Check : KeyRound} size={16} />
          <span>{hero.wayBack}</span>
        </p>
      ) : null}
      {hero.offsite ? (
        <p className={styles.heroLine} data-tone={hero.offsite.dot} data-backup-offsite-line="">
          <Icon icon={hero.offsite.dot === 'warn' ? CircleAlert : CloudUpload} size={16} />
          <span>{hero.offsite.text}</span>
        </p>
      ) : null}
      {hero.askPasskey ? <PasskeyLine onArmed={onArmed} /> : null}
      {hero.chips.length ? (
        <ul className={styles.chips} aria-label={T.chipsLabel}>
          {hero.chips.map((chip) => (
            <li key={chip.text} className={styles.chip}>
              {chip.dot ? <span className={styles.chipDot} data-tone={chip.dot} aria-hidden="true" /> : null}
              {chip.text}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** *Ask {assistant} to fix it*: what is wrong goes to the assistant in its own thread, as the Inbox's button does. */
function AskFix({
  hero,
  agentName,
  burrow,
  onNote,
}: {
  hero: BackupHero;
  agentName: string;
  burrow: string;
  onNote: (note: string | null) => void;
}) {
  const start = useStartChat(burrow);
  const navigateHref = useNavigateHref();
  const ask = async () => {
    onNote(null);
    const result = await start.mutateAsync({ text: backupFixText(hero, currentLocale()) }).catch(() => null);
    if (result?.status === 'ok') navigateHref(startedChatPath(result.data));
    else onNote(backupErrorText(null));
  };
  return (
    <div className={styles.heroFix}>
      <Button variant="primary" size="sm" disabled={start.isPending} onClick={() => void ask()}>
        {T.askFix(agentName)}
      </Button>
    </div>
  );
}

/**
 * Run the shared setup directly from the backup row. The box's own page explains where passkeys are available.
 */
export function PasskeyLine({ onArmed }: { onArmed: () => void }) {
  const tap = useBackupPasskeyTap();
  const busy = tap?.busy ?? false;
  const said = tap?.note ?? null;
  const W = T.wayBack;
  const use = async () => {
    if (!tap) return;
    await tap();
    onArmed();
  };
  return (
    <div className={styles.passkeyRow} data-backup-passkey="">
      <span className={styles.needsIcon} aria-hidden="true">
        <Icon icon={KeyRound} size={18} />
      </span>
      <div className={styles.needsMain}>
        <span className={styles.needsTitle}>{tap?.view?.title ?? W.ask}</span>
        <span className={styles.needsMeta}>{tap ? (tap.view?.meta ?? W.askMeta) : W.elsewhere}</span>
        {said ? (
          <span className={styles.needsMeta} role="status">
            {said}
          </span>
        ) : null}
      </div>
      {tap ? (
        <Button
          variant="secondary"
          size="md"
          disabled={busy || (!tap.view && !tap.loadError)}
          onClick={() => void use()}
        >
          {tap.label}
        </Button>
      ) : null}
    </div>
  );
}

/** NEEDS YOU: the older backups on the box, when there are any; nothing otherwise. */
function BackupNeedsYou({ placeName }: { placeName: string | null }) {
  const { tag: uiLocale } = useWebI18n();
  const { session } = useAppServices();
  const list = useBackupCheckpoints(session);
  const local = list.data?.local ?? null;
  const { move, remove } = useBackupLocal(session);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const showLocal = local !== null && local.count > 0;
  if (!showLocal && !note) return null;
  const L = T.local;
  const doMove = () => {
    setError(null);
    move.mutate(undefined, {
      onSuccess: (r) => setNote(L.moved(r.copied)),
      onError: (e) => setError(backupErrorText(e)),
    });
  };
  const doRemove = () => {
    setError(null);
    remove.mutate(undefined, {
      onSuccess: () => setConfirming(false),
      onError: (e) => {
        setConfirming(false);
        setError(backupErrorText(e));
      },
    });
  };
  return (
    <section className={styles.needsSection} aria-labelledby="backups-needs-label" data-backup-needs="">
      <SectionLabel as="h2" id="backups-needs-label">
        {T.needsYou}
      </SectionLabel>
      <div className={styles.needsCard}>
        {showLocal && local ? (
          <div className={styles.needsRow} data-needs="local">
            <span className={styles.needsIcon} aria-hidden="true">
              <Icon icon={HardDrive} size={18} />
            </span>
            <div className={styles.needsMain}>
              <span className={styles.needsTitle}>{L.title(local.count)}</span>
              <span className={styles.needsMeta}>
                {L.meta(localRange(local), formatBytes(local.bytes, uiLocale), placeName)}
              </span>
              {error ? (
                <span className={styles.needsError} role="alert">
                  {error}
                </span>
              ) : null}
            </div>
            <div className={styles.needsActions}>
              <Button variant="secondary" size="md" disabled={move.isPending} onClick={doMove}>
                {move.isPending ? L.moving : L.move(placeName)}
              </Button>
              <Button
                variant="link"
                className={styles.quiet}
                disabled={move.isPending}
                onClick={() => setConfirming(true)}
              >
                {L.remove}
              </Button>
            </div>
          </div>
        ) : null}
        {!showLocal && note ? (
          <div className={styles.needsRow}>
            <span className={styles.needsMeta} role="status">
              {note}
            </span>
          </div>
        ) : null}
      </div>
      <Modal open={confirming} onOpenChange={setConfirming}>
        <div className={tw.dialog}>
          <div className={tw.dialogHead}>
            <ModalTitle className={tw.dialogTitle}>{L.removeTitle}</ModalTitle>
            <ModalDescription className={tw.dialogLead}>
              {L.removeLead(formatBytes(local?.bytes ?? 0, uiLocale))}
            </ModalDescription>
          </div>
          <div className={tw.dialogActions}>
            <ModalClose asChild>
              <Button variant="secondary" size="lg">
                {T.dialog.cancel}
              </Button>
            </ModalClose>
            <Button variant="primary" size="lg" disabled={remove.isPending} onClick={doRemove}>
              {L.removeConfirm}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}

/**
 * Details, folded: where the backups are kept, who clears old ones, that they can't be deleted from here, checking the
 * newest backup now, and the optional paper copy.
 */
function BackupDetails({
  clearedBy,
  placeName,
  newest,
  onPaper,
}: {
  clearedBy: 'place' | 'box' | 'none' | null;
  placeName: string | null;
  newest: BackupCheckpoint | null;
  onPaper: () => void;
}) {
  const { session } = useAppServices();
  const status = useBackupServiceStatus(session);
  const check = useCheckBackup(session);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const id = useId();
  const D = T.details;
  const lines = backupDetailLines({
    status: status.data?.status ?? null,
    clearedBy,
    placeName,
    locale: currentLocale(),
  });
  return (
    <section className={styles.detailsSection} data-backup-details="">
      <button
        type="button"
        className={styles.detailsToggle}
        aria-expanded={open}
        aria-controls={`${id}-details`}
        onClick={() => setOpen((was) => !was)}
      >
        <span>{open ? D.hide : D.show}</span>
        <Icon
          icon={ChevronDown}
          size={16}
          className={cx(styles.detailsChevron, open && styles.detailsOpen)}
        />
      </button>
      {open ? (
        <div id={`${id}-details`} className={styles.detailsCard}>
          {lines.length ? (
            <ul className={styles.detailsLines}>
              {lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {newest ? (
            <div className={styles.detailsRow}>
              <Button
                variant="secondary"
                size="sm"
                disabled={check.isPending}
                onClick={() =>
                  check.mutate(newest.id, {
                    onSuccess: () => setNote(T.detail.checkQueued),
                    onError: (e) => setNote(backupErrorText(e)),
                  })
                }
              >
                {check.isPending ? T.detail.checking : D.checkNewest}
              </Button>
              {note ? (
                <span className={styles.hint} role="status">
                  {note}
                </span>
              ) : null}
            </div>
          ) : null}
          <PaperCopyRow paperAt={status.data?.summary.bringBack?.paperAt ?? null} onSaved={onPaper} />
        </div>
      ) : null}
    </section>
  );
}
