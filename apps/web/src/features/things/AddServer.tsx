/**
 * Add a server (ONE-15; Whombat `server-signin.md` SI-01…SI-12; app `server-signin-web.md` AP-1677…): what Whombat may
 * do on it, chosen once above two ways in — **Sign in once** (address, user name and the password or a key from the
 * Vault; Whombat installs its agent over SSH and says how it goes step by step), **Run a command** (the
 * pre-approved command for the chosen level) and **Windows PC** (the same as one PowerShell line, windows-servers.md)
 * — and the servers an older command left waiting for you, each added or turned away. Opened from Servers (`?add=1`), Home and the assistant's card (`&address=&user=&control=`).
 */
import { useRouterState } from '@tanstack/react-router';
import {
  type AddServerPrefill,
  addServerPrefill,
  COMMAND_COPY,
  commandOutcome,
  commitOutcomeText,
  formatAgo,
  HOST_CONTROL_QUESTION,
  hostErrorInfo,
  INSTALL_KEY_CHANGED_AGAIN,
  type InstallStep,
  installBody,
  installFailureCard,
  installHostKeyNote,
  installOutcome,
  installRunning,
  installSteps,
  installTitle,
  isHostsUnavailable,
  NEW_KEY,
  SIGN_IN_COPY,
  type SignInErrors,
  type SignInForm,
  serverHref,
  signInFormDefaults,
  signInFormErrors,
  signInFormForRetry,
  sshKeyChoices,
  WINDOWS_COPY,
  withKeyDefaults,
} from '@whombat/client/hosts';
import {
  useHostEnrollments,
  useHostInstall,
  useHostsChange,
  useHostsFleet,
  useHostsStatus,
} from '@whombat/client/hosts/react';
import { useVault, useVaultWrite } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import {
  HOST_CONTROL_LEVELS,
  HOST_WINDOWS_UNINSTALL_COMMAND,
  type HostControlLevel,
  type HostEnrollment,
  type HostInstall,
  type HostPendingEnrollment,
  hostControlLevelWords,
} from '@whombat/core/domain';
import { Check as CheckIcon, ChevronRight, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';
import { Button } from '../../components/Button';
import { CopyButton } from '../../components/CopyButton';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { Modal, ModalDescription, ModalTitle } from '../../components/Modal';
import { SegmentedControl } from '../../components/SegmentedControl';
import { Tabs } from '../../components/Tabs';
import { useToast } from '../../components/Toast';
import { currentLocale, useWebI18n } from '../../i18n/provider';
import { useLocaleWords } from '../../i18n/words';
import s from './AddServer.module.css';
import { Check, SelectField, TextField } from './manage/fields';
import { useChangeRunner } from './parts';
import styles from './Things.module.css';

export function AddServerDialog({ burrow, onClose }: { burrow: string; onClose: () => void }) {
  const { tag: uiLocale } = useWebI18n();
  const status = useHostsStatus({ params: { burrow } });
  const absent = status.data && !status.data.present;
  const refusal = absent
    ? 'Servers aren’t set up on this Whombat.'
    : status.error
      ? isHostsUnavailable(status.error)
        ? 'Servers aren’t reachable right now.'
        : hostErrorInfo(status.error, uiLocale).message
      : null;
  if (refusal || !status.data)
    return (
      <Modal open onOpenChange={(o) => !o && onClose()} width="md">
        <ModalTitle className={styles.dialogTitle}>Add a server</ModalTitle>
        {refusal ? (
          <ModalDescription className={styles.dialogBody}>{refusal}</ModalDescription>
        ) : (
          <div className={styles.skeleton} style={{ height: 160 }} aria-busy="true" />
        )}
        <div className={styles.dialogActions}>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </Modal>
    );
  return <AddServer burrow={burrow} onClose={onClose} />;
}

/* Sign in once and Run a command (SI-01) -------------------------------------------------------------------------- */

type Way = 'signin' | 'command' | 'windows';

function AddServer({ burrow, onClose }: { burrow: string; onClose: () => void }) {
  const HOST_CONTROL_LEVEL_WORDS = useLocaleWords(hostControlLevelWords);
  const { tag: uiLocale } = useWebI18n();
  const raw = useRouterState({ select: (st) => st.location.search }) as Record<string, unknown>;
  // What the dialog opened with (the assistant's card, SI-10); later changes to the address don't refill the form.
  const [prefill] = useState(() => addServerPrefill(raw));
  const [control, setControl] = useState<HostControlLevel>(prefill.control);
  const [way, setWay] = useState<Way>('signin');
  const [form, setForm] = useState<SignInForm>(() => signInFormDefaults(prefill));
  const [job, setJob] = useState<HostInstall | null>(null);
  const [commands, setCommands] = useState<Partial<Record<HostControlLevel, HostEnrollment>>>({});
  const toast = useToast();
  const pending = useHostEnrollments(
    { params: { burrow }, query: { state: 'pending' } },
    { refetchInterval: 10_000 },
  );
  const followed = useHostInstall(burrow, job?.id ?? null);
  const view = followed.data ?? job;
  const waiting = pending.data?.items ?? [];
  const ids = useId();
  const running = view ? installRunning(view) : false;

  const close = () => {
    if (view && running)
      toast.show(
        view.serverName
          ? `Whombat carries on. ${view.serverName} shows up under Servers when it’s ready.`
          : 'Whombat carries on adding it. It shows up under Servers when it’s ready.',
      );
    onClose();
  };

  if (view)
    return (
      <Modal open onOpenChange={(o) => !o && close()} width="md">
        <Progress
          burrow={burrow}
          view={view}
          lost={followed.error && !followed.data ? hostErrorInfo(followed.error, uiLocale).message : null}
          onHide={close}
          onClose={onClose}
          onRetry={() => {
            setForm((f) => signInFormForRetry(f));
            setJob(null);
          }}
          onCommand={() => {
            setJob(null);
            setWay('command');
          }}
        />
      </Modal>
    );

  const line = HOST_CONTROL_LEVEL_WORDS[control].line;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} width="md">
      <ModalTitle className={styles.dialogTitle}>Add a server</ModalTitle>
      <div className={s.level}>
        <span className={s.levelLabel} aria-hidden="true">
          {HOST_CONTROL_QUESTION}
        </span>
        <SegmentedControl
          options={HOST_CONTROL_LEVELS.map((l) => ({ value: l, label: HOST_CONTROL_LEVEL_WORDS[l].title }))}
          value={control}
          onChange={setControl}
          label={HOST_CONTROL_QUESTION}
          role="radiogroup"
          describedBy={`${ids}-level`}
          className={s.levels}
        />
        <small id={`${ids}-level`} className={s.levelLine}>
          {line}
        </small>
      </div>
      <Tabs
        tabs={[
          { key: 'signin', label: SIGN_IN_COPY.tab },
          { key: 'command', label: COMMAND_COPY.tab },
          { key: 'windows', label: WINDOWS_COPY.tab },
        ]}
        value={way}
        onChange={setWay}
        label="How to add it"
        idPrefix={`${ids}-way`}
        panelId={`${ids}-panel`}
        className={s.ways}
        tabClassName={s.way}
      />
      <div id={`${ids}-panel`} role="tabpanel" aria-labelledby={`${ids}-way-${way}`} className={s.panel}>
        {way === 'signin' ? (
          <SignInOnce
            burrow={burrow}
            control={control}
            prefill={prefill}
            form={form}
            setForm={setForm}
            onStarted={(started) => {
              setForm((f) => signInFormForRetry(f));
              setJob(started);
            }}
            onClose={onClose}
          />
        ) : (
          <RunCommand
            burrow={burrow}
            control={control}
            windows={way === 'windows'}
            commands={commands}
            onMade={(level, e) => setCommands((m) => ({ ...m, [level]: e }))}
            onClose={onClose}
          />
        )}
      </div>
      {waiting.length ? <WaitingForYou burrow={burrow} items={waiting} /> : null}
    </Modal>
  );
}

