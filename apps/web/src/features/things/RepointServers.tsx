/**
 * Point them here (Whombat backup-file.md BF-15, BF-16; contracts 0.117 CT-910…CT-914; app backup-file.md AP-4415…):
 * the dialog BF-16's Needs you item opens (`/things/servers?repoint=1`, which goes to Connections). It says the address
 * changed and which servers haven't found it, and Point them here signs in to each with your Vault key and
 * points its agent here; then each server's way there, step-row style as Add a server's job: Pointed here, or Needs a
 * password / Didn't work with “Point it here”, which opens Add a server filled in with its address. Leave them changes
 * nothing. On a Whombat without `hosts.repoint` it says it needs an update. The state and every word come from
 * `@whombat/client/hosts` (`useRepointServers`, `repointView`).
 */
import { REPOINT_TEXT, type RepointRow } from '@whombat/client/hosts';
import { useRepointServers } from '@whombat/client/hosts/react';
import { hostRepointWords } from '@whombat/core/domain';
import { Check as CheckIcon, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { Modal, ModalDescription, ModalTitle } from '../../components/Modal';
import { useLocaleWords } from '../../i18n/words';
import s from './AddServer.module.css';
import styles from './Things.module.css';

export function RepointServersDialog({
  burrow,
  onClose,
  onAddServer,
}: {
  burrow: string;
  onClose: () => void;
  /** “Point it here”: Add a server, filled in with the server's address. */
  onAddServer: (address: string) => void;
}) {
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} width="md">
      <Repoint burrow={burrow} onClose={onClose} onAddServer={onAddServer} />
    </Modal>
  );
}

function Repoint({
  burrow,
  onClose,
  onAddServer,
}: {
  burrow: string;
  onClose: () => void;
  onAddServer: (address: string) => void;
}) {
  const HOST_REPOINT_WORDS = useLocaleWords(hostRepointWords);
  const repoint = useRepointServers(burrow);
  const { view } = repoint;
  return (
    <>
      <ModalTitle className={styles.dialogTitle}>{view.title}</ModalTitle>
      {view.step === 'loading' && !repoint.error ? (
        <div className={styles.skeleton} style={{ height: 120 }} aria-busy="true" />
      ) : (
        <>
          {view.lead ? <ModalDescription className={styles.dialogBody}>{view.lead}</ModalDescription> : null}
          {view.rows.length ? (
            <div className={s.progress} aria-live="polite">
              <ul className={s.steps} aria-label={view.title}>
                {view.rows.map((row) => (
                  <ServerRow key={row.id} row={row} onAddServer={onAddServer} />
                ))}
              </ul>
              {view.outcome ? <p className={s.outcomeText}>{view.outcome}</p> : null}
            </div>
          ) : null}
        </>
      )}
      {repoint.error ? (
        <p className={s.outcomeText} role="alert">
          {repoint.error}
        </p>
      ) : null}
      <div className={styles.dialogActions}>
        {view.step === 'ask' ? (
          <>
            <Button onClick={onClose}>{HOST_REPOINT_WORDS.leaveThem}</Button>
            <Button variant="primary" disabled={repoint.starting} onClick={() => void repoint.start()}>
              {repoint.starting ? HOST_REPOINT_WORDS.states.pointing : view.title}
            </Button>
          </>
        ) : view.step === 'running' ? (
          <Button onClick={onClose}>{REPOINT_TEXT.hide}</Button>
        ) : (
          <Button variant="primary" onClick={onClose}>
            {REPOINT_TEXT.done}
          </Button>
        )}
      </div>
    </>
  );
}

/** A server: its mark (✓ pointed, a spinner while pointing, a ring before, ✗ where it didn't work), name and state. */
function ServerRow({ row, onAddServer }: { row: RepointRow; onAddServer: (address: string) => void }) {
  const HOST_REPOINT_WORDS = useLocaleWords(hostRepointWords);
  let mark: ReactNode;
  if (row.state === 'pointed')
    mark = (
      <span className={cx(s.mark, s.markDone)}>
        <Icon icon={CheckIcon} size={13} strokeWidth={2.5} />
      </span>
    );
  else if (row.state === 'failed')
    mark = (
      <span className={cx(s.mark, s.markFailed)}>
        <Icon icon={X} size={13} strokeWidth={2.5} />
      </span>
    );
  else if (row.state === 'pointing') mark = <span className={cx(s.mark, s.spinner)} />;
  else mark = <span className={cx(s.mark, row.state === 'no_key' ? s.markLate : s.markTodo)} />;
  const sub = [row.address, row.stateText].filter(Boolean).join(' · ');
  const add = row.addServer;
  return (
    <li className={cx(s.step, s.serverStep)} data-state={row.state ?? 'todo'}>
      <span className={s.markBox} role="img" aria-label={row.stateText ?? row.name}>
        {mark}
      </span>
      <span className={s.stepText}>
        <span className={s.stepLabel}>{row.name}</span>
        {sub ? <small className={s.stepSub}>{sub}</small> : null}
        {row.line ? <small className={s.stepSub}>{row.line}</small> : null}
      </span>
      {add ? (
        <Button size="sm" className={s.stepAction} onClick={() => onAddServer(add.address)}>
          {HOST_REPOINT_WORDS.pointItHere}
        </Button>
      ) : null}
    </li>
  );
}
