import { type GuideActInput, vaultAskOf } from '@whombat/client';
import { useTheAgent } from '@whombat/client/react';
import {
  type GuideActionsBlock,
  type GuideBlock,
  type GuideCard as GuideCardData,
  type GuideChoicesBlock,
  type GuideCopyBlock,
  type GuideFormBlock,
  type GuideLinksBlock,
  type GuideStatusBlock,
  type GuideStatusState,
  guideCardLabel,
} from '@whombat/core/domain';
import { Clock } from 'lucide-react';
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { copyText } from '../../components/CopyButton';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { type DotTone, StatusDot } from '../../components/StatusDot';
import { useToast } from '../../components/Toast';
import styles from './Card.module.css';
import guide from './GuideCard.module.css';
import { GuideConnect } from './GuideConnect';
import { GuideForm, type GuideFormProblem } from './GuideForm';
import { GuideIconView } from './guideIcons';
import { CardAction, CardLink, type NavigateHandler, TONE_CLASS } from './parts';
import { useConnectCardOAuth } from './useConnectCardOAuth';
import { VaultAskForm } from './VaultAskForm';

export interface GuideCardProps {
  burrow: string;
  card: GuideCardData;
  /** Acts on the card (`guides.act`); resolves true when the server took it. Absent: nothing is clickable. */
  onAct?: (input: GuideActInput) => Promise<boolean>;
  /** An act is on its way: buttons wait. */
  busy?: boolean;
  /** The last form submit's `invalid_values` (the server's words, per field id). */
  formProblem?: GuideFormProblem | null;
  onNavigate?: NavigateHandler;
  /** Where an OAuth sign-in navigates (tests); a full-page navigation by default. */
  navigate?: (url: string) => void;
}

/** “You chose Google” for a choice, the server's words (“Client ID 1234567890ab… saved”) for anything else. */
export function guideAnswerText(card: Pick<GuideCardData, 'state' | 'answer'>): string | null {
  if (card.answer) return card.answer.optionIds ? `You chose ${card.answer.label}` : card.answer.label;
  if (card.state === 'expired') return 'This expired. Ask me any time.';
  return null;
}

/** Short paragraphs separated by a blank line (plain text, never Markdown). */
function paragraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * A step of a guide in the personal assistant's DM (docs/decisions/assistant-guides.md AG-02, AG-17): the plan /
 * approval card's shell (1.5px line, label row `SET UP · EMAIL · STEP 2 OF 6`), the title, the body and its blocks —
 * choice tiles, buttons, values to copy, links, a secure form, Connect Google and status rows. A locked card
 * (`done`, `expired`) dims its choices, drops what acts and ends with a quiet answer row.
 */
