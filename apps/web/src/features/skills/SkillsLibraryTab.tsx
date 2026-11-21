import { useBootstrap } from '@whombat/client/react';
import {
  skillLibraryEndpoints as E,
  type SkillFold,
  type SkillFoldId,
  type SkillGroup,
  type SkillLibraryItem,
  type SkillRow,
  skillLibraryView,
  SKILL_LIBRARY_TEXT as T,
} from '@whombat/client/skill-library';
import {
  useSkillHubUpdateCheck,
  useSkillLibrary,
  useSkillLibraryWrite,
} from '@whombat/client/skill-library/react';
import type { Agent } from '@whombat/core';
import { ChevronRight } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { LoadErrorNote } from '../../app/runtime';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import { viewerTimeZone } from '../messaging/model';
import { AddSkillsDialog } from './AddSkillsDialog';
import { SkillDialog } from './SkillDialog';
import styles from './Skills.module.css';
import { SKILLS_WORDS } from './skillsWords';

/** A row of the list: a skill by its name (one skill per name, CT-1571). */
export type SkillRef = Pick<SkillLibraryItem, 'name'>;

const TONE = { ok: styles.ok, warn: styles.warn, mut: styles.mut } as const;

/**
 * Settings → Skills (`?tab=skills`; Whombat hermes-skills.md HSK-10…HSK-13, hermes-engine.md HE-41; contracts 3.0
 * CT-1570; app AP-5530…AP-5535, one-person.md AP-5710): “Skills · 42”, one line of help, search (name and description,
 * as you type) and **Add skills** (Hermes's hub); then one list — Hermes's categories with their titles and Hermes's
 * words for them, then what you added and what the agent learned —, its rows with where a skill came from beside its
 * name, its status or what it needs, and a switch each; Off and Removed folded at the end. A row opens the skill in a
 * dialog over the list. Opening the tab asks Hermes whether added skills have a newer version (at most once an hour,
 * HSK-09). The mockup's layout (`docs/design-handoff/all-skills/settings-skills.html`).
 */
