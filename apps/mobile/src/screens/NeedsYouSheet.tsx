/**
 * An Inbox item's sheet, or its page with two pages (`NeedsYouItemScreen`, docs/app/decisions/iphone-duo.md, and
 * where a push or a link about it lands): its group and thing as the badge, its words, what the assistant says by its
 * face, and every button of the shared list stacked (Whombat inbox.md IBX-03…IBX-07): the step it found (the press
 * is the go-ahead, `looks.fix`), *Ask {assistant} to fix it*, the server's own (Yes, do it · Tonight · No, Answer, Sign
 * in again…), *See it*, Settle (with Undo), then More's: *Ask {assistant} to handle it* (`looks.handle`), *Talk to
 * {assistant} about it* (a thread it opens with the item, `needsYou.discuss`, or its own thread once it looked into it),
 * Remind me tomorrow, Stop watching this; Bring it back on Later and Settled. A button runs with a spinner on it; a
 * decision takes the item out at once and puts it back if refused.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  askText,
  atText,
  handedOverThread,
  lookFixOutcomeText,
  NEEDS_YOU_WORDS,
  type NeedsYouButton,
  type NeedsYouIntent,
  needsYouButtonGoes,
  needsYouIntent,
  needsYouListIntent,
  needsYouListItems,
  needsYouListRow,
  needsYouSettledText,
  threadToOpen,
  withNeedsYouListItem,
} from '@whombat/client';
import { patchEndpoint, queryKeys } from '@whombat/client/query';
import {
  type HandleLookOutcome,
  handleLookOutcome,
  lookFixOutcome,
  useBringBackWatch,
  useDecideApproval,
  useDiscussNeedsYou,
  useFixLook,
  useHandleLook,
  useHomeOverview,
  useIgnoreNeedsYou,
  useSnoozeNeedsYou,
  useStartChat,
  useStopWatchingNeedsYou,
} from '@whombat/client/react';
import type { ChatSubject, HomeOverview, HomeRef, NeedsYouItem } from '@whombat/core';
import { APPROVAL_CARD_WORDS } from '@whombat/core/approvals';
import { formatClock } from '@whombat/core/text';
import { isBackupPasskeyHref } from '@whombat/protocol/session';
import { useCallback, useRef, useState } from 'react';
import { Alert, View } from 'react-native';
import { answerMayHaveGoneThrough } from '../data/approval';
import { useBurrowBase } from '../data/BurrowProvider';
import { startedChatRoute, threadRoute } from '../data/chatRoom';
import { NEEDS_YOU_TAB, type PhoneSheetButton, phoneSheet, sheetOffersButtons } from '../data/needsYou';
import { showToast } from '../data/toast';
import { useAgentWords } from '../data/useAgent';
import { useBackupPasskeyTap } from '../managed/backupPasskey';
import { navigateTo, openHref, useAppNavigation } from '../navigation/hooks';
import type { RootStackParamList, Route } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ApprovalFact, TonightBox } from '../ui/approvalFacts';
import { haptic } from '../ui/haptics';
import { LookSays } from '../ui/LookSays';
import { OneCardBody, type OneCardContent, OneCardPage, OneSheet } from '../ui/oneSheet';
import { ErrorState, QuietText, SkeletonRows } from '../ui/primitives';
import { whenSheetDown } from '../ui/sheet';
import { showFailure, showLookFix, showNotice, useDecisionFeedback } from './feedback';

/** Takes an item out of the list at once; the function it returns puts Home back as it was (a refusal). */
function useLeaveHome(): (ref: HomeRef) => () => void {
  const qc = useQueryClient();
  return useCallback(
    (ref: HomeRef) => {
      const snapshot = qc.getQueriesData({ queryKey: queryKeys.scope('home.overview') });
      patchEndpoint<HomeOverview>(qc, 'home.overview', (d) => withNeedsYouListItem(d, ref, 'gone'));
      return () => {
        for (const [key, data] of snapshot) qc.setQueryData(key, data);
      };
    },
    [qc],
  );
}

