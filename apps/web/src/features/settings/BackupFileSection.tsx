/**
 * Settings → This Whombat → Backups → BACKUP FILE (contracts 0.79.0, CT-335; Whombat backup-file.md BF-01…; app
 * docs/decisions/backup-file.md AP-1181…, this-whombat-sections.md AP-1228): the person's, on a Whombat with
 * `backup.file`, after the automatic Backups on a managed Whombat and alone in Backups on a hosted or self-hosted one.
 * One card with two rows, each opening its dialog: “Download a backup” — the categories with their lines and sizes, the
 * password, Download, “Make these the default”; then the file being made and the file that is ready — and “Restore from
 * a file” — choose a `.wbk`, its upload, its password, the preview, Restore, then what came back and what needs you.
 * The state and every word come from `@whombat/client` (`useBackupMaker`, `useBackupRestorer`) and the contracts;
 * saving the file is `backupSave.ts`.
 */
import { createLink } from '@tanstack/react-router';
import { ApiError, BACKUP_FILE_TEXT, backupRestoreFileLine, blobChunkSource } from '@whombat/client';
import { addServerHref } from '@whombat/client/hosts';
import { THIS_WHOMBAT_TEXT } from '@whombat/client/managed';
import {
  type BackupMaker,
  type BackupRestorer,
  type DismissedRestores,
  useBackupDefaults,
  useBackupMaker,
  useBackupRestorer,
} from '@whombat/client/react';
import { expiringRecord } from '@whombat/client/storage';
import {
  BACKUP_COPY,
  BACKUP_FILE_EXTENSION,
  BACKUP_ON_DIFFERENT_LABELS,
  type BackupOnDifferent,
  type BackupServerToPoint,
  backupDownloadLabel,
} from '@whombat/core/backup';
import { hostRepointWords } from '@whombat/core/domain';
import { type DragEvent, type MouseEvent, type ReactNode, useId, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { useNavigateHref } from '../../app/routing/navigation';
import { Button, ButtonLink } from '../../components/Button';
import { cx } from '../../components/cx';
import { Input } from '../../components/Input';
import { Modal, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useWebI18n } from '../../i18n/provider';
import { useLocaleWords } from '../../i18n/words';
import styles from './BackupFile.module.css';
import { backupSaveMethod, openBackupSink } from './backupSave';
import settings from './SettingsScreen.module.css';
import tw from './ThisWhombat.module.css';

const RouterButtonLink = createLink(ButtonLink);

/** The viewer's time zone (a restore's “Made 11 Oct 2026 on …”). */
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const D = BACKUP_COPY.download;
const R = BACKUP_COPY.restore;

export function BackupFileSection({ burrow }: { burrow: string }) {
  const defaults = useBackupDefaults({ params: { burrow } });
  if (defaults.error instanceof ApiError && defaults.error.status === 404) return null;
  return <BackupFileCard burrow={burrow} />;
}

/**
 * The card (this-whombat-sections.md AP-1228): “Download a backup” and “Restore from a file”, each a row whose button
 * opens its dialog. The maker and the restorer live here, not in the dialogs: closing one mid-way keeps the work, and
 * the row says where it is.
 */
function BackupFileCard({ burrow }: { burrow: string }) {
  const maker = useBackupMaker(burrow);
  const dismissed = useDismissedRestores();
  const restorer = useBackupRestorer(burrow, { dismissed });
  const [open, setOpen] = useState<'download' | 'restore' | null>(null);
  const T = THIS_WHOMBAT_TEXT.backupFile;
  const s = restorer.step;
  const makeLine =
    maker.step === 'making'
      ? (maker.progress?.text ?? T.making(null))
      : maker.step === 'ready' && maker.readyLine
        ? T.ready(maker.readyLine)
        : null;
  const restoreLine =
    s === 'uploading'
      ? T.uploading(restorer.uploading?.pct ?? null)
      : s === 'password'
        ? T.opening
        : s === 'preview'
          ? T.preview
          : s === 'restoring'
            ? (restorer.progress?.text ?? T.restoring)
            : s === 'done'
              ? T.restored
              : s === 'failed'
                ? T.failed
                : null;
  return (
    <section className={settings.section} aria-labelledby="this-whombat-backup-file" data-backup-file="">
      <SectionLabel as="h2" id="this-whombat-backup-file">
        {BACKUP_FILE_TEXT.section}
      </SectionLabel>
      <p className={settings.sectionHint}>{BACKUP_FILE_TEXT.when}</p>
      <div className={settings.card}>
        <div className={settings.row}>
          <span className={settings.rowMain}>
            <span className={settings.rowTitle}>{D.title}</span>
            <span className={settings.rowMeta}>{makeLine ?? D.intro}</span>
          </span>
          <Button variant="secondary" size="sm" onClick={() => setOpen('download')}>
            {maker.step === 'choose' ? T.download : T.show}
          </Button>
        </div>
        <div className={cx(settings.row, settings.lastRow)}>
          <span className={settings.rowMain}>
            <span className={settings.rowTitle}>{R.title}</span>
            <span className={settings.rowMeta}>{restoreLine ?? R.intro}</span>
          </span>
          <Button variant="secondary" size="sm" onClick={() => setOpen('restore')}>
            {s === 'choose' ? T.restore : T.show}
          </Button>
        </div>
      </div>
      <Modal open={open === 'download'} onOpenChange={(o) => setOpen(o ? 'download' : null)} width="md">
        <Dialog title={D.title} intro={D.intro}>
          {maker.step === 'making' ? (
            <Making maker={maker} />
          ) : maker.step === 'ready' ? (
            <Ready maker={maker} />
          ) : (
            <Choose maker={maker} />
          )}
        </Dialog>
      </Modal>
      <Modal open={open === 'restore'} onOpenChange={(o) => setOpen(o ? 'restore' : null)} width="md">
        <Dialog title={R.title} intro={R.intro}>
          {s === 'choose' ? <ChooseFile restorer={restorer} /> : null}
          {s === 'uploading' ? <Uploading restorer={restorer} /> : null}
          {s === 'password' ? <OpenFile restorer={restorer} /> : null}
          {s === 'preview' ? <Preview restorer={restorer} /> : null}
          {s === 'restoring' ? <Restoring restorer={restorer} /> : null}
          {s === 'done' || s === 'failed' ? <Outcome restorer={restorer} /> : null}
        </Dialog>
      </Modal>
    </section>
  );
}

/** A dialog's heading and lead over its flow (was the panel's, AP-1228). */
function Dialog({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <div className={tw.dialog}>
      <div className={tw.dialogHead}>
        <ModalTitle className={tw.dialogTitle}>{title}</ModalTitle>
        <ModalDescription className={tw.dialogLead}>{intro}</ModalDescription>
      </div>
      <div>{children}</div>
    </div>
  );
}

function Progress({ pct, text, label }: { pct: number | null; text?: string; label: string }) {
  return (
    <div className={styles.progressBlock}>
      <div
        className={styles.progress}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(pct !== null && { 'aria-valuenow': pct })}
      >
        <span
          className={styles.progressFill}
          style={pct !== null ? { width: `${pct}%` } : undefined}
          data-indeterminate={pct === null || undefined}
        />
      </div>
      {text ? (
        <span className={styles.progressText} aria-live="polite">
          {text}
        </span>
      ) : null}
    </div>
  );
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <p className={styles.problem} role="alert">
      {children}
    </p>
  );
}

