/**
 * `guides.act` (docs/decisions/assistant-guides.md AG-03, contracts CT-81): the DM's owner acts on a guide card.
 * The app setup's form is saved first (account-level, CN-07), and a Vault card's form into the person's Vault
 * (connect-in-chat.md), and a connect card's key into the connection it makes (connect-by-talking.md); their values go
 * only there, never into the command, a message, a log or an event. Then the
 * `guide_act` command locks the card and posts what follows.
 */
import { api } from '@whombat/core';
import { commitAs } from '../routes/burrows';
import { route } from '../routes/define';
import { cardAnswered } from '../vault/login-asks';
import { actOnGuide } from './commands';
import { guideError } from './place';

export const guideRoutes = [
  route(api.guides.act, async (ctx) => {
    const { access, params, body, services } = ctx;
    if (access.principal.kind !== 'person') throw guideError('not_yours', 'Only people answer guide cards.');
    const saved = await services.guides.saveAppFromForm(
      access.burrow.id,
      access.principal.id,
      params.messageId,
      body,
    );
    // A Vault card (connect-in-chat.md, vault-simplify.md): answered here, only how it ended goes on.
    const vault = saved
      ? undefined
      : await services.guides.answerVaultCard(access.burrow.id, access.principal.id, params.messageId, body);
    // A card that connects on the card (connect-by-talking.md): connected here, only how it ended goes on.
    const connect =
      saved || vault
        ? undefined
        : await services.guides.answerConnectCard(
            access.burrow.id,
            access.principal.id,
            params.messageId,
            body,
          );
    await commitAs(ctx, actOnGuide, {
      messageId: params.messageId,
      actionId: body.actionId,
      ...(body.optionIds ? { optionIds: body.optionIds } : {}),
      ...(saved ? { saved } : {}),
      ...(vault ? { vault } : {}),
      ...(connect ? { connect } : {}),
    });
    // A turn waiting on the card hears at once (`runner.loginAskWait`).
    if (vault) cardAnswered(services, params.messageId);
    return { ok: true as const };
  }),
];