export function GuideCard({
  burrow,
  card,
  onAct: act,
  busy = false,
  formProblem,
  onNavigate,
  navigate,
}: GuideCardProps) {
  const open = card.state === 'open' && !!act;
  const answer = guideAnswerText(card);
  const titleId = useId();
  const section = useRef<HTMLElement>(null);
  const answerRow = useRef<HTMLParagraphElement>(null);
  // Acting takes away the button (or tile) that had the focus: it goes to the answer row, and back to the card if a
  // refusal reopens it, so a keyboard or screen reader stays here instead of starting over at the top of the page.
  const acted = useRef(false);
  const wasOpen = useRef(open);
  useLayoutEffect(() => {
    if (wasOpen.current === open) return;
    wasOpen.current = open;
    if (!acted.current) return;
    const focused = document.activeElement;
    const lost = !focused || focused === document.body || !!section.current?.contains(focused);
    if (!lost) return;
    if (open) section.current?.focus();
    else (answerRow.current ?? section.current)?.focus();
  }, [open]);
  const onAct = act
    ? (input: GuideActInput) => {
        acted.current = true;
        return act(input);
      }
    : undefined;
  return (
    <section
      ref={section}
      tabIndex={-1}
      className={cx(styles.card, guide.card)}
      aria-labelledby={titleId}
      data-card="guide"
      data-state={card.state}
      data-guide={card.guide}
    >
      <div className={styles.header}>
        <span className={styles.label}>{guideCardLabel(card)}</span>
      </div>
      <h3 className={cx(styles.title, guide.title)} id={titleId}>
        {card.title}
      </h3>
      {card.body ? (
        <div className={guide.body}>
          {paragraphs(card.body).map((p) => (
            <p key={p}>{p}</p>
          ))}
        </div>
      ) : null}
      {card.blocks.map((block, i) => (
        <GuideBlockView
          // biome-ignore lint/suspicious/noArrayIndexKey: a card's blocks never reorder
          key={`${block.type}-${i}`}
          burrow={burrow}
          card={card}
          block={block}
          open={open}
          busy={busy}
          onAct={onAct}
          formProblem={formProblem ?? null}
          onNavigate={onNavigate}
          navigate={navigate}
        />
      ))}
      {answer ? (
        <p ref={answerRow} tabIndex={-1} className={guide.answer} data-answer={card.state}>
          {card.state === 'done' ? (
            <Icon name="can" size={14} className={guide.answerCheck} />
          ) : (
            <Icon icon={Clock} size={14} />
          )}
          <span>{answer}</span>
        </p>
      ) : null}
    </section>
  );
}

interface BlockProps {
  burrow: string;
  card: GuideCardData;
  open: boolean;
  busy: boolean;
  onAct: GuideCardProps['onAct'];
  formProblem: GuideFormProblem | null;
  onNavigate: NavigateHandler | undefined;
  navigate: ((url: string) => void) | undefined;
}

function GuideBlockView({ block, ...props }: BlockProps & { block: GuideBlock }) {
  switch (block.type) {
    case 'choices':
      return <ChoicesBlock block={block} {...props} />;
    case 'actions':
      return <ActionsBlock block={block} {...props} />;
    case 'copy':
      return <CopyBlock block={block} />;
    case 'links':
      return <LinksBlock block={block} />;
    case 'form':
      // Kept (hidden) while the optimistic lock waits for the server, so a refusal brings the typed values back.
      return props.open || props.busy ? (
        <div hidden={!props.open} className={guide.formWrap}>
          <FormView block={block} {...props} />
        </div>
      ) : null;
    case 'connect':
      return props.open ? <GuideConnect burrow={props.burrow} block={block} /> : null;
    case 'status':
      return <StatusBlock block={block} onNavigate={props.onNavigate} />;
    default:
      return null;
  }
}

/** A sign-in card's form (`vault_ask`) or any other guide's. */
function FormView({ block, burrow, card, busy, formProblem, onAct }: BlockProps & { block: GuideFormBlock }) {
  const ask = vaultAskOf(card);
  const assistant = useTheAgent(burrow).words.name;
  const onSubmit = (values: Record<string, string>) => submitForm(block, values, onAct);
  return ask ? (
    <VaultAskForm
      ask={ask}
      block={block}
      assistant={assistant}
      busy={busy}
      problem={formProblem}
      onSubmit={onSubmit}
    />
  ) : (
    <GuideForm block={block} busy={busy} problem={formProblem} onSubmit={onSubmit} />
  );
}

function submitForm(
  block: GuideFormBlock,
  values: Record<string, string>,
  onAct: GuideCardProps['onAct'],
): Promise<boolean> {
  return onAct ? onAct({ actionId: block.id, values }) : Promise.resolve(false);
}

/* Choices ---------------------------------------------------------------------------------------------------- */

