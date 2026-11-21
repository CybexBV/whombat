/** Agent (wombat), human and automation avatars for React Native. */

import {
  type AvatarCrop,
  type AvatarFace,
  avatarVariant,
  DEFAULT_AVATAR_FACE,
  DEFAULT_AVATAR_SIZE,
  HUMAN_INITIALS_COLOR,
  initialsFontSize,
  normalizeInitials,
  toneFor,
} from '@whombat/avatars';
import { agentFaceOf, automationLabel, isAutomationPrincipal } from '@whombat/client';
import type { Principal } from '@whombat/core';
import { Image as PictureView } from 'expo-image';
import { memo, useState } from 'react';
import { Image, type ImageSourcePropType, type ImageStyle, View, type ViewStyle } from 'react-native';
import { type JsxAST, parse, SvgAst } from 'react-native-svg';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { GitBranch, type LucideIcon, MessageSquare, Workflow } from '../ui/icons';
import { AVATAR_XML, svgDataUri } from './files';
import { usePhotoSource } from './photo';

/** The markup an avatar draws: the face's file for the size (FA-07). */
export function avatarXml(face: AvatarFace, size: number, crop: AvatarCrop = 'auto'): string {
  return (AVATAR_XML[face] ?? AVATAR_XML[DEFAULT_AVATAR_FACE])[avatarVariant(size, crop)];
}

/**
 * Each file parsed once for the app's life and drawn from there (AP-903): `SvgXml` parsed the markup (~13 kB, ~86
 * elements) again for every avatar on screen. Unreadable markup draws nothing, as `SvgXml` did, and says why once.
 */
const parsed = new Map<string, JsxAST | null>();
function avatarAst(face: AvatarFace, size: number, crop: AvatarCrop): JsxAST | null {
  const key = `${face}:${avatarVariant(size, crop)}`;
  let ast = parsed.get(key);
  if (ast === undefined) {
    try {
      ast = parse(avatarXml(face, size, crop));
    } catch (error) {
      console.error(error);
      ast = null;
    }
    parsed.set(key, ast);
  }
  return ast;
}

/**
 * Up to this size a face is one image view drawing the file (`expo-image`: CoreSVG on iOS, AndroidSVG on Android, the
 * decoded picture kept in memory and shared by every avatar of that file) instead of react-native-svg's ~120 native
 * views per avatar. Larger faces, few on a screen, stay with react-native-svg.
 */
export const AVATAR_IMAGE_MAX = 32;

const imageSources = new Map<string, { uri: string }>();
function avatarImageSource(face: AvatarFace, size: number, crop: AvatarCrop): { uri: string } {
  const key = `${face}:${avatarVariant(size, crop)}`;
  let source = imageSources.get(key);
  if (!source) {
    source = { uri: svgDataUri(avatarXml(face, size, crop)) };
    imageSources.set(key, source);
  }
  return source;
}

export interface WhombatAvatarProps {
  /** The face it wears (one-agent.md OA-08): one of the five drawings, Dusty's when absent. */
  face?: AvatarFace;
  /** Width and height in dp. Default 40. */
  size?: number;
  /** `auto` (default): bust from 40dp, head from 25dp, the small head at 24dp and below (FA-07). */
  crop?: AvatarCrop;
  /** Loading / unknown: an empty box of the same size. */
  silhouette?: boolean;
  /** Accessible name: the agent's name (“Dusty”); omit when the name is shown next to it. */
  label?: string;
  style?: ViewStyle;
  /** Drawn as one picture at any size: for a face repeated down a list, where many drawn faces would cost too much. */
  picture?: boolean;
}

/**
 * An agent's avatar (FA-09): the same static SVG file as the web, from the bundle. Small ones are one image view
 * (`AVATAR_IMAGE_MAX`); larger ones are drawn by react-native-svg (parsed once, AP-903), each its own `<Svg>` root, so
 * the files' gradient ids never collide. No background, border or clip.
 */
export const WhombatAvatar = memo(function WhombatAvatar({
  face = DEFAULT_AVATAR_FACE,
  size = DEFAULT_AVATAR_SIZE,
  crop = 'auto',
  silhouette = false,
  label,
  style,
  picture = false,
}: WhombatAvatarProps) {
  if ((size <= AVATAR_IMAGE_MAX || picture) && !silhouette)
    return (
      <PictureView
        source={avatarImageSource(face, size, crop)}
        // A row's margins, never `overflow: scroll`, which images don't take.
        style={[{ width: size, height: size }, style as ImageStyle | undefined]}
        contentFit="contain"
        cachePolicy="memory"
        accessible={!!label}
        accessibilityRole={label ? 'image' : undefined}
        accessibilityLabel={label}
        importantForAccessibility={label ? 'yes' : 'no-hide-descendants'}
      />
    );
  return (
    <View
      style={[{ width: size, height: size }, style]}
      accessible={!!label}
      accessibilityRole={label ? 'image' : undefined}
      accessibilityLabel={label}
      importantForAccessibility={label ? 'yes' : 'no-hide-descendants'}
    >
      {silhouette ? null : (
        <SvgAst ast={avatarAst(face, size, crop)} override={{ width: size, height: size }} />
      )}
    </View>
  );
});