/* Sign in once (SI-02, SI-09) ------------------------------------------------------------------------------------- */

function SignInOnce({
  burrow,
  control,
  prefill,
  form: f,
  setForm,
  onStarted,
  onClose,
}: {
  burrow: string;
  control: HostControlLevel;
  prefill: AddServerPrefill;
  form: SignInForm;
  setForm: (update: (f: SignInForm) => SignInForm) => void;
  onStarted: (job: HostInstall) => void;
  onClose: () => void;
}) {
  const formId = useId();
  const start = useHostsChange(api.hosts.startInstall);
  const [errors, setErrors] = useState<SignInErrors>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needKeys = f.method === 'vault' || f.keepKey;
  const vault = useVault(needKeys ? { params: { burrow } } : null);
  const keys = useMemo(() => sshKeyChoices(vault.data?.entries ?? []), [vault.data]);
  const set = <K extends keyof SignInForm>(k: K, v: SignInForm[K]) => {
    setForm((x) => ({ ...x, [k]: v }));
    setErrors((e) => (k in e ? { ...e, [k]: undefined } : e));
  };
  // The pickers show their defaults until the person picks (SI-09 starts at the key they sign in with).
  const g = useMemo(() => withKeyDefaults(f, keys), [f, keys]);

  const submit = async () => {
    const errs = signInFormErrors(g);
    setErrors(errs);
    setRefusal(null);
    if (Object.values(errs).some(Boolean)) {
      const first = (['address', 'username', 'password', 'entryId', 'name'] as const).find((k) => errs[k]);
      const field = first
        ? (document.getElementById(formId) as HTMLFormElement | null)?.elements.namedItem(first)
        : null;
      if (field instanceof HTMLElement) field.focus();
      return;
    }
    setBusy(true);
    try {
      const r = await start.mutateAsync({ params: { burrow }, body: installBody(g, control) });
      if (r.status === 'ok') onStarted(r.data);
      else setRefusal(commitOutcomeText(r, currentLocale()));
    } catch (err) {
      const info = hostErrorInfo(err, currentLocale());
      const fields: SignInErrors = {};
      for (const k of ['address', 'username', 'name'] as const)
        if (info.fields[k]) fields[k] = info.fields[k];
      if (info.fields['auth.password']) fields.password = info.fields['auth.password'];
      setErrors(fields);
      setRefusal(Object.keys(fields).length ? null : info.message);
    } finally {
      // The password lives in the form only until it is sent (SI-03): the mutation forgets its input too.
      start.reset();
      setBusy(false);
    }
  };

  const useKey = (
    <button type="button" className={s.inlineLink} onClick={() => set('method', 'vault')}>
      {SIGN_IN_COPY.useKey}
    </button>
  );
  return (
    <>
      <form
        id={formId}
        className={styles.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void submit();
        }}
      >
        <div className={s.pair}>
          <TextField
            name="address"
            label={SIGN_IN_COPY.address}
            mono
            value={f.address}
            placeholder={SIGN_IN_COPY.addressPlaceholder}
            inputMode="url"
            autoFocus={!prefill.address}
            error={errors.address}
            onChange={(e) => set('address', e.target.value)}
          />
          <TextField
            name="username"
            label={SIGN_IN_COPY.username}
            mono
            value={f.username}
            error={errors.username}
            onChange={(e) => set('username', e.target.value)}
          />
        </div>
        {f.method === 'password' ? (
          <div className={s.hinted}>
            <TextField
              name="password"
              label={SIGN_IN_COPY.password}
              type="password"
              value={f.password}
              autoFocus={!!prefill.address}
              error={errors.password}
              {...(errors.password ? {} : { 'aria-describedby': `${formId}-hint` })}
              onChange={(e) => set('password', e.target.value)}
            />
            <small id={`${formId}-hint`} className={s.hint}>
              {SIGN_IN_COPY.passwordHint} Or {useKey}.
            </small>
          </div>
        ) : (
          <>
            {keys.length || vault.isPending ? (
              <div className={s.hinted}>
                <SelectField
                  name="entryId"
                  label={SIGN_IN_COPY.key}
                  value={g.entryId}
                  options={
                    keys.length
                      ? keys.map((k) => ({ value: k.id, label: k.label }))
                      : [{ value: '', label: '…' }]
                  }
                  error={errors.entryId}
                  onChange={(e) => set('entryId', e.target.value)}
                />
                <small className={s.hint}>
                  <BackToPassword onClick={() => set('method', 'password')} />
                </small>
              </div>
            ) : (
              <p className={s.note}>
                {SIGN_IN_COPY.noKeys} <BackToPassword onClick={() => set('method', 'password')} />
              </p>
            )}
            <TextField
              label={SIGN_IN_COPY.sudoPassword}
              type="password"
              value={f.sudoPassword}
              onChange={(e) => set('sudoPassword', e.target.value)}
            />
          </>
        )}
        {prefill.name ? (
          <TextField
            name="name"
            label={SIGN_IN_COPY.name}
            mono
            value={f.name}
            error={errors.name}
            onChange={(e) => set('name', e.target.value)}
          />
        ) : null}
        <div className={s.keep}>
          <Check label={SIGN_IN_COPY.keepKey} checked={f.keepKey} onChange={(v) => set('keepKey', v)} />
          {f.keepKey ? (
            <SelectField
              label={SIGN_IN_COPY.keepKeyWhich}
              value={g.keepKeyEntry}
              options={[
                ...keys.map((k) => ({ value: k.id, label: k.label })),
                { value: NEW_KEY, label: SIGN_IN_COPY.newKey },
              ]}
              hint={g.keepKeyEntry === NEW_KEY || !g.keepKeyEntry ? SIGN_IN_COPY.newKeyHint : undefined}
              onChange={(e) => set('keepKeyEntry', e.target.value)}
            />
          ) : null}
        </div>
      </form>
      {refusal ? (
        <p className={styles.error} role="alert">
          {refusal}
        </p>
      ) : null}
      <div className={styles.dialogActions}>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="submit" form={formId} variant="primary" disabled={busy} aria-busy={busy || undefined}>
          {busy ? SIGN_IN_COPY.adding : SIGN_IN_COPY.add}
        </Button>
      </div>
    </>
  );
}

