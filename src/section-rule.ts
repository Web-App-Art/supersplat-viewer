import type { ProfilePoint } from './section-profile';
import {
    median, subsample, firstDenseLayer, measureWindow, HIDDEN_MIN_POINTS, HIDDEN_MIN_DEPTH, HIDDEN_SIGMAS,
    RULE_MIN_SAMPLES, RULE_MIN_COVERAGE, RULE_CELLS_PER_LENGTH, RULE_POINTS_PER_CELL, RULE_MIN_CELL_POINTS, RULE_SPIKE_MIN
} from './tool-utils';
import type { WindowResult } from './tool-utils';

// ARTLIGHT (TKT-246) : règle posée sur le profil d'une coupe, comme une vraie
// règle tirée sur une toiture, une panne, un sol ou une chaussée.
//
// La portée va d'un bout à l'autre de la règle (A et B, ou deux clics sur le
// profil). Dans le repère de la portée (u le long, v en travers, vers le côté
// de la règle), on garde les points d'une bande autour de la portée, puis,
// case par case, la première couche dense du côté de la règle (comme les
// reflets de la planéité : le parquet de l'appartement a une couche fantôme
// sous la surface), sans les points épars au-dessus (pied de meuble, mur au
// bout de la portée). La règle repose sur l'enveloppe convexe des cases, et la
// flèche est le plus grand jour entre deux appuis (measureWindow, commun avec
// la planéité), mesuré perpendiculairement à la règle.
//
// Règle de toute la portée par défaut ; règle de longueur fixe promenée en
// option (sol sous la règle de 2 m, flache sous 3 m).
//
// La tranche a une épaisseur : une surface qu'elle coupe en biais (pan de
// toiture coupé le long du faîtage) y monte de l'épaisseur × la pente, 3,5 cm
// pour 5 cm à 35°, et ce biais passait pour du bruit. Chaque point est ramené
// sur le plan de coupe en suivant la surface : v − k × d, d son écart au plan,
// k la pente de la surface en travers (médiane des pentes case par case).
//
// Tuiles : enveloppe par largeur de tuile. Les creux plus étroits que la
// tuile sont comblés (fermeture : maximum puis minimum sur la largeur), la
// flèche se lit au sommet des tuiles, comme sous une règle posée dessus. Le
// lissage gaussien de la planéité donne la forme moyenne du pan. Sur le banc
// des tuiles canal affaissées de 4 cm (TKT-246), relevé dense : 39,5 à
// 40,8 mm pour 39,3 attendus en travers des rangs, de 20 à 60 cm, contre 35,7
// à 41,2 mm en lissage, qui baisse aux grandes largeurs (bouts de la portée).

// Portée minimale (m).
const RULE_MIN_SPAN = 0.1;
// Portée à moins de 15° de la verticale (mur vu de profil) : la règle est à
// gauche ou à droite, et non dessus ou dessous.
const RULE_VERTICAL_SIN = Math.sin(15 * Math.PI / 180);
// Bande gardée autour de la portée : 3 % de sa longueur (5 cm à 1 m). Elle
// suit un affaissement ou une chaussée bombée, sans prendre un plafond, un
// faux plafond ou une voiture garée.
const RULE_BAND_RATIO = 0.03;
const RULE_BAND_MIN = 0.05;
const RULE_BAND_MAX = 1;
// Au plus 20 000 cases sur la portée.
const RULE_MAX_SAMPLES = 20000;
// Couche visible : niveau d'une case pris chez ses voisines (2 de chaque côté)
// quand elle n'en a pas, ou qu'elle est en retrait (tache de reflet).
const LAYER_NEIGHBOR_RADIUS = 2;
// Cases isolées : écart à leurs voisines de plus de 4 σ (comme la planéité)
// sans voisine qui le confirme, sur des cases de 10 cm au plus.
const RULE_SPIKE_SIGMAS = 4;
const RULE_SPIKE_MAX_CELL = 0.1;
const SPIKE_NEIGHBORS = 3;
// Tuiles : cases de 1/4 de tuile au plus. Sans deux cases par tuile, le relevé
// est trop clairsemé pour l'enveloppe.
const TILE_CELLS = 4;
// Flèche que le bruit seul produirait : la même règle sur un bruit tiré au
// hasard (31 tirages à graine fixe), au 9e décile. Une flèche plus faible
// n'est pas significative.
const NOISE_TRIALS = 31;
const NOISE_QUANTILE = 0.9;
const NOISE_SAMPLE = 10000;
// Niveau et médiane d'une case sur 500 points au plus (pris à pas régulier) :
// une tranche d'1 m en compte des milliers par case.
const CELL_SAMPLE = 500;

