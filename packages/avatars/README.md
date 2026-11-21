# @whombat/avatars

The agent's five faces, people's initials avatars and the council's elders (Whombat `docs/decisions/one-agent.md` OA-08;
which file shows at which size is `avatarVariant` in `src/index.ts`).

A Whombat has one agent, and it wears one of five faces (`AVATAR_FACES`, the contracts' `AGENT_FACES`): `dusty`,
`banjo`, `neo`, `skipper` and `hazel`. Each face is three finished SVG files in `svg/`, copied unchanged from the design
handoff (`docs/design-handoff/whombat-crew/svg`) under the names they were drawn with (`AVATAR_FILE_STEMS`):
`associate` (Dusty), `developer` (Banjo), `operator` (Neo), `lead` (Skipper) and `assistant` (Hazel), each as
`<stem>-bust.svg`, `<stem>-head.svg` and `<stem>-head-small.svg`. The faces have no
renderer and no animation. Never run SVGO on them or inline their markup: the files share gradient and clip ids
(`fur`, `eye`, `shirt`, `mc`, `bc`). `src/index.test.ts` pins every file's SHA-256.

```tsx
import { HumanAvatar, WhombatAvatar } from '@whombat/avatars/react';

<WhombatAvatar face="skipper" size={160} eager label="Skipper" />  // the agent's name is its label
<WhombatAvatar face="neo" size={32} />                // head, decorative (alt="")
<WhombatAvatar face="banjo" size={20} />              // ≤ 24px: the small head, whatever the crop
<WhombatAvatar face="hazel" size={40} silhouette />   // loading: an empty 40px box, no request
<HumanAvatar initials="MO" tone="#d9c3a9" size={28} label="Mara Okafor" />
<HumanAvatar initials="MO" tone="#d9c3a9" size={28} src={photoSrc} />  // their photo, round, over the initials
```

A person's photo (contracts CT-265 `Person.avatarUrl`, `docs/app/decisions/person-avatars.md`): `src` is an
already loadable URL (the apps resolve `avatarUrl` the way they load image attachments: `PersonAvatar` on the web and
Android). It is drawn round with `object-fit: cover` in the same box as the initials, which show while it loads and stay
when it fails; the label is the same either way.

File choice (FA-07, `avatarVariant`): `crop="auto"` shows the bust from 40px, the head from 25px and the small head at
24px and below; a forced `bust` or `head` still shows the small head at 24px and below. The `<img>` has explicit `width`/`height`, `loading="lazy"`
(`eager` above the fold), `decoding="async"` and `draggable={false}`, and no background, border or circular crop: a
parent that wants a chip tints itself with the face's colour at 14% (`agentFaceBackground` in `@whombat/client`).

- Web: `@whombat/avatars/urls` turns each file into a Vite asset (`new URL('../svg/…', import.meta.url)`), so the
  built app serves `/assets/<stem>-<variant>-<hash>.svg`, immutable; each avatar is one cached request.
- Android: `apps/mobile` imports `@whombat/avatars/svg/<file>` as markup (a Metro transformer) and draws it with
  react-native-svg's `SvgXml`, bundled in the APK, no network (FA-09).
- Elsewhere (the appliance console, emails): copy the files from `svg/` as they are and load them as images.

The council's elders are drawn in code instead (`elderSvg`, `ELDER_POSES` in `src/elders.ts`): each member of a council
is an old wombat at the council's table, in the faces' drawing, its seat choosing the robe and what it wears and its
pose (`ElderPose`) how it sits. `elderSvg` returns one SVG document as a string whose ids all start with `idPrefix`, so
many elders share a page. The web puts it inline and animates the parts marked `data-elder` with CSS; the phone draws it
with react-native-svg's `SvgXml`.
