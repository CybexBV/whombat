/**
 * A service's settings on the phone (Whombat service-settings.md SST-01…SST-09; mock service-dash-v2 screen 6): each
 * group's title as a section label over its card, with the group's Ask on the right, then a 56dp row per setting — its
 * name with who changed it last under it, then a switch (the whole row flips it at once), its value and a chevron that
 * opens the Change sheet, or its value and “In Plex” that opens the service's own page. A setting the viewer may not
 * change stays drawn, greyed, and says why when pressed. The sheet: its name, a sentence, the choices as 52dp cards with
 * “Now” on the current one, a hint, **Change it** (waits until another choice is picked) and **Ask {assistant}
 * instead**, and Put it back while the last change can be put back. A card's Ask (SST-08) opens “Ask {assistant} about
 * {title}” with its questions and “Or ask something else…”. Whatever opens after a sheet waits until it is down. Words
 * and arrangement: `data/serviceSettings.ts`.
 */

import { useQueryClient } from '@tanstack/react-query';
import { undoOutcome } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useUndoChange } from '@whombat/client/react';
import type { ThingButtonValue, ThingSetting } from '@whombat/core';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, Switch, View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import {
  canChange,
  type PanelAskView,
  panelAsk,
  SETTINGS_COPY,
  type SettingRowView,
  type SettingSheetView,
  sameChoice,
  settingRowView,
  settingSheet,
  type ThingSettingsPanel,
} from '../../data/serviceSettings';
import { thingPageCopy } from '../../data/thingPage';
import { useAgentWords } from '../../data/useAgent';
import { useI18n } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { BigButton, MonoLabel } from '../../ui/assistant';
import { Check, ChevronRight, MessageCircle } from '../../ui/icons';
import { Sheet, useAfterSheet } from '../../ui/sheet';
import { switchColors } from '../../ui/switchColors';
import { Touchable } from '../../ui/Touchable';
import { hitSlopFor } from '../../ui/touchTarget';
import { showNotice, useDecisionFeedback } from '../feedback';
import type { PanelContext } from './Panels';
import { CardQuiet } from './parts';

/**
 * Put it back (SST-03): undoes a setting's change (`changes.undo`, which runs the same action with the old value), then
 * reads the page again. Its refusal (“…was changed again since…”) is said in the server's words.
 */
export function usePutBack(thing: string): (changeId: string) => void {
  const { rawLocale } = useI18n();
  const thingPageCopyHere = thingPageCopy(rawLocale);

  const { slug } = useBurrowBase();
  const qc = useQueryClient();
  const undo = useUndoChange(slug);
  const feedback = useDecisionFeedback();
  const assistant = useAgentWords().name;
  return (changeId: string) => {
    undo
      .mutateAsync(changeId)
      .then((result) => {
        if (result.status !== 'ok') return feedback.onResult(result);
        if (result.data.state === 'requested') return showNotice(undoOutcome(result.data, assistant).message);
        showNotice(result.data.state === 'asked' ? thingPageCopyHere.undoAsked : SETTINGS_COPY.putBackDone);
      }, feedback.onError)
      .finally(() => {
        void qc.invalidateQueries({ queryKey: queryKeys.scope('things.page', { burrow: slug, thing }) });
        void qc.invalidateQueries({ queryKey: queryKeys.scope('changes.list', { burrow: slug }) });
      });
  };
}

/** A switch's guess key in the page's guesses, apart from the controls' ids. */
const guessKey = (id: string) => `setting:${id}`;

export function SettingsCard({ panel, ctx }: { panel: ThingSettingsPanel; ctx: PanelContext }) {
  const theme = useTheme();
  const assistant = useAgentWords();
  const ask = useMemo(() => panelAsk(panel, assistant.name), [panel, assistant.name]);
  const [open, setOpen] = useState<ThingSetting | null>(null);
  return (
    <View style={{ gap: 6 }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          paddingHorizontal: 4,
          paddingTop: 4,
          minHeight: 28,
        }}
      >
        <MonoLabel>{panel.title}</MonoLabel>
        {ask ? <AskLink ask={ask} about={panel.title} ctx={ctx} /> : null}
      </View>
      {panel.hint?.trim() ? (
        <Text size={13} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 4 }}>
          {panel.hint}
        </Text>
      ) : null}
      <View
        style={{
          backgroundColor: theme.colors.sf,
          borderWidth: 1,
          borderColor: theme.colors.line,
          borderRadius: 16,
          overflow: 'hidden',
        }}
      >
        {panel.rows.length === 0 ? <CardQuiet text={panel.empty ?? ''} first /> : null}
        {panel.rows.map((row, i) => (
          <SettingRow key={row.id} row={row} first={i === 0} ctx={ctx} onChoose={() => setOpen(row)} />
        ))}
      </View>
      <SettingSheet row={open} ctx={ctx} onClose={() => setOpen(null)} />
    </View>
  );
}

