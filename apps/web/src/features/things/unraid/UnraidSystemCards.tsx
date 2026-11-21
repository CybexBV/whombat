/**
 * What an Unraid server's System tab has of its own (Whombat incus-unraid.md IU-05, IU-08; AP-1589; moved here from the
 * old Summary when every server's Summary became the dashboard, dashboards-web.md AP-2050…): updates — Unraid itself,
 * plugins, containers, each with its way out — and Unraid's own unread notifications with Archive and Archive all. The
 * Summary links here (“Notifications”, “Updates”).
 */
import {
  canUpdateContainer,
  detailGuests,
  formatAgoIso,
  NOTIFICATION_WORDS,
  notificationTitle,
  notificationTone,
  pluginUpdates,
  plural,
  unraidDetail,
  unraidPageUrl,
  unraidVersionView,
} from '@whombat/client/hosts';
import type { HostServerDetail, HostUnraidDetail } from '@whombat/core/domain';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Button, ButtonLink } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { Card, Dot, Empty, StateCell } from '../parts';
import { useThingSearch } from '../search';
import styles from '../Things.module.css';
import type { UnraidTabProps } from './ArrayTab';
import wu from './Unraid.module.css';
import { type UnraidDialog, UnraidDialogs } from './UnraidDialogs';
import { type UnraidAccess, useUnraidAccess, useUnraidChange } from './useUnraid';

export function UnraidSystemCards({ burrow, detail }: UnraidTabProps) {
  const u = unraidDetail(detail);
  const access = useUnraidAccess(burrow, detail);
  const [dialog, setDialog] = useState<UnraidDialog | null>(null);
  if (!u) return null;
  return (
    <>
      <UpdatesCard burrow={burrow} detail={detail} u={u} access={access} onDialog={setDialog} />
      <NotificationsCard burrow={burrow} detail={detail} u={u} access={access} />
      <UnraidDialogs burrow={burrow} detail={detail} dialog={dialog} onClose={() => setDialog(null)} />
    </>
  );
}

function UpdatesCard({
  burrow,
  detail,
  u,
  access,
  onDialog,
}: {
  burrow: string;
  detail: HostServerDetail;
  u: HostUnraidDetail;
  access: UnraidAccess;
  onDialog: (d: UnraidDialog) => void;
}) {
  const [, set] = useThingSearch();
  const { run, busy } = useUnraidChange(burrow, detail.server.id);
  const version = unraidVersionView(u);
  const updateUrl = unraidPageUrl(detail, 'Tools/Update');
  const plugins = pluginUpdates(u);
  const outdated = detailGuests(detail).filter((g) => g.platform === 'docker' && g.updateAvailable === true);
  const updatable = outdated.filter((g) => canUpdateContainer(g, true));
  return (
    <Card title="Updates">
      <div className={styles.rows}>
        <div className={styles.row}>
          <div className={styles.rowMain}>
            <b>{version.text}</b>
            <small>
              <StateCell tone={version.update ? 'warn' : 'ok'} text={version.update ?? 'Up to date'} />
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
        <div className={styles.row}>
          <div className={styles.rowMain}>
            <b>Plugins</b>
            <small title={plugins.map((p) => p.name).join(', ')}>
              <StateCell
                tone={plugins.length ? 'warn' : 'ok'}
                text={
                  plugins.length
                    ? `${plural(plugins.length, 'update')}: ${plugins.map((p) => p.name).join(', ')}`
                    : 'Up to date'
                }
              />
            </small>
          </div>
          <span className={wu.wuEnd}>
            {plugins.length && access.can ? (
              <Button size="sm" disabled={busy} onClick={() => onDialog({ kind: 'plugins', file: 'all' })}>
                Update all
              </Button>
            ) : (
              <button
                type="button"
                className={styles.cardLink}
                onClick={() => set({ tab: 'plugins' }, { replace: true })}
              >
                Open Plugins
              </button>
            )}
          </span>
        </div>
        <div className={styles.row}>
          <div className={styles.rowMain}>
            <b>Containers</b>
            <small title={outdated.map((g) => g.name).join(', ')}>
              <StateCell
                tone={outdated.length ? 'warn' : 'ok'}
                text={
                  outdated.length
                    ? `${plural(outdated.length, 'update')}: ${outdated.map((g) => g.name).join(', ')}`
                    : 'Up to date'
                }
              />
            </small>
          </div>
          <span className={wu.wuEnd}>
            {access.can ? (
              <>
                {updatable.length === 1 && updatable[0] ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => onDialog({ kind: 'container', guestId: updatable[0]?.id ?? '' })}
                  >
                    Update {updatable[0].name}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void run('containers.check', { inline: false })}
                >
                  Check
                </Button>
              </>
            ) : null}
            {updatable.length !== 1 || !access.can ? (
              <button
                type="button"
                className={styles.cardLink}
                onClick={() => set({ tab: 'guests' }, { replace: true })}
              >
                Open Guests
              </button>
            ) : null}
          </span>
        </div>
      </div>
    </Card>
  );
}

function NotificationsCard({
  burrow,
  detail,
  u,
  access,
}: {
  burrow: string;
  detail: HostServerDetail;
  u: HostUnraidDetail;
  access: UnraidAccess;
}) {
  const { run, busy } = useUnraidChange(burrow, detail.server.id);
  const now = Date.parse(detail.asOf);
  const list = u.notifications;
  const archive = (id?: string) =>
    void run('notification.archive', { ...(id ? { params: { id }, target: id } : {}), inline: false });
  return (
    <Card
      id="wu-notifications"
      title="From Unraid"
      meta={list.length ? `${list.length} unread` : 'Nothing unread'}
      link={
        list.length && access.can ? (
          <button type="button" className={styles.cardLink} disabled={busy} onClick={() => archive()}>
            Archive all
          </button>
        ) : undefined
      }
    >
      {list.length ? (
        <div>
          {list.map((n) => (
            <div key={n.id} className={wu.wuNote}>
              <span className={wu.wuNoteDot}>
                <Dot tone={notificationTone(n)} label={NOTIFICATION_WORDS[n.importance]} />
              </span>
              <div className={wu.wuNoteMain}>
                <b>{notificationTitle(n)}</b>
                {n.description ? <span>{n.description}</span> : null}
                <small>
                  {n.event} · {formatAgoIso(n.at, now)}
                </small>
              </div>
              {access.can ? (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => archive(n.id)}
                  aria-label={`Archive “${notificationTitle(n)}”`}
                >
                  Archive
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <Empty>Unraid has nothing new to say.</Empty>
      )}
    </Card>
  );
}
