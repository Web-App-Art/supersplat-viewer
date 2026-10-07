#!/usr/bin/env node
// ARTLIGHT (TKT-268)
//
// Prépare la carte navigable d'une scène : un fond de carte par niveau (vue de
// dessus des splats coupée au-dessus du sol + carte des murs), ou une vue
// d'avion pour un extérieur. Calculé une fois ici, lu par le visualisateur.
//
//   node scripts/scene-map.mjs propose <project.json> [id scène] [--lod n] [--force]
//   node scripts/scene-map.mjs build   <project.json> [id scène] [--lod n]
//
// 1. « propose » détecte les niveaux et écrit, dans le dossier map/ à côté du
//    project.json (map/<id scène>/ si le projet a plusieurs scènes) :
//    - levels.json : la liste éditable (id, name, floor, bounds, cut, keep) ;
//    - controle.html : vues de côté avec les niveaux et une vignette par niveau.
//    On relit la planche, on raye les faux niveaux (keep: false), on nomme les
//    vrais. Une vue d'avion est toujours proposée (gardée seulement si aucun
//    niveau n'est trouvé) : pour un extérieur, garder elle seule.
// 2. « build » rend, pour chaque entrée gardée, <id>.webp (photo vue de dessus)
//    et <id>-murs.png (carte des murs, sauf vue d'avion), contrôle le recalage
//    photo / murs, complète la planche et écrit le bloc « map » de la scène dans
//    project.json :
//      "map": { "north": 0, "levels": [ { "id", "name", "floor",
//               "bounds": [E0, N0, E1, N1], "photo", "walls" } ] }
//    bounds est dans le repère source (E, N) de coordinates.ts : un point du
//    moteur (x, y, z) tombe sur la carte en (−x, z). north vaut 0 (nord du
//    quadrillage en haut) pour une scène géoréférencée ; absent sinon.
//
// Les splats sont lus au LOD 1 (un .sog tel quel), exportés en PLY binaire par
// splat-transform (v3.10.0) dans un dossier temporaire. Le PLY est en (E, −H, N).
// PIÈGE : le filtre -B et le rendu .webp de splat-transform travaillent dans le
// repère du moteur, (−E, H, N). D'où la caméra en −E et la boîte en H positif.

import { execFileSync } from 'child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { deflateSync } from 'zlib';

// Splats retenus : opacité au-dessus de ce seuil.
const MIN_OPACITY = 0.3;

// Détection des niveaux (banc de l'audit, levels.py).
const GRID_CELL = 0.10;                 // case de la grille d'occupation 3D
const FREE_FROM = 0.2;                  // vide cherché de +0,2 m…
const FREE_TO = 1.0;                    // …à +1,0 m au-dessus d'un sol (au-dessous d'un plafond)
const HEIGHT_BIN = 0.05;                // tranches de hauteur de l'histogramme
const PEAK_MIN_AREA = 2.0;              // pic de surface : au moins 2 m²…
const PEAK_MIN_SHARE = 0.02;            // …et 2 % du plus grand
const DEDUCED_SLAB = 0.30;              // plafond sans sol au-dessus : sol déduit à +0,30 m
const GROUP_GAP = 1.0;                  // regroupement des candidats (marches, paliers)
const MIN_STOREY = 2.20;                // espacement minimal entre niveaux

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
const opts = { lod: 1, force: false };
const positional = [];
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--lod') opts.lod = Number(args[++i]);
    else if (a === '--force') opts.force = true;
    else if (a.startsWith('--')) fail(`option inconnue ${a}`);
    else positional.push(a);
}
const [step, projectArg, sceneArg] = positional;
if (!['propose', 'build'].includes(step) || !projectArg) {
    fail('usage : node scripts/scene-map.mjs propose|build <project.json> [id scène] [--lod n] [--force]');
}
if (!Number.isInteger(opts.lod) || opts.lod < 0) fail('--lod attend un entier positif');

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
        execFileSync('splat-transform', ['-q', '-w', ...list], { stdio: ['ignore', 'ignore', 'inherit'] });
    } catch (e) {
        fail(`splat-transform a échoué (${e.message.split('\n')[0]})`);
    }
};

