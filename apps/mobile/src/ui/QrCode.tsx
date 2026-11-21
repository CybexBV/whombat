/**
 * A QR code on the phone (hermes-engine-app.md AP-5473), the web's `QrCode` (AP-523) in react-native-svg: error
 * correction M, a four-module quiet zone, dark modules on a light plate in both themes (scanners read dark-on-light
 * best; both colors are fixed tokens, `knob` and `avatarInk`), every module a whole number of dp so edges stay sharp.
 */
import { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';
import { encode } from 'uqr';
import { useTheme } from '../theme/theme';

/** Quiet zone around the modules, in modules (ISO/IEC 18004 asks for 4). */
const QUIET = 4;

/** The dark modules as one path of horizontal runs, and the code's width in modules (the web's `qrPath`). */
export function qrPath(value: string): { path: string; count: number } {
  const qr = encode(value, { ecc: 'M', border: 0 });
  let path = '';
  qr.data.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) x++;
      path += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  });
  return { path, count: qr.size };
}

export function QrCode({ value, size, label }: { value: string; size: number; label: string }) {
  const theme = useTheme();
  const { path, count } = useMemo(() => qrPath(value), [value]);
  const total = count + QUIET * 2;
  const px = Math.max(1, Math.floor(size / total)) * total;
  return (
    <Svg
      width={px}
      height={px}
      viewBox={`0 0 ${total} ${total}`}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
    >
      <Rect width={total} height={total} fill={theme.colors.knob} />
      <Path d={path} fill={theme.colors.avatarInk} transform={`translate(${QUIET} ${QUIET})`} />
    </Svg>
  );
}
