/**
 * Advanced → Model and effort (AP-4968; was Settings → Agent → Model and AI): the provider, its model and effort, Fast
 * replies and whose sign-in it runs on.
 */
import { RunsOnSection } from '../RunsOnSection';
import { type PartProps, PartScroll } from './parts';

export function ModelPart({ profile, refetch }: PartProps) {
  return (
    <PartScroll refreshing={false} onRefresh={refetch}>
      <RunsOnSection profile={profile} onChanged={refetch} />
    </PartScroll>
  );
}
