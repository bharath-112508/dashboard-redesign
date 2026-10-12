import { Block, FileField, IconTile, openTicket, Row, Rows, showToast, toastResult } from '@/components';
import { fmt } from '@/data/format';
import type { ProjectView } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';

import { isImageName, projectFiles } from '../derive';

/** Files tab (V-50): upload tile, then project files and ticket attachments. */
export function FilesTab({ p }: { p: ProjectView }) {
  const files = useAppState((s) => projectFiles(s, p.id));
  const { addProjectFile } = useActions();
  return (
    <>
      <FileField
        label=""
        value={null}
        title="Upload a file"
        sub="Any file type · added to this project"
        accept="*/*"
        onPick={(f) => {
          const r = addProjectFile(p.id, { n: f.n, size: f.size });
          if (r.ok) showToast(r.toast);
          else toastResult(r);
        }}
        testID="project-file-upload"
      />
      <Block title={`${files.length} files`}>
        <Rows empty="No files yet. Files attached to tickets show up here." testID="project-files">
          {files.map((f, i) => (
            <Row
              key={`${f.tk}-${f.n}-${i}`}
              lead={<IconTile icon={isImageName(f.n) ? 'image' : 'file-text'} />}
              title={f.n}
              sub={`${f.tk ? `${f.tk} · ` : 'Project file · '}${f.size} · ${fmt(f.when)}`}
              onPress={f.tk ? () => openTicket(f.tk) : undefined}
              testID={`file-row-${i}`}
            />
          ))}
        </Rows>
      </Block>
    </>
  );
}