function ChoicesBlock({ block, card, open, busy, onAct }: BlockProps & { block: GuideChoicesBlock }) {
  const [ticked, setTicked] = useState<string[]>([]);
  const answered = card.answer?.actionId === block.id ? (card.answer.optionIds ?? []) : [];
  const multi = block.mode === 'multi';
  const badgeIds = useId();

  if (!open) {
    return (
      <ul className={cx(styles.bare, guide.choices)} aria-label="Choices">
        {block.options.map((o) => {
          const chosen = answered.includes(o.id);
          return (
            <li key={o.id} className={guide.option} data-locked data-selected={chosen || undefined}>
              <OptionFace option={o} selected={chosen} />
              {chosen ? <span className={styles.srOnly}> (your choice)</span> : null}
            </li>
          );
        })}
      </ul>
    );
  }

  const act = (optionIds: string[]) => void onAct?.({ actionId: block.id, optionIds });
  return (
    <div className={guide.choicesBlock}>
      {/* biome-ignore lint/a11y/useSemanticElements: a group of buttons, not a fieldset of inputs */}
      <div className={guide.choices} role="group" aria-label={card.title}>
        {block.options.map((o) => {
          const selected = multi && ticked.includes(o.id);
          const badgeId = o.badge ? `${badgeIds}-${o.id}` : undefined;
          return (
            <button
              key={o.id}
              type="button"
              className={guide.option}
              disabled={o.disabled || busy}
              data-unavailable={o.disabled || undefined}
              data-selected={selected || undefined}
              aria-pressed={multi ? selected : undefined}
              aria-describedby={badgeId}
              onClick={() => {
                if (!multi) return act([o.id]);
                setTicked((t) =>
                  t.includes(o.id)
                    ? t.filter((id) => id !== o.id)
                    : block.options.filter((x) => x.id === o.id || t.includes(x.id)).map((x) => x.id),
                );
              }}
            >
              <OptionFace option={o} selected={selected} badgeId={badgeId} />
            </button>
          );
        })}
      </div>
      {multi ? (
        <div className={guide.actions}>
          <Button
            variant="primary"
            size="lg"
            disabled={busy || ticked.length === 0}
            onClick={() => act(ticked)}
          >
            {block.submitLabel ?? 'Continue'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function OptionFace({
  option,
  selected,
  badgeId,
}: {
  option: GuideChoicesBlock['options'][number];
  selected: boolean;
  badgeId?: string;
}) {
  return (
    <>
      {option.icon ? (
        <span className={guide.optionIcon}>
          <GuideIconView icon={option.icon} />
        </span>
      ) : null}
      <span className={guide.optionText}>
        <span className={guide.optionTitle}>
          {option.title}
          {option.badge ? (
            <span id={badgeId} className={cx(guide.badge, TONE_CLASS[option.badge.tone])}>
              {option.badge.label}
            </span>
          ) : null}
        </span>
        {option.description ? <span className={guide.optionDescription}>{option.description}</span> : null}
      </span>
      {selected ? (
        <span className={guide.check} aria-hidden="true">
          <Icon name="can" size={12} />
        </span>
      ) : null}
    </>
  );
}

/* Actions ---------------------------------------------------------------------------------------------------- */

const BUTTON_VARIANT = { primary: 'primary', secondary: 'secondary', quiet: 'ghost' } as const;

function ActionsBlock({
  burrow,
  card,
  block,
  open,
  busy,
  onAct,
  onNavigate,
  navigate,
}: BlockProps & { block: GuideActionsBlock }) {
  const oauth = useConnectCardOAuth(burrow, open ? card.connectOAuth : undefined, navigate);
  // Answered or expired connect cards hide their sign-in/connect links so completed cards stay clean.
  const hideLinks = card.guide === 'add_connection' && (card.answer !== null || card.state === 'expired');
  // A locked card keeps only the links (a settings tab, a help page): nothing else acts any more.
  const shown = open ? block.actions : hideLinks ? [] : block.actions.filter((a) => a.href);
  if (shown.length === 0) return null;
  const fallbackHref = shown.find((a) => (a.id === 'connect' || a.id === 'allow') && a.href)?.href ?? null;
  return (
    <>
      <div className={guide.actions}>
        {shown.map((a) => {
          if (open && card.connectOAuth && (a.id === 'connect' || a.id === 'allow')) {
            return (
              <Button
                key={a.id}
                variant={BUTTON_VARIANT[a.style]}
                size="lg"
                disabled={busy || oauth.busy}
                onClick={() => void oauth.start()}
              >
                {a.label}
              </Button>
            );
          }
          return a.href ? (
            <CardAction
              key={a.id}
              href={a.href}
              onNavigate={onNavigate}
              variant={a.style === 'primary' ? 'primary' : 'secondary'}
              className={cx(guide.linkAction, a.style === 'quiet' && guide.quietLink)}
            >
              {a.label}
            </CardAction>
          ) : (
            <Button
              key={a.id}
              variant={BUTTON_VARIANT[a.style]}
              size="lg"
              disabled={busy || oauth.busy}
              onClick={() => void onAct?.({ actionId: a.id })}
            >
              {a.label}
            </Button>
          );
        })}
      </div>
      {oauth.problem ? (
        <p className={guide.problem} role="alert">
          {oauth.problem}
          {fallbackHref ? (
            <>
              {' '}
              <CardLink href={fallbackHref} onNavigate={onNavigate}>
                Open Settings instead
              </CardLink>
            </>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

/* Copy, links, status ---------------------------------------------------------------------------------------- */

function CopyBlock({ block }: { block: GuideCopyBlock }) {
  const toast = useToast();
  return (
    <dl className={guide.rows}>
      {block.rows.map((row) => (
        <div key={row.label} className={guide.copyRow}>
          <div className={guide.copyMain}>
            <dt className={guide.copyLabel}>{row.label}</dt>
            <dd className={guide.copyValue}>{row.value}</dd>
          </div>
          <Button
            variant="secondary"
            size="sm"
            aria-label={`Copy ${row.label}`}
            onClick={() =>
              void copyText(row.value).then((ok) =>
                toast.show(ok ? `${row.label} copied.` : 'Couldn’t copy. Your browser didn’t allow it.'),
              )
            }
          >
            Copy
          </Button>
        </div>
      ))}
    </dl>
  );
}

function LinksBlock({ block }: { block: GuideLinksBlock }) {
  return (
    <ul className={cx(styles.bare, guide.links)}>
      {block.links.map((link) => (
        <li key={link.url}>
          <a className={guide.link} href={link.url} target="_blank" rel="noopener noreferrer">
            {link.label}
            <Icon name="external" size={14} />
            <span className={styles.srOnly}> (opens in a new tab)</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

const STATUS_TONE: Record<GuideStatusState, DotTone> = { ok: 'ok', warn: 'warn', bad: 'bad', mut: 'mut' };
const STATUS_WORD: Record<GuideStatusState, string> = {
  ok: 'Working',
  warn: 'Needs attention',
  bad: 'Not working',
  mut: 'Not checked',
};

function StatusBlock({
  block,
  onNavigate,
}: {
  block: GuideStatusBlock;
  onNavigate: NavigateHandler | undefined;
}) {
  return (
    <ul className={cx(styles.bare, guide.rows)}>
      {block.rows.map((row) => {
        // The row's own words are the link (“API turned off · Turn it on”): the server writes them.
        const linked = (text: string): ReactNode =>
          row.href ? (
            <CardLink href={row.href} onNavigate={onNavigate} className={guide.statusLink}>
              {text}
            </CardLink>
          ) : (
            text
          );
        return (
          <li key={row.label} className={guide.statusRow} data-state={row.state}>
            <span className={guide.statusDot}>
              <StatusDot tone={STATUS_TONE[row.state]} size={8} label={STATUS_WORD[row.state]} />
            </span>
            <span className={guide.statusText}>
              <span className={guide.statusLabel}>{row.detail ? row.label : linked(row.label)}</span>
              {row.detail ? <span className={guide.statusDetail}>{linked(row.detail)}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
