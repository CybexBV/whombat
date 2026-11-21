/**
 * Join a Wi-Fi network (Whombat hardware-support.md HD-05, HD-06, HD-11; hardware-support-web.md AP-3225, AP-3226): the
 * networks nearby as a list (bars, a lock for secured ones, “Connected”, “Saved”; company and WEP networks disabled with
 * the reason), **Other network…** for one that hides its name (name and security), then the network's form: its
 * password with Show/Hide where one is needed, and the guard's note. **Join** sends it (`host.wifi.join`), and the
 * dialog follows the change NETWORK's poller reads: Joining… → Joined (Done), back to the form with what went wrong
 * (“That password didn’t work.”), or that it went back to the previous network.
 */
import {
  NETWORK_TEXT,
  type NetworkApi,
  type NetworkChange,
  networkChangeRunning,
  networkChangeView,
  networkErrorText,
  type WifiRowView,
  wifiJoinInput,
  wifiNameProblem,
  wifiNeedsPassword,
  wifiPasswordProblem,
  wifiRows,
} from '@whombat/client';
import { ChevronRight, Lock } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StatusDot } from '../../components/StatusDot';
import styles from '../settings/SettingsScreen.module.css';
import tw from '../settings/ThisWhombat.module.css';
import m from './Machine.module.css';
import { SignalBars } from './NetworkSection';

const T = NETWORK_TEXT;
const D = T.dialog;

type Scan = { rows: WifiRowView[] } | { note: string } | null;
/** The network the form is for; `null` is Other network…. */
type Step = { at: 'list' } | { at: 'form'; network: WifiRowView | null } | { at: 'following'; id: string };
type Problem = { field: 'name' | 'password'; text: string } | null;

