/**
 * A job's result as a message (docs/app/decisions/job-result.md): T3 Code's own report under its name, laid out by its
 * parts (`@whombat/client` `jobResultView`) — the outcome, what changed, what it decided, what its council decided, what
 * is left for the person with the choices to mark and one Send for them all — then the facts in one line, the technical
 * detail folded, and the way to T3 Code. Every word is `JOB_RESULT_WORDS` or the report's; a part without rows is its
 * markdown, so nothing T3 Code wrote is dropped.
 */
import { useQueryClient } from '@tanstack/react-query';
import {
  JOB_RESULT_WORDS,
  type JobReportSection,
  type JobResultFact,
  type JobResultPoint,
  type JobResultView,
  jobAnswersOf,
  jobSendBar,
} from '@whombat/client';
import { upsertMessageEverywhere } from '@whombat/client/query';
import { useJobAnswers } from '@whombat/client/react';
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type AccessibilityActionEvent, AccessibilityInfo, Platform, TextInput, View } from 'react-native';
import { useBurrowBase, useNowLabel } from '../data/BurrowProvider';
import {
  answeredLine,
  chooseMark,
  doneLine,
  type JobMarks,
  markedCount,
  marksFor,
  NO_MARKS,
  outcomeParts,
  plainList,
  pointsKey,
  sentLine,
  toggleWords,
  typeWords,
} from '../data/jobResult';
import { showToast } from '../data/toast';
import { useOpenUrl } from '../navigation/hooks';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { AuthorLine } from './chat';
import { CouncilFaces } from './councilFaces';
import { T3Tile } from './handoff';
import { Check, ChevronDown, ChevronRight, Circle, ExternalLink, X } from './icons';
import { useRevealInList } from './revealInList';
import { RichText } from './rich';
import { Touchable } from './Touchable';

/** iOS's 44pt, Android's 48dp. */
const TARGET = Platform.OS === 'android' ? 48 : 44;

/**
 * What the person marked on each result message, by its id: a row scrolled out of the list and back, or re-rendered by a
 * `message.updated` that left the points as they were, keeps them. Gone with the app.
 */
const marksByMessage = new Map<string, { key: string; marks: JobMarks }>();

function useJobMarks(messageId: string, key: string) {
  const [stored, setStored] = useState(() => marksByMessage.get(messageId));
  const marks = marksFor(stored, key);
  const change = useCallback(
    (next: (m: JobMarks) => JobMarks) =>
      setStored((s) => {
        const value = { key, marks: next(marksFor(s, key)) };
        marksByMessage.set(messageId, value);
        return value;
      }),
    [messageId, key],
  );
  return [marks, change] as const;
}

/** A line that changes while it shows is read out politely (TalkBack by its live region, VoiceOver told). */
function useAnnounce(text: string | null) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (text && Platform.OS === 'ios')
      AccessibilityInfo.announceForAccessibilityWithOptions(text, { queue: true });
  }, [text]);
}

export interface JobResultMessageProps {
  messageId: string;
  view: JobResultView;
  /** The message's time, as the author line of every message says it. */
  time: string;
  /** The message's own actions for screen readers (its menu, Copy, a link), on its author line. */
  accessibilityActions: { name: string }[];
  onAccessibilityAction: (e: AccessibilityActionEvent) => void;
}

