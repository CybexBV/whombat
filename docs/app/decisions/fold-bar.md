# The tab bar on Android's system area (AP-2750…AP-2759)

John, 2026-10-19, with a screenshot of the unfolded foldable: a gray strip under the bottom bar, “Why is it there and
can we fix that? And also, can we increase the size of the menu a little bit because there is a Google indicator there …
we can use it to activate Circle to Search.” The strip was `#e8e8e8`: Android's 90% white contrast film (`0xE6FFFFFF`)
over the bar's dark `bg`, about 16dp tall, with the stashed taskbar's handle on it. React Native turns on
`enforceNavigationBarContrast` and says light or dark once, as the activity starts, from the window's theme then
(`WindowUtil.enableEdgeToEdge`); the app's Light/Dark choice in Settings and the phone's own switch while the app runs
come later, so Android kept drawing for light. Where Android draws that film (John's unfolded screen under the stashed
taskbar's handle, the three buttons on a phone) it was the wrong one. The labels also sat about 3dp above the handle:
the bar's bottom padding copied the iPhone mock, where the home indicator sits over the bar. John: spacing only,
“Continue with the implementation.”

## AP-2750 The labels stop above the system's area

The bar's bottom padding is the system's area plus 10dp (`tabBarBottomPadding`, `TAB_BAR_SYSTEM_GAP`), never less than
the mock's 14 for a device without one. The area (the gesture handle, the stashed taskbar, the three buttons) is
Android's: swipe home, long-press for Circle to Search; no tab reaches into it, and the bar's colour runs under it.
Icons and labels keep their size. The bar grows by about 10dp on the unfolded screen (16dp area: 14 → 26), more on
phones whose labels used to sit inside the gesture area (24dp: 16 → 34). Material's bar is 80dp above that area; ours is
about 64dp. With the taskbar shown (three buttons on the unfolded screen) the old padding put the labels' last 8dp under
the taskbar. Only the tab bar changes: the composers and footers of pushed screens keep `bottomPadding`.

## AP-2751 No contrast film; Android is told the app's theme

The app theme sets `android:enforceNavigationBarContrast` to false (`plugins/with-navigation-bar.cjs`, API 29+), which
React Native reads before it turns the film on. The tab bar has its own solid colour there, so nothing needs the film.
In its place a small module, `modules/whombat-system-bars` (Kotlin, Android only), sets the navigation bar's light/dark
appearance from the app's theme whenever it changes (`ThemeProvider`, next to the window background) and again when an
activity comes to the front, so the handle and the three buttons are drawn dark on light and light on dark. Without the
module (tests, the iPhone) nothing happens. Not done: `expo-navigation-bar` (a dependency for one call), a scrim in the
app's own colour (the bar already is that colour). Modals (sheets, the QR scanner) are their own windows and keep React
Native's handling; this change is about the main window.

## whombat-app 0.96.1

AP-2750, AP-2751. Phone only: the web and the shared packages are unchanged, so no Whombat vendor pin or candidate (as
AP-897); the APK is published to DEV. Checks: `pnpm check` (4366 tests; one web routing test hit its 5 s limit at load
28 and passes alone); the demo world's release APK, before (0.96.0) and after, on a throwaway Pixel 9 Pro Fold AVD
(unfolded, gesture and three buttons, light, dark, and a switch while the app runs) and the Pixel 7 AVD. The emulator
draws no film under a gesture handle, so John's white strip itself wasn't reproduced; its mechanism was, behind the
Pixel 7's three buttons: a dark film over the bar in dark, and after a switch to light a gray film with white buttons
over the light bar; after, no film and the buttons follow the theme. Under the handle the pixels are the bar's `bg`. Not
seen on a device: John's foldable.
