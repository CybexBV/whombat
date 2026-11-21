/**
 * Settings → This Whombat → Overview → TAILSCALE (Whombat hermes-engine.md HE-51; contracts CT-1253, CT-1254;
 * hermes-engine-app.md AP-5305, AP-5326), after NETWORK: what Tailscale is and that it reaches this Whombat from
 * anywhere. One row — Off with a quiet **Turn on**; Sign in to Tailscale with **Sign in** (Tailscale's own page, a new
 * tab) and asked again every 2 s until it is on; On, its name in its tailnet beneath, with **Turn off** (asked once). A
 * box without Tailscale (development) shows
 * nothing. Every word is the client's `TAILSCALE_TEXT`; `tailscaleView` decides the row. On a community box there is
 * also its **Login server** — Tailscale's own, or Headscale or their company's — with
 * **Change** (contracts CT-1306; hermes-engine-app.md AP-5426): moving to another server signs the box out of its
 * tailnet first, so the dialog says so before it saves.
 */
import {
  type HostTailscaleOutput,
  readLoginServer,
  TAILSCALE_TEXT,
  type TailscaleAction,
  type TailscaleApi,
  tailscaleAnswer,
  tailscaleApi,
  tailscaleErrorText,
  tailscaleView,
} from '@whombat/client';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useAppServices, useCommunity } from '../../app/providers';
import { Button, ButtonLink } from '../../components/Button';
import { Input } from '../../components/Input';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { StatusDot } from '../../components/StatusDot';
import styles from '../settings/SettingsScreen.module.css';
import tw from '../settings/ThisWhombat.module.css';
import m from './Machine.module.css';

const T = TAILSCALE_TEXT;

