import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type InstallerLocale, isDutch } from '../i18n/locale';
import { useT } from '../i18n/react';
import { english, type Translate } from '../i18n/translate';
import { type Check, INSTALL_STEPS, type InstallerState } from '../lib/api';
import type { Client } from '../lib/client';
import {
  checkLabelCopy,
  checkNote,
  diskHolds,
  diskReasonCopy,
  installerCopy,
  stepLabelCopy,
  stepSayCopy,
} from '../lib/copy';
import {
  checksFolded,
  checksVerdict,
  chosenDisk,
  eligibleDisks,
  eraseConfirmed,
  formatSize,
  type InstallerScreen,
  installerScreen,
  installRequest,
  nextStep,
  prevStep,
  START,
  stepOf,
  stepStates,
  type Wizard,
  type WizardStep,
} from '../lib/installer';
import { fill } from '../ui/Bubble';
import { Button } from '../ui/Button';
import type { SheetInitial } from '../wifi/WifiSheet';
import { Frame } from './Frame';
import styles from './installer.module.css';
import { ReachStep } from './ReachStep';
import { WifiStep } from './WifiStep';

interface Props {
  state: InstallerState;
  client: Client;
  refresh: () => void;
  onLocale: (locale: InstallerLocale) => void;
  /** Demo fixtures only: start on this wizard step. */
  initial?: Partial<Wizard>;
  /** Demo fixtures only: the Wi-Fi step's own state at the start. */
  wifi?: SheetInitial;
}

