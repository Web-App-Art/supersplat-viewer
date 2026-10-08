#!/usr/bin/env node
// ARTLIGHT (TKT-272, lot 2)
//
// Prépare le volume du bâtiment d'une scène à deux modèles (bloc `interior`
// du project.json, voir src/interior.ts) : une union de prismes
// { outline: [[E, N], …], floor, top } tirée des cartes de la scène et de la
// collision extérieure, et une planche de contrôle.
//
//   node scripts/interior-volume.mjs <project.json> [id scène] [--write] [--force]
//
// Au premier lancement, écrit volume/volume.json (volume/<id scène>/ si le
// projet a plusieurs scènes), réglages éditables :
//   - levels : niveaux de la carte marqués `interior` qui ont une carte des
//     murs (id, floor, walls, bounds ; use: false pour en écarter un) ;
//   - close : demi-largeur des ouvertures refermées (portes, fenêtres) ;
//   - wallAlpha : opacité de la carte des murs à partir de laquelle une case
//     est un mur ; minRoom : surface libre minimale d'une emprise gardée ;
//   - within : cadre de calcul [E0, N0, E1, N1] (par défaut celui de la
//     collision intérieure) ;
//   - roof : collision lue pour les toits, pas des paliers de hauteur ;
//   - include / exclude : polygones [[E, N], …] ajoutés à / retirés de
//     l'emprise (champ facultatif "levels": ["n1"] pour les limiter) ;
//   - tops : hauteurs de toit imposées, [{ "outline": [[E, N], …], "top": H }] ;
//   - trajectory : trajectoire du scanner (poses.json d'un LCC), pour
//     repérer les passages réels.
// Puis, à chaque lancement : calcul du volume, planche volume/controle.html
// (contours sur les vues de dessus, carte des toits, une coupe verticale par
// façade) et, avec --write, écriture du volume dans le project.json.
//
// Méthode :
// 1. toits : dans la collision extérieure, dessus du premier voxel plein vu
//    du ciel, médiane 5 × 5 contre les flotteurs ; une case est « lisse » si
//    ce dessus y est plan (toit) plutôt que feuillu (arbre) ;
// 2. emprise par niveau : la carte des murs (scene-map.mjs) est rééchantillonnée
//    sur une grille de 5 cm ; l'extérieur est ce qu'atteint un disque de
//    rayon `close` parti du bord du cadre (il ne passe pas par une ouverture
//    plus étroite que 2 × close) ; le reste, murs compris, est dedans s'il est
//    sous un toit lisse à au moins HEADROOM du sol (pas une terrasse, ni un
//    massif sous un arbre). Seules les emprises qui ont au moins `minRoom` m²
//    libres sont gardées (une haie dense est enclose mais pleine) ;
// 3. une partie d'un niveau sans étage au-dessus (aile) doit avoir un toit
//    bas : sous un feuillage plus haut, on cherche ce toit bas, sinon la
//    partie est retirée (cime d'arbre au-dessus d'une terrasse) ; puis
//    ouverture morphologique contre les franges ;
// 4. tranches horizontales entre les sols des niveaux et des paliers de toit
//    tous les `roof.step` mètres ; une tranche [a, b] couvre l'emprise du
//    niveau qui possède la hauteur a (dernier niveau : plus celle de l'étage
//    du dessous, pour les lucarnes et le pied des rampants), là où le toit
//    dépasse b à un demi-palier près. Les tranches presque identiques qui se
//    suivent sont fusionnées, chaque morceau d'une tranche devient un prisme
//    (contour simplifié, trous bouchés). Le volume reste sous le toit : une
//    caméra au-dessus du toit est toujours dehors.
//
// Ce qu'aucune règle ne tranche (massifs taillés en bord de façade, par
// exemple) se corrige par `exclude` / `include` / `tops`, en relisant la
// planche : chaque bascule de la trajectoire du scanner doit tomber sur une
// porte ou une fenêtre.
//
// Repères : (E, N) comme les bounds de la carte ; un point du moteur (x, y, z)
// est en (E, N, H) = (−x, z, y). Le rendu de splat-transform (coupes) se fait
// dans le repère du moteur.

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { deflateSync, inflateSync } from 'zlib';

const CELL = 0.05;                      // grille de calcul
const ROOF_MEDIAN = 2;                  // médiane (2·2+1)² sur la grille de la collision
const ROUGH_WINDOW = 3;                 // rugosité du toit : médiane sur 7 × 7 cases de la collision
const ROUGH_MAX = 0.15;                 // au-delà : arbre, pas toit (toit ≤ 0,08 à 95 %)
const ROUGH_GROW = 0.3;                 // toit lisse élargi de 30 cm (bord du débord, rugueux)
const LOW_ROOF = 1.5;                   // toit d'une partie sans étage : au plus 1,5 m au-dessus du sol de l'étage
const ABOVE_MARGIN = 0.5;               // étage au-dessus : à 50 cm près (emprise réduite sous un rampant)
const OPEN_RADIUS = 0.3;                // franges de moins de 60 cm retirées
const HEADROOM = 2.0;                   // toit à au moins 2 m du sol pour être dedans
const MERGE_AREA = 0.75;                // tranches fusionnées si elles diffèrent de moins de 0,75 m²…
const MERGE_SHARE = 0.01;               // …ou 1 % de la surface (lucarnes : ~0,5 m² chacune)
const MIN_PRISM = 1.0;                  // morceaux de tranche plus petits : écartés
const EYE = 1.5;                        // hauteur des yeux pour la vue de dessus
const SECTION_DEPTH = 3.0;              // coupe : de 1 m dehors à 3 m dans le bâtiment
const SECTION_PX = 0.025;               // 2,5 cm par pixel…
const SECTION_MAX = 1400;               // …côté plafonné
const CAMERA_DISTANCE = 2000;           // caméra quasi orthographique
const HYSTERESIS = 0.1;                 // comme src/interior.ts
const POSE_STEP = 0.5;                  // trajectoire : une pose par demi-seconde

const DEFAULTS = {
    close: 0.75,
    wallAlpha: 0.75,
    minRoom: 3,
    below: 0.5,
    simplify: 0.1,
    roof: { step: 0.5 }
};

const fail = (message) => {
    console.error(`interior-volume : ${message}`);
    process.exit(1);
};

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

const fmt = (v, d = 2) => v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });

// --- arguments ---------------------------------------------------------------

const args = process.argv.slice(2);
const opts = { write: false, force: false };
const positional = [];
for (const a of args) {
    if (a === '--write') opts.write = true;
    else if (a === '--force') opts.force = true;
    else if (a.startsWith('--')) fail(`option inconnue ${a}`);
    else positional.push(a);
}
const [projectArg, sceneArg] = positional;
if (!projectArg) fail('usage : node scripts/interior-volume.mjs <project.json> [id scène] [--write] [--force]');

const projectPath = resolve(projectArg);
const projectDir = dirname(projectPath);
const projectText = readFileSync(projectPath, 'utf-8');
const project = JSON.parse(projectText);
const scenes = project.scenes ?? [];
const scene = sceneArg ? scenes.find(s => s.id === sceneArg) : scenes.length === 1 ? scenes[0] : null;
if (!scene) {
    fail(sceneArg ? `scène « ${sceneArg} » absente du projet` : `préciser la scène : ${scenes.map(s => s.id).join(', ')}`);
}
if (!scene.interior) fail(`la scène « ${scene.id} » n'a pas de bloc interior (content, collision)`);

const volumeDir = scenes.length > 1 ? join(projectDir, 'volume', scene.id) : join(projectDir, 'volume');
const controlDir = join(volumeDir, 'controle');
const configPath = join(volumeDir, 'volume.json');
const fromProject = p => resolve(projectDir, p);
const relProject = p => `./${relative(projectDir, p)}`;

// --- outils ------------------------------------------------------------------

const run = (cmd, list) => {
    try {
        execFileSync(cmd, list, { stdio: ['ignore', 'ignore', 'inherit'] });
    } catch (e) {
        fail(e.code === 'ENOENT' ? `${cmd} introuvable` : `${cmd} a échoué (${e.message.split('\n')[0]})`);
    }
};

