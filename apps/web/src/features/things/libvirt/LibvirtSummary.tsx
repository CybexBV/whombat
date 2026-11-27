/**
 * A libvirt VM's Summary (Whombat incus-unraid.md IU-13; AP-1650): why the settings tabs are missing when Manage is off
 * (with the way to Agent settings), the libvirt hint about this VM with its way out (no backup or snapshot in 30 days →
 * Back up now), Autostart (stream WU's card), the Proxmox summary's four figures and history, the facts people look for
 * (system, addresses, disks with where they live, the disc in its drive, firmware, autostart, the last backup,
 * snapshots, changes waiting for its next start) and its notes with Edit.
 */
import {
  DASH,
  firmwareWords,
  formatBytesBinary,
  formatRelativeDay,
  isUnraidServer,
  keyOrder,
  keysOf,
  LV_CDROM_RE,
  libvirtGuestHints,
  lvCdromWords,
  lvSourcePlace,
  pendingKeys,
  readLvDisk,
  tpmWords,
} from '@whombat/client/hosts';
import type { HostGuestDetail, HostServerDetail } from '@whombat/core/domain';
import { Info } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { currentLocale } from '../../../i18n/provider';
import type { EditCtx } from '../guest/EditDialog';
import { Figures, HintLine, History } from '../guest/GuestSummary';
import { TextKeyDialog } from '../guest/OptionsTab';
import { Card, Dot, Empty } from '../parts';
import { useThingSearch } from '../search';
import styles from '../Things.module.css';
import { UnraidGuestCard } from '../unraid/UnraidGuests';
import wb from '../wb.module.css';

interface Fact {
  id: string;
  k: string;
  v: ReactNode;
  sub?: ReactNode;
  tone?: 'ok' | 'warn' | 'bad';
}

