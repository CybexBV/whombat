import { HumanAvatar, type HumanAvatarProps } from '@whombat/avatars/react';
import { usePhotoSrc } from './attachmentSource';

export interface PersonAvatarProps extends Omit<HumanAvatarProps, 'src'> {
  /** `Person.avatarUrl` (CT-265): their photo, loaded like an image attachment. Absent or null: the initials. */
  avatarUrl?: string | null | undefined;
}

/**
 * A person's avatar (docs/decisions/person-avatars.md PA-03): their photo when they have one, else their initials on
 * their tone — and the initials while the photo loads or when it fails. Every person avatar on the web is this one.
 */
export function PersonAvatar({ avatarUrl, ...props }: PersonAvatarProps) {
  const src = usePhotoSrc(avatarUrl);
  return <HumanAvatar {...props} src={src} />;
}
