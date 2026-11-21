/**
 * The council's elders (app council-web.md, council-phone.md): each member of a council drawn as an old, wise wombat
 * seated to the waist at the council's table, in the faces' drawing (`svg/*-bust.svg`: the same skull, ears, muzzle and
 * nose) with grey fur, a white beard and brows, and a robe. The seat (first to fourth) sets the robe and what it wears
 * (round glasses, a cap, half-moon glasses, a tall collar), never the company: the plaque in front of it says who it is.
 * How it sits says how it is doing (`ElderPose`).
 *
 * Pure: one SVG document as a string, which the web puts inline and the phone draws with `SvgXml`. Every id in it starts
 * with `idPrefix`, so many elders share a page. The thought dots and the sleeper's z marks are `currentColor` (the
 * text colour around it). The parts that may move carry `data-elder` (`figure`, `dot1`…`dot3`, `z1`, `z2`): the web
 * animates them with CSS; the phone draws them still.
 */

/**
 * How an elder sits: waiting (awake, its turn still to come), thinking (working), answered (with its scroll), agrees,
 * doubts (one brow up), resting (asleep).
 */
export type ElderPose = 'waiting' | 'thinking' | 'answered' | 'agrees' | 'doubts' | 'resting';

export const ELDER_POSES = [
  'waiting',
  'thinking',
  'answered',
  'agrees',
  'doubts',
  'resting',
] as const satisfies readonly ElderPose[];

/** The drawing's size: wider than tall, cut at the table's edge. */
export const ELDER_VIEWBOX = { width: 200, height: 190 } as const;

/** A seat's robe (light, mid, deep) and what it wears; seats past the fourth start again. */
const SEATS = [
  { robe: ['#b4a9dd', '#8f7fc9', '#5e4f99'], wears: 'glasses' },
  { robe: ['#9cba96', '#66865f', '#435e40'], wears: 'cap' },
  { robe: ['#d8a27c', '#ad7049', '#7d4c2e'], wears: 'halfMoon' },
  { robe: ['#9fb3c9', '#6a819c', '#465a73'], wears: 'collar' },
] as const;

type Wears = (typeof SEATS)[number]['wears'];

export interface ElderOptions {
  /** 0 for the first seat. */
  seat: number;
  pose: ElderPose;
  /** Starts every id in the drawing (letters, digits, `-`, `_`). */
  idPrefix: string;
}

/** The head is the faces' 512 drawing, scaled into the seat. */
const HEAD = 'translate(100 86) scale(.34) translate(-256 -252)';

function wearing(wears: Wears, robe: readonly [string, string, string]): string {
  switch (wears) {
    case 'glasses':
      return `<g fill="#fff" fill-opacity=".12" stroke="#4a3a2f" stroke-width="7"><circle cx="193" cy="216" r="34"/><circle cx="319" cy="216" r="34"/></g><path d="M227 210Q256 198 285 210M159 210L124 188M353 210L388 188" fill="none" stroke="#4a3a2f" stroke-width="7" stroke-linecap="round"/>`;
    case 'halfMoon':
      return `<path d="M161 222A32 32 0 0 0 225 222ZM287 222A32 32 0 0 0 351 222Z" fill="#fff" fill-opacity=".12" stroke="#7a5a2a" stroke-width="7" stroke-linejoin="round"/><path d="M225 222Q256 214 287 222" fill="none" stroke="#7a5a2a" stroke-width="7"/>`;
    case 'cap':
      return `<path d="M128 178C136 92 376 92 384 178C330 156 182 156 128 178Z" fill="${robe[1]}"/><path d="M128 178C182 156 330 156 384 178" fill="none" stroke="${robe[2]}" stroke-width="12" stroke-linecap="round"/><path d="M170 150C200 128 312 128 342 150" fill="none" stroke="${robe[0]}" stroke-width="6" opacity=".5"/>`;
    case 'collar':
      return '';
  }
}

