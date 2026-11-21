/**
 * A QEMU/KVM server's Network (Whombat incus-unraid.md IU-13; AP-1658): libvirt's networks (how they reach the rest
 * of the network, their addresses, DHCP, how many VMs use them) with the addresses each handed out (`network.leases`,
 * the VM a lease belongs to linked), the host's bridges VMs can join directly, and the server's other interfaces
 * (moved here from System, less-is-more.md AP-1765). Read here; networks are made and changed with virsh or
 * virt-manager (IU-10).
 */
import { DASH, forwardWords, plural } from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostServerDetail } from '@whombat/core/domain';
import { useState } from 'react';
import { cx } from '../../../components/cx';
import { Card, Empty, ErrorLine, StateCell } from '../parts';
import { useThingSearch } from '../search';
import styles from '../Things.module.css';
import { ServerNetwork } from '../tabs/ServerNetwork';
import wq from './Libvirt.module.css';
import { libvirtGuests } from './LibvirtBackups';

export function LibvirtNetwork({ burrow, detail }: { burrow: string; detail: HostServerDetail }) {
  const nets = detail.libvirt?.networks ?? [];
  const withLeases = nets.filter((n) => n.dhcp);
  const [picked, setPicked] = useState('');
  const open = picked || withLeases.find((n) => n.active)?.name || '';
  const bridges = (detail.health?.network ?? []).filter(
    // libvirt's own bridges (virbr0 of a NAT network) aren't the host's; a bridged network's br0 is.
    (n) => n.kind === 'bridge' && !nets.some((x) => x.bridge === n.name && x.forward !== 'bridge'),
  );
  return (
    <>
      <Card title="libvirt networks" meta={nets.length ? plural(nets.length, 'network') : undefined}>
        {nets.length ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.cellMain}>
                  Network
                </th>
                <th scope="col">
                  <span className={styles.narrowSr}>State</span>
                </th>
                <th scope="col" className={styles.dropM}>
                  Reaches
                </th>
                <th scope="col" className={styles.dropS}>
                  Address
                </th>
                <th scope="col" className={styles.dropL}>
                  VMs
                </th>
                <th scope="col">
                  <span className={styles.srOnly}>Leases</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {nets.map((n) => (
                <tr key={n.name} className={n.name === open ? wq.wqPicked : undefined}>
                  <td className={styles.cellMain}>
                    <span className={styles.mono}>{n.name}</span>{' '}
                    {n.bridge ? <span className={styles.kind}>{n.bridge}</span> : null}
                  </td>
                  <td>
                    <StateCell
                      tone={n.active ? 'ok' : 'mut'}
                      text={n.active ? (n.autostart ? 'Running' : 'Running, not at boot') : 'Stopped'}
                      compact
                    />
                  </td>
                  <td className={cx(styles.muted, styles.dropM)}>{forwardWords(n)}</td>
                  <td className={cx(styles.num, styles.dropS)}>
                    {n.ipv4 ?? DASH}
                    {n.dhcp ? <span className={styles.kind}> · DHCP</span> : null}
                  </td>
                  <td className={cx(styles.num, styles.dropL)}>{n.usedBy}</td>
                  <td>
                    {n.dhcp && n.active ? (
                      <button
                        type="button"
                        className={styles.cardLink}
                        aria-pressed={n.name === open}
                        onClick={() => setPicked(n.name)}
                      >
                        Leases<span className={styles.srOnly}> of {n.name}</span>
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>libvirt has no networks here; VMs join the host’s bridges below.</Empty>
        )}
        <div className={styles.cardNote}>Make or change networks with virsh or virt-manager.</div>
      </Card>
      {open ? <Leases burrow={burrow} detail={detail} network={open} /> : null}
      <Card title="Host bridges" meta="VMs on these get addresses from your router">
        {bridges.length ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.cellMain}>
                  Bridge
                </th>
                <th scope="col">
                  <span className={styles.narrowSr}>State</span>
                </th>
                <th scope="col" className={styles.dropS}>
                  Address
                </th>
                <th scope="col" className={styles.dropM}>
                  Joined by
                </th>
              </tr>
            </thead>
            <tbody>
              {bridges.map((b) => (
                <tr key={b.name}>
                  <td className={styles.cellMain}>
                    <span className={styles.mono}>{b.name}</span>
                  </td>
                  <td>
                    <StateCell tone={b.up ? 'ok' : 'bad'} text={b.up ? 'Up' : 'Down'} compact />
                  </td>
                  <td className={cx(styles.num, styles.dropS)}>{b.addresses.join(', ') || DASH}</td>
                  <td className={cx(styles.mono, styles.muted, styles.dropM)} style={{ fontSize: 12.5 }}>
                    {b.members.join(', ') || DASH}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No bridges on this server.</Empty>
        )}
      </Card>
      <ServerNetwork
        detail={detail}
        title="Server network"
        skip={(n) => bridges.some((b) => b.name === n.name)}
      />
    </>
  );
}

function Leases({ burrow, detail, network }: { burrow: string; detail: HostServerDetail; network: string }) {
  const [, set] = useThingSearch();
  const q = useHostManageRead({
    params: { burrow, serverId: detail.server.id },
    query: { op: 'network.leases', platform: 'libvirt', network },
  });
  const items = q.data?.op === 'network.leases' ? q.data.items : [];
  const guests = libvirtGuests(detail);
  return (
    <Card title={`Addresses on ${network}`} meta={q.data ? plural(items.length, 'lease') : undefined}>
      {q.error ? (
        <ErrorLine error={q.error} onRetry={() => void q.refetch()} />
      ) : items.length ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Address</th>
              <th scope="col" className={styles.dropS}>
                Host name
              </th>
              <th scope="col" className={styles.dropM}>
                MAC
              </th>
              <th scope="col" className={styles.cellMain}>
                VM
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((l) => {
              const g = l.guestId ? guests.find((x) => x.id === l.guestId) : undefined;
              return (
                <tr key={`${l.hwaddr}-${l.address}`}>
                  <td className={styles.num}>{l.address}</td>
                  <td className={styles.dropS}>
                    {l.hostname || <span className={styles.muted}>{DASH}</span>}
                  </td>
                  <td className={cx(styles.mono, styles.muted, styles.dropM)} style={{ fontSize: 12.5 }}>
                    {l.hwaddr}
                  </td>
                  <td className={styles.cellMain}>
                    {g ? (
                      <button type="button" className={styles.name} onClick={() => set({ guest: g.id })}>
                        {g.name}
                      </button>
                    ) : (
                      <span className={styles.muted}>Not a VM here</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <Empty>{q.isLoading ? 'Looking…' : `${network} hasn’t handed out an address yet.`}</Empty>
      )}
    </Card>
  );
}
