/**
 * Backup places in Settings → This Whombat → Backups (Whombat backup-places.md BPL-04…BPL-10; app backup-places.md
 * AP-6700…AP-6715; not in the mocks): ON YOUR NETWORK lists the NAS and servers that can keep this Whombat's backups,
 * each with its mark, name, one line and its one action — Back up here (asked first when another place keeps them,
 * then the minute or two it takes said plainly), Connect it first and Turn on Manage first (links to where that is
 * done), Set it up by hand (the app to paste, its steps and Check it). A place with more than one location asks
 * “Where on BlackBox?” first (backup-places.md BPL-13); the place in use names its location and offers Change, which
 * moves the backups there after a confirm in the place's own terms (BPL-14), said plainly while it runs.
 * `CurrentPlaceRow` is BACKUPS' line naming the place in use. A box from before (`unknown_op`) or without places shows
 * nothing new. The rows, words and actions are `@whombat/client`'s, so the phone says the same.
 */
import {
  BACKUP_PLACE_DEADLINE_MS,
  type BackupPlaceAction,
  type BackupPlaceRow,
  backupPlaceRows,
  currentPlaceLine,
  moveFromPlace,
  moveNeeded,
  placeErrorText,
  placeLocationChange,
  placeLocations,
  placeMoveMayRun,
  placeSetNotes,
  waitForPlaceLocation,
} from '@whombat/client/managed';
import { useBackupPlaces, useReloadBackupPlaces } from '@whombat/client/react';
import { type BackupPlaceByHand, sessionOps } from '@whombat/client/session';
import { BACKUP_PLACE_TEXT, type BackupPlace } from '@whombat/core/domain';
import { type MouseEvent, useEffect, useId, useRef, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { useNavigateHref } from '../../app/routing/navigation';
import { Button, ButtonLink } from '../../components/Button';
import { copyText } from '../../components/CopyButton';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { ACCOUNTS_TEXT, BACKUP_PLACES_TEXT } from '../../i18n/clientWords';
import { currentLocale } from '../../i18n/provider';
import { ProviderLogo } from '../connectors/ConnectionsOverview';
import bd from './BackupDestination.module.css';
import bp from './BackupPlaces.module.css';
import styles from './SettingsScreen.module.css';
import tw from './ThisWhombat.module.css';

const W = BACKUP_PLACES_TEXT;

/** Where a place's link goes in the web app. */
export function backupPlaceHref(action: BackupPlaceAction): string | null {
  if (action.kind === 'connect') {
    if (action.asServer) {
      const q = new URLSearchParams({ add: '1', ...(action.address ? { address: action.address } : {}) });
      return `/connections?${q}`;
    }
    const q = new URLSearchParams({
      tab: 'connections',
      connection: action.catalogId,
      ...(action.address ? { url: action.address } : {}),
    });
    return `/settings?${q}`;
  }
  if (action.kind === 'manage') return `/things/${encodeURIComponent(action.thing)}?tab=${action.tab}`;
  return null;
}

/** BACKUPS' line for the place that keeps the backups now (BPL-10); nothing while none does. */
export function CurrentPlaceRow() {
  const { session } = useAppServices();
  const places = useBackupPlaces(session);
  const line = currentPlaceLine(places.data, currentLocale());
  if (!line) return null;
  return (
    <div className={styles.row} data-backup-place="current">
      <ProviderLogo provider={line.mark} size={32} />
      <div className={styles.rowMain}>
        <span className={styles.rowTitle}>{line.title}</span>
        <span className={styles.rowMeta}>{line.meta}</span>
      </div>
    </div>
  );
}

type Asking = { row: BackupPlaceRow; from: string; byHand: boolean; location?: string };
type Choosing = { row: BackupPlaceRow; mode: 'use' | 'change' };
type Changing = {
  row: BackupPlaceRow;
  location: string;
  change: NonNullable<ReturnType<typeof placeLocationChange>>;
};
/** What a row is busy with: setting the place up, or moving its backups to another location on it. */
type Busy = { id: string; moving: string | null };

/**
 * ON YOUR NETWORK. `onChanged` follows a place that was set (BACKUPS reads its state again); `onKit` saves a new
 * recovery kit, which a new destination needs (absent outside a managed Whombat).
 */
export function BackupPlacesSection({ onChanged, onKit }: { onChanged?: () => void; onKit?: () => void }) {
  const { session } = useAppServices();
  const places = useBackupPlaces(session);
  const reload = useReloadBackupPlaces();
  const [working, setWorking] = useState<Busy | null>(null);
  const busy = working?.id ?? null;
  const [notes, setNotes] = useState<Record<string, { text: string; error: boolean }>>({});
  const [asking, setAsking] = useState<Asking | null>(null);
  const [choosing, setChoosing] = useState<Choosing | null>(null);
  const [changing, setChanging] = useState<Changing | null>(null);
  const [byHand, setByHand] = useState<BackupPlaceRow | null>(null);
  const [kitNeeded, setKitNeeded] = useState(false);
  // A move read after its call stops when the page goes.
  const alive = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    return () => controller.abort();
  }, []);
  const rows = backupPlaceRows(places.data, currentLocale());
  if (rows.length === 0) return null;
  const placeOf = (id: string): BackupPlace | null => places.data?.places.find((p) => p.id === id) ?? null;

  const note = (id: string, text: string | null, error = false) =>
    setNotes((n) => {
      const next = { ...n };
      if (text) next[id] = { text, error };
      else delete next[id];
      return next;
    });

  /** Sets the place up (or, made by hand, checks it); a refusal to move without the person's word asks first. */
  const use = async (
    row: BackupPlaceRow,
    move: boolean,
    check = false,
    location?: string,
  ): Promise<boolean> => {
    setWorking({ id: row.id, moving: null });
    note(row.id, null);
    try {
      const input = { placeId: row.id, ...(move ? { move: true } : {}), ...(location ? { location } : {}) };
      const options = { deadlineMs: BACKUP_PLACE_DEADLINE_MS };
      const result = check
        ? await sessionOps.backupPlaceCheck(session, input, options)
        : await sessionOps.backupUsePlace(session, input, options);
      note(row.id, placeSetNotes({ ...result, locale: currentLocale() }));
      setKitNeeded(true);
      await reload();
      onChanged?.();
      return true;
    } catch (error) {
      const needed = move ? null : moveNeeded(error, currentLocale());
      if (needed) setAsking({ row, from: needed.from, byHand: check, ...(location ? { location } : {}) });
      else note(row.id, placeErrorText(error, currentLocale()), true);
      return false;
    } finally {
      setWorking(null);
    }
  };

  /**
   * Where on the place in use, chosen again (BPL-14): on Unraid or Linux the backups move there, up to an hour; the box
   * carries on whatever the page does, so a call that ends without an answer reads the places until they are there. A
   * NAS sets up a new repository there, as setting a place up does.
   */
  const moveTo = async ({ row, location, change }: Changing) => {
    setWorking({ id: row.id, moving: change.move ? null : change.name });
    note(row.id, null);
    try {
      const result = await sessionOps.backupUsePlace(
        session,
        { placeId: row.id, location, ...(change.move ? { move: true } : {}) },
        { deadlineMs: BACKUP_PLACE_DEADLINE_MS },
      );
      note(
        row.id,
        change.move
          ? placeSetNotes({ ...result, locale: currentLocale() })
          : W.moved(result.locationName ?? change.where),
      );
      // A NAS starts a new repository there, which a new recovery kit needs.
      if (change.move) setKitNeeded(true);
    } catch (error) {
      if (change.move || !placeMoveMayRun(error)) note(row.id, placeErrorText(error, currentLocale()), true);
      else {
        const signal = alive.current.signal;
        const there = await waitForPlaceLocation(() => sessionOps.backupPlaces(session), row.id, location, {
          signal,
        });
        if (signal.aborted) return;
        note(row.id, there ? W.moved(change.where) : W.slow);
      }
    } finally {
      setWorking(null);
    }
    await reload();
    onChanged?.();
  };

  /** Asked first when another place keeps the backups (BPL-06). */
  const backUpAt = (row: BackupPlaceRow, location?: string) => {
    const from = moveFromPlace(places.data, row.id, currentLocale());
    if (from) setAsking({ row, from, byHand: false, ...(location ? { location } : {}) });
    else void use(row, false, false, location);
  };

  /** Where on it first, when it has more than one location (BPL-13). */
  const backUpHere = (row: BackupPlaceRow) => {
    if (placeLocations(placeOf(row.id), currentLocale())) setChoosing({ row, mode: 'use' });
    else backUpAt(row);
  };

  const chosen = (location: string) => {
    if (!choosing) return;
    const { row, mode } = choosing;
    setChoosing(null);
    if (mode === 'use') return backUpAt(row, location);
    const place = placeOf(row.id);
    const change = place ? placeLocationChange(place, location, currentLocale()) : null;
    if (change) setChanging({ row, location, change });
  };

  return (
    <section className={styles.section} aria-label={W.heading} data-backup-places>
      <SectionLabel as="h2">{W.heading}</SectionLabel>
      <div className={styles.card}>
        {rows.map((row) => (
          <PlaceRow
            key={row.id}
            row={row}
            busy={busy === row.id}
            moving={busy === row.id ? (working?.moving ?? null) : null}
            disabled={busy !== null}
            note={notes[row.id] ?? null}
            onUse={() => backUpHere(row)}
            onChange={() => setChoosing({ row, mode: 'change' })}
            onByHand={() => setByHand(row)}
          />
        ))}
        {kitNeeded && onKit ? (
          <div className={styles.row}>
            <div className={styles.rowMain}>
              <span className={styles.rowMeta}>{ACCOUNTS_TEXT.newKit}</span>
            </div>
            <Button variant="secondary" size="sm" onClick={onKit}>
              {ACCOUNTS_TEXT.saveKit}
            </Button>
          </div>
        ) : null}
      </div>

      <Modal open={asking !== null} onOpenChange={(open) => !open && setAsking(null)} width="md">
        {asking ? (
          <div className={tw.dialog}>
            <div className={tw.dialogHead}>
              <ModalTitle className={tw.dialogTitle}>
                {BACKUP_PLACE_TEXT.moveTitle(asking.row.name)}
              </ModalTitle>
              <ModalDescription className={tw.dialogLead}>
                {BACKUP_PLACE_TEXT.moveBody(asking.from)}
              </ModalDescription>
            </div>
            <div className={tw.dialogActions}>
              <ModalClose asChild>
                <Button variant="secondary" size="lg">
                  {W.cancel}
                </Button>
              </ModalClose>
              <Button
                variant="primary"
                size="lg"
                onClick={() => {
                  setAsking(null);
                  void use(asking.row, true, asking.byHand, asking.location);
                }}
              >
                {asking.byHand ? BACKUP_PLACE_TEXT.check : BACKUP_PLACE_TEXT.use}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {choosing ? (
        <WhereDialog
          name={choosing.row.name}
          place={placeOf(choosing.row.id)}
          mode={choosing.mode}
          onClose={() => setChoosing(null)}
          onChoose={chosen}
        />
      ) : null}

      <Modal open={changing !== null} onOpenChange={(open) => !open && setChanging(null)} width="md">
        {changing ? (
          <div className={tw.dialog}>
            <div className={tw.dialogHead}>
              <ModalTitle className={tw.dialogTitle}>{changing.change.title}</ModalTitle>
              <ModalDescription className={tw.dialogLead}>{changing.change.body}</ModalDescription>
            </div>
            <div className={tw.dialogActions}>
              <ModalClose asChild>
                <Button variant="secondary" size="lg">
                  {W.cancel}
                </Button>
              </ModalClose>
              <Button
                variant="primary"
                size="lg"
                onClick={() => {
                  setChanging(null);
                  void moveTo(changing);
                }}
              >
                {changing.change.button}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {byHand ? (
        <ByHandSheet
          row={byHand}
          busy={busy === byHand.id}
          error={notes[byHand.id]?.error ? notes[byHand.id]?.text : null}
          onClose={() => setByHand(null)}
          onCheck={async () => {
            const move = moveFromPlace(places.data, byHand.id, currentLocale());
            if (move) {
              setByHand(null);
              setAsking({ row: byHand, from: move, byHand: true });
              return;
            }
            if (await use(byHand, false, true)) setByHand(null);
          }}
        />
      ) : null}
    </section>
  );
}

function PlaceRow({
  row,
  busy,
  moving,
  disabled,
  note,
  onUse,
  onChange,
  onByHand,
}: {
  row: BackupPlaceRow;
  busy: boolean;
  /** The location its backups move to, while they do. */
  moving: string | null;
  disabled: boolean;
  note: { text: string; error: boolean } | null;
  onUse: () => void;
  onChange: () => void;
  onByHand: () => void;
}) {
  const navigate = useNavigateHref();
  const action = row.action;
  const href = action ? backupPlaceHref(action) : null;
  const follow = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!href || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <div className={styles.row} data-backup-place={row.id}>
      <ProviderLogo provider={row.mark} size={32} />
      <div className={styles.rowMain}>
        <span className={styles.rowTitle}>{row.name}</span>
        {busy ? (
          <span className={styles.rowMeta} role="status">
            {moving ? W.moving(moving) : W.settingUp(row.name)}
          </span>
        ) : (
          <span className={styles.rowMeta}>{row.line}</span>
        )}
        {note && !busy ? (
          <span className={note.error ? bp.error : styles.rowMeta} role={note.error ? 'alert' : 'status'}>
            {note.text}
          </span>
        ) : null}
      </div>
      {action?.kind === 'use' ? (
        <Button variant="secondary" size="sm" disabled={disabled} onClick={onUse}>
          {busy ? W.settingUpButton : action.label}
        </Button>
      ) : action?.kind === 'change' ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={onChange}
          aria-label={busy ? undefined : `${action.label}: ${W.whereTitle(row.name)}`}
        >
          {busy ? W.movingButton : action.label}
        </Button>
      ) : action?.kind === 'byHand' ? (
        <Button variant="secondary" size="sm" disabled={disabled} onClick={onByHand}>
          {action.label}
        </Button>
      ) : action && href ? (
        <ButtonLink
          variant="secondary"
          size="sm"
          href={href}
          onClick={follow}
          aria-label={`${action.label}: ${row.name}`}
        >
          {action.label}
        </ButtonLink>
      ) : null}
    </div>
  );
}

/**
 * “Where on BlackBox?” (BPL-13): the place's locations as the backup form's kind cards, the recommended one first and
 * marked, the one in use marked; preselected is the one in use, else the recommended one. Back up here (or, on the
 * place in use, Change: only to another one) sends the choice.
 */
function WhereDialog({
  name,
  place,
  mode,
  onClose,
  onChoose,
}: {
  name: string;
  place: BackupPlace | null;
  mode: 'use' | 'change';
  onClose: () => void;
  onChoose: (location: string) => void;
}) {
  const group = useId();
  const asked = placeLocations(place, currentLocale());
  const [picked, setPicked] = useState(asked?.selected ?? '');
  if (!asked) return null;
  const current = asked.rows.find((r) => r.current)?.id ?? null;
  return (
    <Modal open onOpenChange={(open) => !open && onClose()} width="md">
      <div className={tw.dialog}>
        <div className={tw.dialogHead}>
          <ModalTitle className={tw.dialogTitle}>{W.whereTitle(name)}</ModalTitle>
          <ModalDescription className={tw.dialogLead}>{W.whereLead}</ModalDescription>
        </div>
        <fieldset className={bp.locations} aria-label={W.whereTitle(name)}>
          {asked.rows.map((r) => (
            <label key={r.id} className={bd.kind} data-selected={r.id === picked}>
              <input
                type="radio"
                name={group}
                value={r.id}
                className={bd.kindRadio}
                checked={r.id === picked}
                onChange={() => setPicked(r.id)}
              />
              <span className={bp.locationHead}>
                <span className={bd.kindTitle}>{r.name}</span>
                {r.recommended ? (
                  <span className={bp.tag} data-tone="ok">
                    {W.recommended}
                  </span>
                ) : null}
                {r.current ? <span className={bp.tag}>{W.inUse}</span> : null}
              </span>
              {r.line ? <span className={bd.kindMeta}>{r.line}</span> : null}
            </label>
          ))}
        </fieldset>
        <div className={tw.dialogActions}>
          <ModalClose asChild>
            <Button variant="secondary" size="lg">
              {W.cancel}
            </Button>
          </ModalClose>
          <Button
            variant="primary"
            size="lg"
            disabled={!picked || (mode === 'change' && picked === current)}
            onClick={() => onChoose(picked)}
          >
            {mode === 'change' ? W.change : BACKUP_PLACE_TEXT.use}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Set it up by hand (BPL-09): the steps, the app to paste with Copy, and Check it, which sets the destination once the
 * app answers. The app is asked for when the sheet opens (it holds the user's bcrypt line, never the password).
 */
function ByHandSheet({
  row,
  busy,
  error,
  onClose,
  onCheck,
}: {
  row: BackupPlaceRow;
  busy: boolean;
  error: string | null | undefined;
  onClose: () => void;
  onCheck: () => Promise<void>;
}) {
  const { session } = useAppServices();
  const [sheet, setSheet] = useState<BackupPlaceByHand | 'failed' | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let live = true;
    sessionOps.backupPlaceByHand(session, row.id).then(
      (s) => live && setSheet(s),
      () => live && setSheet('failed'),
    );
    return () => {
      live = false;
    };
  }, [session, row.id]);
  return (
    <Modal open onOpenChange={(open) => !open && onClose()} width="lg">
      <div className={tw.dialog}>
        <div className={tw.dialogHead}>
          <ModalTitle className={tw.dialogTitle}>{W.byHandTitle(row.name)}</ModalTitle>
          <ModalDescription className={tw.dialogLead}>{W.byHandLead}</ModalDescription>
        </div>
        {sheet === null ? (
          <p className={bd.note} role="status">
            {W.byHandLoading}
          </p>
        ) : sheet === 'failed' ? (
          <p className={bp.error} role="alert">
            {W.byHandFailed}
          </p>
        ) : (
          <>
            <ol className={bp.steps}>
              {sheet.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <div className={bd.key}>
              <div className={bd.keyFoot}>
                <span className={bd.label}>{W.compose}</span>
                <span className={bd.copyWrap}>
                  {copied ? (
                    <span className={bd.hint} role="status">
                      {W.copied}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className={bd.copy}
                    onClick={() => void copyText(sheet.compose).then(setCopied)}
                  >
                    {W.copy}
                  </button>
                </span>
              </div>
              <pre className={bp.compose} data-testid="backup-place-compose">
                {sheet.compose}
              </pre>
            </div>
          </>
        )}
        {busy ? (
          <p className={bd.note} role="status">
            {W.settingUp(row.name)}
          </p>
        ) : error ? (
          <p className={bp.error} role="alert">
            {error}
          </p>
        ) : null}
        <div className={tw.dialogActions}>
          <ModalClose asChild>
            <Button variant="secondary" size="lg">
              {W.close}
            </Button>
          </ModalClose>
          <Button
            variant="primary"
            size="lg"
            disabled={busy || sheet === null || sheet === 'failed'}
            onClick={() => void onCheck()}
          >
            {busy ? W.checking : BACKUP_PLACE_TEXT.check}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
