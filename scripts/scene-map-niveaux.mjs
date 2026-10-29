// ARTLIGHT (TKT-268, revu au TKT-297)
//
// Détection des niveaux d'une scène, partagée par scene-map.mjs (étape
// « propose ») et par le banc de mesure (mesure-propose.mjs). Pur : lit un PLY
// déjà exporté par splat-transform, ne lance rien.
//
// TKT-297 : jusqu'ici « propose » gardait tout sol de plus de 2 m², et la vue
// d'avion seulement si aucun sol n'était trouvé. Sur les cartes réalisées à la
// main, une seule serait passée telle quelle : toits, faîtages et plafonds pris
// pour des sols, petites caves, scènes extérieures découpées en niveaux.
// Chaque niveau détecté reçoit maintenant trois mesures, toutes lues dans la
// grille d'occupation qui sert déjà à la détection :
//   - surface : emprise au sol du niveau (cases de sol à ± 25 cm de sa hauteur) ;
//   - murs : longueur des colonnes « pleines » entre sol + 0,3 et sol + 1,8 m
//     à moins de 50 cm de l'emprise, rapportée au périmètre d'un carré de même
//     surface (0 : rien ne se dresse sur ce « sol » ; 2 à 12 sur les vrais sols,
//     l'emprise mesurée étant plus petite que la pièce) ;
//   - couvert : part de l'emprise qui a quelque chose au-dessus de sol + 2 m
//     (≈ 1 sous un plafond ; ≈ 0 à ciel ouvert).
// et une décision lisible : gardé, ou écarté avec sa raison (champ « raison »
// de levels.json, ajouté sans rien changer au reste du format).

import { closeSync, openSync, readSync } from 'fs';

// Splats retenus : opacité au-dessus de ce seuil.
export const MIN_OPACITY = 0.3;

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

// Mesures d'un niveau (TKT-297).
const FOOT_TOLERANCE = 0.25;            // emprise : cases de sol à ± 25 cm du niveau
const WALL_BAND = [0.3, 1.8];           // bande où l'on cherche des murs
const WALL_FILL = 0.5;                  // colonne « pleine » : au moins la moitié de la bande occupée
const WALL_REACH = 0.5;                 // murs cherchés jusqu'à 50 cm de l'emprise
const COVER_FROM = 2.0;                 // couvert : quelque chose au-dessus de sol + 2 m

// Règles de décision (TKT-297), réglables par l'appelant. Seuils tirés des
// cartes corrigées à la main (docs/tkt-297-publier-scene.md) avec de la marge,
// et non ajustés cas par cas.
export const DEFAULT_RULES = {
    // m² d'emprise mesurée (cases de sol visibles, donc moins que la surface
    // réelle) : en dessous, « Petite surface », sauf pièce fermée (ci-dessous)
    minArea: 15,
    // murs / périmètre : en dessous, aucun mur ne se dresse sur ce « sol ».
    // Mesuré : 0 à 1,18 sur les toits, faîtages et plafonds écartés à la main,
    // 2,41 au moins sur les vrais sols gardés ; 1,5 laisse de la marge des deux côtés
    minWalls: 1.5,
    // petite pièce fermée gardée malgré sa surface : couverte ET murée
    // (studio de Belgentier, rez-de-jardin de Saint-Germain)
    closedCover: 0.8,
    closedWalls: 2,
    // couvert : en dessous, sol à ciel ouvert (cour, terrasse, jardin…)
    minCover: 0.5,
    // un niveau couvert à 80 % au moins prouve un intérieur relevé
    indoorProof: 0.8,
    // sans intérieur prouvé, part de surface à ciel ouvert au-delà de laquelle la scène est un extérieur
    outdoorShare: 0.5,
    // scène mixte : vue d'avion ajoutée si le ciel ouvert pèse au moins 25 % de la surface
    // et que le site dépasse 30 m dans les deux sens (en deçà, la carte d'un niveau montre déjà tout)
    aerialShare: 0.25,
    aerialExtent: 30
};

// Types de scène qu'un opérateur peut imposer (option --type de propose) :
// « auto » laisse décider les mesures.
export const SCENE_TYPES = ['auto', 'interieur', 'exterieur', 'mixte'];

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

