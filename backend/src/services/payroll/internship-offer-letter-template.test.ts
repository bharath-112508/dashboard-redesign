import { describe, expect, it } from 'vitest';

import {
    compensationLine,
    defaultClosing,
    renderInternshipOfferLetterHtml,
    type InternshipOfferRenderData,
} from './internship-offer-letter-template.js';

/**
 * The template is a pure function, so these assert the things that are easy
 * to get silently wrong: how compensation is worded, where the closing lands,
 * and that the acceptance ask isn't printed twice.
 */

const base: InternshipOfferRenderData = {
    companyName: 'Vilja Tech Labs Private Limited',
    companyAddress: ['4th Floor, Prestige Tech Park'],
    companyEmail: 'hr@viljetech.com',
    cinNo: 'U72900KA2024PTC123456',
    iecCode: 'AABCV1234E',
    issueDate: '20 Jul 2026',
    internName: 'Aarav Sharma',
    internAddress: [],
    internEmail: 'aarav@example.com',
    position: 'AI Intern',
    startDate: '18 July 2026',
    endDate: '18 October 2026',
    durationLabel: '3 Months',
    workMode: 'Remote',
    isPaid: false,
    responsibilities: [],
    terms: [],
};

describe('compensationLine', () => {
    it('states unpaid explicitly rather than leaving it blank', () => {
        // An internship offer that simply omits compensation is the kind of
        // ambiguity that turns into a dispute.
        expect(compensationLine({ ...base, isPaid: false })).toBe('This is an unpaid internship.');
    });

    it('formats a monthly stipend in Indian digit grouping', () => {
        expect(compensationLine({ ...base, isPaid: true, stipendAmount: 1500000 })).toBe(
            'Stipend of ₹15,00,000 per month.'
        );
    });

    it('appends the note in parentheses when given', () => {
        expect(compensationLine({ ...base, isPaid: true, stipendAmount: 15000, stipendNote: 'paid on the 5th' })).toBe(
            'Stipend of ₹15,000 per month (paid on the 5th).'
        );
    });
});

describe('defaultClosing', () => {
    it('interpolates the configured company name', () => {
        // Hard-coding it would let the letter drift from the legal name in
        // settings.
        expect(defaultClosing('Acme Labs')[0]).toContain('join Acme Labs');
    });

    it('carries the acceptance ask', () => {
        expect(defaultClosing().join(' ')).toContain('signing below and returning a copy');
    });
});

describe('renderInternshipOfferLetterHtml', () => {
    it('places the closing AFTER the terms and before the signature', () => {
        const html = renderInternshipOfferLetterHtml(base);
        // Anchor on MARKUP, not prose: a CSS comment mentioning "Yours
        // sincerely," matched ahead of the real sign-off and made this pass
        // for the wrong reason.
        const terms = html.indexOf('<h2>General Terms and Conditions</h2>');
        const closing = html.indexOf('We look forward to working with you.');
        const signature = html.indexOf('class="sign-row"');
        expect(terms).toBeGreaterThan(-1);
        expect(closing).toBeGreaterThan(terms);
        expect(signature).toBeGreaterThan(closing);
    });

    it('does not ask for acceptance twice when a validity date is set', () => {
        // The closing already says "please confirm your acceptance by signing
        // and returning"; the validity line must only add the deadline.
        const html = renderInternshipOfferLetterHtml({ ...base, offerValidUntil: '31 Jul 2026' });
        const asks = html.match(/confirm your acceptance/gi) ?? [];
        expect(asks).toHaveLength(1);
        expect(html).toContain('This offer is valid until');
    });

    it('falls back to standard responsibilities and terms when none are given', () => {
        // A letter must never go out with an empty terms section, even via a
        // direct API call that omits them.
        const html = renderInternshipOfferLetterHtml(base);
        expect(html).toContain('does not constitute an offer of employment');
        expect(html).toContain('under the guidance of your mentor');
    });

    it('escapes user-supplied text', () => {
        const html = renderInternshipOfferLetterHtml({
            ...base,
            internName: '<script>alert(1)</script>',
            terms: ['Clause with <b>markup</b>'],
        });
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;');
        expect(html).not.toContain('Clause with <b>markup</b>');
    });

    it('crops the stamp through a frame instead of scaling the whole sheet', () => {
        // stamp.png is a 375x666 SHEET. Rendering it directly at a fixed
        // height produced a 38x68 sliver in the page margin instead of a
        // seal. The frame + negative offsets crop the stamp out of it.
        const html = renderInternshipOfferLetterHtml(base);
        // Assert the MARKUP wraps the image, not merely that a .stamp-frame
        // rule exists in the stylesheet — the CSS is present either way, so
        // a `toContain('stamp-frame')` check passed even with the image
        // rendered bare.
        expect(html).toMatch(/<div class="stamp-frame"><img src="data:image\/png/);
        expect(html).not.toMatch(/<img class="stamp"/);
        expect(html).toMatch(/\.stamp-frame\s*\{[^}]*overflow:\s*hidden/);
        expect(html).toMatch(/\.stamp-frame img\s*\{[^}]*left:\s*-38px/);
        expect(html).toMatch(/\.stamp-frame img\s*\{[^}]*top:\s*-98px/);
    });

    it('layers the signature above the stamp', () => {
        // A signed document has ink over the seal, not under it.
        const html = renderInternshipOfferLetterHtml(base);
        expect(html).toMatch(/\.signature\s*\{[^}]*z-index:\s*2/);
    });

    it('keeps the sign-off from splitting across a page break', () => {
        // It used to orphan "Yours sincerely," at the foot of one page with
        // the signature at the head of the next.
        const html = renderInternshipOfferLetterHtml(base);
        expect(html).toMatch(/\.sign-row\s*\{[^}]*break-inside:\s*avoid/);
    });

    it('renders every internship detail the letter promises', () => {
        const html = renderInternshipOfferLetterHtml(base);
        for (const v of ['AI Intern', '18 July 2026', '18 October 2026', '3 Months', 'Remote']) {
            expect(html, v).toContain(v);
        }
    });
});