export const JobResultMessage = memo(function JobResultMessage({
  messageId,
  view,
  time,
  accessibilityActions,
  onAccessibilityAction,
}: JobResultMessageProps) {
  const theme = useTheme();
  const openUrl = useOpenUrl();
  const { slug, timeZone } = useBurrowBase();
  const [marks, setMarks] = useJobMarks(messageId, pointsKey(view.points));
  const send = useJobAnswers(slug);
  const qc = useQueryClient();
  const { lead, rest } = outcomeParts(view.report.outcome);
  const url = view.url;

  const submit = async () => {
    const answers = jobAnswersOf(view.points, marks.marks);
    if (!answers.length || send.isPending) return;
    try {
      const r = await send.mutateAsync({ messageId, answers });
      if (r.status !== 'ok') {
        showToast(JOB_RESULT_WORDS.left.failed);
        return;
      }
      // The answer is the message as it is now; the `message.updated` frame follows, but the thread shows it at once.
      upsertMessageEverywhere(qc, r.data.message);
      setMarks(() => NO_MARKS);
      // Said once, as they go; the line itself then ticks each minute without being read again.
      AccessibilityInfo.announceForAccessibility(
        JOB_RESULT_WORDS.left.sent(answers.length, '').replace(/ · $/, ''),
      );
    } catch {
      showToast(JOB_RESULT_WORDS.left.failed);
    }
  };

  const hasLeft = view.report.sections.some((s) => s.kind === 'left');
  const pendingLine = view.pending ? <SentLine pending={view.pending} open={view.open} /> : null;
  const done = !view.pending && view.done ? doneLine(view.done, timeZone) : null;

  return (
    <View style={{ gap: 8 }} testID="job-result">
      <View
        accessible
        accessibilityLabel={`${JOB_RESULT_WORDS.author}, ${time}`}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={onAccessibilityAction}
      >
        <AuthorLine avatar={<T3Tile size={24} />} name={JOB_RESULT_WORDS.author} time={time} />
      </View>
      <View style={{ gap: 10, marginTop: 2 }}>
        {lead ? (
          <RichText
            text={lead}
            color={theme.colors.ink}
            accentColor={theme.colors.brand}
            codeBackground={theme.colors.sf2}
            size={17}
            lh={wholeLines(17)}
            selectable
          />
        ) : null}
        {rest ? <Body text={rest} size={15.5} color={theme.colors.ink} /> : null}
      </View>
      {view.report.sections.map((section, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the report's sections are positional
        <Section key={i}>
          {section.kind === 'left' ? (
            <LeftSection
              section={section}
              view={view}
              marks={marks}
              setMarks={setMarks}
              sending={send.isPending}
              onSend={() => void submit()}
              after={pendingLine}
            />
          ) : (
            <ReportSection section={section} />
          )}
        </Section>
      ))}
      {/* Answers sent while the report has no “Left for you” of its own: the line still says T3 Code has them. */}
      {!hasLeft && pendingLine ? <View style={{ marginTop: 6 }}>{pendingLine}</View> : null}
      {view.cut ? (
        url ? (
          <LinkText label={JOB_RESULT_WORDS.facts.rest} onPress={() => openUrl(url)} brand />
        ) : (
          <Text size={14} color={theme.colors.mut}>
            {JOB_RESULT_WORDS.facts.rest}
          </Text>
        )
      ) : null}
      {done ? (
        <View
          style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 6 }}
          accessibilityLiveRegion="polite"
          accessible
          accessibilityLabel={done.text}
        >
          {done.tone === 'ok' ? <Check size={14} color={theme.colors.okText} strokeWidth={2.25} /> : null}
          <Text
            size={14}
            color={
              done.tone === 'ok'
                ? theme.colors.okText
                : done.tone === 'bad'
                  ? theme.colors.bad
                  : theme.colors.mut
            }
            style={{ flexShrink: 1 }}
          >
            {done.text}
          </Text>
        </View>
      ) : null}
      <Facts view={view} />
    </View>
  );
});

/** One part of the report, a hairline above it. */
function Section({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ marginTop: 8, paddingTop: 16, borderTopWidth: 1, borderTopColor: theme.colors.line }}>
      {children}
    </View>
  );
}

/**
 * About 1.5 of the size, rounded to whole points: with 22.5pt lines iOS's selectable text view drew one point's two-line
 * text as one line ending in “…” (seen on the simulator); whole-point lines lay out as measured.
 */
const wholeLines = (size: number) => Math.round(size * 1.5) / size;

function Body({ text, size = 15, color }: { text: string; size?: number; color?: string }) {
  const theme = useTheme();
  return (
    <RichText
      text={text}
      color={color ?? theme.colors.ink2}
      accentColor={theme.colors.brand}
      codeBackground={theme.colors.sf2}
      size={size}
      lh={wholeLines(size)}
      selectable
    />
  );
}

function SectionTitle({ title, before, after }: { title: string; before?: ReactNode; after?: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
      {before}
      <Text size={16} weight={700} lh={1.35} accessibilityRole="header" style={{ flexShrink: 1 }}>
        {title}
      </Text>
      {after}
    </View>
  );
}

