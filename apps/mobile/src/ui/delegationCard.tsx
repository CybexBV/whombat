/**
 * The delegation card on the phone (Whombat docs/decisions/delegate.md), drawn from the shared view so the web says the
 * same, in the council card's look. While it waits for the person: the checklist — each task with its checkbox, its
 * number, title, why, when it starts after another and, on a Whombat that has it, the chip with the AI it runs with —
 * then Hand over N with its arrow for every task's AI, what the others get, Change something and Not now. Once handed
 * over: a row per task that works, waits or needs a look — its number in a round slot where the council's
 * working ring turns while it works, its state (warn when it needs a look), what it does now and the AI on it, how long
 * it worked, the agent's line about it, its pull request, its pictures and a ⋯ with Open in T3 Code and Stop
 * this task — then the tasks that finished well folded into one line (“4 merged”) that opens to the same rows. While
 * its tasks work they show on the card itself; Stop for all of it is a quiet word at the bottom right and in the card's
 * ⋯, never a button above the work; it still asks first.
 */
import {
  cardFrameWords,
  type DelegationCardView,
  type DelegationItemView,
  type DelegationTaskView,
  delegationAiWords,
  delegationFrame,
  delegationWords,
} from '@whombat/client';
import { type DelegationCard, formatClock } from '@whombat/core';
import { useContext, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { CardPicture } from '../data/cardPictures';
import { delegationTaskMenu, parseDelegationTaskPick } from '../data/delegation';
import type { FileAccess } from '../data/fileAccess';
import type { MessageFileActions } from '../data/useFiles';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import {
  CARD_TARGET,
  type CardButton,
  CardButtons,
  CardFrameView,
  type CardHead,
  CardRich,
  CardSection,
  CardStillContext,
} from './cardFrame';
import { CardPictures } from './cardPictures';
import { CardCornerMenu, CardStopButton } from './cardStop';
import { WorkingRing } from './councilCard';
import { Check, ChevronDown, ChevronUp, Ellipsis } from './icons';
import { hasNativeMenu, MenuSheet, NativeMenu } from './nativeMenu';
import { Button } from './primitives';
import { Touchable } from './Touchable';
import { hitSlopFor } from './touchTarget';

/** The number's round slot, as the council's mark slot; the checkbox sits in the same column. */
const SLOT = 24;
const COLUMN = 32;
const BOX = 22;
/** Where a row's words start, past its slot and the gap: its note and links line up under its title. */
const INDENT = COLUMN + 10;

export interface DelegationCardActions {
  pick: (taskId: string, picked: boolean) => void;
  handOver: () => void;
  /** The cursor in this thread's reply box. */
  change: () => void;
  /** The AI menu for one task, or for every task at once (null: Hand over's arrow). */
  chooseAi: (taskId: string | null) => void;
  /** The checklist's Not now: it stops the delegation without asking. */
  notNow: () => void;
  /** Stop every task (the screen asks first). */
  stop: () => void;
  /** Stop one task (the screen asks first). */
  stopTask: (task: DelegationTaskView) => void;
  openUrl: (url: string) => void;
  /** Hand over or Stop is on its way. */
  busy: 'start' | 'stop' | null;
  /** The tasks whose Stop is on its way. */
  stopping: ReadonlySet<string>;
}

/** A task on the checklist: the whole row ticks it; its AI is chosen under the card's Details. */
function PickRow({
  task,
  after,
  disabled,
  onPick,
}: {
  task: DelegationTaskView;
  after: string | null;
  disabled: boolean;
  onPick: (taskId: string, picked: boolean) => void;
}) {
  const { rawLocale } = useI18n();
  const delegationWordsHere = delegationWords(rawLocale);
  const theme = useTheme();
  const on = task.picked;
  return (
    <Touchable
      onPress={() => onPick(task.id, !on)}
      disabled={disabled}
      feedback="wash"
      ringRadius={theme.radii.button}
      accessibilityRole="checkbox"
      accessibilityLabel={[delegationWordsHere.tick(task.title), task.why, after].filter(Boolean).join(', ')}
      accessibilityState={{ checked: on, disabled }}
      style={{
        minHeight: CARD_TARGET,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        paddingVertical: 6,
        marginHorizontal: -8,
        paddingHorizontal: 8,
        borderRadius: theme.radii.button,
      }}
    >
      <View style={{ width: COLUMN, alignItems: 'center' }}>
        <View
          style={{
            width: BOX,
            height: BOX,
            borderRadius: 6,
            borderWidth: 1.5,
            borderColor: on ? theme.colors.btn : theme.colors.line2,
            backgroundColor: on ? theme.colors.btn : 'transparent',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {on ? <Check size={15} color={theme.colors.btnfg} strokeWidth={2.5} /> : null}
        </View>
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text size={14.5} weight={600} lh={1.35}>
          <Text size={13} mono color={theme.colors.mut}>
            {`${task.n}  `}
          </Text>
          {task.title}
        </Text>
        {task.why ? <CardRich text={task.why} size={12.5} color={theme.colors.mut} /> : null}
      </View>
      {after ? (
        <Text size={12} mono color={theme.colors.mut} style={{ paddingTop: 2 }}>
          {after}
        </Text>
      ) : null}
    </Touchable>
  );
}

/** A task's AI: “Default” faintly in a hairline while it has none of its own, its AI line filled once chosen. */
function AiChip({
  task,
  disabled,
  onPress,
}: {
  task: DelegationTaskView;
  disabled: boolean;
  onPress: () => void;
}) {
  const { rawLocale } = useI18n();
  const delegationAiWordsHere = delegationAiWords(rawLocale);
  const theme = useTheme();
  const chosen = task.ai !== null;
  return (
    <Touchable
      onPress={onPress}
      disabled={disabled}
      feedback="wash"
      ringRadius={12}
      accessibilityRole="button"
      accessibilityLabel={delegationAiWordsHere.openTask(task.title, task.ai)}
      hitSlop={hitSlopFor(24)}
      style={{
        minHeight: 24,
        justifyContent: 'center',
        paddingHorizontal: 9,
        paddingVertical: 3,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: chosen ? 'transparent' : theme.colors.line,
        backgroundColor: chosen ? theme.colors.sf2 : 'transparent',
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <Text
        size={12}
        weight={chosen ? 500 : 400}
        lh={1.3}
        color={chosen ? theme.colors.ink2 : theme.colors.mut}
        numberOfLines={2}
        style={{ textAlign: 'right' }}
      >
        {task.ai ?? delegationAiWordsHere.chipDefault}
      </Text>
    </Touchable>
  );
}

/**
 * Hand over N as a split button when the AI can be chosen: the arrow beside it opens the AI menu for every task. The
 * arrow is off with Hand over (nothing ticked, or a press on its way).
 */
function HandOver({ view, actions }: { view: DelegationCardView; actions: DelegationCardActions }) {
  const { rawLocale } = useI18n();
  const delegationAiWordsHere = delegationAiWords(rawLocale);
  const theme = useTheme();
  // A council looking at the list holds it until it answers.
  const off = view.picked === 0 || actions.busy !== null || view.held;
  const button = (
    <Button
      label={view.handOver}
      variant="primary"
      busy={actions.busy === 'start'}
      disabled={off}
      onPress={actions.handOver}
      style={
        view.aiChoosable
          ? { flexGrow: 1, borderTopRightRadius: 0, borderBottomRightRadius: 0 }
          : { flexGrow: 1 }
      }
    />
  );
  if (!view.aiChoosable) return button;
  return (
    <View style={{ flexGrow: 1, flexDirection: 'row', gap: 1 }}>
      {button}
      <Touchable
        onPress={() => actions.chooseAi(null)}
        disabled={off}
        feedback="fade"
        ringRadius={12}
        accessibilityRole="button"
        accessibilityLabel={delegationAiWordsHere.openAll(view.ai)}
        style={{
          width: 44,
          minHeight: 44,
          alignItems: 'center',
          justifyContent: 'center',
          borderTopRightRadius: 12,
          borderBottomRightRadius: 12,
          backgroundColor: theme.colors.btn,
          opacity: off ? 0.45 : 1,
        }}
      >
        <ChevronDown size={18} color={theme.colors.btnfg} strokeWidth={2.25} />
      </Touchable>
    </View>
  );
}

/** The task's number in its round slot, a check once it is done. */
function TaskSlot({ task }: { task: DelegationTaskView }) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: SLOT,
        height: SLOT,
        borderRadius: SLOT / 2,
        backgroundColor: theme.colors.sf2,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {task.done ? (
        <Check size={14} color={theme.colors.ok} strokeWidth={2.5} />
      ) : (
        <Text size={12} weight={700} color={task.attention ? theme.colors.warnText : theme.colors.ink2}>
          {task.slot}
        </Text>
      )}
    </View>
  );
}

/** What a handed-over task's row needs besides the task: the card's presses, its pictures, the image viewer's access. */
interface RowEnv {
  actions: DelegationCardActions;
  pictures: Readonly<Record<string, CardPicture[]>>;
  access: FileAccess | null;
  files: MessageFileActions | null;
  /** Its ⋯ where iOS's own menu isn't: the card's sheet. */
  more: (task: DelegationTaskView) => void;
}

/** A handed-over task: what it does and how it went, then its pull request, its pictures and its ⋯. */
function TaskRow({ task, env }: { task: DelegationTaskView; env: RowEnv }) {
  const { rawLocale } = useI18n();
  const delegationWordsHere = delegationWords(rawLocale);
  const theme = useTheme();
  // A copy of the card as it was (card-moves.md) shows no clocks: they would count on from long ago.
  const elapsed = useContext(CardStillContext) ? null : task.elapsed;
  const { actions } = env;
  const [shown, setShown] = useState(false);
  const second = [task.detail, task.program].filter(Boolean).join(' · ');
  // What needs a look is warn; a question the assistant answers itself is as quiet as work.
  const tone = task.attention
    ? theme.colors.warnText
    : task.done
      ? theme.colors.ok
      : task.working
        ? theme.colors.ink2
        : theme.colors.ink;
  const stopping = actions.stopping.has(task.id);
  const menu = delegationTaskMenu(task, stopping || actions.busy !== null, rawLocale);
  const pictures = task.shots.length ? (env.pictures[task.id] ?? []) : [];
  const links = task.pr || pictures.length || menu;
  return (
    <View style={{ gap: 2 }}>
      <View
        accessible
        accessibilityLabel={[task.label, elapsed, task.program].filter(Boolean).join(', ')}
        style={{
          minHeight: 44,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <WorkingRing working={task.working}>
          <TaskSlot task={task} />
        </WorkingRing>
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Text
            size={14.5}
            weight={600}
            numberOfLines={2}
            color={task.muted ? theme.colors.ink2 : theme.colors.ink}
          >
            {task.title}
          </Text>
          {second ? (
            <Text size={12.5} color={theme.colors.mut} numberOfLines={1}>
              {second}
            </Text>
          ) : null}
        </View>
        <View style={{ alignItems: 'flex-end', gap: 1, maxWidth: '42%' }}>
          <Text size={13} weight={600} color={tone} numberOfLines={2} style={{ textAlign: 'right' }}>
            {task.status}
          </Text>
          {elapsed ? (
            <Text size={11.5} mono color={theme.colors.mut}>
              {elapsed}
            </Text>
          ) : null}
        </View>
      </View>
      {task.note ? (
        <View style={{ marginLeft: INDENT }}>
          <CardRich text={task.note} size={13.5} selectable />
        </View>
      ) : null}
      {task.items ? <Items items={task.items} /> : null}
      {links ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            marginLeft: INDENT - 12,
            marginTop: -4,
          }}
        >
          {task.pr ? (
            <Button
              label={delegationWordsHere.pullRequest}
              variant="quiet"
              accessibilityLabel={`${delegationWordsHere.pullRequest}: ${task.title}`}
              accessibilityHint={task.pr}
              onPress={() => {
                if (task.pr) actions.openUrl(task.pr);
              }}
              style={{ borderWidth: 0 }}
            />
          ) : null}
          {pictures.length ? (
            <QuietToggle
              label={delegationWordsHere.pictures(pictures.length)}
              spoken={`${delegationWordsHere.pictures(pictures.length)}: ${task.title}`}
              open={shown}
              onPress={() => setShown((o) => !o)}
            />
          ) : null}
          {/* The ⋯ at the row's end, under its state, in the same place on every row. */}
          {menu ? (
            <View style={{ marginLeft: 'auto', marginRight: -12 }}>
              <TaskMore task={task} menu={menu} busy={stopping} env={env} />
            </View>
          ) : null}
        </View>
      ) : null}
      {shown && pictures.length ? (
        <View style={{ marginLeft: INDENT, paddingTop: 2, paddingBottom: 10 }}>
          <CardPictures
            pictures={pictures}
            hint={delegationWordsHere.picturesHint}
            access={env.access}
            files={env.files}
          />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The items of one thread doing several tasks, under its row: each one's number, a check once the thread said
 * it finished it, its title and what the thread said about it.
 */
function Items({ items }: { items: readonly DelegationItemView[] }) {
  const theme = useTheme();
  return (
    <View style={{ marginLeft: INDENT, gap: 6, paddingTop: 2, paddingBottom: 4 }}>
      {items.map((i) => (
        <View
          key={i.id}
          accessible
          accessibilityLabel={i.label}
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}
        >
          <View
            style={{
              width: 18,
              height: 18,
              borderRadius: 9,
              marginTop: 1,
              backgroundColor: theme.colors.sf2,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {i.done ? (
              <Check size={12} color={theme.colors.ok} strokeWidth={2.5} />
            ) : (
              <Text size={11} weight={700} color={theme.colors.ink2}>
                {i.n}
              </Text>
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
            <Text size={13.5} lh={1.4} color={i.done ? theme.colors.ink : theme.colors.ink2}>
              {i.title}
            </Text>
            {i.note ? (
              <Text size={12.5} lh={1.4} color={theme.colors.mut}>
                {i.note}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
    </View>
  );
}

/** A quiet button that opens what is under it, with a chevron that says whether it is open. */
function QuietToggle({
  label,
  spoken,
  open,
  onPress,
}: {
  label: string;
  spoken: string;
  open: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={12}
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityState={{ expanded: open }}
      style={{
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        paddingHorizontal: 12,
        borderRadius: 12,
      }}
    >
      <Text size={15} weight={500} color={theme.colors.mut} numberOfLines={1}>
        {label}
      </Text>
      <Chevron size={16} color={theme.colors.mut} strokeWidth={2} />
    </Touchable>
  );
}

/** A task's ⋯: 44pt, iOS's own menu on iPhone, the card's sheet elsewhere. */
function TaskMore({
  task,
  menu,
  busy,
  env,
}: {
  task: DelegationTaskView;
  menu: NonNullable<ReturnType<typeof delegationTaskMenu>>;
  busy: boolean;
  env: RowEnv;
}) {
  const { rawLocale } = useI18n();
  const delegationWordsHere = delegationWords(rawLocale);
  const theme = useTheme();
  const label = delegationWordsHere.more(task.title);
  const face = busy ? (
    <ActivityIndicator size="small" color={theme.colors.mut} />
  ) : (
    <Ellipsis size={20} color={theme.colors.mut} strokeWidth={1.75} />
  );
  return hasNativeMenu ? (
    <NativeMenu
      spec={menu}
      onPick={(id) => pickForTask(task, id, env.actions)}
      trigger="tap"
      label={label}
      style={MORE_FACE}
    >
      <View style={MORE_FACE}>{face}</View>
    </NativeMenu>
  ) : (
    <Touchable
      onPress={() => env.more(task)}
      feedback="wash"
      ringRadius={22}
      accessibilityLabel={label}
      style={MORE_FACE}
    >
      {face}
    </Touchable>
  );
}

const MORE_FACE = {
  width: 44,
  height: 44,
  borderRadius: 22,
  alignItems: 'center',
  justifyContent: 'center',
} as const;

/** A pick in a task's ⋯ menu: its thread in T3 Code, or Stop this task (the screen asks first). */
function pickForTask(task: DelegationTaskView, id: string, actions: DelegationCardActions) {
  const pick = parseDelegationTaskPick(id);
  if (pick === 'open' && task.url) actions.openUrl(task.url);
  else if (pick === 'stop') actions.stopTask(task);
}

/** The tasks that finished well, in one line (“4 merged”) under the rest, which opens to their rows. */
function FoldedLine({ label, open, onPress }: { label: string; open: boolean; onPress: () => void }) {
  const { rawLocale } = useI18n();
  const delegationWordsHere = delegationWords(rawLocale);
  const theme = useTheme();
  const Chevron = open ? ChevronUp : ChevronDown;
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={theme.radii.button}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={open ? delegationWordsHere.hideFolded : delegationWordsHere.showFolded}
      accessibilityState={{ expanded: open }}
      style={{
        minHeight: 44,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginHorizontal: -8,
        paddingHorizontal: 8,
        borderRadius: theme.radii.button,
      }}
    >
      <View style={{ width: COLUMN, alignItems: 'center' }}>
        <View
          style={{
            width: SLOT,
            height: SLOT,
            borderRadius: SLOT / 2,
            backgroundColor: theme.colors.sf2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Check size={14} color={theme.colors.ok} strokeWidth={2.5} />
        </View>
      </View>
      <Text size={14} weight={600} color={theme.colors.ink2} style={{ flex: 1 }}>
        {label}
      </Text>
      <Chevron size={18} color={theme.colors.mut} strokeWidth={2} />
    </Touchable>
  );
}

/** A task's row on the card itself: its number (a check once done), its title and where it is, in words. */
function TaskSummaryRow({ task }: { task: DelegationTaskView }) {
  const theme = useTheme();
  const tone = task.attention ? theme.colors.warnText : theme.colors.mut;
  return (
    <View
      accessible
      accessibilityLabel={task.label}
      style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 }}
    >
      <WorkingRing working={task.working}>
        <TaskSlot task={task} />
      </WorkingRing>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text size={14.5} weight={600} color={task.muted ? theme.colors.ink2 : theme.colors.ink}>
          {task.title}
        </Text>
        <Text size={13} color={tone}>
          {task.status}
        </Text>
      </View>
    </View>
  );
}

export function DelegationCardPanel({
  card,
  timeZone,
  view,
  after,
  actions,
  pictures,
  access,
  files,
}: {
  /** The card with the ticks and AIs not sent back yet: its head. */
  card: DelegationCard;
  /** The person's zone, for the status line's time. */
  timeZone: string;
  /** The card's view on the row's clock (the times tick), with the ticks not sent back yet. */
  view: DelegationCardView;
  /** “After 1” by task id, for the checklist. */
  after: Readonly<Record<string, string>>;
  actions: DelegationCardActions;
  /** Each task's pictures of what changed, by task id. */
  pictures: Readonly<Record<string, CardPicture[]>>;
  access: FileAccess | null;
  files: MessageFileActions | null;
}) {
  const { rawLocale } = useI18n();
  const cardFrameWordsHere = cardFrameWords(rawLocale);
  const delegationWordsHere = delegationWords(rawLocale);
  const theme = useTheme();
  const [unfolded, setUnfolded] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<DelegationTaskView | null>(null);
  const env: RowEnv = { actions, pictures, access, files, more: setMenuFor };
  const menu = menuFor
    ? delegationTaskMenu(menuFor, actions.stopping.has(menuFor.id) || actions.busy !== null, rawLocale)
    : null;
  const frame = delegationFrame(card, useContext(CardStillContext), rawLocale);
  const head: CardHead = { ...frame, time: frame.at ? formatClock(frame.at, timeZone) : null };
  const handed = view.tasks.length > 0 || view.folded !== null;
  const project = view.project ? (
    <Text size={12} mono color={theme.colors.mut}>
      {view.project}
    </Text>
  ) : null;
  // The checklist's AI per task, or every handed-over task's record: its note, pull request, pictures and ⋯.
  const details = view.offer ? (
    view.aiChoosable || project ? (
      <>
        {view.aiChoosable ? (
          <CardSection title={cardFrameWordsHere.aiPerTask}>
            <View style={{ gap: 6 }}>
              {view.tasks.map((t) => (
                <View
                  key={t.id}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 }}
                >
                  <Text size={14} style={{ flex: 1 }}>
                    <Text size={13} mono color={theme.colors.mut}>
                      {`${t.n}  `}
                    </Text>
                    {t.title}
                  </Text>
                  <AiChip task={t} disabled={actions.busy !== null} onPress={() => actions.chooseAi(t.id)} />
                </View>
              ))}
            </View>
            {view.aiSummary ? (
              <Text size={12.5} lh={1.4} color={theme.colors.mut}>
                {view.aiSummary}
              </Text>
            ) : null}
          </CardSection>
        ) : null}
        {project}
      </>
    ) : null
  ) : handed ? (
    <>
      <CardSection title={cardFrameWordsHere.tasks}>
        <View style={{ gap: 6 }}>
          {view.tasks.map((t) => (
            <TaskRow key={t.id} task={t} env={env} />
          ))}
          {view.folded ? (
            <>
              <FoldedLine label={view.folded.label} open={unfolded} onPress={() => setUnfolded((o) => !o)} />
              {unfolded ? view.folded.tasks.map((t) => <TaskRow key={t.id} task={t} env={env} />) : null}
            </>
          ) : null}
        </View>
      </CardSection>
      {project}
    </>
  ) : (
    project
  );
  const others: CardButton[] = view.offer
    ? [
        { label: delegationWordsHere.change, onPress: actions.change },
        {
          label: delegationWordsHere.notNow,
          busy: actions.busy === 'stop',
          disabled: actions.busy !== null,
          onPress: actions.notNow,
        },
      ]
    : [];
  // Stop for every task steps back: a quiet word at the bottom and in the ⋯ (the screen asks first).
  const stop = !view.offer && view.stoppable ? actions.stop : null;
  return (
    <>
      <CardFrameView
        head={head}
        loud={head.mark === 'waiting'}
        buttons={
          <CardButtons
            main={
              view.offer ? (
                <HandOver view={view} actions={actions} />
              ) : handed ? (
                { label: cardFrameWordsHere.openTasks, onPress: () => setDetailsOpen(true) }
              ) : null
            }
            others={others}
          />
        }
        details={details}
        detailsOpen={detailsOpen}
        onDetailsOpen={setDetailsOpen}
        corner={stop ? <CardCornerMenu title={head.title} onChange={null} onStop={stop} /> : null}
        endAction={
          stop ? (
            <CardStopButton
              label={delegationWordsHere.stop}
              spoken={`${delegationWordsHere.stop}: ${head.title}`}
              busy={actions.busy === 'stop'}
              disabled={actions.busy !== null}
              onPress={stop}
            />
          ) : null
        }
      >
        {view.offer && view.tasks.length ? (
          // The checklist stays on the card, above Hand over: the whole row ticks it.
          <View style={{ gap: 2 }}>
            {view.tasks.map((t) => (
              <PickRow
                key={t.id}
                task={t}
                after={after[t.id] ?? null}
                disabled={actions.busy !== null}
                onPick={actions.pick}
              />
            ))}
          </View>
        ) : null}
        {!view.offer && handed ? (
          <View style={{ gap: 2 }}>
            {view.tasks.map((t) => (
              <TaskSummaryRow key={t.id} task={t} />
            ))}
            {view.folded ? (
              <View style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: COLUMN, alignItems: 'center' }}>
                  <Check size={14} color={theme.colors.ink2} strokeWidth={2.5} />
                </View>
                <Text size={14} weight={600} color={theme.colors.ink2}>
                  {view.folded.label}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </CardFrameView>
      {hasNativeMenu ? null : (
        <MenuSheet
          spec={menu}
          visible={menu !== null}
          label={menuFor ? delegationWordsHere.more(menuFor.title) : delegationWordsHere.stop}
          onClose={() => setMenuFor(null)}
          onPick={(id) => {
            if (menuFor) pickForTask(menuFor, id, actions);
          }}
        />
      )}
    </>
  );
}
