import {
  REMOTE_HELP_DEFAULT_CHOICE,
  REMOTE_HELP_TEXT,
  REMOTE_HELP_WORDS,
  type RemoteHelpChoice,
  type RemoteHelpStepRow,
  type RemoteHelpTranscript,
  remoteHelpApi,
  remoteHelpCard,
  remoteHelpChoice,
  remoteHelpConfirmText,
  remoteHelpVisitRows,
} from '@whombat/client/managed';
import { type RemoteHelpModel, useRemoteHelp } from '@whombat/client/react';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StatusDot } from '../../components/StatusDot';
import { saveBlob } from '../../lib/saveBlob';
import rh from './RemoteHelp.module.css';
import styles from './SettingsScreen.module.css';
import tw from './ThisWhombat.module.css';

const W = REMOTE_HELP_WORDS;
const T = REMOTE_HELP_TEXT;

/**
 * Settings → This Whombat → About → REMOTE HELP (Whombat remote-help.md RH-01…RH-12; app remote-help.md AP-4448…),
 * above DIAGNOSTICS. Off: how much (Look, Look and fix as radio cards), for how long (a segmented control,
 * Forever only on a test Whombat), “Turn on remote help” and the passkey hint; the confirmation is the passkey, or a
 * dialog for someone without one. On: the state line with Stop, the help code a customer box needs, who is connected.
 * Always: WHAT SUPPORT DID, each command line behind Show (a modal with Download). A box without a support key says it
 * isn't available yet.
 */
export function RemoteHelpSection() {
  const { session, managed } = useAppServices();
  const api = useMemo(() => (managed ? remoteHelpApi(session) : null), [session, managed]);
  const model = useRemoteHelp(api);
  const card = remoteHelpCard({
    state: model.state,
    hasPasskey: model.hasPasskey,
    now: new Date(),
  });
  if (!managed) return null;
  return (
    <section className={styles.section} aria-labelledby="remote-help" data-remote-help={card.kind}>
      <SectionLabel as="h2" id="remote-help">
        {W.title}
      </SectionLabel>
      <div className={styles.card}>
        {card.kind === 'unavailable' ? (
          <div className={styles.row}>
            <span className={styles.rowMain}>
              <span className={styles.rowMeta}>{card.text}</span>
            </span>
          </div>
        ) : model.loadError && !model.state ? (
          <div className={styles.row}>
            <span className={styles.rowMain}>
              <span className={styles.rowMeta}>{T.loadError}</span>
            </span>
            <Button variant="secondary" size="sm" onClick={model.reload}>
              {T.retry}
            </Button>
          </div>
        ) : card.kind === 'off' ? (
          <OffPart card={card} model={model} />
        ) : card.kind === 'on' ? (
          <OnPart card={card} model={model} />
        ) : null}
        {card.kind === 'off' || card.kind === 'on' ? <VisitsPart model={model} api={api} /> : null}
      </div>
    </section>
  );
}

type OffCard = Extract<ReturnType<typeof remoteHelpCard>, { kind: 'off' }>;
type OnCard = Extract<ReturnType<typeof remoteHelpCard>, { kind: 'on' }>;