/** TAILSCALE, on a box's session; nothing in fixture mode without a box. */
export function TailscaleSection() {
  const { session } = useAppServices();
  const api = useMemo(() => tailscaleApi(session), [session]);
  const [answer, setAnswer] = useState<HostTailscaleOutput | null>(null);
  const [asked, setAsked] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [changing, setChanging] = useState(false);
  const community = useCommunity();
  const id = useId();

  const read = useCallback(() => {
    api.state().then(setAnswer, () => setAnswer({ tailscale: null, reason: 'unavailable' }));
  }, [api]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` asks again.
  useEffect(read, [read, asked]);
  const v = tailscaleView(answer);
  // While it starts, waits for a sign-in or for the tailnet's approval, it is asked again (TAILSCALE_POLL_MS).
  // biome-ignore lint/correctness/useExhaustiveDependencies: each answer asks again after its own wait.
  useEffect(() => {
    if (!v.pollMs) return;
    const t = setTimeout(() => setAsked((n) => n + 1), v.pollMs);
    return () => clearTimeout(t);
  }, [v.pollMs, answer]);

  const change = async (run: (a: TailscaleApi) => ReturnType<TailscaleApi['on']>) => {
    setBusy(true);
    setNote(null);
    try {
      setAnswer(tailscaleAnswer(await run(api)));
      return true;
    } catch (error) {
      setNote(tailscaleErrorText(error));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const act = (action: TailscaleAction) => {
    if (action === 'turn_on') void change((a) => a.on());
    else if (action === 'new_link') void change((a) => a.signIn());
    else if (action === 'turn_off') setConfirmOff(true);
    else if (action === 'try_again') setAsked((n) => n + 1);
  };

  if (!answer || v.hidden) return null;
  return (
    <section className={styles.section} aria-labelledby={id} id="tailscale" data-tailscale="">
      <SectionLabel as="h2" id={id}>
        {T.section}
      </SectionLabel>
      <div className={styles.card}>
        <div className={styles.row} data-row="tailscale">
          <StatusDot tone={v.dot} size={8} label={null} />
          <span className={styles.rowMain}>
            <span className={styles.rowTitle} role="status">
              {v.title}
            </span>
            <span className={styles.rowMeta}>{v.meta}</span>
            {note ? (
              <span className={styles.rowMeta} role="status">
                {note}
              </span>
            ) : null}
          </span>
          {v.actions.map((action, i) =>
            action === 'sign_in' && v.loginUrl ? (
              // Tailscale's own page: the box joins the tailnet of whoever signs in there (HE-51).
              <ButtonLink
                key={action}
                variant="primary"
                size="sm"
                href={v.loginUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {T.openSignIn}
              </ButtonLink>
            ) : (
              <Button
                key={action}
                // Off is a choice, not a problem: its Turn on stays quiet beside NEEDS YOU's one dark button. A
                // sign-in under way or a Tailscale that stopped working leads with its step.
                variant={i === 0 && action !== 'turn_off' && v.dot !== 'mut' ? 'primary' : 'secondary'}
                size="sm"
                disabled={busy}
                onClick={() => act(action)}
              >
                {label(action)}
              </Button>
            ),
          )}
        </div>
        {community ? (
          <div className={styles.row} data-row="login-server">
            <StatusDot tone="mut" size={8} label={null} />
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{T.loginServer}</span>
              <span className={styles.rowMeta}>
                {v.loginServer ? T.loginServerMeta(v.loginServer) : T.loginServerOwnMeta}
              </span>
            </span>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => setChanging(true)}>
              {T.change}
            </Button>
          </div>
        ) : null}
      </div>
      {changing ? (
        <LoginServerDialog
          current={v.loginServer}
          onClose={() => setChanging(false)}
          onSave={async (server) => {
            if (await change((a) => a.on(server))) setChanging(false);
          }}
          busy={busy}
          note={note}
        />
      ) : null}
      <Modal open={confirmOff} onOpenChange={(next) => setConfirmOff(next)} width="md">
        <div className={tw.dialog}>
          <div className={tw.dialogHead}>
            <ModalTitle className={tw.dialogTitle}>{T.offConfirmTitle}</ModalTitle>
            <ModalDescription className={tw.dialogLead}>{T.offConfirm}</ModalDescription>
          </div>
          <div className={tw.dialogActions}>
            <ModalClose asChild>
              <Button variant="secondary" size="lg">
                Cancel
              </Button>
            </ModalClose>
            <Button
              variant="primary"
              size="lg"
              disabled={busy}
              onClick={() => {
                void change((a) => a.off()).then(() => setConfirmOff(false));
              }}
            >
              {T.turnOff}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}

function label(action: TailscaleAction): string {
  switch (action) {
    case 'turn_on':
      return T.turnOn;
    case 'sign_in':
      return T.openSignIn;
    case 'new_link':
      return T.newLink;
    case 'turn_off':
      return T.turnOff;
    case 'try_again':
      return T.tryAgain;
  }
}

/**
 * Change the login server (AP-5426): the address (empty for Tailscale's own), what's wrong with it as it's typed, that
 * plain http:// is fine on your own network, and — when it differs from the current one — that the box leaves its
 * tailnet and signs in again there. Save and sign in turns Tailscale on with it (`host.tailscale.on {loginServer}`).
 */
function LoginServerDialog({
  current,
  onClose,
  onSave,
  busy,
  note,
}: {
  current: string | null;
  onClose: () => void;
  onSave: (server: string | null) => Promise<void>;
  busy: boolean;
  note: string | null;
}) {
  const [text, setText] = useState(current ?? '');
  const [tried, setTried] = useState(false);
  const typed = readLoginServer(text);
  const moves = typed.ok && typed.value !== current;
  const id = useId();
  return (
    <Modal open onOpenChange={(next) => (next ? null : onClose())} width="md">
      <form
        className={tw.dialog}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (typed.ok && moves) void onSave(typed.value);
        }}
      >
        <div className={tw.dialogHead}>
          <ModalTitle className={tw.dialogTitle}>{T.changeTitle}</ModalTitle>
          <ModalDescription className={tw.dialogLead}>{T.changeLead}</ModalDescription>
        </div>
        <div className={m.fields}>
          <div className={m.field}>
            <label className={m.label} htmlFor={id}>
              {T.field}
            </label>
            <Input
              id={id}
              value={text}
              placeholder="https://headscale.example.com"
              autoComplete="url"
              spellCheck={false}
              invalid={tried && !typed.ok}
              aria-describedby={`${id}-hint`}
              onChange={(e) => setText(e.target.value)}
            />
            {!typed.ok && (tried || text.length > 8) ? (
              <span className={m.problem} id={`${id}-hint`} role="alert">
                {typed.problem}
              </span>
            ) : (
              <span className={m.hint} id={`${id}-hint`}>
                {typed.ok && typed.plainHttp ? T.plainHttp : T.fieldHint}
              </span>
            )}
          </div>
          {moves ? <p className={m.hint}>{T.moves}</p> : null}
        </div>
        {note ? (
          <span className={tw.dialogNote} role="status">
            {note}
          </span>
        ) : null}
        <div className={tw.dialogActions}>
          <ModalClose asChild>
            <Button variant="secondary" size="lg">
              Cancel
            </Button>
          </ModalClose>
          <Button variant="primary" size="lg" type="submit" disabled={busy || !moves}>
            {T.save}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