function BackToPassword({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={s.inlineLink} onClick={onClick}>
      {SIGN_IN_COPY.usePassword}
    </button>
  );
}

/* The job, step by step (SI-02, SI-04, SI-07, SI-08, SI-11) ------------------------------------------------------- */

function Progress({
  burrow,
  view,
  lost,
  onHide,
  onClose,
  onRetry,
  onCommand,
}: {
  burrow: string;
  view: HostInstall;
  /** The job can't be read any more (the box restarted): said instead of the steps' end. */
  lost: string | null;
  onHide: () => void;
  onClose: () => void;
  onRetry: () => void;
  /** Run a command instead (a server that can't reach the Whombat this way, connect-in-chat.md). */
  onCommand: () => void;
}) {
  const navigate = useNavigateHref();
  const fleet = useHostsFleet({ params: { burrow }, query: {} });
  const trust = useVaultWrite(api.vault.trustSshHostKey, burrow);
  const [trustProblem, setTrustProblem] = useState<string | null>(null);
  const names = (fleet.data?.servers ?? []).flatMap((x) => [x.id, x.name]);
  const steps = installSteps(view);
  const note = installHostKeyNote(view);
  const outcome = installOutcome(view, names);
  const failed = lost ? { text: lost, detail: null } : outcome?.kind === 'failed' ? outcome : null;
  const added = outcome && outcome.kind !== 'failed' ? outcome : null;
  // One plain card with the one step that helps (connect-in-chat.md); a lost job only says so.
  const card = !lost && outcome?.kind === 'failed' ? installFailureCard(view, outcome) : null;

  /** Trusts the key the server showed on every Vault server that trusted the old one, then back to the form. */
  async function trustNewKey() {
    const fingerprint = view.hostKey?.fingerprint;
    if (!fingerprint) return;
    setTrustProblem(null);
    try {
      for (const pin of view.pins ?? [])
        await trust.mutateAsync({ params: { burrow, ...pin }, body: { fingerprint } });
      onRetry();
    } catch {
      setTrustProblem(INSTALL_KEY_CHANGED_AGAIN);
    }
  }
  return (
    <>
      <ModalTitle className={styles.dialogTitle}>{installTitle(view)}</ModalTitle>
      <div className={s.progress} aria-live="polite">
        <ol className={s.steps} aria-label="Steps">
          {steps.map((step) => (
            <StepRow key={step.key} step={step} />
          ))}
        </ol>
        {note ? (
          <p className={s.keyNote}>
            {note.before}
            <code>{note.fingerprint}</code>
            {note.after}
          </p>
        ) : null}
        {added ? <p className={s.outcomeText}>{added.text}</p> : null}
        {card ? (
          <div className={s.failCard} role="alert" data-step={card.step}>
            <p className={s.outcomeText}>{card.title}</p>
            {card.text ? <p className={s.failText}>{card.text}</p> : null}
            {trustProblem ? <p className={s.failText}>{trustProblem}</p> : null}
          </div>
        ) : failed ? (
          <p className={s.outcomeText} role="alert">
            {failed.text}
          </p>
        ) : null}
        {failed?.detail ? <MoreDetail detail={failed.detail} /> : null}
      </div>
      <div className={styles.dialogActions}>
        {added ? (
          <>
            <Button onClick={onClose}>Done</Button>
            <Button variant="primary" onClick={() => navigate(serverHref(added.serverId))}>
              Open {added.serverName}
            </Button>
          </>
        ) : card ? (
          <>
            <Button onClick={onClose}>{card.step === 'trust' ? 'No' : 'Close'}</Button>
            <Button
              variant="primary"
              disabled={trust.isPending}
              onClick={() =>
                card.step === 'command' ? onCommand() : card.step === 'trust' ? void trustNewKey() : onRetry()
              }
            >
              {card.label}
            </Button>
          </>
        ) : failed ? (
          <>
            <Button onClick={onClose}>Close</Button>
            <Button variant="primary" onClick={onRetry}>
              Try again
            </Button>
          </>
        ) : (
          <Button onClick={onHide}>Hide</Button>
        )}
      </div>
    </>
  );
}

