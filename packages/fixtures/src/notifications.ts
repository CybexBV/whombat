/**
 * Mara's inbox: NEEDS YOU / MENTIONS / FROM THE AGENT. From `needs`/`mentions`/`agents` in `Whombat Mobile.dc.html`,
 * told with one agent and one person: everything the agent did is Dusty's, and so is the mention in the branch room.
 */
import type { Notification } from '@whombat/core/domain';
import { BURROW_ID } from './burrow.js';
import { dusty, mara } from './principals.js';

const PR482_LINK = { type: 'pr', number: 482, repo: 'whombat/billing' } as const;

import { at } from './time.js';

export const ntf_needs_deploy: Notification = {
  id: 'ntf_needs-deploy',
  burrowId: BURROW_ID,
  principalId: mara.id,
  kind: 'needs_you',
  actorId: dusty.id,
  where: 'feat/invoice-pdf',
  text: 'Deploy feat/invoice-pdf to staging. Checks are green.',
  link: { type: 'approval', number: 12, in: PR482_LINK },
  approvalId: 'apr_staging-482',
  createdAt: at('11:25'),
  readAt: null,
};

export const ntf_needs_plan: Notification = {
  id: 'ntf_needs-plan',
  burrowId: BURROW_ID,
  principalId: mara.id,
  kind: 'needs_you',
  actorId: dusty.id,
  where: 'Plan canvas',
  text: 'The invoice PDF plan needs a person to sign off step 4.',
  link: { type: 'canvas', slug: 'invoice-pdf-export-plan' },
  approvalId: null,
  createdAt: at('11:02'),
  readAt: null,
};

export const ntf_mention_pr482: Notification = {
  id: 'ntf_mention-pr482',
  burrowId: BURROW_ID,
  principalId: mara.id,
  kind: 'mention',
  actorId: dusty.id,
  where: 'feat/invoice-pdf',
  text: 'I can put this on staging as soon as the fix is green. @Mara, I need your yes first.',
  link: { type: 'message', in: PR482_LINK, messageId: 'msg_pr482-dusty-1125' },
  approvalId: null,
  createdAt: at('11:25'),
  readAt: null,
};

export const ntf_mention_dm_dusty: Notification = {
  id: 'ntf_mention-dm-dusty',
  burrowId: BURROW_ID,
  principalId: mara.id,
  kind: 'reply',
  actorId: dusty.id,
  where: 'Chat',
  text: 'It does. Step 2 reads the number from the invoice-number service instead of generating one.',
  link: {
    type: 'message',
    in: { type: 'dm' },
    messageId: 'msg_dm-dusty-dusty-1404',
    threadRootId: 'msg_dm-dusty-mara-1402',
  },
  approvalId: null,
  createdAt: at('14:04'),
  readAt: null,
};

export const ntf_agent_dusty: Notification = {
  id: 'ntf_agent-dusty',
  burrowId: BURROW_ID,
  principalId: mara.id,
  kind: 'agent_update',
  actorId: dusty.id,
  where: 'feat/invoice-pdf',
  text: 'Pushed 7be20f. 41 of 41 tests pass.',
  link: PR482_LINK,
  approvalId: null,
  createdAt: at('11:36'),
  readAt: null,
};

export const NOTIFICATIONS: Notification[] = [
  ntf_needs_deploy,
  ntf_needs_plan,
  ntf_mention_pr482,
  ntf_mention_dm_dusty,
  ntf_agent_dusty,
];