/**
 * Carries out one of the server's own buttons (`needsYouIntent`): approve, tonight, decline, open; resolves true when
 * the sheet may close.
 */
function useServerAction(): (item: NeedsYouItem, intent: NeedsYouIntent) => Promise<boolean> {
  const { slug, timeZone } = useBurrowBase();
  const qc = useQueryClient();
  const feedback = useDecisionFeedback();
  const decide = useDecideApproval(slug);
  const leave = useLeaveHome();
  const backupPasskey = useBackupPasskeyTap();
  const navigation = useAppNavigation();
  const words = useAgentWords();
  const start = useStartChat(slug);
  // “Your answer may have gone through”, and only asking the assistant to check (command-safety.md).
  const mayHaveGoneThrough = (title: string) =>
    Alert.alert(APPROVAL_CARD_WORDS.unknown, APPROVAL_CARD_WORDS.unknownBody, [
      { text: APPROVAL_CARD_WORDS.close, style: 'cancel' },
      {
        text: APPROVAL_CARD_WORDS.check(words.name),
        onPress: () =>
          void start
            .mutateAsync({ text: APPROVAL_CARD_WORDS.checkText(title) })
            .then((result) => {
              if (result.status === 'ok')
                navigateTo(navigation, startedChatRoute(result.data, NEEDS_YOU_TAB.title));
              else feedback.onResult(result);
            })
            .catch((error: unknown) => feedback.onError(error)),
      },
    ]);
  return async (item, intent) => {
    try {
      switch (intent.type) {
        case 'approve':
        case 'decline':
        case 'approveLater': {
          haptic('approve');
          const back = leave(item.ref);
          let result: Awaited<ReturnType<typeof decide.mutateAsync>>;
          try {
            result = await decide.mutateAsync({
              number: intent.number,
              decision: intent.type === 'decline' ? 'decline' : 'approve',
              ...(intent.type === 'approveLater' ? { executeAt: intent.executeAt } : {}),
            });
          } catch (error) {
            // It may have gone through: the item stays out until the Whombat says otherwise, and nothing resends it.
            if (answerMayHaveGoneThrough(error)) {
              mayHaveGoneThrough(item.title);
              return false;
            }
            back();
            throw error;
          } finally {
            void qc.invalidateQueries({ queryKey: queryKeys.scope('home.overview') });
          }
          if (result.status !== 'ok') {
            back();
            feedback.onResult(result);
            return false;
          }
          showNotice(
            intent.type === 'approveLater'
              ? `Approved. It runs at ${formatClock(intent.executeAt, timeZone)}.`
              : intent.type === 'decline'
                ? 'Declined.'
                : 'Approved. It runs now.',
          );
          return true;
        }
        case 'open':
          // Keep setup in place and leave the item open until its checks finish.
          if (backupPasskey && isBackupPasskeyHref(intent.href)) {
            const result = await backupPasskey();
            if (result.note) showNotice(result.note);
            return result.complete;
          }
          openHref(intent.href);
          return true;
        default:
          return true;
      }
    } catch (error) {
      feedback.onError(error);
      return false;
    }
  };
}

/**
 * Settle (inbox.md IBX-03): to Settled at once; on a line Whombat watches it comes back when it happens again (the
 * shared Ignore of its line, quiet-notices.md QN-21), anything else simply settles; both with Undo. Resolves true when
 * the sheet may close.
 */
export function useNeedsYouSettle(): (item: NeedsYouItem) => Promise<boolean> {
  const { slug } = useBurrowBase();
  const feedback = useDecisionFeedback();
  const settle = useIgnoreNeedsYou(slug);
  return async (item) => {
    try {
      const result = await settle.mutateAsync({ ref: item.ref, ignored: true });
      if (result.status !== 'ok') {
        feedback.onResult(result);
        return false;
      }
      haptic('success');
      showToast(needsYouSettledText(item.ref), {
        undo: () =>
          void settle.mutateAsync({ ref: item.ref, ignored: false }).then(
            (back) => {
              if (back.status !== 'ok') feedback.onResult(back);
            },
            (error: unknown) => feedback.onError(error),
          ),
      });
      return true;
    } catch (error) {
      feedback.onError(error);
      return false;
    }
  };
}