// --- lecture d'un PLY 3DGS ---------------------------------------------------

// Lit les splats en (E, H, N) avec un drapeau « surface horizontale » :
// splat plat (plus petite échelle < 0,3 × la moyenne) dont la normale est
// verticale (|n_y| > 0,9). Seuls les splats d'opacité > 0,3 sont gardés.
// Le PLY de splat-transform est en (E, −H, N).
export const readSplatsPly = (ply) => {
    const fd = openSync(ply, 'r');
    try {
        const head = Buffer.alloc(4096);
        readSync(fd, head, 0, head.length, 0);
        const headText = head.toString('latin1');
        const end = headText.indexOf('end_header\n');
        if (end < 0 || !headText.startsWith('ply')) throw new Error('PLY illisible');
        const lines = headText.slice(0, end).split('\n');
        if (!lines.includes('format binary_little_endian 1.0')) throw new Error('PLY attendu en binaire little-endian');
        const count = Number(lines.find(l => l.startsWith('element vertex')).split(' ')[2]);
        const props = lines.filter(l => l.startsWith('property ')).map((l) => {
            const [, type, name] = l.split(' ');
            if (type !== 'float') throw new Error(`propriété ${name} en ${type}, float attendu`);
            return name;
        });
        const stride = props.length * 4;
        const at = (name) => {
            const i = props.indexOf(name);
            if (i < 0) throw new Error(`propriété ${name} absente du PLY`);
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
        return { E: E.subarray(0, n), H: H.subarray(0, n), N: N.subarray(0, n), horizontal: horizontal.subarray(0, n), n, total: count };
    } finally {
        closeSync(fd);
    }
};

// Percentiles approchés sur un échantillon régulier (≤ 2 M valeurs).
export const percentiles = (values, ps, mask) => {
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
// TKT-297 : chaque niveau reçoit ses mesures (surface, murs, couvert).
export const detectLevels = (s) => {
    const [e0, e1] = percentiles(s.E, [0.1, 99.9]);
    const [n0, n1] = percentiles(s.N, [0.1, 99.9]);
    const [h0, h1] = percentiles(s.H, [0.1, 99.9]);
    const cell = GRID_CELL;
    const dx = Math.ceil((e1 - e0) / cell) + 1, dy = Math.ceil((n1 - n0) / cell) + 1, dz = Math.ceil((h1 - h0) / cell) + 1;
    const bits = dx * dy * dz;
    if (bits > 8e9) throw new Error(`emprise trop grande pour la grille (${dx} × ${dy} × ${dz} cases)`);
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

    // --- mesures de chaque niveau (TKT-297) ---
    const columns = dx * dy;
    const reach = Math.round(WALL_REACH / cell);

    const measure = (level) => {
        // emprise : colonnes portant une case de sol (ou, pour un sol déduit,
        // de plafond sous la dalle) à ± 25 cm de la hauteur visée
        const set = level.kind === 'déduit' ? ceilingCells : floorCells;
        const target = level.kind === 'déduit' ? level.h - DEDUCED_SLAB : level.h;
        const foot = new Uint8Array(columns);
        let footCount = 0;
        for (const key of set) {
            const bin = key % bins;
            if (Math.abs(center(bin) - target) > FOOT_TOLERANCE) continue;
            const col = (key - bin) / bins;
            if (!foot[col]) {
                foot[col] = 1;
                footCount++;
            }
        }
        const area = footCount * cell * cell;
        if (!footCount) return { surface: 0, murs: 0, couvert: 0 };
        // couvert : quelque chose au-dessus de sol + 2 m, jusqu'au haut de la grille
        const izCover = Math.ceil((level.h + COVER_FROM - h0) / cell);
        let covered = 0;
        // murs : colonnes « pleines » dans la bande, à moins de 50 cm de l'emprise
        const izw0 = Math.floor((level.h + WALL_BAND[0] - h0) / cell), izw1 = Math.floor((level.h + WALL_BAND[1] - h0) / cell);
        const need = Math.max(1, Math.ceil(WALL_FILL * (izw1 - izw0 + 1)));
        const near = new Uint8Array(columns);
        for (let col = 0; col < columns; col++) {
            if (!foot[col]) continue;
            const base = col * dz;
            for (let iz = Math.max(0, izCover); iz < dz; iz++) {
                if (isOccupied(base, iz)) {
                    covered++;
                    break;
                }
            }
            const ix = Math.floor(col / dy), iy = col % dy;
            for (let jx = Math.max(0, ix - reach); jx <= Math.min(dx - 1, ix + reach); jx++) {
                for (let jy = Math.max(0, iy - reach); jy <= Math.min(dy - 1, iy + reach); jy++) {
                    near[jx * dy + jy] = 1;
                }
            }
        }
        let wallColumns = 0;
        for (let col = 0; col < columns; col++) {
            if (!near[col]) continue;
            const base = col * dz;
            let c = 0;
            for (let iz = Math.max(0, izw0); iz <= Math.min(dz - 1, izw1); iz++) c += isOccupied(base, iz);
            if (c >= need) wallColumns++;
        }
        return {
            surface: round(area, 1),
            murs: round(wallColumns * cell / (4 * Math.sqrt(area)), 2),
            couvert: round(covered / footCount, 2)
        };
    };
    for (const l of levels) Object.assign(l, measure(l));

    const totalFloor = fa.reduce((a, b) => a + b, 0), totalCeiling = ca.reduce((a, b) => a + b, 0);
    const [pe0, pe1] = percentiles(s.E, [2, 98]);
    const [pn0, pn1] = percentiles(s.N, [2, 98]);
    return {
        box: { E: [e0, e1], N: [n0, n1], H: [h0, h1] },
        // emprise « utile » (percentiles 2 / 98), pour juger de l'intérêt d'une vue d'avion
        extent: [round(pe1 - pe0, 1), round(pn1 - pn0, 1)],
        floors: fp.map(i => ({ h: round(center(i)), area: round(around(fa, i), 1) })),
        ceilings: cp.map(i => ({ h: round(center(i)), area: round(around(ca, i), 1) })),
        levels,
        horizontalCount,
        floorArea: round(totalFloor, 1),
        ceilingArea: round(totalCeiling, 1),
        histogram: { h0, bin: HEIGHT_BIN, floor: fa.map(v => round(v, 2)), ceiling: ca.map(v => round(v, 2)) }
    };
};

// --- décision : gardé, ou écarté avec sa raison (TKT-297) -------------------

// Rend, pour chaque niveau détecté, { keep, raison?, doute? }, le type de
// scène retenu et la décision pour la vue d'avion. Les raisons se lisent
// telles quelles dans levels.json et sur la planche.
//   1. « Petite surface » : emprise < minArea, sauf pièce fermée (couvert ≥
//      closedCover et murs ≥ closedWalls) : une cave ouverte ou un palier est
//      écarté, le studio de 7 m² mesurés reste.
//   2. « Toit, faîtage ou plafond probable » : aucun mur ne se dresse sur ce
//      sol (murs < minWalls). Sur un relevé intérieur, le dessus d'un plafond
//      n'a rien au-dessus ; sur un extérieur, un toit non plus.
//   3. Scène extérieure : aucun niveau ne reste, ou aucun n'est couvert à
//      indoorProof et le ciel ouvert (couvert < minCover) pèse plus de
//      outdoorShare de la surface des sols notables (toits compris). Tout est alors écarté (« Scène
//      extérieure : vue d'avion seule ») et la vue d'avion gardée.
//   4. Sinon les niveaux restants sont gardés, y compris à ciel ouvert, avec un
//      « doute » (terrasse, ou dernier étage sous rampants peu relevé) : un
//      niveau de trop se raye d'un mot, un niveau manquant se rajoute à la main.
//      Vue d'avion en plus (scène mixte) si le ciel ouvert pèse aerialShare et
//      que le site dépasse aerialExtent m dans les deux sens.
// type impose le résultat de l'étape 3 : « exterieur » (vue d'avion seule),
// « interieur » (jamais de vue d'avion), « mixte » (niveaux et vue d'avion).
export const decideLevels = (levels, { rules = {}, type = 'auto', extent = null } = {}) => {
    const r = { ...DEFAULT_RULES, ...rules };
    if (!SCENE_TYPES.includes(type)) throw new Error(`type de scène « ${type} » : ${SCENE_TYPES.join(', ')}`);
    const out = levels.map((l) => {
        const closed = l.couvert >= r.closedCover && l.murs >= r.closedWalls;
        if (l.surface < r.minArea && !closed) return { keep: false, raison: `Petite surface (${String(round(l.surface, 1)).replace('.', ',')} m² mesurés, moins de ${r.minArea})` };
        if (l.murs < r.minWalls) return { keep: false, raison: 'Toit, faîtage ou plafond probable : aucun mur ne se dresse sur ce sol' };
        if (l.couvert < r.minCover) return { keep: true, doute: 'Sol en partie à ciel ouvert : terrasse ou cour, ou dernier étage peu relevé ? À vérifier sur la vignette', dehors: true };
        return { keep: true };
    });
    const remaining = levels.filter((l, i) => out[i].keep);
    // part du ciel ouvert : sur tous les sols notables (toits compris : un toit
    // est à ciel ouvert, et sur un extérieur il compte autant qu'une cour)
    const notable = levels.filter(l => l.surface >= r.minArea || (l.couvert >= r.closedCover && l.murs >= r.closedWalls));
    const total = notable.reduce((t, l) => t + l.surface, 0);
    const outdoor = notable.reduce((t, l) => t + (l.couvert < r.minCover ? l.surface : 0), 0);
    const proven = remaining.some(l => l.couvert >= r.indoorProof);
    let sceneType;
    if (type !== 'auto') sceneType = type;
    else if (!remaining.length || (!proven && outdoor / total > r.outdoorShare)) sceneType = 'exterieur';
    else {
        const wide = extent ? Math.min(...extent) >= r.aerialExtent : false;
        sceneType = total > 0 && outdoor / total >= r.aerialShare && wide ? 'mixte' : 'interieur';
    }
    if (sceneType === 'exterieur') {
        for (const o of out) {
            if (o.keep) {
                o.keep = false;
                o.raison = 'Scène extérieure : vue d’avion seule';
                delete o.doute;
            }
        }
    }
    const aerial = sceneType === 'interieur' ?
        { keep: false, raison: 'Scène intérieure : la carte des niveaux suffit' } :
        { keep: true };
    // sol de la vue d'avion : le plus étendu des niveaux qui ne sont pas des toits
    const grounds = levels.filter(l => l.murs >= r.minWalls);
    const aerialFloor = grounds.length ? grounds.reduce((a, b) => (b.surface > a.surface ? b : a)).h : null;
    return {
        levels: out.map(({ keep, raison, doute }) => ({ keep, ...(raison ? { raison } : {}), ...(doute ? { doute } : {}) })),
        type: sceneType,
        aerial,
        aerialFloor
    };
};

// Noms proposés aux niveaux gardés : le plus grand des deux plus bas est le
// rez-de-chaussée, au-dessous « Niveau −1 »…, au-dessus « 1er étage »… Un
// extérieur garde « Niveau n » (rien n'est gardé de toute façon).
export const levelNames = (levels, decisions) => {
    const kept = levels.map((l, i) => ({ l, i })).filter(x => decisions[x.i].keep).sort((a, b) => a.l.h - b.l.h);
    const names = levels.map((l, i) => `Niveau ${i + 1}`);
    if (!kept.length) return names;
    const base = kept.length > 1 && kept[1].l.surface > kept[0].l.surface ? 1 : 0;
    kept.forEach((x, k) => {
        const d = k - base;
        names[x.i] = d === 0 ? 'Rez-de-chaussée' : d < 0 ? `Niveau ${d}` : d === 1 ? '1er étage' : `${d}e étage`;
    });
    return names;
};

// Emprise E/N d'un niveau : percentiles 0,5 / 99,5 des splats de sa bande
// (sol + 0,3 à sol + 2,0), plus la marge. Vue d'avion : tous les splats.
export const levelBounds = (s, floor, { from = 0.3, to = 2.0, margin = 1.0 } = {}) => {
    const mask = floor === null ? null : i => s.H[i] > floor + from && s.H[i] < floor + to;
    const [e0, e1] = percentiles(s.E, [0.5, 99.5], mask);
    const [n0, n1] = percentiles(s.N, [0.5, 99.5], mask);
    return [round(e0 - margin, 1), round(n0 - margin, 1), round(e1 + margin, 1), round(n1 + margin, 1)];
};
