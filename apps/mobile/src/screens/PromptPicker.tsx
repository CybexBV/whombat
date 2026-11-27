/**
 * The person's prompts in their Chat on the phone (Whombat docs/decisions/prompts.md; app prompts-phone.md). Two ways
 * in: a `/` and one word typed as the whole draft lists the prompts that match over the reply box, and Prompts in the
 * box's “+” opens them all in a sheet. Each row is a prompt's title and its first line.
 * A prompt that isn't for a repository puts its words in the draft, nothing sent. One for a repository asks “Which
 * repository?”: T3 Code's projects with a search, the ones it ran on first with when; choosing one has Whombat post the
 * person's message (“Find what’s broken · Fusebox”) and hand the prompt to a new T3 Code thread there
 * (`prompts.use`), and the draft empties. While T3 Code isn't connected or can't be reached the sheet says so, with
 * “Put its words in the message”. A failure shows as a failed send does. Only in the person's own Chat, and only where
 * the Whombat keeps prompts.
 */

import { problemText, promptWords } from '@whombat/client';
import type { ChatRoom, Prompt, UsePromptResponse } from '@whombat/core';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, TextInput, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { type PromptRow, promptChoice, promptPickerView, promptRow, slashRows } from '../data/prompts';
import { usePromptProjects, usePrompts, useUsePrompt } from '../data/usePrompts';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { haptic } from '../ui/haptics';
import { Button } from '../ui/primitives';
import { Sheet, useAfterSheet } from '../ui/sheet';
import { Touchable } from '../ui/Touchable';
import { showFailure } from './feedback';

export interface PromptsInChat {
  /** Opens them all in a sheet: Prompts in the box's “+”. */
  open: () => void;
  /** Over the pill: the prompts the draft's `/` word matches. */
  above: (text: string) => ReactNode;
  /** The sheets: all prompts, and which repository. */
  sheets: ReactNode;
  /** The person's own messages here offer Save as prompt. */
  canSave: boolean;
}

/**
 * Prompts in a composer of the person's Chat (`room` 'chat'), its top level or a thread (`threadRootId`); null
 * elsewhere, or where the Whombat doesn't keep them. `fill` puts text in the draft ('' empties it), `onUsed` gets the
 * message Whombat posted.
 */
export function usePromptsInChat({
  room,
  conversationId,
  threadRootId,
  fill,
  onUsed,
}: {
  room: ChatRoom | null;
  conversationId: string | null;
  threadRootId: string | null;
  fill: (text: string) => void;
  onUsed: (used: UsePromptResponse) => void;
}): PromptsInChat | null {
  const { rawLocale } = useI18n();
  const promptWordsHere = promptWords(rawLocale);
  const here = usePrompts(room === 'chat');
  const prompts = here.prompts;
  const [listOpen, setListOpen] = useState(false);
  const [picking, setPicking] = useState<Prompt | null>(null);
  const after = useAfterSheet();
  const byId = useMemo(() => new Map((prompts ?? []).map((p) => [p.id, p])), [prompts]);

  const choose = useCallback(
    (id: string) => {
      const prompt = byId.get(id);
      if (!prompt) return;
      if (promptChoice(prompt) === 'draft') fill(prompt.text);
      else setPicking(prompt);
    },
    [byId, fill],
  );
  const above = useCallback(
    (text: string) => {
      const rows = slashRows(prompts, text);
      return rows ? <SlashList rows={rows} onPick={choose} /> : null;
    },
    [prompts, choose],
  );
  if (room !== 'chat' || !prompts || !conversationId) return null;
  return {
    canSave: true,
    open: () => setListOpen(true),
    above,
    sheets: (
      <>
        <Sheet
          visible={listOpen}
          onClose={() => setListOpen(false)}
          onDismissed={after.onDismissed}
          label={promptWordsHere.title}
          closeLabel={promptWordsHere.cancel}
          surface="sf"
          maxHeight="80%"
        >
          <SheetHead title={promptWordsHere.title} subtitle={null} />
          {prompts.length ? null : <QuietLine text={promptWordsHere.empty} />}
          <ScrollView keyboardShouldPersistTaps="handled">
            <PromptRows
              rows={prompts.map(promptRow)}
              onPick={(id) => {
                setListOpen(false);
                // The next sheet waits for this one to go down (iOS shows no sheet under one it still shows).
                after.later(() => choose(id));
              }}
            />
          </ScrollView>
        </Sheet>
        <RepositorySheet
          prompt={picking}
          conversationId={conversationId}
          threadRootId={threadRootId}
          onClose={() => setPicking(null)}
          onInstead={(p) => {
            setPicking(null);
            fill(p.text);
          }}
          onUsed={(used) => {
            setPicking(null);
            fill('');
            onUsed(used);
          }}
        />
      </>
    ),
  };
}

