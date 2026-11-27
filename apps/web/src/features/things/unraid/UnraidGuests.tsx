/**
 * Docker the Unraid way and libvirt's autostart (Whombat incus-unraid.md IU-05; AP-1593, AP-1594): on an Unraid
 * server's Guests tab an Autostart column (dockerMan's list for containers, libvirt's for VMs), a container's web page
 * and Update (when an update and its template are there, asked), and Check for updates in the head; on a guest's page
 * the same as one card. libvirt VMs get Autostart wherever libvirt runs.
 */
import { canUpdateContainer, guestWebUi, hasAutostart } from '@whombat/client/hosts';
import { type HostGuest, type HostServerDetail, hostErrorWords } from '@whombat/core/domain';
import { ExternalLink } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button, ButtonLink } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { Toggle } from '../../../components/Toggle';
import { useLocaleWords } from '../../../i18n/words';
import { Card } from '../parts';
import styles from '../Things.module.css';
import type { GuestsTabExtras } from '../tabs/GuestsTab';
import wu from './Unraid.module.css';
import { type UnraidDialog, UnraidDialogs } from './UnraidDialogs';
import { useUnraidAccess, useUnraidChange } from './useUnraid';

/** The Guests tab's Unraid parts, and the dialogs they open (render `dialogs` next to the tab). */
export function useUnraidGuestExtras(
  burrow: string,
  detail: HostServerDetail,
  onUnraid: boolean,
): { extras: GuestsTabExtras; dialogs: ReactNode } {
  const HOST_ERROR_WORDS = useLocaleWords(hostErrorWords);
  const access = useUnraidAccess(burrow, detail);
  const { run, busy } = useUnraidChange(burrow, detail.server.id);
  const [dialog, setDialog] = useState<UnraidDialog | null>(null);
  const server = detail.server.id;
  const any = (detail.workloads?.libvirt?.guests.length ?? 0) > 0 || onUnraid;
  const extras: GuestsTabExtras = {
    ...(any
      ? {
          column: {
            label: 'Autostart',
            cell: (g: HostGuest) =>
              hasAutostart(g, onUnraid) ? (
                <Toggle
                  size="sm"
                  aria-label={`Start ${g.name} with ${server}`}
                  checked={g.autostart === true}
                  disabled={!access.can || busy || g.self === true}
                  title={g.self ? HOST_ERROR_WORDS.self_guest : undefined}
                  onCheckedChange={(on) =>
                    void run('guest.autostart', {
                      guestId: g.id,
                      params: { on },
                      on,
                      target: g.name,
                      inline: false,
                    })
                  }
                />
              ) : null,
          },
        }
      : {}),
    tools: (g: HostGuest) => {
      const web = onUnraid ? guestWebUi(g) : null;
      const update = access.can && canUpdateContainer(g, onUnraid);
      if (!web && !update) return null;
      return (
        <>
          {update ? (
            <Button size="sm" disabled={busy} onClick={() => setDialog({ kind: 'container', guestId: g.id })}>
              Update
            </Button>
          ) : null}
          {web && g.state !== 'stopped' ? (
            <a
              className={styles.iconBtn}
              href={web}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${g.name}’s web page`}
              title="Web page"
            >
              <Icon icon={ExternalLink} size={15} />
            </a>
          ) : null}
        </>
      );
    },
    ...(onUnraid && access.can
      ? {
          head: (
            <Button size="sm" disabled={busy} onClick={() => void run('containers.check', { inline: false })}>
              Check for updates
            </Button>
          ),
        }
      : {}),
  };
  return {
    extras,
    dialogs: (
      <UnraidDialogs burrow={burrow} detail={detail} dialog={dialog} onClose={() => setDialog(null)} />
    ),
  };
}

/** A Docker container on Unraid or a libvirt VM on its page: Autostart, its web page, Update. */
export function UnraidGuestCard({
  burrow,
  detail,
  guest: g,
  onUnraid,
}: {
  burrow: string;
  detail: HostServerDetail;
  guest: HostGuest;
  onUnraid: boolean;
}) {
  const HOST_ERROR_WORDS = useLocaleWords(hostErrorWords);
  const access = useUnraidAccess(burrow, detail);
  const { run, busy } = useUnraidChange(burrow, detail.server.id);
  const [dialog, setDialog] = useState<UnraidDialog | null>(null);
  const autostart = hasAutostart(g, onUnraid);
  const web = onUnraid ? guestWebUi(g) : null;
  const update = canUpdateContainer(g, onUnraid);
  if (!autostart && !web && !(g.platform === 'docker' && onUnraid && g.updateAvailable)) return null;
  const server = detail.server.id;
  return (
    <Card id="wu-guest" title={g.platform === 'libvirt' ? 'On this server' : 'On Unraid'}>
      <div className={styles.rows}>
        {autostart ? (
          <div className={styles.row}>
            <div className={styles.rowMain}>
              <b id="wu-autostart">Autostart</b>
              <small>
                {g.autostart
                  ? `Starts when ${server} starts${g.platform === 'docker' ? ' its array' : ''}.`
                  : `Stays off until someone starts it after ${server} restarts.`}
              </small>
            </div>
            <Toggle
              aria-labelledby="wu-autostart"
              checked={g.autostart === true}
              disabled={!access.can || busy || g.self === true}
              title={g.self ? HOST_ERROR_WORDS.self_guest : undefined}
              onCheckedChange={(on) =>
                void run('guest.autostart', {
                  guestId: g.id,
                  params: { on },
                  on,
                  target: g.name,
                  inline: false,
                })
              }
            />
          </div>
        ) : null}
        {g.platform === 'docker' && onUnraid && g.updateAvailable ? (
          <div className={styles.row}>
            <div className={styles.rowMain}>
              <b>An update is out</b>
              <small>
                {update
                  ? 'Unraid makes the container again from its template with the new image.'
                  : 'There’s no Unraid template for it (Compose or the command line made it), so update it where it was made.'}
              </small>
            </div>
            {update && access.can ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => setDialog({ kind: 'container', guestId: g.id })}
              >
                Update {g.name}
              </Button>
            ) : null}
          </div>
        ) : null}
        {web ? (
          <div className={styles.row}>
            <div className={styles.rowMain}>
              <b>Web page</b>
              <small className={wu.wuMonoSmall}>{web}</small>
            </div>
            <ButtonLink
              size="sm"
              href={web}
              target="_blank"
              rel="noreferrer"
              iconEnd={<Icon icon={ExternalLink} size={13} />}
            >
              Open
            </ButtonLink>
          </div>
        ) : null}
      </div>
      <UnraidDialogs burrow={burrow} detail={detail} dialog={dialog} onClose={() => setDialog(null)} />
    </Card>
  );
}
