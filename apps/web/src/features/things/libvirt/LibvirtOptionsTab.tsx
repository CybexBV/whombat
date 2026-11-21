/**
 * A libvirt VM's Options (Whombat incus-unraid.md IU-13; AP-1652): its name (renamed while it's stopped), title, whether
 * it starts with the server, what happens when it switches itself off, restarts or crashes, and its notes — each
 * through the Proxmox review, reusing the Proxmox Options dialogs (`TextKeyDialog`, `SelectKeyDialog`).
 */
import {
  isRestricted,
  LIBVIRT_LATER,
  POWER_EVENT_ACTIONS,
  powerEventWords,
  rowValue,
} from '@whombat/client/hosts';
import { type ReactNode, useState } from 'react';
import { EditBtn, Row } from '../guest/editParts';
import { SelectKeyDialog } from '../guest/hardwareDialogs';
import { TextKeyDialog } from '../guest/OptionsTab';
import { Card } from '../parts';
import styles from '../Things.module.css';
import type { LibvirtTabProps } from './LibvirtHardwareTab';

interface Spec {
  key: string;
  title: string;
  show: (v: string | undefined) => string;
  rich?: (v: string | undefined) => ReactNode;
  dialog: ReactNode;
  muted?: boolean;
  mono?: boolean;
  /** Its own words for the action (Rename…). */
  text?: string;
}

export function LibvirtOptionsTab({
  ctx,
  lockPlace,
  readOnly,
  onRename,
}: LibvirtTabProps & { onRename: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const cfg = ctx.config;
  const v = cfg.values;
  const name = ctx.guest.name;
  const close = () => setOpen(null);
  const p = { ctx, onClose: close };
  const event = (key: string, title: string, fallback: string, hint: string): Spec => ({
    key,
    title,
    show: (x) => powerEventWords(x, fallback),
    dialog: (
      <SelectKeyDialog
        {...p}
        k={key}
        title={`${title} (${name})`}
        label="Then"
        options={POWER_EVENT_ACTIONS}
        read={(x) => x ?? fallback}
        write={(x) => x}
        hint={() => hint}
      />
    ),
  });
  const rows: Spec[] = [
    {
      key: 'name',
      title: 'Name',
      show: (x) => x ?? name,
      mono: true,
      text: 'Rename…',
      dialog: null,
    },
    {
      key: 'title',
      title: 'Title',
      show: (x) => x || 'None',
      muted: !v.title,
      dialog: (
        <TextKeyDialog
          {...p}
          k="title"
          label="Title"
          hint="A short line virt-manager and Unraid show next to its name."
        />
      ),
    },
    {
      key: 'autostart',
      title: 'Start with the server',
      show: (x) => (x === '1' ? 'Yes' : 'No'),
      dialog: (
        <SelectKeyDialog
          {...p}
          k="autostart"
          title={`Start ${name} with the server?`}
          label="Starts when the server starts"
          options={[
            { value: '0', label: 'No' },
            { value: '1', label: 'Yes' },
          ]}
          read={(x) => x ?? '0'}
          write={(x) => x}
        />
      ),
    },
    event(
      'on_poweroff',
      'When it switches itself off',
      'destroy',
      'What libvirt does when the system inside shuts down.',
    ),
    event('on_reboot', 'When it restarts', 'restart', 'What libvirt does when the system inside restarts.'),
    event('on_crash', 'When it crashes', 'destroy', 'What libvirt does when the VM crashes.'),
    {
      key: 'description',
      title: 'Notes',
      show: (x) => (x ? (x.length > 60 ? `${x.slice(0, 60)}…` : x) : 'None'),
      rich: (x) => (x ? <span style={{ fontWeight: 400, whiteSpace: 'pre-wrap' }}>{x}</span> : 'None'),
      muted: !v.description,
      dialog: (
        <TextKeyDialog
          {...p}
          k="description"
          label="Notes"
          multiline
          hint="Plain text; virt-manager and Unraid show it too."
        />
      ),
    },
  ];
  const shown = open ? rows.find((r) => r.key === open) : undefined;
  return (
    <>
      <Card title="Options">
        <div className={styles.rows}>
          {rows.map((r) => {
            const rv = rowValue(cfg, r.key);
            return (
              <Row
                key={r.key}
                title={r.title}
                value={r.rich ? r.rich(v[r.key]) : r.show(v[r.key])}
                mono={r.mono}
                muted={r.muted}
                next={rv.next === undefined ? undefined : r.show(rv.removed ? undefined : rv.next)}
                later={LIBVIRT_LATER}
                locked={isRestricted(cfg, r.key) ? lockPlace : undefined}
                action={
                  readOnly ? undefined : (
                    <EditBtn
                      label={r.title.toLowerCase()}
                      text={r.text}
                      onClick={() => (r.key === 'name' ? onRename() : setOpen(r.key))}
                    />
                  )
                }
              />
            );
          })}
        </div>
      </Card>
      {shown?.dialog ?? null}
    </>
  );
}
