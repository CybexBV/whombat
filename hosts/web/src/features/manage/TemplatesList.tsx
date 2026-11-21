// Templates of a Proxmox host under its guest table (docs/MANAGE.md,
// Create): "Templates (n)", collapsed, with Clone… and Delete… for admins.

import { useState } from 'react';
import { type TemplateGuest, useChoices } from '../../api/manage';
import { DASH, formatGb } from '../../lib/format';
import { t } from '../../lib/i18n';
import { CloneDialog, DeleteGuestDialog, type GuestRef } from './LifecycleDialogs';

const refOf = (x: TemplateGuest): GuestRef => ({ id: `pve:${x.id}`, name: x.name, kind: x.kind, state: 'stopped', platform: 'pve', vmid: Number(x.id) });

export function TemplatesList({ serverId, kind, isAdmin }: { serverId: string; kind: 'vm' | 'container'; isAdmin: boolean }) {
  const choices = useChoices(serverId, 'pve');
  const [dialog, setDialog] = useState<{ kind: 'clone' | 'delete'; tpl: TemplateGuest } | null>(null);
  const list = (choices.data?.templates ?? []).filter((x) => x.kind === kind);
  if (!list.length) return null;
  return (
    <details className="lc-templates">
      <summary>{t('Templates ({n})', { n: list.length })}</summary>
      <ul className="plain-list" aria-label={t('Templates')}>
        {list.map((x) => (
          <li key={x.id} className="lc-tpl-row">
            <span className="mono ink-3 lc-tpl-id">{x.id}</span>
            <span className="mono ellipsis">{x.name}</span>
            <span className="lbl">{x.disk_bytes ? formatGb(x.disk_bytes / 1e9) : DASH}</span>
            {isAdmin && (
              <span className="row-tools">
                <button type="button" className="btn-ghost row-action" onClick={() => setDialog({ kind: 'clone', tpl: x })}>
                  {t('Clone…')}
                  <span className="sr-only"> {x.name}</span>
                </button>
                <button type="button" className="btn-ghost row-action is-serious" onClick={() => setDialog({ kind: 'delete', tpl: x })}>
                  {t('Delete…')}
                  <span className="sr-only"> {x.name}</span>
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {dialog?.kind === 'clone' && <CloneDialog serverId={serverId} guest={refOf(dialog.tpl)} template onClose={() => setDialog(null)} />}
      {dialog?.kind === 'delete' && <DeleteGuestDialog serverId={serverId} guest={refOf(dialog.tpl)} template onClose={() => setDialog(null)} />}
    </details>
  );
}
