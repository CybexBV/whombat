/**
 * A Mac's Screen tab (Whombat macos-servers.md MAC-04…MAC-08; MAC-31…MAC-33): the screen itself — Open the screen opens
 * it live over the page (the host's `vnc` console, `?console=screen`) — with Screen Sharing (how to switch it on when it
 * is off), the lock with Unlock the screen, and who is at the screen; the Mac's password Whombat signs in with (Set,
 * Check, Forget), typed in a form that never keeps it; and Whombat Helper with its Accessibility, “Open the setting on the
 * Mac” when it is off. Every step needs the server's host-shell switch on (the screen goes with it).
 */
import { MAC_WORDS, type MacLine, macAccountProblem, macScreenView } from '@whombat/client/hosts';
import { useHostScreenStep } from '@whombat/client/hosts/react';
import { Monitor } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { Modal, ModalTitle } from '../../../components/Modal';
import { useToast } from '../../../components/Toast';
import { TextField } from '../manage/fields';
import { Card, ConfirmDialog, StateCell } from '../parts';
import { useThingSearch } from '../search';
import styles from '../Things.module.css';
import type { TabProps } from '../tabs/tabProps';
import mac from './Mac.module.css';

export function MacScreenTab({ burrow, serverId, detail }: TabProps) {
  const [, set] = useThingSearch();
  const toast = useToast();
  const name = detail.server.name ?? serverId;
  // The person may change their servers (Whombat is one person's); the server's switches decide the rest.
  const view = macScreenView(detail, { name, owner: true, now: Date.parse(detail.asOf) });
  const { step, busy } = useHostScreenStep(burrow, serverId, name);
  const [asking, setAsking] = useState<'password' | 'forget' | null>(null);
  if (!view) return null;

  /** A step whose words are a toast. */
  const run = async (body: Parameters<typeof step>[0]) => {
    const out = await step(body);
    if (out.text) toast.show(out.text);
    return out;
  };
  const openScreen = () => set({ console: 'screen' });

  return (
    <>
      <Card id="mac-screen" title={MAC_WORDS.screenTitle}>
        <div className={styles.rows}>
          <div className={styles.row}>
            <div className={styles.rowMain}>
              <b>See and use {name}’s screen</b>
              <small>
                {view.screen.can ? 'It opens here, live, as if you sat at the Mac.' : view.screen.why}
              </small>
            </div>
            <span className={mac.end}>
              <Button
                variant="primary"
                iconStart={<Icon icon={Monitor} size={15} />}
                disabled={!view.screen.can}
                onClick={openScreen}
              >
                {MAC_WORDS.openScreen}
              </Button>
            </span>
          </div>
          {view.lines.map((l) => (
            <Line key={l.key} line={l}>
              {l.key === 'lock' && view.maybeLocked && view.unlock.can ? (
                <Button
                  size="sm"
                  disabled={busy !== null}
                  aria-busy={busy === 'unlock' || undefined}
                  onClick={() => void run({ op: 'unlock' })}
                >
                  {MAC_WORDS.unlock}
                </Button>
              ) : null}
            </Line>
          ))}
        </div>
        {view.sharingHow ? <p className={styles.cardNote}>{view.sharingHow}</p> : null}
        {view.fileVaultNote ? <p className={styles.cardNote}>{view.fileVaultNote}</p> : null}
      </Card>

      <div className={mac.split}>
        <Card id="mac-password" title={MAC_WORDS.passwordTitle}>
          <div className={styles.rows}>
            <Line line={{ ...view.account, title: 'Screen sign-in' }}>
              {view.password.can ? (
                <>
                  {view.hasAccount ? (
                    <>
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        aria-busy={busy === 'account.check' || undefined}
                        onClick={() => void run({ op: 'account.check' })}
                      >
                        {MAC_WORDS.check}
                      </Button>
                      <Button size="sm" disabled={busy !== null} onClick={() => setAsking('forget')}>
                        {MAC_WORDS.forget}
                      </Button>
                    </>
                  ) : null}
                  <Button
                    size="sm"
                    variant={view.account.tone === 'ok' ? 'secondary' : 'primary'}
                    disabled={busy !== null}
                    onClick={() => setAsking('password')}
                  >
                    {view.hasAccount ? 'Change it' : MAC_WORDS.setPassword}
                  </Button>
                </>
              ) : null}
            </Line>
          </div>
          <p className={styles.cardNote}>{view.password.can ? MAC_WORDS.passwordHint : view.password.why}</p>
        </Card>

        <Card id="mac-helper" title={MAC_WORDS.helperTitle}>
          <div className={styles.rows}>
            {view.helper.map((l) => (
              <Line key={l.key} line={l}>
                {l.key === 'access' && view.needsAccess && view.helperStep.can ? (
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    aria-busy={busy === 'ui.open' || undefined}
                    onClick={() => void run({ op: 'ui.open', target: 'accessibility' })}
                  >
                    {MAC_WORDS.openSetting}
                  </Button>
                ) : null}
              </Line>
            ))}
          </div>
          {view.helperNote ? <p className={styles.cardNote}>{view.helperNote}</p> : null}
        </Card>
      </div>

      {/* Mounted only while open: it starts empty every time. */}
      {asking === 'password' ? (
        <PasswordDialog
          name={name}
          user={view.accountUser}
          busy={busy === 'account.set'}
          onSave={async (user, password) => {
            const out = await step({ op: 'account.set', account: { user, password } });
            if (out.ok) {
              toast.show(out.text);
              setAsking(null);
            }
            return out.ok ? null : out.text;
          }}
          onClose={() => setAsking(null)}
        />
      ) : null}
      <ConfirmDialog
        open={asking === 'forget'}
        title={MAC_WORDS.forgetTitle(name)}
        body={MAC_WORDS.forgetBody(name)}
        confirm={MAC_WORDS.forgetConfirm}
        serious
        busy={busy === 'account.clear'}
        onConfirm={() =>
          void run({ op: 'account.clear' }).then((out) => {
            if (out.ok) setAsking(null);
          })
        }
        onClose={() => setAsking(null)}
      />
    </>
  );
}

