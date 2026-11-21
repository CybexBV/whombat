/** The live-activity viewer (`LiveViewer`) from the burrow's bootstrap. Pure. */
import { type Bootstrap, shortNameOf } from '@whombat/core';
import type { LiveViewer } from '../../modules/whombat-live/src/content';
import { conversationsById, type People } from '../data/people';

export function liveViewer(bootstrap: Pick<Bootstrap, 'me' | 'sidebar'>, people: People): LiveViewer {
  const conversations = conversationsById(bootstrap);
  return {
    id: bootstrap.me.id,
    // Whombat's own signers (an automation asking for a run) aren't a person: as the agent, the room's people see it.
    kindOf: (id) => {
      const kind = people.get(id)?.kind;
      return kind === 'system' ? 'agent' : kind;
    },
    nameOf: (id) => {
      const p = people.get(id);
      return p ? shortNameOf(p) : 'Someone';
    },
    inConversation: (id) => conversations.has(id),
  };
}