/* A row ----------------------------------------------------------------------------------------------------------- */

function SettingRow({
  row,
  first,
  ctx,
  onChoose,
}: {
  row: ThingSetting;
  first: boolean;
  ctx: PanelContext;
  onChoose: () => void;
}) {
  const { tClient } = useI18n();
  const theme = useTheme();
  const act = ctx.act ?? null;
  const view = useMemo(() => settingRowView(row, act?.guesses[guessKey(row.id)]?.value), [row, act?.guesses]);
  // A change is on its way: the value stays until the service said it took it (SST-02), with a spinner beside it.
  const choose = row.choose;
  const busy = !!act && !!choose && choose.choices.some((c) => act.buttons.running(choose.button, c.value));
  const style = {
    minHeight: 56,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderTopWidth: first ? 0 : 1,
    borderTopColor: theme.colors.line,
  };
  const refused = () => {
    if (view.reason) showNotice(view.reason);
  };
  if (view.look === 'switch' && row.toggle && act) {
    const button = row.toggle;
    const flip = () => {
      if (!view.allowed) return refused();
      const next = !view.on;
      act.buttons.press(button, {
        value: next,
        onSend: () => act.guess(guessKey(row.id), next),
        onDone: (r) => act.done(guessKey(row.id), r),
      });
    };
    return (
      <Touchable
        onPress={flip}
        feedback="wash"
        accessibilityRole="switch"
        accessibilityLabel={view.label}
        accessibilityHint={view.reason ?? view.note ?? undefined}
        accessibilityState={{ checked: view.on, disabled: !view.allowed }}
        style={style}
      >
        <RowWords view={view} />
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ marginVertical: -6 }}
        >
          <Switch
            value={view.on}
            disabled={!view.allowed}
            {...switchColors(theme, view.on)}
            style={{ opacity: view.allowed ? 1 : 0.45 }}
          />
        </View>
      </Touchable>
    );
  }
  if (view.look === 'choose' && row.choose) {
    return (
      <Touchable
        onPress={onChoose}
        feedback="wash"
        accessibilityRole="button"
        accessibilityLabel={view.spoken}
        accessibilityHint={view.reason ?? SETTINGS_COPY.opensChoices}
        accessibilityState={{ busy }}
        style={style}
      >
        <RowWords view={view} />
        {busy ? <ActivityIndicator size="small" color={theme.colors.mut} /> : null}
        <RowValue text={view.value} faded={!view.allowed} />
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <ChevronRight size={16} color={theme.colors.mut} strokeWidth={1.8} />
        </View>
      </Touchable>
    );
  }
  if (view.look === 'elsewhere' && view.url) {
    const url = view.url;
    return (
      <Touchable
        onPress={() => void Linking.openURL(url).catch(() => {})}
        feedback="wash"
        accessibilityRole="link"
        accessibilityLabel={view.spoken}
        accessibilityHint={SETTINGS_COPY.opensElsewhere(view.tag ?? '')}
        style={style}
      >
        <RowWords view={view} />
        <RowValue text={view.value} />
        {view.tag ? <Tag text={view.tag} /> : null}
      </Touchable>
    );
  }
  // Only shown: its value (an `elsewhere` without a page, a switch on a page without buttons).
  return (
    <View accessible accessibilityLabel={view.spoken} style={style}>
      <RowWords view={view} />
      {view.look === 'switch' ? (
        <RowValue text={view.on ? tClient('automations.on') : tClient('notifications.off')} />
      ) : (
        <>
          <RowValue text={view.value} />
          {view.tag ? <Tag text={view.tag} /> : null}
        </>
      )}
    </View>
  );
}

function RowWords({ view }: { view: SettingRowView }) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
      <Text size={15.5} weight={500} lh={1.3} numberOfLines={2}>
        {view.label}
      </Text>
      {view.note ? (
        <Text size={13} lh={1.3} color={theme.colors.mut} numberOfLines={1}>
          {view.note}
        </Text>
      ) : null}
    </View>
  );
}

function RowValue({ text, faded = false }: { text: string | null; faded?: boolean }) {
  const theme = useTheme();
  if (!text) return null;
  return (
    <Text
      size={15}
      color={theme.colors.mut}
      numberOfLines={1}
      style={{ flexShrink: 1, maxWidth: '45%', opacity: faded ? 0.7 : 1 }}
    >
      {text}
    </Text>
  );
}

/** “IN PLEX”: where the setting is changed instead (SST-05). */
function Tag({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: theme.colors.line2,
        borderRadius: 5,
        paddingHorizontal: 6,
        paddingVertical: 2,
      }}
    >
      <Text
        size={10.5}
        weight={500}
        mono
        uppercase
        tracking={0.03}
        color={theme.colors.mut}
        numberOfLines={1}
      >
        {text}
      </Text>
    </View>
  );
}