// PNG 8 bits (gris, gris + alpha, RVB, RVBA), filtres compris.
const readPng = (path) => {
    const data = readFileSync(path);
    let pos = 8, width = 0, height = 0, type = 0;
    const idat = [];
    while (pos < data.length) {
        const len = data.readUInt32BE(pos);
        const tag = data.toString('latin1', pos + 4, pos + 8);
        const body = data.subarray(pos + 8, pos + 8 + len);
        if (tag === 'IHDR') {
            width = body.readUInt32BE(0);
            height = body.readUInt32BE(4);
            if (body[8] !== 8 || body[12] !== 0) fail(`${path} : PNG 8 bits non entrelacé attendu`);
            type = body[9];
        } else if (tag === 'IDAT') idat.push(body);
        pos += 12 + len;
    }
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
    if (!channels) fail(`${path} : type de PNG ${type} non lu`);
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    const out = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
        const f = raw[y * (stride + 1)];
        const src = y * (stride + 1) + 1, dst = y * stride;
        for (let x = 0; x < stride; x++) {
            const a = x >= channels ? out[dst + x - channels] : 0;
            const b = y > 0 ? out[dst - stride + x] : 0;
            const c = x >= channels && y > 0 ? out[dst - stride + x - channels] : 0;
            let p = raw[src + x];
            if (f === 1) p += a;
            else if (f === 2) p += b;
            else if (f === 3) p += (a + b) >> 1;
            else if (f === 4) {
                const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
                p += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
            }
            out[dst + x] = p & 0xff;
        }
    }
    // opacité : canal alpha s'il y en a un, sinon 255 − gris (sombre = mur)
    const alpha = new Uint8Array(width * height);
    for (let i = 0; i < alpha.length; i++) {
        alpha[i] = channels === 2 || channels === 4 ? out[i * channels + channels - 1] : 255 - out[i * channels];
    }
    return { width, height, alpha };
};

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

// Encodeur PNG RVBA minimal (comme scene-map.mjs).
const writePngRgba = (path, width, height, rgba) => {
    const chunk = (type, body) => {
        const out = Buffer.alloc(12 + body.length);
        out.writeUInt32BE(body.length, 0);
        out.write(type, 4, 'latin1');
        body.copy(out, 8);
        out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
        return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
    }
    writeFileSync(path, Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]));
};

// --- collision voxel (même lecture que src/collision/voxel-collision.ts) -----

const loadVoxel = (jsonPath) => {
    const meta = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    if (!meta.version || parseFloat(meta.version) < 1.1) fail(`${jsonPath} : collision v1.0 non lue (refaire avec splat-transform ≥ 3.10)`);
    const buf = readFileSync(jsonPath.replace('.voxel.json', '.voxel.bin'));
    const view = new Uint32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const nodes = view.subarray(0, meta.nodeCount);
    const leaf = view.subarray(meta.nodeCount, meta.nodeCount + meta.leafDataCount);
    const res = meta.voxelResolution, min = meta.gridBounds.min;
    const n = [0, 1, 2].map(a => Math.round((meta.gridBounds.max[a] - min[a]) / res));
    const popcount = (v) => {
        v >>>= 0;
        v -= (v >>> 1) & 0x55555555;
        v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
        return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
    };
    const leafBit = (node, ix, iy, iz) => {
        const li = node & 0xffffff, bit = (iz & 3) * 16 + (iy & 3) * 4 + (ix & 3);
        return bit < 32 ? ((leaf[li * 2] >>> bit) & 1) === 1 : ((leaf[li * 2 + 1] >>> (bit - 32)) & 1) === 1;
    };
    const solid = (ix, iy, iz) => {
        if (ix < 0 || iy < 0 || iz < 0 || ix >= n[0] || iy >= n[1] || iz >= n[2]) return false;
        const bx = ix >> 2, by = iy >> 2, bz = iz >> 2;
        let ni = 0;
        for (let level = meta.treeDepth - 1; level >= 0; level--) {
            const node = nodes[ni] >>> 0;
            if (node === 0xff000000) return true;
            const mask = (node >>> 24) & 0xff;
            if (mask === 0) return leafBit(node, ix, iy, iz);
            const octant = (((bz >>> level) & 1) << 2) | (((by >>> level) & 1) << 1) | ((bx >>> level) & 1);
            if (!(mask & (1 << octant))) return false;
            ni = (node & 0xffffff) + popcount(mask & ((1 << octant) - 1));
        }
        const node = nodes[ni] >>> 0;
        return node === 0xff000000 || leafBit(node, ix, iy, iz);
    };
    return { meta, res, min, n, solid };
};

// --- grilles -----------------------------------------------------------------

// Transformée de distance euclidienne exacte (Felzenszwalb), en cases, à
// partir des cases `source` ; renvoie la distance au carré.
const distanceSquared = (source, w, h) => {
    const INF = 1e20;
    const d = new Float64Array(w * h);
    for (let i = 0; i < d.length; i++) d[i] = source[i] ? 0 : INF;
    const n = Math.max(w, h);
    const f = new Float64Array(n), out = new Float64Array(n), z = new Float64Array(n + 1);
    const v = new Int32Array(n);
    const pass = (len) => {
        let k = 0;
        v[0] = 0; z[0] = -INF; z[1] = INF;
        for (let q = 1; q < len; q++) {
            let s;
            for (;;) {
                const p = v[k];
                s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
                if (s <= z[k] && k > 0) k--;
                else break;
            }
            if (s <= z[k]) {
                v[0] = q; z[0] = -INF; z[1] = INF; k = 0;
            } else {
                k++; v[k] = q; z[k] = s; z[k + 1] = INF;
            }
        }
        k = 0;
        for (let q = 0; q < len; q++) {
            while (z[k + 1] < q) k++;
            out[q] = (q - v[k]) ** 2 + f[v[k]];
        }
    };
    for (let x = 0; x < w; x++) {
        for (let y = 0; y < h; y++) f[y] = d[y * w + x];
        pass(h);
        for (let y = 0; y < h; y++) d[y * w + x] = out[y];
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) f[x] = d[y * w + x];
        pass(w);
        for (let x = 0; x < w; x++) d[y * w + x] = out[x];
    }
    return d;
};

// Composantes 4-connexes d'un masque : étiquettes (0 = hors masque) et tailles.
const components = (mask, w, h) => {
    const label = new Int32Array(w * h);
    const sizes = [0];
    const stack = [];
    for (let i = 0; i < mask.length; i++) {
        if (!mask[i] || label[i]) continue;
        const id = sizes.length;
        let size = 0;
        label[i] = id;
        stack.push(i);
        while (stack.length) {
            const c = stack.pop();
            size++;
            const x = c % w, y = (c - x) / w;
            for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                const j = ny * w + nx;
                if (mask[j] && !label[j]) {
                    label[j] = id;
                    stack.push(j);
                }
            }
        }
        sizes.push(size);
    }
    return { label, sizes };
};

// Bouche les trous d'un masque : ce que le bord n'atteint pas (4-connexe).
const fillHoles = (mask, w, h) => {
    const outside = new Uint8Array(w * h);
    const stack = [];
    const seed = (i) => {
        if (!mask[i] && !outside[i]) {
            outside[i] = 1;
            stack.push(i);
        }
    };
    for (let x = 0; x < w; x++) {
        seed(x); seed((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
        seed(y * w); seed(y * w + w - 1);
    }
    while (stack.length) {
        const c = stack.pop();
        const x = c % w, y = (c - x) / w;
        if (x > 0) seed(c - 1);
        if (x < w - 1) seed(c + 1);
        if (y > 0) seed(c - w);
        if (y < h - 1) seed(c + w);
    }
    const out = new Uint8Array(w * h);
    let filled = 0;
    for (let i = 0; i < out.length; i++) {
        out[i] = outside[i] ? 0 : 1;
        if (out[i] && !mask[i]) filled++;
    }
    return { mask: out, filled };
};

// Point dans un polygone (règle pair-impair).
const insidePolygon = (poly, e, n) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [ax, ay] = poly[j], [bx, by] = poly[i];
        if ((by > n) !== (ay > n) && e < ax + (n - ay) * (bx - ax) / (by - ay)) inside = !inside;
    }
    return inside;
};

// Polygone découpé par la bande lo ≤ v[axis] ≤ hi (Sutherland-Hodgman).
const clipBand = (poly, axis, lo, hi) => {
    const clip = (pts, keep, cross) => {
        const out = [];
        for (let i = 0; i < pts.length; i++) {
            const a = pts[(i + pts.length - 1) % pts.length], b = pts[i];
            if (keep(b)) {
                if (!keep(a)) out.push(cross(a, b));
                out.push(b);
            } else if (keep(a)) out.push(cross(a, b));
        }
        return out;
    };
    const at = limit => (a, b) => {
        const t = (limit - a[axis]) / (b[axis] - a[axis]);
        return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    };
    return clip(clip(poly, v => v[axis] >= lo, at(lo)), v => v[axis] <= hi, at(hi));
};

const polygonArea = (poly) => {
    let a = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
    return a / 2;
};

