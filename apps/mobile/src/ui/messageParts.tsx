/**
 * What the essentials add around a message on the phone (Whombat essentials items 4, 8, 14; not mocked): reaction pills
 * under it, compact link cards, the failed turn's card with Try again, the “Pinned” mark, “(edited)”, the quiet
 * tombstone of a deleted thread root and “Saved to your Vault · Plex” (AP-4037). The chat's own language: `sf` cards with a `line` border, mono labels, 44dp
 * targets (AP-500, AP-503, AP-507, AP-508, AP-509).
 */

import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { PreviewCard, ReactionPill } from '../data/reactions';
import type { TurnFailedView } from '../data/turns';
import type { VaultSavedRow } from '../data/vaultSaved';
import { useI18n, useMobileT } from '../i18n';
import { opensInApp, useOpenUrl } from '../navigation/hooks';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Lock, Pin, Plus } from './icons';
import { Button, toneColor } from './primitives';
import { Touchable } from './Touchable';
import { hitSlopFor } from './touchTarget';

/** `👍 3` pills under a message (the viewer's own on `sel` with a brand outline); a tap adds or takes back. */
export function ReactionRow({
  pills,
  onToggle,
  onAdd,
  disabled,
}: {
  pills: readonly ReactionPill[];
  onToggle: (value: string, on: boolean) => void;
  /** The small “+” after the pills: the full emoji sheet. */
  onAdd?: () => void;
  disabled?: boolean;
}) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  if (pills.length === 0) return null;
  return (
    <View
      accessibilityLabel={tMobile('ui.reactions')}
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
      }}
    >
      {pills.map((p) => (
        <Touchable
          key={p.value}
          onPress={() => onToggle(p.value, !p.mine)}
          disabled={disabled}
          feedback="wash"
          ringRadius={16}
          accessibilityLabel={p.accessibilityLabel}
          accessibilityHint={
            p.mine ? tMobile('ui.takes-your-reaction-back') : tMobile('ui.adds-your-reaction')
          }
          accessibilityState={{ selected: p.mine }}
          hitSlop={hitSlopFor(32)}
          style={{
            minHeight: 32,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 5,
            paddingHorizontal: 10,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: p.mine ? theme.colors.brand : theme.colors.line2,
            backgroundColor: p.mine ? theme.colors.sel : theme.colors.sf,
          }}
        >
          <Text size={15}>{p.value}</Text>
          <Text size={12} weight={500} mono color={p.mine ? theme.colors.brand : theme.colors.ink2}>
            {String(p.count)}
          </Text>
        </Touchable>
      ))}
      {onAdd ? (
        <Touchable
          onPress={onAdd}
          disabled={disabled}
          feedback="wash"
          ringRadius={16}
          accessibilityLabel={tMobile('ui.add-a-reaction')}
          hitSlop={hitSlopFor(32)}
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: theme.colors.line2,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Plus size={15} color={theme.colors.ink2} strokeWidth={2} />
        </Touchable>
      ) : null}
    </View>
  );
}

/** Compact cards for the links in a message (no images): site, title, two lines of description; a tap opens it. */
export function LinkPreviews({ cards }: { cards: readonly PreviewCard[] }) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const openUrl = useOpenUrl();
  if (cards.length === 0) return null;
  return (
    <View style={{ gap: 8 }}>
      {cards.map((c) => (
        <Touchable
          key={c.url}
          onPress={() => openUrl(c.url)}
          feedback="wash"
          ringRadius={14}
          accessibilityRole="link"
          accessibilityLabel={c.accessibilityLabel}
          accessibilityHint={
            opensInApp(c.url) ? tMobile('ui.opens-in-whombat') : tMobile('ui.opens-in-your-browser')
          }
          style={{
            minHeight: 44,
            gap: 3,
            paddingVertical: 10,
            paddingHorizontal: 12,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: theme.colors.line,
            borderLeftWidth: 3,
            borderLeftColor: theme.colors.line2,
            backgroundColor: theme.colors.sf,
          }}
        >
          <Text size={11} weight={500} mono color={theme.colors.mut} numberOfLines={1}>
            {c.site}
          </Text>
          <Text size={14.5} weight={600} numberOfLines={2}>
            {c.title}
          </Text>
          {c.description ? (
            <Text size={13.5} lh={1.4} color={theme.colors.ink2} numberOfLines={2}>
              {c.description}
            </Text>
          ) : null}
        </Touchable>
      ))}
    </View>
  );
}

/**
 * A failed turn (CT-167, AP-500): the failure's short state in the bad tone, its sentence (unless the message already
 * says it), then Try again for people who may, or “Tried again · 14:32” once someone did. A refused retry's words sit
 * under it in the bad tone.
 */
