/**
 * *Add a widget* as a sheet on the phone (Whombat desk-display.md DK-139, DK-143, DK-145, DK-154, DK-155, DK-159;
 * desk-display-android.md AP-6017, AP-6032…, AP-6120…): a search field; *Didn’t fit after rearranging* first while a
 * rearranged page left some out (it never folds); then the sections, each under a heading that folds it — *Whombat and
 * {assistant}* and *Servers* folded at first, each server folded inside *Servers*, the connections, devices, *Your
 * accounts* (each account open inside it) and *Made by {assistant}* open; an account's widget without a brand mark of
 * its own has the icon of what it shows (a calendar, mail, a pull request), a photo or a board the icon of what it draws;
 * a thing that listed only part of what it has offers *Show its widgets*, which reads its whole list
 * (`desk.widgets {thing}`); and at the end how to ask the assistant for one that isn't there. A search opens whatever
 * matches. Each item is one row (56dp and more) that adds it to the first free spot, smaller if it must, with the size
 * it starts at and *On this page* when it's there already.
 */
import {
  DESK_SCREENS_TEXT,
  type DeskApi,
  type DeskCatalog,
  type DeskCatalogGroup,
  type DeskWidget,
  type DeskWidgetType,
  fillDeskWords,
  gridText,
} from '@whombat/client/desk';
import { useDeskWidgets } from '@whombat/client/desk/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useAgentWords } from '../../data/useAgent';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { ChevronDown, ChevronRight, CircleUser, type LucideIcon, Plus, Search } from '../../ui/icons';
import { SectionLabel } from '../../ui/primitives';
import { Sheet } from '../../ui/sheet';
import { Touchable } from '../../ui/Touchable';
import {
  accountName,
  accountShows,
  type CatalogGroupView,
  type CatalogRow,
  type CatalogSectionView,
  catalogView,
} from './catalog';
import { type TileLabel, widgetsText } from './tiles';
import { ACCOUNT_ICONS, VIEW_ICONS, WidgetLogo } from './WidgetLogo';

const E = DESK_SCREENS_TEXT.editor;

/** The icon a section's heading has where it has no mark of its own. */
const SECTION_ICON: Record<CatalogSectionView['kind'], DeskWidgetType> = {
  own: 'clock',
  servers: 'server',
  thing: 'panel',
  accounts: 'figures',
  widgets: 'widget',
};
/** Where a section's heading has an icon of its own: the person's accounts. */
const SECTION_OWN_ICON: Partial<Record<CatalogSectionView['kind'], LucideIcon>> = { accounts: CircleUser };

/** An item's icon where it has no brand mark: what an account's widget shows, else what it draws (a photo, a board). */
function itemIcon(item: CatalogRow['item']): LucideIcon | undefined {
  const shows = accountShows(item);
  return shows ? ACCOUNT_ICONS[shows] : item.view ? VIEW_ICONS[item.view] : undefined;
}

