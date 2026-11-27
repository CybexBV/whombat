/**
 * A page that fails to draw says it didn't load, with Try again (and Go back on a page over another), instead of taking
 * the whole app down: a Whombat newer than this app can send something it doesn't expect yet, and one page shouldn't
 * cost the person the rest. Each tab and page has its own (the navigators' `screenLayout`).
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { View } from 'react-native';
import { notePageError } from '../errors/nativeErrorNotes';
import { mobileTranslator, useMobileT } from '../i18n';
import { Screen } from '../ui/headers';
import { Button, QuietText } from '../ui/primitives';

export function pageFailedText(locale?: string) {
  const { t } = mobileTranslator(locale);
  return {
    text: t('thingPage.thingPageCopy.failed'),
    retry: t('search.searchCopy.retry'),
    back: t('navigation.goBack'),
  };
}
export const PAGE_FAILED_TEXT = pageFailedText();

interface Props {
  children: ReactNode;
  /** Back to the page under it; none on a tab. */
  onBack?: () => void;
}

export class PageBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('A page failed to draw', error);
    // Told to the Whombat the next time it can be: what broke the page, so it can be fixed.
    notePageError(error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return <PageFailed onRetry={() => this.setState({ failed: false })} onBack={this.props.onBack} />;
  }
}

function PageFailed({ onRetry, onBack }: { onRetry: () => void; onBack?: () => void }) {
  const { t } = useMobileT();
  return (
    <Screen>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 16 }}>
        <QuietText style={{ paddingVertical: 0 }}>{t('thingPage.thingPageCopy.failed')}</QuietText>
        <Button label={t('search.searchCopy.retry')} variant="secondary" onPress={onRetry} />
        {onBack ? <Button label={t('navigation.goBack')} variant="quiet" onPress={onBack} /> : null}
      </View>
    </Screen>
  );
}
