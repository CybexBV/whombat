import {
  REMOTE_HELP_DEFAULT_CHOICE,
  REMOTE_HELP_FOLD,
  type RemoteHelpChoice,
  type RemoteHelpStepRow,
  type RemoteHelpTranscript,
  type RemoteHelpVisitGroup,
  remoteHelpApi,
  remoteHelpCard,
  remoteHelpChoice,
  remoteHelpConfirmText,
  remoteHelpVisitGroups,
} from '@whombat/client/managed';
import { type RemoteHelpModel, useRemoteHelp } from '@whombat/client/react';
import { Eye, SquareTerminal, Wrench } from 'lucide-react';
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StatusDot } from '../../components/StatusDot';
import { REMOTE_HELP_TEXT, REMOTE_HELP_WORDS } from '../../i18n/clientWords';
import { currentLocale } from '../../i18n/provider';
import { saveBlob } from '../../lib/saveBlob';
import { PASSKEYS, webAuthnExists } from '../../managed/passkeyEnv';
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
 * Always: WHAT SUPPORT DID, one block per visit (docs/app/decisions/about-page.md: who, how much, when, how many steps),
 * the newest three visits and each one's last three steps, the rest behind Show all, and a visit's command line behind
 * Command line (a modal with Download). A box without a support key says it isn't available yet.
 */
export function RemoteHelpSection() {
  const { session, managed } = useAppServices();
  const boxHost = atOwnAddress(managed) ? window.location.hostname : null;
  const api = useMemo(
    () => (managed ? remoteHelpApi(session, { boxHost }) : null),
    [session, managed, boxHost],
  );
  const model = useRemoteHelp(api);
  const card = remoteHelpCard({
    state: model.state,
    hasPasskey: model.hasPasskey,
    now: new Date(),
    locale: currentLocale(),
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

/** This is a page at the box's own address, where its own passkeys work. */
function atOwnAddress(managed: ReturnType<typeof useAppServices>['managed']): boolean {
  return managed?.page?.atAddress === true && managed.page.secure;
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
      // On the box's own address its own passkeys confirm, in this browser (the hosted app's can't run there).
      platform: managed?.passkeys ?? (atOwnAddress(managed) && webAuthnExists() ? PASSKEYS : null),
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
              {confirm.open
                ? remoteHelpConfirmText(confirm.open.level, confirm.open.duration, currentLocale())
                : null}
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

/**
 * WHAT SUPPORT DID (AP-4451): one block per visit, so a long history folds — the newest three, the rest behind
 * “Show N earlier visits”; a visit's Command line opens what the command line showed.
 */
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
  const [all, setAll] = useState(false);
  const groups = useMemo(
    () =>
      model.visits ? remoteHelpVisitGroups(model.visits, { now: new Date(), locale: currentLocale() }) : null,
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
  const shown = groups ? (all ? groups : groups.slice(0, REMOTE_HELP_FOLD.visits)) : [];
  const hidden = groups ? groups.length - shown.length : 0;
  return (
    <div className={rh.visits}>
      <span className={rh.label} id={labelId}>
        {W.visits}
      </span>
      {groups === null ? null : groups.length === 0 ? (
        <p className={rh.empty}>{W.noVisits}</p>
      ) : (
        <ol className={rh.visitList} aria-labelledby={labelId}>
          {shown.map((g) => (
            <Visit key={g.key} group={g} loading={loading === g.visitId} onShow={show} />
          ))}
        </ol>
      )}
      {hidden > 0 ? (
        <Button variant="link" size="sm" className={rh.more} onClick={() => setAll(true)}>
          {T.earlierVisits(hidden)}
        </Button>
      ) : null}
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

/**
 * One visit: an eye (Look) or a wrench (Look and fix), green with “Now” while it lasts, who came; when it started, how
 * much they could do and how many steps; its last three steps, Show all for the rest, and Command line where one was
 * kept.
 */
function Visit({
  group: g,
  loading,
  onShow,
}: {
  group: RemoteHelpVisitGroup;
  loading: boolean;
  onShow: (visitId: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const headId = useId();
  // “Earlier steps aren’t shown.” isn't a step: only real ones count toward Show all.
  const more = g.stepCount > REMOTE_HELP_FOLD.steps;
  const steps = open || !more ? g.steps : g.steps.slice(-REMOTE_HELP_FOLD.steps);
  const Icon = g.level === 'fix' ? Wrench : Eye;
  return (
    <li className={rh.visit}>
      <div className={rh.visitHead} id={headId}>
        <span className={rh.visitIcon} data-ongoing={g.ongoing || undefined} aria-hidden="true">
          <Icon size={18} strokeWidth={1.8} />
        </span>
        <span className={rh.visitWho}>
          <span className={rh.who}>
            {g.who}
            {g.ongoing ? <span className={rh.now}>{T.now}</span> : null}
          </span>
          <span className={rh.visitMeta}>{`${g.when} · ${g.line}`}</span>
        </span>
      </div>
      <ol className={rh.log} aria-labelledby={headId}>
        {steps.map((r) => (
          <Step key={r.key} row={r} />
        ))}
      </ol>
      {more || g.transcript ? (
        <div className={rh.visitActions}>
          {/* Command line first, so it stays put when Show all becomes Show fewer. */}
          {g.transcript ? (
            <Button
              variant="link"
              size="sm"
              disabled={loading}
              aria-label={`${W.transcript.show} ${W.transcript.title.toLowerCase()}`}
              onClick={() => void onShow(g.transcript as string)}
            >
              <SquareTerminal size={15} strokeWidth={2} aria-hidden="true" />
              {W.transcript.title}
            </Button>
          ) : null}
          {more ? (
            <Button variant="link" size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? T.fewerSteps : T.allSteps(g.stepCount)}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** A step: its time in mono (the visit says the day), its words, a command line in code style. */
function Step({ row }: { row: RemoteHelpStepRow }) {
  return (
    <li className={rh.step} data-muted={row.muted || undefined}>
      {row.time ? (
        <time className={rh.time} dateTime={row.at}>
          {row.time}
        </time>
      ) : null}
      <span className={rh.stepText}>
        {row.text}
        {row.code ? (
          <>
            {' '}
            <code className={rh.line}>{row.code}</code>
          </>
        ) : null}
      </span>
    </li>
  );
}