// --- lecture des splats ----------------------------------------------------

// Lit les splats en (E, H, N) avec un drapeau « surface horizontale » :
// splat plat (plus petite échelle < 0,3 × la moyenne) dont la normale est
// verticale (|n_y| > 0,9). Seuls les splats d'opacité > 0,3 sont gardés.
const loadSplats = () => {
    const t0 = Date.now();
    const { args: lod, lod: lodLevel } = lodArgs();
    const dir = mkdtempSync(join(tmpdir(), 'scene-map-'));
    const ply = join(dir, 'splats.ply');
    try {
        splatTransform([...lod, contentPath, '-H', '0', ply]);
        const fd = openSync(ply, 'r');
        const head = Buffer.alloc(4096);
        readSync(fd, head, 0, head.length, 0);
        const headText = head.toString('latin1');
        const end = headText.indexOf('end_header\n');
        if (end < 0 || !headText.startsWith('ply')) fail('PLY illisible');
        const lines = headText.slice(0, end).split('\n');
        if (!lines.includes('format binary_little_endian 1.0')) fail('PLY attendu en binaire little-endian');
        const count = Number(lines.find(l => l.startsWith('element vertex')).split(' ')[2]);
        const props = lines.filter(l => l.startsWith('property ')).map((l) => {
            const [, type, name] = l.split(' ');
            if (type !== 'float') fail(`propriété ${name} en ${type}, float attendu`);
            return name;
        });
        const stride = props.length * 4;
        const at = (name) => {
            const i = props.indexOf(name);
            if (i < 0) fail(`propriété ${name} absente du PLY`);
            return i * 4;
        };
        const [ox, oy, oz] = ['x', 'y', 'z'].map(at);
        const [os0, os1, os2] = ['scale_0', 'scale_1', 'scale_2'].map(at);
        const [ow, oqx, oqy, oqz] = ['rot_0', 'rot_1', 'rot_2', 'rot_3'].map(at);
        const oop = at('opacity');
        const minLogit = Math.log(MIN_OPACITY / (1 - MIN_OPACITY));

        const E = new Float32Array(count);
        const H = new Float32Array(count);
        const N = new Float32Array(count);
        const horizontal = new Uint8Array(count);
        let n = 0;
        const chunkCount = 1 << 18;
        const buf = Buffer.alloc(chunkCount * stride);
        let pos = end + 'end_header\n'.length;
        for (let done = 0; done < count;) {
            const k = Math.min(chunkCount, count - done);
            readSync(fd, buf, 0, k * stride, pos);
            pos += k * stride;
            done += k;
            for (let i = 0; i < k; i++) {
                const b = i * stride;
                if (!(buf.readFloatLE(b + oop) > minLogit)) continue;
                const x = buf.readFloatLE(b + ox), y = buf.readFloatLE(b + oy), z = buf.readFloatLE(b + oz);
                if (!Number.isFinite(x + y + z)) continue;
                E[n] = x;
                H[n] = -y;
                N[n] = z;
                // échelles en log : comparer les log revient à comparer les échelles
                const s0 = buf.readFloatLE(b + os0), s1 = buf.readFloatLE(b + os1), s2 = buf.readFloatLE(b + os2);
                const kmin = s0 <= s1 ? (s0 <= s2 ? 0 : 2) : (s1 <= s2 ? 1 : 2);
                const smin = Math.min(s0, s1, s2);
                const smid = s0 + s1 + s2 - smin - Math.max(s0, s1, s2);
                if (smin < smid + Math.log(0.3)) {
                    let w = buf.readFloatLE(b + ow), qx = buf.readFloatLE(b + oqx);
                    let qy = buf.readFloatLE(b + oqy), qz = buf.readFloatLE(b + oqz);
                    const qn = Math.hypot(w, qx, qy, qz) + 1e-12;
                    w /= qn; qx /= qn; qy /= qn; qz /= qn;
                    // composante y de la colonne kmin de la matrice de rotation
                    const ny = kmin === 0 ? 2 * (qx * qy + w * qz) :
                        kmin === 1 ? 1 - 2 * (qx * qx + qz * qz) :
                            2 * (qy * qz - w * qx);
                    if (Math.abs(ny) > 0.9) horizontal[n] = 1;
                }
                n++;
            }
        }
        closeSync(fd);
        console.log(`${n.toLocaleString('fr-FR')} splats lus sur ${count.toLocaleString('fr-FR')}${lodLevel === null ? '' : ` (LOD ${lodLevel})`} en ${fmt(seconds(t0), 1)} s`);
        return { E: E.subarray(0, n), H: H.subarray(0, n), N: N.subarray(0, n), horizontal: horizontal.subarray(0, n), n, lod: lodLevel, total: count };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

// Percentiles approchés sur un échantillon régulier (≤ 2 M valeurs).
const percentiles = (values, ps, mask) => {
    const step = Math.max(1, Math.floor(values.length / 2e6));
    const sample = [];
    for (let i = 0; i < values.length; i += step) {
        if (!mask || mask(i)) sample.push(values[i]);
    }
    if (!sample.length) return ps.map(() => NaN);
    const sorted = Float32Array.from(sample).sort();
    return ps.map(p => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p / 100 * (sorted.length - 1))))]);
};

