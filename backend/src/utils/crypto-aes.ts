import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { MFA_ENCRYPTION_ACTIVE_KID, MFA_ENCRYPTION_KEY, MFA_ENCRYPTION_KEY_REGISTRY } from '../config/server.config.js';

/**
 * Symmetric envelope for small secrets (TOTP secret, etc.).
 *
 * Two on-the-wire formats (BACKEND_AUDIT.md R16):
 *
 *   Legacy (single-key mode, no kid):
 *     base64url(iv).base64url(ct).base64url(tag)
 *
 *   Rotation (when MFA_ENCRYPTION_ACTIVE_KID is set):
 *     "kid:" + <kid> + ":" + base64url(iv).base64url(ct).base64url(tag)
 *
 * Why GCM:
 *  - AEAD: tampering with either the IV or the ciphertext surfaces as
 *    an error, not as silently garbled plaintext.
 *  - 96-bit IVs are industry-standard for GCM.
 *
 * Key registry rules:
 *  - `MFA_ENCRYPTION_KEY` is the legacy single key — always present;
 *    used to decrypt blobs WITHOUT a kid prefix.
 *  - `MFA_ENCRYPTION_KEY_<kid>` entries register additional keys.
 *  - `MFA_ENCRYPTION_ACTIVE_KID` names the key used for NEW encryptions.
 *  - When the active kid is unset, encrypt produces the legacy format.
 *
 * Key rotation pipeline:
 *  1. Add `MFA_ENCRYPTION_KEY_v2=<new>` + `MFA_ENCRYPTION_ACTIVE_KID=v2`.
 *     New encryptions stamp `kid:v2:`; old blobs (no prefix) still
 *     decrypt under the legacy key. Mid-rotation reads continue to
 *     work in both directions.
 *  2. Run a re-encryption pass: read each stored blob, decrypt
 *     (whichever key applies), `encryptSecret(plain)` again. The
 *     output now carries `kid:v2:`.
 *  3. Drop `MFA_ENCRYPTION_KEY_v1` (the prior active) and optionally
 *     the legacy `MFA_ENCRYPTION_KEY`. Keep at least one verifiable
 *     legacy fallback until you're sure no `kid`-less blobs remain.
 *
 * Every key MUST be base64 of exactly 32 raw bytes. Anything else
 * aborts at first use so misconfiguration is loud and immediate
 * instead of silently degrading.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KID_PREFIX = 'kid:';

const decodeKey = (raw: string, label: string): Buffer => {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
        throw new Error(
            `${label} must decode to exactly 32 bytes (got ${key.length}). ` +
                "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
        );
    }
    return key;
};

// Cache decoded keys so we don't redo the base64 + length check on
// every encrypt / decrypt. Lazily populated.
const decodedKeyCache = new Map<string, Buffer>();
const LEGACY_KID_SENTINEL = '__legacy__';

const keyForKid = (kid: string | null): Buffer => {
    const cacheKey = kid ?? LEGACY_KID_SENTINEL;
    const cached = decodedKeyCache.get(cacheKey);
    if (cached) return cached;
    let raw: string;
    let label: string;
    if (kid === null) {
        raw = MFA_ENCRYPTION_KEY;
        label = 'MFA_ENCRYPTION_KEY';
    } else {
        const registered = MFA_ENCRYPTION_KEY_REGISTRY.get(kid);
        if (!registered) {
            throw new Error(`Unknown MFA encryption kid "${kid}" — no MFA_ENCRYPTION_KEY_${kid} registered`);
        }
        raw = registered;
        label = `MFA_ENCRYPTION_KEY_${kid}`;
    }
    const decoded = decodeKey(raw, label);
    decodedKeyCache.set(cacheKey, decoded);
    return decoded;
};

const toB64Url = (buf: Buffer): string =>
    buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64Url = (s: string): Buffer => {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
};

export const encryptSecret = (plain: string): string => {
    const activeKid = MFA_ENCRYPTION_ACTIVE_KID;
    const key = keyForKid(activeKid);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const body = [toB64Url(iv), toB64Url(ciphertext), toB64Url(tag)].join('.');
    if (activeKid) {
        return `${KID_PREFIX}${activeKid}:${body}`;
    }
    return body;
};

/**
 * Parse the on-the-wire blob into `{ kid, body }`. `kid: null` means
 * legacy single-key format.
 */
const parseBlob = (blob: string): { kid: string | null; body: string } => {
    if (!blob.startsWith(KID_PREFIX)) {
        return { kid: null, body: blob };
    }
    // Format: `kid:<kid>:<body>`. Find the second colon to slice cleanly;
    // the kid pattern itself contains no colons.
    const afterPrefix = blob.slice(KID_PREFIX.length);
    const colon = afterPrefix.indexOf(':');
    if (colon <= 0) {
        throw new Error('Malformed encrypted blob (kid prefix without separator)');
    }
    const kid = afterPrefix.slice(0, colon);
    const body = afterPrefix.slice(colon + 1);
    return { kid, body };
};

export const decryptSecret = (blob: string): string => {
    const { kid, body } = parseBlob(blob);
    const parts = body.split('.');
    if (parts.length !== 3) {
        throw new Error('Malformed encrypted blob');
    }
    const [iv, ciphertext, tag] = parts.map(fromB64Url);
    const key = keyForKid(kid);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
};

/** Test seam — clear the decoded-key cache between test cases. */
export const __resetCryptoAesCache = (): void => {
    decodedKeyCache.clear();
};
