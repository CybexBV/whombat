/**
 * *Add a widget* as a sheet on the phone (Whombat desk-display.md DK-139, DK-143, DK-145, DK-154, DK-159, DK-163;
 * desk-display-android.md AP-6017, AP-6120…, AP-9980…): a search field; Whombat's own as small tiles, three to a row
 * (one on the page already has a check); *Didn’t fit after rearranging* while a rearranged page left some out; then each
 * server, connection or device and account once under its section's heading — its mark, name, a line and the size its
 * main view starts at; adding it adds that view, and its sheet's *What it shows* chooses another — and the assistant's
 * Home widgets each; and at the end how to ask the assistant for one that isn't there. A search lists single views,
 * named with what they belong to (“pve-01 · Storage”). Each row (56dp and more) and tile (76dp) adds it to the first
 * free spot, smaller if it must; then the editor opens its sheet.
 */
import {
  type CatalogEntry,
  type CatalogRows,
  catalogRows,
  DESK_SCREENS_TEXT,
  type DeskCatalog,
  type DeskWidget,
  fillDeskWords,
  gridText,
  isAccountGroup,
} from '@whombat/client/desk';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useAgentWords } from '../../data/useAgent';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Check, CircleUser, type LucideIcon, Plus, Search } from '../../ui/icons';
import { SectionLabel } from '../../ui/primitives';
import { Sheet } from '../../ui/sheet';
import { Touchable } from '../../ui/Touchable';
import { accountShows } from './catalog';
import type { TileLabel } from './tiles';
import { ACCOUNT_ICONS, VIEW_ICONS, WidgetLogo } from './WidgetLogo';

const E = DESK_SCREENS_TEXT.editor;

/**
 * A row's icon where it has no brand mark: an account's a person's (one found by a search, what it shows), else what it
 * draws (a photo, a board).
 */
function rowIcon(row: CatalogEntry): LucideIcon | undefined {
  if (row.service) return isAccountGroup(row.group) ? CircleUser : undefined;
  const shows = accountShows(row.item);
  return shows ? ACCOUNT_ICONS[shows] : row.item.view ? VIEW_ICONS[row.item.view] : undefined;
}

export function AddWidgetSheet({
  visible,
  onClose,
  onDismissed,
  catalog,
  onPage,
  left,
  labelOf,
  note,
  onAdd,
  onAddBack,
}: {
  visible: boolean;
  onClose: () => void;
  /** Once it's down: the new widget's sheet opens then. */
  onDismissed?: () => void;
  catalog: DeskCatalog | undefined;
  onPage: readonly DeskWidget[];
  /** What didn't fit after a rearranging, to put back. */
  left: readonly DeskWidget[];
  labelOf: (w: DeskWidget) => TileLabel;
  /** Why the last one couldn't be added (the page is full), said in the sheet: the toasts are behind it. */
  note: string | null;
  onAdd: (row: CatalogEntry) => void;
  onAddBack: (w: DeskWidget) => void;
}) {
  const theme = useTheme();
  const assistant = useAgentWords().name;
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!visible) setQuery('');
  }, [visible]);
  const sections = useMemo(() => catalogRows(catalog, query, onPage), [catalog, query, onPage]);
  const own = sections.find((x) => x.kind === 'own');
  const rest = sections.filter((x) => x.kind !== 'own');
  const searching = query.trim() !== '';
  return (
    <Sheet visible={visible} onClose={onClose} onDismissed={onDismissed} label={E.addWidget} maxHeight="92%">
      <View style={{ paddingHorizontal: 20, paddingBottom: 10, gap: 12 }}>
        <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
          {E.addWidget}
        </Text>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            minHeight: 48,
            paddingHorizontal: 14,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: theme.colors.line2,
            backgroundColor: theme.colors.sf,
          }}
        >
          <Search size={18} color={theme.colors.mut} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={E.search}
            accessibilityLabel={E.search}
            placeholderTextColor={theme.colors.placeholder}
            selectionColor={theme.colors.brand}
            autoCorrect={false}
            returnKeyType="search"
            style={{
              flex: 1,
              minHeight: 46,
              fontSize: 16,
              color: theme.colors.ink,
              includeFontPadding: false,
            }}
          />
        </View>
        {note ? (
          <Text size={14} lh={1.45} color={theme.colors.bad} accessibilityLiveRegion="polite">
            {note}
          </Text>
        ) : null}
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
        {own ? <OwnTiles section={own} onAdd={onAdd} /> : null}
        {left.length > 0 && !searching ? (
          <View>
            <Heading label={E.didntFit} />
            {left.map((w) => {
              const l = labelOf(w);
              return (
                <ItemRow
                  key={w.id}
                  type={w.type}
                  mark={l.mark}
                  name={l.name}
                  line={l.of ?? ''}
                  size={gridText(w.w, w.h)}
                  here={false}
                  onPress={() => onAddBack(w)}
                />
              );
            })}
          </View>
        ) : null}
        {rest.map((section) => (
          <View key={section.key}>
            <Heading label={section.label} />
            {section.rows.map((row) => (
              <ItemRow
                key={row.key}
                type={row.item.type}
                mark={row.mark}
                icon={rowIcon(row)}
                name={row.name}
                line={row.line}
                size={gridText(row.size.w, row.size.h)}
                here={row.here}
                onPress={() => onAdd(row)}
              />
            ))}
          </View>
        ))}
        {catalog && sections.length === 0 && searching ? (
          <Text
            size={14}
            lh={1.45}
            color={theme.colors.mut}
            style={{ paddingHorizontal: 26, paddingVertical: 16 }}
          >
            {fillDeskWords(E.noMatch, { q: query.trim() })}
          </Text>
        ) : null}
        <View
          style={{
            marginHorizontal: 20,
            marginTop: 14,
            padding: 14,
            borderRadius: 14,
            backgroundColor: theme.colors.sf2,
          }}
        >
          <Text size={13.5} lh={1.45} color={theme.colors.ink2}>
            {fillDeskWords(E.ask, { assistant })}
          </Text>
        </View>
      </ScrollView>
    </Sheet>
  );
}

