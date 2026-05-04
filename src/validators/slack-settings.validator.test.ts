import { describe, expect, it } from 'vitest';

import { patchSlackSettingsBodySchema, testMessageBodySchema } from './slack-settings.validator.js';
import { SLACK_BOT_TOKEN_MAX, SLACK_TEXT_MAX } from '../constants/slack.js';

/**
 * Validator-level tests for the dedicated `/settings/slack` schemas.
 *
 * The service-level tests in `slack-settings.service.test.ts` exercise
 * happy-path values; this file pins the input-shape contract that the
 * Zod schema enforces — caps, type rejections, and the partial-shape
 * "at least one field" rule.
 */

// ─── PATCH body — caps + types ───────────────────────────────────────────

describe('patchSlackSettingsBodySchema', () => {
    it('accepts a bot_token at exactly the max length', () => {
        const at_max = 'x'.repeat(SLACK_BOT_TOKEN_MAX);
        const result = patchSlackSettingsBodySchema.safeParse({ bot_token: at_max });
        expect(result.success).toBe(true);
    });

    it('rejects a bot_token one char over the max length', () => {
        const over_max = 'x'.repeat(SLACK_BOT_TOKEN_MAX + 1);
        const result = patchSlackSettingsBodySchema.safeParse({ bot_token: over_max });
        expect(result.success).toBe(false);
    });

    it('accepts null as the explicit clear signal for bot_token', () => {
        const result = patchSlackSettingsBodySchema.safeParse({ bot_token: null });
        expect(result.success).toBe(true);
    });

    it('accepts the empty string as the explicit clear signal for bot_token', () => {
        const result = patchSlackSettingsBodySchema.safeParse({ bot_token: '' });
        expect(result.success).toBe(true);
    });

    it('rejects a non-string bot_token (e.g. a pasted number)', () => {
        const result = patchSlackSettingsBodySchema.safeParse({ bot_token: 12345 });
        expect(result.success).toBe(false);
    });

    it('rejects an empty patch object (must touch at least one field)', () => {
        const result = patchSlackSettingsBodySchema.safeParse({});
        expect(result.success).toBe(false);
    });

    it('accepts a partial channels patch and leaves the rest unspecified', () => {
        const result = patchSlackSettingsBodySchema.safeParse({
            channels: { leaves: '#hr-leaves' },
        });
        expect(result.success).toBe(true);
    });

    it('rejects an empty channel name (whitespace-only)', () => {
        const result = patchSlackSettingsBodySchema.safeParse({ channels: { leaves: '' } });
        expect(result.success).toBe(false);
    });
});

// ─── test-message body ───────────────────────────────────────────────────

describe('testMessageBodySchema', () => {
    it('requires a non-empty channel', () => {
        const empty = testMessageBodySchema.safeParse({ channel: '' });
        expect(empty.success).toBe(false);
        const whitespace = testMessageBodySchema.safeParse({ channel: '   ' });
        expect(whitespace.success).toBe(false);
    });

    it('accepts a channel with the optional text', () => {
        const result = testMessageBodySchema.safeParse({ channel: '#leaves', text: 'hi' });
        expect(result.success).toBe(true);
    });

    it('accepts a channel without text (defaults are filled in service)', () => {
        const result = testMessageBodySchema.safeParse({ channel: '#leaves' });
        expect(result.success).toBe(true);
    });

    it('rejects text longer than SLACK_TEXT_MAX', () => {
        const text = 'x'.repeat(SLACK_TEXT_MAX + 1);
        const result = testMessageBodySchema.safeParse({ channel: '#x', text });
        expect(result.success).toBe(false);
    });
});
