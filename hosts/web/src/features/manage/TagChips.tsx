// Proxmox tags of a guest as small chips (guest rows on the host's Guests
// tab and the Guests page).

import { t } from '../../lib/i18n';

export function TagChips({ tags }: { tags?: string[] | null }) {
  if (!tags?.length) return null;
  return (
    <span className="tag-chips">
      <span className="sr-only">{t('tags:')}</span>
      {tags.map((tag) => (
        <span key={tag} className="chip chip-sm tag-chip">
          {tag}
        </span>
      ))}
    </span>
  );
}
