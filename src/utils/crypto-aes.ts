import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { MFA_ENCRYPTION_KEY } from '../config/server.config.js';

/**
 * Symmetric envelope for small secrets (TOTP secret, etc.).
 *
 *   plaintext ─► AES-256-GCM ─► ciphertext + 16-byte auth tag
 *   output = base64url(iv) + '.' + base64url(ciphertext) + '.' + base64url(tag)
 *
 * Why GCM:
 *  - AEAD: tampering with either the IV or the ciphertext surfaces as an error,
 *    not as silently garbled plaintext.
 *  - 96-bit IVs are industry-standard for GCM and kept on the wire with the blob,
 *    so rotation of the MFA_ENCRYPTION_KEY only needs re-encrypting stored values.
 *
 * The key MUST be base64 of exactly 32 raw bytes. Anything else aborts startup
 * so misconfiguration is loud and immediate instead of silently degrading.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;

const loadKey = (): Buffer => {
    const key = Buffer.from(MFA_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) {
        throw new Error(
            `MFA_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). ` +
                "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""
        );
    }
    return key;
};

const KEY = loadKey();

const toB64Url = (buf: Buffer): string =>
    buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64Url = (s: string): Buffer => {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
};

export const encryptSecret = (plain: string): string => {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, KEY, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [toB64Url(iv), toB64Url(ciphertext), toB64Url(tag)].join('.');
};

export const decryptSecret = (blob: string): string => {
    const parts = blob.split('.');
    if (parts.length !== 3) {
        throw new Error('Malformed encrypted blob');
    }
    const [iv, ciphertext, tag] = parts.map(fromB64Url);
    const decipher = createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString('utf8');
};