export function Installer({ state, client, refresh, initial, wifi, onLocale }: Props) {
  const t = useT();

  const [wizard, setWizard] = useState<Wizard>(() => ({ ...START, ...initial }));
  const screen = installerScreen(state, wizard);
  const go = (step: WizardStep) => setWizard((w) => ({ ...w, step }));
  // The release and the environment; no platform: the same ISO installs a VM and a dedicated machine (CG-30).
  const meta = [
    state.release ?? t('installer.installer.developmentBuild'),
    state.environment === 'dev' ? 'dev' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const common = { state, meta, client, refresh };

  // Each screen remounts (`key`), so the primary action's autoFocus lands on it.
  switch (screen) {
    case 'welcome':
      return (
        <Welcome key={screen} meta={meta} onLocale={onLocale} onNext={() => go(nextStep(state, 'welcome'))} />
      );
    case 'reach':
      return (
        <ReachStep
          key={screen}
          {...common}
          kicker={kickerFor(state, 'reach', t)}
          wizard={wizard}
          onChange={(c) => setWizard((w) => ({ ...w, ...c }))}
          onBack={() => go(prevStep(state, 'reach'))}
          onNext={() => go(nextStep(state, 'reach'))}
        />
      );
    case 'checks':
      return (
        <Checks
          key={screen}
          {...common}
          onBack={() => go(prevStep(state, 'checks'))}
          onNext={() => go(nextStep(state, 'checks'))}
        />
      );
    case 'wifi':
      return (
        <WifiStep
          key={screen}
          {...common}
          kicker={kickerFor(state, 'wifi', t)}
          initial={wifi}
          onBack={() => go(prevStep(state, 'wifi'))}
          onNext={() => go(nextStep(state, 'wifi'))}
        />
      );
    case 'disk':
      return (
        <DiskStep
          key={screen}
          {...common}
          picked={wizard.disk}
          onPick={(disk) => setWizard((w) => ({ ...w, disk }))}
          onBack={() => go(prevStep(state, 'disk'))}
          onNext={() => go(nextStep(state, 'disk'))}
        />
      );
    case 'erase':
      return (
        <Erase
          key={screen}
          {...common}
          wizard={wizard}
          picked={wizard.disk}
          onBack={() => go(prevStep(state, 'erase'))}
          onStarted={() => setWizard((w) => ({ ...w, retrying: false }))}
        />
      );
    case 'installing':
      return <Installing key={screen} {...common} />;
    case 'done':
      return <Done key={screen} {...common} />;
    case 'failed':
      return (
        <Failed
          key={screen}
          {...common}
          onRetry={() => setWizard((w) => ({ ...w, step: 'checks', retrying: true }))}
        />
      );
  }
}

/** For the tests and the fixtures: which screen a state and wizard show. */
export const screenFor = (s: InstallerState, w: Partial<Wizard> = {}): InstallerScreen =>
  installerScreen(s, { ...START, ...w });

interface Common {
  state: InstallerState;
  meta: string;
  client: Client;
  refresh: () => void;
}

function kickerFor(s: InstallerState, step: WizardStep, t: Translate = english): string {
  const T = installerCopy(t);

  const n = stepOf(s, step);
  return n ? T.step(n.n, n.of) : T.kicker;
}

function Welcome({
  meta,
  onNext,
  onLocale,
}: {
  meta: string;
  onNext: () => void;
  onLocale: (locale: InstallerLocale) => void;
}) {
  const t = useT();
  const T = installerCopy(t);

  return (
    <Frame
      kicker={T.kicker}
      title={T.welcomeTitle}
      sub={T.welcomeSub}
      guide={{ say: T.welcomeSay }}
      meta={meta}
      actions={
        <Button autoFocus onClick={onNext}>
          {T.start}
        </Button>
      }
    >
      <p className={styles.note}>{T.welcomeNext}</p>
      <LanguageChoice onLocale={onLocale} />
    </Frame>
  );
}

function LanguageChoice({ onLocale }: { onLocale: (locale: InstallerLocale) => void }) {
  const t = useT();
  const dutch = isDutch(t.locale);
  return (
    <fieldset className={styles.languages}>
      <legend className="visually-hidden">{t('installer.language')}</legend>
      <Button kind="secondary" lang="en" aria-pressed={!dutch} onClick={() => onLocale('en-GB')}>
        English
      </Button>
      <Button kind="secondary" lang="nl" aria-pressed={dutch} onClick={() => onLocale('nl-NL')}>
        Nederlands
      </Button>
    </fieldset>
  );
}

function StatusIcon({ status }: { status: 'running' | 'ok' | 'warn' | 'fail' }) {
  const t = useT();

  if (status === 'running')
    return <span className={styles.spinner} aria-label={t('installer.installer.checking')} role="img" />;
  const glyph = { ok: '✓', warn: '!', fail: '✕' }[status];
  const label = {
    ok: 'OK',
    warn: t('installer.installer.warn.warning'),
    fail: t('installer.installer.fail.problem'),
  }[status];
  return (
    <span className={`${styles.icon} ${styles[status]}`} role="img" aria-label={label}>
      {glyph}
    </span>
  );
}

function Checks({
  state,
  meta,
  client,
  refresh,
  onBack,
  onNext,
}: Common & { onBack: () => void; onNext: () => void }) {
  const t = useT();
  const T = installerCopy(t);

  const verdict = checksVerdict(state);
  const next = useRef<HTMLButtonElement>(null);
  const again = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (verdict === 'ok' || verdict === 'warn') next.current?.focus();
    if (verdict === 'fail') again.current?.focus();
  }, [verdict]);
  // The line says it while the checks run and once all passed; the bar under it only what needs reading.
  const summary = verdict === 'warn' ? T.checksWarn : verdict === 'fail' ? T.checksFail : null;
  const { shown, folded } = checksFolded(state.preflight.checks);
  const [details, setDetails] = useState(false);
  const recheck = async () => {
    await client.post('/api/preflight').catch(() => null);
    refresh();
  };
  return (
    <Frame
      kicker={kickerFor(state, 'checks', t)}
      title={T.checksTitle}
      sub={T.checksSub}
      guide={{ say: T.checksSay[verdict] }}
      meta={meta}
      actions={
        <>
          <Button kind="quiet" onClick={onBack}>
            {T.back}
          </Button>
          <p className={`${styles.summary} ${styles[verdict]}`} role="status">
            {summary}
          </p>
          <Button ref={again} kind="secondary" onClick={recheck} disabled={verdict === 'running'}>
            {T.checkAgain}
          </Button>
          <Button ref={next} onClick={onNext} disabled={verdict === 'running' || verdict === 'fail'}>
            {T.continue}
          </Button>
        </>
      }
    >
      {(verdict === 'ok' || verdict === 'running') && (
        <p className={styles.checksLine} aria-live="polite">
          <StatusIcon status={verdict} />
          {verdict === 'ok' ? T.checksAllGood : T.checksLooking}
        </p>
      )}
      {shown.length > 0 && <CheckRows checks={shown} state={state} live />}
      {folded.length > 0 && (
        <>
          <button
            type="button"
            className={styles.detailsToggle}
            aria-expanded={details}
            onClick={() => setDetails((d) => !d)}
          >
            {details ? T.checksHideDetails : T.checksDetails}
          </button>
          {details && <CheckRows checks={folded} state={state} />}
        </>
      )}
    </Frame>
  );
}

