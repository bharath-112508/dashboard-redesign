import { useRef } from 'react';

import { Press } from '../Press';
import type { FileInputProps } from './types';

/** Scale an image file to fit 200px (as the prototype's logo upload); SVG kept as is. */
function readImage(file: File): Promise<string> {
  return new Promise((resolve) => {
    const rd = new FileReader();
    rd.onload = () => {
      const src = String(rd.result);
      if (/svg/.test(file.type)) return resolve(src);
      const im = new Image();
      im.onload = () => {
        const k = Math.min(1, 200 / Math.max(im.width, im.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(im.width * k);
        cv.height = Math.round(im.height * k);
        cv.getContext('2d')?.drawImage(im, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/png'));
      };
      im.onerror = () => resolve(src);
      im.src = src;
    };
    rd.readAsDataURL(file);
  });
}

/** File picker (web): a hidden <input type="file"> behind the tile. */
export function FileInput({ label, image, accept, onPick, testID, children }: FileInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Press label={label} onPress={() => ref.current?.click()} testID={testID}>
        {children}
      </Press>
      <input
        ref={ref}
        type="file"
        accept={accept ?? (image ? 'image/*' : '*/*')}
        style={{ display: 'none' }}
        data-testid={testID ? `${testID}-input` : undefined}
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const size = `${Math.max(1, Math.round(f.size / 1024))} KB`;
          onPick({ n: f.name, size, uri: image ? await readImage(f) : undefined });
        }}
      />
    </>
  );
}
