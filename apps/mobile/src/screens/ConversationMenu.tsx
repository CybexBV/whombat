/**
 * A conversation's menu (Whombat essentials items 12, 14; not mocked; AP-509, AP-511): the “More” button at the end of
 * the chat header opens a sheet with the viewer's notification level for this conversation (All / Mentions / Nothing,
 * the kind's default marked), the pinned messages, the conversation's plans (as the web's conversation header has
 * “Plans”, work-removal-android.md AP-859), the conversation's Files (files-space.md FS-07, AP-772…) and what the
 * agent remembers there. No members, channel settings, archive or leave: people don't share rooms but a pull request's
 * (Whombat one-agent.md OA-04; app one-agent.md AP-4981). On iPhone the button opens the same as iOS's own menu, the
 * notification levels one level down (ios-native.md).
 */

import type { ConversationKind, NotifyLevel } from '@whombat/core';
import { useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { filesCopy } from '../data/filesCopy';
import { type ConversationMenuLink, conversationMenu, parseConversationPick } from '../data/nativeMenu';
import { notifyBody, notifyOptions } from '../data/notify';
import { useSetNotify } from '../data/useEssentials';
import { useFilesSpace } from '../data/useFiles';
import { useI18n, useMobileT } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Check, Ellipsis, Folder, ListChecks, type LucideIcon, Pin } from '../ui/icons';
import { RowChevron } from '../ui/ListRow';
import { hasNativeMenu, NativeMenu } from '../ui/nativeMenu';
import { Button } from '../ui/primitives';
import { Sheet } from '../ui/sheet';
import { Touchable } from '../ui/Touchable';
import { useDecisionFeedback } from './feedback';

/** The header's “More” button: 44dp, the ellipsis in `ink2`. */
export function MenuButton({ onPress, label }: { onPress: () => void; label: string }) {
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={22}
      accessibilityLabel={label}
      style={MENU_BUTTON}
    >
      <MenuFace />
    </Touchable>
  );
}

const MENU_BUTTON = {
  width: 44,
  height: 44,
  borderRadius: 22,
  alignItems: 'center',
  justifyContent: 'center',
} as const;

function MenuFace() {
  const theme = useTheme();
  return <Ellipsis size={22} color={theme.colors.ink2} strokeWidth={1.75} />;
}

export interface MenuConversation {
  id: string;
  kind: ConversationKind;
  notify?: NotifyLevel | null;
}

interface MenuLinks {
  onPins: () => void;
  /** The conversation's plans (AP-859). */
  onPlans: () => void;
  /** The conversation's Files. */
  onFiles: () => void;
}

/**
 * The header's “More” and what it opens: on iPhone iOS's own menu from the button, elsewhere the sheet.
 */
export function ConversationMenu({
  label,
  conversation,
  ...links
}: MenuLinks & { label: string; conversation: MenuConversation }) {
  const { rawLocale } = useI18n();
  const [open, setOpen] = useState(false);
  const model = useConversationMenu(conversation, links);
  if (hasNativeMenu)
    return (
      <NativeMenu
        trigger="tap"
        label={label}
        spec={conversationMenu(notifyOptions(conversation, rawLocale), model.links, rawLocale)}
        onPick={(id) => {
          const p = parseConversationPick(id);
          if (p?.kind === 'notify') model.pick(p.level);
          else if (p) model.links.find((l) => l.key === p.key)?.onPress();
        }}
        style={MENU_BUTTON}
      >
        <View style={MENU_BUTTON}>
          <MenuFace />
        </View>
      </NativeMenu>
    );
  return (
    <>
      <MenuButton label={label} onPress={() => setOpen(true)} />
      <ConversationMenuSheet
        visible={open}
        onClose={() => setOpen(false)}
        conversation={conversation}
        {...links}
      />
    </>
  );
}

/** What the menu holds, as a sheet or iOS's own: a notification level to pick, and the links. */
function useConversationMenu(conversation: MenuConversation, { onPins, onPlans, onFiles }: MenuLinks) {
  const { t: tMobile } = useMobileT();
  const { rawLocale } = useI18n();
  const filesCopyHere = filesCopy(rawLocale);

  const { slug } = useBurrowBase();
  const feedback = useDecisionFeedback();
  const files = useFilesSpace();
  const setNotify = useSetNotify(slug, { onSuccess: feedback.onResult, onError: feedback.onError });
  const pick = (level: NotifyLevel) =>
    setNotify.mutate({
      conversationId: conversation.id,
      kind: conversation.kind,
      notify: notifyBody(conversation.kind, level),
    });
  const links: (ConversationMenuLink & { icon: LucideIcon; onPress: () => void })[] = [
    { key: 'pins', label: tMobile('screens2.menu.pinned'), icon: Pin, onPress: onPins },
    { key: 'plans', label: tMobile('screens.plans'), icon: ListChecks, onPress: onPlans },
    ...(files ? [{ key: 'files' as const, label: filesCopyHere.title, icon: Folder, onPress: onFiles }] : []),
  ];
  return { pick, links };
}

export function ConversationMenuSheet({
  visible,
  onClose,
  conversation,
  ...menuLinks
}: MenuLinks & {
  visible: boolean;
  onClose: () => void;
  conversation: MenuConversation;
}) {
  const { rawLocale, tClient } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const { pick, links } = useConversationMenu(conversation, menuLinks);
  return (
    <Sheet visible={visible} onClose={onClose} label={tMobile('screens.conversation-options')}>
      <View accessibilityRole="radiogroup" accessibilityLabel={tClient('settings.you.notifications')}>
        <Text
          size={11}
          weight={500}
          mono
          tracking={0.05}
          color={theme.colors.mut}
          accessibilityRole="header"
          style={{ paddingHorizontal: 22, paddingTop: 4, paddingBottom: 8 }}
        >
          {tMobile('screens.notifications')}
        </Text>
        {notifyOptions(conversation, rawLocale).map((o) => (
          <Touchable
            key={o.level}
            onPress={() => pick(o.level)}
            feedback="wash"
            accessibilityRole="radio"
            accessibilityState={{ selected: o.selected }}
            accessibilityLabel={`${o.label}, ${o.detail}`}
            style={{
              minHeight: 60,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingVertical: 10,
              paddingHorizontal: 22,
              borderTopWidth: 1,
              borderTopColor: theme.colors.line,
            }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text size={16} weight={o.selected ? 600 : 500}>
                {o.label}
              </Text>
              <Text size={13} lh={1.4} color={theme.colors.mut}>
                {o.detail}
              </Text>
            </View>
            {o.selected ? <Check size={20} color={theme.colors.brand} strokeWidth={2.25} /> : null}
          </Touchable>
        ))}
      </View>
      {links.map((l) => {
        const Icon = l.icon;
        return (
          <Touchable
            key={l.key}
            onPress={() => {
              onClose();
              l.onPress();
            }}
            feedback="wash"
            accessibilityRole="link"
            accessibilityLabel={l.label}
            style={{
              minHeight: 52,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 14,
              paddingHorizontal: 22,
              borderTopWidth: 1,
              borderTopColor: theme.colors.line,
            }}
          >
            <Icon size={19} color={theme.colors.ink2} strokeWidth={1.75} />
            <Text size={16} weight={500} style={{ flex: 1 }}>
              {l.label}
            </Text>
            <RowChevron />
          </Touchable>
        );
      })}
      <View style={{ paddingHorizontal: 22, paddingTop: 12 }}>
        <Button label={tClient('schedules.end.done')} variant="secondary" onPress={onClose} />
      </View>
    </Sheet>
  );
}
