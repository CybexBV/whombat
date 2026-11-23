# Find My on a Mac's page: the build assignment

John, 2026-11-22: “Can we extend the Mac connector's dashboard and show the locations of the people (my family) on a
map?”, then “a combination”: a map with everyone on it, and for one person on request the exact picture from Find My.
Research (on his Mac Studio, macOS 27.2.1, Whombat Helper 1.0.6):

- Find My has no API and its cache files (`~/Library/Caches/com.apple.findmy.fmipcore/*.data`) are encrypted with a key
  only Apple's own processes can read while System Integrity Protection is on. Whombat reads **the Find My app** through
  Whombat Helper's Accessibility, as a person reads it.
- Find My's sidebar rows are `AXButton`s whose description is the row's words joined by ` · ` (U+00A0 U+00B7 U+00A0):
  `Mara Visser · Nearby · Home · Now`, `Ruben Visser · Nearby · Lelystad · Now`, `Mara’s Keys · No location found`. A selected
  row adds the street: `Mara’s Backpack · Home · Nearby · Damrak 1, Amsterdam · 5 minutes ago`. The tabs (People,
  Devices, Items, Me) are `AXRadioButton`s, People first. There are no coordinates anywhere (map pins are
  `AXGenericElement` “Mara Visser,Map pin”); the map is an `AXImage` described “Map”. Selecting a person centres Find My's
  map on them.
- A row's own actions are custom accessibility actions listed as `Name:Play\nTarget:0x0\nSelector:(null)`: for an item
  Open Details, Directions, Play; for a person Open Details, Directions · 0 min, Contact, **Remove Friend**, Remove from
  Favourites.
- Apple's geocoder answers a plain Swift program on the Mac (no key, about 100 m).
- The app's page may load images only from itself, `blob:` and `data:` (`contentSecurityPolicy`, `packages/core/src/text/page.ts`)
  and talks only to the box: a map from a tile service would need the box in between. The map is drawn **on the Mac by
  MapKit** instead (`MKMapSnapshotter`): Apple already holds these places, nothing new learns them, and the apps show a
  picture.
- Two gaps of the helper fixed in the same build: `open` by the name the Mac shows (“Find My”, whose file is
  `FindMy.app`; `list --app FindMy` even hit a widget extension), and running a row's named action (“Play”).

## 1. Whombat Helper 1.1.0 (`hosts/macos/helper`)

Requests and answers as today: one JSON line each way, root only.

