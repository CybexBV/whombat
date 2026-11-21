/**
 * Your notifications on Settings → Notifications (Whombat essentials item 12; CT-175; AP-513): Do not disturb — what's on
 * now with “Turn off”, the quick durations (30 minutes, 1 hour, Until tomorrow) and a time you type, or pick on iPhone —
 * and quiet hours (a switch, from and to, the days), in your time zone, and (AP-809, on a Whombat with
 * `notifications.previews`) whether notifications show message text. Each change replaces `Preferences.notifications`
 * whole, built from what the server has now (`useSaveNotificationPreferences`); a failure puts the old value back and
 * says so.
 */
import { dndSetText, quietHoursText, toggleDay, WEEKDAY_LABELS } from '@whombat/client';
import { type DateInput, dndUntilFor, type QuietHours, WEEKDAY_KEYS, type Weekday } from '@whombat/core';
import { useState } from 'react';
import { Platform, Switch, TextInput, View } from 'react-native';
import { useBurrowBase, useNow } from '../data/BurrowProvider';
import {
  DND_HINT,
  DND_PRESETS,
  dndStateText,
  dndUntilClock,
  nextWholeHour,
  PREVIEWS_HINT,
  PREVIEWS_TITLE,
  QUIET_HOURS_HINT,
} from '../data/notify';
import { useNotificationPreferences, useSaveNotificationPreferences } from '../data/useEssentials';
import { errorText, showNotice } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { ClockField } from '../ui/ClockField';
import { Button, SectionLabel } from '../ui/primitives';
import { switchColors } from '../ui/switchColors';
import { Touchable } from '../ui/Touchable';
import { hitSlopFor } from '../ui/touchTarget';