function Bullet({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <View
        style={{
          width: 5,
          height: 5,
          borderRadius: 2.5,
          marginTop: 9,
          marginLeft: 3,
          backgroundColor: theme.colors.line2,
        }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Body text={text} />
      </View>
    </View>
  );
}

/** Every part but “Left for you”: its rows where the report gave them, else its markdown. */
function ReportSection({ section }: { section: Exclude<JobReportSection, { kind: 'left' }> }) {
  const theme = useTheme();
  const intro = section.intro ? <Body text={section.intro} /> : null;
  const outro = section.outro ? <Body text={section.outro} /> : null;
  if (section.kind === 'changed' && section.groups)
    return (
      <View>
        <SectionTitle title={section.title} />
        <View style={{ gap: 14 }}>
          {intro}
          {section.groups.map((g, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the report's areas are positional
            <View key={i} style={{ gap: 6 }}>
              {g.label ? (
                <Text size={14.5} weight={600}>
                  {g.label}
                </Text>
              ) : null}
              {g.items.map((item, j) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: an area's items are positional
                <Bullet key={j} text={item} />
              ))}
            </View>
          ))}
          {outro}
        </View>
      </View>
    );
  if (section.kind === 'council')
    return (
      <View>
        <SectionTitle title={section.title} before={<CouncilFaces size={20} />} />
        {section.decisions ? (
          <View style={{ gap: 14 }}>
            {intro}
            {section.decisions.map((d, i) => (
              <View
                // biome-ignore lint/suspicious/noArrayIndexKey: the council's decisions are positional
                key={i}
                style={{ gap: 2 }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 2 }}>
                  {d.tone === 'ok' ? (
                    <Check size={14} color={theme.colors.okText} strokeWidth={2.25} />
                  ) : (
                    <Circle size={13} color={theme.colors.mut} strokeWidth={2} />
                  )}
                  <Text
                    size={13.5}
                    weight={600}
                    color={d.tone === 'ok' ? theme.colors.okText : theme.colors.mut}
                  >
                    {d.status}
                  </Text>
                </View>
                <Text size={15.5} weight={600} lh={1.4}>
                  {d.title}
                </Text>
                {d.reason ? <Body text={d.reason} /> : null}
              </View>
            ))}
            {outro}
          </View>
        ) : (
          <Body text={section.body} />
        )}
      </View>
    );
  // “What I decided”, a part T3 Code named itself, and “What changed” without areas: as it wrote them, a plain list with
  // the bullets What changed has.
  const list = plainList(section.body);
  return (
    <View>
      <SectionTitle title={section.title} />
      {list ? (
        <View style={{ gap: 6 }}>
          {list.intro ? <Body text={list.intro} /> : null}
          {list.items.map((item, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a list's items are positional
            <Bullet key={i} text={item} />
          ))}
          {list.outro ? <Body text={list.outro} /> : null}
        </View>
      ) : (
        <Body text={section.body} />
      )}
    </View>
  );
}

