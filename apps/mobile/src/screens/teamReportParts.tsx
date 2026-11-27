/**
 * The pieces the phone's report screens share (Whombat team-reports.md): a report's kind as a small tile with the
 * app's blue dot when something is new, the four-step track, and the report page's ⋯ with Withdraw report.
 */
import {
  type TeamReportStepState,
  teamReportKindWords,
  teamReportTrack,
  teamReportTrackLabel,
  teamReportWords,
} from '@whombat/client';
import type { TeamReportKind, TeamReportStatus } from '@whombat/core';
import { useState } from 'react';
import { View } from 'react-native';
import { plainMenu } from '../data/nativeMenu';
import { teamReportsPhoneWords } from '../data/teamReports';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Bug, Ellipsis, Lightbulb } from '../ui/icons';
import { hasNativeMenu, MenuSheet, NativeMenu } from '../ui/nativeMenu';
import { Touchable } from '../ui/Touchable';

const hidden = {
  accessibilityElementsHidden: true,
  importantForAccessibility: 'no-hide-descendants',
} as const;

/** A report's kind as a tile (a bug, a light bulb), with the blue dot of something new, as a thread's icon has it. */
export function KindTile({
  kind,
  fresh = false,
  size = 36,
}: {
  kind: TeamReportKind;
  fresh?: boolean;
  size?: number;
}) {
  const theme = useTheme();
  const Icon = kind === 'bug' ? Bug : Lightbulb;
  return (
    <View {...hidden} style={{ width: size, height: size }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: 10,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.sf2,
        }}
      >
        <Icon size={Math.round(size * 0.5)} color={theme.colors.ink2} strokeWidth={1.75} />
      </View>
      {fresh ? (
        <View
          style={{
            position: 'absolute',
            top: -3,
            right: -3,
            width: 12,
            height: 12,
            borderRadius: 6,
            borderWidth: 2,
            borderColor: theme.colors.bg,
            backgroundColor: theme.chart.chart1,
          }}
        />
      ) : null}
    </View>
  );
}

/** “#12 · Problem”: the report's number and kind, the mono line over its title. */
export function reportKicker(
  report: { number: number; kind: TeamReportKind },
  locale?: string | null,
): string {
  return `#${report.number} · ${teamReportKindWords(locale)[report.kind]}`;
}

/**
 * The four steps (Received → Looking into it → Being fixed → Fixed): a dot each on one line, the steps behind done,
 * the one the team is at ringed, the rest quiet; their names under them. Read as one line, “Step 2 of 4: …”.
 */
export function ReportTrack({ status }: { status: TeamReportStatus }) {
  const { rawLocale } = useI18n();
  const teamReportWordsHere = teamReportWords(rawLocale);
  const theme = useTheme();
  const steps = teamReportTrack(status, rawLocale);
  const dot = (state: TeamReportStepState) =>
    state === 'done'
      ? { backgroundColor: theme.colors.ink2, borderColor: theme.colors.ink2 }
      : state === 'current'
        ? { backgroundColor: theme.colors.sf, borderColor: theme.colors.brand }
        : { backgroundColor: theme.colors.sf, borderColor: theme.colors.line2 };
  return (
    <View
      accessible
      accessibilityLabel={`${teamReportWordsHere.progress}. ${teamReportTrackLabel(status, rawLocale)}`}
      style={{ flexDirection: 'row' }}
    >
      {steps.map((step, i) => (
        <View key={step.label} {...hidden} style={{ flex: 1, alignItems: 'center', gap: 6 }}>
          <View style={{ height: 12, alignSelf: 'stretch', justifyContent: 'center' }}>
            {/* The line to the step before and after, under the dot. */}
            <View style={{ position: 'absolute', left: 0, right: 0, flexDirection: 'row' }}>
              <View
                style={{
                  flex: 1,
                  height: 2,
                  backgroundColor:
                    i === 0 ? 'transparent' : step.state === 'ahead' ? theme.colors.line : theme.colors.ink2,
                }}
              />
              <View
                style={{
                  flex: 1,
                  height: 2,
                  backgroundColor:
                    i === steps.length - 1
                      ? 'transparent'
                      : steps[i + 1]?.state === 'ahead'
                        ? theme.colors.line
                        : theme.colors.ink2,
                }}
              />
            </View>
            <View
              style={{
                alignSelf: 'center',
                width: 12,
                height: 12,
                borderRadius: 6,
                borderWidth: 2,
                ...dot(step.state),
              }}
            />
          </View>
          <Text
            size={11.5}
            lh={1.3}
            weight={step.state === 'current' ? 600 : 400}
            color={step.state === 'ahead' ? theme.colors.mut : theme.colors.ink2}
            style={{ textAlign: 'center', paddingHorizontal: 2 }}
          >
            {step.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

function moreMenu(locale?: string | null) {
  return plainMenu([
    [{ id: 'withdraw', title: teamReportWords(locale).withdraw, icon: 'trash', destructive: true }],
  ]);
}

/** The report page's ⋯: Withdraw report (the caller asks first). iOS's own menu on an iPhone, a sheet elsewhere. */
export function ReportMore({ title, onWithdraw }: { title: string; onWithdraw: () => void }) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const label = teamReportsPhoneWords(rawLocale).more(title);
  const onPick = (id: string) => {
    if (id === 'withdraw') onWithdraw();
  };
  const box = {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: theme.colors.line,
    backgroundColor: theme.colors.sf,
    alignItems: 'center',
    justifyContent: 'center',
  } as const;
  const face = <Ellipsis size={18} color={theme.colors.ink} strokeWidth={1.8} />;
  if (hasNativeMenu)
    return (
      <NativeMenu spec={moreMenu(rawLocale)} onPick={onPick} trigger="tap" label={label} style={box}>
        <View style={box}>{face}</View>
      </NativeMenu>
    );
  return (
    <>
      <Touchable
        onPress={() => setOpen(true)}
        feedback="wash"
        ringRadius={22}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={box}
      >
        {face}
      </Touchable>
      <MenuSheet
        spec={open ? moreMenu(rawLocale) : null}
        visible={open}
        label={label}
        onClose={() => setOpen(false)}
        onPick={onPick}
      />
    </>
  );
}
