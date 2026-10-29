#!/usr/bin/env node
// ARTLIGHT (TKT-297)
//
// Banc de l'étape « propose » de scene-map.mjs : compare les niveaux proposés
// aux levels.json corrigés à la main.
//
//   node scripts/mesure-propose.mjs <cas.json> --cache <dossier> [--avant <dossier>] [--details] [--json <sortie>]
//
// cas.json : [{ "id", "content": "<lod-meta.json | .sog>", "verite": "<levels.json corrigé>",
//               "type": "interieur|exterieur|mixte"?, "horsEchantillon": true? }]. Les sources sont seulement lues.
// --avec-type : passe à la décision le type de scène du cas (ce qu'un opérateur dirait), au lieu de « auto ».
// --cache : PLY du LOD 1 de chaque scène (gros : ≈ 56 octets par splat), refait s'il manque.
// --avant : dossier où l'ancienne version de propose a écrit <id>/map/levels.json (même LOD,
//           mêmes sources), pour le tableau avant / après.
//
// Un niveau proposé « est » un niveau de la vérité si leurs sols sont à 40 cm près.
// Par scène : vrais gardés, faux gardés, vrais écartés, et la vue d'avion (juste ou non).
// Une carte « passe telle quelle » quand l'ensemble gardé (niveaux et vue d'avion) est
// celui de la vérité ; noms, coupes et sol de la vue d'avion ne comptent pas (à part).

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

import { decideLevels, detectLevels, readSplatsPly } from './scene-map-niveaux.mjs';


const args = process.argv.slice(2);
const opts = { details: false };
const positional = [];
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--cache') opts.cache = resolve(args[++i]);
    else if (a === '--avant') opts.avant = resolve(args[++i]);
    else if (a === '--json') opts.json = resolve(args[++i]);
    else if (a === '--details') opts.details = true;
    else if (a === '--avec-type') opts.withType = true;
    else if (a.startsWith('--')) throw new Error(`option inconnue ${a}`);
    else positional.push(a);
}
if (!positional[0] || !opts.cache) {
    console.error('usage : node scripts/mesure-propose.mjs <cas.json> --cache <dossier> [--avant <dossier>] [--details] [--json <sortie>]');
    process.exit(1);
}
const cases = JSON.parse(readFileSync(positional[0], 'utf-8'));
mkdirSync(opts.cache, { recursive: true });

const TOL = 0.4;

const plyOf = (c) => {
    const ply = join(opts.cache, `${c.id}.ply`);
    if (!existsSync(ply)) {
        const lod = c.content.endsWith('lod-meta.json') ? (() => {
            const meta = JSON.parse(readFileSync(c.content, 'utf-8'));
            return ['-L', String(Math.min(1, (meta.lodLevels ?? 1) - 1))];
        })() : [];
        execFileSync('splat-transform', ['-q', '-w', ...lod, c.content, '-H', '0', ply], { stdio: ['ignore', 'ignore', 'inherit'] });
    }
    return ply;
};

// Ensemble gardé d'un levels.json : sols des niveaux gardés, et la vue d'avion.
const keptOf = levels => ({
    floors: levels.filter(l => l.keep && l.kind !== 'avion').map(l => l.floor),
    aerial: levels.some(l => l.keep && l.kind === 'avion')
});

const compare = (proposedLevels, truthLevels) => {
    const truth = keptOf(truthLevels);
    const prop = keptOf(proposedLevels);
    const match = (a, list) => list.some(b => Math.abs(a - b) <= TOL);
    const justes = prop.floors.filter(f => match(f, truth.floors)).length;
    const faux = prop.floors.length - justes;
    const manques = truth.floors.filter(f => !match(f, prop.floors)).length;
    const avion = prop.aerial === truth.aerial;
    return { justes, faux, manques, avion, passe: faux === 0 && manques === 0 && avion, attendus: truth.floors.length, avionAttendu: truth.aerial };
};

