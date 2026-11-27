# The weather and the news in the apps (AP-10000 … AP-10014, AP-10051 … AP-10058)

John, 2026-11-26: “I realized that we need to improve more capabilities in Whombat by default, for example weather
information which will be useful for Dusty in both dashboard view (morning page for example), but also for Dusty's
"Look ahead" feature. Perhaps we should also add local news (country / state)?” The product's decisions are Whombat
`docs/decisions/weather-news.md`; these are the screens': the two widgets as `@whombat/screen` draws them (the box,
every screen elsewhere, the editors) and Place and News in Settings → This Whombat on the web and the phone.

## AP-10000 The weather's forms grow with its size

`weatherForm(w, h)` in `packages/screen/src/forms.ts`: one cell wide is the sign and the temperature (`tile`, the
highest and lowest under them); two wide and one high adds what the sky does (`line`); three or more wide and one high
puts the next hours beside it (`strip`); two or three wide and higher puts them under it (`block`, and the days under
the hours when it is three high or more); four or more wide and two high has the hours beside a fuller now (`wide`:
highest and lowest, feels like and the wind, the chance of rain); three high or more adds the days under it and sunrise
and sunset (`large`). Opening it big shows its largest size (8 × 4), so the `large` form.

## AP-10001 MET Norway's credit wherever there's room

