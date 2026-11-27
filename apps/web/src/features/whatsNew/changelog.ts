/**
 * What's new: the repository's plain-language changelog (`docs/changelog.md`, legal-texts.md LGL-05), built into the
 * app so every Whombat serves the one its version came with. The box's web build copies that file for this
 * (appliance/nix/lib/sources.nix).
 */
import changelog from '../../../../../docs/changelog.md?raw';

/** The page people read: the changelog without the note for those who keep it, which follows its first `---`. */
export function whatsNewMarkdown(text: string): string {
  const cut = text.search(/^---[ \t]*$/m);
  return `${(cut === -1 ? text : text.slice(0, cut)).trimEnd()}\n`;
}

export const WHATS_NEW_MARKDOWN = whatsNewMarkdown(changelog);
