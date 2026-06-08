/**
 * Push-endpoint SSRF gate — single source of truth shared by the
 * validator (rejects bad endpoints at subscribe-time), the dispatcher
 * (defence in depth: re-validates BEFORE sending), and the boot
 * migration (prunes pre-C8 rows that were stored under the old
 * validator).
 *
 * Pre-C8 the subscribe validator was `z.string().url()` — any
 * logged-in user could submit `http://169.254.169.254/latest/meta-data/`
 * (AWS IMDS), `http://localhost:6379/`, or any other internal target,
 * and the dispatcher's `webPush.sendNotification` would POST to it.
 * The body is encrypted but the REQUEST lands on the internal target
 * — a usable callback / port-scan / OAST primitive.
 *
 * C8 closed the front door (validator). This util closes:
 *   - the back door: rows persisted BEFORE C8's deploy still pointed
 *     at unsafe endpoints; the dispatcher must skip them.
 *   - the cleanup: the boot migration deletes them so they stop
 *     consuming dispatch attempts forever.
 *
 * Allowlist policy:
 *   - HTTPS only (push providers never use HTTP; HTTP+private-IP is
 *     the textbook SSRF vector).
 *   - Hostname must EQUAL a known provider host or END with `.<host>`
 *     so subdomains (`fcm.googleapis.com`) pass but suffix-bypass
 *     attempts (`attackergoogleapis.com`) fail.
 */

export const PUSH_ENDPOINT_ALLOWED_HOSTS = [
    'googleapis.com', // covers `fcm.googleapis.com`, `android.googleapis.com`
    'push.services.mozilla.com', // Firefox autopush
    'push.apple.com', // Safari (`web.push.apple.com`)
    'notify.windows.com', // Edge / WNS
] as const;

export const isAllowedPushEndpoint = (url: string): boolean => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return PUSH_ENDPOINT_ALLOWED_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
};
