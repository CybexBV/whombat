/**
 * A turn as this runner can run it: the commands and gh it really gets, whatever the dispatch asked for.
 */

import { isCommandsTurn } from '@whombat/agent-runtime';
import type { DispatchContext } from '@whombat/core';
import { ghContextOf } from '../gh';
import type { TurnDeps } from './deps';

export interface TurnShape {
  /** The context the turn is built from: without the commands' context or gh this runner doesn't give it. */
  ctx: DispatchContext;
  /** A person's turn with commands (one-person.md OP-07): its production servers, home networks, keys, `~/work`. */
  commandsTurn: boolean;
  ghTurn: boolean;
}

/**
 * A turn as this runner builds it from a context (the commands and gh it really gets):
 * - A person's commands turn (OP-07, AC-23, AC-24): the server gave the turn its commands' context, this runner runs
 *   commands, and it isn't an assessment (`isCommandsTurn`); without a checkout it works in the agent's work folder.
 *   Otherwise the turn is built without it, so neither its folder nor its prompt assumes one (AC-51, AC-DP02).
 * - gh through Whombat (agent-gh.md AGH-02, AGH-12): a live turn the server gave it, on a runner whose API has the
 *   endpoint. Otherwise the turn is built without it, so the prompt doesn't promise a gh.
 */
export function shapeOf(c: DispatchContext, deps: Pick<TurnDeps, 'commands' | 'api'>): TurnShape {
  const commandsTurn = !!deps.commands && isCommandsTurn(c);
  const ghTurn = !!deps.api.ghAuthorize && ghContextOf(c) !== null;
  const withCommands: DispatchContext = commandsTurn || !c.commands ? c : { ...c, commands: null };
  const ctx: DispatchContext = ghTurn || !withCommands.gh ? withCommands : { ...withCommands, gh: null };
  return { ctx, commandsTurn, ghTurn };
}
