/**
 * The one-Whombat shell's sheet (mock 4 right, the approval sheet; one-whombat-mobile.md AP-1353): over a dimmed screen,
 * on the raised surface, a tone badge (“Needs you · pve-02”), the title (22/700), the body (15.5/1.5 `ink2`), anything
 * else the caller puts there, then the big buttons stacked (10dp apart). Needs you, Watch and a guest's power use it.
 */
import type { HomeSeverity } from '@whombat/core';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BigButton, type BigButtonVariant, ToneBadge } from './assistant';
import { BackBar, Screen } from './headers';
import { Sheet } from './sheet';
import { Touchable } from './Touchable';

export interface OneSheetButton {
  id: string;
  label: string;
  variant: BigButtonVariant;
  onPress: () => void;
  disabled?: boolean;
}

/** What a sheet shows: a tone badge, the title, the body, anything else, its buttons and a note under them. */
export interface OneCardContent {
  badge?: string | null;
  tone?: HomeSeverity | 'ok' | 'mut';
  title: string;
  body?: string | null;
  children?: ReactNode;
  buttons: readonly OneSheetButton[];
  /** The button whose request is on its way (a spinner, the others wait). */
  busy?: string | null;
  /** A quiet line under the buttons (why there are none, what happened). */
  note?: string | null;
  /** The quiet buttons sit side by side under the others (an approval's Talk and Remind me tomorrow). */
  linksInRow?: boolean;
}

export function OneSheet({
  visible,
  onClose,
  onDismissed,
  ...content
}: OneCardContent & {
  visible: boolean;
  onClose: () => void;
  /** Once it is down (a screen it opens waits for that). */
  onDismissed?: () => void;
}) {
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      label={content.title}
      surface="sf"
      maxHeight="90%"
      {...(onDismissed ? { onDismissed } : {})}
    >
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 6 }}
        keyboardShouldPersistTaps="handled"
      >
        <OneCardBody {...content} />
      </ScrollView>
    </Sheet>
  );
}

/**
 * The sheet's content without the sheet: with two pages a Needs you or Watch item shows on the right page instead of
 * over the list (docs/app/decisions/iphone-duo.md).
 */
export function OneCardBody({
  badge,
  tone,
  title,
  body,
  children,
  buttons,
  busy = null,
  note,
  linksInRow = false,
}: OneCardContent) {
  const theme = useTheme();
  const links = buttons.filter((b) => b.variant === 'quiet');
  const button = (b: OneSheetButton) => (
    <BigButton
      key={b.id}
      label={b.label}
      variant={b.variant}
      onPress={b.onPress}
      busy={busy === b.id}
      disabled={b.disabled || (busy !== null && busy !== b.id)}
    />
  );
  return (
    <>
      {badge ? <ToneBadge text={badge} tone={tone ?? 'mut'} /> : null}
      <Text
        size={22}
        weight={700}
        lh={1.2}
        tracking={-0.01}
        accessibilityRole="header"
        style={{ marginTop: badge ? 12 : 0 }}
      >
        {title}
      </Text>
      {body ? (
        <Text size={15.5} lh={1.5} color={theme.colors.ink2} style={{ marginTop: 8 }}>
          {body}
        </Text>
      ) : null}
      {children}
      {buttons.length ? (
        <View style={{ gap: 10, marginTop: 18 }}>
          {(linksInRow ? buttons.filter((b) => b.variant !== 'quiet') : buttons).map(button)}
          {linksInRow && links.length ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', columnGap: 4 }}>
              {links.map((b) => (
                <Touchable
                  key={b.id}
                  onPress={b.onPress}
                  disabled={b.disabled || busy !== null}
                  feedback="wash"
                  ringRadius={10}
                  accessibilityLabel={b.label}
                  accessibilityState={{ busy: busy === b.id }}
                  style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 8, borderRadius: 10 }}
                >
                  <Text size={14.5} weight={500} color={theme.colors.mut}>
                    {b.label}
                  </Text>
                </Touchable>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {note ? (
        <Text size={13.5} lh={1.45} color={theme.colors.mut} style={{ marginTop: 14, textAlign: 'center' }}>
          {note}
        </Text>
      ) : null}
    </>
  );
}

/**
 * A Needs you or Watch item as a page, on the right page with two pages: “✕ Close” (“‹ Watch” once folded) over the
 * sheet's content, or what the caller says while it loads or once it is gone.
 */
export function OneCardPage({
  back,
  onBack,
  children,
}: {
  back: string;
  onBack: () => void;
  children: ReactNode;
}) {
  return (
    <Screen>
      <BackBar label={back} onPress={onBack} />
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 6, paddingBottom: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
    </Screen>
  );
}
