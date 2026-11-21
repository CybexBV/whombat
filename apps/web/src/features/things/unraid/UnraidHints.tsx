/**
 * What is worth a look on an Unraid server, each with its way out (Whombat incus-unraid.md IU-08; AP-1598; ONE-07: a
 * hint without an action is noise): the array stopped → Start the array, parity errors or an old check → Check parity,
 * disk errors and a full pool → Array, plugin updates → Update all, an Unraid alert → Archive, a newer Unraid → Update in
 * Unraid (its own page), a container update → Update it. The Summary leaves out what its own cards already show with
 * their way out (notifications, plugins, Unraid, containers); a tab shows the hints of its section.
 */
import { detailGuests, type UnraidHintFix, unraidHintFixes, unraidPageUrl } from '@whombat/client/hosts';
import type { HostHint, HostServerDetail } from '@whombat/core/domain';
import { ExternalLink } from 'lucide-react';
import { Button, ButtonLink } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import wc from '../HostFleet.module.css';
import { Card, Dot } from '../parts';
import { useThingSearch } from '../search';
import type { UnraidDialog } from './UnraidDialogs';
import { useUnraidAccess, useUnraidChange } from './useUnraid';

/** Hints the Summary's own cards carry (with the same way out). */
const ON_SUMMARY_CARDS = new Set([
  'unraid.notification',
  'unraid.plugin_updates',
  'unraid.os_update',
  'docker.update_available',
]);

export function UnraidHints({
  burrow,
  detail,
  section,
  onDialog,
}: {
  burrow: string;
  detail: HostServerDetail;
  /** Only this section's hints (a tab); without it the Summary's. */
  section?: 'array';
  onDialog: (d: UnraidDialog) => void;
}) {
  const [, set] = useThingSearch();
  const access = useUnraidAccess(burrow, detail);
  const { run, busy } = useUnraidChange(burrow, detail.server.id);
  const guests = detailGuests(detail);
  const hints = detail.hints.filter(
    (h) =>
      h.serverId === detail.server.id &&
      (section ? h.section === section || h.section === 'storage' : !ON_SUMMARY_CARDS.has(h.kind)),
  );
  if (!hints.length) return null;
  const ctx = { guests, updateUrl: unraidPageUrl(detail, 'Tools/Update'), canManage: access.can };
  const act = (f: UnraidHintFix) => {
    switch (f.kind) {
      case 'tab':
        return set({ tab: f.tab }, { replace: true });
      case 'guest':
        return set({ guest: f.guestId });
      case 'start_array':
        return void run('array.start', { inline: false });
      case 'check_parity':
        return onDialog({ kind: 'parity' });
      case 'update_plugins':
        return onDialog({ kind: 'plugins', file: 'all' });
      case 'update_container':
        return onDialog({ kind: 'container', guestId: f.guestId });
      case 'archive':
        return void run('notification.archive', { params: { id: f.id }, target: f.id, inline: false });
      default:
        return undefined;
    }
  };
  return (
    <Card title="Worth a look" meta={hints.length === 1 ? '1 thing' : `${hints.length} things`}>
      <div>
        {hints.map((h: HostHint) => {
          const fixes = unraidHintFixes(h, ctx);
          return (
            <div key={`${h.kind}:${h.entity}`} className={wc.wcHint}>
              <span style={{ paddingTop: 6 }}>
                <Dot
                  tone={h.severity === 'warning' ? 'warn' : 'mut'}
                  label={h.severity === 'warning' ? 'Warning' : 'Note'}
                />
              </span>
              <div className={wc.wcHintMain}>
                <b>{h.title}</b>
                {h.detail ? <span>{h.detail}</span> : null}
              </div>
              {fixes.length ? (
                <div className={wc.wcHintActs}>
                  {fixes.map((f) =>
                    f.kind === 'link' ? (
                      <ButtonLink
                        key={f.label}
                        size="sm"
                        href={f.href}
                        target="_blank"
                        rel="noreferrer"
                        iconEnd={<Icon icon={ExternalLink} size={13} />}
                      >
                        {f.label}
                      </ButtonLink>
                    ) : (
                      <Button key={f.label} size="sm" disabled={busy} onClick={() => act(f)}>
                        {f.label}
                      </Button>
                    ),
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
