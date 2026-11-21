/**
 * What a connection runs on (connection-pages.md CP-08; connection-pages-web.md AP-1900…): Whombat finds it by the
 * connection's address; a person who may manage the connection picks a server or one of its guests when it can't (DHCP,
 * NAT), says it runs on nothing Whombat watches, or lets Whombat find it again (`connections.setRunsOn`). The servers
 * and their guests come from the hosts service, searchable by name or number (“CT 131”).
 */
import { runsOnChoices } from '@whombat/client';
import { hostErrorInfo } from '@whombat/client/hosts';
import { useHostGuests, useHostsFleet } from '@whombat/client/hosts/react';
import { useSetRunsOn } from '@whombat/client/react';
import type { ThingPage } from '@whombat/core';
import type { SetRunsOnBody } from '@whombat/core/contracts';
import { Check } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { Input } from '../../../components/Input';
import { Modal, ModalTitle } from '../../../components/Modal';
import { useToast } from '../../../components/Toast';
import things from '../Things.module.css';
import styles from './ThingPage.module.css';

export function RunsOnDialog({
  burrow,
  page,
  onClose,
}: {
  burrow: string;
  page: ThingPage;
  onClose: () => void;
}) {
  const toast = useToast();
  const findId = useId();
  const [query, setQuery] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const fleet = useHostsFleet({ params: { burrow }, query: {} });
  const guests = useHostGuests({ params: { burrow }, query: { limit: 500 } });
  const set = useSetRunsOn(burrow);
  const choices = useMemo(
    () => runsOnChoices(fleet.data?.servers ?? [], guests.data?.guests ?? [], query),
    [fleet.data, guests.data, query],
  );
  const now = page.runsOn;
  const choose = async (body: SetRunsOnBody, said: (name: string | null) => string) => {
    if (!page.connectionId || set.isPending) return;
    setProblem(null);
    try {
      const result = await set.mutateAsync({ connectionId: page.connectionId, body });
      if (result.status !== 'ok') {
        setProblem(result.status === 'pending_approval' ? 'That needs an approval first.' : result.message);
        return;
      }
      toast.show(said(result.data.runsOn?.name ?? null));
      onClose();
    } catch (err) {
      setProblem(hostErrorInfo(err).message);
    }
  };
  const row = (
    key: string,
    selected: boolean,
    main: string,
    note: string | null,
    onClick: () => void,
    extra?: string,
  ) => (
    <li key={key}>
      <button
        type="button"
        className={cx(styles.pickRow, extra)}
        aria-pressed={selected}
        onClick={onClick}
        disabled={set.isPending}
      >
        <span className={styles.pickMain}>{main}</span>
        {note ? <span className={styles.pickNote}>{note}</span> : null}
        {selected ? <Icon icon={Check} size={15} label="Chosen" /> : null}
      </button>
    </li>
  );
  const loading = (!fleet.data && !fleet.error) || (!guests.data && !guests.error);
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} width="md">
      <ModalTitle className={things.dialogTitle}>What does {page.name} run on?</ModalTitle>
      <p className={things.dialogBody}>
        Whombat finds it by its address. Choose the server or guest yourself when it can’t.
      </p>
      <label className={things.srOnly} htmlFor={findId}>
        Find a server or guest
      </label>
      <Input
        id={findId}
        type="search"
        size="md"
        autoComplete="off"
        placeholder="Find a server or guest"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className={styles.pick} aria-label="Servers and guests" aria-busy={loading || undefined}>
        {query.trim()
          ? null
          : row(
              'auto',
              now?.how === 'address',
              'Let Whombat find it',
              'by its address',
              () =>
                void choose({ mode: 'auto' }, (name) =>
                  name
                    ? `Whombat found ${page.name} on ${name}.`
                    : `Whombat looks for ${page.name} by its address.`,
                ),
            )}
        {query.trim()
          ? null
          : row(
              'none',
              false,
              'Not on a server Whombat watches',
              null,
              () => void choose({ mode: 'none' }, () => `${page.name} isn’t on a server Whombat watches.`),
            )}
        {choices.flatMap((s) => [
          row(
            `s:${s.server.serverId}`,
            now?.how === 'chosen' && now.serverId === s.server.serverId && !now.guestId,
            s.server.name,
            s.server.note,
            () =>
              void choose(
                { mode: 'chosen', serverId: s.server.serverId, guestId: null },
                () => `${page.name} runs on ${s.server.label}.`,
              ),
            styles.pickServer,
          ),
          ...s.guests.map((g) =>
            row(
              `g:${g.guestId}`,
              now?.how === 'chosen' && now.guestId === g.guestId,
              g.name,
              g.note,
              () =>
                void choose(
                  { mode: 'chosen', serverId: g.serverId, guestId: g.guestId },
                  () => `${page.name} runs on ${g.label}.`,
                ),
              styles.pickGuest,
            ),
          ),
        ])}
        {query.trim() && !choices.length && !loading ? (
          <li className={styles.pickNote}>No server or guest is called “{query.trim()}”.</li>
        ) : null}
      </ul>
      {now ? (
        <p className={styles.pickNote}>
          Now {now.name}, {now.how === 'address' ? 'found by its address' : 'chosen by a person'}.
        </p>
      ) : null}
      {problem ? (
        <p className={things.error} role="alert">
          {problem}
        </p>
      ) : null}
      <div className={things.dialogActions}>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}
