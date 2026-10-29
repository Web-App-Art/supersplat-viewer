#!/usr/bin/env node
// ARTLIGHT (TKT-268)
//
// Prépare la carte navigable d'une scène : un fond de carte par niveau (vue de
// dessus des splats coupée au-dessus du sol + carte des murs), ou une vue
// d'avion pour un extérieur. Calculé une fois ici, lu par le visualisateur.
//
//   node scripts/scene-map.mjs propose <project.json> [id scène] [--lod n] [--force] [--surface-min m²]
//                                       [--type auto|interieur|exterieur|mixte] [--sans-vignettes]
//   node scripts/scene-map.mjs build   <project.json> [id scène] [--lod n]
//
// 1. « propose » détecte les niveaux et écrit, dans le dossier map/ à côté du
//    project.json (map/<id scène>/ si le projet a plusieurs scènes) :
//    - levels.json : la liste éditable (id, name, floor, bounds, cut, keep) ;
//    - controle.html : vues de côté avec les niveaux et une vignette par niveau.
//    On relit la planche, on raye les faux niveaux (keep: false), on nomme les
//    vrais. TKT-297 : chaque niveau porte ses mesures (surface, murs, couvert)
//    et, s'il est écarté d'office, sa raison (« raison » : « Petite surface »,
//    « Toit ou plafond probable », « Sol à ciel ouvert », « Scène extérieure ») ;
//    une scène extérieure reçoit la vue d'avion seule. Règles et seuils :
//    scene-map-niveaux.mjs ; --surface-min <m²> règle le seuil de surface (15),
//    --type impose le type de scène (extérieur : vue d'avion seule ; intérieur :
//    jamais de vue d'avion ; mixte : les deux). Un niveau gardé mais douteux
//    porte « doute ». Les noms proposés partent du rez-de-chaussée.
//    La vue d'avion est toujours proposée, gardée selon la même décision.
// 2. « build » rend, pour chaque entrée gardée, <id>.webp (photo vue de dessus)
//    et <id>-murs.png (carte des murs, sauf vue d'avion), contrôle le recalage
//    photo / murs, complète la planche et écrit le bloc « map » de la scène dans
//    project.json :
//      "map": { "north": 0, "levels": [ { "id", "name", "floor",
//               "bounds": [E0, N0, E1, N1], "photo", "walls" } ] }
//    Noms de pièces (facultatifs, lot 4) : "rooms": [{ "name", "at": [E, N] }]
//    dans une entrée de levels.json, recopié tel quel dans le niveau du bloc.
//    La planche les fait saisir d'un clic sur la carte construite.
//    "eye" (facultatif) : hauteur de l'œil au-dessus du sol après un clic sur la
//    carte, 1,60 m par défaut ; plus basse sous un plafond bas. Recopié aussi.
//    bounds est dans le repère source (E, N) de coordinates.ts : un point du
//    moteur (x, y, z) tombe sur la carte en (−x, z). north vaut 0 (nord du
//    quadrillage en haut) pour une scène géoréférencée ; absent sinon.
//
// Les splats sont lus au LOD 1 (un .sog tel quel), exportés en PLY binaire par
// splat-transform (v3.10.0) dans un dossier temporaire. Le PLY est en (E, −H, N).
// PIÈGE : le filtre -B et le rendu .webp de splat-transform travaillent dans le
// repère du moteur, (−E, H, N). D'où la caméra en −E et la boîte en H positif.

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { deflateSync } from 'zlib';

import { spliceMapBlock } from './project-json.mjs';
import { decideLevels, DEFAULT_RULES, detectLevels, levelBounds as boundsOf, levelNames, percentiles, readSplatsPly, SCENE_TYPES } from './scene-map-niveaux.mjs';
import { runSplatTransform } from './splat-transform-cli.mjs';

// Fonds de carte.
const MARGIN = 1.0;                     // marge autour de l'emprise d'un niveau
const DEFAULT_CUT = 1.8;                // photo : splats de sol − 0,2 à sol + 1,8
const PHOTO_PX = 0.02;                  // 2 cm par pixel en intérieur…
const MAX_SIDE = 1600;                  // …côté de l'image plafonné
const WALL_CELL = 0.04;                 // case de la carte des murs
const WALL_FROM = 0.3;                  // murs : tranches de 10 cm de sol + 0,3…
const WALL_TO = 2.0;                    // …à sol + 2,0 (17 tranches)
const WALL_SLICE = 0.1;
const WALL_FULL = 0.6;                  // part occupée qui donne un mur plein
const CAMERA_DISTANCE = 2000;           // caméra quasi orthographique (champ étroit)
const THUMB_SIDE = 420;                 // vignettes de la planche
const SIDE_MAX = 1400;                  // vues de côté
const CHECK_SHIFT = 1.5;                // recalage cherché à ± 1,5 m
const CHECK_TOLERANCE = 0.1;            // au-delà de 10 cm : recalage douteux
const CHECK_MIN_SCORE = 0.5;            // corrélation plus faible : photo douteuse
const TILE = 640;                       // côté maximal d'une tuile de rendu
const MIN_TILE = 80;                    // tuile recoupée jusqu'à 80 px au plus petit
const PHOTO_QUALITY = 80;               // qualité cwebp de la photo

const fail = (message) => {
    console.error(`scene-map : ${message}`);
    process.exit(1);
};

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

const fmt = (v, d = 2) => v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

const seconds = t0 => (Date.now() - t0) / 1000;

// --- arguments ---------------------------------------------------------------

const args = process.argv.slice(2);
const opts = { lod: 1, force: false, rules: {}, thumbs: true, type: 'auto' };
const positional = [];
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--lod') opts.lod = Number(args[++i]);
    else if (a === '--force') opts.force = true;
    else if (a === '--surface-min') opts.rules.minArea = Number(args[++i]);
    else if (a === '--sans-vignettes') opts.thumbs = false;
    else if (a === '--type') opts.type = args[++i];
    else if (a.startsWith('--')) fail(`option inconnue ${a}`);
    else positional.push(a);
}
const [step, projectArg, sceneArg] = positional;
if (!['propose', 'build'].includes(step) || !projectArg) {
    fail('usage : node scripts/scene-map.mjs propose|build <project.json> [id scène] [--lod n] [--force] [--surface-min m²] [--type auto|interieur|exterieur|mixte] [--sans-vignettes]');
}
if (!Number.isInteger(opts.lod) || opts.lod < 0) fail('--lod attend un entier positif');
if (!SCENE_TYPES.includes(opts.type)) fail(`--type attend ${SCENE_TYPES.join(', ')}`);
if (opts.rules.minArea !== undefined && !(opts.rules.minArea >= 0)) fail('--surface-min attend une surface en m²');

