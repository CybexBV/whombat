/**
 * The skill library in React (contracts 3.0 CT-1570…CT-1572; app hermes-skills.md AP-5523, was hermes-engine-app.md
 * AP-5203): one hook per read and the writes, the same on the web and the phone (`@whombat/client/skill-library/react`).
 * A skill is its name (one list). A write's answer goes into the cached library at once (a switch flips before the
 * answer comes back); then the library and the open skill read again. Hermes's hub: search, preview, install, the
 * update check (when Settings → Skills opens, at most once an hour, HSK-09) and update.
 */
import { type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AnyEndpoint } from '@whombat/core/contracts';
import { SKILL_UPDATE_CHECK_MS } from '@whombat/core/skills';
import { useEffect, useMemo } from 'react';
import type { BodyInput, CallInput, CommitResult, ResponseData } from '../http/types';
import { endpointScope } from '../query/keys';
import { useWhombat } from '../react/context';
import { queryHook } from '../react/queries';
import { skillLibraryEndpoints as E, type SkillLibrary, type SkillLibraryItem } from './contract';

/** Every skill of the agent, and Hermes's categories. */
export const useSkillLibrary = queryHook(E.library);
/** One skill (`{name}`): its SKILL.md, files and what Compare compares it with. */
export const useSkillLibrarySkill = queryHook(E.skill);
/** One of a skill's files. */
export const useSkillLibraryFile = queryHook(E.file);
/** Browse (no `q`) or search Hermes's hub, all three sources or one. */
export const useSkillHubSearch = queryHook(E.hubSearch);
/** One hub skill as Install would take it: its text, Hermes's scan and what its policy decides. */
export const useSkillHubPreview = queryHook(E.hubPreview);
/** Hermes's update check of the installed hub skills: use `useSkillHubUpdateCheck`. */
export const useSkillHubUpdates = queryHook(E.hubUpdates);

const READS = [E.library.id, E.skill.id, E.file.id];

/** Change the cached library of the burrow. */
function patchLibraries(
  qc: QueryClient,
  burrow: string,
  patch: (items: SkillLibraryItem[]) => SkillLibraryItem[],
): void {
  qc.setQueriesData<SkillLibrary>({ queryKey: endpointScope(E.library, { burrow }) }, (old) =>
    old ? { ...old, items: patch(old.items) } : old,
  );
}

/** Put a row the server answered into the cached library, in the place of the row of its name (or added). */
export function applySkillItem(qc: QueryClient, burrow: string, item: SkillLibraryItem): void {
  patchLibraries(qc, burrow, (items) =>
    items.some((i) => i.name === item.name)
      ? items.map((i) => (i.name === item.name ? item : i))
      : [...items, item],
  );
}

/** Drop a row from the cached library. */
function dropSkillItem(qc: QueryClient, burrow: string, name: string): void {
  patchLibraries(qc, burrow, (items) => items.filter((i) => i.name !== name));
}

/** The library and the open skill read again. */
export function invalidateSkillLibrary(qc: QueryClient, burrow: string): void {
  for (const id of READS) void qc.invalidateQueries({ queryKey: endpointScope(id, { burrow }) });
}

/** What the hub knows is installed (search, preview) and the update check read again. */
function invalidateHub(qc: QueryClient, burrow: string): void {
  for (const id of [E.hubSearch.id, E.hubPreview.id, E.hubUpdates.id])
    void qc.invalidateQueries({ queryKey: endpointScope(id, { burrow }) });
}

type ItemWrite = typeof E.edit | typeof E.restore | typeof E.switch | typeof E.remove;

type WriteBody = { name?: string; on?: boolean };

/**
 * A change to one skill (edit, restore, switch, remove). The answer's row replaces the cached one (a removal that left
 * nothing drops it), then the reads refetch. A switch shows its new state at once and goes back if the server refuses.
 * Removing a hub skill uninstalls it, so the hub's reads refetch too.
 */
