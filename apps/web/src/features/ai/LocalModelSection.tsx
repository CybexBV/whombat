/**
 * A MODEL ON YOUR NETWORK in Settings → AI (`#local-model`; Whombat hermes-engine.md HE-32; contracts 0.124
 * CT-1170…CT-1175; hermes-engine-app.md AP-5048…AP-5051). Not in the mocks: it follows this page's own sections (the
 * AI gateway's section) — the small label, one sentence, a card.
 *
 * - Saved: a row with the last test's dot, its name and “model · address”, the test's line under it; Check again,
 *   Change and Remove (asks first).
 * - None saved, or Change: the form in the card — Address, Model, Name (optional), API key (optional; never shown again,
 *   empty keeps the saved one on the same server, AP-5006) with the contracts' hints, then Save, Test and Cancel. Test
 *   tries the form without saving (the saved one again while the form holds it), Save saves and the server tests it at
 *   once. A field's problem shows once it was left or Save or Test was pressed, in the contracts' words.
 *
 * Only on a runtime with `ai.local_model`.
 */
import {
  ApiError,
  InvalidRequestError,
  LOCAL_MODEL_FIELDS,
  LOCAL_MODEL_TEXT,
  type LocalModelDraft,
  type LocalModelField,
  localModelCheckLine,
  localModelDraft,
  localModelProblems,
  localModelRow,
  localModelSaved,
  localModelSetBody,
  localModelTestBody,
} from '@whombat/client';
import { useClearLocalModel, useSetLocalModel, useTestLocalModel } from '@whombat/client/react';
import type { LocalModelCheck, LocalModelView } from '@whombat/core/domain';
import { LOCAL_MODEL_COPY } from '@whombat/core/text';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { Input } from '../../components/Input';
import { SectionLabel } from '../../components/SectionLabel';
import { StatusDot } from '../../components/StatusDot';
import { useToast } from '../../components/Toast';
import { ConfirmDialog } from '../conversations/ConfirmDialog';
import styles from './ai.module.css';
import local from './LocalModelSection.module.css';

/** The confirm dialog's kicker (the gateway's “AI GATEWAY” pattern). */
const KICKER = 'CUSTOM AI MODEL';

/** The server's sentence for a refused write, per field where it named one. */
function refusalOf(
  err: unknown,
): { message: string; fields: Partial<Record<LocalModelField, string>> } | null {
  if (!(err instanceof ApiError || err instanceof InvalidRequestError)) return null;
  const fields: Partial<Record<LocalModelField, string>> = {};
  for (const f of ['baseUrl', 'model', 'label', 'apiKey'] as const) {
    const said = err.fields[f]?.[0] ?? err.fields[`draft.${f}`]?.[0];
    if (said) fields[f] = said;
  }
  return { message: err.message || LOCAL_MODEL_TEXT.failed, fields };
}

export function LocalModelSection({ burrow, view }: { burrow: string; view: LocalModelView | null }) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [mismatch, setMismatch] = useState<string | null>(null);
  const form = !view || editing;
  return (
    <section
      className={styles.section}
      aria-labelledby={id}
      id="local-model"
      data-local-model={view ? 'set' : 'none'}
    >
      <SectionLabel as="h2" id={id}>
        {LOCAL_MODEL_COPY.title.toUpperCase()}
      </SectionLabel>
      <p className={styles.sectionHelp}>{LOCAL_MODEL_COPY.hint}</p>
      <div className={styles.card}>
        {form ? (
          <div className={styles.row}>
            <LocalModelForm
              burrow={burrow}
              view={view}
              onStart={() => setMismatch(null)}
              onMismatch={(msg) => {
                setMismatch(msg);
                setEditing(false);
              }}
              onDone={() => {
                setMismatch(null);
                setEditing(false);
              }}
              onCancel={
                view
                  ? () => {
                      setMismatch(null);
                      setEditing(false);
                    }
                  : null
              }
            />
          </div>
        ) : view ? (
          <SavedRow
            burrow={burrow}
            view={view}
            notice={mismatch}
            onChange={() => {
              setMismatch(null);
              setEditing(true);
            }}
          />
        ) : null}
      </div>
    </section>
  );
}

