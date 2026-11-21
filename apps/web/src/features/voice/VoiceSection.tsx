/**
 * Settings → This Whombat → Overview → VOICE TYPING (docs/decisions/dictation.md DT-03…DT-06; not in the mocks), right
 * after SCREEN and in its rows: the *Voice typing* switch, *Speech model* (Automatic · Fast · Most accurate, with what
 * Automatic uses now and the slow warning for Most accurate without a graphics chip) and *Language* (Automatic ·
 * English · Nederlands) as SCREEN's segmented rows, then the two models — a dot, the name, what it is for and its size,
 * its state with the download's bar, and Download, Remove or Try again — and the graphics chip line. Hidden where the box
 * has no speech service. A choice is shown at once and put back with a toast when refused; every word is `VOICE_TEXT`'s.
 */
import {
  VOICE_TEXT,
  type VoiceApi,
  type VoiceDutchRow,
  type VoiceModelRow,
  type VoiceSectionView,
  voiceSectionShown,
  voiceSectionView,
  voiceSettingErrorText,
} from '@whombat/client/voice';
import { useVoice, useVoiceActions } from '@whombat/client/voice/react';
import type { VoiceTypingPatch } from '@whombat/core/domain';
import { useEffect, useId, useState } from 'react';
import { useOptionalAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StatusDot } from '../../components/StatusDot';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import d from '../desk/Desk.module.css';
import styles from '../settings/SettingsScreen.module.css';
import tw from '../settings/ThisWhombat.module.css';
import v from './VoiceSection.module.css';

/** VOICE TYPING, where the box can turn speech into text. */
export function VoiceSection() {
  const api = useOptionalAppServices()?.voice ?? null;
  const voice = useVoice(api);
  if (!api || !voiceSectionShown(voice.data)) return null;
  return <VoiceCard api={api} view={voiceSectionView(voice.data)} />;
}

function VoiceCard({ api, view }: { api: VoiceApi; view: VoiceSectionView }) {
  const ids = useId();
  const actions = useVoiceActions(api);
  const toast = useToast();
  const save = (patch: VoiceTypingPatch) =>
    void actions.update(patch).catch((error) => toast.show(voiceSettingErrorText(error)));
  const modelMeta = [view.model.uses, view.model.warning].filter(Boolean);
  return (
    <section className={styles.section} aria-labelledby={`${ids}-label`} data-voice="">
      <SectionLabel as="h2" id={`${ids}-label`}>
        {VOICE_TEXT.sectionLabel}
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row} data-row="voice-on">
          <span className={styles.rowMain}>
            <label className={styles.rowTitle} htmlFor={`${ids}-on`}>
              {view.on.title}
            </label>
            <span className={styles.rowMeta} id={`${ids}-on-meta`}>
              {view.on.meta}
            </span>
          </span>
          <Toggle
            id={`${ids}-on`}
            checked={view.on.on}
            aria-describedby={`${ids}-on-meta`}
            onCheckedChange={(on) => save({ on })}
          />
        </div>
        <div className={cx(styles.row, d.wrapRow)} data-row="voice-model">
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{view.model.title}</span>
            {modelMeta.length ? (
              <span className={styles.rowMeta} id={`${ids}-model-meta`} data-voice-uses="">
                {modelMeta.join(' ')}
              </span>
            ) : null}
          </span>
          <SegmentedControl
            label={view.model.title}
            describedBy={modelMeta.length ? `${ids}-model-meta` : undefined}
            options={view.model.options}
            value={view.model.value}
            onChange={(model) => save({ model })}
          />
        </div>
        <div className={cx(styles.row, d.wrapRow)} data-row="voice-language">
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{view.language.title}</span>
          </span>
          <SegmentedControl
            label={view.language.title}
            options={view.language.options}
            value={view.language.value}
            onChange={(language) => save({ language })}
          />
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: a group of rows, not a form's fieldset */}
        <div role="group" aria-label={view.models.title} className={v.models}>
          {view.models.rows.map((row) => (
            <ModelRow key={row.id} api={api} row={row} />
          ))}
        </div>
        {view.dutchVoice ? <DutchVoiceRow api={api} row={view.dutchVoice} /> : null}
        <div className={cx(styles.row, styles.lastRow)} data-row="voice-gpu">
          <span className={styles.rowMeta}>{view.gpu}</span>
        </div>
      </div>
    </section>
  );
}

/**
 * *Dutch voice*: off until the person agrees to Supertonic 3's Open RAIL-M use restrictions in a dialog, which records
 * the agreement and downloads the model; turning it off removes its files.
 */
