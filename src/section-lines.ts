import { traceSection } from './section-trace';
import type { TracedLine } from './section-trace';

// ARTLIGHT (TKT-264) : traits de coupe redressés. Une face de mur forme dans
// la tranche une bande de ±4 cm de bruit (Immeuble Toulon : σ = 4,3 cm,
// ~115 points par mètre) ; le squelette de section-trace.ts serpente dans
// cette bande et sort un mur en dizaines de petits traits. On ajuste ici une
// droite par face :
//
// 1. Orientation locale de chaque point : ACP de ses voisins à 15 cm.
// 2. Faces : tant qu'il reste une orientation dominante, histogramme des
//    décalages en travers de cette orientation ; chaque pic est une face.
//    Ses points, triés le long, sont coupés aux trous (portes, fenêtres) ;
//    chaque tronçon assez plein, sans courbure et plus dense que ses abords
//    donne une droite (moindres carrés totaux).
// 3. Équerre (directions ramenées sur la direction principale ou sa
//    perpendiculaire), traînes de bruit écartées, faces colinéaires ou
//    doublées fusionnées.
// 4. Courbes : cordes courtes qui tournent toujours du même côté, remplacées
//    par un arc de cercle (écrit en polyligne fine).
// 5. Traits courts en biais ou en travers d'un mur écartés (meubles,
//    encombrement), puis coins : les bouts sont prolongés ou raccourcis
//    jusqu'au trait voisin, si le raccord passe sur des points et ne coupe
//    aucun autre trait. Enfin, deux traits qui se croisent sont raccourcis
//    ou le plus court est écarté, et les doublons sont retirés.
// 6. Reste : les points qu'aucun trait n'explique (mobilier, escaliers,
//    terrain) sont tracés par traceSection, pour un calque à part.
//
// Les traits sont tracés dans le repère du profil (s, t), sans exagération.

export interface SectionLines {
    lines: TracedLine[];        // murs (polylignes à 2 points) et courbes
    details: TracedLine[];      // reste du nuage, tracé par traceSection
    walls: number;
    curves: number;
    tolerance: number;          // tolérance du tracé des détails (m)
}

export interface SectionLinesOptions {
    // Direction d'équerre imposée (radians, modulo 90°) : 0 pour une coupe
    // verticale, dont les sols sont horizontaux et les murs verticaux. Sans
    // elle, la direction principale est tirée des murs trouvés.
    square?: number;
}

// Au-delà de 100 000 points, la tranche est éclaircie : un point par case de
// 1 cm (le bruit d'une face en remplit huit en travers, rien ne se perd),
// puis un point sur n. L'orientation locale et les faces coûtent en
// proportion du nombre de points (2,8 s pour 260 000 points serrés, contre
// 0,4 s pour 52 000) ; on lit au plus 250 000 points, comme traceSection.
const MAX_POINTS = 250000;
const FIT_POINTS = 100000;
const THIN_CELL = 0.01;

// ── 1. Orientation locale ──
// Voisins à 15 cm : quatre fois le bruit d'une face, assez pour qu'une bande
// de mur paraisse allongée, assez peu pour ne pas déborder sur le mur d'en
// face (cloisons de 7 à 10 cm). Point orienté si 1 − λ2/λ1 ≥ 0,6.
const NEIGHBOR_RADIUS = 0.15;
const MIN_NEIGHBORS = 6;
const LINEARITY = 0.6;

// ── 2. Faces ──
// Au plus 60 orientations traitées ; chacune bloque ±5° autour d'elle et prend
// les points orientés à ±20° (et ceux sans orientation).
const MAX_DIRECTIONS = 60;
const DIRECTION_LOCK = 5;
const ANGLE_WINDOW = 20;
// Histogramme des décalages en travers : cases de 5 mm, lissage gaussien
// (σ = 3 cases) sur ±8 cases.
const OFFSET_BIN = 0.005;
const OFFSET_SMOOTH = 8;
// Deux pics à moins de 20 cm ne font deux faces (les deux côtés d'une
// cloison) que s'il y a un creux sous 30 % entre eux ; sinon, c'est la
// traîne d'une même bande bruitée.
const TWIN_DISTANCE = 0.2;
const TWIN_DIP = 0.3;
// Tolérance d'une face : 2,5 × l'écart absolu médian (× 1,4826, soit 2,5 σ)
// des points à ±8 cm du pic, bornée entre 2 et 6 cm.
const FACE_REACH = 0.08;
const FACE_TOL_MIN = 0.02;
const FACE_TOL_MAX = 0.06;
const FACE_TOL_MAD = 2.5 * 1.4826;
// Tronçon coupé aux trous de plus de 15 cm (portes, fenêtres) ; gardé s'il
// fait au moins 20 cm et 10 points, avec un point tous les 5 cm en moyenne et
// 60 % des tranches de 5 cm occupées.
const GAP = 0.15;
const MIN_SEGMENT = 0.2;
const MIN_POINTS = 10;
const STEP = 0.05;
const COVERAGE = 0.6;
// Courbe : la parabole ajustée sur les écarts en travers du tronçon a une
// flèche de plus de 2,5 cm entre ses bouts et son milieu. Ses points sont
// laissés aux courbes et au reste. (Un premier critère, la rotation de
// l'orientation locale le long du tronçon, rejetait des murs droits : aux
// deux bouts, l'orientation tourne vers les murs en retour.)
const CURVE_SAGITTA = 0.025;
// Face nette : d'un côté au moins (la pièce), la bande de 10 cm qui longe la
// face, 2 cm au-delà de sa tolérance, a quatre fois moins de points au mètre
// carré que la face. Un amas épais (meubles, escalier, nuage clairsemé) en a
// des deux côtés : on n'y tire pas de droite. Et aucun des deux côtés n'est
// deux fois plus dense que la face : ce ne serait que la traîne clairsemée
// d'une bande voisine (l'autre face d'une cloison, à 10 cm, l'est autant au
// plus).
const FLANK_GAP = 0.02;
const FLANK_WIDTH = 0.1;
const FLANK_RATIO = 0.25;
const FLANK_DENSER = 2;

