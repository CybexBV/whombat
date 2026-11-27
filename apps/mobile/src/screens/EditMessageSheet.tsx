/**
 * Editing your own message (Whombat essentials item 8; CT-173; AP-504): a sheet with the text in a field, Save and
 * Cancel. The message keeps its old text until the server answers (an edit isn't shown as done before it is); Save is
 * held while nothing changed, the text is empty (a message with files may lose its text) or too long.
 */

import { autocorrectComposerMention, composerText } from '@whombat/client';
import type { MentionTarget } from '@whombat/core';
import { useEffect, useRef, useState } from 'react';
import { TextInput, View } from 'react-native';
import { canSaveEdit, editProblem } from '../data/messageActions';
import { useI18n, useMobileT } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { keepCaret } from '../ui/chat';
import { Button } from '../ui/primitives';
import { Sheet } from '../ui/sheet';

export interface EditTarget {
  messageId: string;
  text: string;
  hasAttachments: boolean;
}

export function EditMessageSheet({
  target,
  busy,
  error,
  onSave,
  onClose,
  mentionTargets = [],
}: {
  /** The message being edited, or null when the sheet is closed. */
  target: EditTarget | null;
  busy: boolean;
  /** Why the last save didn't go through. */
  error: string | null;
  onSave: (text: string) => void;
  onClose: () => void;
  /** Who `@Name` means: `@banjo ` is corrected to `@Banjo ` as it is typed, and saved so (AP-607). */
  mentionTargets?: readonly MentionTarget[];
}) {
  const { rawLocale, tClient } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const [draft, setDraft] = useState('');
  const field = useRef<TextInput>(null);
  useEffect(() => {
    if (target) setDraft(target.text);
  }, [target]);
  const original = target?.text ?? '';
  const hasFiles = target?.hasAttachments ?? false;
  const problem = editProblem(original, draft, hasFiles, rawLocale);
  const ready = canSaveEdit(original, draft, hasFiles);
  const input = textMetrics({ size: 15.5, lineHeight: 1.45 });
  return (
    <Sheet
      visible={target !== null}
      onClose={onClose}
      title={tMobile('screens.edit-message')}
      label={tMobile('screens.edit-message-2')}
      closeLabel={tClient('reports.cancel')}
    >
      <View style={{ paddingHorizontal: 18, gap: 10 }}>
        <TextInput
          ref={field}
          value={draft}
          onChangeText={(v) => {
            const fixed = autocorrectComposerMention({ previous: draft, next: v }, mentionTargets);
            setDraft(fixed?.text ?? v);
            if (fixed) keepCaret(field, fixed.caret);
          }}
          autoFocus
          multiline
          accessibilityLabel={tMobile('screens.message-text')}
          placeholder={tClient('automations.source.message')}
          placeholderTextColor={theme.colors.mut}
          selectionColor={theme.colors.brand}
          cursorColor={theme.colors.ink}
          style={{
            minHeight: 96,
            maxHeight: 240,
            paddingVertical: 12,
            paddingHorizontal: 14,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: theme.colors.line2,
            backgroundColor: theme.colors.sf,
            color: theme.colors.ink,
            ...input,
            includeFontPadding: false,
            textAlignVertical: 'top',
          }}
        />
        {problem || error ? (
          <Text size={13.5} lh={1.45} color={theme.colors.bad} accessibilityLiveRegion="polite">
            {error ?? problem ?? ''}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label={tClient('reports.cancel')}
            variant="secondary"
            onPress={onClose}
            style={{ flex: 1 }}
          />
          <Button
            label={tClient('limit.save')}
            busy={busy}
            disabled={!ready}
            onPress={() => onSave(composerText(draft.trim(), mentionTargets))}
            style={{ flex: 1 }}
          />
        </View>
      </View>
    </Sheet>
  );
}