export function TurnFailedCardView({
  view,
  busy,
  problem,
  onRetry,
  hide = null,
}: {
  view: TurnFailedView;
  busy: boolean;
  /** Why the last press didn't go through. */
  problem: string | null;
  /** Null: no button (not for this viewer, or refused for good). */
  onRetry: (() => void) | null;
  /** “Hide card” in the top right of a card opened from its line (docs/decisions/card-settle.md AP-730). */
  hide?: ReactNode;
}) {
  const { t: tMobile } = useMobileT();
  const { tClient } = useI18n();
  const theme = useTheme();
  return (
    <View
      style={{
        alignSelf: 'stretch',
        gap: 8,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        paddingVertical: 12,
        paddingHorizontal: 14,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
        <View accessible accessibilityLabel={view.accessibilityLabel} style={{ flex: 1, gap: 6 }}>
          <Text size={11} weight={500} mono tracking={0.05} color={toneColor(theme, view.tone)}>
            {view.label}
          </Text>
          {view.reason ? (
            <Text size={15} lh={1.45}>
              {view.reason}
            </Text>
          ) : null}
          {view.retried ? (
            <Text size={12} weight={500} mono color={theme.colors.mut}>
              {view.retried}
            </Text>
          ) : null}
        </View>
        {hide}
      </View>
      {onRetry && !view.retried ? (
        <Button
          label={tClient('settings.retry')}
          busy={busy}
          onPress={onRetry}
          accessibilityHint={tMobile('screens2.chat.retryTurnHint', { name: view.agentName })}
          style={{ alignSelf: 'flex-start', paddingHorizontal: 18 }}
        />
      ) : null}
      {problem ? (
        <Text size={13.5} lh={1.45} color={theme.colors.bad} accessibilityLiveRegion="polite">
          {problem}
        </Text>
      ) : null}
    </View>
  );
}

/** A small “Pinned” above a pinned message (CT-174). */
export function PinnedMark() {
  const { tClient } = useI18n();
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={tClient('overview.tab.pinned')}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        alignSelf: 'flex-start',
      }}
    >
      <Pin size={12} color={theme.colors.mut} strokeWidth={2} />
      <Text size={11} weight={500} mono color={theme.colors.mut}>
        {tClient('overview.tab.pinned')}
      </Text>
    </View>
  );
}

/** “(edited)” under a message whose author line isn't shown (CT-173). */
export function EditedMark() {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  return (
    <Text size={11} mono color={theme.colors.mut} style={{ alignSelf: 'flex-start', marginTop: -4 }}>
      {tMobile('ui.edited')}
    </Text>
  );
}

/** A deleted thread root kept for its replies: “This message was deleted.” in a dashed, quiet box, full width. */
export function Tombstone({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        alignSelf: 'stretch',
        paddingVertical: 10,
        paddingHorizontal: 14,
        borderRadius: 18,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: theme.colors.line2,
      }}
    >
      <Text size={14.5} lh={1.45} color={theme.colors.mut}>
        {text}
      </Text>
    </View>
  );
}

/**
 * “Saved to your Vault · Plex” and “Used once to put “Servers” on web-1, not kept” under a message whose secret Whombat
 * blanked (Whombat vault-self-serve.md VS-07, VS-11; AP-4037, AP-4038): a lock and the line, quiet like the other lines
 * under a message; a tap opens the entry (a 32dp row padded to 44dp).
 */
export function VaultSavedLines({
  rows,
  onOpen,
}: {
  rows: readonly VaultSavedRow[];
  onOpen: (row: VaultSavedRow) => void;
}) {
  const theme = useTheme();
  if (rows.length === 0) return null;
  return (
    <View style={{ alignSelf: 'flex-start', gap: 2, marginTop: -4 }}>
      {rows.map((row) => (
        <Touchable
          key={row.key}
          onPress={() => onOpen(row)}
          feedback="wash"
          ringRadius={8}
          accessibilityRole="link"
          accessibilityLabel={row.text}
          accessibilityHint={row.hint}
          hitSlop={hitSlopFor(32)}
          style={{
            minHeight: 32,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingHorizontal: 4,
            marginHorizontal: -4,
            borderRadius: 8,
          }}
        >
          <Lock size={13} color={theme.colors.mut} strokeWidth={2} />
          <Text size={13} lh={1.4} color={theme.colors.mut} style={{ flexShrink: 1 }}>
            {row.text}
          </Text>
        </Touchable>
      ))}
    </View>
  );
}
