/**
 * The one layout of a card in a thread on the phone (docs/decisions/chat-threads-cards.md), drawn from the shared head
 * (`cardFrame.ts` in `@whombat/client`) so the web says the same: a status line (a mark, the status word, what kind of
 * card, its time), a plain title, a result in words, one sentence, what always shows (a checklist, a run's bar), the main
 * button and at most two others in a fixed place, then the long part folded under “Show more” (it opens the same card in
 * place) and every technical word under one Details.
 */
import { type CardFrame, type CardMark, cardFrameWords, movedCardWords } from '@whombat/client';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { Platform, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import type { CardHeadModel } from '../data/messages';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ChevronDown, ChevronRight } from './icons';
import { Button } from './primitives';
import { RichText } from './rich';
import { Touchable } from './Touchable';

/** iOS's 44pt, Android's 48dp. */
export const CARD_TARGET = Platform.OS === 'android' ? 48 : 44;

/** A card's head with the time it ends with, in the person's zone. */
export interface CardHead extends CardFrame {
  /** “11:22”, or null. */
  time: string | null;
}

/** The status line's mark, 12pt, by shape so no colour carries the meaning alone; the word beside it says it. */
export function CardMarkGlyph({ mark, size = 12 }: { mark: CardMark; size?: number }) {
  const theme = useTheme();
  const warn = theme.colors.warn;
  const quiet = theme.colors.ink2;
  const s = 12;
  const shape = (() => {
    switch (mark) {
      case 'waiting':
        return <Circle cx={6} cy={6} r={4} fill={warn} />;
      case 'working':
        // An incomplete ring: three quarters of a circle.
        return <Path d="M6 1.75a4.25 4.25 0 1 1-4.25 4.25" stroke={quiet} strokeWidth={1.6} fill="none" />;
      case 'handedOver':
        // The branch arrow: a line that turns off to the upper right.
        return (
          <Path
            d="M3 10.5V7a3 3 0 0 1 3-3h3.5M7.5 2l2 2-2 2"
            stroke={quiet}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        );
      case 'done':
        return (
          <Path
            d="M2.5 6.5l2.5 2.5 4.5-5"
            stroke={quiet}
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        );
      case 'stopped':
        return <Rect x={3} y={3} width={6} height={6} rx={1} fill={quiet} />;
      case 'failed':
        return (
          <>
            <Circle cx={6} cy={6} r={4.25} stroke={warn} strokeWidth={1.6} fill="none" />
            <Path d="M3.2 8.8l5.6-5.6" stroke={warn} strokeWidth={1.6} strokeLinecap="round" />
          </>
        );
      default:
        return <Circle cx={6} cy={6} r={4.25} stroke={theme.colors.mut} strokeWidth={1.4} fill="none" />;
    }
  })();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Svg width={size} height={size} viewBox={`0 0 ${s} ${s}`}>
        {shape}
      </Svg>
    </View>
  );
}

/** The status word's colour: warn's readable text where the person is needed or it didn't finish, else `ink2`. */
function wordColor(theme: ReturnType<typeof useTheme>, mark: CardMark): string {
  return mark === 'waiting' || mark === 'failed' ? theme.colors.warnText : theme.colors.ink2;
}

/** “● Waiting for you · Tasks         11:21”. */
/**
 * A card shown as it was earlier on a message (Whombat card-moves.md): its status says so, and its buttons,
 * Details and quiet actions don't show; the row also takes touches and screen readers away from it, so nothing in it
 * acts on the live card.
 */
export const CardStillContext = createContext(false);

export function CardStatusLine({ head }: { head: CardHead }) {
  const { rawLocale } = useI18n();
  const movedCardWordsHere = movedCardWords(rawLocale);
  const theme = useTheme();
  if (useContext(CardStillContext))
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text size={12.5} weight={500} color={theme.colors.ink2} style={{ flexShrink: 1 }}>
          {movedCardWordsHere.earlierWord}
          <Text size={12.5} color={theme.colors.mut}>{` · ${head.kind}`}</Text>
        </Text>
        {head.time ? (
          <Text size={11.5} mono color={theme.colors.mut} style={{ marginLeft: 'auto' }}>
            {head.time}
          </Text>
        ) : null}
      </View>
    );
  return (
    <View
      accessible
      accessibilityLabel={[`${head.word} · ${head.kind}`, head.time].filter(Boolean).join(', ')}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
    >
      <CardMarkGlyph mark={head.mark} />
      <Text size={12.5} weight={500} color={wordColor(theme, head.mark)} style={{ flexShrink: 1 }}>
        {head.word}
        <Text size={12.5} color={theme.colors.mut}>{` · ${head.kind}`}</Text>
      </Text>
      {head.time ? (
        <Text size={11.5} mono color={theme.colors.mut} style={{ marginLeft: 'auto' }}>
          {head.time}
        </Text>
      ) : null}
    </View>
  );
}