export function AddWidgetSheet({
  visible,
  onClose,
  api,
  screen,
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
  api: DeskApi;
  screen: string;
  catalog: DeskCatalog | undefined;
  onPage: readonly DeskWidget[];
  /** What didn't fit after a rearranging, to put back. */
  left: readonly DeskWidget[];
  labelOf: (w: DeskWidget) => TileLabel;
  /** Why the last one couldn't be added (the page is full), said in the sheet: the toasts are behind it. */
  note: string | null;
  onAdd: (row: CatalogRow, group: CatalogGroupView) => void;
  onAddBack: (w: DeskWidget) => void;
}) {
  const theme = useTheme();
  const assistant = useAgentWords().name;
  const [query, setQuery] = useState('');
  // What the person folded or opened, kept while the editor is open (the sheet stays mounted between showings).
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  // The things whose whole list was asked for (*Show its widgets*), and what came back.
  const [asked, setAsked] = useState<ReadonlySet<string>>(new Set());
  const [read, setRead] = useState<Record<string, DeskCatalogGroup | undefined>>({});
  useEffect(() => {
    if (!visible) setQuery('');
  }, [visible]);
  const sections = useMemo(
    () => (catalog ? catalogView(catalog, { query, onPage, flipped, read }) : []),
    [catalog, query, onPage, flipped, read],
  );
  const flip = (key: string) =>
    setFlipped((was) => {
      const next = new Set(was);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const ask = (thing: string) => setAsked((was) => (was.has(thing) ? was : new Set([...was, thing])));
  // A read that failed offers *Show its widgets* again.
  const unask = useCallback(
    (thing: string) =>
      setAsked((was) => {
        const next = new Set(was);
        next.delete(thing);
        return next;
      }),
    [],
  );
  const onRead = useCallback(
    (thing: string, g: DeskCatalogGroup) => setRead((r) => (r[thing] === g ? r : { ...r, [thing]: g })),
    [],
  );
  const searching = query.trim() !== '';
  return (
    <Sheet visible={visible} onClose={onClose} label={E.addWidget} maxHeight="92%">
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
        {[...asked].map((thing) => (
          <ThingRead key={thing} api={api} screen={screen} thing={thing} onRead={onRead} onFailed={unask} />
        ))}
        {left.length > 0 && !searching ? (
          <View>
            <View style={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 2 }}>
              <SectionLabel>{E.didntFit.toUpperCase()}</SectionLabel>
            </View>
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
        {sections.map((section) => (
          <View key={section.key}>
            <FoldHead
              label={section.label}
              type={SECTION_ICON[section.kind]}
              icon={SECTION_OWN_ICON[section.kind]}
              mark={section.mark}
              line={section.groups.some((g) => g.more) ? '' : widgetsText(section.count)}
              open={!section.folded}
              searching={searching}
              onPress={() => flip(section.key)}
            />
            {section.folded
              ? null
              : section.groups.map((g) => (
                  <View key={g.key}>
                    {g.server || g.account ? (
                      <FoldHead
                        label={g.label}
                        type={g.server ? 'server' : 'panel'}
                        icon={g.account ? CircleUser : undefined}
                        mark={g.mark}
                        line={widgetsText(g.rows.length)}
                        open={!g.folded}
                        searching={searching}
                        onPress={() => flip(g.key)}
                        inner
                      />
                    ) : null}
                    {g.folded ? null : <Rows group={g} onAdd={onAdd} />}
                    {g.more && g.thing && !g.folded ? (
                      <MoreRow
                        loading={asked.has(g.thing)}
                        label={g.label}
                        onPress={() => g.thing && ask(g.thing)}
                      />
                    ) : null}
                  </View>
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

/** A thing's whole list, read once asked for (`desk.widgets {thing}`): its page may list more than the catalogue did. */
function ThingRead({
  api,
  screen,
  thing,
  onRead,
  onFailed,
}: {
  api: DeskApi;
  screen: string;
  thing: string;
  onRead: (thing: string, group: DeskCatalogGroup) => void;
  onFailed: (thing: string) => void;
}) {
  const r = useDeskWidgets(api, { screen, thing });
  const group = r.data?.groups.find((g) => g.thing === thing) ?? r.data?.groups[0];
  const failed = Boolean(r.error);
  useEffect(() => {
    if (group) onRead(thing, group);
    else if (failed) onFailed(thing);
  }, [group, failed, thing, onRead, onFailed]);
  return null;
}

/**
 * A section's heading, or a server's inside *Servers* or an account's inside *Your accounts* (`inner`, indented): its
 * mark or icon, name and how many it lists, folding or opening what's under it (a button, expanded or not). While
 * searching everything that matches is open and the heading doesn't fold.
 */
function FoldHead({
  label,
  type,
  icon,
  mark,
  line,
  open,
  searching,
  onPress,
  inner = false,
}: {
  label: string;
  type: DeskWidgetType;
  icon?: LucideIcon | undefined;
  mark: string | null;
  line: string;
  open: boolean;
  searching: boolean;
  onPress: () => void;
  inner?: boolean;
}) {
  const theme = useTheme();
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityState={{ expanded: open, disabled: searching }}
      accessibilityLabel={line ? `${label}, ${line}` : label}
      disabled={searching}
      onPress={onPress}
      feedback="wash"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 10,
        paddingLeft: inner ? 32 : 20,
        paddingRight: 20,
        borderTopWidth: inner ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <WidgetLogo type={type} mark={mark} name={label} icon={icon} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text size={15} weight={inner ? 500 : 600} lh={1.35}>
          {label}
        </Text>
        {line ? (
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {line}
          </Text>
        ) : null}
      </View>
      <Chevron size={18} color={theme.colors.mut} />
    </Touchable>
  );
}

/** *Show its widgets* under a thing that listed only part of what it has; *Reading its page…* while it's read. */
function MoreRow({ loading, label, onPress }: { loading: boolean; label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={`${loading ? E.loadingMore : E.more}, ${label}`}
      accessibilityState={{ busy: loading, disabled: loading }}
      disabled={loading}
      onPress={onPress}
      feedback="wash"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 48,
        paddingVertical: 10,
        paddingLeft: 64,
        paddingRight: 20,
      }}
    >
      <Text size={14.5} weight={500} color={loading ? theme.colors.mut : theme.colors.brand}>
        {loading ? E.loadingMore : E.more}
      </Text>
    </Touchable>
  );
}

function Rows({
  group,
  onAdd,
}: {
  group: CatalogGroupView;
  onAdd: (row: CatalogRow, group: CatalogGroupView) => void;
}) {
  // An account's widgets are under its heading with its mark: each has the icon of what it shows instead.
  const of = group.account ? accountName(group) : group.thing || group.server ? group.label : null;
  return (
    <>
      {group.rows.map((r) => (
        <ItemRow
          key={r.key}
          type={r.item.type}
          mark={r.item.mark ?? ((group.thing || group.server) && !group.account ? group.mark : null)}
          icon={itemIcon(r.item)}
          name={r.item.name}
          of={of}
          line={r.item.line}
          size={r.size}
          here={r.here}
          inner={group.server || group.account}
          onPress={() => onAdd(r, group)}
        />
      ))}
    </>
  );
}

/** An item: its mark, name (with *On this page*), line and size, and +; the whole row adds it. */
function ItemRow({
  type,
  mark,
  icon,
  name,
  of = null,
  line,
  size,
  here,
  inner = false,
  onPress,
}: {
  type: DeskWidget['type'];
  mark: string | null | undefined;
  icon?: LucideIcon | undefined;
  name: string;
  of?: string | null;
  line: string;
  size: string;
  here: boolean;
  /** Under a server's or an account's heading: indented with it. */
  inner?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const spoken = [
    fillDeskWords(E.addOne, { name: of ? `${name}, ${of}` : name }),
    size,
    here ? E.onThisPage : null,
  ]
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
        paddingLeft: inner ? 32 : 20,
        paddingRight: 20,
      }}
    >
      <WidgetLogo type={type} mark={mark} name={of ?? name} icon={icon} />
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
