import {
  delegationAiChoice,
  delegationAiDraft,
  delegationAiMenu,
  delegationAiOf,
  DELEGATION_AI_WORDS as W,
  withAiModel,
} from '@whombat/client';
import { queryHook, useApiMutation } from '@whombat/client/react';
import type { DelegationAi, DelegationAiChoice, DelegationCard } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import rt from '../chats/runtime/ChatRuntime.module.css';
import { Bolt } from '../chats/runtime/ChatRuntimeButton';
import { outcomeText } from '../conversations/refusal';
import d from './DelegationCard.module.css';

/** What T3 Code runs now, asked when a menu opens (`delegations.models`). */
const useDelegationModels = queryHook(api.delegations.models);

const GAP = 8;
const WIDTH = 320;

export interface DelegationAiMenuProps {
  burrow: string;
  /** The checklist it chooses for; absent with `onPick` (a prompt's AI). */
  card?: Pick<DelegationCard, 'delegationId'>;
  /** The task it chooses for; absent: every task without a choice of its own. */
  task?: { id: string; n: number; title: string };
  /** The AI chosen now (the task's, or every task's). */
  current: DelegationAi | null | undefined;
  /** Under the title of every task's menu: “2 of 3 use this”. */
  subtitle?: string | null;
  anchor: HTMLElement | null;
  onClose: (restoreFocus: boolean) => void;
  /** The choice went through: the card shows it until its own update brings it. */
  onChosen: (ai: DelegationAi | null) => void;
  /**
   * Done hands the choice to the caller instead of sending it to a checklist (a prompt's editor keeps it until Save).
   */
  onPick?: (choice: DelegationAiChoice | null) => void;
  /** The menu's title instead of a checklist's (“AI”). */
  title?: string;
  /** Where it is drawn (inside a dialog, so the dialog keeps it); default the page. */
  container?: HTMLElement | null;
}

/**
 * The small menu that chooses a task's AI on the checklist, or every task's: the models T3 Code runs (first the
 * default), the chosen model's efforts, and its fast tier where it has one, in the reply box's AI popover's look so the two read alike. Done sends the choice; Escape or a click outside
 * leaves it as it was. It opens under its button, or above it near the bottom of the window.
 */
