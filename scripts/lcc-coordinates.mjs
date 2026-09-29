#!/usr/bin/env node
// ARTLIGHT (TKT-227)
//
// Recopie le géoréférencement d'un .lcc (« offset » et « epsg ») dans le bloc
// « coordinates » du settings.json de la scène, que splat-transform ne conserve
// pas. À lancer après chaque conversion d'un modèle géoréférencé.
//
//   node scripts/lcc-coordinates.mjs <modèle.lcc> <settings.json> [--height-ref ellipsoid|ngf]
//
// L'offset est recopié tel qu'il est écrit dans le .lcc, sans passer par un
// nombre JS, pour garder toutes ses décimales. Les autres champs du bloc
// (sourceFromWorld…) sont conservés. Un .lcc avec epsg 0 retire epsg et offset
// du bloc : la scène reste en repère local.

import { readFileSync, writeFileSync } from 'fs';

const HEIGHT_REFS = ['ellipsoid', 'ngf'];

const fail = (message) => {
    console.error(`lcc-coordinates : ${message}`);
    process.exit(1);
};

const args = process.argv.slice(2);
let heightRef = null;
const files = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--height-ref') {
        heightRef = args[++i];
        if (!HEIGHT_REFS.includes(heightRef)) fail(`--height-ref doit valoir ${HEIGHT_REFS.join(' ou ')}`);
    } else {
        files.push(args[i]);
    }
}
if (files.length !== 2) {
    fail('usage : node scripts/lcc-coordinates.mjs <modèle.lcc> <settings.json> [--height-ref ellipsoid|ngf]');
}
const [lccPath, settingsPath] = files;

const lccText = readFileSync(lccPath, 'utf-8');
const lcc = JSON.parse(lccText);

// Littéraux numériques d'un champ tableau, tels qu'écrits dans le fichier.
const rawArray = (text, key) => {
    const match = new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*)\\]`).exec(text);
    return match ? match[1].split(',').map(v => v.trim()) : null;
};

const epsg = lcc.epsg ?? 0;
if (!Number.isInteger(epsg)) fail(`epsg illisible dans ${lccPath}`);

const offsetRaw = rawArray(lccText, 'offset');
if (epsg !== 0) {
    if (!offsetRaw || offsetRaw.length !== 3 || offsetRaw.some(v => !Number.isFinite(Number(v)))) {
        fail(`offset illisible dans ${lccPath}`);
    }
}

// shift et scale ne sont pas pris en compte par le viewer : geo = source + offset.
const isIdentity = (v, expected) => !v || v.every(n => n === expected);
if (!isIdentity(lcc.shift, 0) || !isIdentity(lcc.scale, 1)) {
    fail(`shift ${JSON.stringify(lcc.shift)} ou scale ${JSON.stringify(lcc.scale)} non neutres : non géré, voir src/coordinates.ts`);
}

const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
const coordinates = { ...settings.coordinates };
delete coordinates.epsg;
delete coordinates.offset;

// Marqueur remplacé après sérialisation par les littéraux du .lcc.
const OFFSET_MARK = '__LCC_OFFSET__';
if (epsg !== 0) {
    coordinates.epsg = epsg;
    coordinates.offset = OFFSET_MARK;
    coordinates.heightRef = heightRef ?? coordinates.heightRef ?? 'ellipsoid';
} else if (heightRef) {
    coordinates.heightRef = heightRef;
}

if (Object.keys(coordinates).length > 0) {
    settings.coordinates = coordinates;
} else {
    delete settings.coordinates;
}

const out = JSON.stringify(settings, null, 2).replace(`"${OFFSET_MARK}"`, `[${offsetRaw?.join(', ')}]`);
writeFileSync(settingsPath, `${out}\n`);

console.log(epsg !== 0 ?
    `${settingsPath} : epsg ${epsg}, offset [${offsetRaw.join(', ')}], heightRef ${coordinates.heightRef}` :
    `${settingsPath} : epsg 0, repère local`);