export interface RuleOptions {
    span: [ProfilePoint, ProfilePoint];  // bouts de la portée, sur le profil
    side: 1 | -1;                        // 1 : dessus (gauche pour une portée presque verticale)
    length: number;                      // règle promenée (m) ; 0 : toute la portée
    tile: number;                        // largeur des tuiles (m) ; 0 : surface lisse
}

export interface RuleOk {
    status: 'ok';
    gap: number;                 // flèche maximale, perpendiculaire à la règle (m)
    start: ProfilePoint;         // règle la plus défavorable, d'un bout à l'autre
    end: ProfilePoint;
    supports: [ProfilePoint, ProfilePoint];   // ses deux appuis
    gapRule: ProfilePoint;       // flèche : pied sur la règle…
    gapSurface: ProfilePoint;    // …et surface en face
    reach: number;               // portée entre les appuis (m)
    cell: number;                // pas des cases le long de la portée (m)
    noise: number;               // bruit des splats (m)
    noiseFloor: number;          // flèche due au seul bruit (m)
    tiles: boolean;              // enveloppe des tuiles appliquée
    count: number;               // points de la surface sous la portée
    used: Uint8Array;            // 1 : point de la surface retenu (écart à la règle dans le CSV)
    normal: ProfilePoint;        // côté de la règle (unitaire, sur le profil)
    crossSlope: number;          // pente de la surface en travers de la tranche (k)
}

export type RuleResult = RuleOk | {
    status: 'too-short' | 'too-coarse' | 'no-data';
    cell: number;
};

// Repère de la portée : origine au premier bout, u le long, v vers la règle.
export interface SpanFrame {
    origin: ProfilePoint;
    along: ProfilePoint;
    normal: ProfilePoint;
    length: number;
}

// Portée presque verticale sur le profil : la règle est à gauche ou à droite.
export const spanIsUpright = (span: [ProfilePoint, ProfilePoint]): boolean => {
    const ds = span[1].s - span[0].s, dt = span[1].t - span[0].t;
    const length = Math.hypot(ds, dt);
    return length > 0 && Math.abs(ds) / length < RULE_VERTICAL_SIN;
};

export const spanFrame = (span: [ProfilePoint, ProfilePoint], side: 1 | -1): SpanFrame | null => {
    const [p1, p2] = span;
    const ds = p2.s - p1.s, dt = p2.t - p1.t;
    const length = Math.hypot(ds, dt);
    if (!(length > 0)) return null;
    const along = { s: ds / length, t: dt / length };
    // Côté 1 : dessus (t croissant), ou à gauche (s décroissant) pour une
    // portée presque verticale.
    let normal = { s: -along.t, t: along.s };
    if (spanIsUpright(span) ? normal.s > 0 : normal.t < 0) normal = { s: -normal.s, t: -normal.t };
    if (side < 0) normal = { s: -normal.s, t: -normal.t };
    return { origin: { s: p1.s, t: p1.t }, along, normal, length };
};

// Point (u, v) du repère de la portée, sur le profil.
export const spanPoint = (f: SpanFrame, u: number, v: number): ProfilePoint => ({
    s: f.origin.s + u * f.along.s + v * f.normal.s,
    t: f.origin.t + u * f.along.t + v * f.normal.t
});

export interface SurfaceProfile {
    values: Float64Array;        // niveau de la surface par case (v ; NaN : pas de mesure)
    cell: number;
    crossSlope: number;
    used: Uint8Array;
    noise: number;               // bruit des splats (m)
    perCell: number;             // points par case mesurée, en moyenne
    count: number;
}

