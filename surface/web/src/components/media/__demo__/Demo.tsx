import { useState } from 'react';
import { Lightbox, MediaPreview } from '../index';
import { demoFiles } from './fixtures';

export function MediaDemo() {
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(true);

  return (
    <div className="min-h-dvh bg-surface p-5 text-fg">
      <header className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold text-fg">Media preview demo</h1>
          <p className="text-xs text-fg-muted">Fixture-only preview surface for Lane C visual QA.</p>
        </div>
        <button
          type="button"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-semibold text-on-accent hover:bg-accent-hover"
          onClick={() => setOpen(true)}
        >
          Open lightbox
        </button>
      </header>
      <div className="grid grid-cols-4 gap-3">
        {demoFiles.map((file, fileIndex) => (
          <button
            type="button"
            key={file.id}
            className="h-40 overflow-hidden rounded-md border border-edge bg-surface-raised/45 text-left hover:border-edge-strong"
            onClick={() => {
              setIndex(fileIndex);
              setOpen(true);
            }}
          >
            <MediaPreview file={file} variant="tile" />
          </button>
        ))}
      </div>
      {open && (
        <Lightbox
          files={demoFiles}
          index={index}
          onIndexChange={setIndex}
          onClose={() => setOpen(false)}
          onDownload={(file) => console.log('download', file.id)}
          onCopyLink={(file) => console.log('copy-link', file.id)}
          onRename={(_file, name) => console.log('rename', name)}
          onDelete={(file) => console.log('delete', file.id)}
          onComment={(file) => console.log('comment', file.id)}
          canManage={() => true}
        />
      )}
    </div>
  );
}
