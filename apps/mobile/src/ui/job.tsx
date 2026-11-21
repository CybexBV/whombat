/**
 * A job handed to T3 Code on the phone (docs/app/decisions/job-view.md AP-7886…AP-7899): at the thread's end the job's
 * parts — the receipt, a question's options as buttons, the plan, its pull request, the changes, the checks with the
 * fix attempt and the field that steers or queues a message. A permission isn't a part: T3 Code's line above the composer says it (`handoff.tsx`). Every word
 * is `@whombat/client`'s `job.ts`; a part the box didn't give is not drawn (`data/job.ts` `jobParts`).
 */
import {
  JOB_WORDS,
  type JobQuestion,
  jobAnswer,
  jobChanges,
  jobChecks,
  jobPlan,
  jobPullRequest,
  jobQuestion,
  jobReceipt,
} from '@whombat/client';
import { useJobActions } from '@whombat/client/react';
import type { Handoff } from '@whombat/core';
import { useEffect, useRef, useState } from 'react';
import { Image, Platform, TextInput, View } from 'react-native';
import { jobParts, jobToasts, PHONE_FILES } from '../data/job';
import { showToast } from '../data/toast';
import { useOpenUrl } from '../navigation/hooks';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Check, ChevronDown, ChevronUp, GitPullRequest, MessageSquare, X } from './icons';
import { RichText } from './rich';
import { Touchable } from './Touchable';

/**
 * A toast while the app is open when a job starts to need the person's OK, is done or failed; never for a stage, a step
 * or a check. Pushes stay the assistant's own messages (job-view.md).
 */
export function useJobToasts(handoffs: readonly Handoff[]): void {
  const seen = useRef(new Map<string, Handoff>());
  const first = useRef(true);
  useEffect(() => {
    for (const t of jobToasts(seen.current, handoffs, null, first.current)) showToast(t.text);
    if (handoffs.length) first.current = false;
  }, [handoffs]);
}

/** iOS's 44pt, Android's 48dp. */
const TARGET = Platform.OS === 'android' ? 48 : 44;

const live = (h: Handoff) =>
  h.state === 'working' || h.state === 'finishing' || h.state === 'asked' || h.state === 'needs_ok';

/** The job's parts at the thread's end; nothing when the box gave none. */
export function JobPanel({
  slug,
  conversationId,
  handoff,
}: {
  slug: string;
  conversationId: string;
  handoff: Handoff;
}) {
  const theme = useTheme();
  const parts = jobParts(handoff);
  if (!parts.length) return null;
  return (
    <View
      style={{
        marginHorizontal: 12,
        marginTop: 8,
        borderWidth: 1,
        borderColor: theme.colors.line,
        borderRadius: 12,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
      testID={`job-panel-${handoff.state}`}
    >
      {parts.map((p, i) => (
        <View key={p} style={i > 0 ? { borderTopWidth: 1, borderTopColor: theme.colors.line } : undefined}>
          {p === 'receipt' ? <Receipt handoff={handoff} /> : null}
          {p === 'question' ? (
            <QuestionPart
              slug={slug}
              conversationId={conversationId}
              question={jobQuestion(handoff) as JobQuestion}
            />
          ) : null}
          {p === 'plan' ? <PlanPart key={`${handoff.id}:${live(handoff)}`} handoff={handoff} /> : null}
          {p === 'pullRequest' ? <PullRequest handoff={handoff} /> : null}
          {p === 'changes' ? <Changes handoff={handoff} /> : null}
          {p === 'checks' ? <Checks handoff={handoff} /> : null}
          {p === 'message' ? (
            <MessageField slug={slug} conversationId={conversationId} handoffId={handoff.id} />
          ) : null}
        </View>
      ))}
    </View>
  );
}

function Kicker({ title, count }: { title: string; count?: string | null }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8, flexShrink: 1 }}>
      <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
        {title.toUpperCase()}
      </Text>
      {count ? (
        <Text size={13} color={theme.colors.ink2} numberOfLines={1} style={{ flexShrink: 1 }}>
          {count}
        </Text>
      ) : null}
    </View>
  );
}

const PAD = { paddingHorizontal: 14, paddingVertical: 12 } as const;