/** The checks' rows: what each looked at, its value, and under one that isn't ok what to do in plain words. */
function CheckRows({
  checks,
  state,
  live = false,
}: {
  checks: Check[];
  state: InstallerState;
  live?: boolean;
}) {
  const t = useT();
  const CHECK_LABEL = checkLabelCopy(t);

  return (
    <ul className={styles.checks} aria-live={live ? 'polite' : undefined}>
      {checks.map((c) => {
        const note = checkNote(c.id, c.status, c.value, state.preflight.disks, t);
        return (
          <li key={c.id} className={styles.check}>
            <StatusIcon status={c.status} />
            <span className={styles.checkLabel}>{CHECK_LABEL[c.id]}</span>
            <span className={styles.checkValue}>
              {c.id === 'cpu' && c.count !== undefined
                ? t('installer.check.cores', { count: c.count })
                : c.value}
            </span>
            {note && <span className={`${styles.checkNote} ${styles[c.status]}`}>{note}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function DiskStep({
  state,
  meta,
  picked,
  onPick,
  onBack,
  onNext,
}: Common & {
  picked: string | null;
  onPick: (path: string) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  const t = useT();
  const T = installerCopy(t);
  const DISK_REASON = diskReasonCopy(t);

  const disk = chosenDisk(state, picked);
  const none = eligibleDisks(state).length === 0;
  return (
    <Frame
      kicker={kickerFor(state, 'disk', t)}
      title={T.diskTitle}
      sub={T.diskSub}
      guide={{ say: T.diskSay }}
      meta={meta}
      actions={
        <>
          <Button kind="quiet" onClick={onBack}>
            {T.back}
          </Button>
          <span className={styles.grow} />
          <Button onClick={onNext} disabled={!disk}>
            {T.continue}
          </Button>
        </>
      }
    >
      <form
        className={styles.disks}
        onSubmit={(e) => {
          e.preventDefault();
          if (disk) onNext();
        }}
      >
        <fieldset>
          <legend className="visually-hidden">{T.diskTitle}</legend>
          {state.preflight.disks.map((d, i) => {
            const first = i === state.preflight.disks.findIndex((x) => x.eligible);
            return (
              <label key={d.path} className={`${styles.disk} ${d.eligible ? '' : styles.diskOff}`}>
                <input
                  type="radio"
                  name="disk"
                  value={d.path}
                  disabled={!d.eligible}
                  checked={disk?.path === d.path}
                  autoFocus={disk ? disk.path === d.path : first}
                  onChange={() => onPick(d.path)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && disk) onNext();
                  }}
                />
                {/* Size and model as a person knows the disk; its device name quiet at the end. */}
                <span className={styles.diskSize}>{formatSize(d.sizeBytes, t.locale)}</span>
                <span className={styles.diskModel}>{d.model}</span>
                <span className={styles.diskName}>{d.name}</span>
                {!d.eligible && d.reason && (
                  <span className={styles.diskReason}>{DISK_REASON[d.reason]}</span>
                )}
              </label>
            );
          })}
        </fieldset>
        {none && <p className={`${styles.summary} ${styles.fail}`}>{T.diskNone}</p>}
      </form>
    </Frame>
  );
}

function Erase({
  state,
  meta,
  client,
  refresh,
  wizard,
  picked,
  onBack,
  onStarted,
}: Common & { wizard: Wizard; picked: string | null; onBack: () => void; onStarted: () => void }) {
  const t = useT();
  const T = installerCopy(t);

  const disk = chosenDisk(state, picked);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = eraseConfirmed(typed, disk) && !busy;
  const install = async () => {
    if (!disk || !ok) return;
    setBusy(true);
    setError(null);
    const r = await client.post('/api/install', installRequest(state, wizard, disk, typed)).catch(() => null);
    if (r && r.status === 202) {
      onStarted();
      refresh();
      return;
    }
    setBusy(false);
    setError(r?.status === 409 ? T.eraseBusy : T.eraseRefused);
  };
  const name = disk?.name ?? '';
  // The model in the mono face: the sans face's Q has its tail apart under the letter, which read as an underline.
  const model = disk?.model ? (
    <>
      {' ('}
      <span className={styles.model}>{disk.model}</span>)
    </>
  ) : (
    ''
  );
  const size = disk ? formatSize(disk.sizeBytes, t.locale) : '';
  // An empty disk loses nothing: the button confirms (Enter on it). One that holds something: its name typed.
  const empty = disk?.empty === true;
  const holds = disk ? diskHolds(disk, t) : null;
  return (
    <Frame
      kicker={kickerFor(state, 'erase', t)}
      title={T.eraseTitle}
      sub={!disk ? T.diskNone : fill(empty ? T.eraseEmptySub : T.eraseSub, size, model)}
      guide={{ say: T.eraseSay }}
      meta={meta}
      actions={
        <>
          <Button kind="quiet" onClick={onBack}>
            {T.back}
          </Button>
          <span className={styles.grow} />
          <Button kind="danger" onClick={install} disabled={!ok} autoFocus={empty}>
            {busy ? T.erasing : empty ? T.eraseEmpty : T.erase(name)}
          </Button>
        </>
      }
    >
      {empty ? (
        error && (
          <p className={`${styles.summary} ${styles.fail}`} role="alert">
            {error}
          </p>
        )
      ) : (
        <form
          className={styles.confirm}
          onSubmit={(e) => {
            e.preventDefault();
            void install();
          }}
        >
          {holds && <p className={styles.holds}>{holds}</p>}
          <label htmlFor="erase-confirm" className={styles.label}>
            {fill(T.eraseLabel, <span className={styles.name}>{name}</span>)}
          </label>
          <input
            id="erase-confirm"
            className={styles.confirmInput}
            value={typed}
            onChange={(e) => setTyped(e.target.value.slice(0, 32))}
            autoFocus
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={name}
            disabled={busy || !disk}
          />
          {error && (
            <p className={`${styles.summary} ${styles.fail}`} role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </Frame>
  );
}

function Log({ lines, label }: { lines: string[]; label: string }) {
  const ref = useRef<HTMLPreElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the tail on every new line
  useLayoutEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the log scrolls with the arrow keys
    <pre ref={ref} className={styles.log} tabIndex={0} role="log" aria-label={label}>
      {lines.join('\n')}
    </pre>
  );
}

function Steps({ state }: { state: InstallerState }) {
  const t = useT();
  const STEP_LABEL = stepLabelCopy(t);

  const states = stepStates(state);
  return (
    <ol className={styles.steps}>
      {INSTALL_STEPS.map((id) => (
        <li
          key={id}
          className={styles[`step-${states[id]}`]}
          aria-current={states[id] === 'current' ? 'step' : undefined}
        >
          <span className={styles.stepDot} aria-hidden="true">
            {states[id] === 'done' ? '✓' : states[id] === 'failed' ? '✕' : ''}
          </span>
          {STEP_LABEL[id]}
        </li>
      ))}
    </ol>
  );
}

function Installing({ state, meta }: Common) {
  const t = useT();
  const T = installerCopy(t);
  const STEP_SAY = stepSayCopy(t);

  const [details, setDetails] = useState(false);
  const { percent, step } = state.install;
  return (
    <Frame
      kicker={T.kicker}
      title={T.installingTitle}
      sub={T.installingSub}
      guide={{ say: STEP_SAY[step ?? 'partition'], digging: true, pile: percent / 100 }}
      meta={meta}
      actions={
        <Button kind="secondary" autoFocus onClick={() => setDetails((d) => !d)} aria-expanded={details}>
          {details ? T.hideDetails : T.showDetails}
        </Button>
      }
    >
      <div className={styles.progressRow}>
        <div
          className={styles.progress}
          role="progressbar"
          aria-label={T.progressLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <span style={{ width: `${percent}%` }} />
        </div>
        <span className={styles.percent}>{percent}%</span>
      </div>
      {details ? <Log lines={state.install.log} label={T.showDetails} /> : <Steps state={state} />}
    </Frame>
  );
}

function Done({ state, meta, client }: Common) {
  const t = useT();
  const T = installerCopy(t);

  const [restarting, setRestarting] = useState(false);
  const restart = async () => {
    setRestarting(true);
    const r = await client.post('/api/restart').catch(() => null);
    if (r?.status !== 202) setRestarting(false);
  };
  return (
    <Frame
      kicker={T.kicker}
      title={T.doneTitle}
      sub={T.doneSub}
      guide={{ say: T.doneSay, friend: 'banjo' }}
      meta={meta}
      actions={
        <Button autoFocus onClick={restart} disabled={restarting}>
          {restarting ? T.restarting : T.restart}
        </Button>
      }
    >
      <Steps state={state} />
      <p className={styles.iso}>{T.doneMedium}</p>
    </Frame>
  );
}

function Failed({ state, meta, client, refresh, onRetry }: Common & { onRetry: () => void }) {
  const t = useT();
  const STEP_LABEL = stepLabelCopy(t);
  const T = installerCopy(t);

  const step = state.install.step ? STEP_LABEL[state.install.step] : null;
  const retry = async () => {
    await client.post('/api/preflight').catch(() => null);
    onRetry();
    refresh();
  };
  return (
    <Frame
      kicker={T.kicker}
      title={T.failedTitle}
      sub={T.failedSub(step)}
      guide={{ say: T.failedSay }}
      meta={meta}
      actions={
        <Button autoFocus onClick={retry}>
          {T.tryAgain}
        </Button>
      }
    >
      {state.install.error && <p className={styles.error}>{state.install.error}</p>}
      <Log lines={state.install.log} label={T.failedLog} />
    </Frame>
  );
}
