#!/usr/bin/env node
// ARTLIGHT (TKT-228)
//
// Convertit un nuage LiDAR LAS/LAZ en « splats-points » : un petit splat
// isotrope opaque par point, avec sa couleur RVB. Le résultat passe ensuite
// dans le pipeline LOD habituel (splat-transform → lod-meta.json), et le viewer
// l'affiche et le mesure comme n'importe quelle scène.
//
//   node scripts/las-to-splats.mjs <nuage.las|.laz> <dossier de sortie> [options]
//
// Options :
//   --size <m>          diamètre apparent d'un point au niveau 0 (défaut 0.015)
//   --levels <n>        nombre de niveaux de LOD. Le niveau 0 garde tous les
//                       points ; le niveau k ≥ 1 met un point par voxel occupé,
//                       de diamètre size·√2^k pour un voxel deux fois plus
//                       petit. Défaut : 5, ou plus pour que le dernier tienne
//                       en 1 M de points
//   --offset <x,y,z>    offset retiré aux coordonnées (défaut : celui du LAS)
//   --lcc <modèle.lcc>  reprend l'offset et l'epsg du .lcc des splats, pour que
//                       nuage et splats partagent exactement le même repère
//   --epsg <code>       système du nuage, si le LAS ne le déclare pas
//   --settings <json>   écrit epsg/offset/heightRef dans le bloc « coordinates »
//   --height-ref <ellipsoid|ngf>  nature de H (défaut ellipsoid)
//   --keep-noise        garde les classes 7 et 18 (bruit), retirées par défaut
//
// TKT-286 : un point d'un niveau grossier est la moyenne des points de son
// voxel (position, et couleur en lumière linéaire), et non plus un point tiré
// au hasard : la couleur ne varie plus d'un point à l'autre (rendu « poivre et
// sel »), et la couverture est régulière. Le niveau 0 reste le relevé brut,
// au point près.
//
// Le nuage est gardé en mémoire (environ 20 octets par point : 3,4 Go pour
// 170 M points) et traité par blocs cubiques de 256 voxels du niveau 1 de côté.
// Environ 3,5 min pour les 170 M points de Saint-Germain sur un M1 Max.
//
// Chaque niveau est écrit en PLY 3DGS (lod0.ply, lod1.ply…), offset retiré,
// dans le repère où splat-transform (v3.3.3 et v3.10.0) place un .lcc (sans -r, son lecteur
// .lcc l'oriente déjà) : (E, N, H) → (E, −H, N). Le viewer garde donc son
// sourceFromWorld par défaut. La commande splat-transform à lancer est affichée
// à la fin.
//
// Les LAZ sont décompressés par PDAL (`pdal translate`) dans le dossier de
// sortie avant lecture.

import { execFileSync } from 'child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'fs';
import { basename, join } from 'path';

const HEIGHT_REFS = ['ellipsoid', 'ngf'];

// Classes ASPRS « bruit bas » et « bruit haut ».
const NOISE_CLASSES = new Set([7, 18]);

// Coefficient de la bande 0 des harmoniques sphériques : f_dc = (c - 0,5) / SH_C0.
const SH_C0 = 0.28209479177387814;

// Opacité quasi pleine (sigmoïde(8) ≈ 0,9997) : le point est opaque, le pick
// tombe sur sa surface et non sur une profondeur moyenne.
const OPACITY_LOGIT = 8;

// Nombre de points lus par bloc.
const CHUNK_POINTS = 1 << 20;

// Propriétés d'un splat PLY, toutes en float32.
const PLY_PROPERTIES = [
    'x', 'y', 'z',
    'f_dc_0', 'f_dc_1', 'f_dc_2',
    'opacity',
    'scale_0', 'scale_1', 'scale_2',
    'rot_0', 'rot_1', 'rot_2', 'rot_3'
];

const fail = (message) => {
    console.error(`las-to-splats : ${message}`);
    process.exit(1);
};

// --- arguments ---------------------------------------------------------------

