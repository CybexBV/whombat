/**
 * A screen's layout on the phone (Whombat desk-display.md DK-129…DK-133, DK-143…DK-145, DK-163…DK-167, DK-180…DK-185;
 * desk-display-android.md AP-6010…AP-6022, AP-9980…, AP-9995…; the mockups' `editor.html`, the phone's way): “‹ {where
 * it came from}” with *Undo* and *Save*; the screen's name with what it is, its grid and pages, and *Not saved yet*
 * while it isn't; the pages as chips with *+ Page* and *Ask {assistant}* (a thread asking for a page); *Rearranged for
 * 10 × 6.* when the page has no layout of its own for this shape; the grid as labelled tiles (touch one for its sheet:
 * Move, Size, its settings, Remove); what didn't fit; *Add a widget* (a sheet; what it adds opens its own sheet) and
 * *Try on the screen*; then THIS PAGE (its name, its times, *Tidy up*, its place, Delete page) and THIS SCREEN (Size,
 * Pages turn). Everything is a draft until Save (`desk.screen.update {layout, show}`; a refused layout said plainly);
 * leaving with changes asks first. The rules are `@whombat/client/desk`'s editor, the web's too; the draft around them
 * is `draft.ts`.
 */
import { type RouteProp, useRoute } from '@react-navigation/native';
import {
  applyDeskShowPatch,
  type CatalogEntry,
  catalogFind,
  catalogGroupOf,
  catalogName,
  catalogServers,
  DESK_SCREEN_WORDS,
  DESK_SCREENS_TEXT,
  DESK_SIZES,
  DESK_TURNS,
  DESK_WORDS,
  type DeskApi,
  type DeskPageShow,
  type DeskScreenDetail,
  type DeskSize,
  type DeskTurn,
  type DeskWidget,
  deskErrorText,
  deskLayoutWidgets,
  draftProblem,
  fillDeskWords,
  gridText,
  type NewWidget,
  pageShowSaid,
  pageWhenText,
  refusalText,
  sameLayout,
  screenLines,
  screensErrorText,
  serverParts,
  type ViewOf,
} from '@whombat/client/desk';
import {
  useDesk,
  useDeskScreen,
  useDeskScreenActions,
  useDeskScreenViews,
  useDeskWidgets,
} from '@whombat/client/desk/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { TOAST_COPY, toasts } from '../../data/toast';
import { useAgentWords } from '../../data/useAgent';
import { Field } from '../../managed/ui';
import { useDeskApi } from '../../managed/useDesk';
import { useAppNavigation } from '../../navigation/hooks';
import type { RootStackParamList } from '../../navigation/routes';
import { NewChatSheet } from '../../screens/NewChatSheet';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { BackBar, Screen } from '../../ui/headers';
import { KeyboardAvoidingView } from '../../ui/keyboard';
import { Button, ErrorState, Loading, SectionLabel } from '../../ui/primitives';
import { Segmented } from '../../ui/Segmented';
import { useBottomRoom } from '../../ui/screenBottom';
import { useAfterSheet } from '../../ui/sheet';
import { Touchable } from '../../ui/Touchable';
import { AddWidgetSheet } from './AddWidgetSheet';
import {
  accountGroup,
  accountName,
  fromCatalog,
  onAnotherServer,
  widgetLimits,
  widgetPrivate,
} from './catalog';
import {
  canNudge,
  type Draft,
  type DraftResult,
  draftAdd,
  draftAddPage,
  draftChoose,
  draftDeletePage,
  draftDirty,
  draftGoPage,
  draftGrow,
  draftMovePage,
  draftNudge,
  draftOf,
  draftPage,
  draftPageShow,
  draftRemove,
  draftRenamePage,
  draftResize,
  draftSaved,
  draftSelect,
  draftShow,
  draftSize,
  draftSpec,
  draftTidy,
  draftTurn,
  draftUndo,
} from './draft';
import { AskPageChip, PageChip, PageTimesSheet } from './PageTimes';
import { TileGrid } from './TileGrid';
import { didntFitLine, type KnownWidget, PHONE_SCREENS_TEXT, type TileLabel, tileLabel } from './tiles';
import { WidgetSheet, type WidgetSheetActions } from './WidgetSheet';

