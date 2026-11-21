/**
 * An Unraid server's plugins and Unraid itself (Whombat incus-unraid.md IU-05, IU-10; AP-1595): the version line
 * (“Unraid 7.3.1 · Pro”; a newer one is updated in Unraid, linked to the server's own Update page), then every plugin
 * with its author, version and the newer one, Update (asked), Update all and Check for updates. Unraid's own OS plugin
 * isn't listed: Whombat doesn't update the OS (it needs a restart).
 */
import {
  pluginRows,
  pluginUpdates,
  plural,
  unraidDetail,
  unraidPageUrl,
  unraidVersionView,
} from '@whombat/client/hosts';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Button, ButtonLink } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { Badge, Card, Empty, StateCell } from '../parts';
import styles from '../Things.module.css';
import { AccessNote, type UnraidTabProps } from './ArrayTab';
import wu from './Unraid.module.css';
import { type UnraidDialog, UnraidDialogs } from './UnraidDialogs';
import { useUnraidAccess, useUnraidChange } from './useUnraid';

export function PluginsTab({ burrow, serverId, detail }: UnraidTabProps) {
  const u = unraidDetail(detail);
  const access = useUnraidAccess(burrow, detail);
  const { run, busy } = useUnraidChange(burrow, serverId);
  const [dialog, setDialog] = useState<UnraidDialog | null>(null);
  if (!u) return <Empty>No word from {serverId} about its plugins yet.</Empty>;
  const version = unraidVersionView(u);
  const updateUrl = unraidPageUrl(detail, 'Tools/Update');
  const rows = pluginRows(u);
  const updates = pluginUpdates(u);
  return (
    <>
      <Card title="Unraid">
        <div className={styles.rows}>
          <div className={styles.row}>
            <div className={styles.rowMain}>
              <b>{version.text}</b>
              <small>
                <StateCell
                  tone={version.update ? 'warn' : 'ok'}
                  text={version.update ?? 'Up to date. Whombat tells you when a newer one is out.'}
                />
              </small>
            </div>
            {version.update && updateUrl ? (
              <span className={wu.wuEnd}>
                <ButtonLink
                  size="sm"
                  href={updateUrl}
                  target="_blank"
                  rel="noreferrer"
                  iconEnd={<Icon icon={ExternalLink} size={13} />}
                >
                  Update in Unraid
                </ButtonLink>
              </span>
            ) : null}
          </div>
        </div>
        {version.update ? (
          <p className={styles.cardNote}>
            Updating Unraid restarts {serverId}, so it’s done in Unraid’s own page, not from Whombat.
          </p>
        ) : null}
      </Card>
      <Card
        title="Plugins"
        meta={`${plural(rows.length, 'plugin')} · ${updates.length ? plural(updates.length, 'update') : 'all up to date'}`}
        link={
          access.can ? (
            <span className={wu.wuHeadActs}>
              <Button size="sm" disabled={busy} onClick={() => void run('plugin.check', { inline: false })}>
                Check for updates
              </Button>
              {updates.length > 1 ? (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => setDialog({ kind: 'plugins', file: 'all' })}
                >
                  Update all
                </Button>
              ) : null}
            </span>
          ) : undefined
        }
      >
        {rows.length ? (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col" className={styles.cellMain}>
                  Plugin
                </th>
                <th scope="col" className={styles.dropM}>
                  Version
                </th>
                <th scope="col" className={styles.dropS}>
                  Update
                </th>
                <th scope="col">
                  <span className={styles.srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.file}>
                  <td className={styles.cellMain}>
                    <span className={styles.mono} title={p.name}>
                      {p.name}
                    </span>
                    {p.author ? <div className={wu.wuSub}>by {p.author}</div> : null}
                  </td>
                  <td className={cx(styles.num, styles.dropM)}>{p.version}</td>
                  <td className={styles.dropS}>
                    {p.update ? (
                      <Badge tone="warn">{p.update} is out</Badge>
                    ) : (
                      <span className={styles.muted}>Up to date</span>
                    )}
                  </td>
                  <td className={wu.wuActs}>
                    <span className={wu.wuRowActs}>
                      {p.supportUrl ? (
                        <a
                          className={cx(styles.cardLink, wu.wuExternal)}
                          href={p.supportUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label={`Support for ${p.name}`}
                        >
                          Support
                          <Icon icon={ExternalLink} size={12} />
                        </a>
                      ) : null}
                      {p.update && access.can ? (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => setDialog({ kind: 'plugins', file: p.file })}
                          aria-label={`Update ${p.name}`}
                        >
                          Update
                        </Button>
                      ) : null}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No plugins installed.</Empty>
        )}
        <AccessNote access={access} />
      </Card>
      <UnraidDialogs burrow={burrow} detail={detail} dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}