const args = process.argv.slice(2);
const opts = { size: 0.015, keepNoise: false };
const files = [];
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => {
        if (i + 1 >= args.length) fail(`${a} attend une valeur`);
        return args[++i];
    };
    switch (a) {
        case '--size': opts.size = Number(next()); break;
        case '--levels': opts.levels = Number(next()); break;
        case '--offset': opts.offsetRaw = next().split(',').map(v => v.trim()); break;
        case '--lcc': opts.lcc = next(); break;
        case '--epsg': opts.epsg = Number(next()); break;
        case '--settings': opts.settings = next(); break;
        case '--height-ref': opts.heightRef = next(); break;
        case '--keep-noise': opts.keepNoise = true; break;
        default:
            if (a.startsWith('--')) fail(`option inconnue ${a}`);
            files.push(a);
    }
}
if (files.length !== 2) {
    fail('usage : node scripts/las-to-splats.mjs <nuage.las|.laz> <dossier de sortie> [--size m] [--levels n] [--offset x,y,z | --lcc modèle.lcc] [--epsg code] [--settings settings.json] [--height-ref ellipsoid|ngf] [--keep-noise]');
}
if (!(opts.size > 0)) fail('--size doit être un nombre positif, en mètres');
if (opts.levels !== undefined && (!Number.isInteger(opts.levels) || opts.levels < 1 || opts.levels > 10)) {
    fail('--levels doit être un entier entre 1 et 10');
}
if (opts.heightRef && !HEIGHT_REFS.includes(opts.heightRef)) fail(`--height-ref doit valoir ${HEIGHT_REFS.join(' ou ')}`);
if (opts.offsetRaw && opts.lcc) fail('--offset et --lcc sont exclusifs');
if (opts.offsetRaw && (opts.offsetRaw.length !== 3 || opts.offsetRaw.some(v => !Number.isFinite(Number(v))))) {
    fail('--offset attend x,y,z');
}
if (opts.epsg !== undefined && !Number.isInteger(opts.epsg)) fail('--epsg attend un code entier');

const [inputPath, outDir] = files;
mkdirSync(outDir, { recursive: true });

// --- LAZ → LAS ---------------------------------------------------------------

let lasPath = inputPath;
let tempLas = null;
if (inputPath.toLowerCase().endsWith('.laz')) {
    tempLas = join(outDir, `${basename(inputPath, '.laz')}.tmp.las`);
    console.log(`Décompression LAZ avec PDAL → ${tempLas}`);
    try {
        execFileSync('pdal', ['translate', inputPath, tempLas], { stdio: 'inherit' });
    } catch {
        fail('PDAL est nécessaire pour lire un .laz (brew install pdal), ou fournir un .las');
    }
    lasPath = tempLas;
}

// --- en-tête LAS -------------------------------------------------------------

const fd = openSync(lasPath, 'r');
const head = Buffer.alloc(375);
readSync(fd, head, 0, head.length, 0);
if (head.toString('ascii', 0, 4) !== 'LASF') fail(`${lasPath} n'est pas un fichier LAS`);

const versionMinor = head.readUInt8(25);
const headerSize = head.readUInt16LE(94);
const pointDataOffset = head.readUInt32LE(96);
const vlrCount = head.readUInt32LE(100);
const rawFormat = head.readUInt8(104);
if (rawFormat & 0xc0) fail('points compressés (LAZ renommé en .las ?) : décompresser avec PDAL');
const pointFormat = rawFormat & 0x3f;
const recordLength = head.readUInt16LE(105);
const scale = [head.readDoubleLE(131), head.readDoubleLE(139), head.readDoubleLE(147)];
const lasOffset = [head.readDoubleLE(155), head.readDoubleLE(163), head.readDoubleLE(171)];
const max = [head.readDoubleLE(179), head.readDoubleLE(195), head.readDoubleLE(211)];
const min = [head.readDoubleLE(187), head.readDoubleLE(203), head.readDoubleLE(219)];
const pointCount = versionMinor >= 4 && headerSize >= 255 ?
    Number(head.readBigUInt64LE(247)) :
    head.readUInt32LE(107);

