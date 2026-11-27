import { mobileTranslator } from '../i18n/translate';

export function filesCopy(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    title: t('places.files'),
    intro: t('files.intro'),
    spaceEmpty: t('files.spaceEmpty'),
    folderEmpty: t('files.folderEmpty'),
    inMessage: t('files.inMessage'),
    savedToFiles: t('files.savedToFiles'),
    upload: t('files.upload'),
    newFolder: t('files.newFolder'),
    download: t('files.download'),
    openMessage: t('files.openMessage'),
    rename: t('files.rename'),
    move: t('files.move'),
    remove: t('files.remove'),
    top: t('files.top'),
    loadError: t('files.loadError'),
    notHere: t('files.notHere'),
    savedNote: t('files.savedToFiles'),
    loading: t('files.loading'),
    readFailed: t('files.readFailed'),
    readFailedLine: t('automations.automationListText.readFailedText'),
    retry: t('search.searchCopy.retry'),
    emptyTitle: t('files.emptyTitle'),
    emptyLine: (agent: string) => t('files.emptyLine', { agent }),
    goToChat: t('files.goToChat'),
  };
}