/** A `.wbk` file: its tile, name and one line about it. */
function FileCard({ name, line, live = false }: { name: string; line: string; live?: boolean }) {
  return (
    <div className={styles.fileCard}>
      <span className={styles.fileTile} aria-hidden="true">
        {BACKUP_FILE_EXTENSION}
      </span>
      <span className={styles.fileText}>
        <span className={styles.fileName}>{name}</span>
        <span className={styles.fileLine} {...(live && { 'aria-live': 'polite' as const })}>
          {line}
        </span>
      </span>
    </div>
  );
}

function PasswordField({
  value,
  onChange,
  invalid,
  autoComplete,
  onEnter,
}: {
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  autoComplete: 'new-password' | 'current-password';
  onEnter?: () => void;
}) {
  const id = useId();
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.fieldLabel}>
        {D.passwordLabel}
      </label>
      <Input
        id={id}
        type="password"
        value={value}
        invalid={invalid}
        autoComplete={autoComplete}
        aria-describedby={`${id}-hint`}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
      {autoComplete === 'new-password' ? (
        <span id={`${id}-hint`} className={styles.hint}>
          {D.passwordHint}
        </span>
      ) : (
        <span id={`${id}-hint`} hidden />
      )}
    </div>
  );
}

/* Download a backup ------------------------------------------------------------------------------------------------ */