export function DelegationAiMenu({
  burrow,
  card,
  task,
  current,
  subtitle,
  anchor,
  onClose,
  onChosen,
  onPick,
  title: ownTitle,
  container,
}: DelegationAiMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const ids = { name: useId(), effort: useId(), fast: useId(), title: useId() };
  const models = useDelegationModels({ params: { burrow } }, { retry: false, staleTime: 60_000 });
  const setAi = useApiMutation(api.delegations.setAi);
  const [draft, setDraft] = useState(() => delegationAiDraft(current));
  const [place, setPlace] = useState<{
    left: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);
  const options = models.data?.options ?? null;
  const menu = options ? delegationAiMenu(options, draft, current) : null;

  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    // It opens toward the middle of the window: from Hand over's arrow rightwards, from a task's chip leftwards.
    const fromLeft = r.left + r.width / 2 < window.innerWidth / 2;
    const left = Math.max(
      GAP,
      Math.min(fromLeft ? r.left : r.right - WIDTH, window.innerWidth - WIDTH - GAP),
    );
    const below = window.innerHeight - r.bottom - GAP * 2;
    const above = r.top - GAP * 2;
    setPlace(
      below >= 360 || below >= above
        ? { left, top: r.bottom + GAP, maxHeight: below }
        : { left, bottom: window.innerHeight - r.top + GAP, maxHeight: above },
    );
  }, [anchor]);

  // Focus on the chosen model once the list is there.
  const listed = !!menu;
  useEffect(() => {
    if (listed) ref.current?.querySelector<HTMLElement>('input[type="radio"]:checked')?.focus();
    else ref.current?.focus();
  }, [listed]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchor?.contains(target)) onClose(false);
    };
    const onResize = () => onClose(false);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor, onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
      return;
    }
    if (event.key !== 'Tab') return;
    // Focus stays in the menu while it is open; Escape leaves it.
    const focusable = [
      ...(ref.current?.querySelectorAll<HTMLElement>('input:checked, input:not([type="radio"]), button') ??
        []),
    ].filter((el) => !el.hasAttribute('disabled'));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const done = async () => {
    if (onPick) {
      onPick(delegationAiChoice(draft, options ?? []));
      onChosen(delegationAiOf(options ?? [], draft));
      onClose(true);
      return;
    }
    if (!card) return;
    try {
      const r = await setAi.mutateAsync({
        params: { burrow },
        body: {
          delegationId: card.delegationId,
          ...(task ? { taskId: task.id as never } : {}),
          ai: delegationAiChoice(draft, options ?? []),
        },
      });
      if (r.status === 'ok') onChosen(delegationAiOf(options ?? [], draft));
      else toast.show(outcomeText(r));
      onClose(true);
    } catch {
      toast.show(W.failed);
    }
  };

  const title = ownTitle ?? (task ? W.taskTitle(task.n) : W.allTitle);
  const first = task ? W.sameAsOthers : W.t3Default;
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={ids.title}
      tabIndex={-1}
      className={cx(rt.popover, d.aiMenu)}
      style={
        place
          ? { left: place.left, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }
          : { left: -9999, top: 0 }
      }
      onKeyDown={onKeyDown}
      data-delegation-ai={onPick ? undefined : task ? task.n : 'all'}
      data-ai-menu=""
    >
      <div className={rt.section}>
        <div id={ids.title} className={d.aiTitle}>
          {title}
          {task && <span className={d.aiOf}> · {task.title}</span>}
        </div>
        {subtitle && <div className={d.aiOf}>{subtitle}</div>}
      </div>
      {!menu ? (
        <div className={cx(rt.section, rt.hint, d.aiWait)} role="status">
          {models.data?.t3 && models.data.t3 !== 'ready'
            ? W.t3[models.data.t3]
            : models.error
              ? W.t3.unreachable
              : W.loading}
        </div>
      ) : (
        <>
          <div className={d.aiModels}>
            <fieldset className={rt.models} aria-label={W.model}>
              {[{ key: '', label: first, provider: '' }, ...menu.models].map((m) => {
                const on = m.key === menu.selected;
                return (
                  <label key={m.key} className={cx(rt.model, on && rt.modelOn)} data-model={m.key}>
                    <input
                      type="radio"
                      className={rt.srOnly}
                      name={`${ids.name}-model`}
                      checked={on}
                      onChange={() => setDraft(withAiModel(options ?? [], draft, m.key))}
                    />
                    <span className={rt.check} aria-hidden="true">
                      {on ? '✓' : ''}
                    </span>
                    <span className={cx(rt.modelName, !m.key && d.aiDefault)}>{m.label}</span>
                    <span className={rt.modelDescription}>{m.provider}</span>
                  </label>
                );
              })}
            </fieldset>
          </div>
          {menu.efforts.length > 0 && (
            <div className={cx(rt.section, rt.effortSection)}>
              <div id={ids.effort} className={rt.label}>
                {W.effort}
              </div>
              <fieldset className={rt.efforts} aria-labelledby={ids.effort}>
                {menu.efforts.map((e) => (
                  <label key={e.value} className={cx(rt.effort, e.on && rt.effortOn)}>
                    <input
                      type="radio"
                      className={rt.srOnly}
                      name={`${ids.name}-effort`}
                      checked={e.on}
                      onChange={() => setDraft({ ...draft, effort: e.value })}
                    />
                    {e.word}
                  </label>
                ))}
              </fieldset>
            </div>
          )}
          {menu.fast !== null && (
            <div className={rt.fastRow} data-fast-row="">
              <span className={rt.fastBolt}>
                <Bolt size={16} />
              </span>
              <div className={rt.fastText}>
                <div className={rt.fastTitle}>{W.fast}</div>
                <div id={ids.fast} className={rt.fastHint}>
                  {W.fastHint}
                </div>
              </div>
              <Toggle
                className={cx(rt.switch, menu.fast && rt.switchOn)}
                checked={menu.fast}
                aria-label={W.fast}
                aria-describedby={ids.fast}
                onCheckedChange={(on) => setDraft({ ...draft, fast: on })}
              />
            </div>
          )}
        </>
      )}
      <div className={cx(rt.footer, d.aiFoot)}>
        <Button variant="secondary" size="sm" onClick={() => onClose(true)}>
          {W.cancel}
        </Button>
        <Button variant="primary" size="sm" disabled={!menu || setAi.isPending} onClick={() => void done()}>
          {W.done}
        </Button>
      </div>
    </div>,
    container ?? document.body,
  );
}