const STEP_WORDS: Record<InstallStep['state'], string> = {
  done: 'Done',
  active: 'Under way',
  todo: 'Still to come',
  failed: 'Stopped here',
  late: 'Not yet',
};

function StepRow({ step }: { step: InstallStep }) {
  let mark: ReactNode;
  if (step.state === 'done')
    mark = (
      <span className={cx(s.mark, s.markDone)}>
        <Icon icon={CheckIcon} size={13} strokeWidth={2.5} />
      </span>
    );
  else if (step.state === 'failed')
    mark = (
      <span className={cx(s.mark, s.markFailed)}>
        <Icon icon={X} size={13} strokeWidth={2.5} />
      </span>
    );
  else if (step.state === 'active') mark = <span className={cx(s.mark, s.spinner)} />;
  else mark = <span className={cx(s.mark, step.state === 'late' ? s.markLate : s.markTodo)} />;
  return (
    <li
      className={s.step}
      data-state={step.state}
      aria-current={step.state === 'active' ? 'step' : undefined}
    >
      <span className={s.markBox} role="img" aria-label={STEP_WORDS[step.state]}>
        {mark}
      </span>
      <span className={s.stepText}>
        <span className={s.stepLabel}>{step.label}</span>
        {step.sub ? <small className={s.stepSub}>{step.sub}</small> : null}
      </span>
    </li>
  );
}