export function WifiDialog({
  open,
  onClose,
  api,
  name,
  change,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  api: NetworkApi;
  /** The Whombat's name in the words. */
  name: string;
  /** The change NETWORK shows (the poller's). */
  change: NetworkChange | null;
  onStarted: (change: NetworkChange) => void;
}) {
  const ids = useId();
  const [step, setStep] = useState<Step>({ at: 'list' });
  const [scan, setScan] = useState<Scan>(null);
  const [ssid, setSsid] = useState('');
  const [security, setSecurity] = useState<'psk' | 'open'>('psk');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [problem, setProblem] = useState<Problem>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const looking = useRef(0);
  /** The network the form was for, kept while the change runs (the form comes back on a refusal). */
  const formNetwork = useRef<WifiRowView | null>(null);

  const look = async () => {
    const mine = ++looking.current;
    setScan(null);
    try {
      const r = await api.scan();
      if (mine !== looking.current) return;
      setScan(
        r.scan
          ? { rows: wifiRows(r.scan) }
          : { note: r.reason === 'no_wifi' ? T.errors.no_wifi(name) : D.couldNotLook },
      );
    } catch {
      if (mine === looking.current) setScan({ note: D.couldNotLook });
    }
  };

  // Opening looks for networks; closing forgets everything typed (the password above all).
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening
  useEffect(() => {
    if (open) {
      void look();
      return;
    }
    looking.current += 1;
    setStep({ at: 'list' });
    setScan(null);
    setPassword('');
    setShowPassword(false);
    setSsid('');
    setSecurity('psk');
    setProblem(null);
    setNote(null);
    setBusy(false);
  }, [open]);

  // The change this dialog started: a refusal of the network (a wrong password, not found) goes back to the form.
  const followed = step.at === 'following' && change?.id === step.id ? change : null;
  useEffect(() => {
    if (followed?.phase !== 'failed') return;
    const network = followed.ssid;
    setStep((s) => (s.at === 'following' ? { at: 'form', network: formNetwork.current } : s));
    setPassword('');
    if (followed.failure === 'wrong_password')
      setProblem({ field: 'password', text: T.failures.wrong_password(network, name) });
    else setNote(networkChangeView(followed, name).meta);
  }, [followed, name]);

  const choose = (network: WifiRowView | null) => {
    formNetwork.current = network;
    setStep({ at: 'form', network });
    setSsid(network?.ssid ?? '');
    setSecurity(network?.security === 'open' ? 'open' : 'psk');
    setPassword('');
    setShowPassword(false);
    setProblem(null);
    setNote(null);
  };

  const form = step.at === 'form' ? step : null;
  const other = form !== null && form.network === null;
  const needsPassword = form ? (form.network ? wifiNeedsPassword(form.network) : security === 'psk') : false;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const p: Problem =
      other && wifiNameProblem(ssid)
        ? { field: 'name', text: wifiNameProblem(ssid) as string }
        : needsPassword && wifiPasswordProblem(password)
          ? { field: 'password', text: wifiPasswordProblem(password) as string }
          : null;
    setProblem(p);
    setNote(null);
    if (p) return;
    setBusy(true);
    try {
      const started = await api.join(
        wifiJoinInput({
          ssid: other ? ssid.trim() : (form.network?.ssid as string),
          security: other ? security : (form.network?.security ?? 'psk'),
          ...(needsPassword ? { password } : {}),
          hidden: other,
        }),
      );
      onStarted(started);
      setStep({ at: 'following', id: started.id });
    } catch (error) {
      setNote(networkErrorText(error, name));
    } finally {
      setBusy(false);
    }
  };

  const at = (field: NonNullable<Problem>['field']) => (problem?.field === field ? problem.text : null);
  const title = step.at === 'form' ? (form?.network ? form.network.ssid : D.otherTitle) : D.title;
  const lead = step.at === 'list' ? D.lead(name) : step.at === 'form' && other ? D.otherLead : D.guard(name);
  const following = step.at === 'following';
  const outcome = following ? (followed ?? null) : null;
  const running = outcome ? networkChangeRunning(outcome) : following;

  return (
    <Modal open={open} onOpenChange={(next) => (next ? null : onClose())} width="md">
      <form className={tw.dialog} onSubmit={(e) => void submit(e)} noValidate>
        <div className={tw.dialogHead}>
          <ModalTitle className={tw.dialogTitle}>{title}</ModalTitle>
          <ModalDescription className={tw.dialogLead}>{lead}</ModalDescription>
        </div>

        {step.at === 'list' ? (
          <>
            {scan && 'rows' in scan && scan.rows.length > 0 ? (
              <ul className={m.list} aria-label={D.nearby}>
                {scan.rows.map((row) => (
                  <li key={row.ssid}>
                    <NetworkButton row={row} onChoose={() => choose(row)} />
                  </li>
                ))}
                <li>
                  <button type="button" className={m.network} onClick={() => choose(null)}>
                    <span className={m.networkText}>
                      <span className={m.networkName}>{D.other}</span>
                    </span>
                    <span className={m.endIcon} aria-hidden="true">
                      <Icon icon={ChevronRight} size={16} />
                    </span>
                  </button>
                </li>
              </ul>
            ) : (
              <p className={m.listNote} role="status">
                {scan === null ? D.looking : 'note' in scan ? scan.note : D.none}
              </p>
            )}
            <div className={m.listFoot}>
              <Button variant="link" disabled={scan === null} onClick={() => void look()}>
                {D.again}
              </Button>
              {scan && !('rows' in scan && scan.rows.length > 0) ? (
                <Button variant="link" onClick={() => choose(null)}>
                  {D.other}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}

        {form ? (
          <div className={m.fields}>
            {other ? (
              <>
                <Field id={`${ids}-name`} label={D.name} problem={at('name')}>
                  {(describedBy) => (
                    <Input
                      id={`${ids}-name`}
                      value={ssid}
                      autoComplete="off"
                      spellCheck={false}
                      invalid={at('name') !== null}
                      aria-describedby={describedBy}
                      onChange={(e) => setSsid(e.target.value)}
                    />
                  )}
                </Field>
                <div className={m.field}>
                  <span className={m.label} id={`${ids}-security`}>
                    {D.security}
                  </span>
                  <SegmentedControl
                    label={D.security}
                    className={m.security}
                    options={(['psk', 'open'] as const).map((s) => ({ value: s, label: D.securities[s] }))}
                    value={security}
                    onChange={setSecurity}
                  />
                </div>
              </>
            ) : null}
            {needsPassword ? (
              <Field id={`${ids}-password`} label={D.password} problem={at('password')}>
                {(describedBy) => (
                  <span className={m.password}>
                    <Input
                      id={`${ids}-password`}
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      invalid={at('password') !== null}
                      aria-describedby={describedBy}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <Button
                      variant="secondary"
                      aria-controls={`${ids}-password`}
                      aria-pressed={showPassword}
                      onClick={() => setShowPassword((s) => !s)}
                    >
                      {showPassword ? D.hide : D.show}
                    </Button>
                  </span>
                )}
              </Field>
            ) : form.network?.saved ? (
              <p className={m.hint}>{D.savedNote}</p>
            ) : null}
            {other ? <p className={m.hint}>{D.guard(name)}</p> : null}
          </div>
        ) : null}

        {following ? (
          <div className={m.outcome} role="status" data-outcome={outcome?.phase ?? 'applying'}>
            {(() => {
              const v = outcome ? networkChangeView(outcome, name) : null;
              return (
                <>
                  <StatusDot
                    tone={v?.dot ?? 'mut'}
                    size={8}
                    label={null}
                    className={running ? m.running : undefined}
                  />
                  <span className={styles.rowMain}>
                    <span className={styles.rowTitle}>{v?.title ?? D.joining}</span>
                    {v?.meta ? <span className={styles.rowMeta}>{v.meta}</span> : null}
                  </span>
                </>
              );
            })()}
          </div>
        ) : null}

        {note ? (
          <span className={tw.dialogNote} role="status">
            {note}
          </span>
        ) : null}

        <div className={tw.dialogActions}>
          {step.at === 'list' ? (
            <ModalClose asChild>
              <Button variant="secondary" size="lg">
                {D.cancel}
              </Button>
            </ModalClose>
          ) : step.at === 'form' ? (
            <>
              <Button variant="secondary" size="lg" disabled={busy} onClick={() => setStep({ at: 'list' })}>
                {D.back}
              </Button>
              <Button variant="primary" size="lg" type="submit" disabled={busy}>
                {busy ? D.joining : D.join}
              </Button>
            </>
          ) : (
            <ModalClose asChild>
              <Button variant={running ? 'secondary' : 'primary'} size="lg">
                {running ? D.close : D.done}
              </Button>
            </ModalClose>
          )}
        </div>
      </form>
    </Modal>
  );
}

/** One network in the list: bars, its name and state, a lock when secured; disabled when it can't be joined. */
function NetworkButton({ row, onChoose }: { row: WifiRowView; onChoose: () => void }) {
  return (
    <button
      type="button"
      className={m.network}
      disabled={!row.joinable || row.connected}
      aria-label={row.label}
      data-ssid={row.ssid}
      data-joinable={row.joinable}
      onClick={onChoose}
    >
      <SignalBars signal={row.signal} />
      <span className={m.networkText}>
        <span className={m.networkName}>{row.ssid}</span>
        {row.meta ? <span className={m.networkMeta}>{row.meta}</span> : null}
      </span>
      {row.secured ? (
        <span className={m.endIcon} aria-hidden="true">
          <Icon icon={Lock} size={14} />
        </span>
      ) : null}
    </button>
  );
}

/** A labelled field with its problem under it (the problem names the input through `aria-describedby`). */
function Field({
  id,
  label,
  problem,
  children,
}: {
  id: string;
  label: string;
  problem: string | null;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  return (
    <div className={m.field}>
      <label className={m.label} htmlFor={id}>
        {label}
      </label>
      {children(problem ? `${id}-problem` : undefined)}
      {problem ? (
        <span className={m.problem} id={`${id}-problem`} role="alert">
          {problem}
        </span>
      ) : null}
    </div>
  );
}
