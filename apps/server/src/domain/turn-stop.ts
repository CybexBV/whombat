/**
 * Which turns Stop applies to (docs/decisions/review-features.md RF-01; contracts CT-295). Pure.
 *
 * A turn another part of Whombat owns isn't stopped from the thinking line or the Work view: a Feedback assessment
 * (its report's flow ends it), an automation step (its run waits for it) and a search answer (the search screen waits for
 * it). Those are the turns `retryable` leaves out. A run's turn is stoppable here but answers “Pause the run instead.” (`TURN_STOP_RUN_REFUSAL`): the run line offers Pause.
 */
import type { DispatchMode, DispatchTrigger } from '@whombat/core';

export function stoppableTurn(row: { trigger: DispatchTrigger; mode: DispatchMode }): boolean {
  return row.trigger !== 'feedback' && row.trigger !== 'automation' && row.mode !== 'answer';
}