function Choose({ maker }: { maker: BackupMaker }) {
  const [tried, setTried] = useState(false);
  const make = () => {
    setTried(true);
    void maker.make();
  };
  const problem = maker.error ?? (tried ? maker.problem : null);
  return (
    <>
      {maker.failure ? <Problem>{maker.failure}</Problem> : null}
      <fieldset className={styles.list}>
        <legend className={styles.srOnly}>{D.title}</legend>
        {maker.rows.map((row) => (
          <label key={row.id} className={styles.item}>
            <input
              type="checkbox"
              className={styles.checkbox}
              checked={row.ticked}
              onChange={(e) => maker.toggle(row.id, e.target.checked)}
            />
            <span className={styles.itemText}>
              <span className={styles.itemLabel}>{row.label}</span>
              {row.meta ? <span className={styles.itemMeta}>{row.meta}</span> : null}
            </span>
            {row.size ? <span className={styles.itemSize}>{row.size}</span> : null}
          </label>
        ))}
      </fieldset>
      <PasswordField
        value={maker.password}
        onChange={maker.setPassword}
        invalid={tried && maker.problem === D.passwordShort}
        autoComplete="new-password"
        onEnter={make}
      />
      {problem ? <Problem>{problem}</Problem> : null}
      <div className={styles.actions}>
        <Button variant="primary" size="lg" disabled={maker.starting} onClick={make}>
          {maker.starting ? D.making : maker.label}
        </Button>
        {maker.defaults.saved ? (
          <span className={styles.saved} role="status">
            {D.defaultSaved}
          </span>
        ) : (
          <Button variant="link" disabled={maker.defaults.saving} onClick={() => void maker.defaults.save()}>
            {D.makeDefault}
          </Button>
        )}
      </div>
    </>
  );
}

function Making({ maker }: { maker: BackupMaker }) {
  const file = maker.file;
  if (!file || !maker.progress) return null;
  return (
    <div className={styles.state}>
      <FileCard name={file.name} line={maker.progress.text} live />
      <Progress pct={maker.progress.pct} label={D.making} />
      {maker.error ? <Problem>{maker.error}</Problem> : null}
      <div className={styles.actions}>
        <Button variant="secondary" size="lg" disabled={maker.removing} onClick={() => void maker.remove()}>
          {R.cancel}
        </Button>
      </div>
    </div>
  );
}

