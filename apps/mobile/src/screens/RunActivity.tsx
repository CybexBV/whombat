/**
 * The run screen's ACTIVITY section (work-supervision WS-13…WS-17): observed actions oldest first, routine reads and
 * searches collapsed into a group row (“Read 4 files”, tap to expand), each row with its status dot, title, detail,
 * object and time; a row with evidence opens its input and the tail of its output in a code block. Rows update live
 * from `activity.updated` on the run's topic (the run screen subscribes to it).
 */

import { useActivity } from '@whombat/client/react';
import { useState } from 'react';
import { View } from 'react-native';
import {
  ACTIVITY_TRUNCATED_TEXT,
  type ActivityDot,
  type ActivityRowView,
  activitySection,
} from '../data/activity';
import { useBurrowBase, useViewContext } from '../data/BurrowProvider';
import { useMobileT } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Section } from '../ui/primitives';
import { Touchable } from '../ui/Touchable';

function Dot({ dot, label }: { dot: ActivityDot; label: string }) {
  const theme = useTheme();
  const color =
    dot === 'live'
      ? theme.colors.progress
      : dot === 'ok'
        ? theme.colors.ok
        : dot === 'warn'
          ? theme.colors.warn
          : dot === 'bad'
            ? theme.colors.bad
            : theme.colors.mut;
  return (
    <View
      accessible
      accessibilityLabel={label}
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        marginTop: 6,
        backgroundColor: color,
        ...(dot === 'live' ? { boxShadow: `0 0 0 4px ${theme.colors.liveHalo}` } : {}),
      }}
    />
  );
}

function Evidence({ evidence }: { evidence: NonNullable<ActivityRowView['evidence']> }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <View
        accessible
        accessibilityLabel={[
          evidence.input ? `Input: ${evidence.input}` : null,
          evidence.output ? `Output: ${evidence.output}` : null,
        ]
          .filter(Boolean)
          .join('. ')}
        style={{
          borderRadius: 12,
          backgroundColor: theme.colors.code,
          paddingVertical: 10,
          paddingHorizontal: 12,
          gap: 8,
        }}
      >
        {evidence.input ? (
          <Text size={12} lh={1.6} mono color={theme.code.command}>
            {evidence.input}
          </Text>
        ) : null}
        {evidence.output ? (
          <Text size={12} lh={1.6} mono color={theme.code.text}>
            {evidence.output}
          </Text>
        ) : null}
      </View>
      {evidence.truncated ? (
        <Text size={11.5} mono color={theme.colors.mut}>
          {ACTIVITY_TRUNCATED_TEXT}
        </Text>
      ) : null}
    </View>
  );
}

function RowBody({ row, open }: { row: ActivityRowView; open: boolean }) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 12 }}>
      <Dot dot={row.dot} label={row.statusLabel} />
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
          <Text
            size={14.5}
            weight={500}
            color={row.dot === 'mut' ? theme.colors.mut : theme.colors.ink}
            style={{ flex: 1, minWidth: 0 }}
          >
            {row.title}
          </Text>
          <Text size={11.5} mono color={theme.colors.mut}>
            {row.time}
          </Text>
        </View>
        {row.detail ? (
          <Text size={13} lh={1.4} color={row.dot === 'bad' ? theme.colors.bad : theme.colors.mut}>
            {row.detail}
          </Text>
        ) : null}
        {row.object ? (
          <Text size={12} mono color={theme.colors.mut} numberOfLines={open ? undefined : 1}>
            {row.object}
          </Text>
        ) : null}
        {row.evidence ? (
          open ? (
            <View style={{ paddingTop: 6 }}>
              <Evidence evidence={row.evidence} />
            </View>
          ) : (
            <Text size={12} weight={500} color={theme.colors.brand}>
              {tMobile('screens.show-details')}
            </Text>
          )
        ) : null}
      </View>
    </View>
  );
}

function ActivityRow({ row, nested }: { row: ActivityRowView; nested?: boolean }) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const style = {
    minHeight: 44,
    paddingVertical: 12,
    paddingLeft: nested ? 36 : 16,
    paddingRight: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.line,
  };
  if (!row.evidence)
    return (
      <View style={style} accessible accessibilityLabel={row.accessibilityLabel}>
        <RowBody row={row} open={false} />
      </View>
    );
  return (
    <Touchable
      onPress={() => setOpen((o) => !o)}
      feedback="wash"
      accessibilityLabel={row.accessibilityLabel}
      accessibilityHint={
        open ? tMobile('screens.hides-the-details') : tMobile('screens.shows-the-input-and-output')
      }
      accessibilityState={{ expanded: open }}
      style={style}
    >
      <RowBody row={row} open={open} />
    </Touchable>
  );
}

function ActivityGroup({ title, time, rows }: { title: string; time: string; rows: ActivityRowView[] }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Touchable
        onPress={() => setOpen((o) => !o)}
        feedback="wash"
        accessibilityLabel={`${title}, ${time}`}
        accessibilityState={{ expanded: open }}
        style={{
          minHeight: 44,
          flexDirection: 'row',
          gap: 12,
          paddingVertical: 12,
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.line,
        }}
      >
        <View
          style={{ width: 8, height: 8, borderRadius: 4, marginTop: 6, backgroundColor: theme.colors.ok }}
        />
        <Text size={14.5} weight={500} color={theme.colors.ink2} style={{ flex: 1, minWidth: 0 }}>
          {title}
        </Text>
        <Text size={11.5} mono color={theme.colors.mut}>
          {`${time} ${open ? '▴' : '▾'}`}
        </Text>
      </Touchable>
      {open ? rows.map((r) => <ActivityRow key={r.id} row={r} nested />) : null}
    </>
  );
}

export function RunActivity({ runNumber }: { runNumber: number }) {
  const { t: tMobile } = useMobileT();
  const { slug } = useBurrowBase();
  const ctx = useViewContext();
  const query = useActivity({ params: { burrow: slug }, query: { runNumber } }, { retry: false });
  // An older server without `activity.list` (or one that failed) shows no section rather than an error.
  if (!query.data) return null;
  const model = activitySection(query.data, ctx.now, ctx.timeZone);
  if (model.entries.length === 0) return null;
  return (
    <Section title={tMobile('screens.activity')}>
      {model.entries.map((e) =>
        e.type === 'row' ? (
          <ActivityRow key={e.key} row={e.row} />
        ) : (
          <ActivityGroup key={e.key} title={e.title} time={e.time} rows={e.rows} />
        ),
      )}
    </Section>
  );
}