// Surface sous la portée, case par case (cases centrées sur u = i × cell,
// de 0 à la longueur de la portée). offsets : écart des points au plan de
// coupe.
export const surfaceProfile = (points: Float32Array, count: number, f: SpanFrame, cell: number, band: number, offsets?: Float32Array): SurfaceProfile => {
    const n = Math.round(f.length / cell) + 1;
    const u = new Float64Array(count), v = new Float64Array(count);
    const cells: number[][] = Array.from({ length: n }, (): number[] => []);
    for (let i = 0; i < count; i++) {
        const ds = points[i * 2] - f.origin.s, dt = points[i * 2 + 1] - f.origin.t;
        const vi = ds * f.normal.s + dt * f.normal.t;
        if (vi > band || vi < -band) continue;
        const ui = ds * f.along.s + dt * f.along.t;
        const k = Math.round(ui / cell);
        if (k < 0 || k >= n) continue;
        u[i] = ui;
        v[i] = vi;
        cells[k].push(i);
    }

    // Droite des moindres carrés de v selon x sur les points d'une case.
    const fit = (list: number[], x: ArrayLike<number>) => {
        let mx = 0, mv = 0;
        for (const i of list) {
            mx += x[i];
            mv += v[i];
        }
        mx /= list.length;
        mv /= list.length;
        let sxx = 0, sxv = 0;
        for (const i of list) {
            sxx += (x[i] - mx) ** 2;
            sxv += (x[i] - mx) * (v[i] - mv);
        }
        return { mx, mv, sxx, slope: sxx > 0 ? sxv / sxx : 0 };
    };

    // Couche visible depuis la règle, case par case : les points gardés.
    const visibleLayer = (): number[][] => {
        // Première couche dense en partant de la règle
        const levels = new Float64Array(n).fill(NaN);
        const residuals: number[] = [];
        for (let k = 0; k < n; k++) {
            if (cells[k].length < HIDDEN_MIN_POINTS) continue;
            const sorted = subsample(cells[k].map(i => v[i]), CELL_SAMPLE).sort((a, b) => b - a);
            const layer = firstDenseLayer(sorted);
            if (!layer) continue;
            const level = median(layer);
            levels[k] = level;
            for (const x of layer) residuals.push(x - level);
        }
        const layerSigma = residuals.length ? 1.4826 * median(subsample(residuals, NOISE_SAMPLE).map(r => Math.abs(r))) : 0;
        const depth = Math.max(HIDDEN_MIN_DEPTH, HIDDEN_SIGMAS * layerSigma);

        // Case sans niveau, ou en retrait de ses voisines : leur niveau
        const fixed = levels.slice();
        const near: number[] = [];
        for (let k = 0; k < n; k++) {
            near.length = 0;
            for (let d = -LAYER_NEIGHBOR_RADIUS; d <= LAYER_NEIGHBOR_RADIUS; d++) {
                const x = levels[k + d];
                if (d !== 0 && x !== undefined && !Number.isNaN(x)) near.push(x);
            }
            if (Number.isNaN(levels[k])) {
                if (near.length >= 2) fixed[k] = median(near);
            } else if (near.length >= 3) {
                const around = median(near);
                if (levels[k] < around - depth) fixed[k] = around;
            }
        }
        // Au-dessus de la couche, des points trop clairsemés pour en faire une
        // (pied de meuble, mur au bout de la portée, splat flottant) ne
        // comptent pas : une surface en saillie a sa propre couche.
        return cells.map((list, k) => {
            const level = fixed[k];
            return Number.isNaN(level) ? list : list.filter(i => v[i] >= level - depth && v[i] <= level + depth);
        });
    };

    // Surface coupée en biais : pente de v selon l'écart au plan, case par
    // case, puis médiane des cases ; chaque point est ramené sur le plan de
    // coupe. Une première estimation sur tous les points, corrigée sur la
    // seule couche visible (les reflets d'un parquet brouillaient la pente).
    let crossSlope = 0;
    const across = (lists: number[][]) => {
        const slopes: number[] = [];
        for (const list of lists) {
            if (list.length < HIDDEN_MIN_POINTS) continue;
            const line = fit(list, offsets);
            if (line.sxx > 1e-9 * list.length) slopes.push(line.slope);
        }
        if (slopes.length < 3) return;
        const k = median(slopes);
        crossSlope += k;
        for (const list of cells) {
            for (const i of list) v[i] -= k * offsets[i];
        }
    };
    if (offsets) {
        across(cells);
        across(visibleLayer());
    }

    // Niveau de chaque case : médiane de sa couche visible. Bruit : écarts
    // des splats à la droite de leur case (une case en pente ne compte pas).
    const values = new Float64Array(n).fill(NaN);
    const used = new Uint8Array(count);
    const kept = visibleLayer();
    const noiseResiduals: number[] = [];
    let measured = 0, measuredPoints = 0;
    for (let k = 0; k < n; k++) {
        const list = kept[k];
        if (list.length < RULE_MIN_CELL_POINTS) {
            kept[k] = [];
            continue;
        }
        values[k] = median(subsample(list.map(i => v[i]), CELL_SAMPLE));
        measured++;
        measuredPoints += list.length;
        if (list.length >= 4) {
            const line = fit(list, u);
            const correction = Math.sqrt(list.length / (list.length - 2));
            for (const i of list) noiseResiduals.push((v[i] - line.mv - line.slope * (u[i] - line.mx)) * correction);
        }
    }
    const noise = noiseResiduals.length ? 1.4826 * median(subsample(noiseResiduals, NOISE_SAMPLE).map(r => Math.abs(r))) : 0;

    // Cases isolées : écart à la droite des voisines (3 de chaque côté), qui
    // suit la pente d'un profil courbe et prolonge le profil au bout de la
    // portée. Droite robuste (médiane répétée des pentes) : une voisine
    // elle-même isolée ne la fausse pas. Une voisine au même écart confirme
    // la case. Un amas de splats flottants au-dessus d'une surface clairsemée
    // fait une case isolée ; une case large (règle de toute la portée, relevé
    // clairsemé) n'est jamais écartée : son écart est réel (flache d'une
    // chaussée).
    if (cell <= RULE_SPIKE_MAX_CELL) {
        const deltas = new Float64Array(n).fill(NaN);
        const slopes = new Float64Array(n);
        const absDeltas: number[] = [];
        const js: number[] = [], xs: number[] = [], pair: number[] = [], each: number[] = [];
        for (let k = 0; k < n; k++) {
            if (Number.isNaN(values[k])) continue;
            js.length = 0;
            xs.length = 0;
            for (let j = -SPIKE_NEIGHBORS; j <= SPIKE_NEIGHBORS; j++) {
                const x = values[k + j];
                if (j === 0 || x === undefined || Number.isNaN(x)) continue;
                js.push(j);
                xs.push(x);
            }
            if (js.length < 2) continue;
            each.length = 0;
            for (let a = 0; a < js.length; a++) {
                pair.length = 0;
                for (let b = 0; b < js.length; b++) if (b !== a) pair.push((xs[b] - xs[a]) / (js[b] - js[a]));
                each.push(median(pair));
            }
            const slope = median(each);
            slopes[k] = slope;
            deltas[k] = values[k] - median(xs.map((x, a) => x - slope * js[a]));
            absDeltas.push(Math.abs(deltas[k]));
        }
        const threshold = absDeltas.length >= 10 ? Math.max(RULE_SPIKE_SIGMAS * 1.4826 * median(absDeltas), RULE_SPIKE_MIN) : Infinity;
        const spikes: number[] = [];
        for (let k = 0; k < n; k++) {
            const d = deltas[k];
            if (!(Math.abs(d) > threshold)) continue;
            let support = 0;
            for (let j = -SPIKE_NEIGHBORS; j <= SPIKE_NEIGHBORS; j++) {
                const x = values[k + j];
                if (j !== 0 && x !== undefined && !Number.isNaN(x) && Math.abs(x - values[k] - slopes[k] * j) <= Math.abs(d) / 2) support++;
            }
            if (support === 0) spikes.push(k);
        }
        for (const k of spikes) {
            values[k] = NaN;
            measured--;
            measuredPoints -= kept[k].length;
            kept[k] = [];
        }
    }

    let usedCount = 0;
    for (const list of kept) {
        for (const i of list) used[i] = 1;
        usedCount += list.length;
    }
    return { values, cell, crossSlope, used, noise, perCell: measured > 0 ? measuredPoints / measured : 0, count: usedCount };
};

