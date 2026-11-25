/**
 * Approval detail, the one approval card on the phone (approval-card.md): “‹ Inbox”, then the one who asks (a 64dp face)
 * beside the state (“Neo needs your OK”, NEEDS A PERSON) and who, where and when; the question (24/700); for an everyday
 * ask its facts before any answer — what happens, the permission it uses (or “Not supplied in this request”), what it
 * still waits for and the exact moment Yes, tonight means — and Details folding its tool, target and lasting yes; the
 * conditions of code, a command's why and exact command, an email's whole body (IN-16). All of it scrolls in one region
 * above a separate answer bar that never covers it, holding only the one-time answers in the card's order and all of
 * equal weight: Yes, now · Yes, tonight · No (Yes, do it · No without a later time), code's Decline / Approve, a
 * command's scopes stacked (agent-computer.md AC-42), Undo once decided; the assistant's draft report adds Edit, which
 * opens the form with it (team-reports.md). The lasting yes asks first in the platform's own alert, naming where it
 * changes back. An answer whose outcome is unknown says it may have gone through and offers only to ask the assistant
 * to check (command-safety.md). Above a font scale of 1.3 the answers stack and wrap. An automation asking
 * (automation-recipes.md AP-999) shows its mark instead of a wombat.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { NEEDS_YOU_WORDS, nextAt, TEAM_REPORT_WORDS } from '@whombat/client';
import {
  useApproval,
  useChangeWindow,
  useDecideApproval,
  useStartChat,
  useUndoApproval,
} from '@whombat/client/react';
import { type ApprovalLastingWords, type CommandScope, formatClock } from '@whombat/core';
import { APPROVAL_CARD_WORDS } from '@whombat/core/approvals';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AutomationAvatar, WhombatAvatar } from '../avatars/Avatars';
import { answerMayHaveGoneThrough, approvalScreen, scopedApproveToast } from '../data/approval';
import { useBurrow, useViewContext } from '../data/BurrowProvider';
import { startedChatRoute } from '../data/chatRoom';
import { whereOf } from '../data/people';
import { OVERVIEW_TITLE } from '../data/shell';
import { useAgentWords } from '../data/useAgent';
import { navigateTo } from '../navigation/hooks';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ApprovalFact, TonightBox } from '../ui/approvalFacts';
import { haptic } from '../ui/haptics';
import { BackBar, Screen } from '../ui/headers';
import { bottomPadding } from '../ui/insets';
import { useLargeText } from '../ui/largeText';
import { Button, Skeleton, SkeletonRows, toneColor } from '../ui/primitives';
import { ReadNotice, ReadState, readErrorText, TARGET } from '../ui/readState';
import { Touchable } from '../ui/Touchable';
import { showNotice, useDecisionFeedback } from './feedback';

type Props = NativeStackScreenProps<RootStackParamList, 'Approval'>;

export function ApprovalScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { slug, bootstrap } = useBurrow();
  const ctx = useViewContext();
  const { number, back = OVERVIEW_TITLE } = route.params;
  const query = useApproval({ params: { burrow: slug, number } });
  const feedback = useDecisionFeedback();
  const words = useAgentWords();
  // An answer that may have gone through is never offered again: only asking the assistant to check.
  const [unknown, setUnknown] = useState(false);
  const decide = useDecideApproval(slug, {
    onSuccess: feedback.onResult,
    onError: (error) => (answerMayHaveGoneThrough(error) ? setUnknown(true) : feedback.onError(error)),
  });
  const start = useStartChat(slug);
  const undo = useUndoApproval(slug, { onSuccess: feedback.onResult, onError: feedback.onError });
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  // Yes, tonight runs when the Whombat's quiet hours for changes start (care-plan.md), as on the web.
  const quiet = useChangeWindow(slug);
  const large = useLargeText();

  const approval = query.data?.approval;

  if (!approval) {
    const notFound = query.error && 'status' in query.error && query.error.status === 404;
    return (
      <Screen>
        <BackBar label={back} onPress={goBack} />
        {notFound ? (
          <ReadState
            title={APPROVAL_CARD_WORDS.empty}
            body={APPROVAL_CARD_WORDS.emptyBody}
            action={{
              label: APPROVAL_CARD_WORDS.openInbox,
              onPress: () => navigation.navigate('Tabs', { screen: 'NeedsYou' }),
            }}
          />
        ) : query.error ? (
          <ReadState
            problem
            title={APPROVAL_CARD_WORDS.failed}
            body={APPROVAL_CARD_WORDS.noSaved}
            action={{ label: APPROVAL_CARD_WORDS.retry, onPress: () => void query.refetch() }}
            detail={{ label: APPROVAL_CARD_WORDS.moreDetail, text: readErrorText(query.error) }}
          />
        ) : (
          <View style={{ paddingTop: 10 }} accessibilityLabel={APPROVAL_CARD_WORDS.loading}>
            <View style={{ gap: 12, paddingHorizontal: 22, paddingBottom: 22 }}>
              <Text size={15.5} color={theme.colors.ink2} accessibilityLiveRegion="polite">
                {APPROVAL_CARD_WORDS.loading}
              </Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <Skeleton width={64} height={64} radius={32} />
                <Skeleton width={140} height={13} />
              </View>
              <Skeleton width={260} height={24} />
            </View>
            <SkeletonRows count={3} lines={1} label={APPROVAL_CARD_WORDS.loading} />
          </View>
        )}
      </Screen>
    );
  }

  const where = whereOf(bootstrap, approval.conversationId);
  const tonight = nextAt(ctx.now, ctx.timeZone, quiet.start);
  const model = approvalScreen(approval, ctx, where, tonight);
  const choose = model.footer.kind === 'choose' ? model.footer : null;
  const pending = approval.state === 'pending';
  // A refresh that failed keeps the saved details in view, and asks for a read before offering answers again.
  const stale = Boolean(query.error) && !query.isRefetching;
  const showUnknown = unknown && pending;
  const footerKind = showUnknown ? 'unknown' : stale && pending ? 'stale' : model.footer.kind;
  const askToCheck = async () => {
    const result = await start
      .mutateAsync({ text: APPROVAL_CARD_WORDS.checkText(model.question) })
      .catch(() => null);
    if (result?.status === 'ok') navigateTo(navigation as never, startedChatRoute(result.data, back));
    else feedback.onText(NEEDS_YOU_WORDS.failed);
  };
  const answers = model.footer.kind === 'answers' ? model.footer : null;
  const editDraft = model.editDraft;
  // A command's yes goes as far as the button said (AC-42), and the note says so: “Allowed for this task. …”.
  const allow = (scope: CommandScope) => {
    haptic('approve');
    decide.mutate(
      { number, decision: 'approve', scope },
      {
        onSuccess: (result) => {
          if (result.status === 'ok') showNotice(scopedApproveToast(approval, scope, ctx, where));
        },
      },
    );
  };
  const answer = (id: 'now' | 'later' | 'no') => {
    if (id === 'no') {
      decide.mutate({ number, decision: 'decline' });
      return;
    }
    haptic('approve');
    if (id === 'now') {
      decide.mutate({ number, decision: 'approve' });
      return;
    }
    const executeAt = nextAt(Date.now(), ctx.timeZone, quiet.start);
    decide.mutate(
      { number, decision: 'approve', executeAt },
      {
        onSuccess: (result) => {
          if (result.status === 'ok')
            showNotice(`Approved. It runs at ${formatClock(executeAt, ctx.timeZone)}.`);
        },
      },
    );
  };
  // The lasting yes asks first in the platform's own alert; Keep asking changes nothing.
  const confirmLasting = (words: ApprovalLastingWords) =>
    Alert.alert(words.title, words.body, [
      { text: words.keep, style: 'cancel' },
      { text: words.confirm, onPress: () => allow('agent') },
    ]);
  const lastingLink =
    model.lasting && pending ? (
      <Touchable
        onPress={() => model.lasting && confirmLasting(model.lasting)}
        disabled={decide.isPending}
        feedback="wash"
        accessibilityRole="button"
        accessibilityHint="Asks before it stops asking"
        ringRadius={10}
        style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', borderRadius: 10 }}
      >
        <Text size={15} weight={500} color={theme.colors.mut}>
          {model.lasting.link}
        </Text>
      </Touchable>
    ) : null;
  const footerStyle = {
    flexDirection: 'row' as const,
    gap: 10,
    paddingTop: 14,
    paddingHorizontal: 22,
    paddingBottom: bottomPadding(36, insets.bottom, 14),
    borderTopWidth: 1,
    borderTopColor: theme.colors.line,
    backgroundColor: theme.colors.bg,
  };

  return (
    <Screen>
      <BackBar label={back} onPress={goBack} />
      <ScrollView
        style={{ flex: 1 }}
        accessibilityLabel={APPROVAL_CARD_WORDS.contentLabel}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => void query.refetch()}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
        contentContainerStyle={{
          gap: 22,
          paddingTop: 4,
          paddingHorizontal: 22,
          // Without a footer (a decided Vault use) the content clears the gesture area itself.
          paddingBottom: footerKind === 'none' ? 20 + insets.bottom : 20,
        }}
      >
        {stale ? (
          <ReadNotice title={APPROVAL_CARD_WORDS.failedRefresh} body={APPROVAL_CARD_WORDS.saved}>
            <Button
              label={APPROVAL_CARD_WORDS.retry}
              variant="secondary"
              onPress={() => void query.refetch()}
              style={{ alignSelf: 'flex-start', minHeight: TARGET }}
            />
          </ReadNotice>
        ) : null}
        <View style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            {model.automation ? (
              <AutomationAvatar size={64} label={model.automation.label} />
            ) : model.requesterFace ? (
              <WhombatAvatar face={model.requesterFace} size={64} label={model.requesterName} />
            ) : null}
            <View style={{ flex: 1, gap: 4 }}>
              <Text
                size={12}
                weight={500}
                mono
                tracking={0.05}
                // Waiting reads in the status words' warn, which passes on paper (ui-refresh-status.md).
                color={model.tone === 'warn' ? theme.colors.warnText : toneColor(theme, model.tone)}
                accessibilityLiveRegion="polite"
              >
                {model.label}
              </Text>
              <Text size={13.5} color={theme.colors.ink2}>
                {model.context}
              </Text>
            </View>
          </View>
          <Text size={24} weight={700} lh={1.2} tracking={-0.02} accessibilityRole="header">
            {model.question}
          </Text>
          {/* What a yes does, before anything else: the person decides by it. */}
          {model.message ? (
            <Text size={15.5} lh={1.5} color={theme.colors.ink2}>
              {model.message}
            </Text>
          ) : null}
          {model.target ? (
            <Text size={12} mono color={theme.colors.mut}>
              {model.target}
            </Text>
          ) : null}
        </View>

        {/* An everyday ask's facts, all before its answers: what happens, the permission, what it waits for, tonight. */}
        {model.facts ? (
          <View style={{ gap: 16 }}>
            {model.facts.happens.map((line) => (
              <Text key={line} size={15.5} lh={1.5} color={theme.colors.ink2}>
                {line}
              </Text>
            ))}
            <ApprovalFact label={model.facts.permission.label}>
              <Text size={15.5} lh={1.5} color={theme.colors.ink2}>
                {model.facts.permission.text}
              </Text>
            </ApprovalFact>
            {model.facts.unmet.length ? (
              <ApprovalFact label={model.facts.unmetLabel}>
                {model.facts.unmet.map((u) => (
                  <Text key={u.id} size={15.5} lh={1.5} color={theme.colors.ink2}>
                    {u.note ? `${u.label} · ${u.note}` : u.label}
                  </Text>
                ))}
              </ApprovalFact>
            ) : null}
            {model.facts.tonight ? <TonightBox tonight={model.facts.tonight} /> : null}
          </View>
        ) : null}

        {/* What the agent needs the command for, in its words: the person decides by it. */}
        {model.why ? (
          <View style={{ gap: 8 }}>
            <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
              WHY
            </Text>
            <Text size={15.5} lh={1.5}>
              {model.why}
            </Text>
          </View>
        ) : null}

        {model.conditions.length ? (
          <View
            accessibilityLabel="Conditions"
            style={{
              borderRadius: 18,
              backgroundColor: theme.colors.sf,
              borderWidth: 1,
              borderColor: theme.colors.line,
              paddingVertical: 4,
              paddingHorizontal: 16,
            }}
          >
            {model.conditions.map((c, i) => (
              <View
                key={c.id}
                accessible
                accessibilityLabel={`${c.label}: ${c.met ? 'met' : 'not yet'}, ${c.note}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingVertical: 13,
                  borderBottomWidth: i < model.conditions.length - 1 ? 1 : 0,
                  borderBottomColor: theme.colors.line,
                }}
              >
                <View style={{ width: 22, alignItems: 'flex-start' }}>
                  <View
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 10,
                      borderWidth: 2,
                      borderColor: c.met ? theme.colors.ok : theme.colors.line2,
                      backgroundColor: c.met ? theme.colors.ok : 'transparent',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {c.met ? (
                      <Text size={11} color={theme.colors.onSolid} style={{ lineHeight: 12 }}>
                        ✓
                      </Text>
                    ) : null}
                  </View>
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text size={15.5}>{c.label}</Text>
                  <Text size={12} mono color={theme.colors.mut}>
                    {c.note}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {model.content?.mono ? (
          <View style={{ gap: 8 }}>
            <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
              {model.content.label}
            </Text>
            {/* The exact command, wrapped (never wider than the screen) and selectable to copy. */}
            <View
              accessible
              accessibilityLabel={`The command: ${model.content.text}`}
              style={{
                borderRadius: 14,
                backgroundColor: theme.colors.code,
                paddingVertical: 12,
                paddingHorizontal: 14,
              }}
            >
              <Text size={12.5} lh={1.55} mono color={theme.code.text} selectable>
                {model.content.text}
              </Text>
            </View>
          </View>
        ) : model.content ? (
          <View style={{ gap: 8 }}>
            <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
              {model.content.label}
            </Text>
            <View
              accessible
              accessibilityLabel={`The whole message: ${model.content.text}`}
              style={{
                borderRadius: 18,
                backgroundColor: theme.colors.sf,
                borderWidth: 1,
                borderColor: theme.colors.line,
                paddingVertical: 14,
                paddingHorizontal: 16,
              }}
            >
              <Text size={15} lh={1.5}>
                {model.content.text}
              </Text>
            </View>
          </View>
        ) : null}

        {model.technical ? (
          <Details label={model.technical.label}>
            <Text size={12} mono color={theme.colors.mut} selectable>
              {model.technical.text}
            </Text>
            {lastingLink}
          </Details>
        ) : model.lasting ? (
          <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.line, paddingTop: 6 }}>
            {lastingLink}
          </View>
        ) : null}
      </ScrollView>

      {footerKind === 'unknown' ? (
        <View
          accessibilityLabel={APPROVAL_CARD_WORDS.answersLabel}
          style={{ ...footerStyle, flexDirection: 'column', gap: 12 }}
        >
          <View accessibilityLiveRegion="polite" style={{ gap: 6 }}>
            <Text size={19} weight={600} lh={1.3} color={theme.colors.warnText} accessibilityRole="header">
              {APPROVAL_CARD_WORDS.unknown}
            </Text>
            <Text size={15} lh={1.5} color={theme.colors.ink2}>
              {APPROVAL_CARD_WORDS.unknownBody}
            </Text>
          </View>
          <Button
            label={APPROVAL_CARD_WORDS.check(words.name)}
            variant="secondary"
            size="lg"
            wrap
            busy={start.isPending}
            onPress={() => void askToCheck()}
          />
        </View>
      ) : footerKind === 'stale' ? null : model.footer.kind === 'answers' ? (
        // The answers stacked full width, each the same outlined button in the card's order: none looks recommended.
        <View
          accessibilityLabel={APPROVAL_CARD_WORDS.answersLabel}
          style={{ ...footerStyle, flexDirection: 'column' }}
        >
          {model.footer.answers.map((a) => (
            <Button
              key={a.id}
              label={a.label}
              variant="secondary"
              size="lg"
              wrap={large}
              disabled={decide.isPending || (a.id === 'no' ? !answers?.canDecline : !answers?.canApprove)}
              onPress={() => answer(a.id)}
            />
          ))}
          {editDraft ? (
            // The assistant's draft report: the form takes the card's place, so back returns where it was opened.
            <Button
              label={TEAM_REPORT_WORDS.edit}
              variant="secondary"
              size="lg"
              wrap={large}
              disabled={decide.isPending}
              accessibilityHint="Opens the report form with this draft"
              onPress={() => navigation.replace('TeamReportNew', { draftId: editDraft, back })}
            />
          ) : null}
        </View>
      ) : model.footer.kind === 'decide' ? (
        // Approve first, Decline after it, as on the card; the same outlined style, so neither looks recommended.
        <View style={{ ...footerStyle, flexDirection: large ? 'column' : 'row' }}>
          <Button
            label={model.footer.approveLabel}
            variant="secondary"
            size="lg"
            wrap={large}
            disabled={!model.footer.canApprove || decide.isPending}
            onPress={() => {
              haptic('approve');
              decide.mutate({ number, decision: 'approve' });
            }}
            style={large ? undefined : { flex: model.footer.approveWide ? 2.4 : 1.4 }}
          />
          <Button
            label={model.footer.declineLabel}
            variant="secondary"
            size="lg"
            wrap={large}
            disabled={!model.footer.canDecline || decide.isPending}
            onPress={() => decide.mutate({ number, decision: 'decline' })}
            style={large ? undefined : { flex: 1 }}
          />
        </View>
      ) : choose ? (
        <View style={{ ...footerStyle, flexDirection: 'column' }}>
          {/* Allow once · Allow for this task · Always allow · Don’t allow, as on the card, all of the same weight. */}
          {choose.choices.map((c) => (
            <Button
              key={c.scope}
              label={c.label}
              variant="secondary"
              size="lg"
              wrap={large}
              disabled={!choose.canApprove || decide.isPending}
              onPress={() => allow(c.scope)}
            />
          ))}
          <Button
            label={choose.declineLabel}
            variant="secondary"
            size="lg"
            wrap={large}
            disabled={!choose.canDecline || decide.isPending}
            onPress={() => decide.mutate({ number, decision: 'decline' })}
          />
        </View>
      ) : model.footer.kind === 'undo' ? (
        <View style={footerStyle}>
          <Button
            label="Undo"
            variant="quiet"
            size="lg"
            disabled={!model.footer.canUndo}
            accessibilityHint="Returns the request to waiting for a person"
            onPress={() => undo.mutate({ number })}
            style={{ flex: 1 }}
          />
        </View>
      ) : null}
    </Screen>
  );
}

/** An everyday ask's Details, folded: its tool and target and the lasting yes; the person decides by the facts above. */
function Details({ label, children }: { label: string; children: ReactNode }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Touchable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        feedback="wash"
        ringRadius={10}
        style={{ minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start', borderRadius: 10 }}
      >
        <Text size={13} color={theme.colors.ink2}>
          {open ? '▾' : '›'} {label}
        </Text>
      </Touchable>
      {open ? (
        <View style={{ gap: 10, borderTopWidth: 1, borderTopColor: theme.colors.line, paddingTop: 12 }}>
          {children}
        </View>
      ) : null}
    </View>
  );
}