const E = DESK_SCREENS_TEXT.editor;
const M = PHONE_SCREENS_TEXT;
/** A refusal in words: the screens' own, else the desk's (the box's choices before its screen is paired: `not_paired`). */
const failed = (error: unknown) =>
  Alert.alert('That didn’t go through', screensErrorText(error, deskErrorText(error)));

export function SettingsScreenLayout() {
  const route = useRoute<RouteProp<RootStackParamList, 'SettingsScreenLayout'>>();
  const navigation = useAppNavigation();
  const { screen: id, back = DESK_SCREENS_TEXT.back } = route.params;
  const api = useDeskApi();
  const detail = useDeskScreen(api, id);
  if (api && detail.data) return <Editor api={api} screen={detail.data} back={back} />;
  return (
    <Screen>
      <BackBar label={back} onPress={() => navigation.goBack()} />
      {detail.error ? (
        <ErrorState text={screensErrorText(detail.error)} onRetry={() => void detail.refetch()} />
      ) : (
        <Loading />
      )}
    </Screen>
  );
}

function Editor({ api, screen, back }: { api: DeskApi; screen: DeskScreenDetail; back: string }) {
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const navigation = useAppNavigation();
  const assistant = useAgentWords().name;
  const actions = useDeskScreenActions(api);
  const desk = useDesk(api).data;
  const [draft, setDraft] = useState<Draft>(() => draftOf(screen));
  const [known, setKnown] = useState<Record<string, KnownWidget>>({});
  const [sheet, setSheet] = useState<'add' | 'widget' | null>(null);
  const [timing, setTiming] = useState(false);
  const [asking, setAsking] = useState(false);
  const { timeZone } = useBurrowBase();
  const [saving, setSaving] = useState(false);
  const [trying, setTrying] = useState<number | null>(null);

  // The screen changed elsewhere (or said a new size) while nothing here is changed: start from it.
  useEffect(() => {
    setDraft((d) => {
      const sameSize = d.size?.width === screen.size?.width && d.size?.height === screen.size?.height;
      if (draftDirty(d) || (sameLayout(d.saved, screen.layout) && sameSize)) return d;
      return { ...draftOf(screen), page: Math.min(d.page, screen.layout.pages.length - 1) };
    });
  }, [screen]);

  // The views of the draft's widgets: their names and marks for the tiles, a panel's kind for its sizes.
  const specs = useMemo(() => deskLayoutWidgets(draft.layout), [draft.layout]);
  const viewsRead = useDeskScreenViews(api, specs.length > 0 ? { screen: screen.id, widgets: specs } : null);
  // A widget whose *What it shows* changed here is drawn as the item it shows now (`known`) until its view is read again.
  const [rechosen, setRechosen] = useState<ReadonlySet<string>>(new Set());
  const fresh = viewsRead.data !== undefined && !viewsRead.isPlaceholderData;
  // biome-ignore lint/correctness/useExhaustiveDependencies: each fresh read of the views lets the chosen ones go
  useEffect(() => {
    if (fresh) setRechosen((was) => (was.size ? new Set() : was));
  }, [fresh, viewsRead.dataUpdatedAt]);
  const views = useMemo(
    () => viewsRead.data?.views.filter((v) => !rechosen.has(v.id)),
    [viewsRead.data, rechosen],
  );
  const catalog = useDeskWidgets(api, { screen: screen.id }).data;
  // An account's widget is drawn as its catalogue item says, which knows it at once after it switched to another of
  // its account's widgets here (the views read before still draw the one it was until they're read again).
  const accountItem = useCallback(
    (id: string) => {
      const spec = specs.find((s) => s.id === id);
      return spec && accountGroup(catalog, spec.ref) ? catalogFind(catalog, spec) : null;
    },
    [specs, catalog],
  );
  const viewOf = useCallback<ViewOf>(
    (w) => accountItem(w.id)?.item.view ?? views?.find((v) => v.id === w.id)?.kind ?? known[w.id]?.view,
    [views, known, accountItem],
  );
  const labelOf = useCallback(
    (w: DeskWidget): TileLabel => {
      const account = accountItem(w.id);
      if (account)
        return {
          name: account.item.name,
          of: accountName(account.group),
          mark: account.item.mark ?? account.group.mark ?? null,
          view: account.item.view ?? null,
        };
      // A server's part is named from the catalogue, which knows it after its part changed here too.
      const item = w.type === 'server' ? catalogFind(catalog, w) : null;
      const named: KnownWidget | undefined = item
        ? {
            name: catalogName(item.group, item.item),
            ...(item.item.mark ? { mark: item.item.mark } : {}),
            ...(item.item.view ? { view: item.item.view } : {}),
          }
        : known[w.id];
      return tileLabel(
        w,
        views?.find((v) => v.id === w.id),
        named,
        assistant,
      );
    },
    [views, known, catalog, assistant, accountItem],
  );
  const servers = useMemo(() => catalogServers(catalog), [catalog]);

  const page = draftPage(draft, viewOf);
  const dirty = draftDirty(draft);
  const picked = draft.selected ? (page.widgets.find((w) => w.id === draft.selected) ?? null) : null;
  // Its *What it shows*: every view of its connection, server or account, read whole where the catalogue listed part.
  const pickedGroup = picked ? catalogGroupOf(catalog, picked) : null;
  const whole = useDeskWidgets(
    api,
    pickedGroup?.partial && pickedGroup.thing ? { screen: screen.id, thing: pickedGroup.thing } : null,
  );
  const choiceGroup =
    (pickedGroup?.partial ? whole.data?.groups.find((g) => g.thing === pickedGroup.thing) : undefined) ??
    pickedGroup;
  const choicesReading = !!pickedGroup?.partial && !whole.data && !whole.error;
  const show = useMemo(() => applyDeskShowPatch(screen.show, draft.show ?? {}), [screen.show, draft.show]);
  const lines = screenLines(
    { ...screen, layout: draft.layout, pages: draft.layout.pages.length },
    { box: desk?.display ?? null },
  );

  // Leaving with changes asks first (the web's “Leave without saving?”).
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (e) => {
        if (!dirtyRef.current) return;
        e.preventDefault();
        Alert.alert(E.leaveTitle, E.leaveLine, [
          { text: E.stay, style: 'cancel' },
          { text: E.leave, style: 'destructive', onPress: () => navigation.dispatch(e.data.action) },
        ]);
      }),
    [navigation],
  );

  useEffect(() => {
    if (trying === null) return;
    const t = setTimeout(() => setTrying(null), Math.max(0, trying - Date.now()));
    return () => clearTimeout(t);
  }, [trying]);

  // A sheet covers the toasts (a modal is above the app), so what a sheet's button did or couldn't do is said in it.
  const [sheetNote, setSheetNote] = useState<{ text: string; ok: boolean } | null>(null);
  const openSheet = (next: 'add' | 'widget' | null) => {
    setSheet(next);
    setSheetNote(null);
  };
  const after = useAfterSheet();
  const say = (text: string, ok = false) => (sheet ? setSheetNote({ text, ok }) : toasts.show(text));
  const swappedText = (w: DeskWidget, other: string) => {
    const b = page.widgets.find((x) => x.id === other);
    return fillDeskWords(E.swapped, { a: labelOf(w).name, b: b ? labelOf(b).name : other });
  };
  const apply = (r: DraftResult) => {
    if (r.ok) {
      setDraft(r.draft);
      setSheetNote(null);
      // Two widgets that changed places say so (DK-167).
      if (r.swapped && picked) say(swappedText(picked, r.swapped), true);
    } else say(refusalText(r.why, r.size, r.grow));
  };
  const undo = () => {
    const back = draftUndo(draft);
    if (!back) return;
    setDraft(back);
    toasts.show(E.undone);
  };
  /** A toast whose Undo takes the change back. */
  const undoable = (text: string) =>
    toasts.show(text, {
      action: { label: TOAST_COPY.undo, onPress: () => setDraft((d) => draftUndo(d) ?? d) },
    });

  /** Adds a widget, chosen, and opens its sheet once *Add a widget* is down (DK-163). */
  const add = (widget: NewWidget, name: string, remember?: KnownWidget) => {
    const r = draftAdd(draft, widget, viewOf, remember?.view);
    if (!r.ok) return say(refusalText(r.why));
    if (remember) setKnown((k) => ({ ...k, [r.id]: remember }));
    setDraft(r.draft);
    openSheet(null);
    after.later(() => openSheet('widget'));
    toasts.show(fillDeskWords(r.smaller ? E.addedSmaller : E.added, { name }));
  };
  const addFromCatalog = (row: CatalogEntry) => {
    const { widget, known: remember } = fromCatalog(row.item, row.group);
    add(widget, remember.name, remember);
  };
  const addBack = (w: DeskWidget) =>
    add(
      { id: w.id, type: w.type, ...(w.ref ? { ref: w.ref } : {}), opts: w.opts, w: w.w, h: w.h },
      labelOf(w).name,
    );

  const widgetActions: WidgetSheetActions | null = picked
    ? {
        nudge: (dx, dy) => apply(draftNudge(draft, picked.id, dx, dy, viewOf)),
        grow: (dim, by) => apply(draftGrow(draft, picked.id, dim, by, viewOf)),
        resize: (w, h) => apply(draftResize(draft, picked.id, { w, h }, viewOf)),
        canNudge: (dx, dy) => canNudge(draft, picked.id, dx, dy, viewOf),
        setOpts: (opts) => setDraft(draftSpec(draft, picked.id, { opts }, viewOf)),
        setRef: (ref) =>
          setDraft(
            draftSpec(
              draft,
              picked.id,
              { ref, opts: onAnotherServer(picked.opts, serverParts(catalog, ref)) },
              viewOf,
            ),
          ),
        choose: (item) => {
          const r = draftChoose(draft, picked.id, item, viewOf);
          if (r.ok && choiceGroup) {
            // Named and sized as the view it shows now until that view is read.
            setKnown((k) => ({ ...k, [picked.id]: fromCatalog(item, choiceGroup).known }));
            setRechosen((was) => new Set([...was, picked.id]));
          }
          apply(r);
        },
        setShow: (patch) => setDraft(draftShow(draft, patch)),
        remove: () => {
          const name = labelOf(picked).name;
          setDraft(draftRemove(draft, picked.id, viewOf));
          openSheet(null);
          undoable(fillDeskWords(E.removed, { name }));
        },
      }
    : null;
  const tidy = () => {
    const r = draftTidy(draft, viewOf);
    if (!r.ok) return toasts.show(refusalText(r.why));
    if (r.moved === 0) return toasts.show(E.alreadyTidy);
    setDraft(r.draft);
    undoable(E.tidied);
  };

  const save = () => {
    if (draftProblem(draft.layout, viewOf)) return Alert.alert(E.save, DESK_WORDS.errors.bad_layout);
    setSaving(true);
    actions
      .update({ screen: screen.id, layout: draft.layout, ...(draft.show ? { show: draft.show } : {}) })
      .then(
        (saved) => {
          setSaving(false);
          setDraft((d) => draftSaved(d, saved.layout));
          toasts.show(E.saved);
        },
        (e: unknown) => {
          setSaving(false);
          failed(e);
        },
      );
  };
  const tryIt = () =>
    actions.tryLayout({ screen: screen.id, layout: draft.layout }).then((r) => {
      const until = Date.parse(r.until);
      setTrying(Number.isFinite(until) ? until : Date.now() + 60_000);
      toasts.show(M.tryIt);
    }, failed);

  const pageName = draft.layout.pages[draft.page]?.name ?? '';
  const sizeNote = (size: DeskSize) => {
    const next = draftSize(draft, size);
    setDraft(next);
    const p = draftPage(next, viewOf);
    const grid = gridText(p.grid.cols, p.grid.rows);
    toasts.show(
      p.rearranged
        ? p.left.length > 0
          ? fillDeskWords(E.sizeChangedLeft, { grid, n: p.left.length })
          : fillDeskWords(E.sizeChanged, { grid })
        : fillDeskWords(E.sizeOwn, { grid }),
    );
  };
  const turnNote = (turn: DeskTurn) => {
    setDraft(draftTurn(draft, turn));
    toasts.show(turn === 'touch' ? E.turnTouch : fillDeskWords(E.turnAuto, { every: E.every[turn] }));
  };
  const missing = didntFitLine(page.left.length);

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingRight: 16 }}>
        <View style={{ flex: 1 }}>
          <BackBar label={back} onPress={() => navigation.goBack()} />
        </View>
        <Button label={E.undo} variant="quiet" disabled={draft.undo.past.length === 0} onPress={undo} />
        <Button
          label={saving ? E.saving : E.save}
          disabled={!dirty}
          busy={saving}
          onPress={save}
          style={{ marginLeft: 8, paddingHorizontal: 18 }}
        />
      </View>
      <KeyboardAvoidingView style={{ flex: 1 }}>
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 2,
            paddingBottom: 32 + bottomRoom,
            gap: 16,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ gap: 4, paddingHorizontal: 6 }}>
            <Text size={25} weight={700} lh={1.15} tracking={-0.02} accessibilityRole="header">
              {screen.name}
            </Text>
            <Text size={13.5} lh={1.4} color={theme.colors.mut}>
              {lines.what}
            </Text>
            {dirty ? (
              <Text size={13.5} weight={500} color={theme.colors.warn} accessibilityLiveRegion="polite">
                {E.dirty}
              </Text>
            ) : null}
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, alignItems: 'center', paddingVertical: 7, paddingHorizontal: 2 }}
            accessibilityRole="tablist"
            accessibilityLabel={DESK_SCREENS_TEXT.page.layout}
          >
            {draft.layout.pages.map((p, i) => (
              <PageChip
                key={p.id}
                page={p}
                active={i === draft.page}
                onPress={() => setDraft(draftGoPage(draft, i))}
              />
            ))}
            <AddPageChip
              onPress={() => {
                const r = draftAddPage(draft);
                apply(r);
                if (r.ok) toasts.show(M.newPage);
              }}
            />
            <AskPageChip label={fillDeskWords(E.askPage, { assistant })} onPress={() => setAsking(true)} />
          </ScrollView>
          {page.rearranged ? (
            <View
              style={{
                padding: 12,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: theme.colors.line,
                backgroundColor: theme.colors.sf2,
              }}
            >
              <Text size={13.5} lh={1.45} color={theme.colors.ink2}>
                <Text size={13.5} lh={1.45} weight={600}>
                  {fillDeskWords(E.rearranged, { grid: gridText(page.grid.cols, page.grid.rows) })}
                </Text>
                {fillDeskWords(E.rearrangedRest, { from: page.from.replace('x', ' × ') })}
              </Text>
            </View>
          ) : null}
          <TileGrid
            grid={page.grid}
            widgets={page.widgets}
            labelOf={labelOf}
            selected={draft.selected}
            onPress={(id) => {
              setDraft(draftSelect(draft, id));
              openSheet('widget');
            }}
            empty={M.emptyPage}
          />
          <Text size={13} lh={1.4} color={theme.colors.mut} style={{ paddingHorizontal: 6, marginTop: -6 }}>
            {missing ? `${M.tapHint} ${missing}` : M.tapHint}
          </Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button label={E.addWidget} onPress={() => openSheet('add')} style={{ flex: 1 }} />
            <Button label={E.try} variant="secondary" onPress={() => void tryIt()} style={{ flex: 1 }} />
          </View>
          {trying !== null ? (
            <Text
              size={14}
              weight={500}
              lh={1.4}
              accessibilityLiveRegion="polite"
              style={{ paddingHorizontal: 6 }}
            >
              {M.trying}
            </Text>
          ) : null}
          <PageCard
            key={draft.layout.pages[draft.page]?.id}
            name={pageName}
            index={draft.page}
            count={draft.layout.pages.length}
            show={draft.layout.pages[draft.page]?.show ?? null}
            onTimes={() => setTiming(true)}
            onRename={(name) => setDraft(draftRenamePage(draft, draft.page, name))}
            onTidy={page.widgets.length > 0 ? tidy : null}
            onMove={(by) => setDraft(draftMovePage(draft, draft.page, by))}
            onDelete={() => {
              const r = draftDeletePage(draft, draft.page);
              apply(r);
              if (r.ok) undoable(fillDeskWords(E.deletedPage, { name: pageName }));
            }}
          />
          <View style={{ gap: 8 }}>
            <SectionLabel>{M.screen.toUpperCase()}</SectionLabel>
            <View
              style={{
                gap: 12,
                padding: 16,
                borderRadius: 20,
                borderWidth: 1,
                borderColor: theme.colors.line,
                backgroundColor: theme.colors.sf,
              }}
            >
              <Text size={15} weight={500}>
                {E.size}
              </Text>
              <Segmented<DeskSize>
                options={DESK_SIZES.map((value) => ({ value, label: DESK_SCREEN_WORDS.sizes[value] }))}
                value={draft.layout.size}
                onChange={sizeNote}
                label={E.size}
              />
              <Text size={13} lh={1.4} color={theme.colors.mut}>
                {M.sizeHint}
              </Text>
              <Text size={15} weight={500} style={{ marginTop: 4 }}>
                {E.turn}
              </Text>
              <Segmented<DeskTurn>
                options={DESK_TURNS.map((value) => ({ value, label: DESK_SCREEN_WORDS.turns[value] }))}
                value={draft.layout.turn}
                onChange={turnNote}
                label={E.turn}
                fit
              />
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      <WidgetSheet
        visible={sheet === 'widget' && picked !== null}
        onClose={() => openSheet(null)}
        widget={picked}
        label={picked ? labelOf(picked) : null}
        grid={page.grid}
        viewOf={viewOf}
        actions={widgetActions ?? NO_ACTIONS}
        note={sheetNote?.text ?? null}
        noteTone={sheetNote?.ok ? 'ok' : 'bad'}
        options={desk?.showOptions}
        pairFirst={screen.kind === 'box' && desk?.paired === null}
        lockable={picked ? widgetPrivate(picked, catalog?.groups ?? [], viewOf(picked)) : false}
        limits={picked ? widgetLimits(picked, catalog?.groups ?? []) : false}
        show={show}
        servers={servers}
        choices={choiceGroup?.items ?? []}
        reading={choicesReading}
      />
      <AddWidgetSheet
        visible={sheet === 'add'}
        onClose={() => openSheet(null)}
        onDismissed={after.onDismissed}
        catalog={catalog}
        onPage={page.widgets}
        left={page.left}
        labelOf={labelOf}
        note={sheetNote?.text ?? null}
        onAdd={addFromCatalog}
        onAddBack={addBack}
      />
      <PageTimesSheet
        visible={timing}
        name={pageName}
        show={draft.layout.pages[draft.page]?.show ?? null}
        timeZone={timeZone}
        onClose={() => setTiming(false)}
        onSave={(show: DeskPageShow | null) => {
          const next = draftPageShow(draft, draft.page, show);
          if (!next) return E.times.noDays;
          setDraft(next);
          setTiming(false);
          undoable(pageShowSaid(pageName, show ? (next.layout.pages[draft.page]?.show ?? show) : null));
          return null;
        }}
      />
      <NewChatSheet
        visible={asking}
        onClose={() => setAsking(false)}
        back={screen.name}
        initialText={fillDeskWords(E.askPageDraft, { screen: screen.name })}
        words={{
          title: fillDeskWords(E.askPage, { assistant }),
          label: fillDeskWords(E.askPage, { assistant }),
          placeholder: E.askPageField,
        }}
      />
    </Screen>
  );
}