// Enveloppe par largeur de tuile : fermeture (maximum puis minimum sur
// 2 × half + 1 cases). Une case sans mesure, entre des mesures à moins d'une
// demi-tuile de chaque côté, prend l'enveloppe : vu du sol, le recouvrement
// cache le bas de chaque tuile (une case sur trois vide sur un vrai toit),
// et seul le sommet des tuiles compte. Les autres restent sans mesure.
export const closeProfile = (values: Float64Array, half: number): Float64Array => {
    const n = values.length;
    const measured = (k: number) => k >= 0 && k < n && !Number.isNaN(values[k]);
    const kept = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
        if (measured(k)) {
            kept[k] = 1;
            continue;
        }
        let before = false, after = false;
        for (let d = 1; d <= half; d++) {
            before ||= measured(k - d);
            after ||= measured(k + d);
        }
        kept[k] = before && after ? 1 : 0;
    }
    const pass = (src: Float64Array, take: (a: number, b: number) => number) => {
        const out = new Float64Array(n).fill(NaN);
        for (let k = 0; k < n; k++) {
            if (!kept[k]) continue;
            let best = NaN;
            for (let d = -half; d <= half; d++) {
                const x = src[k + d];
                if (x === undefined || Number.isNaN(x)) continue;
                best = Number.isNaN(best) ? x : take(best, x);
            }
            out[k] = best;
        }
        return out;
    };
    return pass(pass(values, Math.max), Math.min);
};

