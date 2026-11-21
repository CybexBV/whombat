/**
 * A Proxmox server's templates under its guest table (ported from Rackoon's `TemplatesList`): “Templates (3)”,
 * collapsed, each with Clone… and Delete… (the guest dialogs; a template is always switched off).
 */
import { type HostTemplate, templateGuest } from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import wc from '../HostFleet.module.css';
import { CloneDialog, DeleteDialog } from './GuestDialogs';

export function TemplatesList({
  burrow,
  serverId,
  canChange,
}: {
  burrow: string;
  serverId: string;
  /** With Manage on: Clone… and Delete…. */
  canChange: boolean;
}) {
  const read = useHostManageRead({ params: { burrow, serverId }, query: { op: 'choices', platform: 'pve' } });
  const list = read.data?.op === 'choices' ? (read.data.choices.templates ?? []) : [];
  const [dialog, setDialog] = useState<{ kind: 'clone' | 'delete'; tpl: HostTemplate } | null>(null);
  if (!list.length) return null;
  const guest = dialog ? templateGuest(dialog.tpl) : null;
  return (
    <details className={wc.wcTemplates}>
      <summary>
        <Icon icon={ChevronRight} size={15} />
        Templates ({list.length})
      </summary>
      <ul className={wc.wcTplList} aria-label="Templates">
        {list.map((t) => {
          const g = templateGuest(t);
          return (
            <li key={t.id} className={wc.wcTplRow}>
              <span>{g.vmid}</span>
              <span>
                {t.name} <span className={wc.wcKind}>{t.kind === 'vm' ? 'VM' : 'CT'} template</span>
              </span>
              {canChange ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'clone', tpl: t })}>
                    Clone…<span className={wc.wcSrOnly}> {t.name}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    style={{ color: 'var(--bad)' }}
                    onClick={() => setDialog({ kind: 'delete', tpl: t })}
                  >
                    Delete…<span className={wc.wcSrOnly}> {t.name}</span>
                  </Button>
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
      {dialog?.kind === 'clone' && guest ? (
        <CloneDialog
          burrow={burrow}
          serverId={serverId}
          guest={guest}
          template
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'delete' && guest ? (
        <DeleteDialog
          burrow={burrow}
          serverId={serverId}
          guest={guest}
          onClose={() => setDialog(null)}
          // The list reads again when the delete's task ends (the task tracker refetches the server's reads).
          onStarted={(taskId) => (taskId ? undefined : void read.refetch())}
        />
      ) : null}
    </details>
  );
}