/**
 * Carries out a button of the shared list (`needsYouListIntent`); resolves true when the sheet may close. `open` shows
 * a thread it asked in or one to talk it over in.
 */
export function useNeedsYouPress(
  open?: (route: Route) => void,
): (item: NeedsYouItem, button: NeedsYouButton) => Promise<boolean> {
  const { slug, timeZone, clock } = useBurrowBase();
  const navigation = useAppNavigation();
  const feedback = useDecisionFeedback();
  const words = useAgentWords();
  const server = useServerAction();
  const settle = useNeedsYouSettle();
  const snooze = useSnoozeNeedsYou(slug);
  const back = useBringBackWatch(slug);
  const stopWatching = useStopWatchingNeedsYou(slug);
  const start = useStartChat(slug);
  const discuss = useDiscussNeedsYou(slug);
  const handle = useHandleLook(slug);
  const backupPasskey = useBackupPasskeyTap();
  const fix = useFixLook(slug, (outcome) => {
    const text = lookFixOutcomeText(outcome);
    if (text) showLookFix(outcome, text);
  });
  const show = (route: Route) => (open ? open(route) : navigateTo(navigation, route));
  // Handed over: the thread the work happens in (backup-places.md BPL-15); true when it opened.
  const showThread = (href: string | null): boolean => {
    const route = threadRoute(threadToOpen(href), NEEDS_YOU_TAB.title);
    if (route) show(route);
    return route !== null;
  };
  // A question in the thing's own thread (a new one when it has none), then that thread.
  const ask = async (text: string, subject: ChatSubject | null): Promise<boolean> => {
    const result = await start.mutateAsync({ text, subject, reuseThread: true });
    if (result.status !== 'ok') {
      feedback.onResult(result);
      return false;
    }
    show(startedChatRoute(result.data, NEEDS_YOU_TAB.title));
    return true;
  };
  return async (item, button) => {
    const now = clock();
    const intent = needsYouListIntent(item, button, now, timeZone);
    if (!intent) return true;
    try {
      switch (intent.type) {
        case 'fix': {
          if (!item.research) return false;
          haptic('approve');
          const answer = await fix.mutateAsync(item.research);
          if (lookFixOutcome(answer) !== 'ok') return false;
          showThread(answer.status === 'ok' ? handedOverThread(answer.data) : null);
          return true;
        }
        case 'ask':
          return ask(intent.text, intent.subject);
        case 'handle': {
          // The assistant takes on everything on that thing and the row moves to its group; nothing to look into (or
          // an older Whombat): the question in the thing's thread.
          haptic('approve');
          let outcome: HandleLookOutcome;
          let thread: string | null = null;
          try {
            const answer = await handle.mutateAsync(intent.key);
            outcome = handleLookOutcome(answer);
            if (answer.status === 'ok') thread = handedOverThread(answer.data);
          } catch (error) {
            outcome = handleLookOutcome(null, error);
          }
          if (outcome === 'ask') return ask(intent.text, intent.subject);
          if (outcome === 'ok' && showThread(thread)) return true;
          if (outcome === 'ok') showNotice(NEEDS_YOU_WORDS.handling(words));
          else showFailure(NEEDS_YOU_WORDS.failed);
          return outcome === 'ok';
        }
        case 'talk': {
          try {
            const result = await discuss.mutateAsync({ ref: intent.ref });
            if (result.status !== 'ok') {
              feedback.onResult(result);
              return false;
            }
            show(startedChatRoute(result.data, NEEDS_YOU_TAB.title));
            return true;
          } catch (error) {
            // An older Whombat, or an item that just left: the question in the thing's thread instead.
            if (error instanceof ApiError && error.status === 404)
              return ask(askText(item), item.subject ?? null);
            throw error;
          }
        }
        case 'open': {
          // Keep setup in place and leave the item open until its checks finish.
          if (backupPasskey && isBackupPasskeyHref(intent.href)) {
            const result = await backupPasskey();
            if (result.note) showNotice(result.note);
            return result.complete;
          }
          // A thread (Talk once it looked into it) opens as the others do: in the item's place, after its sheet.
          const thread = threadRoute(intent.href, NEEDS_YOU_TAB.title);
          if (thread) show(thread);
          else openHref(intent.href);
          return true;
        }
        case 'action':
          return server(item, needsYouIntent(item, intent.action, now, timeZone));
        case 'settle':
          return settle(item);
        case 'snooze': {
          const result = await snooze.mutateAsync({ ref: intent.ref, until: intent.until });
          if (result.status !== 'ok') {
            feedback.onResult(result);
            return false;
          }
          showNotice(`I’ll remind you ${atText(intent.until, now, timeZone)}.`);
          return true;
        }
        case 'back': {
          const result = await back.mutateAsync({ ref: intent.ref });
          if (result.status !== 'ok') {
            feedback.onResult(result);
            return false;
          }
          showNotice(NEEDS_YOU_WORDS.backDone);
          return true;
        }
        case 'stop': {
          // Set up so on purpose: the check behind it off until they turn it on again, with Undo (on-purpose.md).
          const { watch } = intent;
          const result = await stopWatching.mutateAsync({ ref: item.ref, watch, watched: false });
          if (result.status !== 'ok') {
            feedback.onResult(result);
            return false;
          }
          haptic('approve');
          showToast(NEEDS_YOU_WORDS.stopped(watch.name), {
            undo: () =>
              void stopWatching.mutateAsync({ ref: item.ref, watch, watched: true }).then(
                (back) => {
                  if (back.status !== 'ok') feedback.onResult(back);
                },
                (error: unknown) => feedback.onError(error),
              ),
          });
          return true;
        }
      }
    } catch (error) {
      feedback.onError(error);
      return false;
    }
  };
}

