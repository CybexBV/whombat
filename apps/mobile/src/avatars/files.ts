/**
 * The agent's five faces as markup (Whombat five-agents.md FA-09, one-agent.md OA-08): Metro imports each SVG verbatim
 * (`metro-svg-transformer.cjs`), so they ship inside the APK's JS bundle and draw with no network. The files keep the
 * names they were drawn under (`AVATAR_FILE_STEMS`: Dusty's are `associate-*.svg`).
 */
import type { AvatarFace, AvatarVariant } from '@whombat/avatars';
import assistantBust from '@whombat/avatars/svg/assistant-bust.svg';
import assistantHead from '@whombat/avatars/svg/assistant-head.svg';
import assistantHeadSmall from '@whombat/avatars/svg/assistant-head-small.svg';
import associateBust from '@whombat/avatars/svg/associate-bust.svg';
import associateHead from '@whombat/avatars/svg/associate-head.svg';
import associateHeadSmall from '@whombat/avatars/svg/associate-head-small.svg';
import developerBust from '@whombat/avatars/svg/developer-bust.svg';
import developerHead from '@whombat/avatars/svg/developer-head.svg';
import developerHeadSmall from '@whombat/avatars/svg/developer-head-small.svg';
import leadBust from '@whombat/avatars/svg/lead-bust.svg';
import leadHead from '@whombat/avatars/svg/lead-head.svg';
import leadHeadSmall from '@whombat/avatars/svg/lead-head-small.svg';
import operatorBust from '@whombat/avatars/svg/operator-bust.svg';
import operatorHead from '@whombat/avatars/svg/operator-head.svg';
import operatorHeadSmall from '@whombat/avatars/svg/operator-head-small.svg';

export const AVATAR_XML: Record<AvatarFace, Record<AvatarVariant, string>> = {
  dusty: { bust: associateBust, head: associateHead, 'head-small': associateHeadSmall },
  banjo: { bust: developerBust, head: developerHead, 'head-small': developerHeadSmall },
  neo: { bust: operatorBust, head: operatorHead, 'head-small': operatorHeadSmall },
  skipper: { bust: leadBust, head: leadHead, 'head-small': leadHeadSmall },
  hazel: { bust: assistantBust, head: assistantHead, 'head-small': assistantHeadSmall },
};

/**
 * A file as an image source's address (`data:image/svg+xml;base64,…`), made once per file: small avatars are drawn by
 * the platform's image view from it, as one view instead of one per shape. The files are ASCII (the test checks), so
 * `btoa` takes them as they are.
 */
const dataUris = new Map<string, string>();
export function svgDataUri(markup: string): string {
  let uri = dataUris.get(markup);
  if (uri === undefined) {
    uri = `data:image/svg+xml;base64,${btoa(markup)}`;
    dataUris.set(markup, uri);
  }
  return uri;
}