const projectPath = resolve(projectArg);
const projectDir = dirname(projectPath);
const projectText = readFileSync(projectPath, 'utf-8');
const project = JSON.parse(projectText);
const scenes = project.scenes ?? [];
const scene = sceneArg ? scenes.find(s => s.id === sceneArg) : scenes.length === 1 ? scenes[0] : null;
if (!scene) {
    fail(sceneArg ? `scène « ${sceneArg} » absente du projet` : `préciser la scène : ${scenes.map(s => s.id).join(', ')}`);
}
const contentRel = scene.content ?? scene.pointcloud;
if (!contentRel) fail(`la scène « ${scene.id} » n'a ni content ni pointcloud`);
const contentPath = resolve(projectDir, contentRel);

// Un dossier map/ par scène quand le projet en a plusieurs.
const mapDir = scenes.length > 1 ? join(projectDir, 'map', scene.id) : join(projectDir, 'map');
const controlDir = join(mapDir, 'controle');
const levelsPath = join(mapDir, 'levels.json');
const proposePath = join(controlDir, 'propose.json');
const buildPath = join(controlDir, 'build.json');

// LOD lu : celui demandé, borné au plus grossier ; un .sog n'a pas de LOD.
// Les vignettes de la planche se contentent de 2 LOD plus grossiers.
const lodArgs = (wanted = opts.lod) => {
    if (!contentPath.endsWith('lod-meta.json')) return { args: [], lod: null };
    const meta = JSON.parse(readFileSync(contentPath, 'utf-8'));
    const lod = Math.min(wanted, (meta.lodLevels ?? 1) - 1);
    return { args: ['-L', String(lod)], lod };
};

const splatTransform = (list) => {
    try {
        runSplatTransform(['-w', ...list]);
    } catch (e) {
        const detail = String(e.stderr ?? '').trim().split('\n').slice(-3).join(' / ');
        fail(`splat-transform a échoué (${detail || e.message.split('\n')[0]})`);
    }
};

// --- lecture des splats ----------------------------------------------------

// Splats du LOD lu, exportés en PLY dans un dossier temporaire puis lus en
// (E, H, N) avec le drapeau « surface horizontale » (scene-map-niveaux.mjs).
const loadSplats = () => {
    const t0 = Date.now();
    const { args: lod, lod: lodLevel } = lodArgs();
    const dir = mkdtempSync(join(tmpdir(), 'scene-map-'));
    const ply = join(dir, 'splats.ply');
    try {
        splatTransform([...lod, contentPath, '-H', '0', ply]);
        let s;
        try {
            s = readSplatsPly(ply);
        } catch (e) {
            fail(e.message);
        }
        console.log(`${s.n.toLocaleString('fr-FR')} splats lus sur ${s.total.toLocaleString('fr-FR')}${lodLevel === null ? '' : ` (LOD ${lodLevel})`} en ${fmt(seconds(t0), 1)} s`);
        return { ...s, lod: lodLevel };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

const levelBounds = (s, floor) => boundsOf(s, floor, { from: WALL_FROM, to: WALL_TO, margin: MARGIN });

// --- images ------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});

const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
};

// Encodeur PNG minimal : 8 bits, gris (1 canal) ou gris + alpha (2 canaux).
const writePng = (path, width, height, channels, pixels) => {
    const chunk = (type, data) => {
        const out = Buffer.alloc(12 + data.length);
        out.writeUInt32BE(data.length, 0);
        out.write(type, 4, 'latin1');
        data.copy(out, 8);
        out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
        return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = channels === 1 ? 0 : 4;
    const raw = Buffer.alloc((width * channels + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * channels + 1)] = 0;
        Buffer.from(pixels.buffer, pixels.byteOffset + y * width * channels, width * channels)
        .copy(raw, y * (width * channels + 1) + 1);
    }
    writeFileSync(path, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]));
};

const run = (cmd, list) => {
    try {
        execFileSync(cmd, list, { stdio: ['ignore', 'ignore', 'inherit'] });
    } catch (e) {
        fail(e.code === 'ENOENT' ? `${cmd} introuvable : brew install webp` : `${cmd} a échoué (${e.message.split('\n')[0]})`);
    }
};

// .webp ↔ RVBA par dwebp / cwebp (paquet webp de Homebrew), au format PAM.
const readWebp = (path) => {
    const pam = `${path}.pam`;
    run('dwebp', ['-quiet', path, '-pam', '-o', pam]);
    const data = readFileSync(pam);
    rmSync(pam, { force: true });
    const end = data.indexOf('ENDHDR\n');
    const head = data.toString('latin1', 0, end);
    const field = key => Number(new RegExp(`${key} (\\d+)`).exec(head)?.[1]);
    if (field('DEPTH') !== 4) fail(`${path} : RVBA attendu`);
    return { width: field('WIDTH'), height: field('HEIGHT'), rgba: data.subarray(end + 7) };
};

const writeWebp = (path, width, height, rgba) => {
    const pam = `${path}.pam`;
    const head = `P7\nWIDTH ${width}\nHEIGHT ${height}\nDEPTH 4\nMAXVAL 255\nTUPLTYPE RGB_ALPHA\nENDHDR\n`;
    writeFileSync(pam, Buffer.concat([Buffer.from(head, 'latin1'), rgba]));
    run('cwebp', ['-quiet', '-q', String(PHOTO_QUALITY), '-alpha_q', '100', '-m', '6', pam, '-o', path]);
    rmSync(pam, { force: true });
};