/** The saved model: its dot, name and “model · address”, the test's line; Check again, Change, Remove. */
function SavedRow({
  burrow,
  view,
  notice,
  onChange,
}: {
  burrow: string;
  view: LocalModelView;
  notice?: string | null;
  onChange: () => void;
}) {
  const toast = useToast();
  const test = useTestLocalModel(burrow);
  const clear = useClearLocalModel(burrow);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const row = localModelRow(view);
  const line = test.isPending
    ? { text: LOCAL_MODEL_TEXT.testing, tone: 'mut' as const }
    : localModelCheckLine(view.check, view.model);

  const checkAgain = async () => {
    setProblem(null);
    try {
      const result = await test.mutateAsync({ params: { burrow }, body: {} });
      if (result.status !== 'ok')
        setProblem(result.status === 'blocked' ? result.message : LOCAL_MODEL_TEXT.testFailed);
    } catch (err) {
      setProblem(refusalOf(err)?.message ?? LOCAL_MODEL_TEXT.testFailed);
    }
  };

  const remove = async () => {
    setProblem(null);
    try {
      const result = await clear.mutateAsync({ params: { burrow } });
      if (result.status === 'ok') {
        if (result.data.burrow.localModel != null) {
          setProblem(LOCAL_MODEL_TEXT.failed);
          return;
        }
        setAsking(false);
        toast.show(LOCAL_MODEL_COPY.removed);
        return;
      }
      setProblem(result.status === 'blocked' ? result.message : LOCAL_MODEL_TEXT.failed);
    } catch (err) {
      setProblem(refusalOf(err)?.message ?? LOCAL_MODEL_TEXT.failed);
    }
  };

  return (
    <div className={styles.row} data-local-model-row="" data-check={view.check?.state ?? 'none'}>
      <div className={styles.head}>
        <StatusDot tone={line.tone} size={8} label={null} />
        <span className={styles.main}>
          <span className={styles.name}>{row.name}</span>
          <span className={styles.meta}>{row.meta}</span>
        </span>
        <span className={styles.headActions}>
          <Button variant="secondary" size="sm" onClick={() => void checkAgain()} disabled={test.isPending}>
            {LOCAL_MODEL_COPY.checkAgain}
          </Button>
          <Button variant="secondary" size="sm" onClick={onChange}>
            {LOCAL_MODEL_TEXT.change}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAsking(true)}>
            {LOCAL_MODEL_COPY.remove}
          </Button>
        </span>
      </div>
      <span className={styles.hint} role="status" data-tone={line.tone}>
        {line.text}
      </span>
      {(problem ?? notice) && !asking ? (
        <span className={styles.problem} role="alert">
          {problem ?? notice}
        </span>
      ) : null}
      {asking ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setAsking(false);
              setProblem(null);
            }
          }}
          kicker={KICKER}
          title={LOCAL_MODEL_COPY.removeTitle}
          confirmLabel={LOCAL_MODEL_COPY.remove}
          busy={clear.isPending}
          error={problem}
          onConfirm={() => void remove()}
        >
          {LOCAL_MODEL_COPY.removeBody}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/** The form: the four fields with the contracts' hints, a draft's test line, Save, Test and Cancel. */
