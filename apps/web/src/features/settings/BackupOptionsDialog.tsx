/**
 * Backup options (app backup-options.md AP-6803; mock 2-options-and-detail, left): what each choice costs in plain
 * terms, the recommended answer marked, Save sends them all at once (`backup.setPolicy`) and the list is read again.
 * The summary follows the draft, so “about 20 GB” changes as the choice does.
 */
import { BACKUP_OPTIONS_TEXT, keepTicks, policySummary, relativeDay } from '@whombat/client/managed';
import { useSetBackupPolicy } from '@whombat/client/react';
import { formatBytes } from '@whombat/core/text';
import type {
  BackupCheckpointsOutput,
  BackupFrequency,
  BackupKeep,
  BackupPolicyOutput,
  BackupServiceStatus,
} from '@whombat/protocol/session';
import { BACKUP_KEEP_YEAR } from '@whombat/protocol/session';
import { useEffect, useId, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Input } from '../../components/Input';
import { Modal, ModalClose, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { Tag } from '../../components/Tag';
import { Toggle } from '../../components/Toggle';
import { currentLocale } from '../../i18n/provider';
import { backupErrorText } from './BackupDestination';
import styles from './BackupOverview.module.css';
import { draftInput, draftKeep, draftLimit, draftOf, type PolicyDraft } from './backupOptionsModel';
import tw from './ThisWhombat.module.css';

const D = BACKUP_OPTIONS_TEXT.dialog;
const FREQUENCIES: BackupFrequency[] = ['nightly', '6h', 'hourly'];
const FIELDS: (keyof BackupKeep)[] = ['allDays', 'dailyDays', 'weeklyWeeks', 'monthlyMonths'];

export function BackupOptionsDialog({
  open,
  onOpenChange,
  policy,
  list,
  status,
  placeName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  policy: BackupPolicyOutput;
  list: BackupCheckpointsOutput | null;
  status: BackupServiceStatus | null;
  placeName: string | null;
}) {
  const { session } = useAppServices();
  const save = useSetBackupPolicy(session);
  const [draft, setDraft] = useState<PolicyDraft>(() => draftOf(policy.policy));
  const [error, setError] = useState<string | null>(null);
  const ids = useId();
  // Each opening starts from what is set now.
  useEffect(() => {
    if (open) {
      setDraft(draftOf(policy.policy));
      setError(null);
    }
  }, [open, policy.policy]);
  const set = (patch: Partial<PolicyDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const keep = draftKeep(draft);
  const limit = draftLimit(draft);
  // The limit off says the place's real free space, or nothing more.
  const free = list?.space?.freeBytes ?? null;
  const drill = status?.recoverability.lastDrill ?? null;
  const last = drill ? (drill.ok ? D.lastGood : D.lastBad)(capital(relativeDay(drill.at))) : null;

  const onSave = () => {
    setError(null);
    save.mutate(draftInput(draft), {
      onSuccess: () => onOpenChange(false),
      onError: (e) => setError(backupErrorText(e)),
    });
  };

  const keepOption = (
    value: PolicyDraft['keep'],
    title: string,
    meta: string | null,
    extra?: React.ReactNode,
  ) => (
    <label className={styles.choice} data-keep={value}>
      <input
        type="radio"
        className={styles.radio}
        name={`${ids}-keep`}
        value={value}
        checked={draft.keep === value}
        onChange={() => set({ keep: value })}
      />
      <span className={styles.choiceMain}>
        <span className={styles.choiceTitle}>
          {title}
          {value === 'year' ? (
            <Tag tone="ok" className={styles.recommended}>
              {D.recommended}
            </Tag>
          ) : null}
        </span>
        {meta ? <span className={styles.choiceMeta}>{meta}</span> : null}
        {extra}
      </span>
    </label>
  );

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <div className={tw.dialog} data-backup-options="">
        <ModalTitle className={tw.dialogTitle}>{D.title}</ModalTitle>
        <p className={styles.summary} data-summary="">
          {policySummary(keep, list, placeName)}
        </p>

        <div className={styles.field}>
          <SectionLabel as="h3" id={`${ids}-often`}>
            {D.howOften}
          </SectionLabel>
          <SegmentedControl
            label={D.howOften}
            className={styles.frequency}
            value={draft.frequency}
            onChange={(frequency) => set({ frequency })}
            describedBy={`${ids}-often-hint`}
            options={FREQUENCIES.map((f) => ({ value: f, label: D.frequency[f] }))}
          />
          <p className={styles.hint} id={`${ids}-often-hint`}>
            {D.frequencyHint[draft.frequency]}
          </p>
        </div>

        <fieldset className={styles.field}>
          <SectionLabel as="legend" className={styles.legend}>
            {D.howLong}
          </SectionLabel>
          <div className={styles.choices}>
            {keepOption('year', D.keepYear, D.keepYearMeta, <Timeline keep={BACKUP_KEEP_YEAR} />)}
            {keepOption('days90', D.keep90, D.keep90Meta)}
            {keepOption(
              'custom',
              D.keepChoose,
              null,
              draft.keep === 'custom' ? (
                <span className={styles.keepFields}>
                  {FIELDS.map((f) => (
                    <span key={f} className={styles.keepField}>
                      <label htmlFor={`${ids}-${f}`} className={styles.keepLabel}>
                        {D.keepFields[f]}
                      </label>
                      <Input
                        id={`${ids}-${f}`}
                        type="number"
                        inputMode="numeric"
                        min={f === 'allDays' ? 1 : 0}
                        value={draft.custom[f]}
                        onChange={(e) => set({ custom: { ...draft.custom, [f]: e.target.value } })}
                      />
                    </span>
                  ))}
                </span>
              ) : null,
            )}
          </div>
          {policy.clearedBy === 'none' ? <p className={styles.hint}>{D.clearedByNone}</p> : null}
        </fieldset>

        <div className={styles.field}>
          <SectionLabel as="h3">{D.space}</SectionLabel>
          <div className={styles.switchCard}>
            <div className={styles.switchRow}>
              <span className={styles.choiceMain}>
                <span className={styles.choiceTitle} id={`${ids}-limit`}>
                  {D.limit}
                </span>
                <span className={styles.choiceMeta}>
                  {limit === null
                    ? D.limitOff(placeName, free === null ? null : formatBytes(free, currentLocale()))
                    : D.limitOn(formatBytes(limit, currentLocale()))}
                </span>
              </span>
              <Toggle
                aria-labelledby={`${ids}-limit`}
                checked={draft.limitOn}
                onCheckedChange={(limitOn) => set({ limitOn })}
              />
            </div>
            {draft.limitOn ? (
              <div className={styles.limitField}>
                <Input
                  aria-labelledby={`${ids}-limit`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  value={draft.limitGb}
                  onChange={(e) => set({ limitGb: e.target.value })}
                />
                <span className={styles.unit}>{D.limitGb}</span>
              </div>
            ) : null}
          </div>
        </div>

        <div className={styles.field}>
          <SectionLabel as="h3">{D.checking}</SectionLabel>
          <div className={styles.switchCard}>
            <div className={styles.switchRow}>
              <span className={styles.choiceMain}>
                <span className={styles.choiceTitle} id={`${ids}-check`}>
                  {D.weeklyCheck}
                </span>
                <span className={styles.choiceMeta}>{D.weeklyCheckMeta(last)}</span>
              </span>
              <Toggle
                aria-labelledby={`${ids}-check`}
                checked={draft.weeklyCheck}
                onCheckedChange={(weeklyCheck) => set({ weeklyCheck })}
              />
            </div>
          </div>
        </div>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        <div className={tw.dialogActions}>
          <ModalClose asChild>
            <Button variant="secondary" size="lg">
              {D.cancel}
            </Button>
          </ModalClose>
          <Button variant="primary" size="lg" disabled={save.isPending} onClick={onSave}>
            {save.isPending ? D.saving : D.save}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The picture of thinning: a tick per kept backup, denser towards now, with its four labels. */
function Timeline({ keep }: { keep: BackupKeep }) {
  const ticks = keepTicks(keep);
  const t = D.timeline;
  return (
    <span className={styles.timeline} aria-hidden="true">
      <span className={styles.ticks}>
        {ticks.map((tick) => (
          <span
            key={tick.at}
            className={cx(styles.tick, tick.tall && styles.tickTall)}
            style={{ left: `${tick.at * 100}%` }}
          />
        ))}
      </span>
      <span className={styles.timelineLabels}>
        <span style={{ left: '0%' }}>{t.yearAgo}</span>
        <span style={{ left: '38%' }}>{t.months}</span>
        <span style={{ left: '62%' }}>{t.weeks}</span>
        <span style={{ left: '100%' }}>{t.now}</span>
      </span>
    </span>
  );
}