// Emprise des splats d'une tranche (sol − 0,2 à sol + coupe ; tout en vue
// d'avion) sur une grille de `cell`, ligne 0 au nord.
const footprint = (s, { bounds, floor, cut, cell }) => {
    const [e0, n0, e1, n1] = bounds;
    const w = Math.floor((e1 - e0) / cell), h = Math.floor((n1 - n0) / cell);
    const grid = new Uint8Array(w * h);
    for (let i = 0; i < s.n; i++) {
        if (cut !== null && !(s.H[i] > floor - 0.2 && s.H[i] < floor + cut)) continue;
        const x = Math.floor((s.E[i] - e0) / cell), y = Math.floor((n1 - s.N[i]) / cell);
        if (x >= 0 && x < w && y >= 0 && y < h) grid[y * w + x] = 1;
    }
    return { w, h, cell, grid };
};

// Vue de dessus quasi orthographique : caméra à 2 km au-dessus du sol, nord en
// haut, champ vertical = hauteur du cadre. Fond transparent (hors scan).
// En repère moteur (−E, H, N) : caméra en x = −E du centre, boîte en H.
// Au-delà d'environ 800 px, splat-transform v3.3.3 perdait des splats sans
// prévenir sur une tranche dense (image presque vide ; corrigé en v3.10.0,
// mêmes résultats avec les tuiles) : on rend donc en tuiles
// de 640 px au plus, depuis la tranche exportée une fois en PLY, et une tuile
// nettement moins couverte que l'emprise des splats est recoupée en quatre.
const renderTop = ({ bounds, floor, cut, px, out, lod = opts.lod, splats = null }) => {
    const [e0, , , n1] = bounds;
    const width = Math.round((bounds[2] - e0) / px), height = Math.round((n1 - bounds[1]) / px);
    const box = cut === null ? [] : ['-B', `-1e4,${round(floor - 0.2, 3)},-1e4,1e4,${round(floor + cut, 3)},1e4`];
    const t0 = Date.now();
    const view = (input, x0, y0, w, h, file) => {
        const ec = e0 + (x0 + w / 2) * px, nc = n1 - (y0 + h / 2) * px;
        const fov = 2 * Math.atan(h * px / 2 / CAMERA_DISTANCE) * 180 / Math.PI;
        splatTransform([
            ...input, file,
            '--camera-pos', `${-ec},${floor + CAMERA_DISTANCE},${nc}`,
            '--camera-target', `${-ec},${floor},${nc}`,
            '--camera-up', '0,0,1',
            '--camera-fov', String(fov),
            '--resolution', `${w}x${h}`,
            '--camera-near', String(CAMERA_DISTANCE - 100),
            '--background', '0,0,0,0'
        ]);
    };
    // vignette d'une seule tuile : rendue telle quelle, sans contrôle ni cwebp
    if (!splats && width <= TILE && height <= TILE) {
        view([...lodArgs(lod).args, contentPath, ...box], 0, 0, width, height, out);
        return { width, height, tiles: 1, split: 0, seconds: round(seconds(t0), 1) };
    }
    const dir = mkdtempSync(join(tmpdir(), 'scene-map-'));
    try {
        const band = join(dir, 'tranche.ply');
        splatTransform([...lodArgs(lod).args, contentPath, ...box, band]);
        const grid = splats && footprint(splats, { bounds, floor, cut, cell: Math.max(px, 0.1) });
        const rgba = Buffer.alloc(width * height * 4);
        let tiles = 0, split = 0;
        const tile = (x0, y0, w, h) => {
            const file = join(dir, 'tuile.webp');
            view([band], x0, y0, w, h, file);
            tiles++;
            const img = readWebp(file);
            if (grid && w >= 2 * MIN_TILE && h >= 2 * MIN_TILE) {
                // couverture par case de la grille : splats attendus / photo
                const k = grid.cell / px;
                const cx0 = Math.ceil(x0 / k), cx1 = Math.floor((x0 + w) / k);
                const cy0 = Math.ceil(y0 / k), cy1 = Math.floor((y0 + h) / k);
                let expected = 0, got = 0;
                for (let cy = cy0; cy < Math.min(cy1, grid.h); cy++) {
                    for (let cx = cx0; cx < Math.min(cx1, grid.w); cx++) {
                        expected += grid.grid[cy * grid.w + cx];
                        const ix = Math.min(w - 1, Math.floor((cx + 0.5) * k) - x0);
                        const iy = Math.min(h - 1, Math.floor((cy + 0.5) * k) - y0);
                        if (img.rgba[(iy * w + ix) * 4 + 3] > 127) got++;
                    }
                }
                if (expected > 20 && got < 0.5 * expected) {
                    split++;
                    const hw = Math.floor(w / 2), hh = Math.floor(h / 2);
                    tile(x0, y0, hw, hh);
                    tile(x0 + hw, y0, w - hw, hh);
                    tile(x0, y0 + hh, hw, h - hh);
                    tile(x0 + hw, y0 + hh, w - hw, h - hh);
                    return;
                }
            }
            for (let y = 0; y < h; y++) {
                img.rgba.copy(rgba, ((y0 + y) * width + x0) * 4, y * w * 4, (y + 1) * w * 4);
            }
        };
        const nx = Math.ceil(width / TILE), ny = Math.ceil(height / TILE);
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const x0 = Math.round(i * width / nx), y0 = Math.round(j * height / ny);
                tile(x0, y0, Math.round((i + 1) * width / nx) - x0, Math.round((j + 1) * height / ny) - y0);
            }
        }
        writeWebp(out, width, height, rgba);
        return { width, height, tiles, split, seconds: round(seconds(t0), 1) };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

