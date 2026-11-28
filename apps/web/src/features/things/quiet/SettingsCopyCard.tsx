/**
 * A service's settings copy (Whombat outside-changes.md; `ThingPage.settingsCopy`, session minor 22): on the Summary of
 * the services Whombat copies the settings of every night (OPNsense, Pi-hole, Nginx Proxy Manager), when the newest
 * copy was made, what it holds or why the last try didn't work, and Download for the newest. Restoring one is the
 * service's own. Nothing on a page without a copy card (other services, an older Whombat).
 */
import { settingsCopyWords } from '@whombat/client';
import { useSettingsCopyDownload } from '@whombat/client/react';
import type { SettingsCopyView } from '@whombat/core';
import { Download } from 'lucide-react';
import { Button } from '../../../components/Button';
import { Icon } from '../../../components/Icon';
import { currentLocale } from '../../../i18n/provider';
import { saveBlob } from '../../../lib/saveBlob';
import { Card } from '../parts';
import things from '../Things.module.css';

export function SettingsCopyCard({
  burrow,
  thing,
  copy,
}: {
  burrow: string;
  thing: string;
  copy: SettingsCopyView;
}) {
  const words = settingsCopyWords(currentLocale());
  const { supported, busy, failed, download } = useSettingsCopyDownload(burrow, thing);
  const copyId = copy.copyId;
  const fileName = copy.fileName;
  return (
    <Card
      id="settings-copy"
      title={copy.title}
      meta={copy.kept > 1 ? words.kept(copy.kept) : undefined}
      link={
        supported && copyId && fileName ? (
          <Button
            variant="secondary"
            size="sm"
            aria-label={words.downloadName(fileName)}
            disabled={busy}
            onClick={async () => {
              const file = await download(copyId);
              if (file)
                saveBlob(new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), file.fileName);
            }}
          >
            <Icon icon={Download} size={14} />
            {busy ? words.downloading : words.download}
          </Button>
        ) : undefined
      }
    >
      <div className={things.row} data-copy-failing={copy.failing || undefined}>
        <div className={things.rowMain}>
          {copy.detail ? <span className={things.copyDetail}>{copy.detail}</span> : null}
          {failed ? <small role="alert">{words.failed}</small> : fileName ? <small>{fileName}</small> : null}
        </div>
      </div>
    </Card>
  );
}
