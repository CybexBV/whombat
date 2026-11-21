import { type DragEvent, useRef, useState } from 'react';

const hasFiles = (event: DragEvent) => [...(event.dataTransfer?.types ?? [])].includes('Files');

/**
 * Files dropped anywhere on an element attach them (docs/decisions/bp-attachments.md; the thread pane too, WX-04):
 * `dragging` while files are over it (for the drop zone), and the handlers to spread on it. A drop doesn't reach an
 * element around it.
 */
export function useFileDrop(onFiles: ((files: File[]) => void) | null) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  if (!onFiles) return { dragging: false, handlers: {} };
  return {
    dragging,
    handlers: {
      onDragEnter: (event: DragEvent<HTMLElement>) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current += 1;
        setDragging(true);
      },
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        event.stopPropagation();
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        depth.current = 0;
        setDragging(false);
        const files = [...(event.dataTransfer?.files ?? [])];
        if (files.length) onFiles(files);
      },
    },
  };
}