function MoreDetail({ detail }: { detail: string }) {
  return (
    <details className={s.detail}>
      <summary>
        <Icon icon={ChevronRight} size={14} />
        More detail
      </summary>
      <pre className={styles.code}>{detail}</pre>
    </details>
  );
}

/* Run a command (SI-01, SI-06, SI-07) ----------------------------------------------------------------------------- */

function RunCommand({
  burrow,
  control,
  windows,
  commands,
  onMade,
  onClose,
}: {
  burrow: string;
  control: HostControlLevel;
  /** The Windows PC's PowerShell line of the same enrollment, with how to remove the agent again. */
  windows: boolean;
  /** The commands made so far in this dialog, per level: back to a level shows its command again. */
  commands: Partial<Record<HostControlLevel, HostEnrollment>>;
  onMade: (level: HostControlLevel, e: HostEnrollment) => void;
  onClose: () => void;
}) {
  const create = useHostsChange(api.hosts.createEnrollment);
  const navigate = useNavigateHref();
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(new Set<HostControlLevel>());
  const createRef = useRef(create.mutateAsync);
  createRef.current = create.mutateAsync;
  const onMadeRef = useRef(onMade);
  onMadeRef.current = onMade;
  const enrollment = commands[control];
  useEffect(() => {
    if (enrollment || asked.current.has(control)) return;
    asked.current.add(control);
    setError(null);
    createRef
      .current({ params: { burrow }, body: { control } })
      .then((r) => {
        if (r.status === 'ok') onMadeRef.current(control, r.data);
        else setError(commitOutcomeText(r, currentLocale()));
      })
      .catch((err: unknown) => {
        asked.current.delete(control);
        setError(hostErrorInfo(err, currentLocale()).message);
      });
  }, [burrow, control, enrollment]);
  // Pre-approved: once the command has run, the server is added; the list says which (its frame, else every 10 s).
  const all = useHostEnrollments(enrollment ? { params: { burrow }, query: { state: 'all' } } : null, {
    refetchInterval: 10_000,
  });
  const done = commandOutcome(enrollment?.id ?? null, all.data?.items ?? []);
  // A Whombat from before Windows PCs, or one without a Windows agent yet, makes no PowerShell line.
  const line = windows ? enrollment?.installCommandWindows : enrollment?.installCommand;
  return (
    <>
      <div className={s.command}>
        <p className={s.lead}>
          {windows ? (
            <>
              {WINDOWS_COPY.lead} {WINDOWS_COPY.how}
            </>
          ) : (
            COMMAND_COPY.lead
          )}
        </p>
        {enrollment && line ? (
          <>
            <code className={styles.code}>{line}</code>
            <div className={s.copyRow}>
              <CopyButton text={line} copied={COMMAND_COPY.copied} className={s.copy}>
                {COMMAND_COPY.copy}
              </CopyButton>
              <span className={s.valid}>{windows ? WINDOWS_COPY.valid : COMMAND_COPY.valid}</span>
            </div>
            {windows ? (
              <details className={s.detail}>
                <summary>
                  <Icon icon={ChevronRight} size={14} />
                  {WINDOWS_COPY.removeTitle}
                </summary>
                <div className={s.remove}>
                  <span className={s.valid}>{WINDOWS_COPY.remove}</span>
                  <code className={styles.code}>{HOST_WINDOWS_UNINSTALL_COMMAND}</code>
                  <div className={s.copyRow}>
                    <CopyButton
                      text={HOST_WINDOWS_UNINSTALL_COMMAND}
                      copied={COMMAND_COPY.copied}
                      className={s.copy}
                    >
                      {WINDOWS_COPY.copyRemove}
                    </CopyButton>
                  </div>
                </div>
              </details>
            ) : null}
          </>
        ) : enrollment ? (
          <p className={s.lead}>{WINDOWS_COPY.none}</p>
        ) : error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : (
          <div className={styles.code} aria-busy="true">
            {COMMAND_COPY.making}
          </div>
        )}
        <div aria-live="polite">{done ? <p className={s.outcomeText}>{done.text}</p> : null}</div>
      </div>
      <div className={styles.dialogActions}>
        {done ? (
          <>
            <Button onClick={onClose}>Done</Button>
            <Button variant="primary" onClick={() => navigate(serverHref(done.serverId))}>
              Open {done.serverId}
            </Button>
          </>
        ) : (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        )}
      </div>
    </>
  );
}

