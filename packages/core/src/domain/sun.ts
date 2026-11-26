/**
 * When the sun rises and sets, worked out here rather than asked of a service (Whombat docs/decisions/weather-news.md):
 * NOAA's solar position equations, good to about a minute between the polar circles. Pure.
 */

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
/** The sun's centre this far below the horizon is sunrise and sunset: refraction and the sun's own size. */
const HORIZON_DEG = 90.833;

/**
 * A day's sunrise and sunset (epoch milliseconds), or why there is none: `polar` `day` the sun stays up all day,
 * `night` it stays down.
 */
export interface SunTimes {
  rise: number | null;
  set: number | null;
  polar: 'day' | 'night' | null;
}

/** The sun's declination (radians) and the equation of time (minutes) at a moment. */
function sunAt(ms: number): { decl: number; eqTime: number } {
  const t = (ms / DAY_MS + 2440587.5 - 2451545) / 36525;
  const l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const c =
    Math.sin(m * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * t;
  const lambda = l0 + c - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTime =
    (4 / RAD) *
    (y * Math.sin(2 * l0 * RAD) -
      2 * e * Math.sin(m * RAD) +
      4 * e * y * Math.sin(m * RAD) * Math.cos(2 * l0 * RAD) -
      0.5 * y * y * Math.sin(4 * l0 * RAD) -
      1.25 * e * e * Math.sin(2 * m * RAD));
  return { decl, eqTime };
}

/** The hour angle (degrees) of sunrise at a latitude and declination; NaN when the sun doesn't cross the horizon. */
function hourAngle(lat: number, decl: number): number {
  const cos =
    Math.cos(HORIZON_DEG * RAD) / (Math.cos(lat * RAD) * Math.cos(decl)) -
    Math.tan(lat * RAD) * Math.tan(decl);
  return cos > 1 || cos < -1 ? Number.NaN : Math.acos(cos) / RAD;
}

/**
 * Sunrise and sunset on a local date (`YYYY-MM-DD`) at a latitude and longitude: the ones around that date's solar noon
 * there, so in the far east or west one may fall on the day before or after in UTC. Each is worked out twice, the
 * second time with the sun where it is at the first answer.
 */
export function sunTimes(date: string, lat: number, lon: number): SunTimes {
  const day = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(day)) throw new Error(`not a date: ${date}`);
  // Minutes after the date's 00:00 UTC.
  const noonGuess = 720 - 4 * lon;
  const noon = noonGuess - sunAt(day + noonGuess * 60_000).eqTime;
  const at = (sign: -1 | 1): number | null => {
    let minutes = noon;
    for (let i = 0; i < 2; i++) {
      const sun = sunAt(day + minutes * 60_000);
      const ha = hourAngle(lat, sun.decl);
      if (Number.isNaN(ha)) return null;
      minutes = 720 - 4 * (lon - sign * ha) - sun.eqTime;
    }
    return Math.round(day + minutes * 60_000);
  };
  const rise = at(-1);
  const set = at(1);
  if (rise !== null && set !== null) return { rise, set, polar: null };
  // No crossing (or only one, the day the polar night or day begins): the sun is up all day when it is above the
  // horizon at noon.
  const decl = sunAt(day + noon * 60_000).decl;
  const noonElevation = 90 - Math.abs(lat * RAD - decl) / RAD;
  return { rise: null, set: null, polar: noonElevation > 90 - HORIZON_DEG ? 'day' : 'night' };
}