/* The Change sheet (SST-09) ---------------------------------------------------------------------------------------- */

function SettingSheet({
  row,
  ctx,
  onClose,
}: {
  row: ThingSetting | null;
  ctx: PanelContext;
  onClose: () => void;
}) {
  const theme = useTheme();
  const assistant = useAgentWords();
  const after = useAfterSheet();
  // The row it was opened for stays drawn while the sheet goes down.
  const [shown, setShown] = useState<ThingSetting | null>(row);
  useEffect(() => {
    if (row) setShown(row);
  }, [row]);
  const sheet = useMemo<SettingSheetView | null>(() => (shown ? settingSheet(shown) : null), [shown]);
  const [picked, setPicked] = useState<ThingButtonValue | null>(null);
  useEffect(() => {
    if (row) setPicked(row.choose?.current ?? null);
  }, [row]);
  const act = ctx.act ?? null;
  const ready = !!sheet && !!act && canChange(sheet, picked);
  const change = () => {
    const button = shown?.choose?.button;
    if (!ready || !button || !act || picked === null) return;
    onClose();
    act.buttons.press(button, { value: picked });
  };
  const askInstead = () => {
    if (!shown) return;
    const question = SETTINGS_COPY.helpChoose(shown.label, ctx.thing.name);
    onClose();
    after.later(() => ctx.run({ kind: 'ask', question }));
  };
  const putBack = () => {
    const id = sheet?.changeId;
    if (!id || !ctx.putBack) return;
    onClose();
    ctx.putBack(id);
  };
  return (
    <Sheet
      visible={!!row}
      onClose={onClose}
      onDismissed={after.onDismissed}
      label={sheet?.title ?? ''}
      surface="sf"
      maxHeight="90%"
    >
      {sheet ? (
        <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingTop: 4, paddingBottom: 8 }}>
          <Text size={20} weight={700} lh={1.25} accessibilityRole="header">
            {sheet.title}
          </Text>
          {sheet.help ? (
            <Text size={14.5} lh={1.45} color={theme.colors.ink2} style={{ marginTop: 4, marginBottom: 8 }}>
              {sheet.help}
            </Text>
          ) : null}
          {sheet.changed ? (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8 }}>
              <Text size={13} lh={1.4} color={theme.colors.ink2}>
                {sheet.changed}
              </Text>
              {sheet.changeId && ctx.putBack ? (
                <Touchable
                  onPress={putBack}
                  feedback="fade"
                  ringRadius={6}
                  accessibilityRole="button"
                  accessibilityLabel={SETTINGS_COPY.putBack}
                  accessibilityHint={sheet.changed}
                  hitSlop={hitSlopFor(28)}
                  style={{ minHeight: 28, justifyContent: 'center' }}
                >
                  <Text
                    size={13}
                    weight={600}
                    style={{ textDecorationLine: 'underline', textDecorationColor: theme.colors.line2 }}
                  >
                    {SETTINGS_COPY.putBack}
                  </Text>
                </Touchable>
              ) : null}
            </View>
          ) : null}
          <View accessibilityRole="radiogroup" accessibilityLabel={sheet.title}>
            {sheet.choices.map((c) => (
              <ChoiceCard
                key={c.key}
                label={c.label}
                note={c.note}
                now={c.now}
                spoken={c.spoken}
                picked={sameChoice(c.value, picked)}
                disabled={!sheet.allowed}
                onPress={() => setPicked(c.value)}
              />
            ))}
          </View>
          {sheet.hint ? (
            <View
              style={{
                flexDirection: 'row',
                gap: 10,
                marginTop: 14,
                paddingVertical: 11,
                paddingHorizontal: 14,
                borderRadius: 12,
                backgroundColor: theme.colors.sf2,
              }}
            >
              <View
                style={{ paddingTop: 2 }}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <Check size={16} color={theme.colors.ok} strokeWidth={2} />
              </View>
              <Text size={14} lh={1.45} color={theme.colors.ink2} style={{ flex: 1 }}>
                {sheet.hint}
              </Text>
            </View>
          ) : null}
          <View style={{ marginTop: 16 }}>
            <BigButton
              label={SETTINGS_COPY.changeIt}
              variant="primary"
              disabled={!ready}
              onPress={change}
              hint={sheet.reason ?? (ready ? undefined : SETTINGS_COPY.pickHint)}
            />
          </View>
          {sheet.reason ? (
            <Text size={13} lh={1.45} color={theme.colors.mut} style={{ marginTop: 8, textAlign: 'center' }}>
              {sheet.reason}
            </Text>
          ) : null}
          <Touchable
            onPress={askInstead}
            feedback="fade"
            ringRadius={10}
            accessibilityRole="button"
            accessibilityLabel={SETTINGS_COPY.askInstead(assistant.name)}
            style={{
              minHeight: 44,
              marginTop: 6,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
              <MessageCircle size={17} color={theme.colors.ink} strokeWidth={1.9} />
            </View>
            <Text size={15.5} weight={600}>
              {SETTINGS_COPY.askInstead(assistant.name)}
            </Text>
          </Touchable>
        </ScrollView>
      ) : null}
    </Sheet>
  );
}

