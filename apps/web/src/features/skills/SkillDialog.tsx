import { ApiError } from '@whombat/client';
import {
  skillLibraryEndpoints as E,
  fileBytes,
  hubRefusalWords,
  removeAsk,
  type SkillLibrary,
  skillPanel,
  SKILL_LIBRARY_TEXT as T,
} from '@whombat/client/skill-library';
import {
  useSkillHubUpdate,
  useSkillLibraryFile,
  useSkillLibrarySkill,
  useSkillLibraryWrite,
} from '@whombat/client/skill-library/react';
import { X } from 'lucide-react';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { LoadErrorNote } from '../../app/runtime';
import { Button, IconButton } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { SkeletonRows } from '../../components/ListState';
import { Modal, ModalTitle } from '../../components/Modal';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import { TextDiff } from '../branch/FileView';
import { CodeBlock } from '../messaging/CodeBlock';
import { RichText } from '../messaging/RichText';
import { SkillEditor } from './SkillEditor';
import styles from './Skills.module.css';
import type { SkillRef } from './SkillsLibraryTab';
import { SKILLS_WORDS as W } from './skillsWords';

export interface SkillDialogProps {
  burrow: string;
  library: SkillLibrary;
  skill: SkillRef;
  timeZone: string;
  /** Hub skills Hermes's last update check found a newer version of (HSK-09). */
  updates?: ReadonlySet<string>;
  onClose: () => void;
}

/** What the footer asks before it acts. */
type Asking = 'restore' | 'update' | 'remove' | null;

/**
 * The open skill, in a dialog over the list (Whombat hermes-skills.md HSK-02, HSK-09…HSK-11, hermes-engine.md HE-41;
 * contracts 3.0 CT-1570…CT-1572; app AP-5536…AP-5541, one-person.md AP-5710): its name, its category and where it
 * came from (“Productivity · Added from Hermes”, “Note taking · Changed”, “Learned by Dusty”), what it does, what it
 * needs, when it was learned, changed or added, the switch, the rendered SKILL.md and its files; in the footer, which
 * stays in view, **Edit**, **Compare** (Hermes's version of a changed built-in, file by file), **Restore Hermes’s** (a
 * changed or removed built-in), **Update** (a hub skill with a newer version) and **Remove** (a hub skill is
 * uninstalled, a built-in stays removed until restored, a learned one is forgotten), each asking first where it can't be
 * undone. Esc, × or a click beside it closes it; while editing only × or Cancel does, so a slip doesn't lose the
 * changes.
 */