function Ready({ maker }: { maker: BackupMaker }) {
  const { tag: uiLocale } = useWebI18n();
  const file = maker.file;
  const [note, setNote] = useState<string | null>(null);
  if (file?.status !== 'ready') return null;
  const method = backupSaveMethod();
  const label = maker.downloaded ? D.downloadAgain : backupDownloadLabel(file.size ?? 0, uiLocale);
  const variant = maker.downloaded ? 'secondary' : 'primary';
  const d = maker.download;
  const save = async () => {
    setNote(null);
    try {
      const sink = await openBackupSink(method, file.name);
      await maker.startDownload(sink);
    } catch (error) {
      // The person closed the save picker: nothing to say.
      if (!(error instanceof DOMException && error.name === 'AbortError')) setNote(BACKUP_FILE_TEXT.failed);
    }
  };
  return (
    <div className={styles.state}>
      <p className={styles.readyTitle}>{D.ready}</p>
      <FileCard name={file.name} line={maker.readyLine ?? ''} />
      {d.status === 'downloading' ? (
        <Progress pct={d.pct} text={BACKUP_FILE_TEXT.downloading(d.pct)} label={label} />
      ) : null}
      {d.status === 'saved' ? (
        <p className={styles.saved} role="status">
          {BACKUP_FILE_TEXT.saved}
        </p>
      ) : null}
      {d.error || note || maker.error ? <Problem>{d.error ?? note ?? maker.error}</Problem> : null}
      <div className={styles.actions}>
        {d.status === 'downloading' ? (
          <Button variant="secondary" size="lg" onClick={maker.cancelDownload}>
            {R.cancel}
          </Button>
        ) : (
          <Button variant={variant} size="lg" onClick={() => void save()}>
            {label}
          </Button>
        )}
        <Button
          variant="secondary"
          size="lg"
          disabled={maker.removing || d.status === 'downloading'}
          onClick={() => void maker.remove()}
        >
          {D.remove}
        </Button>
      </div>
    </div>
  );
}

/* Restore from a file ---------------------------------------------------------------------------------------------- */

/** Restores put away on this browser (their summary isn't shown again), for a day (`backups.list` keeps them a day). */
function useDismissedRestores(): DismissedRestores {
  return useMemo(() => {
    const record = expiringRecord({
      storage: () => window.localStorage,
      key: 'whombat.backupFile.dismissedRestores',
      schema: z.array(z.string().max(80)).max(50),
      ttlMs: 24 * 3_600_000,
    });
    return {
      read: () => new Set(record.read() ?? []),
      add: (id) => {
        record.hold([...(record.read() ?? []), id].slice(-50));
      },
    };
  }, []);
}