/**
 * The item's sheet over the list. A thread or page a button opens waits until the sheet is down (and at most a moment):
 * iOS shows no new screen under a sheet it still shows, and the person would land back on the Inbox.
 */
export function NeedsYouSheet({ item, onClose }: { item: NeedsYouItem | null; onClose: () => void }) {
  const navigation = useAppNavigation();
  const next = useRef<Route | null>(null);
  const go = () => {
    const route = next.current;
    next.current = null;
    if (route) navigateTo(navigation, route);
  };
  const card = useNeedsYouCard(
    item,
    (route) => {
      next.current = route;
      onClose();
      whenSheetDown(go);
    },
    onClose,
  );
  if (!card) return <OneSheet visible={false} onClose={onClose} onDismissed={go} title="" buttons={[]} />;
  return <OneSheet visible onClose={card.busy ? () => {} : onClose} onDismissed={go} {...card} />;
}

type ItemProps = NativeStackScreenProps<RootStackParamList, 'NeedsYouItem'>;

/**
 * A Needs you item as a page: on the right page with two pages, where its row opens it instead of the sheet, and where
 * a push or a link about it lands (NYL-09). A thread it asks in or a page it opens takes its place; the other buttons
 * close it once done.
 */
export function NeedsYouItemScreen({ route, navigation }: ItemProps) {
  const { slug } = useBurrowBase();
  const home = useHomeOverview({ params: { burrow: slug } });
  const found = home.data
    ? (needsYouListItems(home.data).find((i) => i.id === route.params.itemId) ?? null)
    : null;
  // A decision takes the item out at once; the page keeps showing it until the request is done.
  const kept = useRef(found);
  if (found) kept.current = found;
  const close = () =>
    navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs', { screen: 'NeedsYou' });
  const card = useNeedsYouCard(
    kept.current,
    (next) => (navigation.replace as (name: string, params: unknown) => void)(next.name, next.params),
    // A button that goes to a thread or a page has replaced this page with it; only the others close it (BPL-15).
    (b) => {
      if (needsYouButtonGoes(b.button) === 'stay') close();
    },
  );
  return (
    <OneCardPage back={route.params.back ?? NEEDS_YOU_TAB.title} onBack={close}>
      {card && (found || card.busy) ? (
        <OneCardBody {...card} />
      ) : home.isPending ? (
        <SkeletonRows count={2} lines={2} label={NEEDS_YOU_TAB.loading} />
      ) : !home.data ? (
        <ErrorState text={NEEDS_YOU_TAB.failed} onRetry={() => void home.refetch()} />
      ) : (
        <QuietText>{NEEDS_YOU_WORDS.gone}</QuietText>
      )}
    </OneCardPage>
  );
}