// Vues de côté (densité E/H et N/H, échelle log), pour repérer les planchers.
const writeSideViews = (s) => {
    const [h0, h1] = percentiles(s.H, [0.5, 99.5]);
    const [e0, e1] = percentiles(s.E, [0.5, 99.5]);
    const [n0, n1] = percentiles(s.N, [0.5, 99.5]);
    const step = Math.max(0.05, Math.max(e1 - e0, n1 - n0) / SIDE_MAX);
    const views = [];
    for (const [axis, values, lo, hi] of [['E', s.E, e0, e1], ['N', s.N, n0, n1]]) {
        const w = Math.ceil((hi - lo) / step), h = Math.ceil((h1 - h0) / step);
        const counts = new Uint32Array(w * h);
        for (let i = 0; i < s.n; i++) {
            const x = Math.floor((values[i] - lo) / step), y = Math.floor((h1 - s.H[i]) / step);
            if (x >= 0 && x < w && y >= 0 && y < h) counts[y * w + x]++;
        }
        let max = 1;
        for (const c of counts) if (c > max) max = c;
        const lmax = Math.log1p(max);
        const pixels = new Uint8Array(w * h);
        for (let i = 0; i < pixels.length; i++) pixels[i] = Math.round(255 * (1 - Math.log1p(counts[i]) / lmax));
        const file = `cote-${axis.toLowerCase()}.png`;
        writePng(join(controlDir, file), w, h, 1, pixels);
        views.push({ axis, file, width: w, height: h, lo: round(lo, 2), hi: round(hi, 2), top: round(h1, 2), bottom: round(h0, 2), step });
    }
    return views;
};

// Carte des murs : par case de 4 cm, nombre de tranches de 10 cm occupées
// entre sol + 0,3 et sol + 2,0 ; gris foncé + alpha (opaque = mur).
const writeWalls = (s, { bounds, floor, cell, width, height, out }) => {
    const [e0, , , n1] = bounds;
    const slices = Math.round((WALL_TO - WALL_FROM) / WALL_SLICE);
    const mask = new Uint32Array(width * height);
    for (let i = 0; i < s.n; i++) {
        const h = s.H[i] - floor;
        if (!(h > WALL_FROM && h < WALL_TO)) continue;
        const x = Math.floor((s.E[i] - e0) / cell), y = Math.floor((n1 - s.N[i]) / cell);
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        mask[y * width + x] |= 1 << Math.min(slices - 1, Math.floor((h - WALL_FROM) / WALL_SLICE));
    }
    const pixels = new Uint8Array(width * height * 2);
    let walls = 0;
    for (let i = 0; i < mask.length; i++) {
        let m = mask[i], c = 0;
        while (m) {
            m &= m - 1; c++;
        }
        const a = Math.min(1, c / slices / WALL_FULL) ** 0.7;
        pixels[i * 2] = 0x22;
        pixels[i * 2 + 1] = Math.round(255 * a);
        if (a >= 1) walls++;
    }
    writePng(out, width, height, 2, pixels);
    return walls * cell * cell;
};

// Contrôle du recalage : l'emprise de la photo (alpha) doit tomber sur celle
// des splats de la même tranche. Corrélation normalisée des deux masques, sur
// une grille de 10 cm (plus large en vue d'avion), décalages de ± 1,5 m.
const checkRegistration = (s, { bounds, floor, cut, webp }) => {
    const image = readWebp(webp);
    const [e0, n0, e1, n1] = bounds;
    const { w, h, cell, grid } = footprint(s, { bounds, floor, cut, cell: Math.max(0.1, Math.max(e1 - e0, n1 - n0) / 400) });
    const splats = Float32Array.from(grid);
    const photo = new Float32Array(w * h), samples = new Float32Array(w * h);
    const sx = image.width / (e1 - e0), sy = image.height / (n1 - n0);
    for (let py = 0; py < image.height; py++) {
        const y = Math.floor(py / sy / cell);
        if (y >= h) continue;
        for (let px = 0; px < image.width; px++) {
            const x = Math.floor(px / sx / cell);
            if (x >= w) continue;
            photo[y * w + x] += image.rgba[(py * image.width + px) * 4 + 3] / 255;
            samples[y * w + x]++;
        }
    }
    for (let i = 0; i < photo.length; i++) photo[i] = samples[i] ? photo[i] / samples[i] : 0;
    const centred = (v) => {
        const mean = v.reduce((a, b) => a + b, 0) / v.length;
        return v.map(x => x - mean);
    };
    const a = centred(splats), b = centred(photo);
    const r = Math.min(30, Math.round(CHECK_SHIFT / cell));
    const score = (dx, dy) => {
        let ab = 0, aa = 0, bb = 0;
        for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) {
            for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x++) {
                const va = a[y * w + x], vb = b[(y + dy) * w + x + dx];
                ab += va * vb; aa += va * va; bb += vb * vb;
            }
        }
        return ab / Math.sqrt(aa * bb || 1);
    };
    let best = { dx: 0, dy: 0, score: -Infinity };
    for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
            const v = score(dx, dy);
            if (v > best.score) best = { dx, dy, score: v };
        }
    }
    // photo décalée de (dx, dy) cases : vers l'est et vers le sud
    const shiftE = round(best.dx * cell, 2), shiftN = round(-best.dy * cell, 2);
    return {
        cell: round(cell, 3),
        score: round(score(0, 0), 3),
        best: round(best.score, 3),
        shiftE,
        shiftN,
        ok: best.score >= CHECK_MIN_SCORE && Math.hypot(shiftE, shiftN) <= Math.max(CHECK_TOLERANCE, cell) + 1e-9
    };
};

// --- planche de contrôle -----------------------------------------------------

