/**
 * What the agent remembers, as the person sees and changes it (contracts `api.memory`, CT-1200…CT-1206; hermes-engine.md
 * HE-39, HE-S122; one-person.md OP-01): the person's Hermes memory (`memory.mine`, `memory.write`, `memory.clear`)
 * through the runner (HE-38), and the agent's notes (`memory.notes`, `memory.setNotes`). Over a session each is an
 * `api` op of the same name.
 */
import { AGENT_NOTES_MAX, type AgentNotes, api } from '@whombat/core';
import type { BurrowAccess } from '../auth/request';
import { forbidden, notFound } from '../lib/errors';
import { loadAgentRow } from '../read/principals';
import { ok, type RouteDef, route } from '../routes/define';
import type { Services } from '../services';
import { agentNotesOf, setAgentNotes } from './notes';
import { clearPersonMemory, readPersonMemory, writePersonMemory } from './person';

type Access = Pick<BurrowAccess, 'principal'>;

/** The agent's name, for the person's memory: only the person has one here. */
async function mine(services: Services, access: Access, burrowId: string) {
  if (access.principal.kind !== 'person') throw forbidden('Only you have a memory here.');
  const agent = await loadAgentRow(services.db, burrowId);
  return { agentName: agent?.name ?? 'The agent' };
}

async function notesView(services: Services, burrowId: string): Promise<AgentNotes> {
  const notes = await agentNotesOf(services.db, burrowId);
  return {
    text: notes?.text ?? '',
    used: [...(notes?.text ?? '')].length,
    limit: AGENT_NOTES_MAX,
    updatedAt: notes?.updatedAt ?? null,
  };
}

export const memoryRoutes: RouteDef[] = [
  route(api.memory.mine, async ({ access, services }) => {
    const me = await mine(services, access, access.burrow.id);
    return readPersonMemory(services, me.agentName);
  }),
  route(api.memory.write, async ({ access, body, params, services }) => {
    const me = await mine(services, access, access.burrow.id);
    return writePersonMemory(services, me.agentName, {
      file: params.file,
      text: body.text,
      ...(body.ifVersion !== undefined ? { ifVersion: body.ifVersion } : {}),
    });
  }),
  route(api.memory.clear, async ({ access, query, services }) => {
    const me = await mine(services, access, access.burrow.id);
    return clearPersonMemory(services, me.agentName, query.file);
  }),
  route(api.memory.notes, async ({ access, services }) => {
    if (!(await loadAgentRow(services.db, access.burrow.id))) throw notFound('Agent');
    return notesView(services, access.burrow.id);
  }),
  route(api.memory.setNotes, async ({ access, body, services }) => {
    ok(
      await services.pipeline.commit(
        setAgentNotes,
        { text: body.text },
        { burrowId: access.burrow.id, actorId: access.principal.id },
      ),
    );
    return notesView(services, access.burrow.id);
  }),
];