// Douglas-Peucker sur une boucle fermée.
const simplifyLoop = (pts, tol) => {
    if (pts.length <= 4) return pts;
    const dp = (list) => {
        const keep = new Uint8Array(list.length);
        keep[0] = keep[list.length - 1] = 1;
        const stack = [[0, list.length - 1]];
        while (stack.length) {
            const [i0, i1] = stack.pop();
            const [ax, ay] = list[i0], [bx, by] = list[i1];
            const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
            let best = -1, at = -1;
            for (let i = i0 + 1; i < i1; i++) {
                const d = Math.abs((list[i][0] - ax) * dy - (list[i][1] - ay) * dx) / len;
                if (d > best) {
                    best = d; at = i;
                }
            }
            if (best > tol) {
                keep[at] = 1;
                stack.push([i0, at], [at, i1]);
            }
        }
        return list.filter((_, i) => keep[i]);
    };
    // coupe la boucle au sommet le plus éloigné du premier
    let far = 0, farD = -1;
    for (let i = 1; i < pts.length; i++) {
        const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
        if (d > farD) {
            farD = d; far = i;
        }
    }
    const a = dp(pts.slice(0, far + 1));
    const b = dp([...pts.slice(far), pts[0]]);
    return [...a.slice(0, -1), ...b.slice(0, -1)];
};

// Contours d'un masque sans trou : boucles d'arêtes de cases, sens direct
// (dedans à gauche), en (E, N). Une boucle par morceau.
const traceLoops = (mask, w, h, grid) => {
    // arêtes orientées, clé = sommet de départ (vx, vy) sur la grille des coins
    const next = new Map();
    const key = (x, y) => y * (w + 1) + x;
    const add = (x0, y0, x1, y1) => {
        const k = key(x0, y0);
        const list = next.get(k);
        if (list) list.push(key(x1, y1));
        else next.set(k, [key(x1, y1)]);
    };
    const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x];
    // ligne 0 au nord : en coins (x, y) avec y vers le sud, « dedans à gauche »
    // en (E, N) revient à tourner dans le sens horaire en (x, y).
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (!mask[y * w + x]) continue;
            if (!at(x, y - 1)) add(x + 1, y, x, y);           // nord : vers l'ouest
            if (!at(x - 1, y)) add(x, y, x, y + 1);           // ouest : vers le sud
            if (!at(x, y + 1)) add(x, y + 1, x + 1, y + 1);   // sud : vers l'est
            if (!at(x + 1, y)) add(x + 1, y + 1, x + 1, y);   // est : vers le nord
        }
    }
    const loops = [];
    for (const [start, list] of next) {
        while (list.length) {
            const pts = [];
            let k = start;
            let prev = null;
            for (;;) {
                const outs = next.get(k);
                if (!outs || !outs.length) break;
                // sommet pincé : prendre l'arête qui tourne à gauche en (E, N)
                let pick = 0;
                if (outs.length > 1 && prev !== null) {
                    const kx = k % (w + 1), ky = Math.floor(k / (w + 1));
                    const px = kx - prev % (w + 1), py = ky - Math.floor(prev / (w + 1));
                    pick = outs.findIndex(o => px * (Math.floor(o / (w + 1)) - ky) - py * (o % (w + 1) - kx) < 0);
                    if (pick < 0) pick = 0;
                }
                const to = outs.splice(pick, 1)[0];
                pts.push(k);
                prev = k;
                k = to;
                if (k === start) break;
            }
            if (pts.length < 4) continue;
            const poly = pts.map(p => [grid.e0 + (p % (w + 1)) * grid.cell, grid.n1 - Math.floor(p / (w + 1)) * grid.cell]);
            // retire les sommets alignés
            const clean = poly.filter((p, i) => {
                const a = poly[(i + poly.length - 1) % poly.length], b = poly[(i + 1) % poly.length];
                return Math.abs((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0])) > 1e-9;
            });
            if (clean.length >= 3) loops.push(clean);
        }
    }
    return loops.filter(l => polygonArea(l) > 0);
};

// --- réglages ----------------------------------------------------------------

// Cherche une trajectoire de scanner (poses.json d'un LCC) sous le projet.
const findTrajectory = () => {
    const walk = (dir, depth) => {
        if (depth > 4) return null;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return null;
        }
        for (const e of entries) {
            if (e.isFile() && e.name === 'poses.json') return join(dir, e.name);
        }
        for (const e of entries) {
            if (e.isDirectory() && !e.name.startsWith('.') && !/lod-output|pointcloud|^map$|^volume$/.test(e.name)) {
                const found = walk(join(dir, e.name), depth + 1);
                if (found) return found;
            }
        }
        return null;
    };
    return walk(projectDir, 0);
};

const writeDefaultConfig = () => {
    const levels = (scene.map?.levels ?? []).filter(l => l.interior && l.walls).map(l => ({
        id: l.id, name: l.name, floor: l.floor, walls: l.walls, bounds: l.bounds, photo: l.photo, use: true
    }));
    if (!levels.length) fail(`la carte de la scène « ${scene.id} » n'a aucun niveau "interior": true avec une carte des murs (scene-map.mjs)`);
    let within = null;
    if (scene.interior.collision) {
        const meta = JSON.parse(readFileSync(fromProject(scene.interior.collision), 'utf-8'));
        const [x0, , z0] = meta.gridBounds.min, [x1, , z1] = meta.gridBounds.max;
        within = [round(-x1), round(z0), round(-x0), round(z1)];
    } else {
        const b = levels.map(l => l.bounds);
        within = [Math.min(...b.map(v => v[0])), Math.min(...b.map(v => v[1])), Math.max(...b.map(v => v[2])), Math.max(...b.map(v => v[3]))];
    }
    if (!scene.collision) fail(`la scène « ${scene.id} » n'a pas de collision extérieure (toits)`);
    const trajectory = findTrajectory();
    const config = {
        scene: scene.id,
        levels,
        within,
        close: DEFAULTS.close,
        wallAlpha: DEFAULTS.wallAlpha,
        minRoom: DEFAULTS.minRoom,
        below: DEFAULTS.below,
        simplify: DEFAULTS.simplify,
        roof: { collision: scene.collision, step: DEFAULTS.roof.step },
        include: [],
        exclude: [],
        tops: [],
        ...(trajectory ? { trajectory: relProject(trajectory) } : {})
    };
    mkdirSync(volumeDir, { recursive: true });
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`réglages écrits : ${relative(process.cwd(), configPath)}`);
    return config;
};

const readConfig = () => {
    const c = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : writeDefaultConfig();
    const isBox = b => Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) && b[2] > b[0] && b[3] > b[1];
    const isPoly = p => Array.isArray(p) && p.length >= 3 && p.every(v => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite));
    if (!isBox(c.within)) fail('within attendu [E0, N0, E1, N1]');
    for (const k of ['close', 'wallAlpha', 'minRoom', 'below', 'simplify']) {
        if (!(Number.isFinite(c[k]) && c[k] >= 0)) fail(`${k} attendu nombre positif`);
    }
    if (!(c.roof?.step > 0) || typeof c.roof?.collision !== 'string') fail('roof attendu { "collision": "./….voxel.json", "step": 0.5 }');
    for (const l of c.levels ?? []) {
        if (!Number.isFinite(l.floor) || !isBox(l.bounds) || typeof l.walls !== 'string') fail(`niveau ${l.id} : floor, bounds et walls attendus`);
    }
    for (const k of ['include', 'exclude']) {
        for (const z of c[k] ?? []) {
            const poly = Array.isArray(z) ? z : z?.outline;
            if (!isPoly(poly)) fail(`${k} : polygone [[E, N], …] ou { "outline": […], "levels": [ids] } attendu`);
        }
    }
    for (const t of c.tops ?? []) {
        if (!isPoly(t?.outline) || !Number.isFinite(t?.top)) fail('tops : { "outline": [[E, N], …], "top": H } attendu');
    }
    const used = (c.levels ?? []).filter(l => l.use !== false).sort((a, b) => a.floor - b.floor);
    if (!used.length) fail('aucun niveau utilisé dans volume.json');
    return { ...c, used };
};

// --- calcul ------------------------------------------------------------------

const zones = (list, levelId) => (list ?? [])
.map(z => (Array.isArray(z) ? { outline: z } : z))
.filter(z => !z.levels || z.levels.includes(levelId));

// Masque d'un polygone sur la grille.
const polygonMask = (grid, poly) => {
    const out = new Uint8Array(grid.w * grid.h);
    const es = poly.map(p => p[0]), ns = poly.map(p => p[1]);
    const x0 = Math.max(0, Math.floor((Math.min(...es) - grid.e0) / grid.cell));
    const x1 = Math.min(grid.w - 1, Math.ceil((Math.max(...es) - grid.e0) / grid.cell));
    const y0 = Math.max(0, Math.floor((grid.n1 - Math.max(...ns)) / grid.cell));
    const y1 = Math.min(grid.h - 1, Math.ceil((grid.n1 - Math.min(...ns)) / grid.cell));
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            if (insidePolygon(poly, grid.e0 + (x + 0.5) * grid.cell, grid.n1 - (y + 0.5) * grid.cell)) out[y * grid.w + x] = 1;
        }
    }
    return out;
};

