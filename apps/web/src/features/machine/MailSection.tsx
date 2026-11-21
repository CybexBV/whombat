/**
 * Settings → This Whombat → Overview → EMAIL (Whombat hermes-engine.md HE-61; contracts CT-1308; hermes-engine-app.md
 * AP-5427), after TAILSCALE, on a community box: the box sends email through the person's own mail server, optional. One row — Off with **Set up**; the from name and address, server, port and security, with the last test, and
 * **Send a test** (to your own email), **Change**, **Remove** (asked once). The form (server, port, security, user
 * name, password — never shown again, from address and name) can send a test before it saves. A server from the box's
 * configuration is read-only. Every word is the client's `MAIL_TEXT`; `mailView` decides the row, `mailDraft` the form.
 */
import {
  type HostMailOutput,
  MAIL_TEXT,
  type MailAction,
  type MailApi,
  type MailForm,
  type MailSecurity,
  mailApi,
  mailDraft,
  mailErrorText,
  mailForm,
  mailPortFor,
  mailTestText,
  mailView,
} from '@whombat/client';
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StatusDot } from '../../components/StatusDot';
import styles from '../settings/SettingsScreen.module.css';
import tw from '../settings/ThisWhombat.module.css';
import m from './Machine.module.css';

const T = MAIL_TEXT;