const escapeHtml = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Saisie des noms de pièces sur la planche, sans dépendance : un clic sur la
// carte ajoute un point (E, N), le nom se tape dessous, le bloc « rooms » à
// recopier dans levels.json est tenu à jour.
const ROOMS_EDITOR = `
const r2 = v => Math.round(v * 100) / 100;
for (const section of document.querySelectorAll('section.map[data-bounds]')) {
    const [e0, n0, e1, n1] = JSON.parse(section.dataset.bounds);
    const rooms = JSON.parse(section.dataset.rooms);
    const svg = section.querySelector('svg.rooms');
    const [, , w, h] = svg.getAttribute('viewBox').split(' ').map(Number);
    const editor = section.querySelector('.rooms-editor');
    const list = document.createElement('ol');
    const out = document.createElement('pre');
    const copy = document.createElement('button');
    copy.textContent = 'Copier le bloc';
    copy.onclick = () => navigator.clipboard?.writeText(out.textContent).then(() => { copy.textContent = 'Copié'; setTimeout(() => { copy.textContent = 'Copier le bloc'; }, 1200); });
    editor.append(list, out, copy);
    const text = (x, y, size, t) => { const el = document.createElementNS('http://www.w3.org/2000/svg', 'text'); el.setAttribute('x', x); el.setAttribute('y', y); el.setAttribute('font-size', size); el.setAttribute('text-anchor', 'middle'); el.setAttribute('fill', '#fff'); el.setAttribute('stroke', '#000'); el.setAttribute('stroke-width', size / 6); el.setAttribute('paint-order', 'stroke'); el.textContent = t; return el; };
    const render = () => {
        svg.replaceChildren();
        const size = Math.max(w, h) / 45;
        rooms.forEach((room, i) => {
            const x = (room.at[0] - e0) / (e1 - e0) * w, y = (n1 - room.at[1]) / (n1 - n0) * h;
            const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            dot.setAttribute('cx', x); dot.setAttribute('cy', y); dot.setAttribute('r', size / 3); dot.setAttribute('fill', '#84cc16'); dot.setAttribute('stroke', '#000');
            svg.append(dot, text(x, y - size * 0.6, size, room.name || '#' + (i + 1)));
        });
        list.replaceChildren(...rooms.map((room, i) => {
            const li = document.createElement('li');
            const input = document.createElement('input');
            input.value = room.name;
            input.placeholder = 'nom de la pièce';
            input.oninput = () => { room.name = input.value; render.light(); };
            const del = document.createElement('button');
            del.textContent = 'Retirer';
            del.onclick = () => { rooms.splice(i, 1); render(); };
            li.append(input, ' E ' + room.at[0].toFixed(2) + ' ; N ' + room.at[1].toFixed(2) + ' ', del);
            return li;
        }));
        render.light();
    };
    render.light = () => {
        const kept = rooms.filter(r => r.name.trim());
        out.textContent = '"rooms": [' + kept.map(r => '\\n  ' + JSON.stringify({ name: r.name.trim(), at: r.at })).join(',') + (kept.length ? '\\n' : '') + ']';
        svg.querySelectorAll('text').forEach((t, i) => { t.textContent = rooms[i].name || '#' + (i + 1); });
    };
    svg.addEventListener('click', (event) => {
        const rect = svg.getBoundingClientRect();
        const e = r2(e0 + (event.clientX - rect.left) / rect.width * (e1 - e0));
        const n = r2(n1 - (event.clientY - rect.top) / rect.height * (n1 - n0));
        rooms.push({ name: '', at: [e, n] });
        render();
        list.lastChild.querySelector('input').focus();
    });
    render();
}
`;

