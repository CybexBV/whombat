/**
 * A screen's read states, shared by the approval screen and the Inbox: nothing to show (with where to go), a first read
 * that failed (Try again), and a refresh that failed while the saved copy stays in view. Problems read in warn-text,
 * never red: nothing is broken, the read is. Copy comes from the shared words.
 */
import { type ReactNode, useState } from 'react';
import { Platform, View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button } from './primitives';
import { Touchable } from './Touchable';

/** 44pt on iPhone, 48dp on Android. */
export const TARGET = Platform.OS === 'android' ? 48 : 44;

/** A read that failed after a saved copy was shown: in the content, above the details it keeps. */
export function ReadNotice({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        gap: 10,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
        padding: 16,
      }}
    >
      <Text size={17} weight={600} lh={1.3} color={theme.colors.warnText} accessibilityRole="header">
        {title}
      </Text>
      <Text size={15} lh={1.5} color={theme.colors.ink2}>
        {body}
      </Text>
      {children}
    </View>
  );
}

/** What a failed read says under More detail: the error's own message. */
export function readErrorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/**
 * The screen's read states: nothing to show (with where to go) and a first read that failed (Try again, a second way
 * such as Ask {assistant}, and the error folded under More detail).
 */
export function ReadState({
  title,
  body,
  action,
  second,
  detail,
  problem = false,
}: {
  title: string;
  body: string;
  action: { label: string; onPress: () => void };
  second?: { label: string; onPress: () => void; busy?: boolean };
  detail?: { label: string; text: string };
  problem?: boolean;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        margin: 16,
        gap: 12,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        padding: 22,
      }}
    >
      <Text
        size={23}
        weight={700}
        lh={1.25}
        color={problem ? theme.colors.warnText : theme.colors.ink}
        accessibilityRole="header"
      >
        {title}
      </Text>
      <Text size={15.5} lh={1.55} color={theme.colors.ink2}>
        {body}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
        <Button
          label={action.label}
          variant="secondary"
          wrap
          onPress={action.onPress}
          style={{ minHeight: TARGET }}
        />
        {second ? (
          <Button
            label={second.label}
            variant="secondary"
            wrap
            busy={second.busy}
            onPress={second.onPress}
            style={{ minHeight: TARGET }}
          />
        ) : null}
      </View>
      {detail ? (
        <View style={{ gap: 6 }}>
          <Touchable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen(!open)}
            feedback="wash"
            ringRadius={10}
            style={{ minHeight: TARGET, justifyContent: 'center', alignSelf: 'flex-start', borderRadius: 10 }}
          >
            <Text size={13} color={theme.colors.mut}>
              {open ? '▾' : '▸'} {detail.label}
            </Text>
          </Touchable>
          {open ? (
            <Text size={13} lh={1.6} color={theme.colors.ink2} selectable>
              {detail.text}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