/** One of a card's buttons. */
export interface CardButton {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

/**
 * The card's buttons in their fixed place: the main one filled and widest, at most two others outlined beside it; they
 * wrap under it when the text is large. `main` may be a node of its own (Hand over with its AI arrow).
 */
export function CardButtons({
  main,
  others = [],
}: {
  main: CardButton | ReactNode | null;
  others?: readonly CardButton[];
}) {
  const rest = others.slice(0, 2);
  if (!main && !rest.length) return null;
  const isButton = (b: unknown): b is CardButton =>
    typeof b === 'object' && b !== null && 'label' in b && 'onPress' in b;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {isButton(main) ? (
        <Button
          label={main.label}
          variant="primary"
          busy={main.busy}
          disabled={main.disabled}
          onPress={main.onPress}
          accessibilityLabel={main.accessibilityLabel}
          accessibilityHint={main.accessibilityHint}
          style={{ flexGrow: 2, flexBasis: 140, minHeight: CARD_TARGET }}
        />
      ) : (
        main
      )}
      {rest.map((b) => (
        <Button
          key={b.label}
          label={b.label}
          variant="secondary"
          busy={b.busy}
          disabled={b.disabled}
          onPress={b.onPress}
          accessibilityLabel={b.accessibilityLabel}
          accessibilityHint={b.accessibilityHint}
          style={{ flexGrow: 1, flexBasis: 110, minHeight: CARD_TARGET }}
        />
      ))}
    </View>
  );
}

/** A row that opens what is under it in place: “› Show more”, “› Details”. */
export function CardDisclosure({
  label,
  open,
  onPress,
  spoken,
}: {
  label: string;
  open: boolean;
  onPress: () => void;
  /** What a screen reader hears, when the label alone doesn't say whose. */
  spoken?: string;
}) {
  const theme = useTheme();
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={theme.radii.button}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityLabel={spoken ?? label}
      style={{
        alignSelf: 'flex-start',
        minHeight: CARD_TARGET,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginHorizontal: -8,
        paddingHorizontal: 8,
        borderRadius: theme.radii.button,
      }}
    >
      <Chevron size={15} color={theme.colors.ink2} strokeWidth={2} />
      <Text size={13.5} weight={500} color={theme.colors.ink2}>
        {label}
      </Text>
    </Touchable>
  );
}

/** A short heading inside a card's Details (“The answers”, “The plan”). */
export function CardSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Text size={14} weight={600} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

/** Words that may hold markdown: rendered, never with raw `**`. */
export function CardRich({
  text,
  size = 14,
  color,
  selectable = false,
}: {
  text: string;
  size?: number;
  color?: string;
  selectable?: boolean;
}) {
  const theme = useTheme();
  return (
    <RichText
      text={text}
      color={color ?? theme.colors.ink2}
      accentColor={theme.colors.brand}
      codeBackground={theme.colors.sf2}
      size={size}
      lh={1.45}
      selectable={selectable}
    />
  );
}