function LeftSection({
  section,
  view,
  marks,
  setMarks,
  sending,
  onSend,
  after,
}: {
  section: Extract<JobReportSection, { kind: 'left' }>;
  view: JobResultView;
  marks: JobMarks;
  setMarks: (next: (m: JobMarks) => JobMarks) => void;
  sending: boolean;
  onSend: () => void;
  /** The sent line, in place of the send bar while T3 Code works on the answers. */
  after: ReactNode;
}) {
  const theme = useTheme();
  const numbers = new Set(section.points.map((p) => p.n));
  const points = view.points.filter((p) => numbers.has(p.n));
  const marked = markedCount(view.points, marks);
  const bar = jobSendBar(view, marked);
  // Only the last “Left for you” carries the bar, under all the points it sends.
  const last = view.report.sections.filter((s) => s.kind === 'left').at(-1) === section;
  const locked = !!view.pending || sending;
  useAnnounce(bar && last ? bar.hint : null);
  return (
    <View>
      <SectionTitle
        title={section.title}
        before={
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.status.waiting }} />
        }
        after={
          view.open > 0 ? (
            <Text size={12} mono color={theme.colors.mut}>
              {view.open}
            </Text>
          ) : null
        }
      />
      <View style={{ gap: 4, marginTop: -4 }}>
        {section.intro ? <Body text={section.intro} /> : null}
        {bar && last ? (
          <Text size={15} lh={1.5} color={theme.colors.ink2}>
            {JOB_RESULT_WORDS.left.intro}
          </Text>
        ) : null}
      </View>
      {points.length ? (
        <View style={{ marginTop: 6 }}>
          {points.map((p, i) => (
            <PointView
              key={p.n}
              point={p}
              first={i === 0}
              marks={marks}
              setMarks={setMarks}
              locked={locked}
            />
          ))}
        </View>
      ) : section.intro ? null : (
        <Body text={section.body} />
      )}
      {section.outro ? (
        <View style={{ marginTop: 6 }}>
          <Body text={section.outro} />
        </View>
      ) : null}
      {bar && last ? (
        <View
          style={{
            marginTop: 10,
            paddingTop: 14,
            gap: 8,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
          testID="job-result-send"
        >
          <Touchable
            onPress={onSend}
            disabled={!bar.enabled || sending}
            feedback="fade"
            accessibilityRole="button"
            accessibilityLabel={bar.button}
            accessibilityState={{ disabled: !bar.enabled || sending, busy: sending }}
            ringRadius={theme.radii.button}
            style={{
              minHeight: TARGET,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: 16,
              borderRadius: theme.radii.button,
              backgroundColor: theme.colors.btn,
              opacity: !bar.enabled || sending ? 0.45 : 1,
            }}
          >
            <Text size={15} weight={600} color={theme.colors.btnfg}>
              {bar.button}
            </Text>
          </Touchable>
          <Text size={14} lh={1.45} color={theme.colors.mut} accessibilityLiveRegion="polite">
            {bar.hint}
          </Text>
        </View>
      ) : last && after ? (
        <View style={{ marginTop: 10, paddingTop: 14, borderTopWidth: 1, borderTopColor: theme.colors.line }}>
          {after}
        </View>
      ) : null}
    </View>
  );
}