const writeControl = () => {
    const levels = JSON.parse(readFileSync(levelsPath, 'utf-8'));
    const proposal = JSON.parse(readFileSync(proposePath, 'utf-8'));
    const built = existsSync(buildPath) ? JSON.parse(readFileSync(buildPath, 'utf-8')) : null;
    const entries = levels.levels;

    const side = (view) => {
        const y = h => (view.top - h) / view.step;
        const size = view.width / 45;
        const lines = entries.filter(l => l.floor !== null && l.kind !== 'avion').map((l) => {
            const color = l.keep ? '#1a8f4a' : '#b3261e';
            return `<line x1="0" x2="${view.width}" y1="${y(l.floor)}" y2="${y(l.floor)}" stroke="${color}" stroke-width="${view.width / 500}" ${l.keep ? '' : 'stroke-dasharray="8 6"'}/>` +
                `<text x="${view.width * 0.99}" y="${y(l.floor) < size * 1.3 ? y(l.floor) + size * 1.1 : y(l.floor) - size * 0.35}" fill="${color}" font-size="${size}" text-anchor="end">${escapeHtml(l.id)} · ${fmt(l.floor)} m</text>`;
        }).join('');
        return `<figure><svg viewBox="0 0 ${view.width} ${view.height}"><image href="controle/${view.file}" width="${view.width}" height="${view.height}"/>${lines}</svg>` +
            `<figcaption>Vue de côté, ${view.axis} de ${fmt(view.lo, 1)} à ${fmt(view.hi, 1)} m (horizontal), H de ${fmt(view.bottom, 1)} à ${fmt(view.top, 1)} m</figcaption></figure>`;
    };

    const rows = entries.map(l => `<tr class="${l.keep ? 'keep' : 'drop'}"><td>${escapeHtml(l.id)}</td><td>${escapeHtml(l.name)}</td>` +
        `<td>${l.kind === 'avion' ? 'vue d’avion' : escapeHtml(l.kind)}</td><td class="n">${l.floor === null ? '' : fmt(l.floor)}</td>` +
        `<td class="n">${(l.surface ?? l.area) === undefined ? '' : fmt(l.surface ?? l.area, 1)}</td>` +
        `<td class="n">${l.murs === undefined ? '' : fmt(l.murs)}</td><td class="n">${l.couvert === undefined ? '' : fmt(l.couvert)}</td>` +
        `<td class="n">${l.cut === null ? 'aucune' : `+${fmt(l.cut)}`}</td>` +
        `<td class="n">${l.bounds.map(v => fmt(v, 1)).join(' ; ')}</td><td class="decision">${l.keep ? 'gardé' : 'écarté'}${l.raison ? ` : ${escapeHtml(l.raison)}` : ''}${l.doute ? ` <b class="bad">à vérifier</b> : ${escapeHtml(l.doute)}` : ''}</td></tr>`).join('');

    const thumbs = entries.map((l) => {
        const thumb = proposal.thumbs[l.id];
        return `<figure class="thumb ${l.keep ? 'keep' : 'drop'}">${thumb ? `<img src="controle/${thumb}" alt="">` : '<div class="none">pas de vignette (entrée ajoutée à la main, ou propose --sans-vignettes)</div>'}` +
            `<figcaption><b>${escapeHtml(l.id)}</b> ${escapeHtml(l.name)} — ${l.floor === null ? '' : `sol ${fmt(l.floor)} m, `}${l.keep ? 'gardé' : 'écarté'}</figcaption></figure>`;
    }).join('');

    const maps = built ? built.levels.map((b) => {
        const check = `${b.check.ok ? 'recalage OK' : '<b class="bad">RECALAGE DOUTEUX</b>'} : meilleur décalage E ${fmt(b.check.shiftE)} m, N ${fmt(b.check.shiftN)} m ` +
            `(corrélation ${fmt(b.check.score, 3)} sans décalage, ${fmt(b.check.best, 3)} au mieux, case ${fmt(b.check.cell * 100, 0)} cm)`;
        // Noms de pièces (lot 4) : saisis d'un clic sur la carte, à recopier dans levels.json.
        const bounds = built.map.levels.find(m => m.id === b.id)?.bounds;
        const rooms = entries.find(l => l.id === b.id)?.rooms ?? [];
        const roomsData = bounds ? ` data-level="${escapeHtml(b.id)}" data-bounds="${escapeHtml(JSON.stringify(bounds))}" data-rooms="${escapeHtml(JSON.stringify(rooms))}"` : '';
        return `<section class="map"${roomsData}><h3>${escapeHtml(b.id)} — ${escapeHtml(b.name)}</h3>` +
            `<div class="stack" style="aspect-ratio:${b.width} / ${b.height}; width:min(100%, calc(85vh * ${b.width} / ${b.height}))"><img src="${escapeHtml(b.photoFile)}" alt="">${b.wallsFile ? `<img class="walls" src="${escapeHtml(b.wallsFile)}" alt="">` : ''}` +
            `<svg class="rooms" viewBox="0 0 ${b.width} ${b.height}" preserveAspectRatio="none"></svg></div>` +
            `<p>${b.width} × ${b.height} px (${fmt(b.px * 100, 1)} cm/px), photo ${fmt(b.photoBytes / 1024, 0)} Ko en ${fmt(b.seconds, 1)} s, ${b.tiles} tuile(s)` +
            `${b.wallsFile ? `, murs ${fmt(b.wallsBytes / 1024, 0)} Ko` : ''}. ${check}.</p><div class="rooms-editor"></div></section>`;
    }).join('') : '';

    const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Carte — ${escapeHtml(proposal.scene)}</title>
<style>
:root { --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --keep: #1a8f4a; --drop: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg: #161617; --fg: #f5f5f7; --muted: #a1a1a6; --line: #3a3a3c; } }
body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, system-ui, sans-serif; }
main { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 32px 0 8px; } h3 { font-size: 15px; margin: 16px 0 6px; }
p, figcaption { color: var(--muted); } code { font-size: 13px; }
.sides { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
figure { margin: 0; } svg, img { display: block; max-width: 100%; height: auto; background: #fff; border: 1px solid var(--line); }
.table { overflow-x: auto; } table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; } td.n { text-align: right; font-variant-numeric: tabular-nums; } td.decision { white-space: normal; min-width: 18em; }
tr.drop td { color: var(--muted); text-decoration: line-through; } tr.drop td:last-child { text-decoration: none; color: var(--drop); } tr.keep td:last-child { color: var(--keep); }
.thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
.thumb.drop img { opacity: .45; } .thumb .none { padding: 24px; border: 1px dashed var(--line); }
.stack { position: relative; max-width: 100%; background: #fff; border: 1px solid var(--line); }
.stack img { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: none; }
.stack svg.rooms { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: none; cursor: crosshair; }
.rooms-editor ol { padding-left: 24px; } .rooms-editor li { margin: 4px 0; } .rooms-editor input { font: inherit; width: 14em; }
.rooms-editor pre { padding: 8px; border: 1px solid var(--line); overflow-x: auto; font-size: 13px; }
.stack img.walls { opacity: var(--walls, 1); filter: brightness(0) invert(13%) sepia(97%) saturate(7400%) hue-rotate(4deg); } .bad { color: var(--drop); }
label { color: var(--muted); }
</style></head><body><main>
<h1>Carte de la scène « ${escapeHtml(proposal.scene)} »</h1>
<p>${proposal.splats.toLocaleString('fr-FR')} splats lus${proposal.lod === null ? '' : ` au LOD ${proposal.lod}`}. Détection en ${fmt(proposal.detection.seconds, 1)} s :
surfaces de sol ${fmt(proposal.detection.floorArea, 0)} m², de plafond ${fmt(proposal.detection.ceilingArea, 0)} m².
${proposal.type ? `Scène ${proposal.typeImpose ? 'déclarée' : 'jugée'} <b>${{ interieur: 'intérieure', exterieur: 'extérieure', mixte: 'mixte (niveaux et vue d’avion)' }[proposal.type]}</b>.` : ''}
${built ? `Cartes construites le ${escapeHtml(built.date)}.` : 'Cartes pas encore construites.'}</p>
<p>À faire : relire les vues de côté et les vignettes, puis éditer <code>levels.json</code> (<code>keep</code> à <code>false</code> pour un faux niveau, à <code>true</code> pour un niveau écarté à tort,
<code>name</code> pour les vrais, <code>floor</code>, <code>bounds</code> [E0, N0, E1, N1] ou <code>cut</code> si besoin) et lancer
<code>node scripts/scene-map.mjs build ${escapeHtml(proposal.projectArg)}</code>.</p>
<h2>Niveaux</h2>
<div class="table"><table><thead><tr><th>id</th><th>nom</th><th>origine</th><th>sol (m)</th><th>surface (m²)</th><th title="longueur de murs autour du sol, rapportée au périmètre d'un carré de même surface">murs</th><th title="part du sol qui a quelque chose au-dessus de sol + 2 m">couvert</th><th>coupe</th><th>emprise E0 ; N0 ; E1 ; N1</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>Vues de côté</h2>
<p>Densité des splats, sombre = dense. Vert : niveau gardé ; rouge pointillé : écarté.</p>
<div class="sides">${proposal.sides.map(side).join('')}</div>
<h2>Vignettes (vue de dessus, sol − 0,2 à sol + coupe, nord en haut)</h2>
<div class="thumbs">${thumbs}</div>
${built ? `<h2>Cartes</h2><p><label><input type="checkbox" checked onchange="document.body.style.setProperty('--walls', this.checked ? 1 : 0)"> murs (en rouge sur la planche) par-dessus la photo</label></p>
<p>Noms de pièces (facultatif) : cliquer au milieu d'une pièce sur la carte, taper son nom, puis recopier le bloc <code>"rooms"</code> obtenu dans
l'entrée du niveau de <code>levels.json</code> et relancer l'étape build. Les noms déjà saisis sont repris.</p>${maps}
<script>${ROOMS_EDITOR}</script>` : ''}
</main></body></html>
`;
    writeFileSync(join(mapDir, 'controle.html'), html);
};

// --- étape « propose » --------------------------------------------------------

const propose = () => {
    if (existsSync(levelsPath) && !opts.force) {
        fail(`${relative(process.cwd(), levelsPath)} existe déjà (peut-être édité) : --force pour le remplacer`);
    }
    const t0 = Date.now();
    mkdirSync(controlDir, { recursive: true });
    rmSync(buildPath, { force: true });
    const s = loadSplats();
    const td = Date.now();
    let detection;
    try {
        detection = detectLevels(s);
    } catch (e) {
        fail(e.message);
    }
    detection.seconds = round(seconds(td), 1);
    console.log(`détection : ${detection.horizontalCount.toLocaleString('fr-FR')} splats horizontaux, ${detection.levels.length} niveau(x) en ${fmt(detection.seconds, 1)} s`);
    const decision = decideLevels(detection.levels, { rules: opts.rules, type: opts.type, extent: detection.extent });
    const names = levelNames(detection.levels, decision.levels);
    const sides = writeSideViews(s);

    // Sol de la vue d'avion : le plus étendu des niveaux qui ne sont pas des
    // toits, sinon le plus grand sol détecté, sinon le bas du nuage.
    const ground = decision.aerialFloor ?? (detection.floors.length ?
        detection.floors.reduce((a, b) => (b.area > a.area ? b : a)).h :
        round(percentiles(s.H, [2])[0]));
    const entries = detection.levels.map((l, i) => ({
        id: `n${i + 1}`,
        name: names[i],
        kind: l.kind,
        floor: l.h,
        area: l.area,
        surface: l.surface,
        murs: l.murs,
        couvert: l.couvert,
        cut: DEFAULT_CUT,
        bounds: levelBounds(s, l.h),
        keep: decision.levels[i].keep,
        ...(decision.levels[i].raison ? { raison: decision.levels[i].raison } : {}),
        ...(decision.levels[i].doute ? { doute: decision.levels[i].doute } : {})
    }));
    entries.push({
        id: 'avion',
        name: 'Vue d’avion',
        kind: 'avion',
        floor: ground,
        cut: null,
        bounds: levelBounds(s, null),
        keep: decision.aerial.keep,
        ...(decision.aerial.raison ? { raison: decision.aerial.raison } : {})
    });
    writeFileSync(levelsPath, `${JSON.stringify({ scene: scene.id, levels: entries }, null, 2)}\n`);

    const thumbs = {};
    for (const l of opts.thumbs ? entries : []) {
        const [e0, n0, e1, n1] = l.bounds;
        const px = Math.max(e1 - e0, n1 - n0) / THUMB_SIDE;
        const file = `${l.id}-vignette.webp`;
        const r = renderTop({ bounds: l.bounds, floor: l.floor, cut: l.cut, px, out: join(controlDir, file), lod: opts.lod + 2 });
        console.log(`vignette ${l.id} : ${r.width} × ${r.height} px en ${fmt(r.seconds, 1)} s`);
        thumbs[l.id] = file;
    }
    writeFileSync(proposePath, `${JSON.stringify({
        scene: scene.name ?? scene.id,
        projectArg: [relative(process.cwd(), projectPath), sceneArg].filter(Boolean).join(' '),
        lod: s.lod,
        splats: s.n,
        detection: { ...detection, histogram: undefined },
        rules: { ...DEFAULT_RULES, ...opts.rules },
        type: decision.type,
        typeImpose: opts.type !== 'auto',
        sides,
        thumbs
    }, null, 2)}\n`);
    writeFileSync(join(controlDir, 'histogramme.json'), `${JSON.stringify(detection.histogram)}\n`);
    writeControl();

    console.log('');
    for (const l of entries) {
        console.log(`  ${l.id.padEnd(6)} ${l.kind.padEnd(7)} ${fmt(l.floor).padStart(7)} m` +
            `${l.surface === undefined ? '' : `  ${fmt(l.surface, 1).padStart(8)} m², murs ${fmt(l.murs)}, couvert ${fmt(l.couvert)}`}` +
            `  ${l.keep ? 'gardé' : 'écarté'}${l.raison ? ` : ${l.raison}` : ''}${l.doute ? ` (à vérifier : ${l.doute})` : ''}`);
    }
    console.log(`scène ${opts.type === 'auto' ? 'jugée' : 'déclarée'} ${{ interieur: 'intérieure', exterieur: 'extérieure', mixte: 'mixte (niveaux et vue d’avion)' }[decision.type]}`);
    console.log(`\nproposé en ${fmt(seconds(t0), 1)} s. À relire : ${relative(process.cwd(), join(mapDir, 'controle.html'))}`);
    console.log(`puis éditer ${relative(process.cwd(), levelsPath)} et lancer l'étape build.`);
};

// --- étape « build » ------------------------------------------------------------

const writeMapBlock = (block) => {
    let out = null;
    try {
        out = spliceMapBlock(projectText, scene.id, block);
    } catch {
        out = null;
    }
    if (!out) {
        console.log(`\n${relative(process.cwd(), projectPath)} : bloc impossible à placer sans risque, à recopier à la main dans la scène « ${scene.id} » :`);
        console.log(`"map": ${JSON.stringify(block, null, 2)}`);
        return false;
    }
    writeFileSync(projectPath, out);
    return true;
};

const build = () => {
    if (!existsSync(levelsPath) || !existsSync(proposePath)) {
        fail(`pas de ${relative(process.cwd(), levelsPath)} : lancer d'abord l'étape propose`);
    }
    const t0 = Date.now();
    const levels = JSON.parse(readFileSync(levelsPath, 'utf-8'));
    const kept = levels.levels.filter(l => l.keep).sort((a, b) => (a.floor ?? 0) - (b.floor ?? 0));
    if (!kept.length) fail('aucun niveau gardé dans levels.json');
    const ids = new Set();
    for (const l of kept) {
        if (!/^[a-z0-9-]+$/i.test(l.id)) fail(`id « ${l.id} » : lettres, chiffres et tirets seulement`);
        if (ids.has(l.id)) fail(`id « ${l.id} » en double`);
        ids.add(l.id);
        if (!Number.isFinite(l.floor)) fail(`niveau ${l.id} : floor manquant`);
        if (l.rooms !== undefined && (!Array.isArray(l.rooms) || !l.rooms.every(r => typeof r?.name === 'string' && r.name.trim() &&
            Array.isArray(r.at) && r.at.length === 2 && r.at.every(Number.isFinite)))) {
            fail(`niveau ${l.id} : rooms attendu [{ "name": "Cuisine", "at": [E, N] }]`);
        }
        if (l.eye !== undefined && !(Number.isFinite(l.eye) && l.eye > 0)) fail(`niveau ${l.id} : eye attendu en m, > 0`);
        if (!Array.isArray(l.bounds) || l.bounds.length !== 4 || !(l.bounds[2] > l.bounds[0] && l.bounds[3] > l.bounds[1])) {
            fail(`niveau ${l.id} : bounds attendu [E0, N0, E1, N1]`);
        }
    }
    const s = loadSplats();
    const settingsPath = scene.settings ? resolve(projectDir, scene.settings) : null;
    const settings = settingsPath && existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf-8')) : {};
    const georeferenced = Number(settings.coordinates?.epsg) > 0;

    const results = [];
    const mapLevels = [];
    for (const l of kept) {
        const aerial = l.kind === 'avion' || l.cut === null;
        const cut = l.cut === undefined ? DEFAULT_CUT : l.cut;
        // pixel photo : 2 cm, ou plus pour tenir dans 1 600 px ; case des
        // murs = un nombre entier de pixels photo, cadre élargi en conséquence
        // pour que photo et murs couvrent exactement les mêmes bounds.
        const [b0, b1, b2, b3] = l.bounds;
        const px = Math.max(PHOTO_PX, Math.max(b2 - b0, b3 - b1) / MAX_SIDE);
        const k = Math.max(1, Math.round(WALL_CELL / px));
        const cols = Math.ceil((b2 - b0) / px / k) * k, rows = Math.ceil((b3 - b1) / px / k) * k;
        const ec = (b0 + b2) / 2, nc = (b1 + b3) / 2;
        const bounds = [ec - cols * px / 2, nc - rows * px / 2, ec + cols * px / 2, nc + rows * px / 2];
        const photo = join(mapDir, `${l.id}.webp`);
        const r = renderTop({ bounds, floor: l.floor, cut: aerial ? null : cut, px, out: photo, splats: s });
        const result = {
            id: l.id,
            name: l.name,
            width: r.width,
            height: r.height,
            px,
            seconds: r.seconds,
            tiles: r.tiles,
            split: r.split,
            photoFile: `${l.id}.webp`,
            photoBytes: readFileSync(photo).length
        };
        const entry = { id: l.id, name: l.name, floor: l.floor, bounds: bounds.map(v => round(v, 3)), photo: `./${relative(projectDir, photo)}` };
        if (!aerial) {
            const walls = join(mapDir, `${l.id}-murs.png`);
            result.wallArea = round(writeWalls(s, { bounds, floor: l.floor, cell: k * px, width: cols / k, height: rows / k, out: walls }), 1);
            result.wallsFile = `${l.id}-murs.png`;
            result.wallsBytes = readFileSync(walls).length;
            entry.walls = `./${relative(projectDir, walls)}`;
        }
        if (l.eye !== undefined) entry.eye = l.eye;
        if (l.rooms?.length) {
            entry.rooms = l.rooms.map(r => ({ name: r.name.trim(), at: [round(r.at[0]), round(r.at[1])] }));
            const outside = entry.rooms.filter(r => r.at[0] < bounds[0] || r.at[0] > bounds[2] || r.at[1] < bounds[1] || r.at[1] > bounds[3]);
            if (outside.length) console.log(`${l.id} : pièce(s) hors de l'emprise : ${outside.map(r => r.name).join(', ')}`);
        }
        result.check = checkRegistration(s, { bounds, floor: l.floor, cut: aerial ? null : cut, webp: photo });
        const check = `${result.check.ok ? 'recalage OK' : 'RECALAGE DOUTEUX'} (décalage E ${fmt(result.check.shiftE)} m, N ${fmt(result.check.shiftN)} m, corrélation ${fmt(result.check.score, 3)})`;
        console.log(`${l.id} : ${r.width} × ${r.height} px, photo ${fmt(result.photoBytes / 1024, 0)} Ko en ${fmt(r.seconds, 1)} s` +
            ` (${r.tiles} tuile${r.tiles > 1 ? 's' : ''}${r.split ? `, ${r.split} recoupée${r.split > 1 ? 's' : ''}` : ''})` +
            `${aerial ? '' : `, murs ${fmt(result.wallsBytes / 1024, 0)} Ko`} ; ${check}`);
        results.push(result);
        mapLevels.push(entry);
    }
    const block = { ...(georeferenced ? { north: 0 } : {}), levels: mapLevels };
    writeFileSync(buildPath, `${JSON.stringify({ date: new Date().toLocaleString('fr-FR'), levels: results, map: block }, null, 2)}\n`);
    writeControl();
    const written = writeMapBlock(block);
    const doubtful = results.filter(r => r.check.ok === false).map(r => r.id);
    console.log(`\nconstruit en ${fmt(seconds(t0), 1)} s${written ? `, bloc map écrit dans ${relative(process.cwd(), projectPath)}` : ''}.`);
    if (!georeferenced) console.log('scène non géoréférencée : "north" laissé absent (flèche du nord masquée).');
    if (doubtful.length) console.log(`ATTENTION recalage douteux : ${doubtful.join(', ')} (voir la planche).`);
    console.log(`planche : ${relative(process.cwd(), join(mapDir, 'controle.html'))}`);
};

if (step === 'propose') propose();
else build();