// --- détection des niveaux -------------------------------------------------

// Port de levels.py. Un sol est une surface horizontale avec du vide de +0,2 à
// +1,0 m au-dessus ; un plafond, avec du vide au-dessous. Les pics de surface
// par tranche de 5 cm donnent les candidats ; un plafond sans sol juste
// au-dessus (dalle vue seulement par en dessous) donne un sol déduit à +0,30 m.
const detectLevels = (s) => {
    const t0 = Date.now();
    const [e0, e1] = percentiles(s.E, [0.1, 99.9]);
    const [n0, n1] = percentiles(s.N, [0.1, 99.9]);
    const [h0, h1] = percentiles(s.H, [0.1, 99.9]);
    const cell = GRID_CELL;
    const dx = Math.ceil((e1 - e0) / cell) + 1, dy = Math.ceil((n1 - n0) / cell) + 1, dz = Math.ceil((h1 - h0) / cell) + 1;
    const bits = dx * dy * dz;
    if (bits > 8e9) fail(`emprise trop grande pour la grille (${dx} × ${dy} × ${dz} cases)`);
    const occupied = new Uint8Array(Math.ceil(bits / 8));
    const inside = i => s.E[i] >= e0 && s.E[i] <= e1 && s.N[i] >= n0 && s.N[i] <= n1 && s.H[i] >= h0 && s.H[i] <= h1;
    const cellOf = i => [Math.floor((s.E[i] - e0) / cell), Math.floor((s.N[i] - n0) / cell), Math.floor((s.H[i] - h0) / cell)];
    for (let i = 0; i < s.n; i++) {
        if (!inside(i)) continue;
        const [ix, iy, iz] = cellOf(i);
        const idx = (ix * dy + iy) * dz + iz;
        occupied[Math.floor(idx / 8)] |= 1 << (idx % 8);
    }
    const isOccupied = (column, iz) => {
        if (iz < 0 || iz >= dz) return 0;
        const idx = column + iz;
        return (occupied[Math.floor(idx / 8)] >> (idx % 8)) & 1;
    };
    const a0 = Math.round(FREE_FROM / cell), a1 = Math.round(FREE_TO / cell);
    const bins = Math.floor((h1 - h0) / HEIGHT_BIN) + 2;
    const floorCells = new Set(), ceilingCells = new Set();
    let horizontalCount = 0;
    for (let i = 0; i < s.n; i++) {
        if (!s.horizontal[i] || !inside(i)) continue;
        horizontalCount++;
        const [ix, iy, iz] = cellOf(i);
        const column = (ix * dy + iy) * dz;
        let above = 0, below = 0;
        for (let k = a0; k <= a1; k++) {
            above += isOccupied(column, iz + k);
            below += isOccupied(column, iz - k);
        }
        const key = (ix * dy + iy) * bins + Math.floor((s.H[i] - h0) / HEIGHT_BIN);
        if (above <= 1) floorCells.add(key);
        else if (below <= 1) ceilingCells.add(key);
    }
    const histogram = (set) => {
        const v = new Float64Array(bins);
        for (const key of set) v[key % bins] += cell * cell;
        return Array.from(v);
    };
    const fa = histogram(floorCells), ca = histogram(ceilingCells);
    const center = i => h0 + (i + 0.5) * HEIGHT_BIN;
    const around = (v, i) => v.slice(Math.max(0, i - 2), i + 3).reduce((a, b) => a + b, 0);
    // pics : maxima locaux à ± 25 cm, au-dessus du seuil
    const peaks = (v) => {
        const out = [];
        const threshold = Math.max(PEAK_MIN_AREA, PEAK_MIN_SHARE * Math.max(...v));
        for (let i = 0; i < v.length; i++) {
            if (v[i] < threshold) continue;
            const local = Math.max(...v.slice(Math.max(0, i - 5), Math.min(v.length, i + 6)));
            if (v[i] === local && !(out.length && i - out[out.length - 1] <= 5)) out.push(i);
        }
        return out;
    };
    const fp = peaks(fa), cp = peaks(ca);
    const candidates = fp.map(i => ({ h: center(i), area: around(fa, i), kind: 'sol' }));
    for (const i of cp) {
        const hc = center(i);
        if (!candidates.some(c => c.h - hc >= 0 && c.h - hc <= 0.7)) {
            candidates.push({ h: hc + DEDUCED_SLAB, area: around(ca, i), kind: 'déduit' });
        }
    }
    candidates.sort((a, b) => a.h - b.h);
    const groups = [];
    for (const c of candidates) {
        const last = groups[groups.length - 1];
        if (last && c.h - last[last.length - 1].h < GROUP_GAP) last.push(c);
        else groups.push([c]);
    }
    let levels = groups.map((g) => {
        const best = g.reduce((a, b) => (((b.kind === 'sol') - (a.kind === 'sol') || b.area - a.area) > 0 ? b : a));
        return { h: round(best.h), area: round(g.reduce((t, c) => t + c.area, 0), 1), kind: best.kind };
    });
    const kept = [];
    for (const l of [...levels].sort((a, b) => b.area - a.area)) {
        if (kept.every(k => Math.abs(l.h - k.h) >= MIN_STOREY)) kept.push(l);
    }
    levels = kept.sort((a, b) => a.h - b.h);
    const totalFloor = fa.reduce((a, b) => a + b, 0), totalCeiling = ca.reduce((a, b) => a + b, 0);
    console.log(`détection : ${horizontalCount.toLocaleString('fr-FR')} splats horizontaux, ${levels.length} niveau(x) en ${fmt(seconds(t0), 1)} s`);
    return {
        box: { E: [e0, e1], N: [n0, n1], H: [h0, h1] },
        floors: fp.map(i => ({ h: round(center(i)), area: round(around(fa, i), 1) })),
        ceilings: cp.map(i => ({ h: round(center(i)), area: round(around(ca, i), 1) })),
        levels,
        floorArea: round(totalFloor, 1),
        ceilingArea: round(totalCeiling, 1),
        histogram: { h0, bin: HEIGHT_BIN, floor: fa.map(v => round(v, 2)), ceiling: ca.map(v => round(v, 2)) },
        seconds: round(seconds(t0), 1)
    };
};