/** Over the pill while the draft is a `/` word: the prompts that match, the first few in sight. */
function SlashList({ rows, onPick }: { rows: PromptRow[]; onPick: (id: string) => void }) {
  const { rawLocale } = useI18n();
  const promptWordsHere = promptWords(rawLocale);
  const theme = useTheme();
  return (
    <View
      accessibilityLabel={promptWordsHere.title}
      style={{
        maxHeight: 232,
        marginBottom: 8,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      <Text
        size={10.5}
        weight={500}
        mono
        uppercase
        tracking={0.06}
        color={theme.colors.mut}
        accessibilityRole="header"
        style={{ paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4 }}
      >
        {promptWordsHere.group}
      </Text>
      <ScrollView keyboardShouldPersistTaps="always">
        <PromptRows rows={rows} onPick={onPick} compact />
      </ScrollView>
    </View>
  );
}

/** Prompts as rows: the title over its first line, each one button. */
function PromptRows({
  rows,
  onPick,
  compact = false,
}: {
  rows: readonly PromptRow[];
  onPick: (id: string) => void;
  compact?: boolean;
}) {
  const theme = useTheme();
  return (
    <View>
      {rows.map((r, i) => (
        <Touchable
          key={r.id}
          onPress={() => onPick(r.id)}
          feedback="wash"
          accessibilityRole="button"
          accessibilityLabel={r.label}
          style={{
            minHeight: compact ? 48 : 56,
            justifyContent: 'center',
            gap: 2,
            paddingVertical: compact ? 8 : 11,
            paddingHorizontal: compact ? 14 : 18,
            borderTopWidth: i === 0 ? 0 : 1,
            borderTopColor: theme.colors.line,
          }}
        >
          <Text size={compact ? 14.5 : 15.5} weight={600} numberOfLines={1}>
            {r.title}
          </Text>
          <Text size={compact ? 12.5 : 13.5} lh={1.4} color={theme.colors.mut} numberOfLines={1}>
            {r.preview}
          </Text>
        </Touchable>
      ))}
    </View>
  );
}

/** A quiet line in a sheet (nothing to list yet). */
function QuietLine({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Text size={13.5} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 18, paddingBottom: 12 }}>
      {text}
    </Text>
  );
}