export interface RuleWindow {
    gap: number;                 // perpendiculaire à la règle (m)
    i0: number;                  // cases sous la règle [i0, i1[
    i1: number;
    a: number;                   // appuis
    b: number;
    slope: number;               // pente de la règle (par case)
    iGap: number;
}

// Règle sur le profil (cases de `cell`) : toute la portée (`samples` = 0),
// ou promenée sur `samples` cases. null s'il n'y a pas assez de mesures sous
// la règle (voir RULE_MIN_COVERAGE).
export const ruleOnProfile = (profile: Float64Array, cell: number, samples: number): RuleWindow | null => {
    const n = profile.length;
    const prefix = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + (Number.isNaN(profile[i]) ? 0 : 1);
    const hull = new Int32Array(n);
    const win: WindowResult = { gap: 0, a: 0, b: 0, slope: 0, iGap: 0 };
    let worst: RuleWindow | null = null;
    const measure = (i0: number, i1: number) => {
        measureWindow(profile, i0, i1, hull, win);
        // Jour perpendiculaire à la règle, et non selon v
        const gap = win.gap / Math.sqrt(1 + (win.slope / cell) ** 2);
        if (worst && gap <= worst.gap) return;
        worst = { gap, i0, i1, a: win.a, b: win.b, slope: win.slope, iGap: win.iGap };
    };

    if (samples === 0) {
        let first = -1, last = -1;
        for (let i = 0; i < n; i++) {
            if (Number.isNaN(profile[i])) continue;
            if (first < 0) first = i;
            last = i;
        }
        if (first < 0) return null;
        const span = last - first + 1;
        if (span - 1 < Math.max(RULE_MIN_SAMPLES, (n - 1) / 2)) return null;
        if (prefix[last + 1] - prefix[first] < span * RULE_MIN_COVERAGE) return null;
        measure(first, last + 1);
        return worst;
    }

    // Règle promenée : des mesures à ses deux bouts et sur 70 % de sa longueur.
    const edge = Math.max(1, Math.floor(samples * 0.2));
    const minValid = Math.ceil(samples * RULE_MIN_COVERAGE);
    for (let i0 = 0; i0 + samples <= n; i0++) {
        const i1 = i0 + samples;
        if (prefix[i1] - prefix[i0] < minValid) continue;
        if (prefix[i0 + edge] === prefix[i0]) continue;
        if (prefix[i1] === prefix[i1 - edge]) continue;
        measure(i0, i1);
    }
    return worst;
};

// Générateur pseudo-aléatoire à graine fixe (mulberry32) et loi normale.
const createGauss = (seed: number) => {
    let a = seed >>> 0;
    const random = () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random());
};

/**
 * Règle sur le profil d'une coupe.
 *
 * @param {Float32Array} points - Points du profil (s, t entrelacés).
 * @param {number} count - Nombre de points.
 * @param {RuleOptions} opts - Portée, côté, longueur de la règle, tuiles.
 * @param {Float32Array} [offsets] - Écart des points au plan de coupe (m).
 * @returns {RuleResult} Flèche et position de la règle la plus défavorable.
 */