// Emprise d'un niveau : dedans = ce qu'un disque de rayon `close` parti du
// bord du cadre n'atteint pas.
const levelFootprint = (config, grid, level, roof) => {
    const { w, h, cell } = grid;
    const img = readPng(fromProject(level.walls));
    const [b0, b1, b2, b3] = level.bounds;
    const sx = img.width / (b2 - b0), sy = img.height / (b3 - b1);
    const threshold = Math.round(config.wallAlpha * 255);
    const wall = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const n = grid.n1 - (y + 0.5) * cell;
        const py = Math.floor((b3 - n) * sy);
        if (py < 0 || py >= img.height) continue;
        for (let x = 0; x < w; x++) {
            const px = Math.floor((grid.e0 + (x + 0.5) * cell - b0) * sx);
            if (px >= 0 && px < img.width && img.alpha[py * img.width + px] >= threshold) wall[y * w + x] = 1;
        }
    }
    const r2 = (config.close / cell) ** 2;
    const dWall = distanceSquared(wall, w, h);
    // disque libre de rayon close, atteint depuis le bord
    const reach = new Uint8Array(w * h);
    const stack = [];
    const seed = (i) => {
        if (!reach[i] && dWall[i] > r2) {
            reach[i] = 1;
            stack.push(i);
        }
    };
    for (let x = 0; x < w; x++) {
        seed(x); seed((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
        seed(y * w); seed(y * w + w - 1);
    }
    while (stack.length) {
        const c = stack.pop();
        const x = c % w, y = (c - x) / w;
        if (x > 0) seed(c - 1);
        if (x < w - 1) seed(c + 1);
        if (y > 0) seed(c - w);
        if (y < h - 1) seed(c + w);
    }
    const dReach = distanceSquared(reach, w, h);
    const limit = (config.close / cell + 1) ** 2;
    // dedans, et sous un toit lisse à au moins HEADROOM du sol (terrasse,
    // massif, arbre : non)
    let inside = new Uint8Array(w * h);
    const under = level.floor + HEADROOM;
    for (let i = 0; i < inside.length; i++) inside[i] = dReach[i] > limit && roof.ceil[i] >= under && roof.smooth[i] ? 1 : 0;

    // emprises gardées : au moins minRoom m² libres (à plus de 20 cm d'un mur)
    const { label, sizes } = components(inside, w, h);
    const free = new Float64Array(sizes.length);
    const roomR2 = (0.2 / cell) ** 2;
    for (let i = 0; i < label.length; i++) if (label[i] && dWall[i] > roomR2) free[label[i]] += cell * cell;
    const kept = [], dropped = [];
    for (let id = 1; id < sizes.length; id++) {
        const area = sizes[id] * cell * cell;
        if (free[id] >= config.minRoom) kept.push(id);
        else if (area >= 1) dropped.push({ area: round(area, 1), free: round(free[id], 1) });
    }
    const keep = new Uint8Array(sizes.length);
    for (const id of kept) keep[id] = 1;
    inside = inside.map((_, i) => keep[label[i]]);

    for (const z of zones(config.include, level.id)) {
        const m = polygonMask(grid, z.outline);
        for (let i = 0; i < m.length; i++) if (m[i]) inside[i] = 1;
    }
    for (const z of zones(config.exclude, level.id)) {
        const m = polygonMask(grid, z.outline);
        for (let i = 0; i < m.length; i++) if (m[i]) inside[i] = 0;
    }
    const filled = fillHoles(inside, w, h);
    let area = 0;
    for (const v of filled.mask) area += v;
    return {
        mask: filled.mask,
        wall,
        area: round(area * cell * cell, 1),
        holes: round(filled.filled * cell * cell, 1),
        kept: kept.length,
        dropped
    };
};

// Dessus du toit par case : premier voxel plein vu du ciel dans la collision
// extérieure, entre `lo` et `hi` (sous un feuillage : toit bas cherché sous
// `hi`), médiane sur la grille de la collision ; −∞ sans rien. Une case est
// « lisse » si le dessus y est plan (toit) et non feuillu (arbre).
const roofSurfaces = (config, grid) => {
    const v = loadVoxel(fromProject(config.roof.collision));
    const res = v.res;
    const [e0, n0, e1, n1] = [grid.e0, grid.n1 - grid.h * grid.cell, grid.e0 + grid.w * grid.cell, grid.n1];
    // colonnes de la collision couvrant le cadre (x moteur = −E, z = N)
    const ix0 = Math.floor((-e1 - v.min[0]) / res), ix1 = Math.ceil((-e0 - v.min[0]) / res);
    const iz0 = Math.floor((n0 - v.min[2]) / res), iz1 = Math.ceil((n1 - v.min[2]) / res);
    const cw = ix1 - ix0, ch = iz1 - iz0;
    const win = [];
    const median = (src, r) => {
        const out = new Float32Array(cw * ch);
        for (let k = 0; k < ch; k++) {
            for (let j = 0; j < cw; j++) {
                win.length = 0;
                for (let dk = -r; dk <= r; dk++) {
                    for (let dj = -r; dj <= r; dj++) {
                        const kk = Math.min(ch - 1, Math.max(0, k + dk)), jj = Math.min(cw - 1, Math.max(0, j + dj));
                        win.push(src[kk * cw + jj]);
                    }
                }
                win.sort((a, b) => a - b);
                out[k * cw + j] = win[win.length >> 1];
            }
        }
        return out;
    };
    return (lo, hi = Infinity) => {
        const iyLo = Math.max(0, Math.floor((lo - v.min[1]) / res));
        const iyHi = Math.min(v.n[1] - 1, Number.isFinite(hi) ? Math.floor((hi - v.min[1]) / res) - 1 : v.n[1] - 1);
        const top = new Float32Array(cw * ch).fill(-Infinity);
        for (let k = 0; k < ch; k++) {
            for (let j = 0; j < cw; j++) {
                for (let iy = iyHi; iy >= iyLo; iy--) {
                    if (v.solid(ix0 + j, iy, iz0 + k)) {
                        top[k * cw + j] = v.min[1] + (iy + 1) * res;
                        break;
                    }
                }
            }
        }
        const med = median(top, ROOF_MEDIAN);
        // rugosité : écart médian à la moyenne des voisins à ±20 cm, sur 70 cm ;
        // un toit (plans, arêtes fines) est lisse, une cime d'arbre ne l'est pas
        const lap = new Float32Array(cw * ch).fill(Infinity);
        for (let k = 2; k < ch - 2; k++) {
            for (let j = 2; j < cw - 2; j++) {
                const c = med[k * cw + j];
                const m = (med[k * cw + j - 2] + med[k * cw + j + 2] + med[(k - 2) * cw + j] + med[(k + 2) * cw + j]) / 4;
                if (Number.isFinite(c) && Number.isFinite(m)) lap[k * cw + j] = Math.abs(c - m);
            }
        }
        const rough = median(lap, ROUGH_WINDOW);
        const ceil = new Float32Array(grid.w * grid.h);
        const smooth = new Uint8Array(grid.w * grid.h);
        for (let y = 0; y < grid.h; y++) {
            const n = grid.n1 - (y + 0.5) * grid.cell;
            const k = Math.min(ch - 1, Math.max(0, Math.floor((n - v.min[2]) / res) - iz0));
            for (let x = 0; x < grid.w; x++) {
                const e = grid.e0 + (x + 0.5) * grid.cell;
                const j = Math.min(cw - 1, Math.max(0, Math.floor((-e - v.min[0]) / res) - ix0));
                ceil[y * grid.w + x] = med[k * cw + j];
                smooth[y * grid.w + x] = rough[k * cw + j] <= ROUGH_MAX ? 1 : 0;
            }
        }
        const dSmooth = distanceSquared(smooth, grid.w, grid.h);
        const grow2 = (ROUGH_GROW / grid.cell) ** 2;
        for (let i = 0; i < smooth.length; i++) smooth[i] = dSmooth[i] <= grow2 ? 1 : 0;
        return { ceil, smooth };
    };
};

// Hauteurs imposées à la main (tops) : toit lisse à cette hauteur.
const applyTops = (config, grid, roof) => {
    for (const t of config.tops ?? []) {
        const m = polygonMask(grid, t.outline);
        for (let i = 0; i < m.length; i++) {
            if (m[i]) {
                roof.ceil[i] = t.top;
                roof.smooth[i] = 1;
            }
        }
    }
};

const percentile = (values, p) => {
    if (!values.length) return NaN;
    const s = Float64Array.from(values).sort();
    return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};

const computeVolume = (config) => {
    const [w0, s0, w1, s1] = config.within;
    const grid = { cell: CELL, e0: w0, n1: s1, w: Math.round((w1 - w0) / CELL), h: Math.round((s1 - s0) / CELL) };
    const { w, h } = grid;
    const levels = config.used;

    const bottom = levels[0].floor - config.below;
    const surface = roofSurfaces(config, grid);
    const roof = surface(bottom);
    applyTops(config, grid, roof);
    const footprints = levels.map(l => ({ level: l, ...levelFootprint(config, grid, l, roof) }));
    // partie d'un niveau sans étage au-dessus : son toit doit être bas (aile,
    // appentis), à moins de LOW_ROOF au-dessus du sol de l'étage ; plus haut,
    // c'est une cime d'arbre au-dessus d'une terrasse
    for (let k = 0; k + 1 < footprints.length; k++) {
        // (à ABOVE_MARGIN près : l'emprise d'un étage sous un rampant est un
        // peu plus petite que celle du dessous)
        // Sous un feuillage, on cherche un toit bas (lisse) sous la limite :
        // s'il y en a un, il devient le toit de la case.
        const f = footprints[k], dAbove = distanceSquared(footprints[k + 1].mask, w, h);
        const limit = levels[k + 1].floor + LOW_ROOF, margin2 = (ABOVE_MARGIN / CELL) ** 2;
        let low = null, removed = 0;
        for (let c = 0; c < f.mask.length; c++) {
            if (f.mask[c] && dAbove[c] > margin2 && roof.ceil[c] > limit) {
                low ??= surface(levels[k].floor + HEADROOM, limit);
                if (low.smooth[c] && low.ceil[c] >= levels[k].floor + HEADROOM) {
                    roof.ceil[c] = low.ceil[c];
                } else {
                    f.mask[c] = 0;
                    removed++;
                }
            }
        }
        // ouverture morphologique : retire les franges plus fines que 2 × OPEN_RADIUS
        const open2 = (OPEN_RADIUS / CELL) ** 2;
        const dOut = distanceSquared(f.mask.map(v => 1 - v), w, h);
        const core = dOut.map(d => (d > open2 ? 1 : 0));
        const dCore = distanceSquared(core, w, h);
        for (let c = 0; c < f.mask.length; c++) {
            if (f.mask[c] && dCore[c] > (OPEN_RADIUS / CELL + 1) ** 2) {
                f.mask[c] = 0;
                removed++;
            }
        }
        f.area = round(f.area - removed * CELL * CELL, 1);
        f.treeArea = round(removed * CELL * CELL, 1);
    }

    // paliers : sols des niveaux, paliers de toit, bas du volume
    const union = new Uint8Array(w * h);
    for (const f of footprints) for (let i = 0; i < union.length; i++) union[i] |= f.mask[i];
    let highest = -Infinity;
    for (let i = 0; i < union.length; i++) if (union[i] && roof.ceil[i] > highest) highest = roof.ceil[i];
    if (!(highest > bottom)) fail('aucun toit trouvé au-dessus des emprises : collision extérieure ou cadre à revoir');
    const step = config.roof.step;
    const breaks = new Set([round(bottom, 3), ...levels.slice(1).map(l => round(l.floor, 3))]);
    const firstRoof = Math.ceil((levels[0].floor + 1.8) / step) * step;
    for (let hgt = firstRoof; hgt <= highest + 1e-6; hgt += step) breaks.add(round(hgt, 3));
    const heights = [...breaks].filter(v => v <= highest + 1e-6).sort((a, b) => a - b);

    // tranches : emprise du niveau qui possède le bas, là où le toit dépasse le haut
    const owner = (a) => {
        let k = 0;
        for (let i = 0; i < levels.length; i++) if (levels[i].floor <= a + 1e-6) k = i;
        return k;
    };
    // une case reste dans une tranche si le dessus du toit dépasse son haut
    // à un demi-palier près (le volume ne sort du toit que de quelques cm,
    // la collision tient la caméra plus loin)
    const slack = step / 2;
    // Dernier niveau, sous le toit : emprise de l'étage du dessous (les
    // lucarnes et le pied des rampants sont hors de la carte des murs des
    // combles), le toit seul en découpe la hauteur.
    const owned = footprints.map(f => f.mask);
    if (footprints.length > 1) {
        const top = owned.length - 1;
        owned[top] = owned[top].map((v, c) => v | footprints[top - 1].mask[c]);
    }
    const slabs = [];
    for (let i = 0; i + 1 < heights.length; i++) {
        const a = heights[i], b = heights[i + 1];
        const fp = owned[owner(a)];
        const mask = new Uint8Array(w * h);
        let count = 0;
        for (let c = 0; c < mask.length; c++) {
            if (fp[c] && roof.ceil[c] >= b - slack) {
                mask[c] = 1; count++;
            }
        }
        if (!count) continue;
        // tranche fusionnée avec la précédente si elle n'en perd qu'une frange
        // (bords du toit, flotteurs) : on garde alors l'intersection
        const prev = slabs[slabs.length - 1];
        if (prev && prev.top === a) {
            let kept = 0, added = 0;
            for (let c = 0; c < mask.length; c++) {
                if (prev.first[c] && mask[c]) kept++;
                else if (mask[c] && !prev.mask[c]) added++;
            }
            const lost = (prev.firstCount - kept) * CELL * CELL;
            if (added * CELL * CELL <= MERGE_AREA && lost <= Math.max(MERGE_AREA, MERGE_SHARE * prev.firstCount * CELL * CELL)) {
                for (let c = 0; c < mask.length; c++) prev.mask[c] &= mask[c];
                prev.top = b;
                continue;
            }
        }
        slabs.push({ floor: a, top: b, mask, first: mask.slice(), firstCount: count });
    }

    const prisms = [];
    let holes = 0;
    for (const s of slabs) {
        const { label, sizes } = components(s.mask, w, h);
        for (let id = 1; id < sizes.length; id++) {
            if (sizes[id] * CELL * CELL < MIN_PRISM) continue;   // miettes
            const part = new Uint8Array(w * h);
            for (let c = 0; c < part.length; c++) part[c] = label[c] === id ? 1 : 0;
            const filled = fillHoles(part, w, h);
            holes += filled.filled * CELL * CELL;
            for (const loop of traceLoops(filled.mask, w, h, grid)) {
                const outline = simplifyLoop(loop, Math.max(config.simplify, CELL)).map(p => [round(p[0]), round(p[1])]);
                if (outline.length < 3) continue;
                prisms.push({ outline, floor: round(s.floor), top: round(s.top), area: round(polygonArea(outline), 1) });
            }
        }
    }

    // toits du plus grand morceau du dernier niveau : égout (bord) et faîtage
    const stats = [];
    for (const f of footprints) {
        const { label, sizes } = components(f.mask, w, h);
        for (let id = 1; id < sizes.length; id++) {
            if (sizes[id] * CELL * CELL < 4) continue;
            const edge = [], all = [];
            let se = 0, sn = 0;
            for (let c = 0; c < label.length; c++) {
                if (label[c] !== id) continue;
                const x = c % w, y = (c - x) / w;
                se += grid.e0 + (x + 0.5) * CELL; sn += grid.n1 - (y + 0.5) * CELL;
                if (roof.ceil[c] > f.level.floor) all.push(roof.ceil[c]);
                const border = x === 0 || y === 0 || x === w - 1 || y === h - 1 ||
                    label[c - 1] !== id || label[c + 1] !== id || label[c - w] !== id || label[c + w] !== id;
                if (border && roof.ceil[c] > f.level.floor) edge.push(roof.ceil[c]);
            }
            stats.push({
                level: f.level.id,
                at: [round(se / sizes[id]), round(sn / sizes[id])],
                area: round(sizes[id] * CELL * CELL, 1),
                eave: round(percentile(edge, 0.25)),
                ridge: round(percentile(all, 0.995))
            });
        }
    }
    return { grid, footprints, roof, prisms, holes: round(holes, 1), stats, heights };
};

// --- trajectoire du scanner --------------------------------------------------

// Distance signée au volume, comme src/interior.ts (négative dedans).
const signedDistance = (prisms, e, n, hgt) => {
    let best = Infinity;
    for (const p of prisms) {
        let inside = false, d2 = Infinity;
        const o = p.outline;
        for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
            const [ax, ay] = o[j], [bx, by] = o[i];
            const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
            const t = len2 > 0 ? Math.max(0, Math.min(1, ((e - ax) * dx + (n - ay) * dy) / len2)) : 0;
            d2 = Math.min(d2, (ax + t * dx - e) ** 2 + (ay + t * dy - n) ** 2);
            if ((by > n) !== (ay > n) && e < ax + (n - ay) * dx / dy) inside = !inside;
        }
        const dh = inside ? -Math.sqrt(d2) : Math.sqrt(d2);
        const dv = Math.max(p.floor - hgt, hgt - p.top);
        best = Math.min(best, dh <= 0 && dv <= 0 ? Math.max(dh, dv) : Math.hypot(Math.max(dh, 0), Math.max(dv, 0)));
    }
    return best;
};