export interface HumanAvatarProps {
  initials: string;
  tone?: string;
  size: number;
  label?: string;
  /**
   * Their photo (contracts CT-265 `Person.avatarUrl`, as an `<Image>` source: `usePhotoSource`). Drawn round over the
   * initials, `cover`; the initials show while it loads and stay when it fails.
   */
  src?: ImageSourcePropType | null;
  style?: ViewStyle;
}

/** The key a photo source is remembered by (a new photo has a new URL, CT-265). */
function sourceKey(src: ImageSourcePropType): string {
  const first = Array.isArray(src) ? src[0] : src;
  return typeof first === 'object' && first && 'uri' in first ? String(first.uri) : String(first);
}

export function HumanAvatar({ initials, tone, size, label, src = null, style }: HumanAvatarProps) {
  const text = normalizeInitials(initials);
  const key = src ? sourceKey(src) : null;
  const [shown, setShown] = useState<{ key: string; ok: boolean } | null>(null);
  const loaded = key !== null && shown?.key === key && shown.ok;
  const failed = key !== null && shown?.key === key && !shown.ok;
  return (
    <View
      accessible={!!label}
      accessibilityRole={label ? 'image' : undefined}
      accessibilityLabel={label}
      importantForAccessibility={label ? 'yes' : 'no-hide-descendants'}
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: tone ?? toneFor(text),
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {loaded ? null : (
        <Text size={initialsFontSize(size)} weight={600} color={HUMAN_INITIALS_COLOR}>
          {text}
        </Text>
      )}
      {src && key && !failed ? (
        <Image
          source={src}
          resizeMode="cover"
          onLoad={() => setShown({ key, ok: true })}
          onError={() => setShown({ key, ok: false })}
          style={{ position: 'absolute', top: 0, left: 0, width: size, height: size, borderRadius: size / 2 }}
        />
      ) : null}
    </View>
  );
}

/**
 * An automation where an avatar goes (automation-recipes.md AP-999, the web's AP-997): the Automations mark (`Workflow`,
 * the web sidebar's icon; Android's navigation has none) on a quiet disc — `sf2`, a `line` hairline, the mark in `ink2`
 * at half the size, a 1.75 stroke at any size — never an agent's wombat. `label` announces it (“Automation “Assess and
 * fix …””); without it it is decorative, the name being beside it.
 */
export function AutomationAvatar({
  size,
  label,
  style,
  icon: Icon = Workflow,
}: {
  size: number;
  label?: string | undefined;
  style?: ViewStyle | undefined;
  /** The mark on the disc: the Automations mark, or another system signer's (GitHub, Feedback). */
  icon?: LucideIcon;
}) {
  const theme = useTheme();
  return (
    <View
      accessible={!!label}
      accessibilityRole={label ? 'image' : undefined}
      accessibilityLabel={label}
      importantForAccessibility={label ? 'yes' : 'no-hide-descendants'}
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          borderWidth: 1,
          borderColor: theme.colors.line,
          backgroundColor: theme.colors.sf2,
          alignItems: 'center',
          justifyContent: 'center',
        },
        style,
      ]}
    >
      <Icon size={Math.round(size * 0.5)} color={theme.colors.ink2} strokeWidth={1.75} absoluteStrokeWidth />
    </View>
  );
}

/**
 * Whombat's own signers (Whombat one-agent.md OA-17): GitHub's mirror and Feedback's receiver get a mark on the same
 * quiet disc as an automation's, never the agent's wombat.
 */
const SYSTEM_MARKS: Record<'automation' | 'github' | 'feedback', LucideIcon> = {
  automation: Workflow,
  github: GitBranch,
  feedback: MessageSquare,
};

/**
 * Avatar for any principal: a person's photo or initials, the agent's face, a mark for Whombat's own signers (an
 * automation's, GitHub's, Feedback's); unknown principals get the silhouette.
 */
export function PrincipalAvatar({
  principal,
  size,
  labelled = false,
  style,
}: {
  principal: Principal | null | undefined;
  size: number;
  /** Give it an accessible name (when the name is not shown next to it). */
  labelled?: boolean;
  style?: ViewStyle;
}) {
  if (!principal) return <WhombatAvatar size={size} silhouette style={style} />;
  if (isAutomationPrincipal(principal))
    return (
      <AutomationAvatar
        size={size}
        label={labelled ? automationLabel(principal.name) : undefined}
        style={style}
      />
    );
  if (principal.kind === 'system')
    return (
      <AutomationAvatar
        size={size}
        icon={SYSTEM_MARKS[principal.system] ?? Workflow}
        label={labelled ? principal.name : undefined}
        style={style}
      />
    );
  if (principal.kind === 'agent') {
    return (
      <WhombatAvatar
        face={agentFaceOf(principal)}
        size={size}
        label={labelled ? principal.name : undefined}
        style={style}
      />
    );
  }
  return (
    <PersonAvatar
      person={principal}
      size={size}
      label={labelled ? principal.name : undefined}
      style={style}
    />
  );
}

/** A person: their photo when they have one (CT-265), else their initials on their tone. */
export function PersonAvatar({
  person,
  size,
  label,
  style,
}: {
  person: { initials: string; tone?: string; avatarUrl?: string | null };
  size: number;
  label?: string | undefined;
  style?: ViewStyle;
}) {
  const src = usePhotoSource(person.avatarUrl);
  return (
    <HumanAvatar
      initials={person.initials}
      tone={person.tone}
      size={size}
      label={label}
      src={src}
      style={style}
    />
  );
}