export function useSkillLibraryWrite<W extends ItemWrite>(ep: W, burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ResponseData<W>>, Error, CallInput<W>, { previous: [unknown, unknown][] }>({
    mutationFn: (input) => client.request(ep as AnyEndpoint, input) as Promise<CommitResult<ResponseData<W>>>,
    onMutate: async (input) => {
      if (ep.id !== E.switch.id) return { previous: [] };
      const body = (input as { body: WriteBody }).body;
      const scope = { queryKey: endpointScope(E.library, { burrow }) };
      await qc.cancelQueries(scope);
      const previous = qc.getQueriesData<SkillLibrary>(scope);
      patchLibraries(qc, burrow, (items) =>
        items.map((i) =>
          i.name === body.name ? { ...i, enabled: body.on === true, status: body.on ? 'on' : 'off' } : i,
        ),
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      for (const [key, data] of context?.previous ?? []) qc.setQueryData(key as readonly unknown[], data);
    },
    onSuccess: (result, input) => {
      if (result.status !== 'ok') return;
      const body = (input as { body: WriteBody }).body;
      const item = (result.data as { item: SkillLibraryItem | null }).item;
      if (item) applySkillItem(qc, burrow, item);
      else if (body.name) dropSkillItem(qc, burrow, body.name);
      if (ep.id === E.remove.id) invalidateHub(qc, burrow);
    },
    onSettled: () => invalidateSkillLibrary(qc, burrow),
  });
}

/**
 * Install a hub skill (HSK-06): through Hermes's scan and policy again. The new row goes into the
 * library at once; the library and what the hub knows is installed read again.
 */
export function useSkillHubInstall(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ResponseData<typeof E.hubInstall>>, Error, BodyInput<typeof E.hubInstall>>({
    mutationFn: (body) => client.request(E.hubInstall, { params: { burrow }, body }),
    onSuccess: (result) => {
      if (result.status === 'ok') applySkillItem(qc, burrow, result.data.item);
    },
    onSettled: () => {
      invalidateSkillLibrary(qc, burrow);
      invalidateHub(qc, burrow);
    },
  });
}

/** Install a hub skill's newer version (HSK-09): its row in place, the update check read again. */
export function useSkillHubUpdate(burrow: string) {
  const { client } = useWhombat();
  const qc = useQueryClient();
  return useMutation<CommitResult<ResponseData<typeof E.hubUpdate>>, Error, BodyInput<typeof E.hubUpdate>>({
    mutationFn: (body) => client.request(E.hubUpdate, { params: { burrow }, body }),
    onSuccess: (result) => {
      if (result.status === 'ok') applySkillItem(qc, burrow, result.data.item);
    },
    onSettled: () => {
      invalidateSkillLibrary(qc, burrow);
      void qc.invalidateQueries({ queryKey: endpointScope(E.hubUpdates.id, { burrow }) });
    },
  });
}

/** The hub skills of a library (not removed). */
function hubNames(library: SkillLibrary | undefined): string[] {
  return (library?.items ?? [])
    .filter((i) => i.origin === 'hub' && i.status !== 'removed')
    .map((i) => i.name);
}

/**
 * Hermes's update check of the installed hub skills, when Settings → Skills opens (HSK-09, CT-1415): only while there
 * are hub skills, at most once an hour (the runtime runs it again only when its last answer is older). The
 * names it found a newer version of; when one the library doesn't mark yet is there, the library reads again so its
 * rows (and `can.update`) say so.
 */
export function useSkillHubUpdateCheck(
  burrow: string,
  library: SkillLibrary | undefined,
): ReadonlySet<string> {
  const qc = useQueryClient();
  const enabled = hubNames(library).length > 0;
  const result = useSkillHubUpdates(
    { params: { burrow } },
    { enabled, staleTime: SKILL_UPDATE_CHECK_MS, retry: false },
  );
  const available = result.data?.available;
  const set = useMemo(() => new Set(available ?? []), [available]);
  const unmarked =
    library?.items.some((i) => i.origin === 'hub' && set.has(i.name) && !i.hub?.updateAvailable) ?? false;
  useEffect(() => {
    if (unmarked) void qc.invalidateQueries({ queryKey: endpointScope(E.library.id, { burrow }) });
  }, [unmarked, qc, burrow]);
  return set;
}