// TKT-233 : le moteur garde toujours chargé le niveau le plus grossier, même
// au-delà du budget. Avec 5 niveaux, les 170 M points de Saint-Germain en
// laissaient 10,6 M pour un budget mobile de 2 M. On ajoute des niveaux
// jusqu'à ce que le dernier tienne en 1 M (budget Standard).
// TKT-286 : l'effectif d'un niveau par voxels n'est connu qu'une fois calculé.
// Sans --levels, les 10 niveaux sont calculés, et on garde jusqu'au premier
// qui tient en 1 M (5 niveaux au moins).
const COARSEST_MAX_POINTS = 1e6;
const MIN_LEVELS = 5;
const MAX_LEVELS = 10;
const levelCount = opts.levels ?? MAX_LEVELS;

// Position de la couleur RVB et de la classification selon le format de point.
const RGB_OFFSETS = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };
const rgbOffset = RGB_OFFSETS[pointFormat] ?? null;
const classOffset = pointFormat >= 6 ? 16 : 15;
const classMask = pointFormat >= 6 ? 0xff : 0x1f;
if (pointFormat > 10) fail(`format de point ${pointFormat} non géré`);

// --- système de coordonnées --------------------------------------------------

// Code EPSG déclaré dans les VLR : GeoKeyDirectory (34735) ou WKT (2112).
const readEpsgFromVlrs = () => {
    let pos = headerSize;
    const vlrHead = Buffer.alloc(54);
    for (let v = 0; v < vlrCount; v++) {
        readSync(fd, vlrHead, 0, 54, pos);
        const userId = vlrHead.toString('ascii', 2, 18).replace(/\0.*$/, '');
        const recordId = vlrHead.readUInt16LE(18);
        const length = vlrHead.readUInt16LE(20);
        const data = Buffer.alloc(length);
        readSync(fd, data, 0, length, pos + 54);
        pos += 54 + length;
        if (userId !== 'LASF_Projection') continue;

        if (recordId === 34735) {
            const keys = data.readUInt16LE(6);
            for (let k = 0; k < keys; k++) {
                const at = 8 + k * 8;
                // ProjectedCSTypeGeoKey, valeur stockée directement (location 0).
                if (data.readUInt16LE(at) === 3072 && data.readUInt16LE(at + 2) === 0) {
                    const code = data.readUInt16LE(at + 6);
                    if (code > 0 && code < 32767) return code;
                }
            }
        } else if (recordId === 2112) {
            // WKT1 : l'autorité du PROJCS est la dernière qu'il contient.
            const wkt = data.toString('utf-8').replace(/\0.*$/s, '');
            const start = wkt.search(/PROJCS\[/);
            if (start < 0) continue;
            let depth = 0;
            let end = start;
            for (; end < wkt.length; end++) {
                if (wkt[end] === '[') depth++;
                if (wkt[end] === ']' && --depth === 0) break;
            }
            const authorities = [...wkt.slice(start, end + 1).matchAll(/AUTHORITY\["EPSG",\s*"(\d+)"\]/g)];
            if (authorities.length) return Number(authorities[authorities.length - 1][1]);
        }
    }
    return null;
};

const vlrEpsg = readEpsgFromVlrs();

// Offset retiré aux points : littéraux gardés tels quels pour le settings.json.
let offsetRaw;
let epsg;
if (opts.lcc) {
    const lccText = readFileSync(opts.lcc, 'utf-8');
    const lcc = JSON.parse(lccText);
    const match = /"offset"\s*:\s*\[([^\]]*)\]/.exec(lccText);
    offsetRaw = match?.[1].split(',').map(v => v.trim());
    if (!offsetRaw || offsetRaw.length !== 3) fail(`offset illisible dans ${opts.lcc}`);
    epsg = lcc.epsg ?? 0;
    if (opts.epsg !== undefined && opts.epsg !== epsg) fail(`--epsg ${opts.epsg} contredit l'epsg ${epsg} du .lcc`);
} else {
    offsetRaw = opts.offsetRaw ?? lasOffset.map(v => String(v));
    epsg = opts.epsg ?? vlrEpsg ?? null;
}
if (vlrEpsg !== null && epsg !== null && vlrEpsg !== epsg) {
    fail(`le LAS déclare EPSG:${vlrEpsg}, le repère visé est EPSG:${epsg} : reprojeter le nuage avant conversion`);
}
if (epsg === null) {
    fail('aucune projection déclarée dans le LAS : préciser --epsg (ex. 2154 pour Lambert-93)');
}
const offset = offsetRaw.map(Number);