// ── 3. Équerre et fusion ──
// Trait à moins de 6° de la direction principale ou de sa perpendiculaire :
// ramené dessus.
const SNAP = 6;
// Trait non ramené, à moins de 20° d'une face plus longue et dans sa bande
// (10 cm) : traîne de bruit, écarté.
const TRAIL_ANGLE = 20;
const TRAIL_BAND = 0.1;
// Fusion : colinéaires (décalage ≤ 3 cm, trou ≤ 30 cm), ou parallèles à
// 8 cm au plus qui se recouvrent de plus de 30 % (une bande vue deux fois).
const MERGE_ANGLE = 0.5;
const MERGE_OFFSET = 0.03;
const MERGE_GAP = 0.3;
const MERGE_PARALLEL = 0.08;
const MERGE_OVERLAP = 0.3;

// ── 4. Courbes ──
// Au moins 3 cordes non d'équerre de moins de 1 m, bout à bout (moins de
// 20 cm), qui tournent du même côté de 4 à 50° chacune et de 30° en tout.
// Cercle de Kåsa sur leurs points, gardé si l'écart quadratique moyen est
// sous 2,4 cm (0,6 fois le bruit d'une face) et le rayon sous 10 m. Arc écrit
// en polyligne, à 5 mm près.
const ARC_CHORD = 1;
const ARC_JOIN = 0.2;
const ARC_MIN_CHORDS = 3;
const ARC_TURN_MIN = 4;
const ARC_TURN_MAX = 50;
const ARC_TOTAL = 30;
const ARC_RMS = 0.024;
const ARC_RADIUS = 10;
const ARC_SAGITTA = 0.005;

// ── 5. Encombrement et coins ──
// Trait en biais (ni ramené à l'équerre ni pris dans une courbe) de moins de
// 50 cm : mobilier, objets contre un mur. Ses points vont au reste.
const FREE_MIN = 0.5;
// Trait de moins de 40 cm dont chaque bout tombe, à 12 cm près, au milieu
// d'un trait plus long (à plus de 12 cm de ses bouts) : il traverse la bande
// bruitée d'un mur, ou relie ses deux faces en plein mur. Un vrai retour de
// mur (tableau de porte) part du bout des faces, ou s'écarte d'un bout.
const CROSSING_MAX = 0.4;
const CROSSING_BAND = 0.12;
// Après les coins, un trait couché dans la bande (8 cm) d'un trait plus long,
// sur sa longueur, est un doublon : écarté.
const SWALLOW_BAND = 0.08;
// Coin : bout prolongé ou raccourci jusqu'à l'intersection avec un trait à
// plus de 30°, à moins de 35 cm, sans raccourcir un trait de plus de moitié.
// Un prolongement de plus de 10 cm doit passer sur des points (la moitié des
// tranches de 5 cm à moins de 5 cm du raccord) : pas de raccord à travers une
// porte ou un vide.
const CORNER = 0.35;
const CORNER_SIN = Math.sin(30 * Math.PI / 180);
const CORNER_FREE = 0.1;
const CORNER_REACH = 0.05;
const CORNER_SUPPORT = 0.5;
// Deux traits qui se touchent ne se « coupent » pas : marge de 1 cm.
const CROSS_MARGIN = 0.01;

// ── 6. Reste ──
// Points à moins de 8 cm d'un trait (ou d'une case des détails, si elle est
// plus grande) : bruit de sa face, déjà expliqués.
// Points seuls (moins de 3 voisins à 15 cm, eux compris) : poussière,
// écartés. Le reste, fait de morceaux, ferait grandir les cases de
// traceSection jusqu'à 10 cm, qui relient des amas à travers le vide : les
// cases sont bornées à trois fois l'écart médian des points le long d'un
// trait (2R / médiane du nombre de voisins), entre 2 et 10 cm. Immeuble
// Toulon : 2 cm ; Callian au niveau 3 : 4 cm en plan, 10 cm en coupe.
const EXPLAINED = 0.08;
const DUST = 3;
const DETAIL_SPACING = 3;
const DETAIL_CELL_MIN = 0.02;
const DETAIL_CELL_MAX = 0.1;

const DEG = Math.PI / 180;

type Vec = [number, number];

interface Face {
    th: number;                 // direction [0, π)
    off: number;                // décalage en travers (repère tourné de th)
    u0: number;                 // abscisses des bouts, le long de th
    u1: number;
    ids: number[];              // points de la face
    square: boolean;
    alive: boolean;
}

interface Segment {
    a: Vec;
    b: Vec;
    ids: number[];
    square: boolean;
}

interface Arc {
    cx: number;
    cy: number;
    r: number;
    a0: number;                 // de a0 à a1 > a0, sens trigonométrique
    a1: number;
}

// Écart entre deux directions, modulo π.
const angleDiff = (a: number, b: number) => {
    const d = Math.abs(a - b) % Math.PI;
    return Math.min(d, Math.PI - d);
};

// Système linéaire 3 × 3 (règle de Cramer) ; null s'il est singulier.
const det3 = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
const solve3 = (M: number[][], v: number[]): number[] | null => {
    const d = det3(M);
    if (Math.abs(d) < 1e-12) return null;
    return [0, 1, 2].map(c => det3(M.map((row, r) => row.map((x, k) => (k === c ? v[r] : x)))) / d);
};

const length = (s: Segment) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);

// Paramètres (t sur p1 p2, u sur q1 q2) de l'intersection des deux droites ;
// null si elles sont parallèles.
const intersect = (p1: Vec, p2: Vec, q1: Vec, q2: Vec): [number, number] | null => {
    const rx = p2[0] - p1[0], ry = p2[1] - p1[1], sx = q2[0] - q1[0], sy = q2[1] - q1[1];
    const den = rx * sy - ry * sx;
    if (Math.abs(den) < 1e-12) return null;
    const qx = q1[0] - p1[0], qy = q1[1] - p1[1];
    return [(qx * sy - qy * sx) / den, (qx * ry - qy * rx) / den];
};

