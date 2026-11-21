/**
 * Hands a file (or blob) to the browser as a download: an `<a download>` click, never a navigation. The object URL is
 * revoked a minute later, not right after the click: some browsers still read it then, and revoking it early cancels
 * the download.
 */
export function saveBlob(blob: Blob, name: string, doc: Document = document): void {
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