/** One elder as an SVG document (decorative: the plaque beside it carries its words). */
export function elderSvg({ seat, pose, idPrefix }: ElderOptions): string {
  const p = idPrefix.replace(/[^\w-]/g, '');
  const { robe, wears } = SEATS[((seat % SEATS.length) + SEATS.length) % SEATS.length] ?? SEATS[0];
  const [r1, r2, r3] = robe;
  const awake = pose !== 'thinking' && pose !== 'resting';
  const eyes = awake
    ? `<circle cx="193" cy="214" r="16" fill="url(#${p}eye)"/><circle cx="188" cy="208" r="5" fill="#fff"/><circle cx="319" cy="214" r="16" fill="url(#${p}eye)"/><circle cx="314" cy="208" r="5" fill="#fff"/><path d="M172 222Q193 236 214 222M298 222Q319 236 340 222" fill="none" stroke="#8a7d72" stroke-width="5" stroke-linecap="round" opacity=".6"/>`
    : '<path d="M172 214Q193 232 214 214M298 214Q319 232 340 214" fill="none" stroke="#2a211c" stroke-width="8" stroke-linecap="round"/>';
  // Doubts: the left brow goes up.
  const leftBrow = pose === 'doubts' ? ' transform="translate(0 -12) rotate(-8 190 176)"' : '';
  // Agrees: the beard's corners lift in a smile under the moustache.
  const smile =
    pose === 'agrees'
      ? '<path d="M222 340Q256 362 290 340" fill="none" stroke="#3a2d27" stroke-width="6" stroke-linecap="round"/>'
      : '';
  const above =
    pose === 'thinking'
      ? '<g fill="currentColor"><circle data-elder="dot1" cx="150" cy="30" r="3.4"/><circle data-elder="dot2" cx="162" cy="22" r="4"/><circle data-elder="dot3" cx="176" cy="13" r="4.8"/></g>'
      : pose === 'resting'
        ? '<g fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path data-elder="z1" d="M146 30h7l-7 8h7"/><path data-elder="z2" d="M160 14h9l-9 10h9"/></g>'
        : '';
  // Only an elder that answered holds its scroll.
  const scroll =
    awake && pose !== 'waiting'
      ? '<g transform="translate(118 176) rotate(-8)"><rect width="38" height="11" rx="5.5" fill="#f4ead6" stroke="#b49a72" stroke-width="1.2"/><ellipse cx="38" cy="5.5" rx="3" ry="5.5" fill="#e6d6b8" stroke="#b49a72" stroke-width="1.2"/><rect x="17" y="-.5" width="4" height="12" fill="#a8463a"/></g>'
      : '';
  const collar =
    wears === 'collar'
      ? `<path d="M50 140C66 118 84 112 100 118C116 112 134 118 150 140C134 134 116 132 100 140C84 132 66 134 50 140Z" fill="${r1}" stroke="${r3}" stroke-width="2"/>`
      : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${ELDER_VIEWBOX.width} ${ELDER_VIEWBOX.height}" aria-hidden="true" focusable="false"><defs><radialGradient id="${p}fur" gradientUnits="userSpaceOnUse" cx="215" cy="180" r="280"><stop offset="0" stop-color="#e2ddd6"/><stop offset=".55" stop-color="#b3aba2"/><stop offset="1" stop-color="#7a726a"/></radialGradient><radialGradient id="${p}ear" cx=".4" cy=".3" r=".85"><stop offset="0" stop-color="#c9c2b9"/><stop offset="1" stop-color="#857c73"/></radialGradient><radialGradient id="${p}muz" gradientUnits="userSpaceOnUse" cx="236" cy="296" r="150"><stop offset="0" stop-color="#fbf8f2"/><stop offset="1" stop-color="#ddd5ca"/></radialGradient><radialGradient id="${p}nose" gradientUnits="userSpaceOnUse" cx="226" cy="250" r="115"><stop offset="0" stop-color="#6d5b50"/><stop offset=".5" stop-color="#2b221d"/><stop offset="1" stop-color="#17120f"/></radialGradient><radialGradient id="${p}eye" cx=".38" cy=".3" r=".85"><stop offset="0" stop-color="#4f4037"/><stop offset="1" stop-color="#16120f"/></radialGradient><linearGradient id="${p}beard" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e4ddd2"/></linearGradient><radialGradient id="${p}robe" gradientUnits="userSpaceOnUse" cx="80" cy="140" r="130"><stop offset="0" stop-color="${r1}"/><stop offset=".55" stop-color="${r2}"/><stop offset="1" stop-color="${r3}"/></radialGradient></defs>${above}<g data-elder="figure"><path d="M22 190C22 150 50 126 100 124C150 126 178 150 178 190Z" fill="url(#${p}robe)"/><path d="M62 132C80 150 120 150 138 132L130 190H70Z" fill="${r3}" opacity=".35"/>${collar}<g transform="${HEAD}"><ellipse cx="112" cy="184" rx="33" ry="37" transform="rotate(-18 112 184)" fill="url(#${p}ear)"/><ellipse cx="116" cy="188" rx="16" ry="21" transform="rotate(-18 116 188)" fill="#c8a99a"/><ellipse cx="400" cy="184" rx="33" ry="37" transform="rotate(18 400 184)" fill="url(#${p}ear)"/><ellipse cx="396" cy="188" rx="16" ry="21" transform="rotate(18 396 188)" fill="#c8a99a"/><path d="M92 268C92 168 162 122 256 122C350 122 420 168 420 268C420 336 358 382 256 382C154 382 92 336 92 268Z" fill="url(#${p}fur)"/><ellipse cx="256" cy="312" rx="108" ry="58" fill="url(#${p}muz)"/><path d="M160 316C156 420 204 500 256 548C308 500 356 420 352 316C322 352 292 362 256 362C220 362 190 352 160 316Z" fill="url(#${p}beard)"/><path d="M200 400Q214 450 236 488M312 400Q298 450 276 488M256 380V500" fill="none" stroke="#d6cdbf" stroke-width="5" stroke-linecap="round"/>${smile}<path d="M256 296C228 320 192 328 166 310C186 344 232 344 256 318C280 344 326 344 346 310C320 328 284 320 256 296Z" fill="#fff" stroke="#d9d1c4" stroke-width="3"/><g transform="translate(0 2)"><path d="M182 262C182 242 214 234 256 234C298 234 330 242 330 262C330 288 294 300 256 300C218 300 182 288 182 262Z" fill="url(#${p}nose)"/><ellipse cx="222" cy="250" rx="24" ry="8" fill="#a8968a" opacity=".5" transform="rotate(-8 222 250)"/></g>${eyes}<g fill="#fbf9f4" stroke="#d6cdbf" stroke-width="3"><path d="M150 186C160 160 200 156 224 172C204 170 186 176 168 190C164 184 158 184 150 186Z"${leftBrow}/><path d="M362 186C352 160 312 156 288 172C308 170 326 176 344 190C348 184 354 184 362 186Z"/></g>${wearing(wears, robe)}</g><ellipse cx="66" cy="187" rx="15" ry="7" fill="#9d958c"/><ellipse cx="134" cy="187" rx="15" ry="7" fill="#9d958c"/>${scroll}</g></svg>`;
}