/** EMAIL on a community box's session; `email` is the person's own, where tests go. */
export function MailSection({ email }: { email: string }) {
  const { session } = useAppServices();
  const api = useMemo(() => mailApi(session), [session]);
  const [answer, setAnswer] = useState<HostMailOutput | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const id = useId();

  const read = useCallback(() => {
    api.get().then(setAnswer, () => setAnswer(null));
  }, [api]);
  useEffect(read, [read]);
  const v = mailView(answer);

  const run = async (work: (a: MailApi) => Promise<string | null>) => {
    setBusy(true);
    setNote(null);
    try {
      setNote(await work(api));
      return true;
    } catch (error) {
      setNote(mailErrorText(error));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const act = (action: MailAction) => {
    if (action === 'set_up' || action === 'change') setEditing(true);
    else if (action === 'remove') setRemoving(true);
    // A test of the stored settings is kept as their last test: the row says it, with where it went.
    else
      void run(async (a) => {
        await a.test();
        read();
        return null;
      });
  };

  if (!v) return null;
  return (
    <section className={styles.section} aria-labelledby={id} data-mail="">
      <SectionLabel as="h2" id={id}>
        {T.section}
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row} data-row="mail">
          <StatusDot tone={v.dot} size={8} label={null} />
          <span className={styles.rowMain}>
            <span className={styles.rowTitle}>{v.title}</span>
            <span className={styles.rowMeta}>{v.meta}</span>
            {v.test ? <span className={styles.rowMeta}>{v.test}</span> : null}
            {note ? (
              <span className={styles.rowMeta} role="status">
                {note}
              </span>
            ) : null}
          </span>
          {v.actions.map((action, i) => (
            <Button
              key={action}
              variant={i === 0 && action === 'set_up' ? 'primary' : 'secondary'}
              size="sm"
              disabled={busy}
              onClick={() => act(action)}
            >
              {action === 'set_up'
                ? T.setUp
                : action === 'test'
                  ? busy
                    ? T.testing
                    : T.test
                  : action === 'change'
                    ? T.change
                    : T.remove}
            </Button>
          ))}
        </div>
      </div>
      {editing ? (
        <MailDialog
          api={api}
          initial={mailForm(answer?.mail ?? null, email)}
          hasPassword={answer?.mail?.hasPassword === true}
          onClose={() => setEditing(false)}
          onSaved={(next) => {
            setAnswer(next);
            setEditing(false);
            setNote(T.saved);
          }}
        />
      ) : null}
      <Modal open={removing} onOpenChange={(next) => setRemoving(next)} width="md">
        <div className={tw.dialog}>
          <div className={tw.dialogHead}>
            <ModalTitle className={tw.dialogTitle}>{T.removeTitle}</ModalTitle>
            <ModalDescription className={tw.dialogLead}>{T.removeLead}</ModalDescription>
          </div>
          <div className={tw.dialogActions}>
            <ModalClose asChild>
              <Button variant="secondary" size="lg">
                {T.cancel}
              </Button>
            </ModalClose>
            <Button
              variant="primary"
              size="lg"
              disabled={busy}
              onClick={() =>
                void run(async (a) => {
                  setAnswer(await a.remove());
                  return T.removed;
                }).then(() => setRemoving(false))
              }
            >
              {T.remove}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}

const SECURITIES: readonly MailSecurity[] = ['starttls', 'tls', 'none'];

/** Set up or change the mail server: the form, a test of what's typed, Save (AP-5427). */
function MailDialog({
  api,
  initial,
  hasPassword,
  onClose,
  onSaved,
}: {
  api: MailApi;
  initial: MailForm;
  hasPassword: boolean;
  onClose: () => void;
  onSaved: (answer: HostMailOutput) => void;
}) {
  const [form, setForm] = useState(initial);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const ids = useId();
  const draft = mailDraft(form, hasPassword);
  const problem = tried && !draft.ok ? draft.problem : null;
  const set = (patch: Partial<MailForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setNote(null);
  };
  const go = async (what: 'test' | 'save') => {
    setTried(true);
    if (!draft.ok) return;
    setBusy(what);
    setNote(null);
    try {
      if (what === 'test') {
        const { test } = await api.test(draft.input);
        setNote(mailTestText(test));
      } else onSaved(await api.set(draft.input));
    } catch (error) {
      setNote(mailErrorText(error));
    } finally {
      setBusy(null);
    }
  };
  const at = (p: keyof typeof T.problems) => (problem === p ? T.problems[p] : null);
  return (
    <Modal open onOpenChange={(next) => (next ? null : onClose())} width="md">
      <form
        className={tw.dialog}
        noValidate
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void go('save');
        }}
      >
        <div className={tw.dialogHead}>
          <ModalTitle className={tw.dialogTitle}>{T.formTitle}</ModalTitle>
          <ModalDescription className={tw.dialogLead}>{T.formLead}</ModalDescription>
        </div>
        <div className={m.fields}>
          <div className={m.pair}>
            <Field id={`${ids}-host`} label={T.host} problem={at('host')} grow>
              {(d) => (
                <Input
                  id={`${ids}-host`}
                  value={form.host}
                  placeholder={T.hostPlaceholder}
                  autoComplete="off"
                  spellCheck={false}
                  invalid={at('host') !== null}
                  aria-describedby={d}
                  onChange={(e) => set({ host: e.target.value })}
                />
              )}
            </Field>
            <Field id={`${ids}-port`} label={T.port} problem={at('port')}>
              {(d) => (
                <Input
                  id={`${ids}-port`}
                  className={m.port}
                  value={form.port}
                  inputMode="numeric"
                  invalid={at('port') !== null}
                  aria-describedby={d}
                  onChange={(e) => set({ port: e.target.value.replace(/\D/g, '').slice(0, 5) })}
                />
              )}
            </Field>
          </div>
          <div className={m.field}>
            <span className={m.label} id={`${ids}-security`}>
              {T.securityLabel}
            </span>
            <SegmentedControl
              label={T.securityLabel}
              className={m.security}
              options={SECURITIES.map((s) => ({ value: s, label: T.security[s] }))}
              value={form.security}
              onChange={(security) => set({ security, port: mailPortFor(security, form.port) })}
            />
            {at('login_without_tls') ? (
              <span className={m.problem} role="alert">
                {T.problems.login_without_tls}
              </span>
            ) : null}
          </div>
          <Field id={`${ids}-user`} label={T.username} problem={null} hint={T.usernameHint}>
            {(d) => (
              <Input
                id={`${ids}-user`}
                value={form.username}
                autoComplete="off"
                spellCheck={false}
                aria-describedby={d}
                onChange={(e) => set({ username: e.target.value })}
              />
            )}
          </Field>
          {form.username.trim() ? (
            <Field
              id={`${ids}-password`}
              label={T.password}
              problem={at('password')}
              hint={hasPassword ? T.passwordKept : T.passwordHint}
            >
              {(d) => (
                <Input
                  id={`${ids}-password`}
                  type="password"
                  value={form.password}
                  autoComplete="new-password"
                  invalid={at('password') !== null}
                  aria-describedby={d}
                  onChange={(e) => set({ password: e.target.value })}
                />
              )}
            </Field>
          ) : null}
          <div className={m.pair}>
            <Field id={`${ids}-from`} label={T.from} problem={at('from')} grow>
              {(d) => (
                <Input
                  id={`${ids}-from`}
                  type="email"
                  value={form.from}
                  autoComplete="off"
                  invalid={at('from') !== null}
                  aria-describedby={d}
                  onChange={(e) => set({ from: e.target.value })}
                />
              )}
            </Field>
            <Field id={`${ids}-from-name`} label={T.fromName} problem={at('fromName')} grow>
              {(d) => (
                <Input
                  id={`${ids}-from-name`}
                  value={form.fromName}
                  placeholder={T.fromNamePlaceholder}
                  autoComplete="off"
                  invalid={at('fromName') !== null}
                  aria-describedby={d}
                  onChange={(e) => set({ fromName: e.target.value })}
                />
              )}
            </Field>
          </div>
        </div>
        {note ? (
          <span className={tw.dialogNote} role="status">
            {note}
          </span>
        ) : null}
        <div className={tw.dialogActions}>
          <Button variant="secondary" size="lg" disabled={busy !== null} onClick={() => void go('test')}>
            {busy === 'test' ? T.testing : T.test}
          </Button>
          <span className={m.grow} />
          <ModalClose asChild>
            <Button variant="secondary" size="lg">
              {T.cancel}
            </Button>
          </ModalClose>
          <Button variant="primary" size="lg" type="submit" disabled={busy !== null}>
            {busy === 'save' ? T.saving : T.save}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Field({
  id,
  label,
  problem,
  hint,
  grow,
  children,
}: {
  id: string;
  label: string;
  problem: string | null;
  hint?: string;
  grow?: boolean;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const describedBy = problem || hint ? `${id}-note` : undefined;
  return (
    <div className={grow ? `${m.field} ${m.grow}` : m.field}>
      <label className={m.label} htmlFor={id}>
        {label}
      </label>
      {children(describedBy)}
      {problem ? (
        <span className={m.problem} id={`${id}-note`} role="alert">
          {problem}
        </span>
      ) : hint ? (
        <span className={m.hint} id={`${id}-note`}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}
