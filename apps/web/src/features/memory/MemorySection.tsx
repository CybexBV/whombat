import {
  ApiError,
  MEMORY_TEXT,
  memoryEntryFits,
  memoryFileEntries,
  memoryUsage,
  memoryWithEdit,
  memoryWithEntry,
  memoryWithout,
  memoryWriteProblem,
} from '@whombat/client';
import { useMemoryWrite, useMyMemory, useTheAgent } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import { MEMORY_FILES, type MemoryFile, type MemoryFileView, memoryCopy } from '@whombat/core/domain';
import { type FormEvent, useId, useState } from 'react';
import { LoadErrorNote } from '../../app/runtime';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Input } from '../../components/Input';
import { SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { useToast } from '../../components/Toast';
import { useWebI18n } from '../../i18n/provider';
import { ConfirmDialog } from '../conversations/ConfirmDialog';
import { DangerFold } from '../settings/DangerFold';
import settings from '../settings/SettingsScreen.module.css';
import { MemoryEntries } from './MemoryEntries';
import own from './MemoryEntries.module.css';

type MemoryWords = ReturnType<typeof memoryCopy>;

/** The section's words, the agent by its name (“What Neo remembers”), and that name. */
export function useMemoryWords(burrow: string): { copy: MemoryWords; agentName: string } {
  const { tag: uiLocale } = useWebI18n();
  const { words } = useTheAgent(burrow);
  return { copy: memoryCopy(words.Name, uiLocale), agentName: words.Name };
}

/**
 * Settings → Profile → **What Neo remembers** (`#about-you`; Whombat hermes-engine.md HE-39; contracts 0.125
 * CT-1200…CT-1204; app AP-5220…AP-5224; was What Neo knows about you, AP-681, AP-1789): the person's own memory in their
 * Hermes profile, nobody else's. The label, the contracts' intro, then a card for each file in the
 * contracts' order — what the agent remembers about working with them, and about them — with its hint, the characters
 * used of its limit over a thin bar, its entries (Edit in place, Remove) and a field to add one; then **Forget
 * everything**, which asks first. Every change writes the whole file with the version it started from: a file the agent
 * changed meanwhile says so and reads again. Not in the mocks: the section, cards and rows of the old About you.
 */
export function MemorySection({ burrow }: { burrow: string }) {
  const ids = useId();
  const toast = useToast();
  const { copy, agentName } = useMemoryWords(burrow);
  const { data, error, refetch } = useMyMemory({ params: { burrow } });
  const clear = useMemoryWrite(api.memory.clear, burrow);
  const [asking, setAsking] = useState(false);
  const [clearProblem, setClearProblem] = useState<string | null>(null);

  async function forget() {
    setClearProblem(null);
    try {
      const result = await clear.mutateAsync({ params: { burrow }, query: {} });
      if (result.status !== 'ok') return setClearProblem(MEMORY_TEXT.failed);
      setAsking(false);
      toast.show(copy.cleared);
    } catch (e) {
      setClearProblem(memoryWriteProblem(e, copy.changed));
    }
  }

  return (
    <section className={settings.section} id="about-you" aria-labelledby={`${ids}-label`}>
      <div className={settings.sectionHead}>
        <SectionLabel as="h2" id={`${ids}-label`}>
          {copy.title.toUpperCase()}
        </SectionLabel>
      </div>
      <p className={own.intro}>{copy.intro}</p>
      {!data ? (
        error ? (
          <LoadErrorNote error={error} message={MEMORY_TEXT.loadFailed} onRetry={() => void refetch()} />
        ) : (
          <SkeletonRows count={3} lines={1} />
        )
      ) : (
        <>
          {MEMORY_FILES.map((file) => (
            <MemoryFileCard
              key={file}
              burrow={burrow}
              file={file}
              view={data[file]}
              copy={copy}
              agentName={agentName}
              onStale={() => void refetch()}
            />
          ))}
          {/* Forgetting can't be taken back: folded under Danger, and it asks first. */}
          <DangerFold>
            <div className={own.forget}>
              <Button
                variant="secondary"
                size="lg"
                disabled={!data.memory.text && !data.user.text}
                onClick={() => setAsking(true)}
              >
                {copy.clear}
              </Button>
            </div>
          </DangerFold>
        </>
      )}
      <ConfirmDialog
        open={asking}
        onOpenChange={(open) => {
          setAsking(open);
          if (!open) setClearProblem(null);
        }}
        kicker={copy.clear.toUpperCase()}
        title={copy.clearQuestion}
        confirmLabel={copy.clear}
        busy={clear.isPending}
        error={clearProblem}
        onConfirm={() => void forget()}
      >
        {copy.empty}
      </ConfirmDialog>
    </section>
  );
}

function MemoryFileCard({
  burrow,
  file,
  view,
  copy,
  agentName,
  onStale,
}: {
  burrow: string;
  file: MemoryFile;
  view: MemoryFileView;
  copy: MemoryWords;
  agentName: string;
  onStale: () => void;
}) {
  const ids = useId();
  const toast = useToast();
  const write = useMemoryWrite(api.memory.write, burrow);
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const entries = memoryFileEntries(view);
  const usage = memoryUsage(view);
  const title = file === 'memory' ? copy.memory : copy.user;
  const hint = file === 'memory' ? copy.memoryHint : copy.userHint;
  const placeholder = MEMORY_TEXT.placeholder(file, agentName);
  const full = !memoryEntryFits(view, text);

  /** Writes the whole file; a problem to show, or null once it saved. */
  async function save(next: string, done: string): Promise<string | null> {
    try {
      const result = await write.mutateAsync({
        params: { burrow, file },
        body: { text: next, ifVersion: view.version },
      });
      if (result.status !== 'ok') return MEMORY_TEXT.failed;
      toast.show(done);
      return null;
    } catch (e) {
      // The agent changed it meanwhile (or a turn holds it): read it again so the next try starts from what is there.
      if (e instanceof ApiError && e.code === 'conflict') onStale();
      return memoryWriteProblem(e, copy.changed);
    }
  }

  async function onAdd(event: FormEvent) {
    event.preventDefault();
    const clean = text.trim();
    if (!clean || full) return;
    setProblem(null);
    const failed = await save(memoryWithEntry(view, clean), MEMORY_TEXT.saved);
    if (failed) setProblem(failed);
    else setText('');
  }

  return (
    <section className={settings.card} aria-labelledby={`${ids}-title`} data-memory-file={file}>
      <div className={cx(settings.row, own.fileHead)}>
        <span className={settings.rowMain}>
          <span className={settings.rowTitle} id={`${ids}-title`}>
            {title}
          </span>
          <span className={settings.rowMeta}>{hint}</span>
        </span>
        <span className={own.usageCol}>
          <span className={own.usage}>{usage.text}</span>
          {/* biome-ignore lint/a11y/useSemanticElements: a native <meter> can't be styled the same in every browser with tokens */}
          <span
            role="meter"
            aria-label={title}
            aria-valuemin={0}
            aria-valuemax={view.limit}
            aria-valuenow={Math.min(view.used, view.limit)}
            aria-valuetext={usage.text}
            className={own.track}
            data-tone={usage.tone}
          >
            <span className={own.fill} style={{ width: `${Math.round(usage.fraction * 100)}%` }} />
          </span>
        </span>
      </div>
      {entries.length === 0 ? (
        <p className={cx(settings.empty, own.emptyRow)}>{copy.empty}</p>
      ) : (
        <MemoryEntries
          variant="card"
          label={title}
          entries={entries.map((entry, i) => ({ id: String(i), text: entry }))}
          canEdit
          entryMax={view.limit}
          copy={{ ...copy, remove: MEMORY_TEXT.remove }}
          busy={write.isPending}
          onSave={(id, next) => save(memoryWithEdit(view, Number(id), next), MEMORY_TEXT.saved)}
          onRemove={(id) =>
            void save(memoryWithout(view, Number(id)), MEMORY_TEXT.removed).then(
              (failed) => failed && toast.show(failed),
            )
          }
        />
      )}
      <form className={cx(settings.row, own.addRow, own.lastRow)} onSubmit={onAdd}>
        <span className={own.addField}>
          <Input
            size="lg"
            value={text}
            placeholder={placeholder}
            aria-label={placeholder}
            invalid={problem !== null}
            aria-describedby={problem ? `${ids}-problem` : full ? `${ids}-full` : undefined}
            onChange={(e) => {
              setText(e.target.value);
              if (problem) setProblem(null);
            }}
          />
          {problem ? (
            <span id={`${ids}-problem`} className={own.problem} role="alert">
              {problem}
            </span>
          ) : full ? (
            <span id={`${ids}-full`} className={settings.fieldHint}>
              {copy.full}
            </span>
          ) : null}
        </span>
        <Button
          type="submit"
          variant="secondary"
          size="lg"
          disabled={write.isPending || !text.trim() || full}
        >
          {MEMORY_TEXT.add}
        </Button>
      </form>
    </section>
  );
}