export function NotificationsSection() {
  const theme = useTheme();
  const { timeZone } = useBurrowBase();
  const now = useNow();
  const prefs = useNotificationPreferences();
  const save = useSaveNotificationPreferences();
  const [busy, setBusy] = useState(false);
  const [until, setUntil] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const apply = async (change: Parameters<typeof save>[0], notice?: string): Promise<boolean> => {
    setProblem(null);
    setBusy(true);
    try {
      await save(change);
      if (notice) showNotice(notice);
      return true;
    } catch (error) {
      setProblem(errorText(error));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const setDnd = (at: string, now: DateInput) =>
    apply((p) => ({ ...p, dndUntil: at }), dndSetText(at, now, timeZone));
  const setSchedule = (change: (s: QuietHours) => QuietHours) =>
    apply((p) => ({ ...p, schedule: change(p.schedule) }));
  const state = dndStateText(prefs, now, timeZone);
  const on = state !== 'Off';
  const schedule = prefs.schedule;
  // On iPhone “Until” is iOS's time picker, starting at the next whole hour; elsewhere a time you type.
  const picksTime = Platform.OS === 'ios';
  const untilClock = picksTime ? until || nextWholeHour(now, timeZone) : until;

  return (
    <View style={{ gap: 18 }}>
      <View style={{ gap: 8 }}>
        <SectionLabel>DO NOT DISTURB</SectionLabel>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 6 }}>
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: on ? theme.colors.warn : theme.colors.mut,
            }}
          />
          <Text size={15} weight={500} style={{ flex: 1 }} accessibilityLiveRegion="polite">
            {state}
          </Text>
          {on ? (
            <Touchable
              onPress={() => void apply((p) => ({ ...p, dndUntil: null }), 'Do not disturb is off.')}
              disabled={busy}
              feedback="fade"
              ringRadius={10}
              accessibilityLabel="Turn off Do not disturb"
              hitSlop={hitSlopFor(32)}
              style={{ minHeight: 32, justifyContent: 'center', paddingHorizontal: 8 }}
            >
              <Text size={14} weight={500} color={theme.colors.brand}>
                Turn off
              </Text>
            </Touchable>
          ) : null}
        </View>
        <Text size={13} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
          {DND_HINT}
        </Text>
        <View accessibilityLabel="Do not disturb for" style={{ flexDirection: 'row', gap: 8 }}>
          {DND_PRESETS.map((p) => (
            <Button
              key={p.preset}
              label={p.label}
              variant="secondary"
              disabled={busy}
              onPress={() => void setDnd(dndUntilFor(p.preset, now, timeZone), now)}
              style={{ flex: 1, paddingHorizontal: 6 }}
            />
          ))}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {picksTime ? (
            <View style={{ paddingLeft: 6 }}>
              <ClockField
                label="Until"
                spoken="Do not disturb until this time"
                value={untilClock}
                disabled={busy}
                onChange={setUntil}
              />
            </View>
          ) : (
            <>
              <Text size={13} color={theme.colors.mut} style={{ paddingLeft: 6 }}>
                Until
              </Text>
              <TextInput
                value={until}
                onChangeText={setUntil}
                placeholder="18:30"
                placeholderTextColor={theme.colors.mut}
                accessibilityLabel="Do not disturb until this time"
                keyboardType="numbers-and-punctuation"
                returnKeyType="done"
                maxLength={5}
                cursorColor={theme.colors.ink}
                selectionColor={theme.colors.brand}
                style={{
                  width: 84,
                  minHeight: 44,
                  paddingHorizontal: 10,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: theme.colors.line2,
                  backgroundColor: theme.colors.sf,
                  color: theme.colors.ink,
                  textAlign: 'center',
                  ...textMetrics({ size: 14, family: 'mono' }),
                  includeFontPadding: false,
                }}
              />
            </>
          )}
          <Button
            label="Set"
            variant="secondary"
            disabled={busy || !untilClock.trim()}
            onPress={() => {
              const r = dndUntilClock(untilClock, now, timeZone);
              if (!r.ok) {
                setProblem(r.error);
                return;
              }
              void setDnd(r.until, now).then((ok) => ok && setUntil(''));
            }}
            style={{ paddingHorizontal: 18 }}
          />
        </View>
      </View>

      <View style={{ gap: 8 }}>
        <SectionLabel>QUIET HOURS</SectionLabel>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 6 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text size={15} weight={500}>
              Quiet hours
            </Text>
            <Text size={12.5} mono color={theme.colors.mut}>
              {quietHoursText(schedule)}
            </Text>
          </View>
          <Switch
            value={schedule.enabled}
            disabled={busy}
            onValueChange={(v) => void setSchedule((s) => ({ ...s, enabled: v }))}
            accessibilityLabel="Quiet hours"
            accessibilityRole="switch"
            {...switchColors(theme, schedule.enabled)}
            style={{ minHeight: 44 }}
          />
        </View>
        <Text size={13} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
          {QUIET_HOURS_HINT}
        </Text>
        {schedule.enabled ? (
          <>
            <View style={{ flexDirection: 'row', gap: 16, paddingHorizontal: 6 }}>
              <ClockField
                label="From"
                value={schedule.start}
                disabled={busy}
                onChange={(start) => void setSchedule((s) => ({ ...s, start }))}
              />
              <ClockField
                label="To"
                value={schedule.end}
                disabled={busy}
                onChange={(end) => void setSchedule((s) => ({ ...s, end }))}
              />
            </View>
            <View accessibilityLabel="Days" style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 6 }}>
              {WEEKDAY_KEYS.map((day: Weekday) => {
                const active = schedule.days.includes(day);
                return (
                  <Touchable
                    key={day}
                    onPress={() => void setSchedule((s) => ({ ...s, days: toggleDay(s.days, day) }))}
                    disabled={busy}
                    feedback={active ? 'fade' : 'wash'}
                    ringRadius={999}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: active }}
                    accessibilityLabel={WEEKDAY_LABELS[day].long}
                    hitSlop={hitSlopFor(36)}
                    style={{
                      flex: 1,
                      minHeight: 36,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 999,
                      borderWidth: 1,
                      borderColor: active ? theme.colors.btn : theme.colors.line2,
                      backgroundColor: active ? theme.colors.btn : 'transparent',
                    }}
                  >
                    <Text size={12} weight={500} mono color={active ? theme.colors.btnfg : theme.colors.ink}>
                      {WEEKDAY_LABELS[day].short}
                    </Text>
                  </Touchable>
                );
              })}
            </View>
          </>
        ) : null}
      </View>
      <View style={{ gap: 8 }}>
        <SectionLabel>PREVIEWS</SectionLabel>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 6 }}>
          <Text size={15} weight={500} style={{ flex: 1 }}>
            {PREVIEWS_TITLE}
          </Text>
          <Switch
            value={prefs.previews}
            disabled={busy}
            onValueChange={(v) => void apply((p) => ({ ...p, previews: v }))}
            accessibilityLabel={PREVIEWS_TITLE}
            accessibilityRole="switch"
            {...switchColors(theme, prefs.previews)}
            style={{ minHeight: 44 }}
          />
        </View>
        <Text size={13} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
          {PREVIEWS_HINT}
        </Text>
      </View>
      {problem ? (
        <Text
          size={13.5}
          lh={1.45}
          color={theme.colors.bad}
          accessibilityLiveRegion="polite"
          style={{ paddingHorizontal: 6 }}
        >
          {problem}
        </Text>
      ) : null}
    </View>
  );
}