function PointView({
  point,
  first,
  marks,
  setMarks,
  locked,
}: {
  point: JobResultPoint;
  first: boolean;
  marks: JobMarks;
  setMarks: (next: (m: JobMarks) => JobMarks) => void;
  /** Answers are on their way or with T3 Code: nothing more can be marked until it is done. */
  locked: boolean;
}) {
  const theme = useTheme();
  const reveal = useRevealInList();
  const fieldRef = useRef<View>(null);
  const answered = answeredLine(point);
  const mark = marks.marks[point.n];
  const writing = marks.writing.includes(point.n);
  return (
    <View
      style={{
        paddingTop: first ? 2 : 14,
        paddingBottom: 14,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
      testID={`job-result-point-${point.n}`}
    >
      <Text size={16} weight={600} lh={1.4} color={answered ? theme.colors.ink2 : theme.colors.ink}>
        {point.title}
      </Text>
      {point.text ? (
        <View style={{ marginTop: 2 }}>
          <Body text={point.text} />
        </View>
      ) : null}
      {answered ? (
        <Text size={14.5} lh={1.5} style={{ marginTop: 10 }} testID={`job-result-answered-${point.n}`}>
          {point.answer?.choice ? (
            <>
              {JOB_RESULT_WORDS.left.chose('')}
              <Text size={14.5} lh={1.5} weight={600}>
                {point.answer.choice}
              </Text>
            </>
          ) : (
            answered
          )}
        </Text>
      ) : (
        <>
          {point.advice ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: 10,
                marginTop: 10,
                paddingVertical: 10,
                paddingHorizontal: 12,
                borderRadius: 12,
                backgroundColor: theme.colors.sf2,
              }}
            >
              {/* Ringed in the page's colour, as on the web, so the three faces stand out on the tint. */}
              {point.council ? <CouncilFaces size={18} /> : null}
              <View style={{ flex: 1, minWidth: 0 }}>
                <RichText
                  text={`**${point.council ? JOB_RESULT_WORDS.council : JOB_RESULT_WORDS.advice}** ${point.advice}`}
                  color={theme.colors.ink2}
                  accentColor={theme.colors.brand}
                  codeBackground={theme.colors.bg}
                  size={14.5}
                  lh={1.5}
                />
              </View>
            </View>
          ) : null}
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 12 }}
          >
            {point.choices.map((c) => {
              const on = mark?.choice === c;
              return (
                <Touchable
                  key={c}
                  onPress={() => setMarks((m) => chooseMark(m, point.n, c))}
                  disabled={locked}
                  feedback="wash"
                  accessibilityRole="button"
                  accessibilityLabel={c}
                  accessibilityState={{ selected: on, disabled: locked }}
                  ringRadius={theme.radii.button}
                  style={{
                    minHeight: TARGET,
                    maxWidth: '100%',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingHorizontal: 18,
                    paddingVertical: 8,
                    borderRadius: theme.radii.button,
                    borderWidth: 1,
                    borderColor: on ? theme.colors.ink : theme.colors.line2,
                    backgroundColor: on ? theme.colors.sel : 'transparent',
                    opacity: locked ? 0.45 : 1,
                  }}
                >
                  {on ? <Check size={14} color={theme.colors.ink} strokeWidth={2.5} /> : null}
                  <Text size={15} weight={on ? 600 : 500} style={{ flexShrink: 1 }}>
                    {c}
                  </Text>
                </Touchable>
              );
            })}
          </View>
          <Touchable
            onPress={() => setMarks((m) => toggleWords(m, point.n))}
            disabled={locked}
            feedback="fade"
            accessibilityRole="button"
            accessibilityLabel={JOB_RESULT_WORDS.left.reply}
            accessibilityState={{ expanded: writing, disabled: locked }}
            style={{
              alignSelf: 'flex-start',
              minHeight: TARGET,
              justifyContent: 'center',
              marginTop: 2,
              opacity: locked ? 0.45 : 1,
            }}
          >
            <Text
              size={14.5}
              weight={500}
              color={theme.colors.brand}
              style={{ textDecorationLine: 'underline' }}
            >
              {JOB_RESULT_WORDS.left.reply}
            </Text>
          </Touchable>
          {writing ? (
            <View ref={fieldRef} collapsable={false}>
              <TextInput
                autoFocus
                value={mark?.words ?? ''}
                onChangeText={(t) => setMarks((m) => typeWords(m, point.n, t))}
                onFocus={() => reveal?.(fieldRef.current)}
                editable={!locked}
                multiline
                placeholder={JOB_RESULT_WORDS.left.replyPlaceholder}
                placeholderTextColor={theme.colors.placeholder}
                accessibilityLabel={JOB_RESULT_WORDS.left.replyLabel(point.title)}
                selectionColor={theme.colors.brand}
                style={{
                  minHeight: TARGET + 20,
                  maxHeight: 200,
                  paddingVertical: 10,
                  paddingHorizontal: 12,
                  borderRadius: 12,
                  borderWidth: 1,
                  borderColor: theme.colors.line2,
                  backgroundColor: theme.colors.sf,
                  color: theme.colors.ink,
                  fontSize: 15,
                  textAlignVertical: 'top',
                }}
              />
            </View>
          ) : null}
        </>
      )}
    </View>
  );
}

/** Answers with T3 Code: how many and for how long, ticking each minute; the points still open say they can wait. */
function SentLine({ pending, open }: { pending: NonNullable<JobResultView['pending']>; open: number }) {
  const theme = useTheme();
  const text = useNowLabel((now) => sentLine(pending, now.getTime()));
  return (
    <View style={{ gap: 6 }} testID="job-result-sent">
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
        accessible
        accessibilityLabel={text}
        accessibilityLiveRegion="polite"
      >
        <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: theme.colors.progress }} />
        <Text size={14} lh={1.45} color={theme.colors.mut} style={{ flexShrink: 1 }}>
          {text}
        </Text>
      </View>
      {open > 0 ? (
        <Text size={14} lh={1.45} color={theme.colors.mut}>
          {JOB_RESULT_WORDS.left.hintOpen(open)}
        </Text>
      ) : null}
    </View>
  );
}

function LinkText({
  label,
  onPress,
  brand = false,
}: {
  label: string;
  onPress: () => void;
  brand?: boolean;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="fade"
      accessibilityRole="link"
      accessibilityLabel={label}
      style={{
        alignSelf: 'flex-start',
        minHeight: TARGET,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
      }}
    >
      <Text
        size={13.5}
        weight={500}
        color={brand ? theme.colors.brand : theme.colors.ink2}
        style={{ textDecorationLine: 'underline', textDecorationColor: theme.colors.line2 }}
      >
        {label}
      </Text>
    </Touchable>
  );
}