const rows = [];
for (const c of cases) {
    const truthLevels = JSON.parse(readFileSync(c.verite, 'utf-8')).levels;
    const t0 = Date.now();
    const s = readSplatsPly(plyOf(c));
    const det = detectLevels(s);
    const dec = decideLevels(det.levels, { type: opts.withType && c.type ? c.type : 'auto', extent: det.extent });
    const apres = [
        ...det.levels.map((l, i) => ({ kind: l.kind, floor: l.h, keep: dec.levels[i].keep })),
        { kind: 'avion', floor: null, keep: dec.aerial.keep }
    ];
    const row = { id: c.id, horsEchantillon: !!c.horsEchantillon, apres: compare(apres, truthLevels), secondes: (Date.now() - t0) / 1000 };
    const avantPath = opts.avant && join(opts.avant, c.id, 'map', 'levels.json');
    if (avantPath && existsSync(avantPath)) row.avant = compare(JSON.parse(readFileSync(avantPath, 'utf-8')).levels, truthLevels);
    row.niveaux = det.levels.map((l, i) => {
        const t = truthLevels.find(v => v.kind !== 'avion' && Math.abs(v.floor - l.h) <= TOL);
        return { h: l.h, kind: l.kind, aire: l.area, surface: l.surface, murs: l.murs, couvert: l.couvert, keep: dec.levels[i].keep, raison: dec.levels[i].raison, doute: dec.levels[i].doute, verite: t ? (t.keep ? `gardé « ${t.name} »` : 'écarté') : 'absent' };
    });
    row.emprise = det.extent;
    row.avionVerite = truthLevels.some(l => l.kind === 'avion' && l.keep);
    row.avionApres = dec.aerial;
    rows.push(row);
    if (opts.details) {
        console.log(`\n== ${c.id} (${row.secondes.toFixed(1)} s) vue d'avion : vérité ${row.avionVerite ? 'gardée' : 'écartée'}, proposée ${dec.aerial.keep ? 'gardée' : 'écartée'}(${dec.type}, emprise ${det.extent.join(' × ')} m)`);
        for (const l of row.niveaux) {
            console.log(`  ${String(l.h).padStart(7)} ${l.kind.padEnd(6)} aire ${String(l.aire).padStart(7)} surf ${String(l.surface).padStart(7)} murs ${String(l.murs).padStart(5)} couv ${String(l.couvert).padStart(5)}  → ${l.keep ? 'GARDÉ ' : 'écarté'} ${l.raison ?? l.doute ?? ''}  | vérité : ${l.verite}`);
        }
    }
}

const cell = (m) => {
    if (!m) return 'n/d';
    return `${m.justes}/${m.attendus} justes, ${m.faux} faux, ${m.manques} manqués, avion ${m.avion ? 'juste' : 'FAUX'}${m.passe ? ' : PASSE' : ''}`;
};
console.log('\n| Scène | Avant | Après |');
console.log('|---|---|---|');
for (const r of rows) console.log(`| ${r.id}${r.horsEchantillon ? ' (hors échantillon)' : ''} | ${cell(r.avant)} | ${cell(r.apres)} |`);
const total = (key, sel) => rows.filter(sel).filter(r => r[key]?.passe).length;
const echantillon = r => !r.horsEchantillon;
console.log(`\nCartes qui passent telles quelles (échantillon, ${rows.filter(echantillon).length} cartes) : avant ${total('avant', echantillon)}, après ${total('apres', echantillon)}`);
const sum = (key, field, sel = () => true) => rows.filter(sel).reduce((t, r) => t + (r[key]?.[field] ?? 0), 0);
for (const key of ['avant', 'apres']) {
    console.log(`${key} : ${sum(key, 'justes')} niveaux justes gardés, ${sum(key, 'faux')} faux gardés, ${sum(key, 'manques')} vrais écartés, vue d'avion fausse sur ${rows.filter(r => r[key] && !r[key].avion).length} scène(s)`);
}
if (opts.json) writeFileSync(opts.json, `${JSON.stringify(rows, null, 2)}\n`);