function DutchVoiceRow({ api, row }: { api: VoiceApi; row: VoiceDutchRow }) {
  const ids = useId();
  const actions = useVoiceActions(api);
  const toast = useToast();
  const [askLicence, setAskLicence] = useState(false);
  const [pending, setPending] = useState(false);
  const percent = row.progress === null ? null : Math.floor(row.progress * 100);

  const toggle = (next: boolean) => {
    if (pending) return;
    if (next) {
      setAskLicence(true);
      return;
    }
    setPending(true);
    void actions
      .setDutchVoice({ on: false })
      .catch((error) => toast.show(voiceSettingErrorText(error)))
      .finally(() => setPending(false));
  };

  const retry = () => {
    if (pending) return;
    setPending(true);
    void actions
      .fetchModel('supertonic')
      .catch((error) => toast.show(voiceSettingErrorText(error)))
      .finally(() => setPending(false));
  };

  return (
    <>
      <div className={styles.row} data-row="voice-dutch" data-state={row.state}>
        <span className={styles.rowMain}>
          <label className={styles.rowTitle} htmlFor={`${ids}-dutch`}>
            {row.title}
          </label>
          <span className={styles.rowMeta} id={`${ids}-dutch-meta`}>
            {row.meta}
          </span>
          {row.on ? (
            <span className={v.dutchStatus} id={`${ids}-dutch-state`} data-dutch-state="">
              <StatusDot tone={row.tone} size={8} label={null} />
              <span className={styles.rowMeta}>{`${row.size} · ${row.status}`}</span>
            </span>
          ) : null}
          {row.problem ? (
            <span className={styles.rowMeta} id={`${ids}-dutch-problem`} data-dutch-problem="">
              {row.problem}
            </span>
          ) : null}
          {percent !== null ? (
            <span
              className={v.progress}
              role="progressbar"
              aria-labelledby={`${ids}-dutch`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <span className={v.progressFill} style={{ width: `${percent}%` }} />
            </span>
          ) : null}
          {row.retryLabel ? (
            <span className={v.dutchRetry}>
              <Button variant="primary" size="sm" disabled={pending} onClick={retry}>
                {row.retryLabel}
              </Button>
            </span>
          ) : null}
        </span>
        <Toggle
          id={`${ids}-dutch`}
          checked={row.on}
          disabled={pending}
          aria-describedby={`${ids}-dutch-meta${row.on ? ` ${ids}-dutch-state` : ''}${row.problem ? ` ${ids}-dutch-problem` : ''}`}
          onCheckedChange={toggle}
        />
      </div>
      <DutchLicenceDialog open={askLicence} onClose={() => setAskLicence(false)} api={api} row={row} />
    </>
  );
}

/** Shows Supertonic 3's Open RAIL-M use restrictions with a link to the full licence before downloading. */
function DutchLicenceDialog({
  open,
  onClose,
  api,
  row,
}: {
  open: boolean;
  onClose: () => void;
  api: VoiceApi;
  row: VoiceDutchRow;
}) {
  const actions = useVoiceActions(api);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    if (!open) setNote(null);
  }, [open]);

  const agree = async () => {
    setBusy(true);
    setNote(null);
    try {
      await actions.setDutchVoice({ on: true, licenceVersion: row.licenceVersion });
      onClose();
    } catch (error) {
      setNote(voiceSettingErrorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={(next) => (next ? null : onClose())} width="md">
      <div className={tw.dialog}>
        <div className={tw.dialogHead}>
          <ModalTitle className={tw.dialogTitle}>{row.dialog.title}</ModalTitle>
          <ModalDescription className={tw.dialogLead}>{row.dialog.intro}</ModalDescription>
        </div>
        <ul className={v.restrictions}>
          {row.dialog.restrictions.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <a className={v.licenceLink} href={row.licenceUrl} target="_blank" rel="noopener noreferrer">
          {row.dialog.licenceLink}
        </a>
        {note ? (
          <span className={tw.dialogNote} role="status">
            {note}
          </span>
        ) : null}
        <div className={tw.dialogActions}>
          <ModalClose asChild>
            <Button variant="secondary" size="lg" disabled={busy}>
              {row.dialog.cancel}
            </Button>
          </ModalClose>
          <Button variant="primary" size="lg" disabled={busy} onClick={() => void agree()}>
            {row.dialog.agree}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** A model: its dot, name, what it is for and size, its state (with the download's bar) and the one thing to do. */
function ModelRow({ api, row }: { api: VoiceApi; row: VoiceModelRow }) {
  const ids = useId();
  const actions = useVoiceActions(api);
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const act = () => {
    if (!row.action || pending) return;
    const run = row.action.kind === 'remove' ? actions.removeModel : actions.fetchModel;
    setPending(true);
    void run(row.id)
      .catch((error) => toast.show(voiceSettingErrorText(error)))
      .finally(() => setPending(false));
  };
  const percent = row.progress === null ? null : Math.floor(row.progress * 100);
  return (
    <div className={styles.row} data-row="voice-model-file" data-model={row.id} data-state={row.state}>
      <StatusDot tone={row.tone} size={8} label={null} />
      <span className={styles.rowMain}>
        <span className={styles.rowTitle} id={`${ids}-name`}>
          {row.name}
        </span>
        <span className={styles.rowMeta}>{row.about}</span>
        <span className={styles.rowMeta} id={`${ids}-state`} data-voice-state="">
          {`${row.size} · ${row.status}`}
        </span>
        {row.problem ? (
          <span className={styles.rowMeta} id={`${ids}-problem`} data-voice-problem="">
            {row.problem}
          </span>
        ) : null}
        {percent !== null ? (
          <span
            className={v.progress}
            role="progressbar"
            aria-labelledby={`${ids}-name`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <span className={v.progressFill} style={{ width: `${percent}%` }} />
          </span>
        ) : null}
      </span>
      {row.action ? (
        <Button
          variant={row.action.kind === 'retry' ? 'primary' : 'secondary'}
          size="sm"
          aria-describedby={`${ids}-name ${ids}-state${row.problem ? ` ${ids}-problem` : ''}`}
          disabled={pending}
          onClick={act}
        >
          {row.action.label}
        </Button>
      ) : null}
    </div>
  );
}
