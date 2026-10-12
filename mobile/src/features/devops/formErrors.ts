import { useState } from 'react';

import { showToast } from '@/components';

type Res = { ok: true; toast: string } | { ok: false; error: string; field?: string };

/**
 * Form errors for sheets (SPEC §5): a failed save marks every empty required field with
 * "Required" (the prototype's `tried`), then the command's own error lands on its field
 * (or shows as a toast when it has none).
 */
export function useFormErrors() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  return {
    errors,
    /** Mark empty required fields; true when all are filled. */
    need(values: Record<string, string | null | undefined>): boolean {
      const e: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) if (!String(v ?? '').trim()) e[k] = 'Required';
      setErrors(e);
      return !Object.keys(e).length;
    },
    /** Apply a command result: toast on success, field error or toast on failure. */
    result(r: Res): boolean {
      if (r.ok) {
        setErrors({});
        showToast(r.toast);
        return true;
      }
      if (r.field) setErrors((x) => ({ ...x, [r.field as string]: r.error }));
      else showToast(r.error);
      return false;
    },
    clear: () => setErrors({}),
  };
}