“Data from MET Norway” (the view's `credit`) sits small at the bottom right of every form two cells or more each way
(`weatherCredit`). The one-high and one-wide forms leave it out: there is no room that wouldn't crowd the temperature,
and the larger forms, opening big and the assistant's answers carry it. No Yr name or logo anywhere.

## AP-10002 The screen's own weather signs

The signs are drawn in `packages/screen/src/WeatherIcon.tsx` from a symbol's parts (`weatherSign` in `weather.ts`): the
sun or the moon (alone, beside a small cloud, or peeking from behind one), a cloud, rain, sleet or snow (two, three or
four pieces for light, plain and heavy), a flash, fog. Lines in the token colours: the cloud in the ink, filled with the
card so a sun behind it stays behind, the sun in `--warn`, the moon in `--brand`, rain in `--chart1`, snow in `--ink`.
No pictures from anywhere. A polar twilight's sun is the day's; a symbol MET adds later is a plain cloud. Always
decorative: the words beside it say what the sky does.

## AP-10003 The next hours

Columns of the hour, its sign and its temperature; the first says “Now”, the others the hour's clock in the screen's
time zone. Every hour when twelve or more columns fit, else every second or third hour, so a narrow strip still reaches
into the evening (`weatherHourPicks`, 56 px a column). The rain of an hour shows under it on the wide and large forms
only.

## AP-10004 The days

“Today”, then each day's short name (“Wed”), its sign, its rain, and its lowest to highest as a bar on the week's
scale, cool to warm (`--chart1` to `--warn`). A card narrower than 420 px leaves the rain column out rather than squeeze
it. As many days as fit, up to seven.

## AP-10005 The place in the header; a problem as every problem

The header is the weather sign and the place's name (“Amsterdam”). A forecast that couldn't be read is the widget's
usual problem form (the red card, the runtime's words); one cell wide the words are 17 px so they fit. Without a
forecast and without a place it says “Choose where this Whombat is in Settings”.

## AP-10006 The news reads as headlines

The `news` widget's `list` view is drawn as headlines: each headline in bold, its site and time under it (“NOS ·
14:12”), as many as fit; one cell high, the first headline alone on up to two lines. With no site on it says “Choose
your news in Settings” (or the view's own `empty`).

## AP-10007 The editor's signs

The web editor's *Add a widget* shows Weather with lucide's `CloudSun` and News with `Newspaper`, as the phone's
already do; on the screen their headers have the screen's own small sun-and-cloud and newspaper tiles.

## AP-10008 Place and News sit beside the time zone

On the web they are This Whombat → About's PLACE and NEWS, right after the quiet hours (whose line names the time
zone). On the phone they are cards after VERSION on This Whombat's About and on the demo world's This Whombat. Both are
asked only of a Whombat at `WEATHER_NEWS_MINOR` or later (`placeNewsShown`); an older one shows neither.

On the phone superseded by AP-10051.

## AP-10009 Changing the place

The row says “Amsterdam · guessed from the time zone” or the place chosen (“Eindhoven, Noord-Brabant”), with the
country under it, and *Change*. *Change* opens in the card: a town or city to look up (two letters or more), up to five
places as buttons (the place and its region, the country beside it), and one tap keeps it. *Use my location* (web) asks
the browser only when pressed and rounds to two decimals before it is sent. *Use the time zone’s guess* shows only
once a place was chosen. “© OpenStreetMap” stays under the results while the search is open. Saving says “Saved. The
weather and news are for Eindhoven now.” and the suggested news follows the new place.

## AP-10010 No *Use my location* on the phone yet

The phone app has no location module. Adding one (`expo-location`) means a native module, its permission words on both
platforms and a new build, for a button the search already covers. Left until the phone needs the location for more.

## AP-10011 The news part

One line first: headlines come straight from these sites to this Whombat, and nothing is read until a site is on. Then
*Your news*: each site's name, its address under it and its problem in amber, with *Turn off* (a suggested site) or
*Remove* (one the person added). Then *Suggested for …* — the region's name when the place has one (“Noord-Brabant”),
else the country (“the Netherlands”) — each with *Turn on*, in the server's nearest-first order. Then *Add a news site*:
the address and *Add*; a refusal (not https, not a feed, the twelfth) says the server's words under the field, and an
added site says “AT5 is on.”. With twelve on, the line says so and *Turn on* and *Add* wait.

On the phone superseded by AP-10052 … AP-10056.

## AP-10012 Buttons, not switches, and no confirm

A site turned off leaves *Your news* (a suggestion goes back to the suggestions), so a switch that made its own row
vanish would mislead: plain buttons say what happens. Neither asks first: the person can turn it on or add it again in
one step.

## AP-10013 One fake for fixture mode and the demo world

`@whombat/client/weather-news/fake` answers the five ops as the runtime does, refusals included: a few real towns to
find (by name, and the nearest for a latitude and longitude), the time zone's guess (Amsterdam) and AT5 on to start, so
Settings shows a site on and one suggested; looking up “Eindhoven” gives Noord-Brabant and Omroep Brabant. The web's
fixture mode (`placeNewsFixtures.ts`) and the phone's demo world serve it with the burrow's `place` in every answer
that carries the burrow. The fake screens serve the weather and news views from `@whombat/screen`'s fixtures, and
`pnpm --filter @whombat/screen shots f-weather-news` draws every form.

## AP-10014 The words

Everything said is the contracts' (`PLACE_SETTING_WORDS`, `NEWS_WORDS`, `WEATHER_WORDS`) or the screen's own
(`SCREEN_WORDS.weather`, `.news`), a test keeping the screen's equal to core's. A country is named in English by the
device (`Intl.DisplayNames`), its code where the device can't, with “the” where English says it.

## The phone's News and weather page (2026-11-27)

John, 2026-11-27: Settings gets a News and weather group of its own, with up to 30 sources, browsing by country and
topic, and importing a list (Whombat `docs/decisions/weather-news.md`, session minor 19). These are the phone's.

## AP-10051 A page of its own

Settings → News and weather is a row after This Whombat (lucide's `Newspaper`, the line `NEWS_WORDS.homeLine`) and a
page at `whombat://settings/news`, which the web's `/settings?tab=news` and `/settings/news` open too; Search finds it
by “weather”, “place”, “headlines”, “feeds” and “sources”, and the app reopens on it. The row and the page are there
only where the Whombat answers the place and the news (`placeNewsShown`). PLACE and the news left This Whombat →
About and the demo world's This Whombat. The demo world serves `createFakePlaceNews`, which answers browsing and
importing as the runtime does.

## AP-10052 The page: PLACE, YOUR SOURCES, FIND MORE

The page's line (`pageLine`), then PLACE as before (AP-10009, AP-10010), then YOUR SOURCES with “5 of 30” at the label's
end and the line that nothing is read until a source is on. Each source has its mark, its name, a line saying what it
is (“Netherlands · national”, “Noord-Brabant · regional”, “Netherlands · Tech”, “YouTube · added by you”, the feed's
host when the suggestion isn't known) and its problem in amber, with *Turn off* (a suggestion) or *Remove* (one the
person added). With every place taken the list says so (“Up to 30 sources. Turn one off first.”), and *Add* and
*Import* wait. Then FIND MORE, with three underlined tabs: *Suggested*, *Add your own* (the address and *Add*, as
before) and *Import*.

## AP-10053 *Change order* instead of dragging

Under the list, *Change order* swaps each row's *Turn off* or *Remove* for *Move up* and *Move down* (44 dp each, named
“Move NOS up”) until *Done*. A row isn't wide enough for *Turn off* and two arrows, and the app has no shared drag list
to reuse. Each move is saved at once; the first can't go up and the last can't go down.

## AP-10054 *Suggested*: a country and topic chips

A *Country* row with the country's name opens a sheet listing the countries the Whombat has sites for, by name, the
chosen one ticked; it starts at the place's country. Under it the chips All · Near you · National · Tech · Sport ·
Business · Science · Culture, only those with sites in that country (Near you: the place's region or area; National:
the country's general news). Each site has its mark, its name, its line (“National”, “Tech”, “Noord-Brabant ·
regional”) and *Add*, or a tick and “On” in the ok colour where it is on already. Adding says “AT5 is on.”.

## AP-10055 *Import* with the document picker

*Import* opens the system's file picker (`expo-document-picker`, already in the app) for an OPML file from another
news reader, reads at most 1 MB of it, takes its feed addresses, sends up to 30 to the Whombat, and says what came of
it in a notice (“2 sources added. 1 couldn’t be added.”). A file with no addresses says so under the button. The
picker's copy is deleted afterwards.

## AP-10056 An older Whombat keeps the old part

A Whombat before the browse and import contracts (`newsMoreShown` false) keeps the limit of twelve (“5 of 12”), its
*Suggested* is the old list of suggestions for the place (titled “Suggested for Noord-Brabant”), and there is no
*Import* tab, country or chips.

## AP-10057 Source marks

A source's mark is a 32 dp square with radius 8 in the avatar tone for its id (`toneFor`), with up to three letters
in the avatars' initials colour: an abbreviation its name starts with (“NOS”, “RTL”), else the first letters of its
first two words (“OB” for Omroep Brabant). The phone loads no pictures from news sites.

## AP-10058 The phone's words

Everything said is the contracts' (`NEWS_WORDS`, `NEWS_TOPIC_WORDS`, `NEWS_KIND_WORDS`, `PLACE_SETTING_WORDS`).
The phone needed five more, kept at the end of `NEWS_WORDS` under “phone”: “On”, “Change order”, “Done”, “Move {name}
up” and “Move {name} down”.
