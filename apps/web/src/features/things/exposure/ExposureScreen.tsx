/** Open to the internet in the Servers place (`/internet`): its row picked in the list beside it on a wide window. */
import { EXPOSURE_PATH } from '@whombat/client';
import { PageInPlace } from '../places/ThingPlace';
import { ExposurePage } from './ExposurePage';

export function ExposureScreen({ burrow }: { burrow: string }) {
  return (
    <PageInPlace burrow={burrow} place="servers" selected={EXPOSURE_PATH}>
      <ExposurePage burrow={burrow} />
    </PageInPlace>
  );
}
