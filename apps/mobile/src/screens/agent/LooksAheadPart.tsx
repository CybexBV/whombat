/**
 * Settings → the assistant → **Looks ahead** on the phone (Whombat looks-ahead.md; the web's LooksAheadPart): switch
 * with Check now and week count, calendars, incoming mail switch, what it keeps an eye on (“Keeping an eye on”, each
 * with Remove), standing rules (“What to watch for”), stopped kinds, and recent checks. Every change saves at once with a note; one that didn't go through says why. Pulling down reads
 * it again. Only on a Whombat that has it (`hasLooksAhead`).
 */

import {
  hasLooksAheadMatters,
  hasLooksAheadV2,
  looksAheadCalendarMeta,
  looksAheadCheckMeta,
  looksAheadSavedText,
  matterLine,
  LOOKS_AHEAD_TEXT as T,
} from '@whombat/client';
import { commitOutcomeText, hostErrorInfo } from '@whombat/client/hosts';
import {
  useCheckLooksAheadNow,
  useLooksAhead,
  useSessionProtocol,
  useUpdateLooksAhead,
} from '@whombat/client/react';
import { AHEAD_RULE_MAX, AHEAD_RULES_MAX, aheadKindWords, type LooksAheadUpdate } from '@whombat/core';
import { useState } from 'react';
import { Alert, Switch, TextInput, View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { threadRoute } from '../../data/chatRoom';
import { useI18n } from '../../i18n';
import { navigateTo, useAppNavigation } from '../../navigation/hooks';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { ChevronRight } from '../../ui/icons';
import { Button, ErrorState, Section, SkeletonRows } from '../../ui/primitives';
import { switchColors } from '../../ui/switchColors';
import { Touchable } from '../../ui/Touchable';
import { showNotice } from '../feedback';
import { Note, type PartProps, PartScroll } from './parts';

export function LooksAheadPart({ profile }: PartProps) {
  const { rawLocale } = useI18n();
  const aheadKindWordsHere = aheadKindWords(rawLocale);

  const theme = useTheme();
  const navigation = useAppNavigation();
  const { slug, timeZone } = useBurrowBase();
  const protocol = useSessionProtocol();
  const v2 = hasLooksAheadV2(protocol);
  const hasMatters = hasLooksAheadMatters(protocol);
  const query = useLooksAhead({ params: { burrow: slug } }, { retry: false });
  const update = useUpdateLooksAhead(slug);
  const checkNow = useCheckLooksAheadNow(slug);
  const [draftRule, setDraftRule] = useState('');
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
  const save = (change: LooksAheadUpdate, onDone?: () => void) => {
    const said = looksAheadSavedText(view, change);
    update.mutate(change, {
      onSuccess: (r) => {
        if (r.status === 'ok') {
          showNotice(said);
          onDone?.();
        } else failed(commitOutcomeText(r, rawLocale) ?? '');
      },
      onError: (error) => failed(hostErrorInfo(error, rawLocale).message),
    });
  };
  const runCheckNow = () => {
    checkNow.mutate(undefined, {
      onSuccess: (r) => {
        if (r.status === 'ok') showNotice(r.data.started ? T.checkStarted : T.nothingDue);
        else failed(commitOutcomeText(r, rawLocale) ?? '');
      },
      onError: (error) => failed(hostErrorInfo(error, rawLocale).message),
    });
  };
  const rules = view.rules ?? [];
  const recent = view.recent ?? [];
  const matters = view.matters ?? [];
  const trimmedRule = draftRule.trim();
  const canAddRule = trimmedRule.length >= 2 && rules.length < AHEAD_RULES_MAX && !busy;

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
        {v2 ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'flex-end',
              paddingVertical: 10,
              paddingHorizontal: 16,
              borderTopWidth: 1,
              borderTopColor: theme.colors.line,
            }}
          >
            <Button
              label={checkNow.isPending ? T.checkingNow : T.checkNow}
              variant="secondary"
              disabled={!view.on || checkNow.isPending}
              onPress={runCheckNow}
            />
          </View>
        ) : null}
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

      {v2 ? (
        <Section title={T.mail}>
          {view.hasMail === false ? (
            <Note>{T.noMail}</Note>
          ) : (
            <SwitchRow
              first
              title={T.mail}
              line={T.mailLine}
              on={view.mailOn ?? true}
              resting={!view.on}
              disabled={busy || !view.on}
              onChange={(mailOn) => save({ mailOn })}
            />
          )}
        </Section>
      ) : null}

      {hasMatters && (view.hasMail || matters.length > 0) ? (
        <Section title={T.matters}>
          {matters.length ? (
            matters.map((matter, i) => (
              <View
                key={matter.id}
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
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text size={15} weight={600}>
                    {matter.title}
                  </Text>
                  <Text size={13} lh={1.4} color={theme.colors.mut}>
                    {matterLine(matter, timeZone)}
                  </Text>
                </View>
                <Button
                  label={T.removeMatter}
                  variant="secondary"
                  disabled={busy}
                  onPress={() => save({ removeMatter: matter.id })}
                  accessibilityLabel={T.removeMatterLabel(matter.title)}
                />
              </View>
            ))
          ) : (
            <Note>{T.mattersEmpty(profile.agent.name)}</Note>
          )}
        </Section>
      ) : null}

      {v2 ? (
        <Section title={T.rules}>
          <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
            <Text size={13} lh={1.45} color={theme.colors.mut}>
              {T.rulesHint}
            </Text>
          </View>
          {rules.map((rule) => (
            <View
              key={rule}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                minHeight: 52,
                paddingVertical: 10,
                paddingHorizontal: 16,
                borderTopWidth: 1,
                borderTopColor: theme.colors.line,
              }}
            >
              <Text size={14} lh={1.4} style={{ flex: 1, minWidth: 0 }}>
                {rule}
              </Text>
              <Button
                label={T.removeRule}
                variant="secondary"
                disabled={busy}
                onPress={() => save({ removeRule: rule })}
                accessibilityLabel={T.removeRuleLabel(rule)}
              />
            </View>
          ))}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingVertical: 10,
              paddingHorizontal: 16,
              borderTopWidth: 1,
              borderTopColor: theme.colors.line,
            }}
          >
            <TextInput
              value={draftRule}
              onChangeText={setDraftRule}
              placeholder={T.rulesPlaceholder}
              placeholderTextColor={theme.colors.mut}
              maxLength={AHEAD_RULE_MAX}
              accessibilityLabel={T.rules}
              style={{
                flex: 1,
                minHeight: 44,
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderWidth: 1,
                borderColor: theme.colors.line,
                borderRadius: theme.radii.button,
                color: theme.colors.ink,
                fontSize: 14,
              }}
            />
            <Button
              label={T.addRule}
              variant="secondary"
              disabled={!canAddRule}
              onPress={() => save({ addRule: trimmedRule }, () => setDraftRule(''))}
            />
          </View>
        </Section>
      ) : null}

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
                {aheadKindWordsHere[kind]}
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

      {v2 && recent.length ? (
        <Section title={T.recent}>
          {recent.map((item, i) => {
            const canOpenThread = Boolean(item.threadRootId && item.of !== 'triage');
            const canOpenInbox = Boolean(!canOpenThread && item.inboxItemId && item.of !== 'triage');
            const openRecent = canOpenThread
              ? () => {
                  const route = threadRoute(`/chat?thread=${item.threadRootId}`, T.title);
                  if (route) navigateTo(navigation, route);
                }
              : canOpenInbox
                ? () =>
                    navigation.navigate('NeedsYouItem', {
                      itemId: item.inboxItemId as string,
                      back: T.title,
                    })
                : null;
            const rowStyle = {
              flexDirection: 'row' as const,
              alignItems: 'center' as const,
              gap: 10,
              minHeight: 52,
              paddingVertical: 10,
              paddingHorizontal: 16,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: theme.colors.line,
            };
            const body = (
              <>
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text size={14} weight={600} numberOfLines={1}>
                    {item.title}
                  </Text>
                  <Text size={13} lh={1.4} color={theme.colors.mut}>
                    {looksAheadCheckMeta(item)}
                  </Text>
                </View>
                {openRecent ? <ChevronRight size={16} color={theme.colors.mut} strokeWidth={1.7} /> : null}
              </>
            );
            return openRecent ? (
              <Touchable
                key={item.id}
                onPress={openRecent}
                feedback="wash"
                accessibilityRole="button"
                accessibilityLabel={`${item.title}, ${canOpenThread ? T.openThread : T.openInInbox}`}
                style={rowStyle}
              >
                {body}
              </Touchable>
            ) : (
              <View key={item.id} style={rowStyle}>
                {body}
              </View>
            );
          })}
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
