/**
 * A page's buttons as every kind draws them (service-dashboards.md SD-07, SD-S04; contracts CT-1001): the same rules as
 * Restart (CP-12) — allowed when Whombat may change things there; drawn disabled, with the reason, on Look only. The
 * person manages every connection (one-person.md OP-S07). `things/actions.ts` checks the same again when one is pressed.
 */
import type { ThingPageButton } from '@whombat/core';
import type { CatalogConnectionRow } from '../../connections/types';
import { displayName } from '../part-of';
import type { KindCtx } from './types';

/** A button on a page (CT-1001). */
export type PageButton = ThingPageButton;

/** Why the person may not press a button here, or null when they may. */
export function buttonRefusal(ctx: {
  row: Pick<CatalogConnectionRow, 'access' | 'label' | 'catalogId' | 'fields'>;
}): string | null {
  if (ctx.row.access === 'read')
    return `${displayName(ctx.row)} is set to Look only, so Whombat changes nothing there. Set it to Manage in Settings first.`.slice(
      0,
      200,
    );
  return null;
}

/** A button for this page's reader: its words clipped to the contract, allowed or not with the reason. */
export function pageButton(
  ctx: Pick<KindCtx, 'row'>,
  spec: Omit<PageButton, 'allowed' | 'reason'>,
): PageButton {
  const refusal = buttonRefusal(ctx);
  return {
    ...spec,
    label: spec.label.slice(0, 30),
    ...(spec.target !== undefined ? { target: spec.target.slice(0, 200) } : {}),
    ...(typeof spec.value === 'string' ? { value: spec.value.slice(0, 100) } : {}),
    ...(spec.confirm
      ? {
          confirm: {
            title: spec.confirm.title.slice(0, 80),
            body: spec.confirm.body.slice(0, 300),
            button: spec.confirm.button.slice(0, 30),
          },
        }
      : {}),
    allowed: refusal === null,
    ...(refusal ? { reason: refusal } : {}),
  };
}