/** One choice: a 52dp card with its ring, its label and note, and “NOW” on the current one; the picked one inked. */
function ChoiceCard({
  label,
  note,
  now,
  spoken,
  picked,
  disabled,
  onPress,
}: {
  label: string;
  note: string | null;
  now: boolean;
  spoken: string;
  picked: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      disabled={disabled}
      feedback="wash"
      ringRadius={12}
      accessibilityRole="radio"
      accessibilityLabel={spoken}
      accessibilityState={{ checked: picked, selected: picked, disabled }}
      style={{
        minHeight: 52,
        marginTop: 8,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingVertical: 11,
        paddingHorizontal: 14,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: picked ? theme.colors.ink : theme.colors.line,
        backgroundColor: picked ? theme.colors.sel : 'transparent',
        opacity: disabled && !picked ? 0.55 : 1,
      }}
    >
      <View
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          borderWidth: picked ? 5 : 2,
          borderColor: picked ? theme.colors.ink : theme.colors.line2,
        }}
      />
      <Text size={15} style={{ flex: 1, minWidth: 0 }} numberOfLines={2}>
        <Text size={15} weight={600}>
          {label}
        </Text>
        {note ? (
          <Text size={13.5} color={theme.colors.mut}>
            {` · ${note}`}
          </Text>
        ) : null}
      </Text>
      {now ? (
        <Text size={10.5} weight={500} mono uppercase tracking={0.04} color={theme.colors.mut}>
          {SETTINGS_COPY.now}
        </Text>
      ) : null}
    </Touchable>
  );
}

/* A card's Ask (SST-08) ------------------------------------------------------------------------------------------- */

/** The small “Ask” on a card's head: opens its questions. */
export function AskLink({ ask, about, ctx }: { ask: PanelAskView; about: string; ctx: PanelContext }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Touchable
        onPress={() => setOpen(true)}
        feedback="wash"
        ringRadius={8}
        accessibilityRole="button"
        accessibilityLabel={ask.title}
        accessibilityHint={SETTINGS_COPY.askHint(about)}
        hitSlop={hitSlopFor(28)}
        style={{
          minHeight: 28,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 6,
          paddingHorizontal: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: theme.colors.line,
        }}
      >
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <MessageCircle size={14} color={theme.colors.ink2} strokeWidth={1.9} />
        </View>
        <Text size={13.5} weight={500} color={theme.colors.ink2}>
          {SETTINGS_COPY.ask}
        </Text>
      </Touchable>
      <AskSheet ask={ask} visible={open} onClose={() => setOpen(false)} ctx={ctx} />
    </>
  );
}

function AskSheet({
  ask,
  visible,
  onClose,
  ctx,
}: {
  ask: PanelAskView;
  visible: boolean;
  onClose: () => void;
  ctx: PanelContext;
}) {
  const after = useAfterSheet();
  const pick = (question: string) => {
    onClose();
    after.later(() => ctx.run({ kind: 'ask', question }));
  };
  return (
    <Sheet visible={visible} onClose={onClose} onDismissed={after.onDismissed} label={ask.title} surface="sf">
      <View style={{ paddingHorizontal: 18, paddingTop: 4, paddingBottom: 8, gap: 8 }}>
        <Text size={18} weight={700} lh={1.3} accessibilityRole="header" style={{ marginBottom: 4 }}>
          {ask.title}
        </Text>
        {ask.questions.map((q) => (
          <AskRow key={q} text={q} onPress={() => pick(q)} />
        ))}
        <AskRow text={ask.other} muted onPress={() => pick('')} />
      </View>
    </Sheet>
  );
}

function AskRow({ text, muted = false, onPress }: { text: string; muted?: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={10}
      accessibilityRole="button"
      accessibilityLabel={text}
      style={{
        minHeight: 48,
        justifyContent: 'center',
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: muted ? theme.colors.line2 : theme.colors.line,
        backgroundColor: muted ? 'transparent' : theme.colors.bg,
      }}
    >
      <Text size={15} lh={1.35} color={muted ? theme.colors.mut : theme.colors.ink}>
        {text}
      </Text>
    </Touchable>
  );
}