/** Off: the choices and the button (AP-4449). */
function OffPart({ card, model }: { card: OffCard; model: RemoteHelpModel }) {
  const { managed } = useAppServices();
  const name = useId();
  const levelsId = useId();
  const [picked, setPicked] = useState<RemoteHelpChoice>(REMOTE_HELP_DEFAULT_CHOICE);
  const choice = remoteHelpChoice(picked, model.state);
  const confirm = useConfirm();
  const turnOn = () =>
    void model.turnOn(choice, {
      platform: managed?.passkeys ?? null,
      endpoint: managed?.devicePeerId ?? '',
      confirm: confirm.ask,
    });
  return (
    <div className={rh.body}>
      <p className={rh.intro}>{card.intro}</p>
      <fieldset className={rh.levels}>
        <legend className={rh.label} id={levelsId}>
          {card.howMuch}
        </legend>
        {card.levels.map((l) => (
          <label key={l.value} className={rh.level} data-selected={l.value === choice.level}>
            <input
              type="radio"
              name={name}
              value={l.value}
              className={rh.radio}
              checked={l.value === choice.level}
              onChange={() => setPicked((c) => ({ ...c, level: l.value }))}
            />
            <span className={rh.levelTitle}>{l.label}</span>
            <span className={rh.levelText}>{l.text}</span>
          </label>
        ))}
      </fieldset>
      <div className={rh.field}>
        <span className={rh.label} aria-hidden="true">
          {card.howLong}
        </span>
        <SegmentedControl
          label={card.howLong}
          role="radiogroup"
          className={rh.durations}
          value={choice.duration}
          onChange={(duration) => setPicked((c) => ({ ...c, duration }))}
          options={card.durations}
        />
      </div>
      <div className={rh.actions}>
        <Button variant="primary" size="md" disabled={model.busy !== null} onClick={turnOn}>
          {card.button}
        </Button>
        {card.hint ? <span className={rh.hint}>{card.hint}</span> : null}
      </div>
      {model.problem ? (
        <p className={rh.problem} role="alert">
          {model.problem}
        </p>
      ) : null}
      <Modal open={confirm.open !== null} onOpenChange={(open) => !open && confirm.answer(false)} width="md">
        <div className={tw.dialog} data-remote-help-confirm="">
          <div className={tw.dialogHead}>
            <ModalTitle className={tw.dialogTitle}>{W.confirm.title}</ModalTitle>
            <ModalDescription className={tw.dialogLead}>
              {confirm.open ? remoteHelpConfirmText(confirm.open.level, confirm.open.duration) : null}
            </ModalDescription>
          </div>
          <div className={tw.dialogActions}>
            <Button variant="secondary" size="lg" onClick={() => confirm.answer(false)}>
              {W.confirm.cancel}
            </Button>
            <Button variant="primary" size="lg" onClick={() => confirm.answer(true)}>
              {W.confirm.turnOn}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** The no-passkey dialog as a promise (`TurnOnRemoteHelpDeps.confirm`): the buttons answer it. */
function useConfirm() {
  const [open, setOpen] = useState<RemoteHelpChoice | null>(null);
  const resolve = useRef<((yes: boolean) => void) | null>(null);
  const ask = useCallback(
    (choice: RemoteHelpChoice) =>
      new Promise<boolean>((done) => {
        resolve.current?.(false);
        resolve.current = done;
        setOpen(choice);
      }),
    [],
  );
  const answer = useCallback((yes: boolean) => {
    resolve.current?.(yes);
    resolve.current = null;
    setOpen(null);
  }, []);
  return { open, ask, answer };
}

/** On: the state line and Stop, the help code, who is connected (AP-4450). */
function OnPart({ card, model }: { card: OnCard; model: RemoteHelpModel }) {
  return (
    <>
      <div className={cx(styles.row, rh.stateRow)}>
        <StatusDot tone="warn" size={9} label={T.onLabel} />
        <span className={styles.rowMain}>
          <span className={rh.stateLine}>{card.line}</span>
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={model.busy !== null}
          onClick={() => void model.stop()}
        >
          {card.stop}
        </Button>
      </div>
      {model.problem ? (
        <div className={styles.row}>
          <p className={rh.problem} role="alert">
            {model.problem}
          </p>
        </div>
      ) : null}
      {card.helpCode ? (
        <div className={styles.row}>
          <span className={styles.rowMain}>
            <span className={rh.label}>{card.helpCode.label}</span>
            <span className={rh.code} data-help-code="">
              {card.helpCode.code}
            </span>
            <span className={styles.rowMeta}>{card.helpCode.hint}</span>
          </span>
        </div>
      ) : null}
      {card.connected.map((c) => (
        <div key={c.key} className={styles.row} data-connected="">
          <StatusDot tone="ok" size={9} label={T.connectedLabel} />
          <span className={styles.rowMain}>
            <span className={rh.connected}>{c.text}</span>
          </span>
        </div>
      ))}
    </>
  );
}

/** WHAT SUPPORT DID (AP-4451): every visit's steps, Show opening a command line. */
function VisitsPart({
  model,
  api,
}: {
  model: RemoteHelpModel;
  api: ReturnType<typeof remoteHelpApi> | null;
}) {
  const labelId = useId();
  const [open, setOpen] = useState<RemoteHelpTranscript | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const rows = useMemo(
    () => (model.visits ? remoteHelpVisitRows(model.visits, { now: new Date() }) : null),
    [model.visits],
  );
  const show = async (visitId: string) => {
    if (!api) return;
    setFailed(false);
    setLoading(visitId);
    try {
      setOpen(await api.transcript(visitId));
    } catch {
      setFailed(true);
    } finally {
      setLoading(null);
    }
  };
  return (
    <div className={rh.visits}>
      <span className={rh.label} id={labelId}>
        {W.visits}
      </span>
      {rows === null ? null : rows.length === 0 ? (
        <p className={rh.empty}>{W.noVisits}</p>
      ) : (
        <ol className={rh.log} aria-labelledby={labelId}>
          {rows.map((r) => (
            <Step key={r.key} row={r} loading={loading === r.transcript} onShow={show} />
          ))}
        </ol>
      )}
      {failed ? (
        <p className={rh.problem} role="alert">
          {T.transcriptFailed}
        </p>
      ) : null}
      <Modal open={open !== null} onOpenChange={(o) => !o && setOpen(null)} width="lg">
        <div className={tw.dialog} data-remote-help-transcript="">
          <div className={tw.dialogHead}>
            <ModalTitle className={tw.dialogTitle}>{W.transcript.title}</ModalTitle>
          </div>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling record is read with the keyboard too */}
          <pre className={rh.transcript} tabIndex={0}>
            {open?.text}
          </pre>
          <div className={tw.dialogActions}>
            <ModalClose asChild>
              <Button variant="secondary" size="lg">
                {T.close}
              </Button>
            </ModalClose>
            <Button
              variant="primary"
              size="lg"
              onClick={() =>
                open &&
                // A download, never a navigation (AP-16): a neutral type, then the file is yours.
                saveBlob(
                  new Blob([new Uint8Array(open.bytes)], { type: 'application/octet-stream' }),
                  open.name,
                )
              }
            >
              {W.transcript.download}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Step({
  row,
  loading,
  onShow,
}: {
  row: RemoteHelpStepRow;
  loading: boolean;
  onShow: (visitId: string) => Promise<void>;
}) {
  return (
    <li className={rh.step} data-muted={row.muted || undefined}>
      {row.time ? (
        <time className={rh.time} dateTime={row.at}>
          {row.time}
        </time>
      ) : (
        <span className={rh.time} />
      )}
      <span className={rh.stepText}>
        {row.text}
        {row.code ? (
          <>
            {' '}
            <code className={rh.line}>{row.code}</code>
          </>
        ) : null}
      </span>
      {row.transcript ? (
        <Button
          variant="link"
          size="sm"
          className={rh.show}
          disabled={loading}
          aria-label={`${W.transcript.show} ${W.transcript.title.toLowerCase()}`}
          onClick={() => void onShow(row.transcript as string)}
        >
          {W.transcript.show}
        </Button>
      ) : null}
    </li>
  );
}
