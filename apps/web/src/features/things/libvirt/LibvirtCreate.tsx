/**
 * A new libvirt VM (Whombat incus-unraid.md IU-13; AP-1661, AP-1662): the OS type first — its preset sets the firmware,
 * a TPM, the disk bus and sizes (Windows 11: UEFI with Secure Boot, a TPM 2.0, SATA; refused with a plain reason when
 * the server has no OVMF or swtpm) —, then CPU and memory, the disk and where it goes (a pool, or Unraid's VM folder),
 * the ISO to install from (Get an ISO… downloads one), the network or host bridge, and whether it starts. Made as a task;
 * the new VM's page opens when it's done (PX-05). `NewVmButton` is the Guests tab's way in, on every server with libvirt.
 */
import {
  formatBytesBinary,
  gibHint,
  hasErrors,
  isoTargets,
  LIBVIRT_CREATE_ERROR_FIELDS,
  type LibvirtCreateErrors,
  type LibvirtCreateForm,
  libvirtCreateErrors,
  libvirtCreateParams,
  libvirtDefaults,
  libvirtIsos,
  lvLinkOptions,
  osVariantNote,
  osVariantsOf,
  storageWord,
  withOsVariant,
} from '@whombat/client/hosts';
import { useHostManageRead } from '@whombat/client/hosts/react';
import type { HostChoices, HostServerDetail } from '@whombat/core/domain';
import { Plus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { Modal, ModalTitle } from '../../../components/Modal';
import wc from '../HostFleet.module.css';
import { Check, FormDialog, Section, SelectField, TextField } from '../manage/fields';
import { ErrorLine, Skeleton } from '../parts';
import styles from '../Things.module.css';
import { IsoDownloadDialog } from './LibvirtStorage';
import { useLibvirtAccess, useLibvirtManage } from './useLibvirt';

/** “New VM” in a Guests tab's head: Manage on, a Whombat with `hosts.libvirt`, a host that runs libvirt. */
export function NewVmButton({ burrow, detail }: { burrow: string; detail: HostServerDetail }) {
  const access = useLibvirtAccess(burrow, detail);
  const [open, setOpen] = useState(false);
  if (!access.can || !detail.libvirt) return null;
  return (
    <>
      <Button size="sm" iconStart={<Icon icon={Plus} size={14} />} onClick={() => setOpen(true)}>
        New VM
      </Button>
      {open ? <LibvirtCreateDialog burrow={burrow} detail={detail} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function LibvirtCreateDialog({
  burrow,
  detail,
  onClose,
}: {
  burrow: string;
  detail: HostServerDetail;
  onClose: () => void;
}) {
  const serverId = detail.server.id;
  const read = useHostManageRead({
    params: { burrow, serverId },
    query: { op: 'choices', platform: 'libvirt' },
  });
  const choices = read.data?.op === 'choices' ? read.data.choices : undefined;
  if (!choices)
    return (
      <Modal open onOpenChange={(o) => !o && onClose()} width="lg">
        <ModalTitle className={styles.dialogTitle}>New virtual machine</ModalTitle>
        {read.error ? (
          <ErrorLine error={read.error} onRetry={() => void read.refetch()} />
        ) : (
          <Skeleton height={320} />
        )}
      </Modal>
    );
  return <CreateForm burrow={burrow} detail={detail} choices={choices} onClose={onClose} />;
}

function Row({ children, cols }: { children: ReactNode; cols?: number }) {
  return (
    <div
      className={styles.formRow}
      style={cols ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}
    >
      {children}
    </div>
  );
}

function CreateForm({
  burrow,
  detail,
  choices,
  onClose,
}: {
  burrow: string;
  detail: HostServerDetail;
  choices: HostChoices;
  onClose: () => void;
}) {
  const serverId = detail.server.id;
  const [f, setF] = useState<LibvirtCreateForm>(() => libvirtDefaults(choices));
  const [errors, setErrors] = useState<LibvirtCreateErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [getIso, setGetIso] = useState(false);
  const { send, busy } = useLibvirtManage(burrow, serverId);
  const set = <K extends keyof LibvirtCreateForm>(k: K, v: LibvirtCreateForm[K]) => {
    setF((x) => ({ ...x, [k]: v }));
    setErrors((e) => (e[k] ? { ...e, [k]: undefined } : e));
  };
  const variants = osVariantsOf(choices);
  const isos = libvirtIsos(choices.isos);
  const variant = variants.find((v) => v.id === f.osVariant);
  const note = osVariantNote(variant, choices.firmware ?? detail.libvirt?.firmware);
  const links = lvLinkOptions(choices);
  const canGetIso = isoTargets(detail.libvirt).length > 0;
  const submit = () => {
    const errs = libvirtCreateErrors(f);
    setErrors(errs);
    if (hasErrors(errs) || note?.blocked) return;
    void (async () => {
      setError(null);
      const out = await send({ op: 'guest.create', params: libvirtCreateParams(f), name: f.name.trim() });
      if (out.ok) return onClose();
      const mapped: LibvirtCreateErrors = {};
      for (const [k, v] of Object.entries(out.fields)) {
        const field = LIBVIRT_CREATE_ERROR_FIELDS[k];
        if (field) mapped[field] = v;
      }
      setErrors(mapped);
      setError(Object.keys(mapped).length ? 'Some fields need a look.' : out.message);
    })();
  };
  return (
    <>
      <FormDialog
        title="New virtual machine"
        description={`Made on ${serverId} with libvirt. You can change everything later on its page.`}
        action={busy ? 'Creating…' : 'Create VM'}
        busy={busy}
        disabled={note?.blocked}
        error={error}
        onSubmit={submit}
        onClose={onClose}
        width="lg"
      >
        <Section title="General">
          <Row cols={2}>
            <TextField
              label="Name"
              mono
              value={f.name}
              autoFocus
              placeholder="web-02"
              error={errors.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </Row>
        </Section>
        <Section title="OS">
          <Row>
            <SelectField
              label="OS type"
              value={f.osVariant}
              options={variants.map((v) => ({ value: v.id, label: v.label }))}
              error={note?.blocked ? note.text : errors.osVariant}
              hint={note && !note.blocked ? note.text : undefined}
              onChange={(e) => {
                const id = e.target.value;
                setF((x) => withOsVariant(x, id, isos));
              }}
            />
            <SelectField
              label="Install from"
              value={f.iso}
              error={errors.iso}
              options={[
                { value: '', label: 'No ISO (an empty drive)' },
                ...isos.map((i) => ({
                  value: i.volid,
                  label: `${i.name}${i.sizeBytes != null ? ` · ${formatBytesBinary(i.sizeBytes)}` : ''}`,
                  group: storageWord(i.place),
                })),
              ]}
              hint={
                canGetIso ? (
                  <>
                    {isos.length ? null : 'No ISO images on this server yet. '}
                    <button type="button" className={wc.wcInlineLink} onClick={() => setGetIso(true)}>
                      Get an ISO…
                    </button>
                  </>
                ) : isos.length ? undefined : (
                  'No ISO images on this server yet.'
                )
              }
              onChange={(e) => set('iso', e.target.value)}
            />
          </Row>
        </Section>
        <Section title="CPU and memory">
          <Row>
            <TextField
              label="vCPUs"
              inputMode="numeric"
              value={f.vcpus}
              error={errors.vcpus}
              onChange={(e) => set('vcpus', e.target.value)}
            />
            <TextField
              label="Memory (MiB)"
              inputMode="numeric"
              value={f.memoryMb}
              error={errors.memoryMb}
              hint={gibHint(f.memoryMb)}
              onChange={(e) => set('memoryMb', e.target.value)}
            />
          </Row>
        </Section>
        <Section title="Disk">
          <Row>
            <SelectField
              label="On"
              value={f.storage}
              error={errors.storage}
              options={
                choices.storages.length
                  ? choices.storages.map((s) => ({
                      value: s.id,
                      label: `${storageWord(s.id)}${s.availBytes != null ? ` · ${formatBytesBinary(s.availBytes)} free` : ''}`,
                    }))
                  : [{ value: '', label: 'Nowhere to put it' }]
              }
              onChange={(e) => set('storage', e.target.value)}
            />
            <TextField
              label="Size (GiB)"
              inputMode="numeric"
              value={f.diskGb}
              error={errors.diskGb}
              hint={
                /^win/.test(f.osVariant)
                  ? 'On SATA, so Windows sees it without drivers.'
                  : 'On VirtIO, qcow2.'
              }
              onChange={(e) => set('diskGb', e.target.value)}
            />
          </Row>
        </Section>
        <Section title="Network">
          <Row cols={2}>
            <SelectField
              label="Connects to"
              value={f.link}
              error={errors.link}
              options={links.length ? links : [{ value: '', label: 'None found' }]}
              hint={
                f.link.startsWith('bridge:')
                  ? 'It joins the host’s network and gets an address from your router.'
                  : 'libvirt’s network: it reaches out through the host.'
              }
              onChange={(e) => set('link', e.target.value)}
            />
          </Row>
        </Section>
        <div className={wc.wcChecks}>
          <Check label="Start it once it’s made" checked={f.start} onChange={(v) => set('start', v)} />
          <Check
            label="Start when the server starts"
            checked={f.autostart}
            onChange={(v) => set('autostart', v)}
          />
        </div>
      </FormDialog>
      {getIso ? (
        <IsoDownloadDialog
          burrow={burrow}
          serverId={serverId}
          detail={detail}
          onClose={() => setGetIso(false)}
        />
      ) : null}
    </>
  );
}
