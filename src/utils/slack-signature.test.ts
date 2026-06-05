import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';

import { verifySlackSignature } from './slack-signature.js';

/**
 * Phase 0 — verify the HMAC-SHA256 contract Slack signs every
 * interactive / slash-command webhook with.
 *
 * Slack signs `v0:<timestamp>:<rawBody>` with the app's signing secret,
 * sends the result in `X-Slack-Signature: v0=<hex>` along with
 * `X-Slack-Request-Timestamp`. We constant-time compare and reject
 * anything older than 5 minutes (Slack's documented replay window).
 */

const SECRET = 'test_signing_secret_8e15b0c8c0e7';
const validBody = JSON.stringify({ payload: 'hello' });

const signFor = (ts: string, body: string) => {
    const base = `v0:${ts}:${body}`;
    const sig = crypto.createHmac('sha256', SECRET).update(base).digest('hex');
    return `v0=${sig}`;
};

describe('verifySlackSignature', () => {
    it('returns true for a valid signature within the replay window', () => {
        const ts = Math.floor(Date.now() / 1000).toString();
        const sig = signFor(ts, validBody);
        expect(
            verifySlackSignature({ secret: SECRET, signature: sig, timestamp: ts, body: validBody })
        ).toBe(true);
    });

    it('returns false when the body is tampered', () => {
        const ts = Math.floor(Date.now() / 1000).toString();
        const sig = signFor(ts, validBody);
        expect(
            verifySlackSignature({
                secret: SECRET,
                signature: sig,
                timestamp: ts,
                body: validBody + 'tamper',
            })
        ).toBe(false);
    });

    it('returns false for a stale timestamp (> 5 min)', () => {
        // 6 minutes in the past — beyond the 5-minute replay window.
        const ts = (Math.floor(Date.now() / 1000) - 6 * 60).toString();
        const sig = signFor(ts, validBody);
        expect(
            verifySlackSignature({ secret: SECRET, signature: sig, timestamp: ts, body: validBody })
        ).toBe(false);
    });

    it('returns false for missing or malformed signature headers', () => {
        const ts = Math.floor(Date.now() / 1000).toString();
        // Missing entirely
        expect(
            verifySlackSignature({ secret: SECRET, signature: '', timestamp: ts, body: validBody })
        ).toBe(false);
        // Wrong scheme — doesn't start with `v0=`
        expect(
            verifySlackSignature({
                secret: SECRET,
                signature: 'sha256=abc',
                timestamp: ts,
                body: validBody,
            })
        ).toBe(false);
        // Right scheme but wrong hash
        expect(
            verifySlackSignature({
                secret: SECRET,
                signature: 'v0=deadbeef',
                timestamp: ts,
                body: validBody,
            })
        ).toBe(false);
    });

    it('returns false when timestamp is non-numeric', () => {
        const sig = signFor('0', validBody);
        expect(
            verifySlackSignature({
                secret: SECRET,
                signature: sig,
                timestamp: 'not-a-number',
                body: validBody,
            })
        ).toBe(false);
    });
});