export function SkillsLibraryTab({ burrow, agent }: { burrow: string; agent: Pick<Agent, 'name'> }) {
  const toast = useToast();
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const timeZone = viewerTimeZone(bootstrap);
  const query = useSkillLibrary({ params: { burrow } });
  const library = query.data;
  const updates = useSkillHubUpdateCheck(burrow, library);
  const name = library?.agentName ?? agent.name;
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<SkillRef | null>(null);
  const [folds, setFolds] = useState<ReadonlySet<SkillFoldId>>(new Set());
  const [adding, setAdding] = useState(false);
  const toggle = useSkillLibraryWrite(E.switch, burrow);
  const searchId = useId();

  const view = useMemo(
    () => (library ? skillLibraryView(library, { query: search, now: Date.now(), timeZone, updates }) : null),
    [library, search, timeZone, updates],
  );

  async function switchSkill(row: SkillRow, on: boolean) {
    try {
      const r = await toggle.mutateAsync({ params: { burrow }, body: { name: row.item.name, on } });
      if (r.status !== 'ok') toast.show(SKILLS_WORDS.notChanged);
    } catch {
      toast.show(SKILLS_WORDS.notChanged);
    }
  }

  if (query.error && !library)
    return (
      <LoadErrorNote
        error={query.error}
        message={SKILLS_WORDS.loadError(name)}
        onRetry={() => void query.refetch()}
      />
    );

  const rowProps: RowProps = { assistantName: name, onOpen: setOpen, onSwitch: switchSkill };
  const foldOpen = (f: SkillFold) => (view?.filtering ?? false) || folds.has(f.id);
  const toggleFold = (id: SkillFoldId) =>
    setFolds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className={styles.layout} data-skills-library>
      <section className={styles.card} aria-labelledby={`${searchId}-title`}>
        <h2 id={`${searchId}-title`} className={styles.title}>
          {view ? view.title : 'Skills'}
        </h2>
        <p className={styles.help}>{T.help(name)}</p>
        <div className={styles.bar}>
          <label htmlFor={searchId} className={styles.srOnly}>
            {T.search}
          </label>
          <Input
            id={searchId}
            type="search"
            className={styles.search}
            placeholder={T.search}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {library && (
            <Button variant="primary" size="md" onClick={() => setAdding(true)}>
              {T.add}
            </Button>
          )}
        </div>

        {!view ? (
          <div aria-busy="true">
            <SkeletonRows count={8} lines={2} />
          </div>
        ) : (
          <>
            {view.nothingMatches && view.filtering ? (
              <p className={styles.note}>{T.noMatch(search.trim())}</p>
            ) : null}
            {view.empty ? <p className={styles.note}>{view.empty}</p> : null}
            {view.groups.map((g) => (
              <Group key={g.id} group={g} rowProps={rowProps} />
            ))}
            {view.folds.map((f) => (
              <Fold
                key={f.id}
                fold={f}
                open={foldOpen(f)}
                onToggle={() => toggleFold(f.id)}
                rowProps={rowProps}
              />
            ))}
          </>
        )}
      </section>

      {open && library && (
        <SkillDialog
          burrow={burrow}
          library={library}
          skill={open}
          timeZone={timeZone}
          updates={updates}
          onClose={() => setOpen(null)}
        />
      )}

      <AddSkillsDialog burrow={burrow} assistantName={name} open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

/** A group: Hermes's category's title, and Hermes's words for it beside it on the same line (HSK-13). */
function Group({ group, rowProps }: { group: SkillGroup; rowProps: RowProps }) {
  return (
    <section className={styles.group} aria-label={group.label} data-skills-group={group.id}>
      <div className={styles.groupHead}>
        <SectionLabel as="h4" className={styles.groupLabel}>
          {group.label}
        </SectionLabel>
        {group.description && (
          <span className={styles.groupDescription} title={group.description}>
            {group.description}
          </span>
        )}
      </div>
      <ul className={styles.rows}>
        {group.rows.map((row) => (
          <SkillRowItem key={row.key} row={row} {...rowProps} />
        ))}
      </ul>
    </section>
  );
}

interface RowProps {
  assistantName: string;
  onOpen: (ref: SkillRef) => void;
  onSwitch: (row: SkillRow, on: boolean) => void;
}

function SkillRowItem({ row, assistantName, onOpen, onSwitch }: RowProps & { row: SkillRow }) {
  const { item } = row;
  const statusId = useId();
  return (
    <li className={styles.row} data-skill={row.key}>
      <button
        type="button"
        className={styles.open}
        aria-haspopup="dialog"
        aria-describedby={statusId}
        onClick={() => onOpen({ name: item.name })}
      >
        <span className={styles.nameLine}>
          <span className={styles.name} title={item.name}>
            {item.name}
          </span>
          {row.origin && <span className={styles.origin}>{row.origin}</span>}
        </span>
        <span className={styles.description} title={item.description}>
          {item.description}
        </span>
      </button>
      <span id={statusId} className={cx(styles.status, TONE[row.tone])} title={row.status}>
        {row.status}
      </span>
      <span className={styles.switchCell}>
        {row.canSwitch ? (
          <Toggle
            size="sm"
            checked={row.on}
            onCheckedChange={(on) => onSwitch(row, on)}
            aria-label={SKILLS_WORDS.switchLabel(item.name, assistantName)}
          />
        ) : null}
      </span>
    </li>
  );
}

function Fold({
  fold,
  open,
  onToggle,
  rowProps,
}: {
  fold: SkillFold;
  open: boolean;
  onToggle: () => void;
  rowProps: RowProps;
}) {
  const id = useId();
  return (
    <div className={styles.fold}>
      <button
        type="button"
        className={styles.foldButton}
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
      >
        <Icon icon={ChevronRight} size={14} className={styles.chevron} />
        <span>{fold.label}</span>
      </button>
      {open && (
        <ul id={id} className={styles.rows}>
          {fold.rows.map((row) => (
            <SkillRowItem key={row.key} row={row} {...rowProps} />
          ))}
        </ul>
      )}
    </div>
  );
}
