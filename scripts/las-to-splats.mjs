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
//   --levels <n>        nombre de niveaux de LOD (défaut 5) ; chaque niveau garde
//                       la moitié des points du précédent, en points plus gros
//   --offset <x,y,z>    offset retiré aux coordonnées (défaut : celui du LAS)
//   --lcc <modèle.lcc>  reprend l'offset et l'epsg du .lcc des splats, pour que
//                       nuage et splats partagent exactement le même repère
//   --epsg <code>       système du nuage, si le LAS ne le déclare pas
//   --settings <json>   écrit epsg/offset/heightRef dans le bloc « coordinates »
//   --height-ref <ellipsoid|ngf>  nature de H (défaut ellipsoid)
//   --keep-noise        garde les classes 7 et 18 (bruit), retirées par défaut
//
// Chaque niveau est écrit en PLY 3DGS (lod0.ply, lod1.ply…), offset retiré,
// dans le repère où splat-transform v3.3.3 place un .lcc (sans -r, son lecteur
// .lcc l'oriente déjà) : (E, N, H) → (E, −H, N). Le viewer garde donc son
// sourceFromWorld par défaut. La commande splat-transform à lancer est affichée
// à la fin.
//
// Les LAZ sont décompressés par PDAL (`pdal translate`) dans le dossier de
// sortie avant lecture.

import { execFileSync } from 'child_process';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from 'fs';
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
const opts = { size: 0.015, levels: 5, keepNoise: false };
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
if (!Number.isInteger(opts.levels) || opts.levels < 1 || opts.levels > 10) fail('--levels doit être un entier entre 1 et 10');
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

// Tirage déterministe par point (hachage de l'indice) : le niveau k garde les
// points de tirage < 2^-k. Les niveaux sont emboîtés et les effectifs se
// calculent sans relire le fichier.
const hash01 = (i) => {
    let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
};

// Nombre de niveaux auxquels appartient le point : 1 = niveau 0 seul.
const levelsOf = (i) => {
    const u = hash01(i);
    let n = 1;
    while (n < opts.levels && u < 2 ** -n) n++;
    return n;
};

// Un niveau garde 2^-k des points : leur espacement sur une surface croît de
// √2^k, la taille des points aussi pour boucher les trous.
// Écart-type de la gaussienne = diamètre / 4 : opacité ≈ 13 % au bord du disque.
const logScales = [];
for (let k = 0; k < opts.levels; k++) {
    logScales.push(Math.log(opts.size * Math.SQRT2 ** k / 4));
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

// --- premier passage : points gardés ----------------------------------------

// Le filtrage du bruit change les effectifs : un passage léger ne lit que la
// classification pour écrire des en-têtes PLY exacts.
const keptMask = new Uint8Array(pointCount);
const counts = new Array(opts.levels).fill(0);
const readBuf = Buffer.alloc(CHUNK_POINTS * recordLength);
for (let first = 0; first < pointCount; first += CHUNK_POINTS) {
    const n = Math.min(CHUNK_POINTS, pointCount - first);
    readSync(fd, readBuf, 0, n * recordLength, pointDataOffset + first * recordLength);
    for (let p = 0; p < n; p++) {
        const cls = readBuf.readUInt8(p * recordLength + classOffset) & classMask;
        if (!opts.keepNoise && NOISE_CLASSES.has(cls)) continue;
        const levels = levelsOf(first + p);
        keptMask[first + p] = levels;
        for (let k = 0; k < levels; k++) counts[k]++;
    }
}

// --- second passage : écriture des PLY ---------------------------------------

const plyHeader = count => [
    'ply',
    'format binary_little_endian 1.0',
    `element vertex ${count}`,
    ...PLY_PROPERTIES.map(p => `property float ${p}`),
    'end_header',
    ''
].join('\n');

const outputs = counts.map((count, k) => {
    const path = join(outDir, `lod${k}.ply`);
    const out = openSync(path, 'w');
    writeSync(out, plyHeader(count));
    return { path, fd: out, buf: new Float32Array(CHUNK_POINTS * PLY_PROPERTIES.length), used: 0 };
});

const bboxMin = [Infinity, Infinity, Infinity];
const bboxMax = [-Infinity, -Infinity, -Infinity];

for (let first = 0; first < pointCount; first += CHUNK_POINTS) {
    const n = Math.min(CHUNK_POINTS, pointCount - first);
    readSync(fd, readBuf, 0, n * recordLength, pointDataOffset + first * recordLength);
    for (const o of outputs) o.used = 0;

    for (let p = 0; p < n; p++) {
        const levels = keptMask[first + p];
        if (!levels) continue;
        const at = p * recordLength;
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

        for (let k = 0; k < levels; k++) {
            const o = outputs[k];
            const s = logScales[k];
            const v = o.buf;
            let w = o.used++ * PLY_PROPERTIES.length;
            // Rotation de 90° autour de X : repère des .lcc après splat-transform.
            v[w++] = x; v[w++] = -z; v[w++] = y;
            v[w++] = (r - 0.5) / SH_C0; v[w++] = (g - 0.5) / SH_C0; v[w++] = (b - 0.5) / SH_C0;
            v[w++] = OPACITY_LOGIT;
            v[w++] = s; v[w++] = s; v[w++] = s;
            v[w++] = 1; v[w++] = 0; v[w++] = 0; v[w] = 0;
        }
    }

    for (const o of outputs) {
        writeSync(o.fd, new Uint8Array(o.buf.buffer, 0, o.used * PLY_PROPERTIES.length * 4));
    }
    process.stdout.write(`\r${Math.round(100 * (first + n) / pointCount)} %`);
}
process.stdout.write('\n');

for (const o of outputs) closeSync(o.fd);
closeSync(fd);
if (tempLas) rmSync(tempLas);

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
outputs.forEach((o, k) => console.log(`  ${o.path} : ${counts[k]} points, diamètre ${(opts.size * Math.SQRT2 ** k * 100).toFixed(1)} cm`));

const lodArgs = outputs.map((o, k) => `${o.path} -l ${k}`).join(' ');
console.log('\nPuis (sans -r : la rotation est déjà dans les PLY) :');
console.log(`splat-transform -w --lod-chunk-count 256 ${lodArgs} ${join(outDir, 'lod-meta.json')}`);