export function LibvirtSummary({
  burrow,
  serverId,
  guest: g,
  detail,
  ctx,
  reason,
  timeZone,
  onBackup,
  onPending,
}: {
  burrow: string;
  serverId: string;
  guest: HostGuestDetail;
  detail: HostServerDetail;
  ctx: EditCtx | null;
  /** Why the settings tabs aren't there (Manage off, an older Whombat). */
  reason: string | null;
  timeZone?: string;
  onBackup: (() => void) | null;
  onPending: () => void;
}) {
  const [, set] = useThingSearch();
  const [notes, setNotes] = useState(false);
  const on = g.state === 'running' || g.state === 'unhealthy';
  const now = Date.parse(detail.asOf);
  const cfg = ctx?.config;
  const hints = libvirtGuestHints(detail.hints, g);
  const v = cfg?.values ?? {};

  const facts: Fact[] = [];
  if (g.image) facts.push({ id: 'image', k: 'System', v: g.image });
  facts.push({ id: 'addresses', k: 'Addresses', v: g.addresses?.join(', ') || DASH });
  const disks = (cfg?.disks ?? []).filter((d) => d.media !== 'cdrom').sort((a, b) => keyOrder(a.key, b.key));
  if (disks.length)
    facts.push({
      id: 'disks',
      k: disks.length === 1 ? 'Disk' : 'Disks',
      v: disks
        .map((d) => {
          const target = readLvDisk(v[d.key]).target || d.key;
          return `${target} ${d.sizeBytes ? formatBytesBinary(d.sizeBytes) : ''}`.trim();
        })
        .join(' · '),
      sub:
        [
          ...new Set(
            disks.map((d) => lvSourcePlace(readLvDisk(v[d.key]).source) || d.storage).filter(Boolean),
          ),
        ].join(', ') || undefined,
    });
  const discs = keysOf(cfg, LV_CDROM_RE).filter((k) => lvCdromWords(v[k]) !== 'No disc');
  if (discs.length)
    facts.push({ id: 'cdrom', k: 'In the drive', v: discs.map((k) => lvCdromWords(v[k])).join(', ') });
  if (cfg)
    facts.push({
      id: 'firmware',
      k: 'Firmware',
      v: firmwareWords(v),
      sub: v.tpm ? tpmWords(v.tpm) : undefined,
    });
  facts.push({ id: 'node', k: 'Runs on', v: g.node ?? g.serverId });
  if (g.autostart != null || cfg)
    facts.push({
      id: 'autostart',
      k: 'Starts with it',
      v: (cfg ? v.autostart === '1' : g.autostart) ? 'Yes' : 'No',
    });
  if (g.lastBackup) {
    const ok = g.lastBackup.result === 'ok';
    facts.push({
      id: 'backup',
      k: 'Last backup',
      v: `${formatRelativeDay(Date.parse(g.lastBackup.at), now, timeZone, currentLocale())} · ${ok ? 'went fine' : g.lastBackup.result}`,
      tone: ok ? 'ok' : 'bad',
    });
  } else if (cfg) facts.push({ id: 'backup', k: 'Last backup', v: 'None yet' });
  if (g.snapshots != null)
    facts.push({
      id: 'snapshots',
      k: 'Snapshots',
      v: String(g.snapshots),
      sub: g.oldestSnapshot ? oldestText(Date.parse(g.oldestSnapshot), now) : undefined,
    });
  const pending = cfg ? pendingKeys(cfg).length : (g.pendingChanges ?? 0);
  if (pending > 0)
    facts.push({
      id: 'pending',
      k: 'Waiting for its next start',
      v: ctx ? (
        <button type="button" className={styles.cardLink} style={{ marginLeft: 0 }} onClick={onPending}>
          {pending === 1 ? '1 change' : `${pending} changes`}
        </button>
      ) : pending === 1 ? (
        '1 change'
      ) : (
        `${pending} changes`
      ),
      sub: 'They apply once it’s been shut down and started again.',
      tone: 'warn',
    });

  return (
    <>
      {reason ? (
        <p className={wb.wbNote}>
          <Icon icon={Info} size={16} />
          <span>
            Settings, backups and tasks aren’t here: {reason.replace(/\.$/, '')}.{' '}
            <button
              type="button"
              className={styles.cardLink}
              onClick={() => set({ guest: undefined, gtab: undefined, tab: 'system' })}
            >
              Agent settings
            </button>
          </span>
        </p>
      ) : null}
      {hints.map((h) => (
        <HintLine
          key={h.kind}
          hint={{
            kind: h.kind,
            tone: h.severity === 'warning' ? 'warn' : 'mut',
            title: `${g.name} has no backup or snapshot from the last 30 days`,
            detail: 'If its disk breaks or an update goes wrong, there’s nothing to go back to.',
            action: 'Back up now',
            fix: 'backup_now',
          }}
          action={onBackup ? 'Back up now' : null}
          onFix={() => onBackup?.()}
        />
      ))}
      <UnraidGuestCard burrow={burrow} detail={detail} guest={g} onUnraid={isUnraidServer(detail)} />
      <Figures guest={g} on={on} />
      <History burrow={burrow} serverId={serverId} guest={g} timeZone={timeZone} />
      <div className={wb.wbSplit}>
        <Card title="Details">
          <div className={styles.rows}>
            {facts.map((f) => (
              <div key={f.id} id={`wq-fact-${f.id}`} className={cx(styles.row, wb.wbFact)}>
                <span className={wb.wbFactKey}>{f.k}</span>
                <span className={wb.wbFactValue}>
                  <span className={wb.wbFactLine}>
                    {f.tone ? <Dot tone={f.tone} /> : null}
                    {f.v}
                  </span>
                  {f.sub ? <small>{f.sub}</small> : null}
                </span>
              </div>
            ))}
          </div>
        </Card>
        {cfg ? (
          <Card
            title="Notes"
            link={
              ctx && !g.self ? (
                <button
                  type="button"
                  className={styles.cardLink}
                  style={{ marginLeft: 'auto' }}
                  onClick={() => setNotes(true)}
                >
                  {v.description ? 'Edit' : 'Add'}
                  <span className={styles.srOnly}> notes</span>
                </button>
              ) : undefined
            }
          >
            {v.description ? (
              <p className={wb.wbNotes}>{v.description}</p>
            ) : (
              <Empty>No notes yet. virt-manager and Unraid show them too.</Empty>
            )}
          </Card>
        ) : null}
      </div>
      {notes && ctx ? (
        <TextKeyDialog
          ctx={ctx}
          k="description"
          label="Notes"
          multiline
          hint="Plain text; virt-manager and Unraid show it too."
          onClose={() => setNotes(false)}
        />
      ) : null}
    </>
  );
}

/** “The oldest is 45 days old”. */
function oldestText(at: number, now: number): string {
  const days = Math.floor((now - at) / 86_400_000);
  return days < 1 ? 'The oldest is from today' : `The oldest is ${days === 1 ? 'a day' : `${days} days`} old`;
}
