/**
 * Pressing a thing page's buttons (contracts 0.121, CT-1001…CT-1006; Whombat service-dashboards.md SD-07…SD-09; app
 * service-dashboards.md AP-4538…AP-4541): a button with a question asks it first, then runs `things.action {action,
 * target, value}`; the server's words say how it went (a toast on the web, the phone's toast), a refusal or a failure in
 * its words too; the page is read again at once (SD-09), and Done recently when the press left a change there. Several
 * buttons may run at once (two lights switched quickly), each drawn busy by its key. Switches and steppers show what the
 * person set until the page is read again after the answer (`useControlGuesses`); a stepper sends its figure once the
 * presses stop (`useStepperDraft`). Works in React DOM and React Native.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { ThingButtonValue, ThingControlStepper, ThingPageButton } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type ControlGuesses,
  STEPPER_SEND_MS,
  settleGuesses,
  stepperNext,
  type ThingButtonView,
  thingActionBody,
  thingButtonKey,
  thingButtonView,
} from '../home/thingButtons';
import { commitOutcomeText, hostErrorInfo } from '../hosts/errors';
import { queryKeys } from '../query/keys';
import { useWhombat } from './context';

/**
 * How a press went: the server's words either way, and the change it left when it can be put back (Whombat
 * service-settings.md SST-03: the toast's “Put it back” is `changes.undo` of `undo`).
 */
export type ThingPressNote = (
  message: string,
  outcome: 'done' | 'failed',
  undo?: { changeId: string },
) => void;

export interface ThingPressOptions {
  /** What it sends instead of the button's own value: a switch's `!on`, a stepper's new figure. */
  value?: ThingButtonValue;
  /** Just before it is sent (after the question, when it has one): show the new state at once. */
  onSend?: () => void;
  /**
   * Once it answered (`ok`, at `at` ms) or failed, or its question was cancelled (`sent` false, nothing was sent).
   */
  onDone?: (result: { ok: boolean; sent: boolean; at: number }) => void;
}

/** A button waiting for its question's answer: the dialog (web) or sheet (phone) draws it. */
export interface ThingAsking {
  button: ThingPageButton;
  view: ThingButtonView;
  /** The question (always there while asking). */
  confirm: NonNullable<ThingButtonView['confirm']>;
  /** Running after “yes”: the dialog stays, its buttons busy. */
  busy: boolean;
}

export interface ThingButtons {
  /** Press a button: asks first when it has `confirm`, else runs at once. A disabled one does nothing. */
  press(button: ThingPageButton, options?: ThingPressOptions): void;
  asking: ThingAsking | null;
  /** “Yes” to the question: runs it; the question closes once it answered. */
  confirm(): void;
  /** “Cancel”: nothing is sent. */
  cancel(): void;
  /** Whether this button (with this value) is running now. */
  running(button: ThingPageButton, value?: ThingButtonValue): boolean;
}

/**
 * A page's buttons (`thing` the thingId): one per page, shared by its panels, so its question is one dialog. `note`
 * says how each press went.
 */
