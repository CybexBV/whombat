/**
 * Pieces the Files screens share (files-space.md FS-07; AP-772…; not mocked): a conversation's mark (the agent's face
 * for the person's Chat and Feedback room, a branch), the folder and file tiles, and the screen's title block in the
 * Vault's language (mono kicker, 25/700 title, intro).
 */
import type { FilesConversationRow } from '@whombat/client';
import { type Attachment, isPageSet } from '@whombat/core';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { PrincipalAvatar } from '../avatars/Avatars';
import { useTheAgentHere } from '../data/useAgent';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { AttachmentImage, type FileAccess, isRaster } from '../ui/attachments';
import { FileIcon, FileText, Folder, ImageIcon, Layers } from '../ui/icons';
import { ConversationMark } from './ConversationScreen';

/** A conversation in the Files list: the agent's face for the person's own rooms with it, else the branch's mark. */
export function FilesConversationMark({ row, size }: { row: FilesConversationRow; size: number }) {
  const agent = useTheAgentHere();
  if (row.kind === 'dm' && agent) return <PrincipalAvatar principal={agent} size={size} />;
  return <ConversationMark kind={row.kind === 'dm' ? 'dm' : 'branch'} size={size} />;
}

/** A rounded `sf2` tile with an icon: a folder, or a file of a kind. */
function Tile({ size, children }: { size: number; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        backgroundColor: theme.colors.sf2,
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {children}
    </View>
  );
}

export function FolderTile({ size = 44 }: { size?: number }) {
  const theme = useTheme();
  return (
    <Tile size={size}>
      <Folder size={Math.round(size * 0.46)} color={theme.colors.ink2} strokeWidth={1.75} />
    </Tile>
  );
}

/** A file's tile: a picture's thumbnail once the phone can fetch it, else its kind's icon. */
export function FileTile({
  attachment,
  access,
  size = 44,
}: {
  attachment: Attachment;
  access: FileAccess | null;
  size?: number;
}) {
  const theme = useTheme();
  const Icon = isPageSet(attachment)
    ? Layers
    : attachment.kind === 'image'
      ? ImageIcon
      : attachment.kind === 'file'
        ? FileIcon
        : FileText;
  return (
    <Tile size={size}>
      {access && isRaster(attachment) ? (
        <AttachmentImage
          attachment={attachment}
          access={access}
          style={{ width: size, height: size }}
          resizeMode="cover"
        />
      ) : (
        <Icon size={Math.round(size * 0.44)} color={theme.colors.ink2} strokeWidth={1.75} />
      )}
    </Tile>
  );
}

/** The title block: a mono kicker (the conversation, with its mark), the 25/700 title, then what follows. */
export function FilesTitle({
  kicker,
  mark,
  title,
  children,
}: {
  kicker?: string | null;
  mark?: ReactNode;
  title: string;
  children?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: 22, paddingBottom: 14, gap: 4 }}>
      {kicker ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {mark}
          <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut} numberOfLines={1}>
            {kicker}
          </Text>
        </View>
      ) : null}
      <Text size={25} weight={700} lh={1.15} tracking={-0.02} accessibilityRole="header" numberOfLines={2}>
        {title}
      </Text>
      {children}
    </View>
  );
}

/** A grouped-list card without a label (the title above says where it is): 20dp radius, `sf`, hairline. */
export function FilesGroup({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
      <View
        style={{
          borderRadius: 20,
          backgroundColor: theme.colors.sf,
          borderWidth: 1,
          borderColor: theme.colors.line,
          overflow: 'hidden',
        }}
      >
        {children}
      </View>
    </View>
  );
}
