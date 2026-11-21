/**
 * A guest row's ⋯ menu (ported from Rackoon's `GuestMenu`; the server's Guests tab and the fleet's list): Console, the
 * power items the guest's state allows (stopping and restarting asked first), Snapshots…, History… and Open. Only what
 * the viewer may do is listed; power results arrive live.
 */
import {
  actionAcceptedText,
  isDestructiveAction,
  type PowerActionView,
  powerActions,
  selfAllowsAction,
} from '@whombat/client/hosts';
import { useHostsChange } from '@whombat/client/hosts/react';
import { api } from '@whombat/core/contracts';
import type { HostGuest } from '@whombat/core/domain';
import { Ellipsis } from 'lucide-react';
import { useState } from 'react';
import type { ContextMenuItem } from '../../../app/shell/ContextMenu';
import { Icon } from '../../../components/Icon';
import { ConfirmDialog, useChangeRunner } from '../parts';
import styles from '../Things.module.css';
import { GuestHistoryDialog } from './GuestHistoryDialog';
import { MenuButton } from './MenuButton';

/** Where a row's menu goes: the guest's page (a tab of it) or its console. */
export interface GuestPlace {
  guest?: string;
  gtab?: string;
  console?: string;
}

export function GuestRowMenu({
  burrow,
  serverId,
  guest: g,
  power,
  console: consoleOk,
  withServer,
  onGo,
}: {
  burrow: string;
  serverId: string;
  guest: HostGuest;
  /** The viewer may power guests on this server. */
  power: boolean;
  /** Consoles are allowed on this server and the guest has one. */
  console: boolean;
  /** Name the server in the menu's name (the fleet's list). */
  withServer?: boolean;
  onGo: (place: GuestPlace) => void;
}) {
  const [ask, setAsk] = useState<PowerActionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const change = useHostsChange(api.hosts.guestAction);
  const { run, busy } = useChangeRunner();
  const go = async (a: PowerActionView, inline: boolean) => {
    setError(null);
    const out = await run(
      () =>
        change.mutateAsync({
          params: { burrow, serverId, guestId: g.id },
          body: { action: a.action, ...(isDestructiveAction(a.action) ? { confirm: true } : {}) },
        }),
      (data) => actionAcceptedText(a.action, g.name, data.noop),
      { inline },
    );
    if (out.ok || !out.error) setAsk(null);
    else setError(out.message);
  };
  const items: ContextMenuItem[] = [];
  if (consoleOk)
    items.push({ label: g.kind === 'vm' ? 'Console' : 'Shell', onSelect: () => onGo({ console: g.id }) });
  // The guest this Whombat runs in keeps only what doesn't stop it (IU-02).
  const powerItems: ContextMenuItem[] = power
    ? powerActions(g)
        .filter((a) => selfAllowsAction(g, a.action))
        .map((a) => ({
          label: a.confirm ? `${a.label}…` : a.label,
          danger: a.serious,
          onSelect: () => (a.confirm ? setAsk(a) : void go(a, false)),
        }))
    : [];
  const more: ContextMenuItem[] = [];
  if (power && g.platform !== 'docker')
    more.push({ label: 'Snapshots…', onSelect: () => onGo({ guest: g.id, gtab: 'snapshots' }) });
  more.push({ label: 'History…', onSelect: () => setHistory(true) });
  more.push({ label: 'Open', onSelect: () => onGo({ guest: g.id }) });
  // A line between the groups (console, power, the rest).
  for (const group of [powerItems, more])
    for (const [i, item] of group.entries()) items.push({ ...item, separated: i === 0 && items.length > 0 });
  return (
    <>
      <MenuButton
        label={withServer ? `Actions for ${g.name} on ${serverId}` : `Actions for ${g.name}`}
        className={styles.iconBtn}
        title="More"
        disabled={busy}
        items={items}
      >
        <Icon icon={Ellipsis} size={15} />
      </MenuButton>
      <ConfirmDialog
        open={ask !== null}
        title={ask?.question ?? ''}
        confirm={ask?.label ?? ''}
        serious={ask?.serious}
        busy={busy}
        error={error}
        onConfirm={() => ask && void go(ask, true)}
        onClose={() => {
          setAsk(null);
          setError(null);
        }}
      />
      {history ? (
        <GuestHistoryDialog burrow={burrow} serverId={serverId} guest={g} onClose={() => setHistory(false)} />
      ) : null}
    </>
  );
}