// Poses (E, N, H) du scanner, une par POSE_STEP secondes, et passages de la
// bascule le long de la trajectoire (même hystérésis que le visualisateur).
const trajectoryCrossings = (config, prisms) => {
    if (!config.trajectory) return null;
    const path = fromProject(config.trajectory);
    if (!existsSync(path)) {
        console.log(`trajectoire absente : ${config.trajectory}`);
        return null;
    }
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    // segments de relevé, dans l'ordre du temps ; pas de bascule comptée d'un
    // segment à l'autre
    const segments = (data.fusionPoses ?? [data.poses ?? []])
    .map(seg => (seg ?? []).filter(p => Array.isArray(p?.T)).map(p => ({ t: Number(p.ts), e: p.T[0], n: p.T[1], h: p.T[2] })))
    .filter(seg => seg.length)
    .sort((a, b) => a[0].t - b[0].t);
    if (!segments.length) return null;
    const t0 = segments[0][0].t;
    const poses = [], crossings = [];
    for (const seg of segments) {
        let last = -Infinity, inside = null;
        for (const p of seg) {
            if (p.t - last < POSE_STEP) continue;
            last = p.t;
            const d = signedDistance(prisms, p.e, p.n, p.h);
            if (inside === null) inside = d < 0;
            p.inside = inside ? d < HYSTERESIS : d < -HYSTERESIS;
            if (p.inside !== inside) {
                crossings.push({ e: round(p.e), n: round(p.n), h: round(p.h), t: round(p.t - t0, 1), entering: p.inside });
                inside = p.inside;
            }
            poses.push(p);
        }
    }
    return { poses, crossings };
};

