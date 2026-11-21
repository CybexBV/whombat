---
name: connection-pages
description: Give a Custom connection (an MCP server or an API you set up) its own logo and a page that shows what it can read — sensors, states, counts, what happens now — laid out like the services Whombat knows. Use right after such a connection is connected, or when the person asks for its logo or page.
---

# A logo and a page for a Custom connection

A service Whombat has no entry for is connected as `custom_mcp` (an MCP server) or `custom_api` (an HTTP API). Out of
the box it shows a generic mark and a page that only says how fast it answers. You give it its own logo and a page
built from what it can read, with `connection_look`. Whombat checks everything you give it.

## The logo

Whombat looks for the service's own logo by itself right after Connect: the MCP server's own icon, then the SVG icon
its website names. `connection_look` with only `connection` tells you whether it found one (`logo.from`).

If it has none, or it isn't the brand's real logo, find one yourself. Only SVG works (no PNG, no JPEG). Try, in order:

1. Simple Icons: `https://cdn.jsdelivr.net/npm/simple-icons@latest/icons/<slug>.svg` (slugs are the brand name in
   lower case without spaces or dots: `homeassistant`, `openweathermap`, `linear`). Search
   `https://simpleicons.org/?q=<name>` when unsure.
2. dashboard-icons, for self-hosted apps: `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/<name>.svg`
   (kebab-case: `home-assistant`, `uptime-kuma`).
3. svgl: `https://api.svgl.app?search=<name>` answers JSON; use its `route` (a string, or `light` of `{light, dark}`).
4. The brand's own press or brand page, or its website's SVG logo.

Check that it is that brand (not another with a similar name) before you keep it. Give it as `logo` with `save: true`.
Whombat refuses one it can't draw (text, pictures, masks) and says why: try the next source. `logo: "none"` goes back to
the generic mark.

## The page

1. Find out what it can read. An MCP server: its read-only tools in `connection_tools` (a page may only use tools marked
   as reads). An API: its documentation, its GET endpoints. Call the most useful ones once with `connection_call` and
   look at the real answers.
2. Pick what the person would want at a glance: what is happening now, what it holds, a number worth a weekly trend,
   and what should warn them. Leave out what nobody needs to see. Fewer, better parts.
3. Write the recipe and try it: `connection_look` with `page` and no `save`. It reads everything now and answers with
   what each part would show (`page.shows`) and what is wrong (`page.problems`). Fix every problem, try again.
4. When it shows the right things and nothing is wrong, call it again with `save: true`. `page: null` removes the page.

### The recipe

```json
{
  "reads": [
    { "id": "status", "tool": "get_status", "args": {}, "everyS": 60 },
    { "id": "queue", "path": "/api/v1/queue", "query": { "limit": "20" }, "everyS": 30 }
  ],
  "live": {
    "title": "Downloading now", "read": "queue", "items": "data.items",
    "name": { "at": "title" }, "detail": { "at": "size", "format": "bytes" },
    "right": { "at": "progress", "format": "percent" },
    "tone": { "at": "state", "bad": ["failed"], "warn": ["paused"] },
    "empty": "Nothing is downloading."
  },
  "counts": {
    "title": "In the house",
    "lines": [
      { "id": "lights", "title": "Lights on", "value": { "read": "status", "at": "lights.on" }, "change": true },
      { "id": "temp", "title": "Living room", "value": { "read": "status", "at": "sensors.living.temp", "unit": "°C" } }
    ]
  },
  "trend": { "title": "Energy", "label": "Energy", "value": { "read": "status", "at": "energy.today_kwh", "unit": "kWh" }, "how": "max", "rest": "kWh today" },
  "list": { "title": "Recent events", "read": "status", "items": "events", "name": { "at": "message" }, "right": { "at": "time", "format": "ago" } },
  "facts": [{ "label": "Firmware", "value": { "read": "status", "at": "version" } }],
  "warnings": [
    { "id": "offline", "title": "The hub is offline", "value": { "read": "status", "at": "online" }, "equals": false, "important": true },
    { "id": "battery", "title": "A sensor battery is low", "value": { "read": "status", "at": "battery.min" }, "below": 15, "important": false }
  ]
}
```

- `reads` (1–6): `tool` (+ `args`) for an MCP server, `path` (+ `query`, a GET from the API's address) for an API.
  `everyS` 30–3600 (60 when absent): how long an answer is kept. Every part names its read by `id`.
- A path is keys and list positions joined by dots (`data.items.0.name`), `$` for the whole answer. Inside `live` and
  `list`, `name`, `detail`, `right` and `tone` start at each item.
- Formats: `text`, `number`, `percent` (0–100; add `"scale": 100` for 0–1), `bytes`, `duration` (seconds), `date`,
  `ago`, `count` (how many items), `yesno`. `unit` goes after a number; `scale` multiplies first.
- `live`: what happens now (two of three columns). `counts`: up to 8 lines with their number large (one column);
  `change: true` says what changed on last week once Whombat has a week of readings. `trend`: a bar a day of one number
  over the last week, from Whombat's own readings every five minutes (`how`: the day's `last`, `max`, `sum` or `mean`;
  it appears after two days). `list`: anything else, below. `facts`: up to 3 in the page's head. Leave out any part
  you have nothing good for.
- `warnings`: a line on the page while its one condition holds (`above`, `below`, `equals`, `not`, or `present: true`).
  `important: true` only when it means the thing is down or broken now, data is at risk, a backup isn't happening, a
  security opening, or money being lost: Whombat watches those from the start. Everything else is `important: false`
  and starts off until the person turns it on in What Whombat watches. When in doubt, false.

## Words

Titles and lines are what the person reads: short and plain (“Downloading now”, “Lights on”, “The hub is offline”), no
ids, paths or field names. When you are done, tell the person in one sentence what the page shows (“Linear now has its
logo and a page with your open issues and what changed this week.”); never paste the recipe into the chat.
