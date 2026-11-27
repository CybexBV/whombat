/**
 * Settings → Agent → Name and character (Whombat one-agent.md OA-08; one-agent.md AP-4924, AP-4966; was Settings →
 * Profile → Your assistant, assistant-name-mobile.md AP-1536…AP-1541): the face's bust on its colour beside NAME with
 * Save and the hint, then Character and its five tiles (a pick saves, never renames; agent-voices.md AP-5500, AP-5503)
 * with a line on how the picked one talks (AP-5501). Both go through `agent.update`; the server checks the name again
 * and its refusal shows under the field. Targets are 44dp or more.
 */

import { ApiError, agentFaceLabel, agentFaceOf } from '@whombat/client';
import { useSetAgentModel } from '@whombat/client/react';
import { AGENT_NAME_MAX, type AgentFace } from '@whombat/core';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, TextInput, View } from 'react-native';
import { WhombatAvatar } from '../../avatars/Avatars';
import {
  agentNameProblem,
  canSaveName,
  characterLine,
  cleanAgentName,
  faceChoices,
  NAME_AND_FACE_TEXT,
  updateRefusalText,
} from '../../data/agentName';
import { useBurrowBase } from '../../data/BurrowProvider';
import { useAgentWords } from '../../data/useAgent';
import { useMobileT } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { textMetrics } from '../../theme/type';
import { tint } from '../../ui/glanceColors';
import { Check } from '../../ui/icons';
import { Button, Section } from '../../ui/primitives';
import { Touchable } from '../../ui/Touchable';
import { errorText, outcomeText } from '../feedback';
import { type PartProps, PartScroll } from './parts';

/** A face's colour at 14 % behind its drawing: the bust, and the chosen tile (the mock's `color-mix(… 14%)`). */
const FACE_WASH = 0.14;

