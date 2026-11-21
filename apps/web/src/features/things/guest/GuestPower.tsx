/**
 * A guest's power (ported from Rackoon's `GuestMenu` and `powerActions`): Start straight away; Shut down, Restart and
 * Force stop ask first (ONE-12: stopping and rebooting always ask). The result arrives live (`hosts.guest`); the
 * toast says it started.
 */
import {
  actionAcceptedText,
  isDestructiveAction,
  type PowerActionView,
  powerActions,
} from '@whombat/client/hosts';
import { useHostsChange } from '@whombat/client/hosts/react';
import { api } from '@whombat/core/contracts';
import type { HostGuest } from '@whombat/core/domain';
import { ChevronDown, Power } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { ConfirmDialog, useChangeRunner } from '../parts';
import styles from '../Things.module.css';

export function GuestPower({
  burrow,
  serverId,
  guest,
  allowed = true,
  reason,
  size = 'md',
}: {
  burrow: string;
  serverId: string;
  guest: Pick<HostGuest, 'id' | 'name' | 'state' | 'platform' | 'kind'>;
  allowed?: boolean;
  reason?: string | null;
  size?: 'sm' | 'md';
}) {
  const [open, setOpen] = useState(false);
  const [ask, setAsk] = useState<PowerActionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const change = useHostsChange(api.hosts.guestAction);
  const { run, busy } = useChangeRunner();
  const wrap = useRef<HTMLDivElement>(null);
  const actions = powerActions(guest);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !wrap.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const go = async (a: PowerActionView, inline: boolean) => {
    setError(null);
    const out = await run(
      () =>
        change.mutateAsync({
          params: { burrow, serverId, guestId: guest.id },
          body: { action: a.action, ...(isDestructiveAction(a.action) ? { confirm: true } : {}) },
        }),
      (data) => actionAcceptedText(a.action, guest.name, data.noop),
      { inline },
    );
    if (out.ok || !out.error) setAsk(null);
    else setError(out.message);
  };
  const pick = (a: PowerActionView) => {
    setOpen(false);
    if (a.confirm) setAsk(a);
    else void go(a, false);
  };

  const first = actions[0];
  // A stopped guest's only action is Start: one button, no menu.
  if (actions.length === 1 && first) {
    return (
      <Button
        size={size}
        className={size === 'md' ? styles.btn : undefined}
        iconStart={<Icon icon={Power} size={14} />}
        disabled={!allowed || busy}
        title={
          allowed ? undefined : (reason ?? 'Starting and stopping guests is switched off for this server.')
        }
        onClick={() => pick(first)}
        aria-label={`${first.label} ${guest.name}`}
      >
        {first.label}
      </Button>
    );
  }
  return (
    <div ref={wrap} className={styles.menuWrap}>
      <Button
        size={size}
        className={size === 'md' ? styles.btn : undefined}
        iconStart={<Icon icon={Power} size={14} />}
        iconEnd={<Icon icon={ChevronDown} size={14} />}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Power for ${guest.name}`}
        disabled={!allowed || busy}
        title={
          allowed ? undefined : (reason ?? 'Starting and stopping guests is switched off for this server.')
        }
        onClick={() => setOpen((o) => !o)}
      >
        Power
      </Button>
      {open ? (
        <div className={styles.menu} role="menu" aria-label={`Power for ${guest.name}`}>
          {actions.map((a) => (
            <button
              key={a.action}
              type="button"
              role="menuitem"
              className={a.serious ? styles.menuSerious : undefined}
              onClick={() => pick(a)}
            >
              {a.label}
            </button>
          ))}
        </div>
      ) : null}
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
    </div>
  );
}