/* Waiting for you: servers an older command left for you (SI-07) --------------------------------------------- */

function WaitingForYou({ burrow, items }: { burrow: string; items: readonly HostPendingEnrollment[] }) {
  return (
    <section className={s.waiting} aria-labelledby="add-server-waiting">
      <h3 id="add-server-waiting" className={styles.lbl}>
        {COMMAND_COPY.waiting}
      </h3>
      <ul className={styles.rows} style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {items.map((e) => (
          <PendingRow key={e.id} burrow={burrow} enrollment={e} />
        ))}
      </ul>
    </section>
  );
}

function PendingRow({ burrow, enrollment: e }: { burrow: string; enrollment: HostPendingEnrollment }) {
  const { tag: uiLocale } = useWebI18n();
  const approve = useHostsChange(api.hosts.approveEnrollment);
  const reject = useHostsChange(api.hosts.rejectEnrollment);
  const { run, busy } = useChangeRunner();
  const [name, setName] = useState(e.hostname ?? '');
  const bad = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/.test(name.trim())
    ? null
    : 'Letters, digits, dots and dashes.';
  return (
    <li
      className={styles.row}
      style={{ paddingLeft: 0, paddingRight: 0, alignItems: 'flex-end', flexWrap: 'wrap' }}
    >
      <div className={styles.rowMain} style={{ minWidth: 200 }}>
        <TextField
          label={`${e.hostname ?? 'A server'} · ${[e.os, e.address].filter(Boolean).join(' · ')}`}
          mono
          value={name}
          error={bad}
          onChange={(ev) => setName(ev.target.value)}
        />
        <small className={styles.muted}>
          {e.requestedAt
            ? `Asked ${formatAgo((Date.now() - Date.parse(e.requestedAt)) / 1000, uiLocale)}`
            : ''}
        </small>
      </div>
      <span style={{ display: 'inline-flex', gap: 8, marginBottom: 22 }}>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void run(
              () => reject.mutateAsync({ params: { burrow, enrollmentId: e.id } }),
              `Turned ${e.hostname ?? 'it'} away.`,
            )
          }
        >
          Not this one
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={busy || !!bad}
          onClick={() =>
            void run(
              () =>
                approve.mutateAsync({ params: { burrow, enrollmentId: e.id }, body: { name: name.trim() } }),
              `Added ${name.trim()}. Its first report comes in a moment.`,
            )
          }
        >
          Add it
        </Button>
      </span>
    </li>
  );
}
