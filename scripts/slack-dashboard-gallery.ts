/* Spike — render several Slack Home "dashboard" design options as PNGs and a
 * gallery HTML so the look can be picked before building. Throwaway. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';

const F = '/System/Library/Fonts/Supplemental/';
const arial = readFileSync(F + 'Arial.ttf');
const arialB = readFileSync(F + 'Arial Bold.ttf');
const georgia = readFileSync(F + 'Georgia.ttf');
const georgiaB = readFileSync(F + 'Georgia Bold.ttf');

const OUT = '/tmp/dash-gallery';
mkdirSync(OUT, { recursive: true });

type N = { type: string; props: Record<string, unknown> };
const h = (type: string, style: Record<string, unknown>, children?: unknown): N => ({
    type,
    props: { style, ...(children !== undefined ? { children } : {}) },
});
const row = (style: Record<string, unknown>, kids: unknown[]) => h('div', { display: 'flex', ...style }, kids);
const col = (style: Record<string, unknown>, kids: unknown[]) => h('div', { display: 'flex', flexDirection: 'column', ...style }, kids);

const W = 880;
const fonts = [
    { name: 'Arial', data: arial, weight: 400 as const, style: 'normal' as const },
    { name: 'Arial', data: arialB, weight: 700 as const, style: 'normal' as const },
    { name: 'Georgia', data: georgia, weight: 400 as const, style: 'normal' as const },
    { name: 'Georgia', data: georgiaB, weight: 700 as const, style: 'normal' as const },
];

const render = async (name: string, tree: N) => {
    const svg = await satori(tree as unknown as React.ReactNode, { width: W, fonts });
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
    writeFileSync(`${OUT}/${name}.png`, png);
    return `${name}.png`;
};

const BARS = [6, 9, 7, 8, 5, 9, 10, 7, 8, 11, 9, 2];

// ── A. Midnight (dark cards) ───────────────────────────────────────────────
const midnight = (): N => {
    const ink = '#e8eaed', muted = '#8b93a1', cardBg = '#171a21', bd = '#262a33', blue = '#3d7bff', green = '#16a34a';
    const card = (label: string, value: string, sub: string | null, dot: string) =>
        col({ background: cardBg, borderRadius: 18, padding: 22, width: 384, border: `1px solid ${bd}` }, [
            row({ alignItems: 'center', marginBottom: 10 }, [h('div', { width: 8, height: 8, borderRadius: 8, background: dot, marginRight: 8 }), h('div', { fontSize: 13, color: muted, fontWeight: 700, letterSpacing: 1 }, label.toUpperCase())]),
            row({ alignItems: 'baseline' }, [h('div', { fontSize: 46, fontWeight: 700, color: ink }, value), ...(sub ? [h('div', { fontSize: 18, color: muted, marginLeft: 10 }, sub)] : [])]),
        ]);
    return col({ width: W, padding: 36, background: '#0d0f13', fontFamily: 'Arial' }, [
        row({ justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }, [
            col({}, [h('div', { fontSize: 30, fontWeight: 700, color: ink }, 'Attendance'), h('div', { fontSize: 15, color: muted, marginTop: 2 }, 'Wed 17 Jun · Viljetech')]),
            row({ alignItems: 'center', background: '#13251a', border: '1px solid #1e4d33', borderRadius: 999, padding: '8px 16px' }, [h('div', { width: 9, height: 9, borderRadius: 9, background: green, marginRight: 8 }), h('div', { fontSize: 15, color: '#7fe0a3', fontWeight: 700 }, 'Checked in · 11:37')]),
        ]),
        row({ justifyContent: 'space-between', marginBottom: 16 }, [card('Present today', '2', '/ 11', green), card('Pending approvals', '2', null, blue)]),
        row({ justifyContent: 'space-between', marginBottom: 16 }, [card('Hours logged', '395h', '· 35%', blue), card('On leave', '0', null, '#a855f7')]),
        col({ background: cardBg, borderRadius: 18, padding: 22, border: `1px solid ${bd}` }, [
            h('div', { fontSize: 13, color: muted, fontWeight: 700, letterSpacing: 1, marginBottom: 14 }, 'ATTENDANCE TREND'),
            row({ alignItems: 'flex-end', height: 110 }, BARS.map((v, i) => h('div', { width: 26, height: v * 9, borderRadius: 6, background: i === BARS.length - 1 ? blue : '#2b3a63', marginRight: 38 }))),
        ]),
    ]);
};

// ── B. Daylight (light, soft cards) ────────────────────────────────────────
const daylight = (): N => {
    const ink = '#0f172a', muted = '#64748b', cardBg = '#ffffff', bd = '#e7eaf0', blue = '#2563eb', green = '#16a34a';
    const card = (label: string, value: string, sub: string | null, dot: string) =>
        col({ background: cardBg, borderRadius: 16, padding: 22, width: 384, border: `1px solid ${bd}`, boxShadow: '0 1px 3px rgba(15,23,42,0.06)' }, [
            row({ alignItems: 'center', marginBottom: 10 }, [h('div', { width: 8, height: 8, borderRadius: 8, background: dot, marginRight: 8 }), h('div', { fontSize: 13, color: muted, fontWeight: 700, letterSpacing: 1 }, label.toUpperCase())]),
            row({ alignItems: 'baseline' }, [h('div', { fontSize: 46, fontWeight: 700, color: ink }, value), ...(sub ? [h('div', { fontSize: 18, color: muted, marginLeft: 10 }, sub)] : [])]),
        ]);
    return col({ width: W, padding: 36, background: '#f4f6f9', fontFamily: 'Arial' }, [
        row({ justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }, [
            col({}, [h('div', { fontSize: 30, fontWeight: 700, color: ink }, 'Attendance'), h('div', { fontSize: 15, color: muted, marginTop: 2 }, 'Wed 17 Jun · Viljetech')]),
            row({ alignItems: 'center', background: '#e7f7ee', border: '1px solid #bfe8cf', borderRadius: 999, padding: '8px 16px' }, [h('div', { width: 9, height: 9, borderRadius: 9, background: green, marginRight: 8 }), h('div', { fontSize: 15, color: '#15803d', fontWeight: 700 }, 'Checked in · 11:37')]),
        ]),
        row({ justifyContent: 'space-between', marginBottom: 16 }, [card('Present today', '2', '/ 11', green), card('Pending approvals', '2', null, blue)]),
        row({ justifyContent: 'space-between', marginBottom: 16 }, [card('Hours logged', '395h', '· 35%', blue), card('On leave', '0', null, '#9333ea')]),
        col({ background: cardBg, borderRadius: 16, padding: 22, border: `1px solid ${bd}`, boxShadow: '0 1px 3px rgba(15,23,42,0.06)' }, [
            h('div', { fontSize: 13, color: muted, fontWeight: 700, letterSpacing: 1, marginBottom: 14 }, 'ATTENDANCE TREND'),
            row({ alignItems: 'flex-end', height: 110 }, BARS.map((v, i) => h('div', { width: 26, height: v * 9, borderRadius: 6, background: i === BARS.length - 1 ? blue : '#cdd9f2', marginRight: 38 }))),
        ]),
    ]);
};

// ── C. Editorial (Viljetech brand: cream, ink, electric blue, serif) ───────
const editorial = (): N => {
    const cream = '#f3eee2', ink = '#1a160f', muted = '#6f6757', blue = '#1f48ff', line = '#ddd5c3';
    const stat = (label: string, value: string, sub: string) =>
        col({ width: 250 }, [
            h('div', { fontSize: 13, color: muted, fontFamily: 'Arial', fontWeight: 700, letterSpacing: 2, marginBottom: 8 }, label.toUpperCase()),
            row({ alignItems: 'baseline' }, [h('div', { fontSize: 52, fontFamily: 'Georgia', fontWeight: 700, color: ink }, value), h('div', { fontSize: 17, color: muted, fontFamily: 'Arial', marginLeft: 8 }, sub)]),
        ]);
    return col({ width: W, padding: 44, background: cream, fontFamily: 'Georgia' }, [
        h('div', { fontSize: 15, color: blue, fontFamily: 'Georgia', fontWeight: 700, fontStyle: 'italic', marginBottom: 6 }, 'Attendance.'),
        h('div', { fontSize: 40, color: ink, fontFamily: 'Georgia', fontWeight: 700, marginBottom: 4 }, 'Wednesday, 17 June'),
        h('div', { fontSize: 16, color: muted, fontFamily: 'Arial', marginBottom: 26 }, 'You checked in at 11:37 · 2h 14m so far'),
        h('div', { width: W - 88, height: 1, background: line, marginBottom: 26 }),
        row({ justifyContent: 'space-between', marginBottom: 28 }, [stat('Present today', '2', '/ 11'), stat('Pending', '2', 'requests'), stat('On leave', '0', 'today')]),
        h('div', { width: W - 88, height: 1, background: line, marginBottom: 22 }),
        col({}, [
            h('div', { fontSize: 13, color: muted, fontFamily: 'Arial', fontWeight: 700, letterSpacing: 2, marginBottom: 16 }, 'ATTENDANCE · LAST 12 DAYS'),
            row({ alignItems: 'flex-end', height: 90 }, BARS.map((v, i) => h('div', { width: 22, height: v * 7, background: i === BARS.length - 1 ? blue : '#cfc6b2', marginRight: 42 }))),
        ]),
    ]);
};

// ── D. Operational (KPI strip + pending list with avatars) ─────────────────
const operational = (): N => {
    const ink = '#0f172a', muted = '#64748b', cardBg = '#ffffff', bd = '#e7eaf0', blue = '#2563eb';
    const kpi = (label: string, value: string, dot: string) =>
        col({ background: cardBg, borderRadius: 14, padding: 16, width: 196, border: `1px solid ${bd}` }, [
            row({ alignItems: 'center', marginBottom: 6 }, [h('div', { width: 7, height: 7, borderRadius: 7, background: dot, marginRight: 7 }), h('div', { fontSize: 12, color: muted, fontWeight: 700, letterSpacing: 1 }, label.toUpperCase())]),
            h('div', { fontSize: 32, fontWeight: 700, color: ink }, value),
        ]);
    const avatar = (initials: string, bg: string) => h('div', { display: 'flex', width: 38, height: 38, borderRadius: 38, background: bg, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, [h('div', { color: '#fff', fontSize: 14, fontWeight: 700 }, initials)]);
    const pending = (init: string, bg: string, name: string, meta: string) =>
        row({ alignItems: 'center', padding: '10px 0', borderBottom: `1px solid ${bd}` }, [avatar(init, bg), col({ flexGrow: 1 }, [h('div', { fontSize: 16, fontWeight: 700, color: ink }, name), h('div', { fontSize: 13, color: muted }, meta)]), h('div', { fontSize: 13, color: '#fff', fontWeight: 700, background: blue, borderRadius: 8, padding: '6px 12px' }, 'Approve')]);
    return col({ width: W, padding: 32, background: '#f4f6f9', fontFamily: 'Arial' }, [
        row({ justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }, [col({}, [h('div', { fontSize: 26, fontWeight: 700, color: ink }, 'Today at Viljetech'), h('div', { fontSize: 14, color: muted, marginTop: 2 }, 'Wed 17 Jun')]), h('div', { fontSize: 14, color: '#15803d', fontWeight: 700, background: '#e7f7ee', border: '1px solid #bfe8cf', borderRadius: 999, padding: '7px 14px' }, '🟢 Checked in 11:37')]),
        row({ justifyContent: 'space-between', marginBottom: 18 }, [kpi('Present', '2', '#16a34a'), kpi('Not in', '9', '#94a3b8'), kpi('On leave', '0', '#9333ea'), kpi('Pending', '2', blue)]),
        col({ background: cardBg, borderRadius: 16, padding: 20, border: `1px solid ${bd}` }, [
            h('div', { fontSize: 13, color: muted, fontWeight: 700, letterSpacing: 1, marginBottom: 6 }, 'PENDING APPROVALS'),
            pending('SP', '#2563eb', 'Sneha Patil', '1–3 Jul · Casual · 3 days'),
            pending('VN', '#16a34a', 'Vikram Nair', '15 Jun · Sick · 1 day'),
            pending('AK', '#9333ea', 'Aditya Kulkarni', '20 Jun · Casual · 1 day'),
        ]),
    ]);
};

// ── E. A+C hybrid (dark editorial: dark cards + serif/electric-blue brand) ──
const hybrid = (): N => {
    const bg = '#0c0b0a', ink = '#f1ece1', muted = '#8c8576', cardBg = '#16140f', bd = '#2b2823', blue = '#3f6bff', green = '#3ec27a';
    const card = (label: string, value: string, sub: string | null, dot: string) =>
        col({ background: cardBg, borderRadius: 16, padding: 22, width: 384, border: `1px solid ${bd}` }, [
            row({ alignItems: 'center', marginBottom: 10 }, [h('div', { width: 8, height: 8, borderRadius: 8, background: dot, marginRight: 9 }), h('div', { fontSize: 12, color: muted, fontFamily: 'Arial', fontWeight: 700, letterSpacing: 2 }, label.toUpperCase())]),
            row({ alignItems: 'baseline' }, [h('div', { fontSize: 48, fontFamily: 'Georgia', fontWeight: 700, color: ink }, value), ...(sub ? [h('div', { fontSize: 17, color: muted, fontFamily: 'Arial', marginLeft: 10 }, sub)] : [])]),
        ]);
    return col({ width: W, padding: 36, background: bg, fontFamily: 'Arial' }, [
        row({ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 26 }, [
            col({}, [
                h('div', { fontSize: 15, color: blue, fontFamily: 'Georgia', fontWeight: 700, fontStyle: 'italic', marginBottom: 4 }, 'Attendance.'),
                h('div', { fontSize: 34, fontFamily: 'Georgia', fontWeight: 700, color: ink }, 'Wednesday, 17 June'),
                h('div', { fontSize: 15, color: muted, fontFamily: 'Arial', marginTop: 4 }, 'You checked in at 11:37 · 2h 14m so far'),
            ]),
            row({ alignItems: 'center', background: '#11241a', border: '1px solid #234c34', borderRadius: 999, padding: '8px 16px' }, [h('div', { width: 9, height: 9, borderRadius: 9, background: green, marginRight: 8 }), h('div', { fontSize: 14, color: '#8fe5b0', fontFamily: 'Arial', fontWeight: 700 }, 'Checked in')]),
        ]),
        row({ justifyContent: 'space-between', marginBottom: 16 }, [card('Present today', '2', '/ 11', green), card('Pending approvals', '2', null, blue)]),
        row({ justifyContent: 'space-between', marginBottom: 16 }, [card('Hours logged', '395h', '· 35%', blue), card('On leave', '0', null, '#b07bff')]),
        col({ background: cardBg, borderRadius: 16, padding: 22, border: `1px solid ${bd}` }, [
            h('div', { fontSize: 12, color: muted, fontFamily: 'Arial', fontWeight: 700, letterSpacing: 2, marginBottom: 14 }, 'ATTENDANCE · LAST 12 DAYS'),
            row({ alignItems: 'flex-end', height: 110 }, BARS.map((v, i) => h('div', { width: 24, height: v * 9, borderRadius: 5, background: i === BARS.length - 1 ? blue : '#39342a', marginRight: 39 }))),
        ]),
    ]);
};

// ── FINAL: E hero + D-style pending list, dark/brand ───────────────────────
const finalCombined = (): N => {
    const bg = '#0c0b0a', ink = '#f1ece1', muted = '#8c8576', cardBg = '#16140f', bd = '#2b2823', blue = '#3f6bff', green = '#3ec27a';
    const card = (label: string, value: string, sub: string | null, dot: string) =>
        col({ background: cardBg, borderRadius: 16, padding: 20, width: 384, border: `1px solid ${bd}` }, [
            row({ alignItems: 'center', marginBottom: 9 }, [h('div', { width: 8, height: 8, borderRadius: 8, background: dot, marginRight: 9 }), h('div', { fontSize: 12, color: muted, fontFamily: 'Arial', fontWeight: 700, letterSpacing: 2 }, label.toUpperCase())]),
            row({ alignItems: 'baseline' }, [h('div', { fontSize: 44, fontFamily: 'Georgia', fontWeight: 700, color: ink }, value), ...(sub ? [h('div', { fontSize: 16, color: muted, fontFamily: 'Arial', marginLeft: 9 }, sub)] : [])]),
        ]);
    const avatar = (initials: string, c: string) => h('div', { display: 'flex', width: 40, height: 40, borderRadius: 40, background: c, alignItems: 'center', justifyContent: 'center', marginRight: 14 }, [h('div', { color: '#fff', fontSize: 15, fontFamily: 'Arial', fontWeight: 700 }, initials)]);
    const pendRow = (init: string, c: string, name: string, meta: string, last: boolean) =>
        row({ alignItems: 'center', padding: '12px 0', ...(last ? {} : { borderBottom: `1px solid ${bd}` }) }, [
            avatar(init, c),
            col({ flexGrow: 1 }, [h('div', { fontSize: 17, fontFamily: 'Georgia', fontWeight: 700, color: ink }, name), h('div', { fontSize: 13, color: muted, fontFamily: 'Arial', marginTop: 2 }, meta)]),
            h('div', { fontSize: 13, color: '#cdd8ff', fontFamily: 'Arial', fontWeight: 700, border: `1px solid ${blue}`, borderRadius: 8, padding: '7px 14px' }, 'Approve / Reject'),
        ]);
    return col({ width: W, padding: 36, background: bg, fontFamily: 'Arial' }, [
        row({ justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }, [
            col({}, [
                h('div', { fontSize: 15, color: blue, fontFamily: 'Georgia', fontWeight: 700, fontStyle: 'italic', marginBottom: 4 }, 'Attendance.'),
                h('div', { fontSize: 34, fontFamily: 'Georgia', fontWeight: 700, color: ink }, 'Wednesday, 17 June'),
                h('div', { fontSize: 15, color: muted, fontFamily: 'Arial', marginTop: 4 }, 'You checked in at 11:37 · 2h 14m so far'),
            ]),
            row({ alignItems: 'center', background: '#11241a', border: '1px solid #234c34', borderRadius: 999, padding: '8px 16px' }, [h('div', { width: 9, height: 9, borderRadius: 9, background: green, marginRight: 8 }), h('div', { fontSize: 14, color: '#8fe5b0', fontFamily: 'Arial', fontWeight: 700 }, 'Checked in')]),
        ]),
        row({ justifyContent: 'space-between', marginBottom: 16 }, [card('Present today', '2', '/ 11', green), card('On leave', '0', null, '#b07bff')]),
        col({ background: cardBg, borderRadius: 16, padding: 22, border: `1px solid ${bd}`, marginBottom: 16 }, [
            row({ alignItems: 'center', marginBottom: 4 }, [h('div', { fontSize: 12, color: muted, fontFamily: 'Arial', fontWeight: 700, letterSpacing: 2 }, 'PENDING APPROVALS · 2')]),
            pendRow('SP', '#3f6bff', 'Sneha Patil', '1–3 Jul · Casual · 3 days', false),
            pendRow('VN', '#3ec27a', 'Vikram Nair', '15 Jun · Sick · 1 day', true),
        ]),
        col({ background: cardBg, borderRadius: 16, padding: 22, border: `1px solid ${bd}` }, [
            h('div', { fontSize: 12, color: muted, fontFamily: 'Arial', fontWeight: 700, letterSpacing: 2, marginBottom: 14 }, 'ATTENDANCE · LAST 12 DAYS'),
            row({ alignItems: 'flex-end', height: 96 }, BARS.map((v, i) => h('div', { width: 24, height: v * 8, borderRadius: 5, background: i === BARS.length - 1 ? blue : '#39342a', marginRight: 39 }))),
        ]),
    ]);
};

const main = async () => {
    const files: { id: string; label: string; file: string }[] = [];
    files.push({ id: 'FINAL', label: 'FINAL · E hero + D-style pending approvals (dark editorial) ★', file: await render('FINAL-E-plus-D', finalCombined()) });
    files.push({ id: 'E', label: 'E · A+C HYBRID (dark editorial — dark cards + serif/electric-blue)', file: await render('E-hybrid', hybrid()) });
    files.push({ id: 'A', label: 'A · Midnight (dark cards + chart)', file: await render('A-midnight', midnight()) });
    files.push({ id: 'B', label: 'B · Daylight (light, soft cards + chart)', file: await render('B-daylight', daylight()) });
    files.push({ id: 'C', label: 'C · Editorial (Viljetech brand — cream/ink/blue, serif)', file: await render('C-editorial', editorial()) });
    files.push({ id: 'D', label: 'D · Operational (KPI strip + pending list w/ avatars)', file: await render('D-operational', operational()) });

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Slack Home dashboard — options</title>
<style>body{margin:0;background:#202225;color:#e8eaed;font:16px -apple-system,Segoe UI,Arial;padding:32px}
h1{font-size:22px;margin:0 0 6px}p.sub{color:#9aa0a8;margin:0 0 28px}
.grid{display:flex;flex-direction:column;gap:34px;max-width:920px;margin:0 auto}
.opt{background:#2b2d31;border:1px solid #1e1f22;border-radius:14px;padding:16px}
.opt h2{font-size:16px;margin:0 0 12px;color:#fff}
.opt img{width:100%;border-radius:10px;display:block;border:1px solid #1e1f22}</style></head>
<body><div class="grid"><div><h1>Slack Home tab — dashboard options</h1>
<p class="sub">Sample data. Pick one (A/B/C/D) and I'll build it data-driven into the Home tab.</p></div>
${files.map((f) => `<div class="opt"><h2>${f.label}</h2><img src="${f.file}" alt="${f.id}"></div>`).join('\n')}
</div></body></html>`;
    writeFileSync(`${OUT}/index.html`, html);
    console.log('wrote', files.length, 'options +', `${OUT}/index.html`);
};

void main();