// Décalage à appliquer aux coordonnées entières : local = X·scale + (offsetLAS − offset).
const shift = lasOffset.map((o, i) => o - offset[i]);

// --- niveaux de LOD ----------------------------------------------------------

// Diamètre des points du niveau k : size·√2^k. Écart-type de la gaussienne =
// diamètre / 4 : opacité ≈ 13 % au bord du disque.
const diameter = k => opts.size * Math.SQRT2 ** k;

// Niveau k ≥ 1 : un point par voxel occupé. Sur une surface, l'effectif est à
// peu près divisé par deux d'un niveau au suivant.
// TKT-286 : les centres forment une grille presque régulière sur un mur. Avec
// un diamètre de √2 fois le côté du voxel (la diagonale), la gaussienne ne
// couvre que 44 % du milieu d'une maille : le fond passe et dessine un
// quadrillage sur les murs. À deux fois le côté, la couverture monte à 84 %
// et le quadrillage disparaît.
const DIAMETER_PER_VOXEL = 2;
const voxelSide = k => diameter(k) / DIAMETER_PER_VOXEL;

// Un voxel peu rempli (point isolé, feuillage, bord) ne doit pas peser plus
// que ses points au niveau 0 : sans garde, un point de bruit devient une tache
// de plus en plus grosse, et un arbre une masse opaque. Un voxel est plein
// s'il a au moins les points d'une surface relevée tous les `size` (le
// diamètre du niveau 0) ; sinon son diamètre suit la racine de son
// remplissage, sans descendre sous celui du niveau 0.
const fullVoxelCount = k => 2 ** k / DIAMETER_PER_VOXEL ** 2; // (voxelSide(k) / diameter(0))², exact

// Blocs cubiques de BLOCK_VOXELS voxels du niveau 1 de côté. Le côté des
// voxels du niveau k est arrondi pour en mettre un nombre entier par bloc :
// la grille est la même partout et aucun voxel n'est à cheval sur deux blocs.
const BLOCK_VOXELS = 256;
const blockSize = BLOCK_VOXELS * voxelSide(1);
const voxelsPerBlock = [0];
for (let k = 1; k < levelCount; k++) {
    voxelsPerBlock.push(Math.max(1, Math.round(BLOCK_VOXELS / Math.SQRT2 ** (k - 1))));
}

// --- couleurs ----------------------------------------------------------------

// Certains logiciels écrivent le RVB sur 8 bits dans des champs 16 bits : on
// regarde un échantillon pour choisir le diviseur.
const colorDivisor = (() => {
    if (rgbOffset === null) return 1;
    const sample = Math.min(pointCount, 200000);
    const buf = Buffer.alloc(sample * recordLength);
    readSync(fd, buf, 0, buf.length, pointDataOffset);
    let maxValue = 0;
    for (let p = 0; p < sample; p++) {
        const at = p * recordLength + rgbOffset;
        maxValue = Math.max(maxValue, buf.readUInt16LE(at), buf.readUInt16LE(at + 2), buf.readUInt16LE(at + 4));
    }
    return maxValue > 255 ? 65535 : 255;
})();