| Request | Answer | Needs |
|---|---|---|
| `open` (target an app) | as today; the target also matches the app's **display name** (`FileManager.displayName(atPath:)`, `CFBundleDisplayName`, `CFBundleName`) and names match with spaces ignored (“FindMy” = “Find My”); a **bundle id** (`com.apple.findmy`) opens that app in any language | — |
| any `app` (list, press, …) | running apps: a regular app (`activationPolicy == .regular`) wins over an accessory or an extension **for every kind of match** (exact, then prefix, then contains); spaces ignored as above | — |
| `{"op":"action","app","name","role","index","action":"Play"}` | finds the element as `press` does, then performs the accessibility action named `action`: a custom action's name is the text after `Name:` up to the first newline; an `AX…` action matches by its own name. Exact (case- and space-insensitive) first, then prefix (“Directions” runs “Directions · 0 min”). `{"ok":true,"element":{…}}`; `not_found` with the element's action names in `names` | Accessibility, unlocked |
| `{"op":"quit","app":"Find My"}` | `NSRunningApplication.terminate()` on the matching regular app; waits up to 3 s; `{"ok":true}` (`"message":"It is still closing."` when it hasn't ended); `not_found` when it isn't running | — |
| `{"op":"geocode","queries":["Damrak 1, Amsterdam", …]}` (1–8, each ≤ 300 characters) | `{"ok":true,"places":[{"lat":52.37,"lon":4.89,"accuracy_m":100} or null, …]}` in the same order (null: nothing found). Apple's geocoder (`MKGeocodingRequest` on macOS 26+, `CLGeocoder` before), one query at a time, answers kept in memory for an hour. A network failure is `failed` with its words | works while locked |
| `{"op":"map","w":600,"h":400,"scale":2,"dark":false,"format":"jpeg","pins":[{"lat","lon"},…],"lat","lon","span_m"}` | `MKMapSnapshotter`, standard map, `dark` = `.darkAqua`. The region: `lat`+`lon`+`span_m` when given (span = the shorter side in metres), else every pin with a 30 % margin and at least 600 m, a single pin 600 m around it; neither is `invalid_request`. `w`,`h` 64–1600 points, `scale` 1 or 2 (image pixels = points × scale), ≤ 20 pins. `{"ok":true,"image":"<base64>","format":"jpeg","w":px,"h":px,"points":[{"x":pt,"y":pt} or null,…],"lat","lon","span_m"}`: `points` in the requested points (0…w, 0…h; null outside the picture), `lat`/`lon`/`span_m` the region drawn | works while locked |
| `status` | adds `"idle_s"`: whole seconds since the last keyboard or mouse input at the Mac (`CGEventSource.secondsSinceLastEventType(.hidSystemState, …)` for any input), null when unknown | — |

`geocode` and `map` may take 20 s (the others keep 10 s). Bump `VERSION` to 1.1.0, unit-test the matching, the action
names and the map region in `HelperCore`, build, sign, notarize and commit `dist/` on the Mac (`build.sh`).

## 2. The agent and the hub (`hosts/`)

New screen ops (`internal/proto/macos.go`), passed to the helper as above:

| Op | Fields | Helper | Role on the hub | Audit |
|---|---|---|---|---|
| `ui.action` | `app`, `name` (required), `role`, `index`, `action` (required, ≤ 200) | `action` | admin | like `ui.press`, plus `action` |
| `ui.quit` | `app` (required) | `quit` | admin | the app |
| `map.geocode` | `queries` (1–8, each ≤ 300) | `geocode` | admin, a read | the op only: **never the queries** |
| `map.snapshot` | `w`, `h` (64–1600), `scale` (1, 2), `dark`, `format`, `pins` (≤ 20; lat −90…90, lon −180…180), `lat`, `lon`, `span_m` (50 m…20,000 km) | `map` | admin, a read | the op only: **never a place** |
| `look` | adds `crop {x,y,w,h}` (framebuffer pixels, cut before scaling to `max_w`; clamped to the screen; w,h ≥ 1) | — | as today | as today |

- Answers add `places`, `points`, `lat`, `lon`, `span_m`, and for `map.snapshot` the picture in `image`/`format`/`w`/`h`
  as a look's. `status`'s helper adds `idle_s`.
- `map.*` and `ui.quit` don't need Accessibility nor an unlocked screen; `ui.action` does (as `ui.press`). Without a
  helper in the session they answer `no_helper`.
- A helper that doesn't know the op (“unknown op …”) is `unsupported`: “Whombat Helper on this Mac is older than this
  step; it updates itself.”
- Step limit 25 s for `map.*` (the hub waits 30 s, Whombat 35 s).
- The agent's command line: `screen ui action --name N --action A`, `screen ui quit --app A`,
  `screen map geocode --query Q …`, `screen map snapshot --pin LAT,LON … --w --h [--dark] --out FILE`,
  `screen look --crop X,Y,W,H`.
- `docs/WHOMBAT.md` “A Mac's screen” and `docs/decisions/hosts.md` say the same. The agent changes, so every server gets
  a new signed agent with the next release (meant).

## 3. Whombat's contract (`packages/core`)

The screen ops above in `HOST_SCREEN_OPS`, `HostScreenBody` (`action`, `queries`, `pins`, `lat`, `lon`, `spanM`, `w`,
`h`, `scale`, `dark`, `crop`), `HostScreenResult` (`places`, `points`, `lat`, `lon`, `spanM`) and `HostMacHelper.idleS`.

Find My on a Mac's page, five ops (`packages/core/src/contracts/hosts.ts`, schemas in `domain/hosts.ts`):

| Op | | |
|---|---|---|
| `hosts.findMy` | GET `/burrows/:burrow/hosts/servers/:serverId/find-my` | `HostFindMy`: what Whombat read last, kept in memory only |
| `hosts.findMyRefresh` | POST `…/find-my/refresh` `{}` | starts a read unless one runs or the last is under 2 minutes old; answers `HostFindMy` |
| `hosts.findMyExact` | POST `…/find-my/exact` `{person}` | starts the exact picture of one person; answers `HostFindMy` |
| `hosts.findMyMap` | GET `…/find-my/map?w&h&dark&lat&lon&spanM` | `HostFindMyMap`, an export read |
| `hosts.findMyPicture` | GET `…/find-my/picture?person` | `HostFindMyPicture`, an export read |

```ts
HostFindMy = {
  server: Id,
  reading: boolean,                 // a read is under way
  readAt: Timestamp | null,         // when `people` were read
  problem: HostFindMyProblem | null,// why the last read didn't work
  people: HostFindMyPerson[],       // Find My's People tab, in its order
  exact: { person: string, state: 'taking' | 'ready' | 'failed', takenAt: Timestamp | null,
           problem: HostFindMyProblem | null } | null,
}
HostFindMyPerson = {
  id: string,              // stable for the name: 12 hex characters of its SHA-256
  name: string,            // “Mara Visser”
  place: string | null,    // Find My's place words: “Home”, “Lelystad”
  address: string | null,  // the street when Find My gave one: “Damrak 1, Amsterdam”
  when: string | null,     // Find My's own words: “Now”, “5 min ago”
  nearby: boolean,         // Find My said “Nearby” (near the Mac)
  location: { lat: number, lon: number, accuracyM: number } | null,  // from the address, else the place; null: none
}
HostFindMyProblem = { code: HostScreenCode | 'in_use' | 'no_find_my' | 'helper_old', message?: string }
HostFindMyMap = { server, imageB64, format, w, h, points: { person: string, x: number, y: number }[], lat, lon, spanM }
HostFindMyPicture = { server, person, imageB64, format, w, h, takenAt }
```

`findMyProblemText(code, server, message?)` words a problem for both apps (the screen codes through
`hostScreenProblemText`).

## 4. The server (`apps/server/src/hosts/findmy.ts`)

- **A read** (one at a time per Mac): `status`. No helper, no Accessibility or a helper older than 1.1.0 is the problem.
  Unlocked and `idle_s` < 60 is `in_use` (someone is at the Mac: Whombat doesn't take the screen from them). Locked:
  `unlock` first. Note whether Find My was running (`ui.apps`), `ui.open` `com.apple.findmy` (the bundle id: the app's
  name is the Mac's language's), wait until its window lists radio
  buttons (≤ 8 s; else `no_find_my`), press the first radio button (People, in any language) by its description, `ui.list`,
  take the `AXButton`s whose description has ` · `. For each person with a place (three parts or more) press the row by
  name (role button), list again and take the part with a comma as the address, leaving out how far away the person is
  (“5,5 km”: a decimal comma in Dutch). `map.geocode` the addresses (or the
  place when there is none). Then `ui.quit` `com.apple.findmy` when it wasn't running, and lock the screen again
  (`keys` `ctrl+cmd+q`) when it was locked.
- **The exact picture**: the same start, press People and the person's row, press “Zoom in” twice when there is one,
  wait for the map to settle (1.5 s), `ui.list` for the window's largest `AXImage`, `look` cropped to it (JPEG, at most
  1280 px), then quit and lock as above. Kept in memory for 10 minutes, one per person.
- **The map**: `map.snapshot` with every located person's pin, in the page's theme; the same picture is kept for a
  minute.
- What was read lives in memory only and goes after an hour without a view: Whombat keeps no history of where anyone
  was, never logs a place, and signs none of these steps (the hosts service audits them, without places).
- Find My's ops are an owner's (admin), as a look is, and need the host-shell switch on both sides.
- **The assistant**: `mac_ui` gains `action` (`name`, `action`, `app`, `role`, `index`) and `quit` (`app`); `list`
  answers each element's own action names (“Play”, “Directions · 0 min”). An action whose name removes, deletes, erases,
  forgets, blocks, unpairs, signs out, stops sharing or marks something lost (English, Dutch, German, French, Spanish) is
  refused by name with a sentence that says to do it on the Mac's screen.

## 5. The apps

- Tabs: web Summary · Screen · Find My · Storage · Sensors · System; phone Summary · Screen · Find My.
- The Find My tab reads when it opens (when the last read is older than 2 minutes) and every 15 minutes while it stays
  open; “Read again” reads now. While a read runs the apps ask `hosts.findMy` every 2 s.
- A map card (the Mac's map in the app's theme, ＋ and − to zoom, each person as an initials avatar with their first name)
  and the people: name, “Home · Now”, and **Show exactly**, which takes the picture and shows it with “Find My on
  {server} · {when}”.
- Every problem in one line (`findMyProblemText`); `in_use`: someone is using the Mac, Whombat waits.
- The fixture Mac answers Find My with made-up people and a drawn map (`packages/client/src/hosts/fixtures-mac.ts`, the
  phone's demo world).
