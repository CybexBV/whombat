/** The shape of an area's steps (one module per area: memory, sessions, archive, skills). */
import type { HermesHomeArgs, HermesHomeMethod, HermesHomeResult } from '@whombat/core';
import type { HermesHomeContext } from './context';

/** A step: its params already checked against the protocol; its result is checked again by the server. */
export type HermesHomeHandler<M extends HermesHomeMethod> = (
  ctx: HermesHomeContext,
  params: HermesHomeArgs<M>,
) => Promise<HermesHomeResult<M>>;

export type AreaHandlers<M extends HermesHomeMethod> = { [K in M]: HermesHomeHandler<K> };
