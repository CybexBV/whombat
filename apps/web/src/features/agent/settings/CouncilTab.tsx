import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  COUNCIL_USUAL,
  councilDraft,
  councilSeatView,
  councilSetupProblem,
  COUNCIL_SETUP_WORDS as W,
} from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { queryHook, useApiMutation } from '@whombat/client/react';
import {
  COUNCIL_ROUNDS_ASKED_MAX,
  type CouncilProviderOption,
  type CouncilSeatSetup,
  type CouncilSetup,
} from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { LoadErrorNote } from '../../../app/runtime';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { SkeletonRows } from '../../../components/ListState';
import { SegmentedControl } from '../../../components/SegmentedControl';
import { useToast } from '../../../components/Toast';
import { ConfirmDialog } from '../../conversations/ConfirmDialog';
import { outcomeText, refusalText } from '../../conversations/refusal';
import settings from '../../settings/SettingsScreen.module.css';
import type { SettingsTabProps } from './AgentTab';
import agent from './AgentTab.module.css';
import c from './Council.module.css';
import { type CouncilDraft, councilSaveBody, councilTargetChoices } from './councilDraft';
import { sameDraft } from './model';
import perm from './Permissions.module.css';

/** Who T3 Code's council sits, the rounds and score the person chose, and what T3 Code can run now (`councils.setup`). */
export const useCouncilSetup = queryHook(api.councils.setup);

const ROUNDS = Array.from({ length: COUNCIL_ROUNDS_ASKED_MAX }, (_, i) => String(i + 1));

/** Why the council didn't load: an older Whombat doesn't have it yet; else try again. */
function loadProblem(error: unknown): string {
  return error instanceof ApiError && (error.status === 404 || error.status === 501)
    ? refusalText(error, W.loadFailed)
    : W.loadFailed;
}

/**
 * Settings → the assistant → **Council** (Whombat docs/decisions/council.md): the one council the assistant calls. Who
 * sits is always T3 Code's own council, shown to read with where to change it (the skill in T3 Code); the person
 * chooses only its rounds and the score to reach. Change opens those in place, and leaving with unsaved changes asks
 * first; “Use the usual rounds and score” forgets the person's (asks first). Without T3 Code's list of AIs the council
 * stays readable but can't be changed.
 */
export function CouncilTab({ burrow, profile, onDirtyChange }: SettingsTabProps) {
  const { data, error, refetch } = useCouncilSetup({ params: { burrow } }, { retry: false });
  const [editing, setEditing] = useState<CouncilDraft | null>(null);
  // A closed editor leaves nothing unsaved.
  useEffect(() => {
    if (!editing) onDirtyChange(false);
  }, [editing, onDirtyChange]);

  if (!data)
    return error ? (
      <LoadErrorNote error={error} message={loadProblem(error)} onRetry={() => void refetch()} />
    ) : (
      <SkeletonRows count={3} lines={2} />
    );

  const { setup, automatic, options } = data;
  return (
    <>
      <p className={perm.intro}>{W.intro(profile.agent.name)}</p>
      {options === null && data.t3 !== 'ready' ? (
        <p className={agent.notice} data-council-t3={data.t3}>
          {W.t3[data.t3]}
        </p>
      ) : null}
      <div className={cx(settings.card, c.list)}>
        {editing ? (
          <CouncilEditor
            burrow={burrow}
            start={editing}
            onDirtyChange={onDirtyChange}
            onClose={() => setEditing(null)}
          />
        ) : (
          <CouncilRow
            setup={setup}
            automatic={automatic}
            options={options}
            onChange={
              options && (setup?.seats ?? automatic).length >= 2
                ? () => setEditing(councilDraft(setup, automatic))
                : null
            }
          />
        )}
      </div>
      {setup && options && !editing ? <ResetCouncil burrow={burrow} /> : null}
    </>
  );
}

/**
 * The council as it is: who T3 Code's council sits (a line per seat, read only) with where to change that, then how it
 * runs, the person's rounds and score else the usual ones; Change on the right.
 */
function CouncilRow({
  setup,
  automatic,
  options,
  onChange,
}: {
  setup: CouncilSetup | null;
  automatic: readonly CouncilSeatSetup[];
  options: readonly CouncilProviderOption[] | null;
  /** None without T3 Code's list of AIs, or without seats to run. */
  onChange: (() => void) | null;
}) {
  const seats = setup?.seats ?? automatic;
  const rounds = setup?.rounds ?? COUNCIL_USUAL.rounds;
  const target = setup?.target ?? COUNCIL_USUAL.target;
  return (
    <div className={cx(settings.row, c.setup)} data-council={setup ? 'yours' : 'usual'}>
      <span className={settings.rowMain}>
        {seats.length > 0 ? (
          <>
            <span className={c.lead}>{W.sits}</span>
            <SeatList seats={seats} options={options} />
            <span className={c.sitsHint} data-council-hint="">
              {W.sitsHint}
            </span>
            <span className={cx(settings.rowMeta, c.summary)}>{W.summary(seats.length, rounds, target)}</span>
          </>
        ) : (
          <span className={c.lead}>{W.sitsUnknown}</span>
        )}
      </span>
      {onChange ? (
        <Button variant="secondary" size="lg" onClick={onChange}>
          {W.edit}
        </Button>
      ) : null}
    </div>
  );
}