export function CardFrameView({
  head,
  callout = null,
  children,
  buttons: ownButtons,
  fold,
  details: ownDetailsPart,
  detailsOpen,
  detailsToggle = true,
  onDetailsOpen,
  footer: ownFooter,
  corner: ownCorner = null,
  loud = false,
  underTitle = null,
  endAction: ownEndAction = null,
}: {
  head: CardHead;
  /** Right under the title (a council's five steps). */
  underTitle?: ReactNode;
  /**
   * A quiet action at the bottom right, level with Details (a live card's Stop): rare, so never the first thing to tap.
   */
  endAction?: ReactNode;
  /** Beside the status line, at its end (a card opened from its line: “Hide card”). */
  corner?: ReactNode;
  /** The step a plan names (“Current step” · its title), shown where the card is open. */
  callout?: { label: string; text: string } | null;
  /** What always shows under the sentence (a checklist, a run's bar, the tasks at work). */
  children?: ReactNode;
  /** The buttons in their fixed place (`CardButtons`). */
  buttons?: ReactNode;
  /** The long part: folded under “Show more” (Details folds with it). */
  fold?: ReactNode;
  /** Every technical word, under one Details. */
  details?: ReactNode;
  /** Details' state when the card's main button opens it (“Read the answers”); else its own. */
  detailsOpen?: boolean;
  /** False: the main button is Details' only way open and shut (a finished council's “Read the answers”). */
  detailsToggle?: boolean;
  onDetailsOpen?: (open: boolean) => void;
  /** A quiet line under the buttons. */
  footer?: ReactNode;
  /** It waits for the person: a stronger frame. */
  loud?: boolean;
}) {
  const { rawLocale } = useI18n();
  const cardFrameWordsHere = cardFrameWords(rawLocale);
  const theme = useTheme();
  // The card as it was earlier: what it said, without anything to press.
  const still = useContext(CardStillContext);
  const buttons = still ? null : ownButtons;
  const details = still ? null : ownDetailsPart;
  const footer = still ? null : ownFooter;
  const endAction = still ? null : ownEndAction;
  const corner = still ? null : ownCorner;
  const [unfolded, setUnfolded] = useState(false);
  const [ownDetails, setOwnDetails] = useState(false);
  const showDetails = detailsOpen ?? ownDetails;
  const toggleDetails = () => {
    const next = !showDetails;
    if (onDetailsOpen) onDetailsOpen(next);
    else setOwnDetails(next);
  };
  const disclosure =
    details && detailsToggle ? (
      <CardDisclosure label={cardFrameWordsHere.details} open={showDetails} onPress={toggleDetails} />
    ) : null;
  const detailsPart =
    details || endAction ? (
      <View style={{ gap: 8 }}>
        {endAction ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}>{disclosure}</View>
            {endAction}
          </View>
        ) : (
          disclosure
        )}
        {details && showDetails ? <View style={{ gap: 12 }}>{details}</View> : null}
      </View>
    ) : null;
  const foldable = fold !== undefined && fold !== null && fold !== false;
  return (
    <View
      style={{
        alignSelf: 'stretch',
        gap: 10,
        borderRadius: theme.radii.card,
        borderWidth: loud && !still ? 1.5 : 1,
        borderStyle: still ? 'dashed' : 'solid',
        borderColor: loud && !still ? theme.colors.warn : theme.colors.line,
        backgroundColor: still ? 'transparent' : theme.colors.sf,
        paddingVertical: 14,
        paddingHorizontal: 16,
      }}
    >
      <View style={{ gap: 6 }}>
        {corner ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <CardStatusLine head={head} />
            </View>
            {corner}
          </View>
        ) : (
          <CardStatusLine head={head} />
        )}
        <Text size={18} weight={600} lh={1.3} tracking={-0.01} accessibilityRole="header">
          {head.title}
        </Text>
        {head.changed ? (
          <Text size={13.5} lh={1.4} color={theme.colors.ink2}>
            {head.changed}
          </Text>
        ) : null}
        {underTitle}
        {head.headline ? (
          <Text size={16} weight={600} lh={1.35}>
            {head.headline}
          </Text>
        ) : null}
        {head.sentence ? <CardRich text={head.sentence} size={14.5} /> : null}
      </View>
      {children}
      {buttons}
      {footer}
      {foldable && still ? (
        <View style={{ gap: 12 }}>{fold}</View>
      ) : foldable ? (
        <View style={{ gap: 10 }}>
          <CardDisclosure
            label={unfolded ? cardFrameWordsHere.showLess : cardFrameWordsHere.showMore}
            open={unfolded}
            onPress={() => setUnfolded((o) => !o)}
            spoken={`${unfolded ? cardFrameWordsHere.showLess : cardFrameWordsHere.showMore}: ${head.title}`}
          />
          {unfolded ? (
            <View style={{ gap: 12, borderTopWidth: 1, borderTopColor: theme.colors.line, paddingTop: 12 }}>
              {callout ? <CardCallout {...callout} /> : null}
              {fold}
              {detailsPart}
            </View>
          ) : null}
        </View>
      ) : (
        <>
          {callout ? <CardCallout {...callout} /> : null}
          {detailsPart}
        </>
      )}
    </View>
  );
}

