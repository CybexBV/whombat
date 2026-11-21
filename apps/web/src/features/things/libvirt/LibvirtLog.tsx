/**
 * A libvirt VM's own log (Whombat incus-unraid.md IU-13; AP-1655): the last lines of QEMU's log for it
 * (`/var/log/libvirt/qemu/<name>.log`, `log.get`) — how libvirt started it, what QEMU complained about — with how many
 * lines and Refresh. Read-only.
 */

import { useHostManageRead } from '@whombat/client/hosts/react';
import { HOST_LOG_LINES_MAX } from '@whombat/core/domain';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { SegmentedControl } from '../../../components/SegmentedControl';
import type { GuestTabProps } from '../guest/tabProps';
import { Card, Empty, ErrorLine } from '../parts';
import styles from '../Things.module.css';
import wq from './Libvirt.module.css';

const COUNTS = ['100', '500', String(HOST_LOG_LINES_MAX)] as const;

export function LibvirtLog({ burrow, serverId, guest }: GuestTabProps) {
  const [lines, setLines] = useState<(typeof COUNTS)[number]>('500');
  const q = useHostManageRead({
    params: { burrow, serverId },
    query: { op: 'log.get', guestId: guest.id, platform: 'libvirt', lines: Number(lines) },
  });
  const log = q.data?.op === 'log.get' ? q.data : undefined;
  return (
    <Card
      title="Log"
      meta={log ? log.file : 'QEMU’s log for this VM'}
      link={
        <span className={wq.wqHeadActs}>
          <SegmentedControl
            options={COUNTS.map((c) => ({ value: c, label: `Last ${Number(c).toLocaleString('en-US')}` }))}
            value={lines}
            onChange={setLines}
            label="Lines"
            size="sm"
            variant="soft"
          />
          <Button
            size="sm"
            iconStart={<Icon icon={RefreshCw} size={13} />}
            disabled={q.isFetching}
            onClick={() => void q.refetch()}
          >
            Refresh
          </Button>
        </span>
      }
    >
      {q.error ? (
        <ErrorLine error={q.error} onRetry={() => void q.refetch()} />
      ) : !log ? (
        <Empty>Looking…</Empty>
      ) : log.lines.length ? (
        <div className={wq.wqLogWrap}>
          <pre
            className={`${styles.code} ${wq.wqLog}`}
            role="log"
            aria-live="off"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the log scrolls; keyboard users need to reach it
            tabIndex={0}
            aria-label={`${guest.name}’s log`}
          >
            {log.lines.join('\n')}
          </pre>
        </div>
      ) : (
        <Empty>Nothing in {guest.name}’s log yet.</Empty>
      )}
    </Card>
  );
}