export function useThingButtons(burrow: string, thing: string, note: ThingPressNote): ThingButtons {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const [running, setRunning] = useState<ReadonlySet<string>>(() => new Set());
  const [asking, setAsking] = useState<{
    button: ThingPageButton;
    options: ThingPressOptions;
    busy: boolean;
  } | null>(null);
  const noteRef = useRef(note);
  noteRef.current = note;

  const send = useCallback(
    async (button: ThingPageButton, options: ThingPressOptions): Promise<boolean> => {
      const key = thingButtonKey(button, options.value);
      setRunning((s) => new Set(s).add(key));
      options.onSend?.();
      let ok = false;
      let at = Date.now();
      try {
        const result = await client.request(api.things.action, {
          params: { burrow, thing },
          body: thingActionBody(button, options.value),
        });
        at = Date.now();
        if (result.status === 'ok') {
          ok = true;
          noteRef.current(
            result.data.message,
            'done',
            result.data.changeId && result.data.undoable ? { changeId: result.data.changeId } : undefined,
          );
          // Done recently shows it only when the press left a change there (SD-08: everyday switches don't).
          if (result.data.changeId)
            void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview', { burrow }) });
        } else noteRef.current(commitOutcomeText(result) ?? '', 'failed');
      } catch (error) {
        at = Date.now();
        noteRef.current(hostErrorInfo(error).message, 'failed');
      } finally {
        setRunning((s) => {
          const next = new Set(s);
          next.delete(key);
          return next;
        });
        // The page again at once (SD-09, CT-1006 `refresh`), and its Activity.
        void qc.invalidateQueries({ queryKey: queryKeys.scope('things.page', { burrow, thing }) });
        void qc.invalidateQueries({ queryKey: queryKeys.scope('changes.list', { burrow }) });
        options.onDone?.({ ok, sent: true, at });
      }
      return ok;
    },
    [client, qc, burrow, thing],
  );

  const press = useCallback(
    (button: ThingPageButton, options: ThingPressOptions = {}) => {
      if (!button.allowed) return;
      if (button.confirm) setAsking({ button, options, busy: false });
      else void send(button, options);
    },
    [send],
  );

  const confirm = useCallback(() => {
    if (!asking || asking.busy) return;
    setAsking({ ...asking, busy: true });
    void send(asking.button, asking.options).finally(() => setAsking(null));
  }, [asking, send]);

  const cancel = useCallback(() => {
    if (!asking || asking.busy) return;
    asking.options.onDone?.({ ok: false, sent: false, at: Date.now() });
    setAsking(null);
  }, [asking]);

  const isRunning = useCallback(
    (button: ThingPageButton, value?: ThingButtonValue) => running.has(thingButtonKey(button, value)),
    [running],
  );

  const askingView = useMemo((): ThingAsking | null => {
    if (!asking?.button.confirm) return null;
    return {
      button: asking.button,
      view: thingButtonView(asking.button),
      confirm: asking.button.confirm,
      busy: asking.busy,
    };
  }, [asking]);

  return { press, asking: askingView, confirm, cancel, running: isRunning };
}

/**
 * What switches and steppers show while their change is on its way (AP-4534): the value the person set, from the
 * press until the page is read again after the answer (`readAt`, the page query's `dataUpdatedAt`); a failure or a
 * cancelled question puts the page's value back at once.
 */
export function useControlGuesses(readAt: number) {
  const [guesses, setGuesses] = useState<ControlGuesses>({});
  const settled = settleGuesses(guesses, readAt);
  useEffect(() => {
    if (settled !== guesses) setGuesses(settled);
  }, [settled, guesses]);
  const guess = useCallback((id: string, value: boolean | number) => {
    setGuesses((g) => ({ ...g, [id]: { value, answeredAt: null } }));
  }, []);
  const done = useCallback((id: string, result: { ok: boolean; at: number }) => {
    setGuesses((g) => {
      const had = g[id];
      if (!had) return g;
      const next = { ...g };
      if (result.ok) next[id] = { ...had, answeredAt: result.at };
      else delete next[id];
      return next;
    });
  }, []);
  return { guesses: settled, guess, done };
}

/**
 * A stepper's figure while it is pressed (AP-4533): each press moves the shown figure a step (within min…max); once
 * the presses stop for `STEPPER_SEND_MS` the last figure is sent (`send`), once — also when the stepper goes away
 * meanwhile. `value` is what the page (or its guess) says.
 */
export function useStepperDraft(
  value: number,
  stepper: Pick<ThingControlStepper, 'min' | 'max' | 'step'>,
  send: (value: number) => void,
) {
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<number | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  const valueRef = useRef(value);
  valueRef.current = value;

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    setDraft(null);
    if (next !== null && next !== valueRef.current) sendRef.current(next);
  }, []);

  const step = useCallback(
    (dir: 1 | -1) => {
      const next = stepperNext(stepper, pending.current ?? valueRef.current, dir);
      pending.current = next;
      setDraft(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, STEPPER_SEND_MS);
    },
    [stepper, flush],
  );

  // Leaving with a figure not sent yet sends it.
  useEffect(() => () => flush(), [flush]);

  return { shown: draft ?? value, step, waiting: draft !== null };
}