/** *+ Page* beside the page chips, in their shape (a button, not a tab; 44dp with the chips' slop). */
function AddPageChip({ onPress }: { onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      accessibilityRole="button"
      accessibilityLabel={E.addPage}
      onPress={onPress}
      feedback="wash"
      ringRadius={999}
      hitSlop={{ top: 7, bottom: 7 }}
      style={{
        paddingVertical: 7,
        paddingHorizontal: 13,
        borderRadius: 999,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: theme.colors.line2,
      }}
    >
      <Text size={14} weight={500} color={theme.colors.ink2}>
        {E.addPage}
      </Text>
    </Touchable>
  );
}

const NO_ACTIONS: WidgetSheetActions = {
  nudge: () => {},
  grow: () => {},
  resize: () => {},
  canNudge: () => false,
  setOpts: () => {},
  setRef: () => {},
  choose: () => {},
  setShow: () => {},
  remove: () => {},
};

/**
 * THIS PAGE: its name (kept when the field is left), *Show at set times…* (with when it shows), *Tidy up* (DK-166),
 * Move left and Move right among the pages, Delete page.
 */
function PageCard({
  name,
  index,
  count,
  show,
  onTimes,
  onRename,
  onTidy,
  onMove,
  onDelete,
}: {
  name: string;
  index: number;
  count: number;
  show: DeskPageShow | null;
  onTimes: () => void;
  onRename: (name: string) => void;
  /** Null on an empty page. */
  onTidy: (() => void) | null;
  onMove: (by: -1 | 1) => void;
  onDelete: () => void;
}) {
  const theme = useTheme();
  const [typed, setTyped] = useState(name);
  useEffect(() => setTyped(name), [name]);
  const keep = () => (typed.trim() ? onRename(typed) : setTyped(name));
  return (
    <View style={{ gap: 8 }}>
      <SectionLabel>{M.page.toUpperCase()}</SectionLabel>
      <View
        style={{
          gap: 12,
          padding: 16,
          borderRadius: 20,
          borderWidth: 1,
          borderColor: theme.colors.line,
          backgroundColor: theme.colors.sf,
        }}
      >
        <Field
          label={M.pageName}
          value={typed}
          onChangeText={setTyped}
          onEndEditing={keep}
          onSubmitEditing={keep}
          returnKeyType="done"
          maxLength={24}
          hint={M.pageNameHint}
        />
        <Button
          label={E.showAt}
          variant="secondary"
          onPress={onTimes}
          accessibilityHint={show ? fillDeskWords(E.times.label, { when: pageWhenText(show) }) : undefined}
        />
        {show ? (
          <Text size={13} lh={1.4} color={theme.colors.mut} style={{ marginTop: -4 }}>
            {fillDeskWords(E.times.label, { when: pageWhenText(show) })}
          </Text>
        ) : null}
        <Button
          label={E.tidy}
          variant="secondary"
          disabled={!onTidy}
          onPress={() => onTidy?.()}
          accessibilityLabel={`${E.tidy}, ${name}`}
        />
        {count > 1 ? (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              label={E.moveLeft}
              variant="secondary"
              disabled={index === 0}
              onPress={() => onMove(-1)}
              accessibilityLabel={`${E.moveLeft}, ${name}`}
              style={{ flex: 1 }}
            />
            <Button
              label={E.moveRight}
              variant="secondary"
              disabled={index === count - 1}
              onPress={() => onMove(1)}
              accessibilityLabel={`${E.moveRight}, ${name}`}
              style={{ flex: 1 }}
            />
          </View>
        ) : null}
        <Button
          label={E.deletePage}
          variant="secondary"
          disabled={count <= 1}
          onPress={onDelete}
          accessibilityLabel={`${E.deletePage}, ${name}`}
          accessibilityHint={count <= 1 ? E.refused.lastPage : undefined}
        />
      </View>
    </View>
  );
}