// Couleur d'un voxel : moyenne en lumière linéaire, comme l'œil mélange de
// loin des points de couleurs différentes.
const SRGB_TO_LINEAR = new Float64Array(256);
for (let c = 0; c < 256; c++) {
    const v = c / 255;
    SRGB_TO_LINEAR[c] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
const linearToSrgb = v => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

// --- écriture des PLY --------------------------------------------------------

// L'effectif d'un niveau n'est connu qu'à la fin : l'en-tête est écrit avec
// un compte sur 10 chiffres (zéros en tête), réécrit à la fermeture.
const plyHeader = count => [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${String(count).padStart(10, '0')}`,
    ...PLY_PROPERTIES.map(p => `property float ${p}`),
    'end_header',
    ''
].join('\n');

const WRITE_POINTS = 1 << 16;

const openPly = (k) => {
    const path = join(outDir, `lod${k}.ply`);
    const out = openSync(path, 'w');
    writeSync(out, plyHeader(0));
    const logScale = Math.log(diameter(k) / 4);
    return { path, fd: out, count: 0, sparse: 0, logScale, buf: new Float32Array(WRITE_POINTS * PLY_PROPERTIES.length), used: 0 };
};

const flushPly = (o) => {
    writeSync(o.fd, new Uint8Array(o.buf.buffer, 0, o.used * PLY_PROPERTIES.length * 4));
    o.used = 0;
};

// Point en (E, N, H) local, couleur sRGB entre 0 et 1.
const writePoint = (o, e, n, h, r, g, b, logScale = o.logScale) => {
    if (o.used === WRITE_POINTS) flushPly(o);
    const v = o.buf;
    let w = o.used++ * PLY_PROPERTIES.length;
    // Rotation de 90° autour de X : repère des .lcc après splat-transform.
    v[w++] = e; v[w++] = -h; v[w++] = n;
    v[w++] = (r - 0.5) / SH_C0; v[w++] = (g - 0.5) / SH_C0; v[w++] = (b - 0.5) / SH_C0;
    v[w++] = OPACITY_LOGIT;
    v[w++] = logScale; v[w++] = logScale; v[w++] = logScale;
    v[w++] = 1; v[w++] = 0; v[w++] = 0; v[w] = 0;
    o.count++;
};

const closePly = (o) => {
    flushPly(o);
    writeSync(o.fd, plyHeader(o.count), 0);
    closeSync(o.fd);
};

// --- lecture : niveau 0, et nuage gardé en mémoire ---------------------------

// Points gardés, en (E, N, H) local, couleur sRGB sur 8 bits.
const px = new Float32Array(pointCount);
const py = new Float32Array(pointCount);
const pz = new Float32Array(pointCount);
const pc = new Uint8Array(pointCount * 3);
let kept = 0;

const bboxMin = [Infinity, Infinity, Infinity];
const bboxMax = [-Infinity, -Infinity, -Infinity];

const outputs = [openPly(0)];
const readBuf = Buffer.alloc(CHUNK_POINTS * recordLength);
for (let first = 0; first < pointCount; first += CHUNK_POINTS) {
    const n = Math.min(CHUNK_POINTS, pointCount - first);
    readSync(fd, readBuf, 0, n * recordLength, pointDataOffset + first * recordLength);

    for (let p = 0; p < n; p++) {
        const at = p * recordLength;
        const cls = readBuf.readUInt8(at + classOffset) & classMask;
        if (!opts.keepNoise && NOISE_CLASSES.has(cls)) continue;
        const x = readBuf.readInt32LE(at) * scale[0] + shift[0];
        const y = readBuf.readInt32LE(at + 4) * scale[1] + shift[1];
        const z = readBuf.readInt32LE(at + 8) * scale[2] + shift[2];

        let r;
        let g;
        let b;
        if (rgbOffset !== null) {
            r = readBuf.readUInt16LE(at + rgbOffset) / colorDivisor;
            g = readBuf.readUInt16LE(at + rgbOffset + 2) / colorDivisor;
            b = readBuf.readUInt16LE(at + rgbOffset + 4) / colorDivisor;
        } else {
            r = g = b = readBuf.readUInt16LE(at + 12) / 65535;
        }

        bboxMin[0] = Math.min(bboxMin[0], x); bboxMax[0] = Math.max(bboxMax[0], x);
        bboxMin[1] = Math.min(bboxMin[1], y); bboxMax[1] = Math.max(bboxMax[1], y);
        bboxMin[2] = Math.min(bboxMin[2], z); bboxMax[2] = Math.max(bboxMax[2], z);

        writePoint(outputs[0], x, y, z, r, g, b);
        px[kept] = x; py[kept] = y; pz[kept] = z;
        pc[3 * kept] = Math.round(r * 255);
        pc[3 * kept + 1] = Math.round(g * 255);
        pc[3 * kept + 2] = Math.round(b * 255);
        kept++;
    }
    process.stdout.write(`\rlecture ${Math.round(100 * (first + n) / pointCount)} %`);
}
process.stdout.write('\n');
closePly(outputs[0]);
closeSync(fd);
if (tempLas) rmSync(tempLas);

// --- niveaux 1 et suivants : moyennes par voxel -------------------------------

if (levelCount > 1 && kept > 0) {
    // Tri des points par bloc (dénombrement) : order les liste bloc après bloc.
    const blocks = [0, 1, 2].map(a => Math.max(1, Math.ceil((bboxMax[a] - bboxMin[a]) / blockSize)));
    const blockCount = blocks[0] * blocks[1] * blocks[2];
    if (blockCount > 1 << 24) fail(`emprise trop grande pour --size ${opts.size} (${blockCount} blocs)`);
    const blockAxis = (v, a) => Math.min(blocks[a] - 1, Math.max(0, Math.floor((v - bboxMin[a]) / blockSize)));
    const blockOf = i => (blockAxis(px[i], 0) * blocks[1] + blockAxis(py[i], 1)) * blocks[2] + blockAxis(pz[i], 2);

    const blockStart = new Uint32Array(blockCount + 1);
    for (let i = 0; i < kept; i++) blockStart[blockOf(i) + 1]++;
    let maxBlock = 0;
    for (let bl = 0; bl < blockCount; bl++) {
        maxBlock = Math.max(maxBlock, blockStart[bl + 1]);
        blockStart[bl + 1] += blockStart[bl];
    }
    const order = new Uint32Array(kept);
    const fill = blockStart.slice(0, blockCount);
    for (let i = 0; i < kept; i++) order[fill[blockOf(i)]++] = i;

    // Clé de tri d'un point : numéro du voxel dans le bloc, puis rang du point
    // dans le bloc, dans un float64 exact (53 bits).
    const indexScale = 2 ** Math.max(1, Math.ceil(Math.log2(maxBlock)));
    if (BLOCK_VOXELS ** 3 * indexScale > 2 ** 53) fail(`trop de points dans un bloc (${maxBlock}) : augmenter --size`);

    const lx = new Float32Array(maxBlock);
    const ly = new Float32Array(maxBlock);
    const lz = new Float32Array(maxBlock);
    const lc = new Uint8Array(maxBlock * 3);
    const keys = new Float64Array(maxBlock);

    for (let k = 1; k < levelCount; k++) outputs.push(openPly(k));

    let done = 0;
    for (let bl = 0; bl < blockCount; bl++) {
        const start = blockStart[bl];
        const m = blockStart[bl + 1] - start;
        if (m === 0) continue;

        // Points du bloc, relatifs à son coin.
        const bz = bl % blocks[2];
        const by = Math.floor(bl / blocks[2]) % blocks[1];
        const bx = Math.floor(bl / (blocks[1] * blocks[2]));
        const ox = bboxMin[0] + bx * blockSize;
        const oy = bboxMin[1] + by * blockSize;
        const oz = bboxMin[2] + bz * blockSize;
        for (let j = 0; j < m; j++) {
            const i = order[start + j];
            lx[j] = px[i] - ox; ly[j] = py[i] - oy; lz[j] = pz[i] - oz;
            lc[3 * j] = pc[3 * i]; lc[3 * j + 1] = pc[3 * i + 1]; lc[3 * j + 2] = pc[3 * i + 2];
        }

        for (let k = 1; k < levelCount; k++) {
            const nv = voxelsPerBlock[k];
            const toVoxel = nv / blockSize;
            const cell = v => Math.min(nv - 1, Math.max(0, Math.floor(v * toVoxel)));
            for (let j = 0; j < m; j++) {
                keys[j] = ((cell(lx[j]) * nv + cell(ly[j])) * nv + cell(lz[j])) * indexScale + j;
            }
            const sorted = keys.subarray(0, m).sort();

            const o = outputs[k];
            const fullCount = fullVoxelCount(k);
            let j = 0;
            while (j < m) {
                const end = (Math.floor(sorted[j] / indexScale) + 1) * indexScale;
                let count = 0;
                let se = 0;
                let sn = 0;
                let sh = 0;
                let sr = 0;
                let sg = 0;
                let sb = 0;
                for (; j < m && sorted[j] < end; j++) {
                    const q = sorted[j] % indexScale;
                    se += lx[q]; sn += ly[q]; sh += lz[q];
                    sr += SRGB_TO_LINEAR[lc[3 * q]];
                    sg += SRGB_TO_LINEAR[lc[3 * q + 1]];
                    sb += SRGB_TO_LINEAR[lc[3 * q + 2]];
                    count++;
                }
                let logScale = o.logScale;
                if (count < fullCount) {
                    logScale = Math.log(Math.max(diameter(0), diameter(k) * Math.sqrt(count / fullCount)) / 4);
                    o.sparse++;
                }
                writePoint(o, ox + se / count, oy + sn / count, oz + sh / count,
                    linearToSrgb(sr / count), linearToSrgb(sg / count), linearToSrgb(sb / count), logScale);
            }
        }

        done += m;
        process.stdout.write(`\rniveaux 1 à ${levelCount - 1} : ${Math.round(100 * done / kept)} %`);
    }
    process.stdout.write('\n');
    for (let k = 1; k < levelCount; k++) closePly(outputs[k]);
}

// Sans --levels : on s'arrête au premier niveau qui tient en 1 M de points.
if (opts.levels === undefined) {
    let levels = outputs.length;
    for (let k = MIN_LEVELS - 1; k < outputs.length; k++) {
        if (outputs[k].count <= COARSEST_MAX_POINTS) {
            levels = k + 1;
            break;
        }
    }
    for (const o of outputs.splice(levels)) unlinkSync(o.path);
}
const coarsest = outputs[outputs.length - 1];
if (coarsest.count > COARSEST_MAX_POINTS) {
    console.warn(`Attention : le niveau le plus grossier garde ${coarsest.count} points, chargés quel que soit le budget`);
}

// --- settings.json -----------------------------------------------------------

if (opts.settings) {
    const settings = JSON.parse(readFileSync(opts.settings, 'utf-8'));
    const coordinates = { ...settings.coordinates };
    delete coordinates.epsg;
    delete coordinates.offset;
    const OFFSET_MARK = '__LAS_OFFSET__';
    if (epsg !== 0) {
        coordinates.epsg = epsg;
        coordinates.offset = OFFSET_MARK;
        coordinates.heightRef = opts.heightRef ?? coordinates.heightRef ?? 'ellipsoid';
    }
    if (Object.keys(coordinates).length > 0) {
        settings.coordinates = coordinates;
    } else {
        delete settings.coordinates;
    }
    const out = JSON.stringify(settings, null, 2).replace(`"${OFFSET_MARK}"`, `[${offsetRaw.join(', ')}]`);
    writeFileSync(opts.settings, `${out}\n`);
    console.log(`${opts.settings} : epsg ${epsg}, offset [${offsetRaw.join(', ')}]`);
}

// --- résumé ------------------------------------------------------------------

const fmt = v => v.map(n => n.toFixed(3)).join(', ');
console.log(`Nuage : ${pointCount} points, format ${pointFormat}, EPSG:${epsg}${vlrEpsg === null ? ' (non déclaré dans le LAS)' : ''}`);
console.log(`Emprise LAS : min (${fmt(min)}) max (${fmt(max)})`);
console.log(`Offset retiré : [${offsetRaw.join(', ')}]`);
console.log(`Emprise locale (E, N, H) : min (${fmt(bboxMin)}) max (${fmt(bboxMax)})`);
console.log(`Centre dans le moteur (−E, H, N) : ${fmt([-(bboxMin[0] + bboxMax[0]) / 2, (bboxMin[2] + bboxMax[2]) / 2, (bboxMin[1] + bboxMax[1]) / 2])}`);
outputs.forEach((o, k) => {
    const source = k === 0 ? 'relevé brut' : `voxels de ${(blockSize / voxelsPerBlock[k] * 100).toFixed(1)} cm`;
    const sparse = k === 0 ? '' : ` (${(100 * o.sparse / Math.max(1, o.count)).toFixed(1)} % de voxels peu remplis, plus petits)`;
    console.log(`  ${o.path} : ${o.count} points, ${source}, diamètre ${(diameter(k) * 100).toFixed(1)} cm${sparse}`);
});

const lodArgs = outputs.map((o, k) => `${o.path} -l ${k}`).join(' ');
console.log('\nPuis (sans -r : la rotation est déjà dans les PLY) :');
console.log(`splat-transform -w --lod-chunk-count 256 ${lodArgs} ${join(outDir, 'lod-meta.json')}`);
