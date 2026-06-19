/* Spike — render a sample Slack Home "dashboard" as a PNG via Satori + resvg
 * (no Chromium). Throwaway: judge the look, then decide on the full build. */
import { readFileSync, writeFileSync } from 'node:fs';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

const arial = readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf');
const arialBold = readFileSync('/System/Library/Fonts/Supplemental/Arial Bold.ttf');

type Node = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, children?: unknown): Node => ({
    type,
    props: { style, ...(children !== undefined ? { children } : {}) },
});

const INK = '#e8eaed';
const MUTED = '#8b93a1';
const CARD = '#171a21';
const BORDER = '#262a33';
const BLUE = '#3d7bff';
const GREEN = '#16a34a';

const card = (label: string, value: string, sub: string | null, accent: string, width: number): Node =>
    h('div', { display: 'flex', flexDirection: 'column', background: CARD, borderRadius: 18, padding: 22, width, border: `1px solid ${BORDER}` }, [
        h('div', { display: 'flex', alignItems: 'center', marginBottom: 10 }, [
            h('div', { width: 8, height: 8, borderRadius: 8, background: accent, marginRight: 8 }),
            h('div', { fontSize: 14, color: MUTED, fontWeight: 700, letterSpacing: 1 }, label.toUpperCase()),
        ]),
        h('div', { display: 'flex', alignItems: 'baseline' }, [
            h('div', { fontSize: 46, fontWeight: 700, color: INK }, value),
            ...(sub ? [h('div', { fontSize: 18, color: MUTED, marginLeft: 10 }, sub)] : []),
        ]),
    ]);

const bars = [6, 9, 7, 8, 5, 9, 10, 7, 8, 11, 9, 2];
const barChart = (): Node =>
    h('div', { display: 'flex', flexDirection: 'column', background: CARD, borderRadius: 18, padding: 22, width: 780, border: `1px solid ${BORDER}` }, [
        h('div', { display: 'flex', alignItems: 'center', marginBottom: 14 }, [
            h('div', { fontSize: 14, color: MUTED, fontWeight: 700, letterSpacing: 1 }, 'ATTENDANCE TREND'),
        ]),
        h('div', { display: 'flex', alignItems: 'flex-end', height: 120 }, bars.map((v, i) =>
            h('div', { display: 'flex', flexDirection: 'column', alignItems: 'center', width: 56 }, [
                h('div', { width: 26, height: v * 10, borderRadius: 6, background: i === bars.length - 1 ? BLUE : '#2b3a63' }),
            ])
        )),
    ]);

const tree: Node = h('div', {
    display: 'flex', flexDirection: 'column', width: 860, padding: 36, background: '#0d0f13', fontFamily: 'Arial',
}, [
    // header
    h('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 26 }, [
        h('div', { display: 'flex', flexDirection: 'column' }, [
            h('div', { fontSize: 30, fontWeight: 700, color: INK }, 'Attendance'),
            h('div', { fontSize: 16, color: MUTED, marginTop: 2 }, 'Wed 17 Jun · Viljetech'),
        ]),
        h('div', { display: 'flex', alignItems: 'center', background: '#13251a', border: `1px solid #1e4d33`, borderRadius: 999, padding: '8px 16px' }, [
            h('div', { width: 9, height: 9, borderRadius: 9, background: GREEN, marginRight: 8 }),
            h('div', { fontSize: 16, color: '#7fe0a3', fontWeight: 700 }, 'Checked in · 11:37'),
        ]),
    ]),
    // stat row 1
    h('div', { display: 'flex', justifyContent: 'space-between', marginBottom: 16 }, [
        card('Present today', '2', '/ 11', GREEN, 380),
        card('Pending approvals', '2', null, BLUE, 380),
    ]),
    // stat row 2
    h('div', { display: 'flex', justifyContent: 'space-between', marginBottom: 16 }, [
        card('Hours logged', '395h', '· 35% util', BLUE, 380),
        card('On leave', '0', null, '#a855f7', 380),
    ]),
    // chart
    barChart(),
]);

const main = async () => {
    const svg = await satori(tree as unknown as React.ReactNode, {
        width: 860,
        fonts: [
            { name: 'Arial', data: arial, weight: 400, style: 'normal' },
            { name: 'Arial', data: arialBold, weight: 700, style: 'normal' },
        ],
    });
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: 860 } }).render().asPng();
    writeFileSync('/tmp/slack-dashboard-preview.png', png);
    console.log('wrote /tmp/slack-dashboard-preview.png', png.length, 'bytes');
};

void main();
