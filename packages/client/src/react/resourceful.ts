/**
 * Resourceful agents (contracts 0.44.0; Whombat resourceful-agents.md RA-30, RA-41…RA-44; since 0.125 hermes-engine.md
 * HE-39): what the agent remembers about the person and the agent's notes, its schedules, and the burrow's LAN switch. Every write answers the thing as it is now, which goes into its read at once;
 * a refusal (`validation_failed` with `details.reason`, `forbidden`, `not_found`) rejects as an `ApiError` with the
 * server's sentence.
 */
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentScheduleView, Burrow } from '@whombat/core';
import { type AnyEndpoint, api } from '@whombat/core/contracts';
import type { CallInput, CommitResult, ResponseData } from '../http/types';
import { patchMessages } from '../query/apply';
import { patchEndpoint } from '../query/cache';
import { queryKeys } from '../query/keys';
import { cardPatchers, patchCard } from '../query/reducers';
import { useWhombat } from './context';
import { queryHook } from './queries';

/**
 * What the agent remembers about the viewer (`memory.mine`, CT-1202): about working with them and about them, from their
 * own Hermes profile. Theirs alone, owners included.
 */
export const useMyMemory = queryHook(api.memory.mine);
/** The agent's notes for everyone (Settings → Agent → Notes, `memory.notes`, CT-1205). */
export const useAgentNotes = queryHook(api.memory.notes);
/** Reminders and checks the agent set for itself (Automations, under Only tells you; `schedules.list`). */
export const useAgentSchedules = queryHook(api.schedules.list);

/** One write to an endpoint; `onOk` puts its answer where it shows. */
function useWrite<E extends AnyEndpoint>(ep: E, onOk: (qc: QueryClient, data: ResponseData<E>) => void) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ResponseData<E>>, Error, CallInput<E>>({
    mutationFn: (input) => client.request(ep, input),
    onSuccess: (result) => {
      if (result.status === 'ok') onOk(qc, result.data);
    },
  });
}

/* What the agent remembers (HE-39, CT-1200…CT-1205; app AP-5207) ------------------------------------------------ */

/**
 * Replace one of the viewer's memory files (`memory.write`, with the `ifVersion` the edit started from) or forget
 * (`memory.clear`, both files or one); the answer is their memory as it is now. A file the agent changed meanwhile, or a
 * turn holding it, rejects as `conflict` (`details.reason` `busy` for the turn); over its limit, `validation_failed`
 * `too_long`.
 */
export function useMemoryWrite<E extends typeof api.memory.write | typeof api.memory.clear>(
  ep: E,
  burrow: string,
) {
  return useWrite(ep, (qc, data) => {
    qc.setQueryData(queryKeys.endpoint(api.memory.mine, { params: { burrow } }), data);
  });
}

/** Save the agent's notes for everyone (owners, `memory.setNotes`); the answer is the notes as they are now. */
export function useSetAgentNotes(burrow: string) {
  return useWrite(api.memory.setNotes, (qc, data) => {
    qc.setQueryData(queryKeys.endpoint(api.memory.notes, { params: { burrow } }), data);
  });
}

/* Schedules (RA-30) ----------------------------------------------------------------------------------------------- */

/** A schedule as it is now, everywhere it shows: the agent's Schedules tab and its card in the room. */
export function applySchedule(qc: QueryClient, schedule: AgentScheduleView): void {
  patchEndpoint<{ schedules: AgentScheduleView[] }>(qc, 'schedules.list', (d) =>
    d.schedules.some((s) => s.id === schedule.id)
      ? {
          schedules: d.schedules.map((s) =>
            s.id === schedule.id ? { ...schedule, prompt: schedule.prompt ?? s.prompt } : s,
          ),
        }
      : d,
  );
  patchMessages({ qc }, (m) => patchCard(m, cardPatchers.schedule(schedule)));
}

/** Pause, Resume or Remove a schedule (the card's Cancel is Remove). */
export function useScheduleAction<
  E extends typeof api.schedules.pause | typeof api.schedules.resume | typeof api.schedules.remove,
>(ep: E) {
  return useWrite(ep, (qc, data) => applySchedule(qc, data.schedule));
}

/* The LAN switch (RA-41) ------------------------------------------------------------------------------------------ */

/** “Agents may reach your local network”; the burrow as it is now goes into the bootstrap and `burrows.get`. */
export function useSetAgentsReachLan(burrow: string) {
  return useWrite(api.burrows.setAgentsReachLan, (qc, data) => applyBurrow(qc, burrow, data.burrow));
}

/* The AI gateway's switches (Whombat ai-gateway.md AIG-05; app AP-1117) ------------------------------------------- */

/**
 * “Send Claude Code through Fusebox” / “Send ChatGPT through Fusebox” (`burrows.setAiGateway`, owners); the burrow as it is
 * now, with its `aiGateway`, goes into the bootstrap and `burrows.get`.
 */
export function useSetAiGateway(burrow: string) {
  return useWrite(api.burrows.setAiGateway, (qc, data) => applyBurrow(qc, burrow, data.burrow));
}

/* A model on your network (Whombat hermes-engine.md HE-32; contracts 0.124 CT-1171; app AP-5008) ---------------------- */

/**
 * Set, change or remove the model on the owner's network (`burrows.setLocalModel`, `burrows.clearLocalModel`, owners):
 * the burrow as it is now goes into the bootstrap and `burrows.get`, and the Chat picker reads its providers again
 * (Local comes and goes with it).
 */
export function useSetLocalModel(burrow: string) {
  return useWrite(api.burrows.setLocalModel, (qc, data) => {
    applyBurrow(qc, burrow, data.burrow);
    void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.runtime') });
  });
}

export function useClearLocalModel(burrow: string) {
  return useWrite(api.burrows.clearLocalModel, (qc, data) => {
    applyBurrow(qc, burrow, data.burrow);
    void qc.invalidateQueries({ queryKey: queryKeys.scope('chats.runtime') });
  });
}

/**
 * Test it (`burrows.testLocalModel`): a draft is only tried; the saved model checked again keeps its result, which goes
 * into the burrow's `localModel.check` at once (the server publishes the burrow too).
 */
export function useTestLocalModel(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  const ep = api.burrows.testLocalModel;
  return useMutation<CommitResult<ResponseData<typeof ep>>, Error, CallInput<typeof ep>>({
    mutationFn: (input) => client.request(ep, input),
    onSuccess: (result, input) => {
      if (result.status !== 'ok' || input.body?.draft) return;
      const check = result.data.check;
      const patch = (d: { burrow: Burrow }) =>
        d.burrow?.localModel
          ? { ...d, burrow: { ...d.burrow, localModel: { ...d.burrow.localModel, check } } }
          : d;
      patchEndpoint<{ burrow: Burrow }>(qc, 'conversations.bootstrap', patch, { burrow });
      patchEndpoint<{ burrow: Burrow }>(qc, 'burrows.get', patch, { burrow });
    },
  });
}

function applyBurrow(qc: QueryClient, slug: string, next: Burrow): void {
  patchEndpoint<{ burrow: Burrow }>(
    qc,
    'conversations.bootstrap',
    (d) => (d.burrow?.id === next.id ? { ...d, burrow: { ...d.burrow, ...next } } : d),
    { burrow: slug },
  );
  patchEndpoint<{ burrow: Burrow }>(
    qc,
    'burrows.get',
    (d) => (d.burrow?.id === next.id ? { ...d, burrow: { ...d.burrow, ...next } } : d),
    { burrow: slug },
  );
}
