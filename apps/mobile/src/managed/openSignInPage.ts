/**
 * A provider's sign-in page in the app's in-app browser (Whombat first-day.md): Chrome Custom Tabs on Android, Safari's
 * view on iOS, so the person signs in on OpenAI's or Anthropic's own page without leaving the app, and closing it
 * brings them back to the step. Neither sign-in needs a redirect into the app (the code goes through the clipboard).
 * An app built before the in-app browser was in it opens the system browser instead.
 */
import { Linking } from 'react-native';

export async function openSignInPage(url: string): Promise<void> {
  try {
    const WebBrowser = await import('expo-web-browser');
    await WebBrowser.openBrowserAsync(url, { showTitle: true, enableBarCollapsing: true });
  } catch {
    await Linking.openURL(url);
  }
}