export function NameAndFacePart({ profile, refetch }: PartProps) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const words = useAgentWords();
  const agent = profile.agent;
  const update = useSetAgentModel(slug);
  const [draft, setDraft] = useState(agent.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [busy, setBusy] = useState<'name' | 'face' | null>(null);
  // The face just picked, shown at once until the agent has it (or it was refused).
  const [picked, setPicked] = useState<AgentFace | null>(null);

  // A new name (saved here, or elsewhere) is the field's again.
  useEffect(() => setDraft(agent.name), [agent.name]);
  const face = agentFaceOf(agent);
  useEffect(() => {
    if (picked === face) setPicked(null);
  }, [picked, face]);

  const say = (text: string, bad: boolean) => {
    setNote({ text, bad });
    AccessibilityInfo.announceForAccessibility(text);
  };

  const saveName = () => {
    if (busy || !canSaveName(draft, agent.name)) return;
    const name = cleanAgentName(draft);
    const local = agentNameProblem(name);
    setNote(null);
    if (local) {
      setProblem(local);
      AccessibilityInfo.announceForAccessibility(local);
      return;
    }
    setProblem(null);
    setBusy('name');
    update
      .mutateAsync({ params: { burrow: slug }, body: { name } })
      .then(
        (result) => {
          const refused = outcomeText(result);
          if (refused) return say(refused.body, true);
          if (result.status !== 'ok') return;
          const saved = result.data.agent.name;
          if (saved !== name) {
            setDraft(saved);
            return say('Couldn’t save that. Try again in a moment.', true);
          }
          say(words.renamed(saved), false);
        },
        (error: unknown) => {
          const text =
            (error instanceof ApiError ? updateRefusalText(error, 'name') : null) ?? errorText(error);
          setProblem(text);
          AccessibilityInfo.announceForAccessibility(text);
        },
      )
      .finally(() => setBusy(null));
  };

  const pickFace = (next: AgentFace) => {
    if (busy || next === (picked ?? face)) return;
    setPicked(next);
    setNote(null);
    setBusy('face');
    update
      .mutateAsync({ params: { burrow: slug }, body: { face: next } })
      .then(
        (result) => {
          const refused = outcomeText(result);
          if (refused) {
            setPicked(null);
            return say(refused.body, true);
          }
          if (result.status !== 'ok') {
            setPicked(null);
            return;
          }
          if (agentFaceOf(result.data.agent) !== next) {
            setPicked(null);
            return say('Couldn’t save that face. Try again in a moment.', true);
          }
          say(words.newFace, false);
        },
        (error: unknown) => {
          setPicked(null);
          say(
            (error instanceof ApiError ? updateRefusalText(error, 'face') : null) ?? errorText(error),
            true,
          );
        },
      )
      .finally(() => setBusy(null));
  };

  const wears = picked ?? face;
  const choices = faceChoices(face, picked);
  const character = characterLine(wears);
  const input = textMetrics({ size: 16 });
  const rowStyle = { paddingHorizontal: 16, paddingVertical: 16, gap: 12 } as const;
  const hairline = { borderTopWidth: 1, borderTopColor: theme.colors.line } as const;
  return (
    <PartScroll refreshing={false} onRefresh={refetch}>
      <Section>
        <View style={rowStyle}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 14 }}>
            <View
              style={{
                width: 76,
                height: 76,
                borderRadius: 16,
                overflow: 'hidden',
                backgroundColor: tint(theme.faces[wears].accent, FACE_WASH),
              }}
            >
              <WhombatAvatar face={wears} size={76} crop="bust" label={agentFaceLabel(wears)} />
            </View>
            <View style={{ flex: 1, gap: 6 }}>
              <Text size={12} weight={500} mono color={theme.colors.mut}>
                {NAME_AND_FACE_TEXT.name}
              </Text>
              <TextInput
                value={draft}
                onChangeText={(v) => {
                  setDraft(v);
                  setProblem(null);
                }}
                accessibilityLabel={tMobile('screens.name')}
                accessibilityHint={problem ?? words.nameHint}
                maxLength={AGENT_NAME_MAX}
                autoCapitalize="words"
                autoCorrect={false}
                autoComplete="off"
                importantForAutofill="no"
                spellCheck={false}
                returnKeyType="done"
                submitBehavior="blurAndSubmit"
                onSubmitEditing={saveName}
                editable={busy !== 'name'}
                placeholderTextColor={theme.colors.placeholder}
                selectionColor={theme.colors.brand}
                cursorColor={theme.colors.ink}
                style={{
                  height: 48,
                  paddingHorizontal: 16,
                  paddingVertical: 0,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: problem ? theme.colors.bad : theme.colors.line2,
                  backgroundColor: theme.colors.bg,
                  color: theme.colors.ink,
                  fontFamily: input.fontFamily,
                  fontSize: input.fontSize,
                  includeFontPadding: false,
                }}
              />
            </View>
          </View>
          <Button
            label={NAME_AND_FACE_TEXT.save}
            variant="secondary"
            busy={busy === 'name'}
            disabled={!canSaveName(draft, agent.name) || busy === 'face'}
            onPress={saveName}
          />
          {problem ? (
            <Text size={13} lh={1.4} color={theme.colors.bad} accessibilityLiveRegion="polite">
              {problem}
            </Text>
          ) : null}
          <Text size={13.5} lh={1.45} color={theme.colors.mut}>
            {words.nameHint}
          </Text>
          {note ? (
            <Text size={13.5} lh={1.45} color={note.bad ? theme.colors.bad : theme.colors.ink2}>
              {note.text}
            </Text>
          ) : null}
        </View>
        <View style={[rowStyle, hairline]}>
          <View style={{ gap: 3 }}>
            <Text size={15} weight={600}>
              {NAME_AND_FACE_TEXT.face}
            </Text>
            <Text size={13.5} lh={1.45} color={theme.colors.mut}>
              {NAME_AND_FACE_TEXT.faceLine(words)}
            </Text>
          </View>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel={NAME_AND_FACE_TEXT.face}
            style={{ flexDirection: 'row', gap: 8, paddingTop: 6 }}
          >
            {choices.map((c) => (
              <Touchable
                key={c.key}
                accessibilityRole="radio"
                accessibilityLabel={c.label}
                accessibilityState={{ selected: c.selected, disabled: busy !== null }}
                disabled={busy !== null}
                onPress={() => pickFace(c.key)}
                feedback={c.selected ? 'none' : 'wash'}
                ringRadius={14}
                style={{
                  flex: 1,
                  aspectRatio: 1,
                  minHeight: 48,
                  borderRadius: 14,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: c.selected ? 2 : 1,
                  borderColor: c.selected ? theme.colors.ink : theme.colors.line2,
                  backgroundColor: c.selected ? tint(theme.faces[c.key].accent, FACE_WASH) : 'transparent',
                }}
              >
                <WhombatAvatar face={c.key} size={44} crop="bust" />
                {c.selected ? (
                  // The mock's check badge on the chosen tile.
                  <View
                    style={{
                      position: 'absolute',
                      top: -7,
                      right: -7,
                      width: 20,
                      height: 20,
                      borderRadius: 10,
                      backgroundColor: theme.colors.ink,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Check size={12} color={theme.colors.bg} strokeWidth={3} />
                  </View>
                ) : null}
              </Touchable>
            ))}
          </View>
          {/* How the picked character talks (AP-5501), read out again when the pick changes. */}
          <Text size={13.5} lh={1.45} color={theme.colors.mut} accessibilityLiveRegion="polite">
            <Text size={13.5} lh={1.45} weight={600}>
              {character.name}
            </Text>
            {` · ${character.style}`}
          </Text>
        </View>
      </Section>
    </PartScroll>
  );
}
