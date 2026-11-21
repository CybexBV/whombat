/**
 * An Incus server's Network (Whombat incus-unraid.md IU-04; AP-1576): Incus's networks — its own bridges with their
 * address ranges and NAT, and the server's cards Incus sees — with how many instances use each; a managed network
 * opens to the addresses it handed out (`network.leases`), each instance a link to its page; then the server's own
 * interfaces (moved here from System, less-is-more.md AP-1765). Changing networks stays with the incus command (IU-10).
 */
import {
  DASH,
  type HostIncusNetwork,
  incusDetail,
  incusRef,
  networkWords,
  usedByText,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostServerDetail } from '@whombat/core/domain';
import { ChevronRight } from 'lucide-react';
import { Fragment, useState } from 'react';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { Card, Empty, ErrorLine } from '../parts';
import { useThingSearch } from '../search';
import styles from '../Things.module.css';
import { ServerNetwork } from '../tabs/ServerNetwork';
import wi from './Incus.module.css';

const LEASE_WORDS: Record<string, string> = {
  static: 'Fixed',
  dynamic: 'Handed out',
  gateway: 'The network itself',
};

export function IncusNetworkTab({ burrow, detail }: { burrow: string; detail: HostServerDetail }) {
  const inc = incusDetail(detail);
  const leasesOn = detail.server.remoteControl.manage === true;
  const [open, setOpen] = useState<string | null>(null);
  const nets = [...(inc?.networks ?? [])].sort(
    (a, b) => Number(b.managed) - Number(a.managed) || b.usedBy - a.usedBy || a.name.localeCompare(b.name),
  );
  return (
    <>
      <Card
        title="Incus networks"
        meta={nets.length ? `${nets.filter((n) => n.managed).length} of its own` : undefined}
      >
        {!inc ? (
          <Empty>No word from Incus about its networks yet.</Empty>
        ) : nets.length ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.cellMain}>
                  Network
                </th>
                <th scope="col" className={styles.dropM}>
                  Kind
                </th>
                <th scope="col">Addresses</th>
                <th scope="col" className={styles.dropS}>
                  Used by
                </th>
              </tr>
            </thead>
            <tbody>
              {nets.map((n) => (
                <Fragment key={n.name}>
                  <tr>
                    <td className={styles.cellMain}>
                      {n.managed && leasesOn ? (
                        <button
                          type="button"
                          className={wi.wiTwist}
                          aria-expanded={open === n.name}
                          aria-controls={`wi-leases-${n.name}`}
                          onClick={() => setOpen((o) => (o === n.name ? null : n.name))}
                        >
                          <Icon icon={ChevronRight} size={14} />
                          {n.name}
                        </button>
                      ) : (
                        <span className={styles.mono}>{n.name}</span>
                      )}
                      {n.description ? <span className={wi.wiSub}>{n.description}</span> : null}
                    </td>
                    <td className={cx(styles.muted, styles.dropM)}>{kindWords(n)}</td>
                    <td>
                      <span className={styles.mono}>{networkWords(n) || DASH}</span>
                    </td>
                    <td className={cx(styles.num, styles.dropS)}>{usedByText(n.usedBy)}</td>
                  </tr>
                  {open === n.name ? (
                    <tr id={`wi-leases-${n.name}`}>
                      <td colSpan={4} style={{ padding: 0 }}>
                        <Leases burrow={burrow} serverId={detail.server.id} network={n.name} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>Incus has no networks on this server.</Empty>
        )}
        <p className={styles.cardNote}>Networks are changed with the incus command.</p>
      </Card>
      <ServerNetwork detail={detail} title="Server network" />
    </>
  );
}

function kindWords(n: HostIncusNetwork): string {
  if (n.managed) return n.type === 'bridge' ? 'Incus bridge' : `Incus ${n.type}`;
  return n.type === 'physical' ? 'Network card' : n.type === 'bridge' ? 'Server bridge' : n.type;
}

function Leases({ burrow, serverId, network }: { burrow: string; serverId: string; network: string }) {
  const [, set] = useThingSearch();
  const q = useHostManageRead({
    params: { burrow, serverId },
    query: { op: 'network.leases', platform: 'incus', network },
  });
  const items = q.data?.op === 'network.leases' ? q.data.items : [];
  return (
    <div className={wi.wiLeases}>
      {q.error ? (
        <ErrorLine error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length ? (
        <table className={styles.table} aria-label={`Addresses on ${network}`}>
          <thead>
            <tr>
              <th scope="col" className={styles.cellMain}>
                Name
              </th>
              <th scope="col">Address</th>
              <th scope="col" className={styles.dropM}>
                MAC address
              </th>
              <th scope="col" className={styles.dropS}>
                How
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((l) => (
              <tr key={`${l.address}-${l.hwaddr}`}>
                <td className={styles.cellMain}>
                  {l.guestId ? (
                    <button
                      type="button"
                      className={styles.name}
                      onClick={() => set({ guest: l.guestId as string })}
                    >
                      {incusRef(l.guestId).name}
                    </button>
                  ) : (
                    <span className={styles.mono}>{l.hostname || DASH}</span>
                  )}
                </td>
                <td>
                  <span className={styles.mono}>{l.address}</span>
                </td>
                <td className={styles.dropM}>
                  <span className={styles.mono}>{l.hwaddr || DASH}</span>
                </td>
                <td className={cx(styles.muted, styles.dropS)}>
                  {LEASE_WORDS[l.type.toLowerCase()] ?? l.type}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{q.isLoading ? 'Looking…' : 'No addresses handed out on this network.'}</Empty>
      )}
    </div>
  );
}