// --- coupes par façade -------------------------------------------------------

// Une coupe par façade (vue depuis l'ouest, l'est, le nord, le sud) : les
// splats extérieurs d'une tranche de 1 m dehors à SECTION_DEPTH dans le
// bâtiment, rendus en quasi orthographique. Mise en cache dans controle/.
const FACADES = [
    // look : direction du regard en (E, N) ; right : droite de l'image en (E, N)
    // (regard vers le sud : l'est est à gauche)
    { id: 'ouest', name: 'Façade ouest (vue depuis l’ouest)', look: [1, 0], right: [0, -1] },
    { id: 'est', name: 'Façade est (vue depuis l’est)', look: [-1, 0], right: [0, 1] },
    { id: 'nord', name: 'Façade nord (vue depuis le nord)', look: [0, -1], right: [-1, 0] },
    { id: 'sud', name: 'Façade sud (vue depuis le sud)', look: [0, 1], right: [1, 0] }
];

const renderSections = (config, prisms) => {
    const content = fromProject(scene.content);
    const lod = content.endsWith('lod-meta.json') ? ['-L', String(Math.min(1, (JSON.parse(readFileSync(content, 'utf-8')).lodLevels ?? 1) - 1))] : [];
    const es = prisms.flatMap(p => p.outline.map(v => v[0])), ns = prisms.flatMap(p => p.outline.map(v => v[1]));
    const box = [Math.min(...es) - 1.5, Math.min(...ns) - 1.5, Math.max(...es) + 1.5, Math.max(...ns) + 1.5];
    const h0 = Math.min(...prisms.map(p => p.floor)) - 0.5, h1 = Math.max(...prisms.map(p => p.top)) + 1.5;
    const out = [];
    for (const f of FACADES) {
        // profondeur : de la face la plus avancée (1 m dehors) à SECTION_DEPTH dedans
        const depthE = f.look[0] !== 0, sign = depthE ? f.look[0] : f.look[1];
        const front = sign > 0 ? (depthE ? Math.min(...es) : Math.min(...ns)) : (depthE ? Math.max(...es) : Math.max(...ns));
        const near = front - sign * 1.0, far = front + sign * SECTION_DEPTH;
        const [d0, d1] = [Math.min(near, far), Math.max(near, far)];
        const [eLo, eHi] = depthE ? [d0, d1] : [box[0], box[2]];
        const [nLo, nHi] = depthE ? [box[1], box[3]] : [d0, d1];
        // horizontale de l'image : u = right · (E, N)
        const uLo = f.right[0] ? Math.min(f.right[0] * box[0], f.right[0] * box[2]) : Math.min(f.right[1] * box[1], f.right[1] * box[3]);
        const uHi = f.right[0] ? Math.max(f.right[0] * box[0], f.right[0] * box[2]) : Math.max(f.right[1] * box[1], f.right[1] * box[3]);
        const px = Math.max(SECTION_PX, Math.max(uHi - uLo, h1 - h0) / SECTION_MAX);
        const width = Math.round((uHi - uLo) / px), height = Math.round((h1 - h0) / px);
        const uc = (uLo + uHi) / 2, hc = (h0 + h1) / 2;
        // centre (E, N) : u au milieu, profondeur au milieu de la tranche
        const ce = f.right[0] ? f.right[0] * uc : (eLo + eHi) / 2;
        const cn = f.right[1] ? f.right[1] * uc : (nLo + nHi) / 2;
        const cam = [ce - f.look[0] * CAMERA_DISTANCE, cn - f.look[1] * CAMERA_DISTANCE];
        const file = `coupe-${f.id}.webp`;
        const key = JSON.stringify({ content: scene.content, lod, eLo, eHi, nLo, nHi, h0, h1, width, height });
        const keyPath = join(controlDir, `coupe-${f.id}.json`);
        const cached = existsSync(join(controlDir, file)) && existsSync(keyPath) && readFileSync(keyPath, 'utf-8') === key;
        if (!cached || opts.force) {
            const t0 = Date.now();
            const dir = mkdtempSync(join(tmpdir(), 'interior-volume-'));
            try {
                // boîte en repère moteur (−E, H, N)
                const band = join(dir, 'tranche.ply');
                run('splat-transform', ['-q', '-w', ...lod, content, '-B', `${round(-eHi, 3)},${round(h0, 3)},${round(nLo, 3)},${round(-eLo, 3)},${round(h1, 3)},${round(nHi, 3)}`, band]);
                const fov = 2 * Math.atan(height * px / 2 / CAMERA_DISTANCE) * 180 / Math.PI;
                run('splat-transform', ['-q', '-w', band, join(controlDir, file),
                    '--camera-pos', `${-cam[0]},${hc},${cam[1]}`,
                    '--camera-target', `${-ce},${hc},${cn}`,
                    '--camera-up', '0,1,0',
                    '--camera-fov', String(fov),
                    '--resolution', `${width}x${height}`,
                    '--camera-near', String(CAMERA_DISTANCE - 100),
                    '--background', '1,1,1,1']);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
            writeFileSync(keyPath, key);
            console.log(`coupe ${f.id} : ${width} × ${height} px en ${fmt((Date.now() - t0) / 1000, 1)} s`);
        }
        out.push({ ...f, file, width, height, px, uLo, h1, d0, d1, depthE });
    }
    return out;
};

// --- planche de contrôle -----------------------------------------------------

const escapeHtml = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const PALETTE = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2', '#dc2626', '#65a30d'];

// Carte des toits en couleurs (bleu bas → rouge haut), hors emprise estompée.
const writeRoofImage = (result, path) => {
    const { grid, roof, footprints } = result;
    const { w, h } = grid;
    const union = new Uint8Array(w * h);
    for (const f of footprints) for (let i = 0; i < union.length; i++) union[i] |= f.mask[i];
    const vals = [];
    for (let i = 0; i < union.length; i++) if (union[i] && Number.isFinite(roof.ceil[i])) vals.push(roof.ceil[i]);
    const lo = percentile(vals, 0.01), hi = percentile(vals, 1);
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        const v = roof.ceil[i];
        if (!Number.isFinite(v)) continue;
        const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
        // rampe bleu → jaune → rouge
        const r = Math.round(255 * Math.min(1, 2 * t)), g = Math.round(255 * (t < 0.5 ? 0.4 + 1.2 * t : 2 - 2 * t)), b = Math.round(255 * Math.max(0, 1 - 2 * t));
        rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b;
        rgba[i * 4 + 3] = union[i] ? 255 : 70;
    }
    writePngRgba(path, w, h, rgba);
    return { lo: round(lo), hi: round(hi) };
};