function ChooseFile({ restorer }: { restorer: BackupRestorer }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const take = (file: File | undefined) => {
    if (file) void restorer.choose(blobChunkSource(file));
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    take(e.dataTransfer.files[0]);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dropping a file is a shortcut; “Choose a file” is the way in
    <div
      className={cx(styles.drop, over && styles.dropOver)}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {restorer.stopped ? (
        <FileCard
          name={restorer.stopped.fileName}
          line={BACKUP_FILE_TEXT.stopped(
            Math.floor((restorer.stopped.received / Math.max(1, restorer.stopped.size)) * 100),
          )}
        />
      ) : null}
      {restorer.error ? <Problem>{restorer.error}</Problem> : null}
      <input
        ref={input}
        type="file"
        className={styles.srOnly}
        tabIndex={-1}
        aria-hidden="true"
        accept={`${BACKUP_FILE_EXTENSION},application/vnd.whombat.backup`}
        onChange={(e) => {
          take(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <div className={styles.actions}>
        <Button variant="primary" size="lg" onClick={() => input.current?.click()}>
          {R.choose}
        </Button>
      </div>
    </div>
  );
}

function Uploading({ restorer }: { restorer: BackupRestorer }) {
  const u = restorer.uploading;
  if (!u) return null;
  // Before the first byte is sent (the managed session hashes the file first) the bar sweeps.
  const started = u.done > 0;
  return (
    <div className={styles.state}>
      <FileCard name={u.fileName} line={started ? BACKUP_FILE_TEXT.uploading(u.pct) : R.uploading} live />
      <Progress pct={started ? u.pct : null} label={R.uploading} />
      <div className={styles.actions}>
        <Button
          variant="secondary"
          size="lg"
          disabled={restorer.cancelling}
          onClick={() => void restorer.cancel()}
        >
          {R.cancel}
        </Button>
      </div>
    </div>
  );
}

function OpenFile({ restorer }: { restorer: BackupRestorer }) {
  const upload = restorer.upload;
  if (!upload) return null;
  const open = () => void restorer.open();
  return (
    <div className={styles.state}>
      <FileCard name={upload.fileName} line={BACKUP_FILE_TEXT.uploaded(upload.size)} />
      <PasswordField
        value={restorer.password}
        onChange={restorer.setPassword}
        invalid={restorer.errorCode === 'wrong_password'}
        autoComplete="current-password"
        onEnter={open}
      />
      {restorer.error ? <Problem>{restorer.error}</Problem> : null}
      <div className={styles.actions}>
        <Button
          variant="primary"
          size="lg"
          disabled={restorer.opening || restorer.password.length === 0}
          onClick={open}
        >
          {restorer.opening ? R.opening : R.open}
        </Button>
        <Button
          variant="secondary"
          size="lg"
          disabled={restorer.cancelling}
          onClick={() => void restorer.cancel()}
        >
          {R.cancel}
        </Button>
      </div>
    </div>
  );
}

function Preview({ restorer }: { restorer: BackupRestorer }) {
  const HOST_REPOINT_WORDS = useLocaleWords(hostRepointWords);
  const preview = restorer.preview;
  const differentId = useId();
  const addressId = useId();
  if (!preview) return null;
  return (
    <div className={styles.state}>
      <FileCard name={preview.fileName} line={restorer.madeLine ?? ''} />
      <fieldset className={styles.list}>
        <legend className={styles.srOnly}>{R.title}</legend>
        {restorer.rows.map((row) => (
          <div key={row.id} className={styles.restoreItem} data-category={row.id}>
            <label className={cx(styles.restoreLabel, row.disabled && styles.restoreLabelOff)}>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={row.ticked}
                disabled={row.disabled}
                onChange={(e) => restorer.toggle(row.id, e.target.checked)}
              />
              <span className={styles.itemLabel}>{row.label}</span>
            </label>
            <span className={styles.chips}>
              {row.chips.map((chip) => (
                <span key={chip.label} className={cx(styles.chip, chip.tone === 'warn' && styles.chipWarn)}>
                  {chip.label}
                </span>
              ))}
            </span>
            {row.hint ? <span className={styles.itemMeta}>{row.hint}</span> : null}
            {row.notes.map((note) => (
              <span key={note} className={styles.itemMeta}>
                {note}
              </span>
            ))}
          </div>
        ))}
      </fieldset>
      {restorer.fileNotes.map((note) => (
        <p key={note} className={styles.note}>
          {note}
        </p>
      ))}
      {restorer.serversQuestion ? (
        <div className={styles.different} data-servers-address="">
          <span id={addressId} className={styles.question}>
            {restorer.serversQuestion}
          </span>
          <SegmentedControl<'here' | 'leave'>
            label={restorer.serversQuestion}
            variant="soft"
            role="radiogroup"
            value={restorer.pointHere ? 'here' : 'leave'}
            onChange={(v) => restorer.setPointHere(v === 'here')}
            options={[
              { value: 'here', label: HOST_REPOINT_WORDS.pointThemHere },
              { value: 'leave', label: HOST_REPOINT_WORDS.leaveThem },
            ]}
          />
        </div>
      ) : null}
      {restorer.hasDifferent ? (
        <div className={styles.different}>
          <span id={differentId} className={styles.fieldLabel}>
            {R.whenDifferent}
          </span>
          <SegmentedControl<BackupOnDifferent>
            label={R.whenDifferent}
            describedBy={differentId}
            variant="soft"
            role="radiogroup"
            value={restorer.onDifferent}
            onChange={restorer.setOnDifferent}
            options={[
              { value: 'keep', label: BACKUP_ON_DIFFERENT_LABELS.keep },
              { value: 'replace', label: BACKUP_ON_DIFFERENT_LABELS.replace },
            ]}
          />
        </div>
      ) : null}
      {restorer.error ? <Problem>{restorer.error}</Problem> : null}
      <div className={styles.actions}>
        <Button
          variant="primary"
          size="lg"
          disabled={restorer.starting || restorer.ticked.length === 0}
          onClick={() => void restorer.restore()}
        >
          {restorer.starting ? R.restoring : R.restore}
        </Button>
        <Button
          variant="secondary"
          size="lg"
          disabled={restorer.cancelling}
          onClick={() => void restorer.cancel()}
        >
          {R.cancel}
        </Button>
      </div>
    </div>
  );
}

function Restoring({ restorer }: { restorer: BackupRestorer }) {
  const r = restorer.restoreView;
  if (!r || !restorer.progress) return null;
  return (
    <div className={styles.state}>
      <FileCard name={r.fileName} line={restorer.progress.text} live />
      <Progress pct={restorer.progress.pct} label={R.restoring} />
    </div>
  );
}

function Outcome({ restorer }: { restorer: BackupRestorer }) {
  const r = restorer.restoreView;
  const outcome = restorer.outcome;
  if (!r || !outcome) return null;
  return (
    <div className={styles.state}>
      <FileCard name={r.fileName} line={backupRestoreFileLine(r, timeZone())} />
      {outcome.failed ? (
        <Problem>{outcome.title}</Problem>
      ) : (
        <p className={styles.readyTitle}>{outcome.title}</p>
      )}
      {outcome.lines.length > 0 ? (
        <ul className={styles.summary}>
          {outcome.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {outcome.toPoint.length > 0 ? <ServersToPoint servers={outcome.toPoint} /> : null}
      <div className={styles.actions}>
        {outcome.links.includes('connections') ? (
          <RouterButtonLink
            variant="secondary"
            size="lg"
            to="/settings"
            search={{ tab: 'connections' }}
            hash="connections-needs"
          >
            {BACKUP_FILE_TEXT.openConnections}
          </RouterButtonLink>
        ) : null}
        {outcome.links.includes('automations') ? (
          <RouterButtonLink variant="secondary" size="lg" to="/automations">
            {BACKUP_FILE_TEXT.openAutomations}
          </RouterButtonLink>
        ) : null}
        <Button variant="secondary" size="lg" onClick={restorer.dismiss}>
          {outcome.failed ? BACKUP_FILE_TEXT.tryAgain : BACKUP_FILE_TEXT.done}
        </Button>
      </div>
    </div>
  );
}

/**
 * The servers still looking for the old address (BF-15; AP-4416), each with “Point it here”: Add a server on
 * Connections, filled in with its address (a password once).
 */
function ServersToPoint({ servers }: { servers: readonly BackupServerToPoint[] }) {
  const HOST_REPOINT_WORDS = useLocaleWords(hostRepointWords);
  const navigate = useNavigateHref();
  return (
    <ul className={styles.toPoint} aria-label={HOST_REPOINT_WORDS.pointThemHere}>
      {servers.map((server) => {
        const href = addServerHref(server.address ? { address: server.address } : {});
        return (
          <li key={server.id} className={styles.toPointItem}>
            <span className={styles.itemText}>
              <span className={styles.itemLabel}>{server.name}</span>
              {server.address ? <span className={styles.itemMeta}>{server.address}</span> : null}
            </span>
            <ButtonLink
              variant="secondary"
              size="sm"
              href={href}
              aria-label={`${HOST_REPOINT_WORDS.pointItHere}: ${server.name}`}
              onClick={(e: MouseEvent<HTMLAnchorElement>) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                navigate(href);
              }}
            >
              {HOST_REPOINT_WORDS.pointItHere}
            </ButtonLink>
          </li>
        );
      })}
    </ul>
  );
}
