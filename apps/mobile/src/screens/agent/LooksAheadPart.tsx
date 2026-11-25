/**
 * Settings → the assistant → **Looks ahead** on the phone (Whombat looks-ahead.md; the web's LooksAheadPart): the
 * afternoon before something on the person's calendar, the assistant checks it against their mail and the web and says
 * something only when it doesn't match. Its switch with how the last week went, the calendars it reads (each its own
 * switch, resting while Looks ahead is off) and the kinds of finding the person stopped, each with Check again. Every
 * change saves at once with a note; one that didn't go through says why. Pulling down reads it again. Only on a Whombat
 * that has it (`hasLooksAhead`; the screen leaves the part out elsewhere).
 */
import { looksAheadCalendarMeta, looksAheadSavedText, LOOKS_AHEAD_TEXT as T } from '@whombat/client';
import { commitOutcomeText, hostErrorInfo } from '@whombat/client/hosts';
import { useLooksAhead, useUpdateLooksAhead } from '@whombat/client/react';
import { AHEAD_KIND_WORDS, type LooksAheadUpdate } from '@whombat/core';
import { Alert, Switch, View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Button, ErrorState, Section, SkeletonRows } from '../../ui/primitives';
import { switchColors } from '../../ui/switchColors';
import { showNotice } from '../feedback';
import { Note, type PartProps, PartScroll } from './parts';

export function LooksAheadPart({ profile }: PartProps) {
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const query = useLooksAhead({ params: { burrow: slug } }, { retry: false });
  const update = useUpdateLooksAhead(slug);
  const view = query.data;

  if (!view) {
    return query.error ? (
      <ErrorState text={T.failed} onRetry={() => void query.refetch()} />
    ) : (
      <View accessibilityLabel={T.loading} style={{ paddingTop: 14 }}>
        <SkeletonRows count={3} lines={1} />
      </View>
    );
  }

  const busy = update.isPending;
  const failed = (text: string) => Alert.alert(T.notSaved, text);
  const save = (change: LooksAheadUpdate) => {
    const said = looksAheadSavedText(view, change);
    update.mutate(change, {
      onSuccess: (r) => (r.status === 'ok' ? showNotice(said) : failed(commitOutcomeText(r) ?? '')),
      onError: (error) => failed(hostErrorInfo(error).message),
    });
  };

  return (
    <PartScroll refreshing={query.isRefetching} onRefresh={() => void query.refetch()}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 14 }}>
        <Text size={15} lh={1.5} color={theme.colors.ink2}>
          {T.explainFor(profile.agent.name)}
        </Text>
      </View>

      <Section>
        <SwitchRow
          first
          title={T.title}
          line={T.week(view.week.checked, view.week.told)}
          on={view.on}
          disabled={busy}
          onChange={(on) => save({ on })}
        />
      </Section>

      <Section title={T.calendars}>
        {!view.hasCalendar ? (
          <Note>{T.noCalendar}</Note>
        ) : !view.calendarsRead ? (
          <Note>{T.calendarsUnread}</Note>
        ) : (
          view.calendars.map((c, i) => (
            <SwitchRow
              key={c.key}
              first={i === 0}
              title={c.name}
              line={looksAheadCalendarMeta(c)}
              on={c.on}
              resting={!view.on}
              disabled={busy || !view.on}
              onChange={(on) => save({ calendar: c.key, on })}
            />
          ))
        )}
      </Section>

      {view.stopped.length ? (
        <Section title={T.stopped}>
          {view.stopped.map((kind, i) => (
            <View
              key={kind}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                minHeight: 56,
                paddingVertical: 10,
                paddingHorizontal: 16,
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: theme.colors.line,
              }}
            >
              <Text size={15} weight={600} style={{ flex: 1, minWidth: 0 }}>
                {AHEAD_KIND_WORDS[kind]}
              </Text>
              <Button
                label={T.turnBackOn}
                variant="secondary"
                disabled={busy}
                onPress={() => save({ kind, on: true })}
                accessibilityLabel={T.turnBackOnLabel(kind)}
              />
            </View>
          ))}
        </Section>
      ) : null}
    </PartScroll>
  );
}

/** A row with its title, a line under it and a real switch on the right (44dp). */
function SwitchRow({
  title,
  line,
  on,
  disabled,
  resting = false,
  first = false,
  onChange,
}: {
  title: string;
  line: string;
  on: boolean;
  disabled: boolean;
  /** Keeps its choice but rests (Looks ahead is off). */
  resting?: boolean;
  first?: boolean;
  onChange: (on: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View style={{ flex: 1, minWidth: 0, gap: 2, opacity: resting ? 0.55 : 1 }}>
        <Text size={15} weight={600}>
          {title}
        </Text>
        {line ? (
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {line}
          </Text>
        ) : null}
      </View>
      <Switch
        value={on}
        disabled={disabled}
        onValueChange={onChange}
        accessibilityLabel={title}
        accessibilityHint={line}
        accessibilityRole="switch"
        accessibilityState={{ checked: on, disabled }}
        {...switchColors(theme, on)}
        style={{ minHeight: 44 }}
      />
    </View>
  );
}