// Emprise E/N d'un niveau : percentiles 0,5 / 99,5 des splats de sa bande
// (sol + 0,3 à sol + 2,0), plus 1 m de marge. Vue d'avion : tous les splats.
const levelBounds = (s, floor) => {
    const mask = floor === null ? null : i => s.H[i] > floor + WALL_FROM && s.H[i] < floor + WALL_TO;
    const [e0, e1] = percentiles(s.E, [0.5, 99.5], mask);
    const [n0, n1] = percentiles(s.N, [0.5, 99.5], mask);
    return [round(e0 - MARGIN, 1), round(n0 - MARGIN, 1), round(e1 + MARGIN, 1), round(n1 + MARGIN, 1)];
};

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
        `<td class="n">${l.area === undefined ? '' : fmt(l.area, 1)}</td><td class="n">${l.cut === null ? 'aucune' : `+${fmt(l.cut)}`}</td>` +
        `<td class="n">${l.bounds.map(v => fmt(v, 1)).join(' ; ')}</td><td>${l.keep ? 'gardé' : 'écarté'}</td></tr>`).join('');

    const thumbs = entries.map((l) => {
        const thumb = proposal.thumbs[l.id];
        return `<figure class="thumb ${l.keep ? 'keep' : 'drop'}">${thumb ? `<img src="controle/${thumb}" alt="">` : '<div class="none">pas de vignette (entrée ajoutée à la main)</div>'}` +
            `<figcaption><b>${escapeHtml(l.id)}</b> ${escapeHtml(l.name)} — ${l.floor === null ? '' : `sol ${fmt(l.floor)} m, `}${l.keep ? 'gardé' : 'écarté'}</figcaption></figure>`;
    }).join('');

    const maps = built ? built.levels.map((b) => {
        const check = `${b.check.ok ? 'recalage OK' : '<b class="bad">RECALAGE DOUTEUX</b>'} : meilleur décalage E ${fmt(b.check.shiftE)} m, N ${fmt(b.check.shiftN)} m ` +
            `(corrélation ${fmt(b.check.score, 3)} sans décalage, ${fmt(b.check.best, 3)} au mieux, case ${fmt(b.check.cell * 100, 0)} cm)`;
        return `<section class="map"><h3>${escapeHtml(b.id)} — ${escapeHtml(b.name)}</h3>` +
            `<div class="stack" style="aspect-ratio:${b.width} / ${b.height}; width:min(100%, calc(85vh * ${b.width} / ${b.height}))"><img src="${escapeHtml(b.photoFile)}" alt="">${b.wallsFile ? `<img class="walls" src="${escapeHtml(b.wallsFile)}" alt="">` : ''}</div>` +
            `<p>${b.width} × ${b.height} px (${fmt(b.px * 100, 1)} cm/px), photo ${fmt(b.photoBytes / 1024, 0)} Ko en ${fmt(b.seconds, 1)} s, ${b.tiles} tuile(s)` +
            `${b.wallsFile ? `, murs ${fmt(b.wallsBytes / 1024, 0)} Ko` : ''}. ${check}.</p></section>`;
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
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; } td.n { text-align: right; font-variant-numeric: tabular-nums; }
tr.drop td { color: var(--muted); text-decoration: line-through; } tr.drop td:last-child { text-decoration: none; color: var(--drop); } tr.keep td:last-child { color: var(--keep); }
.thumbs { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
.thumb.drop img { opacity: .45; } .thumb .none { padding: 24px; border: 1px dashed var(--line); }
.stack { position: relative; max-width: 100%; background: #fff; border: 1px solid var(--line); }
.stack img { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: none; }
.stack img.walls { opacity: var(--walls, 1); filter: brightness(0) invert(13%) sepia(97%) saturate(7400%) hue-rotate(4deg); } .bad { color: var(--drop); }
label { color: var(--muted); }
</style></head><body><main>
<h1>Carte de la scène « ${escapeHtml(proposal.scene)} »</h1>
<p>${proposal.splats.toLocaleString('fr-FR')} splats lus${proposal.lod === null ? '' : ` au LOD ${proposal.lod}`}. Détection en ${fmt(proposal.detection.seconds, 1)} s :
surfaces de sol ${fmt(proposal.detection.floorArea, 0)} m², de plafond ${fmt(proposal.detection.ceilingArea, 0)} m².
${built ? `Cartes construites le ${escapeHtml(built.date)}.` : 'Cartes pas encore construites.'}</p>
<p>À faire : relire les vues de côté et les vignettes, puis éditer <code>levels.json</code> (<code>keep</code> à <code>false</code> pour un faux niveau,
<code>name</code> pour les vrais, <code>floor</code>, <code>bounds</code> [E0, N0, E1, N1] ou <code>cut</code> si besoin) et lancer
<code>node scripts/scene-map.mjs build ${escapeHtml(proposal.projectArg)}</code>.</p>
<h2>Niveaux</h2>
<div class="table"><table><thead><tr><th>id</th><th>nom</th><th>origine</th><th>sol (m)</th><th>surface (m²)</th><th>coupe</th><th>emprise E0 ; N0 ; E1 ; N1</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>Vues de côté</h2>
<p>Densité des splats, sombre = dense. Vert : niveau gardé ; rouge pointillé : écarté.</p>
<div class="sides">${proposal.sides.map(side).join('')}</div>
<h2>Vignettes (vue de dessus, sol − 0,2 à sol + coupe, nord en haut)</h2>
<div class="thumbs">${thumbs}</div>
${built ? `<h2>Cartes</h2><p><label><input type="checkbox" checked onchange="document.body.style.setProperty('--walls', this.checked ? 1 : 0)"> murs (en rouge sur la planche) par-dessus la photo</label></p>${maps}` : ''}
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
    const detection = detectLevels(s);
    const sides = writeSideViews(s);

    // Sol de la vue d'avion : le plus grand sol détecté, sinon le bas du nuage.
    const ground = detection.floors.length ?
        detection.floors.reduce((a, b) => (b.area > a.area ? b : a)).h :
        round(percentiles(s.H, [2])[0]);
    const entries = detection.levels.map((l, i) => ({
        id: `n${i + 1}`,
        name: `Niveau ${i + 1}`,
        kind: l.kind,
        floor: l.h,
        area: l.area,
        cut: DEFAULT_CUT,
        bounds: levelBounds(s, l.h),
        keep: true
    }));
    entries.push({
        id: 'avion',
        name: 'Vue d’avion',
        kind: 'avion',
        floor: ground,
        cut: null,
        bounds: levelBounds(s, null),
        keep: entries.length === 0
    });
    writeFileSync(levelsPath, `${JSON.stringify({ scene: scene.id, levels: entries }, null, 2)}\n`);

    const thumbs = {};
    for (const l of entries) {
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
        sides,
        thumbs
    }, null, 2)}\n`);
    writeFileSync(join(controlDir, 'histogramme.json'), `${JSON.stringify(detection.histogram)}\n`);
    writeControl();

    console.log('');
    for (const l of entries) {
        console.log(`  ${l.id.padEnd(6)} ${l.kind.padEnd(7)} ${fmt(l.floor).padStart(7)} m` +
            `${l.area === undefined ? '' : `  ${fmt(l.area, 1).padStart(8)} m²`}  ${l.keep ? 'gardé' : 'écarté'}`);
    }
    console.log(`\nproposé en ${fmt(seconds(t0), 1)} s. À relire : ${relative(process.cwd(), join(mapDir, 'controle.html'))}`);
    console.log(`puis éditer ${relative(process.cwd(), levelsPath)} et lancer l'étape build.`);
};

