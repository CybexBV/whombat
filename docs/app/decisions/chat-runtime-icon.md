# What answers in Chat as an icon in the box (AP-2960…AP-2969)

John, 2026-10-20, with a screenshot of the phone's Chat box: the “Opus · Automatic” button above the box — “I don't
like the view of this, I do like the view of the pop-up window when you click on it” — and could it be an icon in front
of the paperclip, in the same box, so it looks clean. The mockup showed the phone's box before and after, the icon's
states, the sheet it opens (unchanged) and the web's box with the same icon. John: “I like this very much. Can you
please implement this fully?”

| ID | Decision | Why |
|---|---|---|
| AP-2960 | **The web's button is a round icon** (`ChatRuntimeButton`): 32px like the paperclip beside it, the provider's mark at 16px, no words and no ▾; hover and open get `--sel`, the 2px `--brand` focus ring stays. It sits where AP-2690 put the button (before the paperclip in the Chat's box, before `+ file` in a Chat thread's reply box) and opens the same popover, now with its right edge on the icon's (it lined up with the button's left edge, which put it past the box's right end once the button was only an icon). Its accessible name and description don't change (“Choose how Dusty answers”, “Claude · Opus · Automatic”). This replaces AP-2690's look. | One clean box, and the same look on the web and the phone. |
| AP-2961 | **On hover, the choice in words above it** (`.buttonTip`): “Opus · Automatic”, with “· Fast replies” when fast is on (`chatRuntimeLine`), on `--sf2` with a `--line2` frame and the chart tip's shadow, after 0.35 s; at once on keyboard focus; never while the popover is open. `aria-hidden`: the description already says it. A CSS tip, not `title`: the browser's own waits about a second and can't follow the theme. | The words are what the icon gave up. |
| AP-2962 | **The phone's icon is in the pill, before the paperclip** (`Composer` `tool`, `ui/chatRuntime.tsx` `ChatRuntimeIcon`): a 32dp round like the paperclip, the mark at 18dp, 4dp between the two icons (10dp to the field as before), touch padded to 44dp. The row above the pill (AP-2715's `ChatRuntimeChip`) is gone, so the chat keeps those 42dp. Same places, the same sheet and the same TalkBack words as AP-2715. | John's request and the mockup. |
| AP-2963 | **A long press on the phone's icon says the choice** with the app's short notice — “Opus · Automatic · For this thread” (`chatRuntimeLine` with the scope) — and the long-press haptic; a tap opens the sheet. Not a bubble above the icon as in the mockup: that needs absolute layout, which the reading-order guard (`talkback-order.test.ts`) keeps out of the Chat's files, and a reply's mark already says its line the same way (AP-2726). | Seeing the model without opening anything. |
| AP-2964 | **Fast replies are a bolt on the mark**, on the web and the phone: a 15px disc of the box's surface (`--sf` / `sf`) with the 10px bolt in `warn`, on the mark's lower right. On the phone the disc overlaps the mark by its margins, not absolute layout. | The one state worth seeing at a glance; the model and effort are in the sheet, on hover or a long press, and on each reply's mark. |
| AP-2965 | **whombat-app 0.100.1.** No contract change (contracts stay 0.98.0); `chatRuntimeLine` in `@whombat/client` joins words that are already there. | A look change in both clients. |

AP-2960…AP-2965 used; AP-2966…AP-2969 kept for this work's follow-ups.

## whombat-app 0.100.1

AP-2960…AP-2964. Checks: `pnpm check`; the web in the fixture world at 1440×900 in light and dark (the Chat's box, hover,
ChatGPT with fast replies, keyboard focus, the popover now right-aligned on the icon, a Chat thread's reply box); the
demo world's release APK on the Pixel 7 AVD in light and dark (the icon in the pill, the sheet from it, ChatGPT with fast
replies, a long press), plus a throwaway build with attachments allowed in the demo world to see the icon beside the
paperclip. Not seen on a device: John's phone.
