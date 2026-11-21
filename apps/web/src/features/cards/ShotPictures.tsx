import type { Attachment, CouncilShot } from '@whombat/core';
import { useState } from 'react';
import { useImageSrc } from '../messaging/attachmentSource';
import { AttachmentViewer } from '../messaging/MessageAttachments';
import s from './ShotPictures.module.css';

/**
 * Pictures of what changed (Whombat council.md CNL-32, delegate.md DLG-27), as the council's final card and a delegation
 * task's row both draw them: per screen its name, the picture Whombat drew (before on top, after below) at the width it
 * is given, which opens the attachment viewer, the hint when it has numbered areas, and its notes in their numbers'
 * order. The pictures are files of the card's message; one that isn't there, or doesn't load, is left out and its notes
 * stay.
 */
export function ShotPictures({
  shots,
  attachments,
  hint,
}: {
  shots: readonly CouncilShot[];
  attachments: readonly Attachment[];
  /** Under a picture with numbered areas: how to read it. */
  hint: string;
}) {
  const [opened, setOpened] = useState<Attachment | null>(null);
  return (
    <>
      {shots.map((shot) => {
        const attachment = attachments.find((a) => a.id === shot.attachmentId) ?? null;
        return (
          <Shot
            key={`${shot.attachmentId}-${shot.view}`}
            shot={shot}
            attachment={attachment}
            hint={hint}
            onOpen={() => setOpened(attachment)}
          />
        );
      })}
      <AttachmentViewer attachment={opened} onClose={() => setOpened(null)} />
    </>
  );
}

/** One screen that changed: its name, the picture (opens in the viewer), the hint and its notes. */
function Shot({
  shot,
  attachment,
  hint,
  onOpen,
}: {
  shot: CouncilShot;
  attachment: Attachment | null;
  hint: string;
  onOpen: () => void;
}) {
  const image = useImageSrc(attachment);
  return (
    <figure className={s.shot}>
      <figcaption className={s.name}>{shot.view}</figcaption>
      {attachment && !image.failed && (
        <button type="button" className={s.picture} onClick={onOpen}>
          <img
            src={image.src ?? undefined}
            alt={shot.view}
            width={shot.width}
            height={shot.height}
            style={{ aspectRatio: `${shot.width} / ${shot.height}` }}
            loading="lazy"
            decoding="async"
          />
        </button>
      )}
      {shot.areas > 0 && <p className={s.hint}>{hint}</p>}
      {shot.notes.length > 0 && (
        <ol className={s.notes}>
          {[...shot.notes]
            .sort((a, b) => a.n - b.n)
            .map((note) => (
              <li key={note.n} value={note.n}>
                {note.text}
              </li>
            ))}
        </ol>
      )}
    </figure>
  );
}