const writeControl = (config, result, trajectory, sections) => {
    const { grid, prisms, footprints, stats } = result;
    const color = i => PALETTE[i % PALETTE.length];
    const rel = p => relative(volumeDir, fromProject(p));
    const svgPoly = (poly, toXY, attrs) => `<polygon points="${poly.map(p => toXY(p).map(v => round(v, 1)).join(',')).join(' ')}" ${attrs}/>`;

    // vues de dessus : photo de la carte du niveau, emprise (pointillé),
    // prismes qui contiennent les yeux (plein) ou touchent le niveau (trait)
    const levelViews = config.used.map((l, k) => {
        const [b0, b1, b2, b3] = l.bounds;
        const next = config.used[k + 1]?.floor ?? Infinity;
        const eye = l.floor + EYE;
        // cadre : emprise du volume, pas toute la carte (n1 couvre le jardin)
        const es = prisms.flatMap(p => p.outline.map(v => v[0])), ns = prisms.flatMap(p => p.outline.map(v => v[1]));
        const v0 = Math.max(b0, Math.min(...es) - 3), v2 = Math.min(b2, Math.max(...es) + 3);
        const v1 = Math.max(b1, Math.min(...ns) - 3), v3 = Math.min(b3, Math.max(...ns) + 3);
        const S = 40;   // px par mètre dans le repère SVG
        const W = (v2 - v0) * S, H = (v3 - v1) * S;
        const toXY = p => [(p[0] - v0) * S, (v3 - p[1]) * S];
        const fp = footprints.find(f => f.level.id === l.id);
        const fpLoops = traceLoops(fp.mask, grid.w, grid.h, grid);
        const shapes = prisms.map((p, i) => {
            if (p.top <= l.floor || p.floor >= next) return '';
            const full = p.floor <= eye && p.top >= eye;
            return svgPoly(p.outline, toXY, `fill="${full ? color(i) : 'none'}" fill-opacity="0.18" stroke="${color(i)}" stroke-width="${full ? 3 : 2}" ${full ? '' : 'stroke-dasharray="10 6"'}`);
        }).join('');
        const outline = fpLoops.map(loop => svgPoly(loop, toXY, 'fill="none" stroke="#111" stroke-width="1.5" stroke-dasharray="3 4"')).join('');
        let path = '', marks = '';
        if (trajectory) {
            const pts = trajectory.poses.filter(p => p.h >= l.floor && p.h < next);
            path = pts.map((p) => {
                const [x, y] = toXY([p.e, p.n]);
                return `<circle cx="${round(x, 1)}" cy="${round(y, 1)}" r="2.2" fill="${p.inside ? '#059669' : '#9ca3af'}"/>`;
            }).join('');
            marks = trajectory.crossings.map((c, i) => ({ ...c, i })).filter(c => c.h >= l.floor && c.h < next).map((c) => {
                const [x, y] = toXY([c.e, c.n]);
                return `<g><circle cx="${round(x, 1)}" cy="${round(y, 1)}" r="11" fill="none" stroke="${c.entering ? '#059669' : '#dc2626'}" stroke-width="3"/>` +
                    `<text x="${round(x + 14, 1)}" y="${round(y - 10, 1)}" font-size="22" font-weight="600" fill="${c.entering ? '#047857' : '#b91c1c'}" paint-order="stroke" stroke="#fff" stroke-width="4">${c.i + 1}</text></g>`;
            }).join('');
        }
        const photo = l.photo ? `<image href="${escapeHtml(rel(l.photo))}" x="${(b0 - v0) * S}" y="${(v3 - b3) * S}" width="${(b2 - b0) * S}" height="${(b3 - b1) * S}" preserveAspectRatio="none"/>` : '';
        return `<section><h3>${escapeHtml(l.id)} — ${escapeHtml(l.name ?? '')} (sol ${fmt(l.floor)} m)</h3>` +
            `<svg class="top" viewBox="0 0 ${round(W)} ${round(H)}"><rect width="100%" height="100%" fill="#fff"/>${photo}${outline}${shapes}${path}${marks}</svg>` +
            `<p>Emprise ${fmt(fp.area, 1)} m² (${fp.kept} morceau${fp.kept > 1 ? 'x' : ''}${fp.holes ? `, ${fmt(fp.holes, 1)} m² de trous bouchés` : ''})` +
            `${fp.treeArea ? ` ; ${fmt(fp.treeArea, 1)} m² retirés, sans étage au-dessus mais sous un « toit » haut (arbre)` : ''}` +
            `${fp.dropped.length ? ` ; écartés (enclos sans pièce) : ${fp.dropped.map(d => `${fmt(d.area, 1)} m²`).join(', ')}` : ''}.</p></section>`;
    }).join('');

    // carte des toits
    const roofRange = writeRoofImage(result, join(controlDir, 'toits.png'));
    const S = 30;
    const RW = grid.w * grid.cell * S, RH = grid.h * grid.cell * S;
    const rXY = p => [(p[0] - grid.e0) * S, (grid.n1 - p[1]) * S];
    const roofShapes = prisms.map((p, i) => svgPoly(p.outline, rXY, `fill="none" stroke="${color(i)}" stroke-width="2"`) +
        (() => {
            const c = p.outline.reduce((a, v) => [a[0] + v[0] / p.outline.length, a[1] + v[1] / p.outline.length], [0, 0]);
            const [x, y] = rXY(c);
            return `<text x="${round(x, 1)}" y="${round(y, 1)}" font-size="16" text-anchor="middle" fill="#111" paint-order="stroke" stroke="#fff" stroke-width="3">${i + 1}</text>`;
        })()).join('');

    // coupes
    const sectionViews = sections.map((s) => {
        const S2 = 1 / s.px;
        const u = (e, n) => s.right[0] * e + s.right[1] * n;
        const shapes = prisms.map((p, i) => {
            // partie du prisme dans la tranche (sinon tout le prisme, en pointillé)
            const axis = s.depthE ? 0 : 1;
            const clipped = clipBand(p.outline, axis, s.d0, s.d1);
            const cut = clipped.length >= 3;
            const us = (cut ? clipped : p.outline).map(v => u(v[0], v[1]));
            const x0 = (Math.min(...us) - s.uLo) * S2, x1 = (Math.max(...us) - s.uLo) * S2;
            const y0 = (s.h1 - p.top) * S2, y1 = (s.h1 - p.floor) * S2;
            return `<rect x="${round(x0, 1)}" y="${round(y0, 1)}" width="${round(x1 - x0, 1)}" height="${round(y1 - y0, 1)}" fill="none" stroke="${color(i)}" stroke-width="${cut ? 2.5 : 1.2}" ${cut ? '' : 'stroke-dasharray="8 6" stroke-opacity="0.6"'}/>`;
        }).join('');
        const floors = config.used.map(l => `<line x1="0" x2="${s.width}" y1="${round((s.h1 - l.floor) * S2, 1)}" y2="${round((s.h1 - l.floor) * S2, 1)}" stroke="#6b7280" stroke-width="1" stroke-dasharray="2 5"/>`).join('');
        const marks = trajectory ? trajectory.crossings.map((c, i) => ({ ...c, i })).filter((c) => {
            const d = s.depthE ? c.e : c.n;
            return d >= s.d0 - 0.5 && d <= s.d1 + 0.5;
        }).map((c) => {
            const x = (u(c.e, c.n) - s.uLo) * S2, y = (s.h1 - c.h) * S2;
            return `<circle cx="${round(x, 1)}" cy="${round(y, 1)}" r="9" fill="none" stroke="${c.entering ? '#059669' : '#dc2626'}" stroke-width="3"/>` +
                `<text x="${round(x + 12, 1)}" y="${round(y - 8, 1)}" font-size="20" font-weight="600" fill="${c.entering ? '#047857' : '#b91c1c'}" paint-order="stroke" stroke="#fff" stroke-width="4">${c.i + 1}</text>`;
        }).join('') : '';
        return `<section><h3>${escapeHtml(s.name)}</h3><svg class="section" viewBox="0 0 ${s.width} ${s.height}"><image href="controle/${s.file}" width="${s.width}" height="${s.height}"/>${floors}${shapes}${marks}</svg>` +
            `<p>Tranche de ${s.depthE ? 'E' : 'N'} ${fmt(s.d0, 1)} à ${fmt(s.d1, 1)} m (1 m dehors, ${fmt(SECTION_DEPTH, 0)} m dedans). Trait plein : prisme coupé par la tranche ; pointillé : plus loin.</p></section>`;
    }).join('');

    const rows = prisms.map((p, i) => `<tr><td><span class="sw" style="background:${color(i)}"></span>${i + 1}</td><td class="n">${fmt(p.floor)}</td><td class="n">${fmt(p.top)}</td><td class="n">${fmt(p.area, 1)}</td><td class="n">${p.outline.length}</td></tr>`).join('');
    const statRows = stats.map(s => `<tr><td>${escapeHtml(s.level)}</td><td class="n">${fmt(s.at[0], 1)} ; ${fmt(s.at[1], 1)}</td><td class="n">${fmt(s.area, 1)}</td><td class="n">${Number.isFinite(s.eave) ? fmt(s.eave) : '—'}</td><td class="n">${Number.isFinite(s.ridge) ? fmt(s.ridge) : '—'}</td></tr>`).join('');
    const crossRows = trajectory ? trajectory.crossings.map((c, i) => `<tr><td>${i + 1}</td><td>${c.entering ? 'entrée' : 'sortie'}</td><td class="n">${fmt(c.e)}</td><td class="n">${fmt(c.n)}</td><td class="n">${fmt(c.h)}</td><td class="n">${fmt(c.t, 0)} s</td></tr>`).join('') : '';

    const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Volume intérieur — ${escapeHtml(scene.name ?? scene.id)}</title>
<style>
:root { --bg: #fff; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; }
@media (prefers-color-scheme: dark) { :root { --bg: #161617; --fg: #f5f5f7; --muted: #a1a1a6; --line: #3a3a3c; } }
body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--fg); font: 15px/1.5 -apple-system, system-ui, sans-serif; }
main { max-width: 1200px; margin: 0 auto; }
h1 { font-size: 24px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 32px 0 8px; } h3 { font-size: 15px; margin: 16px 0 6px; }
p { color: var(--muted); } code { font-size: 13px; }
svg { display: block; width: 100%; height: auto; max-height: 90vh; background: #fff; border: 1px solid var(--line); }
.table { overflow-x: auto; } table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; } td.n { text-align: right; font-variant-numeric: tabular-nums; }
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
</style></head><body><main>
<h1>Volume intérieur — ${escapeHtml(scene.name ?? scene.id)}</h1>
<p>${prisms.length} prismes, calculés le ${escapeHtml(new Date().toLocaleString('fr-FR'))} à partir de <code>${escapeHtml(relative(process.cwd(), configPath))}</code>
(ouvertures refermées jusqu'à ${fmt(2 * config.close)} m, paliers de toit de ${fmt(config.roof.step)} m).
${result.holes ? `Trous bouchés dans les prismes : ${fmt(result.holes, 1)} m².` : ''}</p>
<p>À vérifier : chaque porte et chaque fenêtre doit tomber sur un contour (la bascule se fait à ±10 cm du contour) ; aucun prisme ne doit dépasser du toit.
Corriger dans <code>volume.json</code> (<code>close</code>, <code>wallAlpha</code>, <code>include</code>, <code>exclude</code>, <code>tops</code>, <code>roof.step</code>), relancer,
puis écrire le volume avec <code>--write</code>.</p>
<h2>Prismes</h2>
<div class="table"><table><thead><tr><th>n°</th><th>bas (m)</th><th>haut (m)</th><th>surface (m²)</th><th>sommets</th></tr></thead><tbody>${rows}</tbody></table></div>
<h2>Toits mesurés (collision extérieure)</h2>
<p>Par morceau d'emprise : égout = quart bas des hauteurs du toit sur le bord, faîtage = point haut (99,5 %).</p>
<div class="table"><table><thead><tr><th>niveau</th><th>centre E ; N</th><th>surface (m²)</th><th>égout (m)</th><th>faîtage (m)</th></tr></thead><tbody>${statRows}</tbody></table></div>
<h3>Hauteur du dessus du toit (bleu ${fmt(roofRange.lo, 1)} m → rouge ${fmt(roofRange.hi, 1)} m), contours de tous les prismes</h3>
<svg class="top" viewBox="0 0 ${round(RW)} ${round(RH)}"><image href="controle/toits.png" width="${round(RW)}" height="${round(RH)}" preserveAspectRatio="none" style="image-rendering:pixelated"/>${roofShapes}</svg>
<h2>Vues de dessus par niveau</h2>
<p>Pointillé noir : emprise tirée de la carte des murs. Couleur pleine : prismes qui contiennent les yeux (sol + ${fmt(EYE, 1)} m) ; tirets : prismes qui touchent le niveau.
${trajectory ? 'Points : trajectoire du scanner (vert dedans, gris dehors) ; cercles numérotés : bascules le long de la trajectoire (vert entrée, rouge sortie). Une bascule hors d\'une porte signale un contour faux.' : ''}</p>
${levelViews}
<h2>Coupes verticales par façade</h2>
<p>Modèle extérieur, quasi orthographique. Rectangles : partie de chaque prisme comprise dans la tranche (pointillé : prisme hors tranche, étendue totale) ; pointillés gris : sols des niveaux.</p>
${sectionViews}
${trajectory ? `<h2>Bascules sur la trajectoire du scanner</h2><p>${trajectory.poses.length} poses (une par ${fmt(POSE_STEP, 1)} s).</p>
<div class="table"><table><thead><tr><th>n°</th><th>sens</th><th>E</th><th>N</th><th>H</th><th>temps</th></tr></thead><tbody>${crossRows}</tbody></table></div>` : ''}
</main></body></html>
`;
    writeFileSync(join(volumeDir, 'controle.html'), html);
};

// --- écriture dans le project.json -------------------------------------------

// Réécrit le project.json avec les niveaux de carte et les prismes sur une
// ligne chacun, seulement s'il a déjà cette forme ou celle de JSON.stringify(…, 2).
const formatProject = (obj) => {
    const blocks = [];
    const copy = structuredClone(obj);
    const inline = v => JSON.stringify(v).replace(/,/g, ', ').replace(/:/g, ': ');
    for (const sc of copy.scenes) {
        for (const list of [sc.map?.levels, sc.interior?.volume]) {
            if (!list) continue;
            list.forEach((item, i) => {
                blocks.push(item);
                list[i] = `__LINE_${blocks.length - 1}__`;
            });
        }
    }
    return JSON.stringify(copy, null, 2).replace(/"__LINE_(\d+)__"/g, (_, i) => inline(blocks[Number(i)]));
};

const writeVolume = (prisms) => {
    const volume = prisms.map(p => ({ outline: p.outline, floor: p.floor, top: p.top }));
    const original = JSON.parse(projectText);
    const text = projectText.trim();
    if (text !== JSON.stringify(original, null, 2) && text !== formatProject(original)) {
        console.log(`\n${relative(process.cwd(), projectPath)} n'a pas la forme attendue : volume à recopier à la main dans interior de la scène « ${scene.id} » :`);
        console.log(`"volume": ${JSON.stringify(volume)}`);
        return false;
    }
    original.scenes.find(s => s.id === scene.id).interior.volume = volume;
    writeFileSync(projectPath, `${formatProject(original)}\n`);
    return true;
};

// --- principal ---------------------------------------------------------------

const t0 = Date.now();
const config = readConfig();
const result = computeVolume(config);
mkdirSync(controlDir, { recursive: true });
const trajectory = trajectoryCrossings(config, result.prisms);
const sections = renderSections(config, result.prisms);
writeControl(config, result, trajectory, sections);
writeFileSync(join(controlDir, 'resultat.json'), `${JSON.stringify({
    prisms: result.prisms,
    roofs: result.stats,
    heights: result.heights,
    crossings: trajectory?.crossings ?? null
}, null, 2)}\n`);

for (const f of result.footprints) {
    console.log(`${f.level.id.padEnd(4)} sol ${fmt(f.level.floor).padStart(6)} m : emprise ${fmt(f.area, 1).padStart(7)} m² (${f.kept} morceau${f.kept > 1 ? 'x' : ''})` +
        `${f.dropped.length ? `, ${f.dropped.length} enclos sans pièce écarté${f.dropped.length > 1 ? 's' : ''}` : ''}`);
}
for (const s of result.stats) {
    console.log(`toit ${s.level} (${fmt(s.at[0], 1)} ; ${fmt(s.at[1], 1)}, ${fmt(s.area, 1)} m²) : égout ${fmt(s.eave)} m, faîtage ${fmt(s.ridge)} m`);
}
console.log('');
result.prisms.forEach((p, i) => console.log(`prisme ${String(i + 1).padStart(2)} : ${fmt(p.floor).padStart(6)} → ${fmt(p.top).padStart(6)} m, ${fmt(p.area, 1).padStart(6)} m², ${p.outline.length} sommets`));
if (trajectory) {
    console.log(`\ntrajectoire : ${trajectory.poses.length} poses, ${trajectory.crossings.length} bascules`);
}
const written = opts.write && writeVolume(result.prisms);
console.log(`\ncalculé en ${fmt((Date.now() - t0) / 1000, 1)} s${written ? `, volume écrit dans ${relative(process.cwd(), projectPath)}` : opts.write ? '' : ' (project.json inchangé : --write pour écrire)'}.`);
console.log(`planche : ${relative(process.cwd(), join(volumeDir, 'controle.html'))}`);