/** A sheet's title (18/700) over its quiet line, as the AI sheet has them. */
function SheetHead({ title, subtitle }: { title: string; subtitle: string | null }) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: 18, paddingTop: 4, paddingBottom: 12, gap: 3 }}>
      <Text size={18} weight={700} accessibilityRole="header">
        {title}
      </Text>
      {subtitle ? (
        <Text size={13.5} lh={1.4} color={theme.colors.mut} numberOfLines={2}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

/** “Which repository?”: T3 Code's projects for a prompt, asked as it opens. */
function RepositorySheet({
  prompt,
  conversationId,
  threadRootId,
  onClose,
  onInstead,
  onUsed,
}: {
  prompt: Prompt | null;
  conversationId: string;
  threadRootId: string | null;
  onClose: () => void;
  onInstead: (prompt: Prompt) => void;
  onUsed: (used: UsePromptResponse) => void;
}) {
  const { rawLocale } = useI18n();
  const promptWordsHere = promptWords(rawLocale);

  const theme = useTheme();
  const { slug, clock } = useBurrowBase();
  const open = prompt !== null;
  const projects = usePromptProjects(open);
  const use = useUsePrompt();
  const [search, setSearch] = useState('');
  const [shown, setShown] = useState<Prompt | null>(prompt);
  // The sheet keeps its prompt while it goes down.
  if (prompt && prompt !== shown) {
    setShown(prompt);
    setSearch('');
  }
  const view = promptPickerView(shown, projects.data, !!projects.error, search, clock(), rawLocale);
  const field = textMetrics({ size: 15.5 });
  const pick = (project: { id: string; title: string }) => {
    if (!shown || use.isPending) return;
    use.mutate(
      {
        params: { burrow: slug, promptId: shown.id },
        body: {
          conversationId,
          ...(threadRootId ? { rootId: threadRootId } : {}),
          project,
        },
      },
      {
        onSuccess: (r) => {
          if (r.status !== 'ok') return showFailure(promptWordsHere.useFailed, rawLocale);
          haptic('send');
          onUsed(r.data);
        },
        onError: (error) => showFailure(problemText(error, promptWordsHere.useFailed, rawLocale), rawLocale),
      },
    );
  };
  return (
    <Sheet
      visible={open}
      onClose={use.isPending ? () => {} : onClose}
      label={promptWordsHere.pickTitle}
      closeLabel={promptWordsHere.cancel}
      surface="sf"
      maxHeight="85%"
    >
      <SheetHead title={promptWordsHere.pickTitle} subtitle={shown?.title ?? null} />
      {view.kind === 'rows' || (view.kind === 'empty' && search) ? (
        <View style={{ paddingHorizontal: 18, paddingBottom: 10 }}>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={promptWordsHere.pickSearch}
            accessibilityLabel={promptWordsHere.pickSearch}
            placeholderTextColor={theme.colors.placeholder}
            selectionColor={theme.colors.brand}
            cursorColor={theme.colors.ink}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            style={{
              minHeight: 44,
              paddingVertical: 10,
              paddingHorizontal: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: theme.colors.line2,
              backgroundColor: theme.colors.bg,
              color: theme.colors.ink,
              fontFamily: field.fontFamily,
              fontSize: field.fontSize,
            }}
          />
        </View>
      ) : null}
      {view.kind === 'rows' ? (
        <ScrollView keyboardShouldPersistTaps="handled">
          {view.rows.map((r) => (
            <Touchable
              key={r.id}
              onPress={() => pick({ id: r.id, title: r.title })}
              disabled={use.isPending}
              feedback="wash"
              accessibilityRole="button"
              accessibilityLabel={r.label}
              style={{
                minHeight: 56,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingVertical: 11,
                paddingHorizontal: 18,
                borderTopWidth: 1,
                borderTopColor: theme.colors.line,
                opacity: use.isPending && use.variables?.body.project.id !== r.id ? 0.45 : 1,
              }}
            >
              <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                <Text size={15.5} weight={600} numberOfLines={1}>
                  {r.title}
                </Text>
                {r.folder ? (
                  <Text size={12} mono color={theme.colors.mut} numberOfLines={1}>
                    {r.folder}
                  </Text>
                ) : null}
              </View>
              {use.isPending && use.variables?.body.project.id === r.id ? (
                <ActivityIndicator size="small" color={theme.colors.mut} />
              ) : r.ran ? (
                <Text size={12.5} color={theme.colors.mut} numberOfLines={1}>
                  {r.ran}
                </Text>
              ) : null}
            </Touchable>
          ))}
        </ScrollView>
      ) : (
        <View accessibilityLiveRegion="polite" style={{ paddingHorizontal: 18, paddingBottom: 6, gap: 14 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {view.kind === 'loading' ? <ActivityIndicator size="small" color={theme.colors.mut} /> : null}
            <Text size={13.5} lh={1.45} color={theme.colors.mut} style={{ flex: 1 }}>
              {view.text}
            </Text>
          </View>
          {view.kind === 't3' && shown ? (
            <Button
              label={promptWordsHere.pickInstead}
              variant="secondary"
              onPress={() => onInstead(shown)}
            />
          ) : null}
        </View>
      )}
    </Sheet>
  );
}
