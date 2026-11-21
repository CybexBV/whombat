/**
 * An Unraid server's shares, read only (Whombat incus-unraid.md IU-05, IU-10; AP-1596): each share with its note,
 * where its files live (the array, a pool, or a pool and the array with the mover's way), how it's shared over SMB and
 * NFS, whether it's encrypted, and the space left for it. Changing shares stays in Unraid's own page, which is linked.
 */
import {
  plural,
  shareSmbWords,
  shareWhere,
  unraidDetail,
  unraidPageUrl,
  unraidSize,
} from '@whombat/client/hosts';
import { ExternalLink, Lock } from 'lucide-react';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { Card, Empty } from '../parts';
import styles from '../Things.module.css';
import type { UnraidTabProps } from './ArrayTab';
import wu from './Unraid.module.css';

export function SharesTab({ detail, serverId }: UnraidTabProps) {
  const u = unraidDetail(detail);
  const url = unraidPageUrl(detail, 'Shares');
  const shares = [...(u?.shares ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
  );
  const link = url ? (
    <a className={cx(styles.cardLink, wu.wuExternal)} href={url} target="_blank" rel="noreferrer">
      Shares in Unraid
      <Icon icon={ExternalLink} size={13} />
    </a>
  ) : undefined;
  return (
    <Card title="Shares" meta={shares.length ? plural(shares.length, 'share') : undefined} link={link}>
      {shares.length ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.cellMain}>
                Share
              </th>
              <th scope="col" className={styles.dropM}>
                Stored on
              </th>
              <th scope="col" className={styles.dropS}>
                SMB
              </th>
              <th scope="col" className={styles.dropL}>
                NFS
              </th>
              <th scope="col" className={wu.wuRight}>
                Free
              </th>
            </tr>
          </thead>
          <tbody>
            {shares.map((s) => (
              <tr key={s.name}>
                <td className={styles.cellMain}>
                  <span className={wu.wuShare}>
                    <span className={styles.mono}>{s.name}</span>
                    {s.encrypted ? (
                      <span className={wu.wuLock} role="img" aria-label="Encrypted" title="Encrypted">
                        <Icon icon={Lock} size={12} />
                      </span>
                    ) : null}
                  </span>
                  {s.comment ? <div className={wu.wuSub}>{s.comment}</div> : null}
                </td>
                <td className={cx(styles.mono, styles.dropM)}>{shareWhere(s)}</td>
                <td className={cx(s.smb ? undefined : styles.muted, styles.dropS)}>{shareSmbWords(s.smb)}</td>
                <td className={cx(s.nfs ? undefined : styles.muted, styles.dropL)}>
                  {s.nfs ? 'Shared' : 'Not shared'}
                </td>
                <td className={cx(styles.num, wu.wuRight)}>{unraidSize(s.freeBytes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>{u ? `${serverId} has no shares.` : `No word from ${serverId} about its shares yet.`}</Empty>
      )}
      <p className={styles.cardNote}>
        Change shares in Unraid’s own page.
        {url ? (
          <>
            {' '}
            <a className={cx(styles.cardLink, wu.wuInline)} href={url} target="_blank" rel="noreferrer">
              Open it
            </a>
          </>
        ) : null}
      </p>
    </Card>
  );
}
