import type { BranchTab } from '../../app/routing/search';
import { Tabs } from '../../components/Tabs';

export interface BranchTabsProps {
  tab: BranchTab;
  /** Number of files changed, shown after "Files changed". */
  fileCount: number;
  onTabChange: (tab: BranchTab) => void;
  /** Id of the element the tabs control (the scrolling body). */
  panelId?: string;
}

/** "Conversation" / "Files changed 6" with the 2px ink underline on the current tab. */
export function BranchTabs({ tab, fileCount, onTabChange, panelId }: BranchTabsProps) {
  return (
    <Tabs
      label="Branch room"
      idPrefix="branch-tab"
      panelId={panelId}
      value={tab}
      onChange={onTabChange}
      tabs={[
        { key: 'conversation', label: 'Conversation', meta: '' },
        { key: 'files', label: 'Files changed', meta: fileCount },
      ]}
    />
  );
}