function FactText({ fact }: { fact: JobResultFact }) {
  const theme = useTheme();
  const openUrl = useOpenUrl();
  const color =
    fact.tone === 'ok' ? theme.colors.okText : fact.tone === 'bad' ? theme.colors.bad : theme.colors.mut;
  const words = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      {fact.tone === 'ok' ? <Check size={13} color={color} strokeWidth={2.5} /> : null}
      {fact.tone === 'bad' ? <X size={13} color={color} strokeWidth={2.5} /> : null}
      <Text
        size={13.5}
        lh={1.5}
        weight={fact.tone ? 600 : 400}
        color={color}
        numberOfLines={1}
        style={fact.url ? { textDecorationLine: 'underline', textDecorationColor: theme.colors.line2 } : null}
      >
        {fact.text}
      </Text>
    </View>
  );
  const url = fact.url;
  if (!url) return words;
  return (
    <Touchable
      onPress={() => openUrl(url)}
      feedback="fade"
      accessibilityRole="link"
      accessibilityLabel={fact.text}
      style={{ minHeight: TARGET, justifyContent: 'center' }}
    >
      {words}
    </Touchable>
  );
}

/**
 * The facts in one group that wraps between whole facts (no `·` to start a line), then Technical detail, which unfolds
 * in place, and Open in T3 Code.
 */
function Facts({ view }: { view: JobResultView }) {
  const theme = useTheme();
  const openUrl = useOpenUrl();
  const [open, setOpen] = useState(false);
  const detail = view.report.detail;
  const url = view.url;
  const plain = view.facts.filter((f) => !f.url);
  return (
    <View
      style={{ marginTop: 8, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme.colors.line }}
      testID="job-result-facts"
    >
      {view.facts.length ? (
        <View
          style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 2 }}
        >
          {/* Read as one line: the facts in their order, a pull request its own link after them. */}
          <View
            accessible
            accessibilityLabel={plain.map((f) => f.text).join(', ')}
            style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 14, rowGap: 2 }}
          >
            {plain.map((f) => (
              <FactText key={f.key} fact={f} />
            ))}
          </View>
          {view.facts
            .filter((f) => f.url)
            .map((f) => (
              <FactText key={f.key} fact={f} />
            ))}
        </View>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 18 }}>
        {detail ? (
          <Touchable
            onPress={() => setOpen((o) => !o)}
            feedback="fade"
            accessibilityRole="button"
            accessibilityLabel={JOB_RESULT_WORDS.facts.detail}
            accessibilityState={{ expanded: open }}
            style={{ minHeight: TARGET, flexDirection: 'row', alignItems: 'center', gap: 4 }}
            testID="job-result-detail-toggle"
          >
            <Text size={13.5} weight={500} color={theme.colors.ink2}>
              {open ? JOB_RESULT_WORDS.facts.hideDetail : JOB_RESULT_WORDS.facts.detail}
            </Text>
            {open ? (
              <ChevronDown size={14} color={theme.colors.mut} strokeWidth={2} />
            ) : (
              <ChevronRight size={14} color={theme.colors.mut} strokeWidth={2} />
            )}
          </Touchable>
        ) : null}
        {url ? (
          <Touchable
            onPress={() => openUrl(url)}
            feedback="fade"
            accessibilityRole="link"
            accessibilityLabel={JOB_RESULT_WORDS.facts.open}
            style={{ minHeight: TARGET, flexDirection: 'row', alignItems: 'center', gap: 5 }}
          >
            <Text
              size={13.5}
              weight={500}
              color={theme.colors.ink2}
              style={{ textDecorationLine: 'underline', textDecorationColor: theme.colors.line2 }}
            >
              {JOB_RESULT_WORDS.facts.open}
            </Text>
            <ExternalLink size={13} color={theme.colors.mut} strokeWidth={2} />
          </Touchable>
        ) : null}
      </View>
      {detail && open ? (
        <View
          style={{
            marginTop: 4,
            paddingVertical: 12,
            paddingHorizontal: 14,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme.colors.line,
            backgroundColor: theme.colors.sf,
          }}
          testID="job-result-detail"
        >
          <Body text={detail} size={14} />
        </View>
      ) : null}
    </View>
  );
}