function PlanPart({ handoff }: { handoff: Handoff }) {
  const theme = useTheme();
  const plan = jobPlan(handoff);
  const [open, setOpen] = useState(plan?.open ?? false);
  if (!plan) return null;
  return (
    <View style={PAD}>
      <Touchable
        onPress={() => setOpen((o) => !o)}
        feedback="fade"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${JOB_WORDS.plan.title}, ${plan.count}`}
        style={{ minHeight: TARGET - 12, flexDirection: 'row', alignItems: 'center' }}
      >
        <Kicker title={JOB_WORDS.plan.title} count={plan.count} />
        <View style={{ marginLeft: 'auto' }}>
          {open ? (
            <ChevronUp size={16} color={theme.colors.mut} />
          ) : (
            <ChevronDown size={16} color={theme.colors.mut} />
          )}
        </View>
      </Touchable>
      {open ? (
        <View style={{ gap: 7, marginTop: 4 }}>
          {plan.rows.map((r) => (
            <View
              key={r.text}
              style={{ flexDirection: 'row', gap: 9 }}
              accessible
              accessibilityLabel={r.spoken}
            >
              <View
                style={{
                  width: 15,
                  height: 15,
                  marginTop: 2,
                  borderRadius: 4,
                  borderWidth: 1.5,
                  borderColor: r.state === 'next' ? theme.colors.line2 : theme.colors.progress,
                  backgroundColor: r.state === 'done' ? theme.colors.progress : 'transparent',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {r.state === 'done' ? <Check size={10} color={theme.colors.sf} strokeWidth={3} /> : null}
                {r.state === 'now' ? (
                  <View
                    style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: theme.colors.progress }}
                  />
                ) : null}
              </View>
              <Text
                size={14}
                weight={r.state === 'now' ? 600 : 400}
                color={r.state === 'done' ? theme.colors.mut : theme.colors.ink}
                style={{ flex: 1 }}
              >
                {r.text}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function LinkButton({ label, url }: { label: string; url: string }) {
  const theme = useTheme();
  const openUrl = useOpenUrl();
  return (
    <Touchable
      onPress={() => openUrl(url)}
      feedback="wash"
      accessibilityRole="link"
      accessibilityLabel={label}
      ringRadius={theme.radii.button}
      style={{
        minHeight: TARGET,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'flex-start',
      }}
    >
      <GitPullRequest size={14} color={theme.colors.ink2} strokeWidth={2} />
      <Text size={14} weight={500} color={theme.colors.ink2}>
        {label}
      </Text>
    </Touchable>
  );
}

/** Its pull request and whether it is merged, one tap to open it. */
function PullRequest({ handoff }: { handoff: Handoff }) {
  const theme = useTheme();
  const openUrl = useOpenUrl();
  const pr = jobPullRequest(handoff);
  if (!pr) return null;
  return (
    <Touchable
      onPress={() => openUrl(pr.url)}
      feedback="wash"
      accessibilityRole="link"
      accessibilityLabel={pr.spoken}
      style={{ ...PAD, minHeight: TARGET, flexDirection: 'row', alignItems: 'center', gap: 8 }}
      testID={`job-pull-request-${pr.state}`}
    >
      <Kicker title={JOB_WORDS.pullRequest.title} />
      <GitPullRequest size={14} color={theme.colors.ink2} strokeWidth={2} />
      <Text size={13} color={theme.colors.ink2} numberOfLines={1} style={{ flexShrink: 1 }}>
        {pr.text}
      </Text>
    </Touchable>
  );
}

function Changes({ handoff }: { handoff: Handoff }) {
  const theme = useTheme();
  const changes = jobChanges(handoff, PHONE_FILES);
  if (!changes) return null;
  return (
    <View style={[PAD, { paddingBottom: changes.url ? 2 : 12 }]}>
      <Kicker title={JOB_WORDS.changes.title} count={changes.summary} />
      {changes.title ? (
        <Text size={14} color={theme.colors.ink} style={{ marginTop: 6 }}>
          {changes.title}
        </Text>
      ) : null}
      <View style={{ gap: 3, marginTop: 8 }}>
        {changes.files.map((f) => (
          <View
            key={f.path}
            style={{ flexDirection: 'row', gap: 8 }}
            accessible
            accessibilityLabel={f.spoken}
          >
            <Text size={12} mono color={theme.colors.ink} numberOfLines={1} style={{ flex: 1 }}>
              {f.name}
            </Text>
            <Text size={12} mono color={theme.colors.okText}>
              {f.plus}
            </Text>
            <Text size={12} mono color={theme.colors.bad}>
              {f.minus}
            </Text>
          </View>
        ))}
      </View>
      {changes.more ? (
        <Text size={12.5} color={theme.colors.mut} style={{ marginTop: 6 }}>
          {changes.more}
        </Text>
      ) : null}
      {changes.url ? <LinkButton label={JOB_WORDS.changes.open} url={changes.url} /> : null}
    </View>
  );
}

function Checks({ handoff }: { handoff: Handoff }) {
  const theme = useTheme();
  const openUrl = useOpenUrl();
  const checks = jobChecks(handoff);
  if (!checks) return null;
  const tone = (t: string) =>
    t === 'ok'
      ? theme.colors.ok
      : t === 'bad'
        ? theme.colors.bad
        : t === 'live'
          ? theme.status.working
          : theme.colors.line2;
  return (
    <View style={PAD}>
      <Kicker title={JOB_WORDS.checks.title} count={checks.count} />
      {checks.failure ? (
        <Text
          size={14}
          weight={600}
          color={theme.colors.warnText}
          style={{ marginTop: 6 }}
          accessibilityLiveRegion="polite"
        >
          {checks.failure}
        </Text>
      ) : null}
      <View style={{ marginTop: 4 }}>
        {checks.rows.map((c) => {
          const url = c.url;
          return (
            <Touchable
              key={c.name}
              onPress={url ? () => openUrl(url) : undefined}
              disabled={!url}
              feedback="fade"
              accessibilityRole={url ? 'link' : 'text'}
              accessibilityLabel={`${c.name}, ${c.word}`}
              style={{ minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 9 }}
            >
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone(c.tone) }} />
              <Text size={14} color={theme.colors.ink} numberOfLines={1} style={{ flex: 1 }}>
                {c.name}
              </Text>
              <Text size={13} color={c.tone === 'bad' ? theme.colors.bad : theme.colors.mut}>
                {c.word}
              </Text>
            </Touchable>
          );
        })}
      </View>
    </View>
  );
}

function QuestionPart({
  slug,
  conversationId,
  question,
}: {
  slug: string;
  conversationId: string;
  question: JobQuestion;
}) {
  const theme = useTheme();
  const { answer } = useJobActions(slug, conversationId);
  const [sent, setSent] = useState<string | null>(null);
  const pick = async (label: string, answers: Record<string, string>) => {
    try {
      const r = await answer.mutateAsync({
        handoffId: question.handoffId,
        requestId: question.requestId,
        answers,
      });
      if (r.status === 'ok') {
        setSent(label);
        showToast(JOB_WORDS.question.answered(label));
      } else showToast(JOB_WORDS.question.failed);
    } catch {
      showToast(JOB_WORDS.question.failed);
    }
  };
  return (
    <View style={PAD}>
      <Kicker title={JOB_WORDS.question.title} />
      <Text size={15.5} weight={600} color={theme.colors.ink} style={{ marginTop: 6 }}>
        {question.text}
      </Text>
      {!question.multiSelect && question.options.length > 0 ? (
        <View style={{ gap: 8, marginTop: 10 }}>
          {question.options.map((o) => (
            <Touchable
              key={o.label}
              onPress={() => void pick(o.label, o.answers)}
              disabled={answer.isPending || sent !== null}
              feedback="wash"
              accessibilityRole="button"
              accessibilityLabel={[o.label, o.description].filter(Boolean).join(', ')}
              accessibilityState={{ disabled: answer.isPending || sent !== null, selected: sent === o.label }}
              ringRadius={theme.radii.button}
              style={{
                minHeight: TARGET,
                justifyContent: 'center',
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: theme.radii.button,
                borderWidth: 1,
                borderColor: sent === o.label ? theme.colors.progress : theme.colors.line2,
                backgroundColor: theme.colors.bg,
                opacity: sent !== null && sent !== o.label ? 0.5 : 1,
              }}
            >
              <Text size={15} weight={600} color={theme.colors.ink}>
                {o.label}
              </Text>
              {o.description ? (
                <Text size={13} color={theme.colors.mut}>
                  {o.description}
                </Text>
              ) : null}
            </Touchable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function MessageField({
  slug,
  conversationId,
  handoffId,
}: {
  slug: string;
  conversationId: string;
  handoffId: string;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'steer' | 'queue'>('steer');
  const { send } = useJobActions(slug, conversationId);
  const submit = async () => {
    const t = text.trim();
    if (!t || send.isPending) return;
    try {
      const r = await send.mutateAsync({ handoffId, text: t, mode });
      if (r.status !== 'ok') {
        showToast(JOB_WORDS.message.failed);
        return;
      }
      showToast(mode === 'steer' ? JOB_WORDS.message.sentNow : JOB_WORDS.message.sentNext);
      setText('');
      setOpen(false);
    } catch {
      showToast(JOB_WORDS.message.failed);
    }
  };
  if (!open)
    return (
      <Touchable
        onPress={() => setOpen(true)}
        feedback="wash"
        accessibilityRole="button"
        accessibilityLabel={JOB_WORDS.message.open}
        style={{
          minHeight: TARGET,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 14,
        }}
      >
        <MessageSquare size={15} color={theme.colors.ink2} strokeWidth={1.75} />
        <Text size={14.5} color={theme.colors.ink2}>
          {JOB_WORDS.message.open}
        </Text>
      </Touchable>
    );
  return (
    <View style={[PAD, { gap: 8 }]}>
      <TextInput
        autoFocus
        value={text}
        onChangeText={setText}
        multiline
        placeholder={JOB_WORDS.message.placeholder}
        placeholderTextColor={theme.colors.placeholder}
        accessibilityLabel={JOB_WORDS.message.open}
        selectionColor={theme.colors.brand}
        style={{
          minHeight: 64,
          paddingVertical: 10,
          paddingHorizontal: 12,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: theme.colors.line2,
          backgroundColor: theme.colors.bg,
          color: theme.colors.ink,
          fontSize: 15,
          textAlignVertical: 'top',
        }}
      />
      <View style={{ flexDirection: 'row', gap: 8 }} accessibilityRole="radiogroup">
        {(['steer', 'queue'] as const).map((m) => (
          <Touchable
            key={m}
            onPress={() => setMode(m)}
            feedback="fade"
            accessibilityRole="radio"
            accessibilityState={{ checked: mode === m }}
            accessibilityHint={m === 'steer' ? JOB_WORDS.message.nowHint : JOB_WORDS.message.nextHint}
            style={{
              flex: 1,
              minHeight: TARGET,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: theme.radii.button,
              borderWidth: 1,
              borderColor: mode === m ? theme.colors.ink2 : theme.colors.line2,
              backgroundColor: mode === m ? theme.colors.sel : 'transparent',
            }}
          >
            <Text size={14} weight={mode === m ? 600 : 400} color={theme.colors.ink}>
              {m === 'steer' ? JOB_WORDS.message.now : JOB_WORDS.message.next}
            </Text>
          </Touchable>
        ))}
      </View>
      <Text size={12.5} color={theme.colors.mut}>
        {mode === 'steer' ? JOB_WORDS.message.nowHint : JOB_WORDS.message.nextHint}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
        <Touchable
          onPress={() => {
            setOpen(false);
            setText('');
          }}
          feedback="wash"
          accessibilityRole="button"
          style={{ minHeight: TARGET, paddingHorizontal: 14, justifyContent: 'center' }}
        >
          <Text size={15} color={theme.colors.ink2}>
            {JOB_WORDS.message.close}
          </Text>
        </Touchable>
        <Touchable
          onPress={() => void submit()}
          disabled={!text.trim() || send.isPending}
          feedback="wash"
          accessibilityRole="button"
          accessibilityState={{ disabled: !text.trim() || send.isPending }}
          ringRadius={theme.radii.button}
          style={{
            minHeight: TARGET,
            paddingHorizontal: 16,
            justifyContent: 'center',
            borderRadius: theme.radii.button,
            backgroundColor: theme.colors.btn,
            opacity: !text.trim() || send.isPending ? 0.5 : 1,
          }}
        >
          <Text size={15} weight={600} color={theme.colors.btnfg}>
            {mode === 'steer' ? JOB_WORDS.message.now : JOB_WORDS.message.next}
          </Text>
        </Touchable>
      </View>
    </View>
  );
}

function Receipt({ handoff }: { handoff: Handoff }) {
  const theme = useTheme();
  const openUrl = useOpenUrl();
  const r = jobReceipt(handoff);
  if (!r) return null;
  const mark =
    r.tone === 'bad' ? theme.colors.bad : r.tone === 'quiet' ? theme.colors.mut : theme.colors.progress;
  return (
    <View style={PAD} testID="job-receipt">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: mark,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {r.tone === 'bad' ? (
            <X size={12} color={theme.colors.sf} strokeWidth={3} />
          ) : (
            <Check size={12} color={theme.colors.sf} strokeWidth={3} />
          )}
        </View>
        <Text size={16} weight={600} color={theme.colors.ink} accessibilityRole="header">
          {r.title}
        </Text>
      </View>
      {r.summary ? (
        <Text size={14.5} color={theme.colors.ink} style={{ marginTop: 6 }}>
          {r.summary}
        </Text>
      ) : null}
      <View style={{ gap: 4, marginTop: 8 }}>
        {r.lines.map((l) => {
          const color =
            l.tone === 'ok' ? theme.colors.okText : l.tone === 'bad' ? theme.colors.bad : theme.colors.ink2;
          const url = l.url;
          return url ? (
            <Touchable
              key={l.key}
              onPress={() => openUrl(url)}
              feedback="fade"
              accessibilityRole="link"
              style={{ minHeight: 32, justifyContent: 'center' }}
            >
              <Text size={14} color={color} style={{ textDecorationLine: 'underline' }}>
                {l.text}
              </Text>
            </Touchable>
          ) : (
            <Text key={l.key} size={l.key === 'model' ? 12.5 : 14} mono={l.key === 'model'} color={color}>
              {l.text}
            </Text>
          );
        })}
      </View>
      {r.screenshot ? (
        <Image
          source={{ uri: r.screenshot.url }}
          accessibilityLabel={r.screenshot.alt || JOB_WORDS.receipt.screenshot}
          style={{
            marginTop: 10,
            width: '100%',
            aspectRatio: 16 / 10,
            borderRadius: 10,
            borderWidth: 1,
            borderColor: theme.colors.line,
          }}
          resizeMode="cover"
        />
      ) : null}
      {/* A new run's answer starts folded again. */}
      <Answer key={`${handoff.id}:${handoff.endedAt}`} handoff={handoff} />
    </View>
  );
}

/**
 * T3 Code's whole answer, folded under the receipt until the person opens it, as a council member's on its row: read on
 * the phone without T3 Code, the rest there when the thread keeps only its start.
 */
function Answer({ handoff }: { handoff: Handoff }) {
  const theme = useTheme();
  const openUrl = useOpenUrl();
  const [open, setOpen] = useState(false);
  const answer = jobAnswer(handoff);
  if (!answer) return null;
  const url = answer.cut ? answer.url : null;
  const word = open ? JOB_WORDS.answer.hide : JOB_WORDS.answer.read;
  return (
    <View style={{ marginTop: 4 }} testID="job-answer">
      <Touchable
        onPress={() => setOpen((o) => !o)}
        feedback="wash"
        ringRadius={theme.radii.button}
        accessibilityRole="button"
        accessibilityLabel={word}
        accessibilityState={{ expanded: open }}
        style={{
          alignSelf: 'flex-start',
          minHeight: TARGET,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          marginHorizontal: -8,
          paddingHorizontal: 8,
          borderRadius: theme.radii.button,
        }}
      >
        <Text size={14} weight={600} color={theme.colors.ink2}>
          {word}
        </Text>
        {open ? (
          <ChevronUp size={16} color={theme.colors.mut} />
        ) : (
          <ChevronDown size={16} color={theme.colors.mut} />
        )}
      </Touchable>
      {open ? (
        <View
          style={{ gap: 2, paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: theme.colors.line }}
          testID="job-answer-text"
        >
          <RichText
            text={answer.text}
            color={theme.colors.ink2}
            accentColor={theme.colors.brand}
            codeBackground={theme.colors.sf2}
            size={14.5}
            lh={1.45}
            selectable
          />
          {url ? (
            <Touchable
              onPress={() => openUrl(url)}
              feedback="wash"
              ringRadius={theme.radii.button}
              accessibilityRole="link"
              accessibilityLabel={JOB_WORDS.answer.rest}
              style={{
                alignSelf: 'flex-start',
                minHeight: TARGET,
                justifyContent: 'center',
                marginHorizontal: -8,
                paddingHorizontal: 8,
                borderRadius: theme.radii.button,
              }}
            >
              <Text size={14} weight={600} color={theme.colors.brand}>
                {JOB_WORDS.answer.rest}
              </Text>
            </Touchable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
