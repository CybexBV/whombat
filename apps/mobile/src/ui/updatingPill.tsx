/**
 * “Updating…” and “Couldn’t update · Try again”: a quiet pill over the top of a conversation's list while what it shows
 * may be old and no new answer has come. The phone opens with the copy it kept (AP-717) and live updates keep changing
 * it, so without this a list that wasn't read again for days looked as current as one read a second ago. It shows only
 * when it says something: a read under way for a moment (`UPDATING_AFTER_MS`) over data a while old (`OLD_AFTER_MS`),
 * or a read that failed with data on screen (in warn-text, never red: nothing is broken, the read is). Floats like
 * “New messages ↓” (`jumpPill.tsx`), so nothing moves when it comes or goes; in the tree it comes right after the list.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { READ_STATE_TEXT, type ReadLine, readLineOf, UPDATING_AFTER_MS } from '../data/readLine';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { TARGET } from './readState';
import { Touchable } from './Touchable';

/** The parts of a TanStack query result the pill reads. */
export interface ReadSource {
  data: unknown;
  status: 'pending' | 'error' | 'success';
  isFetching: boolean;
  isPaused: boolean;
  dataUpdatedAt: number;
  isFetchingNextPage?: boolean;
  isFetchingPreviousPage?: boolean;
  /** Shown while the read hasn't answered yet (a thread's root from the room): loading, not old. */
  isPlaceholderData?: boolean;
  /** Loading older messages failed: what is on screen was read all the same (that list says so itself). */
  isFetchNextPageError?: boolean;
  isFetchPreviousPageError?: boolean;
  refetch: () => unknown;
}

/** The pill's line for a query result, “Updating…” held back for `UPDATING_AFTER_MS`. */
export function useReadLine(source: ReadSource, now: () => number = Date.now): ReadLine {
  const paging = !!source.isFetchingNextPage || !!source.isFetchingPreviousPage;
  const asking = (source.isFetching || source.isPaused) && !paging;
  const [since, setSince] = useState<number | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!asking) {
      setSince(null);
      return;
    }
    setSince(now());
    // Drawn again once “Updating…” is due.
    const timer = setTimeout(() => setTick((n) => n + 1), UPDATING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [asking, now]);
  return readLineOf(
    {
      hasData: source.data !== undefined && !source.isPlaceholderData,
      status:
        source.status === 'error' && (source.isFetchNextPageError || source.isFetchPreviousPageError)
          ? 'success'
          : source.status,
      asking,
      dataUpdatedAt: source.dataUpdatedAt,
      askingSince: asking ? since : null,
    },
    now(),
  );
}

export function ReadStatePill({ source }: { source: ReadSource }) {
  const theme = useTheme();
  const line = useReadLine(source);
  if (!line) return null;
  const pill = {
    minHeight: TARGET,
    paddingHorizontal: 18,
    borderRadius: TARGET / 2,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    backgroundColor: theme.colors.sf,
    borderWidth: 1,
    borderColor: theme.colors.line,
    boxShadow: theme.shadows.toast.boxShadow,
  };
  return (
    <View
      pointerEvents="box-none"
      style={{ position: 'absolute', left: 0, right: 0, top: 10, alignItems: 'center' }}
    >
      {line === 'updating' ? (
        <View style={pill} accessible accessibilityLiveRegion="polite">
          <Text size={13} weight={500} color={theme.colors.mut}>
            {READ_STATE_TEXT.updating}
          </Text>
        </View>
      ) : (
        <Touchable
          onPress={() => void source.refetch()}
          accessibilityLabel={`${READ_STATE_TEXT.failed}. ${READ_STATE_TEXT.retry}`}
          accessibilityHint={READ_STATE_TEXT.retryHint}
          accessibilityLiveRegion="polite"
          feedback="wash"
          ringRadius={TARGET / 2}
          style={pill}
        >
          <Text size={13} weight={500} color={theme.colors.warnText}>
            {`${READ_STATE_TEXT.failed} · `}
          </Text>
          <Text size={13} weight={600} color={theme.colors.ink}>
            {READ_STATE_TEXT.retry}
          </Text>
        </Touchable>
      )}
    </View>
  );
}