/** A section's heading: its name in capitals, a header for TalkBack. */
function Heading({ label }: { label: string }) {
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 2 }}>
      <SectionLabel>{label.toUpperCase()}</SectionLabel>
    </View>
  );
}

/** Whombat's own (DK-163): tiles three to a row, each its icon and name; one on the page already is dimmed with a check. */
function OwnTiles({ section, onAdd }: { section: CatalogRows; onAdd: (row: CatalogEntry) => void }) {
  const rows: (CatalogEntry | null)[][] = [];
  for (let i = 0; i < section.rows.length; i += 3) {
    const three: (CatalogEntry | null)[] = section.rows.slice(i, i + 3);
    while (three.length < 3) three.push(null);
    rows.push(three);
  }
  return (
    <View>
      <Heading label={section.label} />
      <View style={{ paddingHorizontal: 20, gap: 8 }}>
        {rows.map((three) => (
          <View key={three.map((t) => t?.key ?? '').join(' ')} style={{ flexDirection: 'row', gap: 8 }}>
            {three.map((row, i) =>
              row ? (
                <OwnTile key={row.key} row={row} onPress={() => onAdd(row)} />
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: the empty places at the end of the last row
                <View key={i} style={{ flex: 1 }} />
              ),
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

function OwnTile({ row, onPress }: { row: CatalogEntry; onPress: () => void }) {
  const theme = useTheme();
  const label = fillDeskWords(E.addOne, { name: row.name });
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={row.here ? `${label}, ${E.onThisPage}` : label}
      accessibilityHint={row.line || undefined}
      onPress={onPress}
      feedback="wash"
      ringRadius={14}
      style={{
        flex: 1,
        minHeight: 76,
        alignItems: 'center',
        gap: 6,
        paddingTop: 12,
        paddingBottom: 10,
        paddingHorizontal: 6,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
      }}
    >
      <View style={{ opacity: row.here ? 0.6 : 1, alignItems: 'center', gap: 6 }}>
        <WidgetLogo type={row.item.type} name={row.name} size={28} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
          {row.here ? <Check size={12} color={theme.colors.ink2} /> : null}
          <Text
            size={13}
            weight={500}
            lh={1.25}
            numberOfLines={2}
            style={{ flexShrink: 1, textAlign: 'center' }}
          >
            {row.name}
          </Text>
        </View>
      </View>
    </Touchable>
  );
}

/** An item: its mark, name (with *On this page*), line and size, and +; the whole row adds it. */
function ItemRow({
  type,
  mark,
  icon,
  name,
  line,
  size,
  here,
  onPress,
}: {
  type: DeskWidget['type'];
  mark: string | null | undefined;
  icon?: LucideIcon | undefined;
  name: string;
  line: string;
  size: string;
  here: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const spoken = [fillDeskWords(E.addOne, { name }), size, here ? E.onThisPage : null]
    .filter(Boolean)
    .join(', ');
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      accessibilityHint={line || undefined}
      onPress={onPress}
      feedback="wash"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 10,
        paddingHorizontal: 20,
      }}
    >
      <WidgetLogo type={type} mark={mark} name={name} icon={icon} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
          <Text size={15} weight={500} lh={1.35}>
            {name}
          </Text>
          {here ? (
            <View
              style={{
                paddingHorizontal: 7,
                paddingVertical: 1,
                borderRadius: 6,
                backgroundColor: theme.colors.sf2,
              }}
            >
              <Text size={11.5} weight={500} color={theme.colors.mut}>
                {E.onThisPage}
              </Text>
            </View>
          ) : null}
        </View>
        {line ? (
          <Text size={13} lh={1.4} color={theme.colors.mut} numberOfLines={2}>
            {line}
          </Text>
        ) : null}
      </View>
      <Text size={12.5} color={theme.colors.mut}>
        {size}
      </Text>
      <View
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
        <Plus size={16} color={theme.colors.ink} />
      </View>
    </Touchable>
  );
}