export const computeRule = (points: Float32Array, count: number, opts: RuleOptions, offsets?: Float32Array): RuleResult => {
    const f = spanFrame(opts.span, opts.side);
    if (!f || f.length < RULE_MIN_SPAN || opts.length > f.length + 1e-9) return { status: 'too-short', cell: 0 };
    const band = Math.min(RULE_BAND_MAX, Math.max(RULE_BAND_MIN, RULE_BAND_RATIO * f.length));

    // Cases : L/40 de la règle, 8 points chacune en moyenne ; pour des tuiles,
    // un quart de tuile au plus.
    let inBand = 0;
    for (let i = 0; i < count; i++) {
        const ds = points[i * 2] - f.origin.s, dt = points[i * 2 + 1] - f.origin.t;
        const u = ds * f.along.s + dt * f.along.t, v = ds * f.normal.s + dt * f.normal.t;
        if (u >= 0 && u <= f.length && v <= band && v >= -band) inBand++;
    }
    if (inBand < RULE_MIN_SAMPLES * RULE_MIN_CELL_POINTS) return { status: 'no-data', cell: 0 };
    const sparse = RULE_POINTS_PER_CELL * f.length / inBand;
    const ruleLength = opts.length > 0 ? opts.length : f.length;
    let cell = Math.max(ruleLength / RULE_CELLS_PER_LENGTH, sparse);
    if (opts.tile > 0) cell = Math.max(sparse, Math.min(cell, opts.tile / TILE_CELLS));
    cell = Math.max(cell, f.length / RULE_MAX_SAMPLES);
    cell = f.length / Math.max(1, Math.round(f.length / cell));
    const samples = opts.length > 0 ? Math.round(opts.length / cell) + 1 : 0;
    if ((samples || Math.round(f.length / cell) + 1) - 1 < RULE_MIN_SAMPLES) return { status: 'too-coarse', cell };

    const surface = surfaceProfile(points, count, f, cell, band, offsets);
    const half = opts.tile > 0 ? Math.round(opts.tile / cell / 2) : 0;
    const tiles = half >= 1;
    const profile = tiles ? closeProfile(surface.values, half) : surface.values;
    const win = ruleOnProfile(profile, cell, samples);
    if (!win) return { status: 'no-data', cell };

    // Flèche due au seul bruit : la même règle sur un bruit de même écart
    // type par case (médiane de n splats : 1,25 σ / √n), mêmes cases mesurées.
    const cellNoise = surface.perCell > 0 ? surface.noise * 1.2533 / Math.sqrt(surface.perCell) : 0;
    const gauss = createGauss(1);
    const trials: number[] = [];
    const noisy = new Float64Array(profile.length);
    for (let k = 0; k < NOISE_TRIALS; k++) {
        for (let i = 0; i < noisy.length; i++) noisy[i] = Number.isNaN(surface.values[i]) ? NaN : cellNoise * gauss();
        trials.push(ruleOnProfile(tiles ? closeProfile(noisy, half) : noisy, cell, samples)?.gap ?? 0);
    }
    trials.sort((a, b) => a - b);

    // Repère de la portée → profil
    const ruleAt = (i: number) => profile[win.a] + win.slope * (i - win.a);
    const at = (i: number, v: number) => spanPoint(f, i * cell, v);
    const m = win.slope / cell;
    const cos = 1 / Math.sqrt(1 + m * m);
    const gapSurface = at(win.iGap, profile[win.iGap]);
    // Pied de la flèche : perpendiculaire à la règle
    const gapRule = spanPoint(f, win.iGap * cell - m * cos * win.gap, profile[win.iGap] + cos * win.gap);
    return {
        status: 'ok',
        gap: win.gap,
        start: at(win.i0, ruleAt(win.i0)),
        end: at(win.i1 - 1, ruleAt(win.i1 - 1)),
        supports: [at(win.a, profile[win.a]), at(win.b, profile[win.b])],
        gapRule,
        gapSurface,
        reach: Math.hypot((win.b - win.a) * cell, profile[win.b] - profile[win.a]),
        cell,
        noise: surface.noise,
        noiseFloor: trials[Math.round(NOISE_QUANTILE * (trials.length - 1))],
        tiles,
        count: surface.count,
        used: surface.used,
        normal: f.normal,
        crossSlope: surface.crossSlope
    };
};
