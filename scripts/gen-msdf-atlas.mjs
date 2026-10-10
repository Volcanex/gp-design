#!/usr/bin/env node
/**
 * Build-time only. Generates an MSDF atlas for the app's one default font,
 * JetBrains Mono Regular (SIL Open Font License 1.1), and writes the result
 * into public/assets/msdf/jetbrains-mono/. Runtime never imports
 * msdf-bmfont-xml; the generated atlas.png + font.json are committed so
 * `npm run build`/serve never needs this tool.
 *
 * The TTF is not vendored. Get the static Regular TTF from the official
 * release and pass its path:
 *
 *   https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip
 *   (zip sha256 6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf)
 *   fonts/ttf/JetBrainsMono-Regular.ttf
 *   (ttf sha256 a0bf60ef0f83c5ed4d7a75d45838548b1f6873372dfac88f71804491898d138f)
 *
 *   node scripts/gen-msdf-atlas.mjs path/to/JetBrainsMono-Regular.ttf
 *   MSDF_FONT_PATH=path/to/JetBrainsMono-Regular.ttf npm run gen:atlas
 *
 * Default when neither is given: fonts/JetBrainsMono-Regular.ttf under the
 * repo root. The TTF itself is not committed; only the generated atlas is.
 * The variable woff2 in public/g/fonts/ does not work with msdf-bmfont-xml.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import generateBMFont from 'msdf-bmfont-xml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const FONT_PATH = resolve(
  process.argv[2] ?? process.env.MSDF_FONT_PATH ?? resolve(ROOT, 'fonts/JetBrainsMono-Regular.ttf'),
);
const OUT_DIR = resolve(ROOT, 'public/assets/msdf/jetbrains-mono');

generateBMFont(
  FONT_PATH,
  { outputType: 'json', fieldType: 'msdf', fontSize: 42, texturePadding: 2 },
  async (err, textures, font) => {
    if (err) {
      console.error('gen-msdf-atlas: font not found or generation failed:', err.message);
      console.error(`expected font at ${FONT_PATH}; pass a path or set MSDF_FONT_PATH (see header).`);
      process.exit(1);
    }
    if (textures.length !== 1) {
      console.error(`gen-msdf-atlas: expected a single-page atlas, got ${textures.length} pages`);
      process.exit(1);
    }
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(resolve(OUT_DIR, 'atlas.png'), textures[0].texture);
    await writeFile(resolve(OUT_DIR, 'font.json'), font.data);
    console.log(`gen-msdf-atlas: wrote ${OUT_DIR}/atlas.png + font.json (${JSON.parse(font.data).chars.length} glyphs)`);
  },
);
