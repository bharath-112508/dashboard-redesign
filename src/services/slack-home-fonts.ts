import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import logger from '../utils/logger.js';

export interface HomeFont {
    name: string;
    data: Buffer;
    weight: 400 | 700;
    style: 'normal' | 'italic';
}

const require = createRequire(import.meta.url);

const FILES: Array<{ pkg: string; file: string; name: string; weight: 400 | 700; style: 'normal' | 'italic' }> = [
    { pkg: '@fontsource/inter', file: 'inter-latin-400-normal.woff', name: 'Inter', weight: 400, style: 'normal' },
    { pkg: '@fontsource/inter', file: 'inter-latin-700-normal.woff', name: 'Inter', weight: 700, style: 'normal' },
    {
        pkg: '@fontsource/playfair-display',
        file: 'playfair-display-latin-700-normal.woff',
        name: 'Playfair',
        weight: 700,
        style: 'normal',
    },
    {
        pkg: '@fontsource/playfair-display',
        file: 'playfair-display-latin-700-italic.woff',
        name: 'Playfair',
        weight: 700,
        style: 'italic',
    },
];

let cache: HomeFont[] | null = null;

export const loadHomeFonts = (): HomeFont[] => {
    if (cache) return cache;
    const fonts: HomeFont[] = [];
    for (const f of FILES) {
        try {
            const path = require.resolve(`${f.pkg}/files/${f.file}`);
            fonts.push({ name: f.name, data: readFileSync(path), weight: f.weight, style: f.style });
        } catch (err) {
            logger.warn({ err, code: 'SLACK_HOME_FONT_MISSING', file: f.file }, 'Slack Home dashboard font missing');
        }
    }
    cache = fonts;
    return fonts;
};
