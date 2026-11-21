import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { OperationError } from '../session/managed-ops';
import { ONE_PASSKEY_TEXT, onePasskeyWords, setUpOnePasskey } from './one-passkey';
import { type PasskeySetupView, readPasskeySetup, PASSKEY_SETUP_TEXT as T } from './passkey-setup';
import { operationReason, PasskeyCancelled, PasskeyError, passkeyErrorText } from './passkeys';

export type BackupPasskeyProgress = (note: string) => void;
export interface PasskeySetupFeedback {
  note: string | null;
  complete: boolean;
  /** An interrupted check or another Whombat still needs finishing. */
  pending?: boolean;
}
type Tap = (onProgress?: BackupPasskeyProgress) => Promise<PasskeySetupFeedback>;
type Load = () => Promise<PasskeySetupView>;
type State = {
  busy: boolean;
  note: string | null;
  view: PasskeySetupView | null;
  loadError: boolean;
  unfinished: boolean;
};

/** One setup action, status and feedback wherever this Whombat asks for a passkey. */
export interface BackupPasskeyTap extends State {
  (): Promise<PasskeySetupFeedback>;
  label: string;
  refresh(): Promise<void>;
}

function makeFlow() {
  let state: State = { busy: false, note: null, view: null, loadError: false, unfinished: false };
  let pending: Promise<PasskeySetupFeedback> | null = null;
  let reading: Promise<void> | null = null;
  let revision = 0;
  const listeners = new Set<() => void>();
  const update = (next: State) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const refresh = (load: Load): Promise<void> => {
    if (reading) return reading;
    const at = revision;
    const work = Promise.resolve()
      .then(load)
      .then(
        (view) => {
          if (at !== revision) return;
          update({ ...state, view, loadError: false });
        },
        () => {
          if (at === revision) update({ ...state, loadError: true });
        },
      )
      .finally(() => {
        if (reading === work) reading = null;
      });
    reading = work;
    return work;
  };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    tap(invoke: Tap, load: Load): Promise<PasskeySetupFeedback> {
      if (pending) return pending;
      if (state.loadError || !state.view) return refresh(load).then(() => ({ note: null, complete: false }));
      revision++;
      reading = null;
      const previousNote = state.note;
      const progress = (note: string) => update({ ...state, note });
      pending = Promise.resolve()
        .then(() => invoke(progress))
        .then((result) => {
          update({
            ...state,
            unfinished: result.complete ? false : (result.pending ?? state.unfinished),
            note: result.note ?? previousNote,
          });
          return result;
        })
        .catch((error) => {
          update({ ...state, note: previousNote });
          throw error;
        })
        .finally(async () => {
          await refresh(load);
          pending = null;
          update({ ...state, busy: false });
        });
      update({ ...state, busy: true });
      return pending;
    },
  };
}

// Feedback and unfinished checks survive navigation. A different appliance session gets its own flow.
const flows = new WeakMap<object, ReturnType<typeof makeFlow>>();

export function useBackupPasskeyAction(scope: object | null, invoke: Tap, load: Load): BackupPasskeyTap {
  const flow = useMemo(() => {
    if (!scope) return makeFlow();
    let found = flows.get(scope);
    if (!found) {
      found = makeFlow();
      flows.set(scope, found);
    }
    return found;
  }, [scope]);
  useEffect(() => {
    if (scope) void flow.refresh(load);
  }, [scope, flow, load]);
  const refresh = useMemo(() => () => flow.refresh(load), [flow, load]);
  const state = useSyncExternalStore(flow.subscribe, flow.snapshot, flow.snapshot);
  return useMemo(() => {
    const settled =
      state.unfinished && state.view?.phase === 'ready'
        ? { phase: 'incomplete' as const, title: T.incomplete, meta: T.intro, action: T.finish }
        : state.view;
    const view =
      state.busy && settled
        ? { ...settled, phase: 'incomplete' as const, title: T.settingUp, action: T.finish }
        : settled;
    return Object.assign(() => flow.tap(invoke, load), {
      ...state,
      view,
      label: state.busy
        ? T.checking
        : state.loadError
          ? 'Try again'
          : !view
            ? T.loading
            : (view.action ?? T.check),
      refresh,
    });
  }, [flow, invoke, load, refresh, state]);
}

/** The default ceremony on every entry point; no separate sign-in-only, backup or upgrade action. */
export function useOnePasskeySetup(
  input: Parameters<typeof setUpOnePasskey>[0] | null,
): BackupPasskeyTap | null {
  const session = input?.session;
  const control = input?.control;
  const platform = input?.platform;
  const appliance = input?.appliance ?? '';
  const me = input?.me ?? null;
  const name = input?.name ?? '';
  const whombats = input?.whombats;
  const load = useCallback(async () => {
    if (!session || !control) throw new Error('No account');
    return readPasskeySetup({ session, control, appliance, me });
  }, [session, control, appliance, me]);
  const invoke = useCallback(
    async (onProgress?: BackupPasskeyProgress): Promise<PasskeySetupFeedback> => {
      if (!session || !control || !platform) return { note: null, complete: false };
      try {
        const result = await setUpOnePasskey({
          session,
          control,
          platform,
          appliance,
          me,
          name,
          whombats,
          onProgress,
        });
        return {
          note: onePasskeyWords(result),
          complete: result.pending.length === 0,
          pending: result.pending.length > 0,
        };
      } catch (error) {
        return {
          note:
            error instanceof PasskeyCancelled
              ? ONE_PASSKEY_TEXT.cancelled
              : error instanceof OperationError && operationReason(error) === 'backup_passkey_saving'
                ? T.saving
                : error instanceof PasskeyError && error.code === 'unsupported'
                  ? T.unsupported
                  : passkeyErrorText(error),
          complete: false,
          pending: true,
        };
      }
    },
    [session, control, platform, appliance, me, name, whombats],
  );
  const tap = useBackupPasskeyAction(session ?? null, invoke, load);
  return input ? tap : null;
}