/** “Current step / Build the invoice export” on `sf2`. */
function CardCallout({ label, text }: { label: string; text: string }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${label}: ${text}`}
      style={{ gap: 3, borderRadius: theme.radii.button, backgroundColor: theme.colors.sf2, padding: 12 }}
    >
      <Text size={12} weight={600} color={theme.colors.ink2}>
        {label}
      </Text>
      <Text size={14.5}>{text}</Text>
    </View>
  );
}

/** A link or a button the screen gives a plan or run card (“Open plan”, “Watch run”, “Try again”). */
export interface SummaryAction {
  label: string;
  onPress: () => void;
  busy?: boolean;
  accessibilityHint?: string;
}

/**
 * A plan or a run card (`CardSummary.head`): its first link is the main button, Try again and the next links beside it
 * (two at most), the rest under Details with the facts; a plan's steps fold under Show more with its step called out.
 */
export function SummaryFrame({
  head,
  links,
  buttons,
  busy = false,
  bar = null,
  meta = null,
  corner = null,
}: {
  head: CardHeadModel;
  links: readonly SummaryAction[];
  buttons: readonly SummaryAction[];
  busy?: boolean;
  /** A live run's bar, which always shows. */
  bar?: ReactNode;
  /** A run's changes and pull request, under Details. */
  meta?: ReactNode;
  corner?: ReactNode;
}) {
  const theme = useTheme();
  const [first, ...more] = links;
  const ordered = [...buttons, ...more];
  const toButton = (a: SummaryAction): CardButton => ({
    label: a.label,
    onPress: a.onPress,
    busy: a.busy,
    disabled: busy,
    accessibilityLabel: `${a.label}: ${head.title}`,
    accessibilityHint: a.accessibilityHint,
  });
  const main = first ? toButton(first) : ordered[0] ? toButton(ordered[0]) : null;
  const others = (first ? ordered : ordered.slice(1)).map(toButton);
  const extra = others.slice(2);
  const details =
    head.facts.length || meta || extra.length ? (
      <>
        {head.facts.map((f) => (
          <Text key={f} size={12.5} mono color={theme.colors.mut}>
            {f}
          </Text>
        ))}
        {meta}
        {extra.map((b) => (
          <Button
            key={b.label}
            label={b.label}
            variant="secondary"
            onPress={b.onPress}
            disabled={b.disabled}
            accessibilityLabel={b.accessibilityLabel}
            style={{ alignSelf: 'flex-start', minHeight: CARD_TARGET }}
          />
        ))}
      </>
    ) : undefined;
  const steps = head.steps.length ? (
    <View>
      {head.steps.map((s, i) => (
        <View
          key={s.id}
          accessible
          accessibilityLabel={[s.title, s.state, s.note].filter(Boolean).join(', ')}
          style={{
            flexDirection: 'row',
            gap: 12,
            paddingVertical: 10,
            borderTopWidth: i ? 1 : 0,
            borderTopColor: theme.colors.line,
          }}
        >
          <View style={{ paddingTop: 4 }}>
            <CardMarkGlyph mark={s.mark} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text size={14.5} weight={600}>
              {s.title}
            </Text>
            <Text
              size={13.5}
              color={s.mark === 'waiting' || s.mark === 'failed' ? theme.colors.warnText : theme.colors.ink2}
            >
              {s.state}
            </Text>
            {s.note ? <CardRich text={s.note} size={13.5} /> : null}
          </View>
        </View>
      ))}
    </View>
  ) : null;
  return (
    <CardFrameView
      head={head}
      callout={head.callout}
      corner={corner}
      loud={head.mark === 'waiting'}
      buttons={<CardButtons main={main} others={others.slice(0, 2)} />}
      fold={steps}
      details={details}
    >
      {bar}
    </CardFrameView>
  );
}
