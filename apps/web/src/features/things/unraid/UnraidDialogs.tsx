/**
 * The questions before an Unraid change (Whombat incus-unraid.md IU-06; AP-1591, AP-1603): stopping the array (what
 * stops with it), a parity check (corrections off unless ticked), stopping a running check, updating plugins and
 * updating a container from its template. Each says in plain words what happens, then starts the command; a refusal
 * stays in the dialog. One host renders whichever is open, so a tab and its hints share them.
 */
import { arrayStopWords, detailGuests, formatPct, pluginUpdates, unraidDetail } from '@whombat/client/hosts';
import type { HostServerDetail } from '@whombat/core/domain';
import { useState } from 'react';
import { Check, FormDialog } from '../manage/fields';
import { ConfirmDialog } from '../parts';
import styles from '../Things.module.css';
import wu from './Unraid.module.css';
import { useUnraidChange } from './useUnraid';

export type UnraidDialog =
  | { kind: 'stop' }
  | { kind: 'parity' }
  | { kind: 'cancel' }
  | { kind: 'plugins'; file: string }
  | { kind: 'container'; guestId: string };

export function UnraidDialogs({
  burrow,
  detail,
  dialog,
  onClose,
}: {
  burrow: string;
  detail: HostServerDetail;
  dialog: UnraidDialog | null;
  onClose: () => void;
}) {
  if (!dialog) return null;
  const props = { burrow, detail, onClose };
  switch (dialog.kind) {
    case 'stop':
      return <StopArrayDialog {...props} />;
    case 'parity':
      return <ParityCheckDialog {...props} />;
    case 'cancel':
      return <CancelParityDialog {...props} />;
    case 'plugins':
      return <PluginUpdateDialog {...props} file={dialog.file} />;
    case 'container':
      return <ContainerUpdateDialog {...props} guestId={dialog.guestId} />;
  }
}

interface Props {
  burrow: string;
  detail: HostServerDetail;
  onClose: () => void;
}

/** Runs one asked change and keeps a refusal in the dialog. */
function useAsked(burrow: string, detail: HostServerDetail, onClose: () => void) {
  const { run, busy } = useUnraidChange(burrow, detail.server.id);
  const [error, setError] = useState<string | null>(null);
  const go = async (...a: Parameters<typeof run>) => {
    setError(null);
    const out = await run(...a);
    if (out.ok) onClose();
    else setError(out.message);
  };
  return { go, busy, error };
}

function StopArrayDialog({ burrow, detail, onClose }: Props) {
  const u = unraidDetail(detail);
  const name = detail.server.id;
  const { go, busy, error } = useAsked(burrow, detail, onClose);
  return (
    <ConfirmDialog
      open
      title={`Stop the array on ${name}?`}
      body={u ? arrayStopWords(u, detailGuests(detail), name) : undefined}
      confirm="Stop the array"
      serious
      busy={busy}
      error={error}
      onConfirm={() => void go('array.stop', { confirm: true })}
      onClose={onClose}
    />
  );
}

function ParityCheckDialog({ burrow, detail, onClose }: Props) {
  const [correct, setCorrect] = useState(false);
  const { go, busy, error } = useAsked(burrow, detail, onClose);
  return (
    <FormDialog
      title={`Check parity on ${detail.server.id}`}
      description="Unraid reads every disk and compares it with parity. It takes hours and the disks are slower meanwhile; you can pause it."
      action={busy ? 'Starting…' : 'Start the check'}
      busy={busy}
      error={error}
      onClose={onClose}
      onSubmit={() => void go('parity.start', { params: { correct }, correct })}
    >
      <Check
        label="Write corrections to parity"
        checked={correct}
        onChange={setCorrect}
        hint="Only when you know why parity is wrong: it changes parity to match the disks."
      />
    </FormDialog>
  );
}

function CancelParityDialog({ burrow, detail, onClose }: Props) {
  const p = unraidDetail(detail)?.array.parity;
  const { go, busy, error } = useAsked(burrow, detail, onClose);
  return (
    <ConfirmDialog
      open
      title="Stop the parity check?"
      body={`It stops${p?.pct != null ? ` at ${formatPct(p.pct)}` : ''} and starts from the beginning next time. Pause it instead to go on later.`}
      confirm="Stop the check"
      serious
      busy={busy}
      error={error}
      onConfirm={() => void go('parity.cancel', { confirm: true })}
      onClose={onClose}
    />
  );
}

function PluginUpdateDialog({ burrow, detail, onClose, file }: Props & { file: string }) {
  const u = unraidDetail(detail);
  const all = file === 'all';
  const list = u ? (all ? pluginUpdates(u) : u.plugins.filter((p) => p.file === file)) : [];
  const one = list[0];
  const { go, busy, error } = useAsked(burrow, detail, onClose);
  return (
    <ConfirmDialog
      open
      title={
        all
          ? `Update ${list.length === 1 ? 'the plugin' : `${list.length} plugins`} on ${detail.server.id}?`
          : `Update ${one?.name ?? file}?`
      }
      body="Unraid downloads and installs the new version, as its own Plugins page does. A plugin may restart what it runs."
      confirm={all && list.length > 1 ? 'Update all' : 'Update'}
      busy={busy}
      error={error}
      onConfirm={() =>
        void go('plugin.update', {
          params: { plugin: file },
          confirm: true,
          target: all ? 'all' : (one?.name ?? file),
        })
      }
      onClose={onClose}
    >
      {list.length ? (
        <ul className={styles.review}>
          {list.map((p) => (
            <li key={p.file}>
              <b>{p.name}</b>
              <span className={styles.old}>{p.version}</span>
              <span>→ {p.update ?? p.version}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </ConfirmDialog>
  );
}

function ContainerUpdateDialog({ burrow, detail, onClose, guestId }: Props & { guestId: string }) {
  const g = detailGuests(detail).find((x) => x.id === guestId);
  const name = g?.name ?? guestId.replace(/^docker:/, '');
  const { go, busy, error } = useAsked(burrow, detail, onClose);
  return (
    <ConfirmDialog
      open
      title={`Update ${name}?`}
      body={
        <>
          Unraid pulls the new image and makes the container again from its template, as its own Docker page
          does. {g?.state === 'running' ? `${name} is down for a minute.` : `${name} stays stopped.`}
        </>
      }
      confirm="Update"
      busy={busy}
      error={error}
      onConfirm={() => void go('container.update', { guestId, confirm: true, target: name })}
      onClose={onClose}
    >
      {g?.image ? <p className={wu.wuDialogNote}>{g.image}</p> : null}
    </ConfirmDialog>
  );
}