function LocalModelForm({
  burrow,
  view,
  onStart,
  onMismatch,
  onDone,
  onCancel,
}: {
  burrow: string;
  view: LocalModelView | null;
  onStart: () => void;
  onMismatch: (message: string) => void;
  onDone: () => void;
  onCancel: (() => void) | null;
}) {
  const ids = useId();
  const toast = useToast();
  const set = useSetLocalModel(burrow);
  const test = useTestLocalModel(burrow);
  const [draft, setDraft] = useState<LocalModelDraft>(() => localModelDraft(view));
  const [touched, setTouched] = useState<ReadonlySet<LocalModelField>>(new Set());
  const [tried, setTried] = useState(false);
  const [server, setServer] = useState<Partial<Record<LocalModelField, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ check: LocalModelCheck; model: string } | null>(null);
  const problems = localModelProblems(draft);
  const ready = Object.keys(problems).length === 0;
  const shown = (f: LocalModelField) => server[f] ?? (tried || touched.has(f) ? problems[f] : undefined);

  const edit = (f: LocalModelField, value: string) => {
    setDraft((d) => ({ ...d, [f]: value }));
    setServer(({ [f]: _, ...rest }) => rest);
    setChecked(null);
  };

  const runTest = async () => {
    setTried(true);
    setProblem(null);
    if (!ready) return;
    try {
      const result = await test.mutateAsync({ params: { burrow }, body: localModelTestBody(draft, view) });
      if (result.status === 'ok') setChecked({ check: result.data.check, model: draft.model.trim() });
      else setProblem(result.status === 'blocked' ? result.message : LOCAL_MODEL_TEXT.testFailed);
    } catch (err) {
      const refusal = refusalOf(err);
      setServer(refusal?.fields ?? {});
      setProblem(refusal?.message ?? LOCAL_MODEL_TEXT.testFailed);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    setProblem(null);
    onStart();
    if (!ready) return;
    const body = localModelSetBody(draft, view);
    try {
      const result = await set.mutateAsync({ params: { burrow }, body });
      if (result.status === 'ok') {
        if (!localModelSaved(body, result.data.localModel)) {
          setProblem(LOCAL_MODEL_TEXT.failed);
          onMismatch(LOCAL_MODEL_TEXT.failed);
          return;
        }
        toast.show(LOCAL_MODEL_COPY.saved);
        onDone();
        return;
      }
      setProblem(result.status === 'blocked' ? result.message : LOCAL_MODEL_TEXT.failed);
    } catch (err) {
      const refusal = refusalOf(err);
      setServer(refusal?.fields ?? {});
      setProblem(refusal?.message ?? LOCAL_MODEL_TEXT.failed);
    }
  };

  const line = test.isPending
    ? { text: LOCAL_MODEL_TEXT.testing, tone: 'mut' as const }
    : checked
      ? localModelCheckLine(checked.check, checked.model)
      : null;
  const busy = set.isPending || test.isPending;

  return (
    <form className={styles.flow} onSubmit={(e) => void save(e)} noValidate data-local-model-form="">
      <div className={local.fields}>
        {LOCAL_MODEL_FIELDS.map(({ field, label, hint }) => {
          const said = shown(field);
          const fieldId = `${ids}-${field}`;
          const keyHint = field === 'apiKey' && view?.hasApiKey ? LOCAL_MODEL_COPY.apiKeySaved : hint;
          return (
            <div key={field} className={local.field}>
              <label className={local.label} htmlFor={fieldId}>
                {label}
              </label>
              <Input
                id={fieldId}
                className={local.input}
                value={draft[field]}
                invalid={!!said}
                aria-describedby={`${fieldId}-hint`}
                autoComplete="off"
                spellCheck={false}
                {...(field === 'apiKey' ? { type: 'password' } : {})}
                {...(field === 'baseUrl' ? { inputMode: 'url' as const } : {})}
                onChange={(e) => edit(field, e.target.value)}
                onBlur={() => setTouched((t) => new Set(t).add(field))}
              />
              <span id={`${fieldId}-hint`} className={said ? local.fieldProblem : local.hint}>
                {said ?? keyHint}
              </span>
            </div>
          );
        })}
      </div>
      {line ? (
        <span className={local.check} role="status" data-tone={line.tone} data-test-result="">
          <StatusDot tone={line.tone} size={8} label={null} />
          {line.text}
        </span>
      ) : null}
      {problem ? (
        <span className={styles.problem} role="alert">
          {problem}
        </span>
      ) : null}
      <div className={styles.flowActions}>
        <Button variant="primary" size="sm" type="submit" disabled={busy}>
          {LOCAL_MODEL_COPY.save}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void runTest()} disabled={busy}>
          {LOCAL_MODEL_COPY.test}
        </Button>
        {onCancel ? (
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={set.isPending}>
            {LOCAL_MODEL_TEXT.cancel}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
