/**
 * Light haptics (MX-08): a tick when a message is sent, a confirm when an approval is approved, the long-press feel
 * when a message's menu opens, `success` when a thread settles (chat-settle.md AP-6157), and `threshold` when a swipe
 * reaches the point where letting go runs its action, and again when it goes back (ios-native.md). On Android they
 * are the system's own feedback constants (`View.performHapticFeedback` through expo-haptics'
 * `performAndroidHapticsAsync`), so the phone's “Touch feedback” setting turns them off and they need no vibration;
 * elsewhere a light impact, the system's success notification for `success` and its selection tick for `threshold`.
 * A build without the module, or an error, does nothing.
 */
import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

export type HapticMoment = 'send' | 'approve' | 'menu' | 'success' | 'threshold';

const ANDROID: Record<HapticMoment, Haptics.AndroidHaptics> = {
  send: Haptics.AndroidHaptics.Virtual_Key,
  approve: Haptics.AndroidHaptics.Confirm,
  menu: Haptics.AndroidHaptics.Long_Press,
  success: Haptics.AndroidHaptics.Confirm,
  threshold: Haptics.AndroidHaptics.Segment_Tick,
};

export function haptic(moment: HapticMoment): void {
  try {
    const played =
      Platform.OS === 'android'
        ? Haptics.performAndroidHapticsAsync(ANDROID[moment])
        : moment === 'success'
          ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
          : moment === 'threshold'
            ? Haptics.selectionAsync()
            : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void played.catch(() => {});
  } catch {
    // No haptics module in this build: nothing to feel.
  }
}
