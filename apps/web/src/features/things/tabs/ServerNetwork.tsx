/**
 * The server's own network interfaces (its cards and bridges): whether each is up and how fast, its addresses and the
 * traffic now. On the Network tab where a server has one (Incus, QEMU/KVM; less-is-more.md AP-1765), else on System.
 * The columns drop as the card narrows (AP-1754).
 */
import { DASH, formatNetRate } from '@whombat/client/hosts';
import type { HostServerDetail } from '@whombat/core/domain';
import { cx } from '../../../components/cx';
import { Card, StateCell } from '../parts';
import styles from '../Things.module.css';

type Iface = NonNullable<NonNullable<HostServerDetail['health']>['network']>[number];

export function ServerNetwork({
  detail,
  title = 'Network',
  skip,
}: {
  detail: HostServerDetail;
  title?: string;
  /** Interfaces another card on the tab already lists (libvirt's host bridges). */
  skip?: (n: Iface) => boolean;
}) {
  const ifaces = (detail.health?.network ?? []).filter((n) => n.kind !== 'loopback' && !skip?.(n));
  if (!ifaces.length) return null;
  return (
    <Card title={title}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col" className={styles.cellMain}>
              Interface
            </th>
            <th scope="col">
              <span className={styles.narrowSr}>State</span>
            </th>
            <th scope="col" className={styles.dropS}>
              Address
            </th>
            <th scope="col" className={styles.dropM}>
              In / out
            </th>
          </tr>
        </thead>
        <tbody>
          {ifaces.map((n) => (
            <tr key={n.name}>
              <td className={styles.cellMain}>
                <span className={styles.mono}>{n.name}</span>{' '}
                <span className={styles.kind}>
                  {n.kind}
                  {n.master ? ` · in ${n.master}` : ''}
                </span>
              </td>
              <td>
                <StateCell
                  tone={n.up && n.carrier ? 'ok' : n.up ? 'warn' : 'mut'}
                  text={
                    n.up
                      ? n.carrier
                        ? n.speedMbps
                          ? formatNetRate(n.speedMbps)
                          : 'up'
                        : 'no cable'
                      : 'down'
                  }
                  compact
                />
              </td>
              <td className={cx(styles.kind, styles.dropS)}>{n.addresses.join(', ') || DASH}</td>
              <td className={cx(styles.num, styles.dropM)}>
                {formatNetRate(n.rxMbps)} / {formatNetRate(n.txMbps)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