/**
 * Traits redressés de la coupe, dans le repère du profil.
 *
 * @param {Float32Array} points - Points de la tranche (s, t alternés).
 * @param {number} total - Nombre de points.
 * @param {SectionLinesOptions} options - Direction d'équerre imposée.
 * @returns {SectionLines} Murs et courbes, détails, et leurs nombres.
 */
export const fitSectionLines = (points: Float32Array, total: number, options: SectionLinesOptions = {}): SectionLines => {
    const empty: SectionLines = { lines: [], details: [], walls: 0, curves: 0, tolerance: 0 };
    if (total < 10) return empty;

    // Tranche très fournie : un point par case de 1 cm, puis un point sur n
    // au-delà de 100 000.
    let pts = points, count = total;
    if (total > FIT_POINTS) {
        const seen = new Set<number>();
        const kept: number[] = [];
        const stride = Math.max(1, total / MAX_POINTS);
        for (let k = 0; k < Math.min(total, MAX_POINTS); k++) {
            const i = Math.floor(k * stride);
            const s = points[i * 2], t = points[i * 2 + 1];
            // Clé numérique de la case (sans collision sous 50 km).
            const key = Math.floor(s / THIN_CELL) * 1e7 + Math.floor(t / THIN_CELL);
            if (seen.has(key)) continue;
            seen.add(key);
            kept.push(i);
        }
        const step = Math.max(1, kept.length / FIT_POINTS);
        count = Math.min(kept.length, FIT_POINTS);
        pts = new Float32Array(count * 2);
        for (let k = 0; k < count; k++) {
            const i = kept[Math.floor(k * step)];
            pts[k * 2] = points[i * 2];
            pts[k * 2 + 1] = points[i * 2 + 1];
        }
    }

    // Grille des voisins (cases de 15 cm), points rangés par case.
    let sMin = Infinity, tMin = Infinity, sMax = -Infinity, tMax = -Infinity;
    for (let i = 0; i < count; i++) {
        const s = pts[i * 2], t = pts[i * 2 + 1];
        if (s < sMin) sMin = s;
        if (s > sMax) sMax = s;
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
    }
    const R = NEIGHBOR_RADIUS;
    const cols = Math.floor((sMax - sMin) / R) + 1, rows = Math.floor((tMax - tMin) / R) + 1;
    const start = new Int32Array(cols * rows + 1);
    const cellOf = new Int32Array(count);
    for (let i = 0; i < count; i++) {
        const k = Math.floor((pts[i * 2 + 1] - tMin) / R) * cols + Math.floor((pts[i * 2] - sMin) / R);
        cellOf[i] = k;
        start[k + 1]++;
    }
    for (let k = 0; k < cols * rows; k++) start[k + 1] += start[k];
    const order = new Int32Array(count);
    const fill = start.slice(0, cols * rows);
    for (let i = 0; i < count; i++) order[fill[cellOf[i]]++] = i;
    // Points des cases à moins de `reach` du segment a b (et quelques
    // autres) : cases prises tous les demi-pas le long du segment, avec
    // leurs voisines. Le rectangle englobant d'un long mur en biais
    // couvrirait presque toute la coupe.
    const stamp = new Int32Array(cols * rows);
    let generation = 0;
    const visit = (a: Vec, b: Vec, reach: number, f: (i: number) => void) => {
        generation++;
        const m = Math.ceil(reach / R);
        const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (R / 2)));
        for (let k = 0; k <= steps; k++) {
            const x = a[0] + (b[0] - a[0]) * k / steps, y = a[1] + (b[1] - a[1]) * k / steps;
            const c0 = Math.floor((x - sMin) / R), r0 = Math.floor((y - tMin) / R);
            for (let r = Math.max(0, r0 - m); r <= Math.min(rows - 1, r0 + m); r++) {
                for (let c = Math.max(0, c0 - m); c <= Math.min(cols - 1, c0 + m); c++) {
                    const cell = r * cols + c;
                    if (stamp[cell] === generation) continue;
                    stamp[cell] = generation;
                    for (let j = start[cell]; j < start[cell + 1]; j++) f(order[j]);
                }
            }
        }
    };

    // ── 1. Orientation locale ──
    const theta = new Float32Array(count).fill(NaN);
    const neighbors = new Uint32Array(count);
    const R2 = R * R;
    for (let i = 0; i < count; i++) {
        const x = pts[i * 2], y = pts[i * 2 + 1];
        const c0 = Math.floor((x - sMin) / R), r0 = Math.floor((y - tMin) / R);
        let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
        // Boucle écrite à plat (sans visit) : c'est l'étape la plus longue.
        for (let r = Math.max(0, r0 - 1); r <= Math.min(rows - 1, r0 + 1); r++) {
            for (let c = Math.max(0, c0 - 1); c <= Math.min(cols - 1, c0 + 1); c++) {
                const k = r * cols + c;
                for (let j = start[k]; j < start[k + 1]; j++) {
                    const q = order[j];
                    const dx = pts[q * 2] - x, dy = pts[q * 2 + 1] - y;
                    if (dx * dx + dy * dy > R2) continue;
                    n++;
                    sx += dx;
                    sy += dy;
                    sxx += dx * dx;
                    syy += dy * dy;
                    sxy += dx * dy;
                }
            }
        }
        neighbors[i] = n;
        if (n < MIN_NEIGHBORS) continue;
        const mx = sx / n, my = sy / n;
        const a = sxx / n - mx * mx, b = sxy / n - mx * my, d = syy / n - my * my;
        const disc = Math.sqrt(Math.max(0, (a - d) * (a - d) / 4 + b * b));
        const l1 = (a + d) / 2 + disc, l2 = (a + d) / 2 - disc;
        if (l1 <= 0 || 1 - l2 / l1 < LINEARITY) continue;
        let th = 0.5 * Math.atan2(2 * b, a - d);
        if (th < 0) th += Math.PI;
        theta[i] = th;
    }

    // ── 2. Faces ──
    const used = new Uint8Array(count);
    const faces: Face[] = [];
    const blocked = new Uint8Array(180);
    const histogram = new Float64Array(180);
    const kernel = Array.from({ length: 2 * OFFSET_SMOOTH + 1 }, (_, k) => Math.exp(-((k - OFFSET_SMOOTH) ** 2) / 18));
    const offsetOf = new Float64Array(count);
    const alongOf = new Float64Array(count);
    for (let iter = 0; iter < MAX_DIRECTIONS; iter++) {
        histogram.fill(0);
        for (let i = 0; i < count; i++) if (!used[i] && !Number.isNaN(theta[i])) histogram[Math.floor(theta[i] / DEG) % 180]++;
        let best = -1, bestWeight = 0;
        for (let b = 0; b < 180; b++) {
            if (blocked[b]) continue;
            let w = 0;
            for (let k = -2; k <= 2; k++) w += histogram[(b + k + 180) % 180] * (3 - Math.abs(k));
            if (w > bestWeight) {
                bestWeight = w;
                best = b;
            }
        }
        // Moins qu'une petite face (10 points) vue sur la fenêtre pondérée :
        // plus d'orientation dominante.
        if (best < 0 || bestWeight < 9 * MIN_POINTS) break;
        for (let k = -DIRECTION_LOCK; k <= DIRECTION_LOCK; k++) blocked[(best + k + 180) % 180] = 1;
        const th = (best + 0.5) * DEG;
        const ux = Math.cos(th), uy = Math.sin(th);

        // Candidats rangés par case de décalage en travers (tri par
        // comptage : sur un grand site, un tri complet à chaque orientation
        // coûtait plusieurs secondes).
        const list: number[] = [];
        let oMin = Infinity, oMax = -Infinity;
        for (let i = 0; i < count; i++) {
            if (used[i] || (!Number.isNaN(theta[i]) && angleDiff(theta[i], th) > ANGLE_WINDOW * DEG)) continue;
            list.push(i);
            const o = -pts[i * 2] * uy + pts[i * 2 + 1] * ux;
            offsetOf[i] = o;
            if (o < oMin) oMin = o;
            if (o > oMax) oMax = o;
        }
        if (list.length < MIN_POINTS) continue;
        const nb = Math.floor((oMax - oMin) / OFFSET_BIN) + 1;
        const binOf = (o: number) => Math.min(nb - 1, Math.max(0, Math.floor((o - oMin) / OFFSET_BIN)));
        const raw = new Float64Array(nb);
        const binStart = new Int32Array(nb + 1);
        for (const i of list) binStart[binOf(offsetOf[i]) + 1]++;
        for (let b = 0; b < nb; b++) {
            raw[b] = binStart[b + 1];
            binStart[b + 1] += binStart[b];
        }
        const cand = new Int32Array(list.length);
        const cursor = binStart.slice(0, nb);
        for (const i of list) cand[cursor[binOf(offsetOf[i])]++] = i;
        // Candidats libres de décalage dans [lo, hi).
        const between = (lo: number, hi: number, f: (i: number) => void) => {
            for (let j = binStart[binOf(lo)]; j < binStart[binOf(hi) + 1]; j++) {
                const i = cand[j];
                if (!used[i] && offsetOf[i] >= lo && offsetOf[i] < hi) f(i);
            }
        };
        const smooth = new Float64Array(nb);
        for (let b = 0; b < nb; b++) {
            for (let k = -OFFSET_SMOOTH; k <= OFFSET_SMOOTH; k++) smooth[b] += (raw[b + k] ?? 0) * kernel[k + OFFSET_SMOOTH];
        }
        const peaks: number[] = [];
        for (let b = 0; b < nb; b++) {
            if (smooth[b] >= MIN_POINTS * 0.8 && smooth[b] >= (smooth[b - 1] ?? 0) && smooth[b] > (smooth[b + 1] ?? 0)) peaks.push(b);
        }
        peaks.sort((p, q) => smooth[q] - smooth[p]);

        const accepted: number[] = [];
        for (const pb of peaks) {
            let twin = false;
            for (const q of accepted) {
                if (Math.abs(q - pb) * OFFSET_BIN > TWIN_DISTANCE) continue;
                let low = Infinity;
                for (let b = Math.min(q, pb); b <= Math.max(q, pb); b++) low = Math.min(low, smooth[b]);
                if (low > TWIN_DIP * smooth[pb]) twin = true;
            }
            if (twin) continue;
            accepted.push(pb);
            const peak = oMin + (pb + 0.5) * OFFSET_BIN;

            const near: number[] = [];
            between(peak - FACE_REACH, peak + FACE_REACH, i => near.push(Math.abs(offsetOf[i] - peak)));
            if (near.length < MIN_POINTS) continue;
            near.sort((p, q) => p - q);
            const tol = Math.min(FACE_TOL_MAX, Math.max(FACE_TOL_MIN, FACE_TOL_MAD * near[near.length >> 1]));
            const face: number[] = [];
            between(peak - tol, peak + tol, i => face.push(i));
            if (face.length < MIN_POINTS) continue;

            // Tronçons, coupés aux trous.
            for (const i of face) alongOf[i] = pts[i * 2] * ux + pts[i * 2 + 1] * uy;
            face.sort((p, q) => alongOf[p] - alongOf[q]);
            const flush = (run: number[]) => {
                if (run.length < MIN_POINTS) return;
                const u0 = alongOf[run[0]], u1 = alongOf[run[run.length - 1]];
                if (u1 - u0 < MIN_SEGMENT || run.length < (u1 - u0) / STEP) return;
                const occupied = new Set<number>();
                for (const i of run) occupied.add(Math.floor((alongOf[i] - u0) / STEP));
                if (occupied.size < COVERAGE * Math.ceil((u1 - u0) / STEP + 1e-9)) return;
                // Courbure : écart en travers o = a + b u + c u², u compté
                // depuis le milieu ; flèche c L² / 4.
                {
                    const um = (u0 + u1) / 2;
                    let s1 = 0, s2 = 0, s3 = 0, s4 = 0, so = 0, suo = 0, suuo = 0;
                    for (const i of run) {
                        const u = alongOf[i] - um, o = offsetOf[i] - peak, uu = u * u;
                        s1 += u;
                        s2 += uu;
                        s3 += uu * u;
                        s4 += uu * uu;
                        so += o;
                        suo += u * o;
                        suuo += uu * o;
                    }
                    const fit = solve3([[run.length, s1, s2], [s1, s2, s3], [s2, s3, s4]], [so, suo, suuo]);
                    if (fit && Math.abs(fit[2]) * (u1 - u0) ** 2 / 4 > CURVE_SAGITTA) return;
                }
                // Côtés de la face.
                {
                    const lo = tol + FLANK_GAP, hi = lo + FLANK_WIDTH;
                    let inner = 0, left = 0, right = 0;
                    const ax = ux * u0 - uy * peak, ay = uy * u0 + ux * peak;
                    const bx = ux * u1 - uy * peak, by = uy * u1 + ux * peak;
                    visit([ax, ay], [bx, by], hi, (i) => {
                        const u = pts[i * 2] * ux + pts[i * 2 + 1] * uy;
                        if (u < u0 || u > u1) return;
                        const o = -pts[i * 2] * uy + pts[i * 2 + 1] * ux - peak;
                        if (Math.abs(o) < tol) inner++;
                        else if (o >= lo && o < hi) left++;
                        else if (o <= -lo && o > -hi) right++;
                    });
                    const density = inner / (2 * tol);
                    if (Math.min(left, right) / FLANK_WIDTH > FLANK_RATIO * density || Math.max(left, right) / FLANK_WIDTH > FLANK_DENSER * density) return;
                }
                // Moindres carrés totaux.
                let mx = 0, my = 0;
                for (const i of run) {
                    mx += pts[i * 2];
                    my += pts[i * 2 + 1];
                }
                mx /= run.length;
                my /= run.length;
                let a2 = 0, b2 = 0, d2 = 0;
                for (const i of run) {
                    const dx = pts[i * 2] - mx, dy = pts[i * 2 + 1] - my;
                    a2 += dx * dx;
                    b2 += dx * dy;
                    d2 += dy * dy;
                }
                let t2 = 0.5 * Math.atan2(2 * b2, a2 - d2);
                if (t2 < 0) t2 += Math.PI;
                if (angleDiff(t2, th) > ANGLE_WINDOW * DEG) t2 = th;
                const vx = Math.cos(t2), vy = Math.sin(t2);
                let lo = Infinity, hi = -Infinity;
                for (const i of run) {
                    const u = (pts[i * 2] - mx) * vx + (pts[i * 2 + 1] - my) * vy;
                    if (u < lo) lo = u;
                    if (u > hi) hi = u;
                }
                for (const i of run) used[i] = 1;
                const mu = mx * vx + my * vy;
                faces.push({ th: t2, off: -mx * vy + my * vx, u0: mu + lo, u1: mu + hi, ids: run, square: false, alive: true });
            };
            let runStart = 0;
            for (let k = 1; k < face.length; k++) {
                if (alongOf[face[k]] - alongOf[face[k - 1]] > GAP) {
                    flush(face.slice(runStart, k));
                    runStart = k;
                }
            }
            flush(face.slice(runStart));
        }
    }

    // ── 3. Équerre ──
    // Direction principale : pic, modulo 90°, des directions pondérées par la
    // longueur (fenêtre de 5°), affiné par la moyenne à ±3° du pic.
    let main = options.square;
    if (main === undefined) {
        const h90 = new Float64Array(90);
        for (const f of faces) h90[Math.floor((f.th / DEG) % 90)] += f.u1 - f.u0;
        let m90 = 0, mw = -1;
        for (let b = 0; b < 90; b++) {
            let w = 0;
            for (let k = -2; k <= 2; k++) w += h90[(b + k + 90) % 90];
            if (w > mw) {
                mw = w;
                m90 = b;
            }
        }
        let sw = 0, sa = 0;
        for (const f of faces) {
            let d = (f.th / DEG) % 90 - (m90 + 0.5);
            if (d > 45) d -= 90;
            if (d < -45) d += 90;
            if (Math.abs(d) < 3) {
                sw += f.u1 - f.u0;
                sa += d * (f.u1 - f.u0);
            }
        }
        main = (m90 + 0.5 + (sw ? sa / sw : 0)) * DEG;
    }
    main = ((main % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
    // Centre d'une face.
    const middle = (f: Face): Vec => {
        const m = (f.u0 + f.u1) / 2, c = Math.cos(f.th), s = Math.sin(f.th);
        return [c * m - s * f.off, s * m + c * f.off];
    };
    for (const f of faces) {
        for (const q of [main, main + Math.PI / 2]) {
            if (angleDiff(f.th, q) >= SNAP * DEG) continue;
            const [mx, my] = middle(f), half = (f.u1 - f.u0) / 2;
            f.th = q % Math.PI;
            const ux = Math.cos(f.th), uy = Math.sin(f.th), mu = mx * ux + my * uy;
            f.off = -mx * uy + my * ux;
            f.u0 = mu - half;
            f.u1 = mu + half;
            f.square = true;
            break;
        }
    }
    // Traînes de bruit.
    for (const f of faces) {
        if (f.square) continue;
        const [sx, sy] = middle(f);
        for (const q of faces) {
            if (q === f || !q.alive || q.u1 - q.u0 <= f.u1 - f.u0 || angleDiff(q.th, f.th) > TRAIL_ANGLE * DEG) continue;
            const ux = Math.cos(q.th), uy = Math.sin(q.th), u = sx * ux + sy * uy;
            if (Math.abs(-sx * uy + sy * ux - q.off) < TRAIL_BAND && u > q.u0 && u < q.u1) {
                f.alive = false;
                break;
            }
        }
    }
    // Fusion.
    for (let changed = true; changed;) {
        changed = false;
        for (const a of faces) {
            if (!a.alive) continue;
            for (const b of faces) {
                if (b === a || !b.alive || angleDiff(a.th, b.th) > MERGE_ANGLE * DEG) continue;
                const ux = Math.cos(a.th), uy = Math.sin(a.th);
                const [bx, by] = middle(b);
                const boff = -bx * uy + by * ux, bu = bx * ux + by * uy, bh = (b.u1 - b.u0) / 2;
                const gap = Math.max(bu - bh - a.u1, a.u0 - (bu + bh));
                const doff = Math.abs(boff - a.off);
                const overlap = -gap / Math.min(a.u1 - a.u0, 2 * bh);
                if (!((doff <= MERGE_OFFSET && gap <= MERGE_GAP) || (doff <= MERGE_PARALLEL && overlap > MERGE_OVERLAP))) continue;
                const la = a.u1 - a.u0, lb = 2 * bh;
                a.off = (a.off * la + boff * lb) / (la + lb);
                a.u0 = Math.min(a.u0, bu - bh);
                a.u1 = Math.max(a.u1, bu + bh);
                a.ids = a.ids.concat(b.ids);
                b.alive = false;
                changed = true;
            }
        }
    }
    let segments: Segment[] = faces.filter(f => f.alive).map((f) => {
        const ux = Math.cos(f.th), uy = Math.sin(f.th);
        return {
            a: [ux * f.u0 - uy * f.off, uy * f.u0 + ux * f.off],
            b: [ux * f.u1 - uy * f.off, uy * f.u1 + ux * f.off],
            ids: f.ids,
            square: f.square
        };
    });

    // ── 4. Courbes ──
    const circleFit = (ids: number[]) => {
        // Kåsa : x² + y² + D x + E y + F = 0, moindres carrés, autour du
        // premier point (sommes mieux conditionnées).
        const ox = pts[ids[0] * 2], oy = pts[ids[0] * 2 + 1];
        let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sz = 0, sxz = 0, syz = 0;
        const n = ids.length;
        for (const i of ids) {
            const x = pts[i * 2] - ox, y = pts[i * 2 + 1] - oy, z = x * x + y * y;
            sx += x;
            sy += y;
            sxx += x * x;
            syy += y * y;
            sxy += x * y;
            sz += z;
            sxz += x * z;
            syz += y * z;
        }
        const sol = solve3([[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]], [-sxz, -syz, -sz]);
        if (!sol) return null;
        const cx = -sol[0] / 2, cy = -sol[1] / 2, r2 = cx * cx + cy * cy - sol[2];
        if (!(r2 > 0)) return null;
        const r = Math.sqrt(r2);
        let e = 0;
        for (const i of ids) e += (Math.hypot(pts[i * 2] - ox - cx, pts[i * 2 + 1] - oy - cy) - r) ** 2;
        return { cx: cx + ox, cy: cy + oy, r, rms: Math.sqrt(e / n) };
    };
    const arcs: (Arc & { ids: number[] })[] = [];
    {
        const short = segments.filter(s => !s.square && length(s) < ARC_CHORD);
        const near = (p: Vec, q: Vec) => Math.hypot(p[0] - q[0], p[1] - q[1]) < ARC_JOIN;
        const dir = (s: Segment) => Math.atan2(s.b[1] - s.a[1], s.b[0] - s.a[0]);
        const turnOf = (a: Segment, b: Segment) => Math.atan2(Math.sin(dir(b) - dir(a)), Math.cos(dir(b) - dir(a)));
        const taken = new Set<Segment>();
        for (const s0 of short) {
            if (taken.has(s0)) continue;
            // Chaîne dans les deux sens à partir de s0 ; une corde peut être
            // retournée pour se raccorder.
            const chain: Segment[] = [s0];
            for (const forward of [true, false]) {
                for (;;) {
                    const tip = forward ? chain[chain.length - 1] : chain[0];
                    const end = forward ? tip.b : tip.a;
                    let next: Segment | null = null;
                    for (const q of short) {
                        if (chain.includes(q) || taken.has(q)) continue;
                        if (near(end, forward ? q.a : q.b)) {
                            next = q;
                        } else if (near(end, forward ? q.b : q.a)) {
                            [q.a, q.b] = [q.b, q.a];
                            next = q;
                        }
                        if (next) break;
                    }
                    if (!next) break;
                    const turn = forward ? turnOf(tip, next) : turnOf(next, tip);
                    if (Math.abs(turn) < ARC_TURN_MIN * DEG || Math.abs(turn) > ARC_TURN_MAX * DEG) break;
                    // Toujours du même côté.
                    if (chain.length >= 2 && Math.sign(turn) !== Math.sign(turnOf(chain[0], chain[1]))) break;
                    if (forward) chain.push(next);
                    else chain.unshift(next);
                }
            }
            if (chain.length < ARC_MIN_CHORDS) continue;
            let totalTurn = 0;
            for (let k = 1; k < chain.length; k++) totalTurn += turnOf(chain[k - 1], chain[k]);
            if (Math.abs(totalTurn) < ARC_TOTAL * DEG) continue;
            const ids = chain.flatMap(s => s.ids);
            const c = circleFit(ids);
            if (!c || c.rms > ARC_RMS || c.r > ARC_RADIUS) continue;
            const first = Math.atan2(chain[0].a[1] - c.cy, chain[0].a[0] - c.cx);
            const last = Math.atan2(chain[chain.length - 1].b[1] - c.cy, chain[chain.length - 1].b[0] - c.cx);
            let a0 = totalTurn > 0 ? first : last, a1 = totalTurn > 0 ? last : first;
            while (a1 < a0) a1 += 2 * Math.PI;
            if (a1 - a0 > 2 * Math.PI - 1e-6) a0 = a1 - 2 * Math.PI;
            arcs.push({ cx: c.cx, cy: c.cy, r: c.r, a0, a1, ids });
            for (const s of chain) taken.add(s);
        }
        segments = segments.filter(s => !taken.has(s));
    }

    // ── 5. Encombrement et coins ──
    segments = segments.filter(s => s.square || length(s) >= FREE_MIN);
    const inside = (p: Vec, ls: number) => segments.some((q) => {
        const lq = length(q);
        if (lq <= ls) return false;
        const ux = (q.b[0] - q.a[0]) / lq, uy = (q.b[1] - q.a[1]) / lq;
        const x = p[0] - q.a[0], y = p[1] - q.a[1], u = x * ux + y * uy;
        return u > CROSSING_BAND && u < lq - CROSSING_BAND && Math.abs(-x * uy + y * ux) < CROSSING_BAND;
    });
    segments = segments.filter((s) => {
        const ls = length(s);
        return ls >= CROSSING_MAX || !inside(s.a, ls) || !inside(s.b, ls);
    });

    // Le raccord p → q passe-t-il sur des points ?
    const supported = (p: Vec, q: Vec) => {
        const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy);
        if (len <= CORNER_FREE) return true;
        const ux = dx / len, uy = dy / len;
        const bins = Math.ceil(len / STEP);
        const hit = new Uint8Array(bins);
        const e = CORNER_REACH;
        visit(p, q, e, (i) => {
            const x = pts[i * 2] - p[0], y = pts[i * 2 + 1] - p[1];
            const u = x * ux + y * uy;
            if (u < 0 || u >= len || Math.abs(-x * uy + y * ux) > e) return;
            hit[Math.min(bins - 1, Math.floor(u / STEP))] = 1;
        });
        let n = 0;
        for (let k = 0; k < bins; k++) n += hit[k];
        return n >= CORNER_SUPPORT * bins;
    };
    // Le raccord p → q coupe-t-il un trait (autre que ceux qui se raccordent) ?
    const crosses = (p: Vec, q: Vec, skip: Segment[]) => {
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (len < CROSS_MARGIN) return false;
        for (const o of segments) {
            if (skip.includes(o)) continue;
            const x = intersect(p, q, o.a, o.b);
            if (!x) continue;
            const lo = length(o);
            if (x[0] > CROSS_MARGIN / len && x[0] <= 1 && x[1] > CROSS_MARGIN / lo && x[1] < 1 - CROSS_MARGIN / lo) return true;
        }
        return false;
    };
    // Coins candidats : bout de s et bout de q (coin en L), ou bout de s et
    // milieu de q (en T). Du plus court au plus long, un bout ne sert
    // qu'une fois.
    type End = 'a' | 'b';
    const other = (e: End): End => (e === 'a' ? 'b' : 'a');
    const candidates: { s: Segment; se: End; q: Segment; qe: End | null; x: Vec; d: number }[] = [];
    for (const s of segments) {
        const ls = length(s);
        for (const q of segments) {
            if (q === s) continue;
            const lq = length(q);
            const sx = s.b[0] - s.a[0], sy = s.b[1] - s.a[1], qx = q.b[0] - q.a[0], qy = q.b[1] - q.a[1];
            if (Math.abs(sx * qy - sy * qx) < CORNER_SIN * ls * lq) continue;
            const t = intersect(s.a, s.b, q.a, q.b);
            if (!t) continue;
            const x: Vec = [s.a[0] + t[0] * sx, s.a[1] + t[0] * sy];
            for (const se of ['a', 'b'] as End[]) {
                const ds = Math.hypot(x[0] - s[se][0], x[1] - s[se][1]);
                // Le bout le plus proche de x seulement, à moins de 35 cm, et
                // le trait raccourci de moitié au plus.
                if (ds >= CORNER || (se === 'a') !== (t[0] < 0.5)) continue;
                if (Math.hypot(x[0] - s[other(se)][0], x[1] - s[other(se)][1]) < 0.5 * ls) continue;
                const qe: End = t[1] < 0.5 ? 'a' : 'b';
                const dq = Math.hypot(x[0] - q[qe][0], x[1] - q[qe][1]);
                if (dq < CORNER && Math.hypot(x[0] - q[other(qe)][0], x[1] - q[other(qe)][1]) >= 0.5 * lq) {
                    if (s !== q && segments.indexOf(s) < segments.indexOf(q)) candidates.push({ s, se, q, qe, x, d: ds + dq });
                } else if (t[1] > 0 && t[1] < 1) {
                    candidates.push({ s, se, q, qe: null, x, d: ds });
                }
            }
        }
    }
    candidates.sort((p, q) => p.d - q.d);
    const done = new Set<string>();
    const key = (s: Segment, e: End) => `${segments.indexOf(s)}${e}`;
    for (const c of candidates) {
        const { s, se, q, qe, x } = c;
        if (done.has(key(s, se)) || (qe && done.has(key(q, qe)))) continue;
        // En T : x doit toujours être sur q (q a pu être raccourci).
        if (!qe) {
            const t = intersect(s.a, s.b, q.a, q.b);
            if (!t || t[1] <= 0 || t[1] >= 1) continue;
        }
        const moves: [Segment, End][] = qe ? [[s, se], [q, qe]] : [[s, se]];
        // Seuls les prolongements sont contrôlés : raccourcir n'ajoute rien.
        const ok = moves.every(([g, e]) => {
            const p = g[e], o = g[other(e)];
            const grows = Math.hypot(x[0] - o[0], x[1] - o[1]) > Math.hypot(p[0] - o[0], p[1] - o[1]);
            return !grows || (supported(p, x) && !crosses(p, x, [s, q]));
        });
        if (!ok) continue;
        for (const [g, e] of moves) {
            g[e] = [x[0], x[1]];
            done.add(key(g, e));
        }
    }
    // Croisements : deux murs ne se traversent pas. Un trait qui dépasse
    // l'autre de moins de 35 cm est raccourci au croisement ; sinon le plus
    // court des deux est écarté (ses points vont au reste).
    for (let changed = true, guard = 0; changed && guard < 4 * segments.length; guard++) {
        changed = false;
        for (let i = 0; i < segments.length && !changed; i++) {
            for (let j = i + 1; j < segments.length && !changed; j++) {
                const s = segments[i], q = segments[j];
                const ls = length(s), lq = length(q);
                const t = intersect(s.a, s.b, q.a, q.b);
                if (!t || t[0] <= CROSS_MARGIN / ls || t[0] >= 1 - CROSS_MARGIN / ls || t[1] <= CROSS_MARGIN / lq || t[1] >= 1 - CROSS_MARGIN / lq) continue;
                const x: Vec = [s.a[0] + t[0] * (s.b[0] - s.a[0]), s.a[1] + t[0] * (s.b[1] - s.a[1])];
                // Bout qui dépasse le moins, de chaque trait.
                const over = (g: Segment, u: number, lg: number): [End, number] => (u < 0.5 ? ['a', u * lg] : ['b', (1 - u) * lg]);
                const [se, ds] = over(s, t[0], ls), [qe, dq] = over(q, t[1], lq);
                const [g, e, d, lg] = ds <= dq ? [s, se, ds, ls] : [q, qe, dq, lq];
                if (d < CORNER && d < 0.5 * lg) g[e] = x;
                else segments.splice(ls < lq ? i : j, 1);
                changed = true;
            }
        }
    }
    const alongside = (p: Vec, q: Segment, lq: number, band: number) => {
        const ux = (q.b[0] - q.a[0]) / lq, uy = (q.b[1] - q.a[1]) / lq;
        const x = p[0] - q.a[0], y = p[1] - q.a[1], u = x * ux + y * uy;
        return u > -band && u < lq + band && Math.abs(-x * uy + y * ux) < band;
    };
    segments = segments.filter((s) => {
        const ls = length(s);
        return !segments.some((q) => {
            const lq = length(q);
            return lq > ls && alongside(s.a, q, lq, SWALLOW_BAND) && alongside(s.b, q, lq, SWALLOW_BAND);
        });
    });

    // ── 6. Reste ──
    const sample: number[] = [];
    for (let i = 0; i < count; i += Math.max(1, Math.floor(count / 20000))) sample.push(neighbors[i]);
    sample.sort((p, q) => p - q);
    const spacing = 2 * R / Math.max(1, sample[sample.length >> 1]);
    const detailCell = Math.min(DETAIL_CELL_MAX, Math.max(DETAIL_CELL_MIN, DETAIL_SPACING * spacing));
    const reach = Math.max(EXPLAINED, detailCell);
    const explained = new Uint8Array(count);
    for (const s of segments) for (const i of s.ids) explained[i] = 1;
    for (const a of arcs) for (const i of a.ids) explained[i] = 1;
    // Bruit d'une face, à moins de 8 cm de son trait.
    for (const s of segments) {
        const len = length(s);
        if (len < 1e-9) continue;
        const ux = (s.b[0] - s.a[0]) / len, uy = (s.b[1] - s.a[1]) / len, e = reach;
        visit(s.a, s.b, e, (i) => {
            if (explained[i]) return;
            const x = pts[i * 2] - s.a[0], y = pts[i * 2 + 1] - s.a[1], u = x * ux + y * uy;
            if (u >= -e && u <= len + e && Math.abs(-x * uy + y * ux) <= e) explained[i] = 1;
        });
    }
    // Arcs en polylignes, à 5 mm près.
    const curves = arcs.map((a) => {
        const step = 2 * Math.acos(Math.max(-1, 1 - ARC_SAGITTA / a.r));
        const n = Math.max(4, Math.ceil((a.a1 - a.a0) / step));
        const p: number[] = [];
        for (let k = 0; k <= n; k++) {
            const ang = a.a0 + (a.a1 - a.a0) * k / n;
            p.push(a.cx + a.r * Math.cos(ang), a.cy + a.r * Math.sin(ang));
        }
        return p;
    });
    arcs.forEach((a, k) => {
        const p = curves[k];
        for (let j = 2; j < p.length; j += 2) {
            visit([p[j - 2], p[j - 1]], [p[j], p[j + 1]], reach, (i) => {
                if (explained[i]) return;
                const x = pts[i * 2] - a.cx, y = pts[i * 2 + 1] - a.cy;
                if (Math.abs(Math.hypot(x, y) - a.r) > reach) return;
                let ang = Math.atan2(y, x);
                while (ang < a.a0) ang += 2 * Math.PI;
                if (ang <= a.a1) explained[i] = 1;
            });
        }
    });
    for (let i = 0; i < count; i++) if (neighbors[i] < DUST) explained[i] = 1;
    let restCount = 0;
    for (let i = 0; i < count; i++) if (!explained[i]) restCount++;
    const rest = new Float32Array(restCount * 2);
    for (let i = 0, k = 0; i < count; i++) {
        if (explained[i]) continue;
        rest[k++] = pts[i * 2];
        rest[k++] = pts[i * 2 + 1];
    }
    const trace = traceSection(rest, restCount, detailCell);

    const lines: TracedLine[] = segments.map(s => ({ points: [s.a[0], s.a[1], s.b[0], s.b[1]], closed: false }));
    for (const p of curves) lines.push({ points: p, closed: false });
    return { lines, details: trace.lines, walls: segments.length, curves: arcs.length, tolerance: trace.tolerance };
};