export function SkillDialog({ burrow, library, skill, timeZone, updates, onClose }: SkillDialogProps) {
  const toast = useToast();
  const read = useSkillLibrarySkill({ params: { burrow }, query: { name: skill.name } });
  const detail = read.data;
  const agent = library.agentName;
  const [editing, setEditing] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [asking, setAsking] = useState<Asking>(null);
  const [file, setFile] = useState<string | null>(null);
  const toggle = useSkillLibraryWrite(E.switch, burrow);
  const restore = useSkillLibraryWrite(E.restore, burrow);
  const remove = useSkillLibraryWrite(E.remove, burrow);
  const update = useSkillHubUpdate(burrow);
  // The library's row is the freshest (a switch flips it at once); the detail's while the list is reading.
  const item = library.items.find((i) => i.name === skill.name) ?? detail?.item;
  const panel = useMemo(
    () =>
      detail && item
        ? skillPanel(
            { ...detail, item },
            { now: Date.now(), timeZone, categories: library.categories, updates, agent },
          )
        : null,
    [detail, item, timeZone, library.categories, updates, agent],
  );

  async function run(action: () => Promise<{ status: string }>, done?: string) {
    try {
      const r = await action();
      if (r.status !== 'ok') toast.show(W.notChanged);
      else if (done) toast.show(done);
      return r.status === 'ok';
    } catch (error) {
      toast.show(
        (item && hubRefusalWords(error, item.name)) ??
          (error instanceof ApiError && error.message ? error.message : W.notChanged),
      );
      return false;
    }
  }

  let body: ReactNode;
  if (!detail || !panel || !item) {
    body = (
      <div className={styles.skillScroll}>
        {read.error ? (
          <LoadErrorNote error={read.error} message={W.openError} onRetry={() => void read.refetch()} />
        ) : (
          <div aria-busy="true">
            <SkeletonRows count={5} lines={1} />
          </div>
        )}
      </div>
    );
  } else if (editing) {
    body = (
      <SkillEditor
        burrow={burrow}
        detail={{ ...detail, item }}
        body={panel.body}
        marksChanged={item.origin === 'builtin' && !item.changed}
        onDone={() => setEditing(false)}
      />
    );
  } else {
    const question =
      asking === 'restore'
        ? item.status === 'removed'
          ? T.restoreRemovedAsk(item.name, agent)
          : T.restoreAsk(item.name)
        : asking === 'update'
          ? T.updateAsk(item.name)
          : asking === 'remove' && panel.removeKind
            ? removeAsk(panel.removeKind, item.name, agent)
            : null;
    const confirmLabel = asking === 'restore' ? T.restore : asking === 'update' ? T.update : T.remove;
    const busy = restore.isPending || remove.isPending || update.isPending;
    const confirm = async () => {
      if (!item || !panel) return;
      if (asking === 'restore') {
        await run(
          () => restore.mutateAsync({ params: { burrow }, body: { name: item.name } }),
          T.restored(item.name),
        );
        return setAsking(null);
      }
      if (asking === 'update') {
        await run(() => update.mutateAsync({ name: item.name }), T.updated(item.name));
        return setAsking(null);
      }
      if (asking === 'remove') {
        const ok = await run(
          () => remove.mutateAsync({ params: { burrow }, body: { name: item.name } }),
          T.removed(item.name),
        );
        setAsking(null);
        if (ok) onClose();
      }
    };
    body = (
      <>
        <div className={styles.skillScroll}>
          <p className={styles.panelDescription}>{panel.description}</p>
          {panel.lines.length > 0 && (
            <ul className={styles.lines}>
              {panel.lines.map((line) => (
                <li key={line} className={line === T.updateLine ? styles.warn : undefined}>
                  {line}
                </li>
              ))}
            </ul>
          )}
          {panel.originalChanged && (
            <p className={styles.changedNote}>
              {panel.originalChanged}
              <Button variant="link" size="sm" onClick={() => setComparing(true)}>
                {panel.compareLabel}
              </Button>
            </p>
          )}
          {panel.canSwitch && (
            <SwitchRow
              label={T.uses(agent)}
              on={panel.on}
              onChange={(next) =>
                void run(() =>
                  toggle.mutateAsync({ params: { burrow }, body: { name: item.name, on: next } }),
                )
              }
            />
          )}
          <div className={styles.body}>
            <RichText text={panel.shownBody} />
          </div>
          {detail.files.length > 0 && (
            <div>
              <SectionLabel as="h4" className={styles.sublabel}>
                {W.files}
              </SectionLabel>
              <ul className={styles.files}>
                {detail.files.map((f) => (
                  <li key={f.path}>
                    <button type="button" className={styles.fileButton} onClick={() => setFile(f.path)}>
                      <span>{f.path}</span>
                      <span className={styles.fileSize}>{fileBytes(f.bytes)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className={styles.skillFoot}>
          {question ? (
            <fieldset className={styles.confirm} aria-label={confirmLabel}>
              <span>{question}</span>
              <span className={styles.confirmActions}>
                <Button variant="primary" size="sm" disabled={busy} onClick={() => void confirm()}>
                  {confirmLabel}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setAsking(null)}>
                  {W.cancel}
                </Button>
              </span>
            </fieldset>
          ) : (
            <>
              {panel.canUpdate && (
                <Button variant="primary" size="sm" onClick={() => setAsking('update')}>
                  {T.update}
                </Button>
              )}
              {panel.canEdit && (
                <Button
                  variant={panel.canUpdate ? 'secondary' : 'primary'}
                  size="sm"
                  onClick={() => setEditing(true)}
                >
                  {W.edit}
                </Button>
              )}
              {panel.canCompare && (
                <Button variant="secondary" size="sm" onClick={() => setComparing(true)}>
                  {panel.compareLabel}
                </Button>
              )}
              {panel.canRestore && (
                <Button variant="secondary" size="sm" onClick={() => setAsking('restore')}>
                  {T.restore}
                </Button>
              )}

              {panel.removeKind && (
                <Button variant="secondary" size="sm" onClick={() => setAsking('remove')}>
                  {T.remove}
                </Button>
              )}
            </>
          )}
        </div>
        {comparing && detail.original && (
          <CompareDialog
            name={item.name}
            original={detail.original.text}
            text={detail.text}
            title={panel.compareLabel}
            files={panel.fileChanges}
            onClose={() => setComparing(false)}
          />
        )}
        {file && <FileDialog burrow={burrow} skill={skill} path={file} onClose={() => setFile(null)} />}
      </>
    );
  }

  return (
    <Modal
      open
      onOpenChange={(o) => !o && !editing && onClose()}
      width="lg"
      padded={false}
      className={styles.skillDialog}
    >
      <div className={styles.skillHead}>
        <div className={styles.panelHeading}>
          <ModalTitle className={styles.panelTitle}>{skill.name}</ModalTitle>
          {panel && <div className={styles.tag}>{panel.tag}</div>}
        </div>
        <IconButton label={W.close} onClick={onClose}>
          <Icon icon={X} size={16} />
        </IconButton>
      </div>
      {body}
    </Modal>
  );
}

/** “Neo uses it” and its switch. */
function SwitchRow({ label, on, onChange }: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  const id = useId();
  return (
    <div className={styles.uses}>
      <span id={id}>{label}</span>
      <Toggle size="sm" checked={on} aria-labelledby={id} onCheckedChange={onChange} />
    </div>
  );
}

/**
 * Compare (CT-1412): the SKILL.md against Hermes's version of a changed built-in, line by line, and how each other file
 * differs, as Hermes's diff says.
 */
function CompareDialog({
  name,
  original,
  text,
  title,
  files,
  onClose,
}: {
  name: string;
  original: string;
  text: string;
  title: string;
  /** The other files that differ, and how. */
  files: readonly { path: string; change: string }[];
  onClose: () => void;
}) {
  const legend = W.compareLegend;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} width="lg">
      <div className={styles.dialogHead}>
        <ModalTitle className={styles.dialogTitle}>{title}</ModalTitle>
        <p className={styles.dialogSub}>
          <span className={styles.legendDel}>{legend.del}</span>,{' '}
          <span className={styles.legendAdd}>{legend.add}</span>
        </p>
      </div>
      <div className={styles.diff}>
        <TextDiff path={`${name}/SKILL.md`} base={original} head={text} same={W.same} />
      </div>
      {files.length > 0 && (
        <div>
          <SectionLabel as="h4" className={styles.sublabel}>
            {W.otherFiles}
          </SectionLabel>
          <ul className={styles.files} aria-label={W.otherFiles}>
            {files.map((f) => (
              <li key={f.path} className={styles.fileChange}>
                <span>{f.path}</span>
                <span className={styles.fileSize}>{f.change}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className={styles.footer}>
        <Button variant="secondary" size="md" onClick={onClose}>
          {W.close}
        </Button>
      </div>
    </Modal>
  );
}

function FileDialog({
  burrow,
  skill,
  path,
  onClose,
}: {
  burrow: string;
  skill: SkillRef;
  path: string;
  onClose: () => void;
}) {
  const read = useSkillLibraryFile({
    params: { burrow },
    query: { name: skill.name, path },
  });
  const lang = path.split('.').pop() ?? null;
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} width="lg">
      <div className={styles.dialogHead}>
        <ModalTitle className={styles.dialogTitle}>{path}</ModalTitle>
        <p className={styles.dialogSub}>{skill.name}</p>
      </div>
      <div className={styles.fileText}>
        {read.data ? (
          <CodeBlock
            lang={lang === 'md' ? 'markdown' : lang === 'sh' ? 'bash' : lang}
            text={read.data.text}
          />
        ) : read.error ? (
          <LoadErrorNote error={read.error} message={W.fileError} onRetry={() => void read.refetch()} />
        ) : (
          <SkeletonRows count={6} lines={1} />
        )}
      </div>
      <div className={styles.footer}>
        <Button variant="secondary" size="md" onClick={onClose}>
          {W.close}
        </Button>
      </div>
    </Modal>
  );
}
