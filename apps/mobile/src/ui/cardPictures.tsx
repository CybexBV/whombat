/**
 * Pictures of what changed (Whombat council.md, delegate.md), as a council's final card and a delegation
 * task's row draw them: each screen's name, its picture at full width with its own aspect ratio (a tap opens the image
 * viewer), how to read it and its numbered notes.
 */

import type { Attachment } from '@whombat/core';
import { useState } from 'react';
import { View } from 'react-native';
import type { CardPicture } from '../data/cardPictures';
import type { FileAccess } from '../data/fileAccess';
import type { MessageFileActions } from '../data/useFiles';
import { useMobileT } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { AttachmentImage, ImageViewer } from './attachments';
import { Touchable } from './Touchable';

/** A screen that changed: its name, the picture at full width (tap: the image viewer), the hint and the notes. */
function Picture({
  picture,
  hint,
  access,
  onOpen,
}: {
  picture: CardPicture;
  hint: string;
  access: FileAccess | null;
  onOpen: (a: Attachment) => void;
}) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const a = picture.attachment;
  const box = { width: '100%' as const, aspectRatio: picture.aspect, borderRadius: theme.radii.buttonLarge };
  return (
    <View style={{ gap: 8 }}>
      <Text size={13.5} weight={600}>
        {picture.view}
      </Text>
      {a && access ? (
        <Touchable
          onPress={() => onOpen(a)}
          accessibilityLabel={picture.label}
          accessibilityHint={tMobile('ui.opens-the-image')}
          feedback="fade"
          ringRadius={theme.radii.buttonLarge}
          style={{
            borderRadius: theme.radii.buttonLarge,
            overflow: 'hidden',
            backgroundColor: theme.colors.sf2,
          }}
        >
          <AttachmentImage attachment={a} access={access} style={box} resizeMode="cover" />
        </Touchable>
      ) : (
        <View accessibilityLabel={picture.label} style={[box, { backgroundColor: theme.colors.sf2 }]} />
      )}
      <Text size={12} color={theme.colors.mut} lh={1.4}>
        {hint}
      </Text>
      {picture.notes.length ? (
        <View style={{ gap: 6 }}>
          {picture.notes.map((note) => (
            <View
              key={note.n}
              accessible
              accessibilityLabel={`${note.n}. ${note.text}`}
              style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}
            >
              <View
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: theme.radii.button,
                  marginTop: 0.5,
                  backgroundColor: theme.colors.ink,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Text size={11} weight={700} color={theme.colors.bg}>
                  {note.n}
                </Text>
              </View>
              <Text size={14} lh={1.45} color={theme.colors.ink2} style={{ flex: 1 }}>
                {note.text}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The pictures one under the other, with the image viewer a tap opens. */
export function CardPictures({
  pictures,
  hint,
  access,
  files,
}: {
  pictures: readonly CardPicture[];
  /** Under each picture: how to read it (“Before on top, after below. …”). */
  hint: string;
  access: FileAccess | null;
  files: MessageFileActions | null;
}) {
  const [open, setOpen] = useState<Attachment | null>(null);
  return (
    <View style={{ gap: 14 }}>
      {pictures.map((p) => (
        <Picture
          key={`${p.view}:${p.attachment?.id ?? ''}`}
          picture={p}
          hint={hint}
          access={access}
          onOpen={setOpen}
        />
      ))}
      {access ? (
        <ImageViewer attachment={open} access={access} onClose={() => setOpen(null)} files={files} />
      ) : null}
    </View>
  );
}