function Line({ line, children }: { line: MacLine; children?: ReactNode }) {
  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <b>{line.title}</b>
        <small>
          <StateCell tone={line.tone} text={line.text} />
        </small>
      </div>
      {children ? <span className={mac.end}>{children}</span> : null}
    </div>
  );
}

/**
 * Set the Mac's password: the user and the password, sent once to the Mac (`account.set`), which keeps it only if it
 * signs in with it. The password lives in this form only while it is open and is cleared once sent.
 */
function PasswordDialog({
  name,
  user: initialUser,
  busy,
  onSave,
  onClose,
}: {
  name: string;
  user: string;
  busy: boolean;
  /** Resolves to the problem to show, or null when it was saved. */
  onSave: (user: string, password: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const id = useId();
  const [user, setUser] = useState(initialUser);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const close = () => {
    setPassword('');
    setProblem(null);
    onClose();
  };
  const submit = async () => {
    const u = user.trim();
    const wrong = macAccountProblem(u, password);
    if (wrong) return setProblem(wrong);
    const typed = password;
    // The form doesn't keep it once it is on its way (nor does the step: `useHostScreenStep`).
    setPassword('');
    setProblem(null);
    const out = await onSave(u, typed);
    if (out) setProblem(out);
    else setUser(u);
  };
  return (
    <Modal open onOpenChange={(o) => !o && !busy && close()}>
      <ModalTitle className={styles.dialogTitle}>{MAC_WORDS.setPassword}</ModalTitle>
      <p className={styles.dialogBody}>
        The password of a user who may sign in at {name}. Whombat keeps it on the Mac only, to open and unlock
        its screen.
      </p>
      <form
        id={id}
        className={mac.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) void submit();
        }}
      >
        <TextField
          name="mac-user"
          label={MAC_WORDS.user}
          mono
          value={user}
          onChange={(e) => setUser(e.target.value)}
        />
        <TextField
          name="mac-password"
          label={MAC_WORDS.password}
          type="password"
          autoComplete="off"
          autoFocus
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setProblem(null);
          }}
        />
      </form>
      {problem ? (
        <p className={styles.error} role="alert">
          {problem}
        </p>
      ) : null}
      <div className={styles.dialogActions}>
        <Button variant="secondary" onClick={close} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" form={id} disabled={busy} aria-busy={busy || undefined}>
          {MAC_WORDS.save}
        </Button>
      </div>
    </Modal>
  );
}