// --- étape « build » ------------------------------------------------------------

// Écrit le bloc « map » dans la scène sans toucher au reste du fichier : le
// project.json est réécrit seulement s'il a la forme JSON.stringify(…, 2),
// blocs « map » compris (un niveau par ligne).
const formatProject = (obj) => {
    const blocks = [];
    const copy = structuredClone(obj);
    for (const sc of copy.scenes) {
        if (sc.map !== undefined) {
            blocks.push(sc.map);
            sc.map = `__MAP_${blocks.length - 1}__`;
        }
    }
    return JSON.stringify(copy, null, 2).replace(/( *)"map": "__MAP_(\d+)__"/g, (_, indent, i) => {
        const block = blocks[Number(i)];
        const value = v => (Array.isArray(v) ? `[${v.map(x => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v));
        const line = l => `${indent}    {${Object.entries(l).map(([k, v]) => `${JSON.stringify(k)}: ${value(v)}`).join(', ')}}`;
        return `${indent}"map": {\n${block.north === undefined ? '' : `${indent}  "north": ${block.north},\n`}` +
            `${indent}  "levels": [\n${(block.levels ?? []).map(line).join(',\n')}\n${indent}  ]\n${indent}}`;
    });
};

const writeMapBlock = (block) => {
    const original = JSON.parse(projectText);
    if (formatProject(original) !== projectText.trim()) {
        console.log(`\n${relative(process.cwd(), projectPath)} n'a pas la forme attendue : bloc à recopier à la main dans la scène « ${scene.id} » :`);
        console.log(`"map": ${JSON.stringify(block, null, 2)}`);
        return false;
    }
    original.scenes.find(x => x.id === scene.id).map = block;
    writeFileSync(projectPath, `${formatProject(original)}\n`);
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