/**
 * An item's sheet or page: its badge, words, what the assistant says and its buttons. A button runs with a spinner on
 * it; `open` shows a thread it asked in, `onDone` follows a button that went through.
 */
function useNeedsYouCard(
  item: NeedsYouItem | null,
  open: ((route: Route) => void) | undefined,
  onDone: (button: PhoneSheetButton) => void,
): OneCardContent | null {
  const theme = useTheme();
  const { slug, timeZone, clock } = useBurrowBase();
  const home = useHomeOverview({ params: { burrow: slug } }, { retry: false });
  const press = useNeedsYouPress(open);
  const passkey = useBackupPasskeyTap();
  const words = useAgentWords();
  const [busy, setBusy] = useState<string | null>(null);
  if (!item) return null;
  const row = needsYouListRow(item, {
    now: clock(),
    timeZone,
    assistant: words.name,
    things: home.data?.things ?? [],
  });
  const view = phoneSheet(row, words, { now: clock().getTime(), timeZone });
  const isPasskey = (b: PhoneSheetButton) => {
    const target =
      b.button.kind === 'see' ? item.href : b.button.action?.kind === 'open' ? b.button.action.href : null;
    return !!target && isBackupPasskeyHref(target);
  };
  const passkeyHere = view.buttons.some(isPasskey);
  const offers = sheetOffersButtons(
    item.id,
    home.data ? needsYouListItems(home.data) : undefined,
    busy !== null,
  );
  return {
    badge: view.badge,
    tone: view.tone,
    title: passkeyHere ? (passkey?.view?.title ?? view.title) : view.title,
    // Under the title of a finding: since when, then the assistant's words by its face, as the mock's card.
    body: view.says ? null : view.body,
    // An approval's card facts before its answers: the permission and the exact moment Yes, tonight means.
    children: view.approval ? (
      <View style={{ gap: 14, marginTop: 12 }}>
        <ApprovalFact label={APPROVAL_CARD_WORDS.permission}>{view.approval.permission}</ApprovalFact>
        {view.approval.tonight ? <TonightBox tonight={view.approval.tonight} /> : null}
      </View>
    ) : view.says ? (
      <>
        {view.since ? (
          <Text size={13} color={theme.colors.mut} style={{ marginTop: 6 }}>
            {view.since}
          </Text>
        ) : null}
        {view.body ? (
          <Text size={15.5} lh={1.5} color={theme.colors.ink2} style={{ marginTop: 8 }}>
            {view.body}
          </Text>
        ) : null}
        <View style={{ marginTop: 12 }}>
          <LookSays view={view.says} size={24} textSize={15.5} />
        </View>
      </>
    ) : null,
    busy,
    note: !offers ? NEEDS_YOU_WORDS.gone : passkeyHere && passkey?.note ? passkey.note : view.note,
    linksInRow: view.linksInRow,
    buttons: (offers ? view.buttons : []).map((b) => ({
      id: b.id,
      label: isPasskey(b) && passkey ? passkey.label : b.label,
      variant: b.variant,
      onPress: () => {
        setBusy(b.id);
        void press(item, b.button).then((done) => {
          setBusy(null);
          if (done) onDone(b);
        });
      },
    })),
  };
}
