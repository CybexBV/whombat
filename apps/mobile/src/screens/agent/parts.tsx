/**
 * The pieces every part of the assistant's page and of Advanced's own pages share (one-agent.md AP-4965): the part's
 * own scroll with pull to refresh, a quiet note in a card, and the save bar under a part with a draft (Keys). A part
 * tells the screen when it has unsaved changes, so leaving it asks first (`useUnsavedGuard`).
 */

import type { AgentProfile } from '@whombat/core';
import { type ReactNode, type Ref, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { mobileTranslator, useI18n, useMobileT } from '../../i18n';
import { useAppNavigation } from '../../navigation/hooks';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { bottomPadding } from '../../ui/insets';
import { Button } from '../../ui/primitives';

/** Leaving a part with unsaved changes (the web's save bar). */
export function leaveText(locale?: string | null) {
  const tr = mobileTranslator(locale);
  return {
    title: tr.t('screens2.agent.leaveTitle'),
    text: (name: string, part: string) =>
      tr.t('screens2.agent.leaveText', { name, part: part.toLowerCase() }),
    stay: tr.t('screens2.agent.stay'),
    discard: tr.t('screens2.agent.discard'),
  };
}

/**
 * Unsaved changes in the open part: leaving the screen asks first, and `confirm` asks before something else replaces
 * the part. `name` and `part` say whose changes and to what.
 */
export function useUnsavedGuard(name: string, part: string) {
  const { rawLocale } = useI18n();
  const leaveTextHere = leaveText(rawLocale);
  const navigation = useAppNavigation();
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const ask = useCallback(
    (onDiscard: () => void) =>
      Alert.alert(leaveTextHere.title, leaveTextHere.text(name, part), [
        { text: leaveTextHere.stay, style: 'cancel' },
        { text: leaveTextHere.discard, style: 'destructive', onPress: onDiscard },
      ]),
    [name, part, leaveTextHere.title, leaveTextHere.text, leaveTextHere.stay, leaveTextHere.discard],
  );
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (e) => {
        if (!dirtyRef.current) return;
        e.preventDefault();
        ask(() => navigation.dispatch(e.data.action));
      }),
    [navigation, ask],
  );
  /** Runs `next` now, or once the person agrees to drop what isn't saved. */
  const confirm = (next: () => void) => {
    if (!dirtyRef.current) return next();
    ask(() => {
      setDirty(false);
      next();
    });
  };
  const onDirtyChange = useCallback((d: boolean) => setDirty(d), []);
  /** Runs `next` (going back) without asking: what changed was just saved, or deleted. */
  const leave = (next: () => void) => {
    dirtyRef.current = false;
    setDirty(false);
    next();
  };
  return { confirm, onDirtyChange, leave, reset: () => setDirty(false) };
}

/** What every part gets. */
export interface PartProps {
  profile: AgentProfile;
  /** Reads the agent again (pull to refresh). */
  refetch: () => void;
  /** The part has unsaved changes (Keys, Workspace). */
  onDirtyChange: (dirty: boolean) => void;
}

/** A part's own scroll: its content, pull to refresh, the keyboard's taps kept. */
export function PartScroll({
  children,
  refreshing,
  onRefresh,
  scrollRef,
}: {
  children: ReactNode;
  refreshing: boolean;
  onRefresh: () => void;
  scrollRef?: Ref<ScrollView>;
}) {
  const theme = useTheme();
  return (
    <ScrollView
      ref={scrollRef}
      style={{ flex: 1 }}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: 14, paddingBottom: 28 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          colors={[theme.colors.ink]}
          progressBackgroundColor={theme.colors.sf}
        />
      }
    >
      {children}
    </ScrollView>
  );
}

/** A quiet line inside a card (or under one, `tone="bad"` for a refusal). */
export function Note({ children, tone }: { children: string; tone?: 'bad' }) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
      <Text
        size={13}
        lh={1.45}
        color={tone === 'bad' ? theme.colors.bad : theme.colors.mut}
        accessibilityLiveRegion={tone === 'bad' ? 'polite' : undefined}
      >
        {children}
      </Text>
    </View>
  );
}

/** Save and Discard under a part while something changed, with why the last save didn't go through. */
export function SaveBar({
  dirty,
  saving,
  notice,
  onSave,
  onDiscard,
}: {
  dirty: boolean;
  saving: boolean;
  notice: string | null;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const { tClient } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  if (!dirty && !notice) return null;
  return (
    <View
      style={{
        gap: 10,
        paddingTop: 14,
        paddingHorizontal: 22,
        paddingBottom: bottomPadding(36, insets.bottom, 14),
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
        backgroundColor: theme.colors.bg,
      }}
    >
      {notice ? (
        <Text size={13.5} lh={1.4} color={theme.colors.bad} accessibilityLiveRegion="polite">
          {notice}
        </Text>
      ) : null}
      {dirty ? (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button
            label={tMobile('screens.discard')}
            variant="secondary"
            size="lg"
            onPress={onDiscard}
            style={{ flex: 1 }}
          />
          <Button
            label={tClient('limit.save')}
            size="lg"
            onPress={onSave}
            busy={saving}
            style={{ flex: 1 }}
          />
        </View>
      ) : null}
    </View>
  );
}