/** Use the usual rounds and score: quiet under the card, asks first, then forgets the person's. */
function ResetCouncil({ burrow }: { burrow: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const reset = useApiMutation(api.councils.resetSetup);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function onReset() {
    setProblem(null);
    setBusy(true);
    try {
      const result = await reset.mutateAsync({ params: { burrow }, body: {} });
      if (result.status !== 'ok') return setProblem(outcomeText(result));
      await qc.invalidateQueries({ queryKey: queryKeys.scope('councils.setup', { burrow }) });
      setAsking(false);
      toast.show(W.wasReset);
    } catch (err) {
      setProblem(refusalText(err, W.failed));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={c.reset}>
        <Button variant="ghost" size="lg" className={c.resetButton} onClick={() => setAsking(true)}>
          {W.reset}
        </Button>
      </div>
      <ConfirmDialog
        open={asking}
        onOpenChange={(next) => {
          setAsking(next);
          if (!next) setProblem(null);
        }}
        kicker={W.title.toUpperCase()}
        title={W.resetAsk}
        confirmLabel={W.reset}
        cancelLabel={W.cancel}
        busy={busy}
        error={problem}
        onConfirm={() => void onReset()}
      >
        {W.resetBody}
      </ConfirmDialog>
    </>
  );
}

/** The council's seats, a line each: its company, then its model and effort; one T3 Code can't run now is muted. */
function SeatList({
  seats,
  options,
}: {
  seats: readonly CouncilSeatSetup[];
  options: readonly CouncilProviderOption[] | null;
}) {
  return (
    <ul className={c.seats}>
      {seats.map((seat) => {
        const view = councilSeatView(seat, options);
        return (
          <li
            // Seats keep their order; the same model never sits twice on a saved council.
            key={`${seat.provider}:${seat.model}`}
            className={cx(c.seat, !view.available && c.unavailable)}
            data-seat-available={view.available}
          >
            <span className={c.seatProvider}>{view.provider}</span>
            <span className={c.seatLine}>{view.line}</span>
            {view.note ? <span className={c.seatNote}>{view.note}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The council open for a change: its rounds and the score to reach; Save and Cancel. Who sits goes with Save as T3
 * Code's council has it. Save waits while something keeps it from being saved and says what; a refusal shows the
 * server's words.
 */
function CouncilEditor({
  burrow,
  start,
  onDirtyChange,
  onClose,
}: {
  burrow: string;
  start: CouncilDraft;
  onDirtyChange: (dirty: boolean) => void;
  onClose: () => void;
}) {
  const ids = useId();
  const toast = useToast();
  const qc = useQueryClient();
  const save = useApiMutation(api.councils.saveSetup);
  const [draft, setDraft] = useState(start);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const dirty = !sameDraft(draft, start);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  const problem = councilSetupProblem(draft);
  const shown = refusal ?? problem;
  const edit = (change: (d: CouncilDraft) => CouncilDraft) => {
    setRefusal(null);
    setDraft(change);
  };
  // The council reads again before the editor closes, so the row shows what was saved.
  const reread = () => qc.invalidateQueries({ queryKey: queryKeys.scope('councils.setup', { burrow }) });

  async function onSave(event: FormEvent) {
    event.preventDefault();
    if (problem || busy) return;
    setRefusal(null);
    setBusy(true);
    try {
      const result = await save.mutateAsync({ params: { burrow }, body: councilSaveBody(draft) });
      if (result.status !== 'ok') return setRefusal(outcomeText(result));
      await reread();
      toast.show(W.saved);
      onClose();
    } catch (err) {
      setRefusal(refusalText(err, W.failed));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={c.editor} aria-label={W.title} onSubmit={(e) => void onSave(e)} noValidate>
      <div className={cx(settings.row, c.choiceRow)}>
        <span className={settings.rowMain}>
          <span className={settings.rowTitle}>{W.rounds}</span>
          <span className={settings.rowMeta} id={`${ids}-rounds-hint`}>
            {W.roundsHint}
          </span>
        </span>
        <SegmentedControl<string>
          label={W.rounds}
          role="radiogroup"
          size="sm"
          describedBy={`${ids}-rounds-hint`}
          options={ROUNDS}
          value={String(draft.rounds)}
          onChange={(v) => edit((d) => ({ ...d, rounds: Number(v) }))}
        />
      </div>

      <div className={cx(settings.row, c.choiceRow)}>
        <span className={settings.rowMain}>
          <label className={settings.rowTitle} htmlFor={`${ids}-target`}>
            {W.target}
          </label>
          <span className={settings.rowMeta} id={`${ids}-target-hint`}>
            {W.targetHint}
          </span>
        </span>
        <select
          id={`${ids}-target`}
          className={cx(c.select, c.target)}
          value={String(draft.target)}
          aria-describedby={`${ids}-target-hint`}
          onChange={(e) => {
            const target = Number(e.target.value);
            edit((d) => ({ ...d, target }));
          }}
        >
          {councilTargetChoices(draft.target).map((t) => (
            <option key={t} value={String(t)}>
              {W.score(t)}
            </option>
          ))}
        </select>
      </div>

      <div className={cx(settings.row, c.actions)}>
        {shown ? (
          <p className={c.problem} aria-live="polite" data-council-problem="">
            {shown}
          </p>
        ) : null}
        <div className={c.buttons}>
          <Button variant="secondary" size="lg" className={c.cancel} disabled={busy} onClick={onClose}>
            {W.cancel}
          </Button>
          <Button type="submit" variant="primary" size="lg" disabled={problem !== null || busy}>
            {W.save}
          </Button>
        </div>
      </div>
    </form>
  );
}
