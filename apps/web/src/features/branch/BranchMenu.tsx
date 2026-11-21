import { useRowMenu } from '../../app/shell/ContextMenu';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import headerStyles from '../messaging/ConversationHeader.module.css';

/**
 * The branch room header's More (docs/decisions/settings-simplify.md SS-53): what the sidebar's room row offered
 * before the rows went (SS-20) — Copy branch name. The room's Knowledge went with Whombat's memory (HE-39, AP-5226);
 * Files changed is the room's own tab.
 */
export function BranchMenu({ conversationId, branch }: { conversationId: string; branch: string }) {
  const menu = useRowMenu();
  const toast = useToast();
  const key = `branch-menu:${conversationId}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(branch);
      toast.show(`Copied ${branch}.`);
    } catch {
      toast.show('Couldn’t copy the branch name.');
    }
  };
  return (
    <>
      <button
        type="button"
        className={cx(headerStyles.iconAction, menu.openKey === key && headerStyles.iconActionOpen)}
        aria-label={`More for ${branch}`}
        title="More"
        aria-haspopup="menu"
        aria-expanded={menu.openKey === key}
        data-header-more=""
        onClick={(e) =>
          menu.openFrom(
            e.currentTarget,
            key,
            branch,
            [{ label: 'Copy branch name', onSelect: () => void copy() }],
            'end',
          )
        }
      >
        <Icon name="more" size={17} />
      </button>
      {menu.element}
    </>
  );
}
