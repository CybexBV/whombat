import { ApiError, InvalidRequestError } from '@whombat/client';
import { useApiMutation, useBootstrap, useTheAgent } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import { LOCAL_REPO_OWNER, LocalRepoName, type Repo } from '@whombat/core/domain';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { PersonAvatar } from '../messaging/PersonAvatar';
import styles from './ReposTab.module.css';

/** Under the name while it is fine (or empty). */
const NAME_HINT = 'Letters, digits, _ . and -. It becomes the folder your agent works in.';

/** Why a typed name can't be used, in the dialog's words; null when it can. */
export function localRepoNameProblem(name: string, taken: readonly string[]): string | null {
  if (!name) return null;
  if (/\s/.test(name)) return 'No spaces: use _ or - instead.';
  if (name.startsWith('.') || name.startsWith('-')) return 'Start with a letter or a digit.';
  if (/\.git$/i.test(name)) return 'Leave out the .git at the end.';
  if (name.length > 100) return 'Keep it to 100 characters.';
  if (!LocalRepoName.safeParse(name).success) return 'Use only letters, digits, _ . and -.';
  const lower = name.toLowerCase();
  if (taken.some((t) => t.toLowerCase() === lower))
    return `This Whombat already has a repository called ${name}.`;
  return null;
}

/** The field error of a refused `repos.create` (server validation). */
function nameErrorOf(err: unknown): string | null {
  if (err instanceof ApiError || err instanceof InvalidRequestError)
    return err.fields.name?.[0] ?? err.message;
  return null;
}

export interface NewRepoModalProps {
  burrow: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Who the first commit is by (`ReposResponse.create.author`). */
  author: { name: string; email: string };
  /** Names already in the burrow (folder names), refused before asking. */
  taken: readonly string[];
  onCreated: (repo: Repo) => void;
}

/**
 * New repository (AP-544): a Git repository kept on this Whombat (`repos.create`, CT-192). A name (the folder agents work
 * in), an optional description (the README's first line), and who the first commit is by — the person creating it,
 * shown before anything happens, as John asked (“use name and email address of the owner”).
 */
export function NewRepoModal({ burrow, open, onOpenChange, author, taken, onCreated }: NewRepoModalProps) {
  const ids = useId();
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const { words } = useTheAgent(burrow);
  const createRepo = useApiMutation(api.repos.create);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  // A fresh dialog each time it opens, with the name field ready to type in.
  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setServerError(null);
    setNotice(null);
    const t = window.setTimeout(() => nameInput.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  const trimmed = name.trim();
  const problem = serverError ?? localRepoNameProblem(trimmed, taken);
  const ready = trimmed.length > 0 && !problem && !createRepo.isPending;
  const me = bootstrap?.me;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setNotice(null);
    try {
      const result = await createRepo.mutateAsync({
        params: { burrow },
        body: { name: trimmed, ...(description.trim() ? { description: description.trim() } : {}) },
      });
      if (result.status === 'blocked') {
        setNotice(result.message);
        return;
      }
      if (result.status === 'pending_approval') {
        setNotice(`Waiting for a person to approve (approval #${result.approvalNumber}).`);
        return;
      }
      onCreated(result.data.repo);
    } catch (err) {
      const reason = nameErrorOf(err);
      if (reason === null) throw err;
      setServerError(reason);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} width="md" className={styles.modal}>
      <form className={styles.modalForm} onSubmit={handleSubmit} noValidate>
        <div className={styles.modalHead}>
          <span className={styles.modalIcon}>
            <Icon name="branch" size={20} />
          </span>
          <div className={styles.modalHeading}>
            <ModalTitle className={styles.modalTitle}>New repository</ModalTitle>
            <ModalDescription className={styles.modalLead}>
              A Git repository kept on this Whombat. {words.Name} can work in it right away.
            </ModalDescription>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${ids}-name`}>
            Name
          </label>
          <Input
            ref={nameInput}
            id={`${ids}-name`}
            size="lg"
            className={styles.nameInput}
            placeholder="Whombat_Website"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            maxLength={120}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (serverError) setServerError(null);
            }}
            invalid={problem !== null}
            aria-describedby={`${ids}-name-hint`}
            aria-invalid={problem !== null}
          />
          <span
            id={`${ids}-name-hint`}
            className={problem ? styles.fieldError : styles.fieldHint}
            role={problem ? 'alert' : undefined}
          >
            {problem ??
              (trimmed ? (
                <>
                  Agents see it as{' '}
                  <span className={styles.mono}>
                    {LOCAL_REPO_OWNER}/{trimmed}
                  </span>
                  .
                </>
              ) : (
                NAME_HINT
              ))}
          </span>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${ids}-description`}>
            Description <span className={styles.optional}>optional</span>
          </label>
          <Input
            id={`${ids}-description`}
            size="lg"
            placeholder="What it’s for"
            maxLength={280}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className={styles.commitCard}>
          <span className={styles.commitAvatar}>
            {me ? (
              <PersonAvatar avatarUrl={me.avatarUrl} initials={me.initials} tone={me.tone} size={32} />
            ) : (
              <Icon name="people" size={16} />
            )}
          </span>
          <span className={styles.commitMain}>
            <span className={styles.commitTitle}>First commit by {author.name}</span>
            <span className={styles.commitEmail}>{author.email}</span>
          </span>
          <span className={styles.commitMeta}>
            <Icon name="branch" size={13} /> main · README.md
          </span>
        </div>

        {notice ? (
          <span className={styles.fieldHint} role="status">
            {notice}
          </span>
        ) : null}

        <div className={styles.modalActions}>
          <ModalClose asChild>
            <Button variant="secondary" size="lg">
              Cancel
            </Button>
          </ModalClose>
          <Button type="submit" variant="primary" size="lg" disabled={!ready}>
            {createRepo.isPending ? 'Creating…' : 'Create repository'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
