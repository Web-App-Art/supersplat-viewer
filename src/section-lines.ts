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
// 4. Courbes (lot 2) : les points orientés hors des murs d'équerre votent
//    pour les centres des cercles qui leur sont tangents ; chaque centre
//    candidat donne un cercle ajusté de proche en proche, gardé s'il
//    explique les points nettement mieux qu'une droite ou que deux (coin),
//    puis écrit en vrai arc. Les droites qui n'en étaient que des cordes
//    sont retirées.
// 5. Traits courts en biais ou en travers d'un mur écartés (meubles,
//    encombrement), puis coins en L et raccords en T (mur qui bute au milieu
//    d'un autre) : les bouts sont prolongés ou raccourcis jusqu'au trait
//    voisin, si le raccord passe sur des points et ne coupe aucun autre
//    trait. Enfin, deux traits (droites ou arcs) qui se croisent sont
//    raccourcis ou le plus court est écarté, les bouts des arcs sont
//    raccordés aux droites voisines, et les doublons sont retirés.
// 6. Reste : les points qu'aucun trait n'explique (mobilier, escaliers,
//    terrain) sont tracés par traceSection, pour un calque à part.
//
// Les traits sont tracés dans le repère du profil (s, t), sans exagération.

// Arc de cercle, de a0 à a1 (radians, sens trigonométrique, a0 < a1 ≤ a0 + 2π ;
// a1 − a0 = 2π : cercle entier).
export interface SectionArc {
    cx: number;
    cy: number;
    r: number;
    a0: number;
    a1: number;
}

export interface SectionLines {
    lines: TracedLine[];        // murs (polylignes à 2 points)
    arcs: SectionArc[];         // courbes
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
// Les cordes d'une courbe ne suffisent pas à la trouver (une baie clairsemée
// donne des droites tronquées, un poteau aucune). Chaque point orienté qui
// n'est ni sur un mur d'équerre ni sur un long mur (2 m) vote pour les
// centres des cercles qui lui sont tangents : à la distance r, de part et d'autre, pour 35 rayons de 8 cm
// à 10 m (pas de 15 %). Les votes d'un arc tombent dans la même case, ceux
// d'un mur droit s'étalent le long d'une parallèle. Cases de 12 % du rayon
// (l'orientation locale d'une courbe clairsemée est juste à 10° près, et on
// réunit 3 × 3 cases), 2 cm au moins. Un votant par case de 4 cm, au plus
// 4 000 (un sur n au-delà), 60 candidats d'au moins 12 votes, maximums
// locaux en position et en rayon.
const ARC_POOL_LONG = 2;
const ARC_R_MIN = 0.08;
const ARC_R_MAX = 10;
const ARC_R_STEP = 1.15;
const ARC_CELL = 0.12;
const ARC_CELL_MIN = 0.02;
const ARC_VOTER_CELL = 0.04;
const ARC_VOTERS = 4000;
const ARC_VOTES = 12;
const ARC_CANDIDATES = 60;
// Candidats : la partie du cercle où sont leurs votants (le complément du
// plus grand trou entre leurs angles). La longueur que couvrent les votants
// (tranches de 10 cm) en fait au moins 25 % : les quatre murs d'une pièce
// votent pour un cercle centré dans la pièce, mais par quatre paquets
// étroits (un poteau couvre 90 % de son tour, une pièce 10 % de son
// cercle). Leurs orientations suivent la tangente mieux que leur moyenne
// (ARC_BETTER) : un mur droit vote beaucoup pour un grand rayon, mais avec
// une seule orientation. Classement : nombre de tranches de 10° occupées
// par les votants, multiplié par cette part (un poteau passe ainsi devant
// les grands cercles de hasard, plus riches en votes).
const ARC_VOTE_FILL = 0.25;
const ARC_VOTE_BIN = 10;
// Les votants d'un candidat couvrent au moins les trois quarts de
// l'ouverture et de la longueur minimales d'un arc.
const ARC_VOTE_SPAN = 0.75;
// Ajustement, sur les points à ±8 cm du cercle dont l'orientation suit la
// tangente à 20° près (ou sans orientation) : tolérance comme pour une face
// (2,5 σ, 2 à 6 cm), cercle géométrique (Gauss-Newton). On part du plus
// fourni des tronçons de la partie des votants, puis, en 4 tours au plus,
// la fenêtre s'étend de 1 m de chaque côté et garde les tronçons qui
// touchent les précédents ; fini quand le cercle bouge de moins de 5 mm.
// Validation : un arc garde au moins 25 cm, 10 points, un point tous les
// 5 cm, une flèche de 2,5 cm (sinon c'est une droite) et 20° d'ouverture.
// Dans un coin ou du mobilier, un cercle trouve des points mais pas leurs
// orientations : 70 % des points orientés de l'arc doivent suivre la
// tangente. Ses côtés sont contrôlés comme ceux d'une face (FLANK_*).
const ARC_TANGENT = 20;
const ARC_MIN_LENGTH = 0.25;
const ARC_MIN_SPAN = 20;
const ARC_AGREE = 0.7;
const ARC_ITERATIONS = 4;
const ARC_GROW = 1;
const ARC_STABLE = 0.005;
// Trous : 30 cm (une courbe clairsemée se lit par paquets). Occupation :
// 60 % des tranches de 10 cm, une tranche comptant si elle a 2 points et
// 15 % du nombre moyen par tranche (un paquet serré relié par quelques
// points épars n'est pas un arc).
const ARC_GAP = 0.3;
const ARC_STEP = 0.1;
const ARC_EVEN = 0.15;
// Mieux qu'une droite : l'écart moyen des orientations à la tangente sous
// 0,5 fois celui à la droite ajustée sur les mêmes points, et l'écart
// quadratique moyen des distances au cercle sous 0,35 fois celui à la
// droite. Une bande de mur bruitée prise pour un grand arc, un coin arrondi
// par le bruit ou un amas de mobilier n'y arrivent pas (0,4 à 0,6 en
// distance) ; un poteau est à 0,1, la baie de l'Immeuble Toulon à 0,05.
const ARC_BETTER = 0.5;
const ARC_CLOSER = 0.35;
// Nuage clairsemé (arbres, végétation, bruit) : au moins 55 % des points de
// l'arc sont orientés et suivent la tangente, et l'écart quadratique
// moyen au cercle est sous 6 % du rayon (1,5 cm au moins). Poteau : 85 % et
// 1,1 cm pour 13,6 cm ; baie de Toulon : 86 % et 3,1 cm pour 1,9 m ; cercles
// de hasard : 3 cm pour 30 cm, ou des points sans orientation.
const ARC_ORIENTED = 0.55;
const ARC_THIN = 0.06;
const ARC_THIN_MIN = 0.015;
// Coin arrondi par le bruit : deux droites (coupées au mieux) font au moins
// aussi bien que le cercle, en écart quadratique. Sur un vrai arc de plus de
// 30°, les deux cordes laissent une flèche.
const ARC_CORNER = 1;
// Droite dont les deux bouts et le milieu sont sur un arc (à sa tolérance
// plus 3 cm) : une corde de l'arc, écartée. Droite dont la moitié des points
// sont pris par un arc : écartée aussi.
const ARC_CHORD_BAND = 0.03;
// Arc suivi en polyligne à 5 mm près pour marquer les points qu'il explique
// (le reste) ; le dessin, lui, l'écrit en vrai arc.
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
// plus de 30°, à moins de 45 cm (35 cm au lot 1 : trop de coins restaient
// ouverts), sans raccourcir un trait de plus de moitié.
// Un prolongement de plus de 10 cm doit passer sur des points (la moitié des
// tranches de 5 cm à moins de 5 cm du raccord) : pas de raccord à travers une
// porte ou un vide.
const CORNER = 0.45;
const CORNER_SIN = Math.sin(30 * Math.PI / 180);
const CORNER_FREE = 0.1;
const CORNER_REACH = 0.05;
const CORNER_SUPPORT = 0.5;
// En T : l'autre trait dépasse le croisement de plus de 10 cm et son bout
// est à moins de 10 cm d'un troisième trait (l'autre face du mur où il
// bute) ; il ne bouge pas, seul le trait qui bute est prolongé. Sans ce
// troisième trait, c'est un coin en L : dans un coin, chaque face dépasse
// de 10 à 20 cm dans la bande de l'autre mur.
const T_OVERHANG = 0.1;
const T_ANCHOR = 0.1;
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


const TAU = 2 * Math.PI;

// Angle ramené dans [lo, lo + 2π).
const wrap = (a: number, lo: number) => a - TAU * Math.floor((a - lo) / TAU);

// Ensemble de cases (colonne, rangée) de la grille, pour au plus n cases :
// table de hachage ouverte (un Set de clés numériques coûte cher au
// ramasse-miettes sur 250 000 points). Renvoie vrai si la case est nouvelle.
// Clé sans collision sous ±2·10⁹ cases.
const cellSet = (n: number) => {
    let capacity = 1024;
    while (capacity < 2 * n) capacity *= 2;
    const mask = capacity - 1;
    const keys = new Float64Array(capacity).fill(NaN);
    return (ix: number, iy: number) => {
        const key = ix * 4294967296 + iy;
        let h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663)) & mask;
        while (!Number.isNaN(keys[h])) {
            if (keys[h] === key) return false;
            h = (h + 1) & mask;
        }
        keys[h] = key;
        return true;
    };
};

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
 * Sommets d'un arc (x, y alternés), à `sagitta` près : pour un format ou une
 * déformation (profil exagéré) qui n'a pas d'arc.
 *
 * @param {SectionArc} a - Arc.
 * @param {number} sagitta - Écart maximal entre l'arc et ses cordes.
 * @returns {number[]} Sommets, du début à la fin de l'arc.
 */
export const arcPoints = (a: SectionArc, sagitta: number): number[] => {
    const step = 2 * Math.acos(Math.max(-1, 1 - sagitta / a.r));
    const n = Math.max(4, Math.ceil((a.a1 - a.a0) / step));
    const p: number[] = [];
    for (let k = 0; k <= n; k++) {
        const ang = a.a0 + (a.a1 - a.a0) * k / n;
        p.push(a.cx + a.r * Math.cos(ang), a.cy + a.r * Math.sin(ang));
    }
    return p;
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
    const empty: SectionLines = { lines: [], arcs: [], details: [], walls: 0, curves: 0, tolerance: 0 };
    if (total < 10) return empty;

    // Tranche très fournie : un point par case de 1 cm, puis un point sur n
    // au-delà de 100 000.
    let pts = points, count = total;
    if (total > FIT_POINTS) {
        const seen = cellSet(Math.min(total, MAX_POINTS));
        const kept: number[] = [];
        const stride = Math.max(1, total / MAX_POINTS);
        for (let k = 0; k < Math.min(total, MAX_POINTS); k++) {
            const i = Math.floor(k * stride);
            if (seen(Math.floor(points[i * 2] / THIN_CELL), Math.floor(points[i * 2 + 1] / THIN_CELL))) kept.push(i);
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
    let arcs: (SectionArc & { ids: number[]; tol: number })[] = [];
    {
        const pool = new Uint8Array(count).fill(1);
        for (const s of segments) if (s.square || length(s) >= ARC_POOL_LONG) for (const i of s.ids) pool[i] = 0;
        const radii: number[] = [];
        for (let r = ARC_R_MIN; r <= ARC_R_MAX; r *= ARC_R_STEP) radii.push(r);
        const cellOfRadius = radii.map(r => Math.max(ARC_CELL_MIN, ARC_CELL * r));

        // Un votant par case de 4 cm : chaque longueur de trait pèse autant,
        // qu'il soit dense (près du scanner) ou clairsemé (vitrage).
        const voters: number[] = [];
        const voterCells = cellSet(count);
        for (let i = 0; i < count; i++) {
            if (pool[i] && !Number.isNaN(theta[i]) && voterCells(Math.floor(pts[i * 2] / ARC_VOTER_CELL), Math.floor(pts[i * 2 + 1] / ARC_VOTER_CELL))) voters.push(i);
        }
        const stride = Math.max(1, voters.length / ARC_VOTERS);
        // Votes, rangés dans une table de hachage ouverte : clé (rayon,
        // colonne, rangée), sans collision sous ±10 km.
        const voteCount = Math.ceil(voters.length / stride) * radii.length * 2;
        let capacity = 1024;
        while (capacity < 1.5 * voteCount) capacity *= 2;
        const mask = capacity - 1, OFFSET = 2 ** 20, SPAN = 2 ** 21;
        const keys = new Float64Array(capacity).fill(-1);
        const tally = new Int32Array(capacity);
        const slot = (b: number, ix: number, iy: number, insert: boolean) => {
            const key = (b * SPAN + ix) * SPAN + iy;
            let h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(b, 83492791)) & mask;
            while (keys[h] !== -1 && keys[h] !== key) h = (h + 1) & mask;
            if (keys[h] === -1) {
                if (!insert) return -1;
                keys[h] = key;
            }
            return h;
        };
        // Chaque votant, pour chaque rayon, des deux côtés : f(case, votant).
        const vote = (f: (h: number, i: number) => void, insert: boolean) => {
            for (let k = 0; k < voters.length; k += stride) {
                const i = voters[Math.floor(k)];
                const x = pts[i * 2], y = pts[i * 2 + 1], nx = -Math.sin(theta[i]), ny = Math.cos(theta[i]);
                for (let b = 0; b < radii.length; b++) {
                    const r = radii[b], c = cellOfRadius[b];
                    for (let side = -1; side <= 1; side += 2) {
                        const h = slot(b, Math.floor((x + side * r * nx) / c) + OFFSET, Math.floor((y + side * r * ny) / c) + OFFSET, insert);
                        if (h >= 0) f(h, i);
                    }
                }
            }
        };
        vote((h) => {
            tally[h]++;
        }, true);
        // Cases candidates : maximum local, votes des 3 × 3 cases voisines
        // réunis (centre pondéré).
        const need = Math.max(3, ARC_VOTES / stride);
        type Candidate = { cx: number; cy: number; r: number; band: number; votes: number; voters: number[]; rank: number };
        const candidates: Candidate[] = [];
        const owner = new Int32Array(capacity).fill(-1);
        const decode = (key: number) => {
            const iy = key % SPAN, rest = (key - iy) / SPAN, ix = rest % SPAN;
            return [(rest - ix) / SPAN, ix, iy];
        };
        // Votes des 3 × 3 cases autour de (x, y), pour le rayon b.
        const around = (b: number, x: number, y: number) => {
            if (b < 0 || b >= radii.length) return 0;
            const c = cellOfRadius[b], ix = Math.floor(x / c) + OFFSET, iy = Math.floor(y / c) + OFFSET;
            let n = 0;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const g = slot(b, ix + dx, iy + dy, false);
                    if (g >= 0) n += tally[g];
                }
            }
            return n;
        };
        const peaks: { b: number; ix: number; iy: number; cx: number; cy: number; score: number }[] = [];
        for (let h = 0; h < capacity; h++) {
            const v = tally[h];
            if (v < need / 4) continue;
            const [b, ix, iy] = decode(keys[h]);
            let score = 0, wx = 0, wy = 0, peak = true;
            for (let dy = -1; dy <= 1 && peak; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const g = slot(b, ix + dx, iy + dy, false);
                    const w = g < 0 ? 0 : tally[g];
                    if (w > v || (w === v && g > h)) {
                        peak = false;
                        break;
                    }
                    score += w;
                    wx += w * dx;
                    wy += w * dy;
                }
            }
            if (!peak || score < need) continue;
            const c = cellOfRadius[b];
            peaks.push({ b, ix, iy, cx: (ix - OFFSET + 0.5 + wx / score) * c, cy: (iy - OFFSET + 0.5 + wy / score) * c, score });
        }
        // Maximum aussi d'un rayon au suivant (même centre).
        for (const p of peaks) {
            if (p.score < around(p.b - 1, p.cx, p.cy) || p.score < around(p.b + 1, p.cx, p.cy)) continue;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const g = slot(p.b, p.ix + dx, p.iy + dy, false);
                    if (g >= 0 && owner[g] < 0) owner[g] = candidates.length;
                }
            }
            const c = cellOfRadius[p.b];
            candidates.push({ cx: p.cx, cy: p.cy, r: radii[p.b], band: Math.max(FACE_REACH, c), votes: p.score, voters: [], rank: 0 });
        }
        // Votants des candidats : la partie du cercle où ils sont, et ce
        // qu'ils en couvrent.
        vote((h, i) => {
            if (owner[h] >= 0) candidates[owner[h]].voters.push(i);
        }, false);
        // Écart entre l'orientation du point i et la tangente au cercle.
        const tangentGap = (i: number, cx: number, cy: number) => angleDiff(theta[i], Math.atan2(pts[i * 2 + 1] - cy, pts[i * 2] - cx) + Math.PI / 2);
        const windows = new Map<Candidate, [number, number]>();
        for (const cand of candidates) {
            if (cand.voters.length < 2) continue;
            const angles = cand.voters.map(i => wrap(Math.atan2(pts[i * 2 + 1] - cand.cy, pts[i * 2] - cand.cx), 0)).sort((p, q) => p - q);
            // Le complément du plus grand trou entre les angles des votants.
            let gap = angles[0] + TAU - angles[angles.length - 1], lo = angles[0], hi = angles[angles.length - 1];
            for (let k = 1; k < angles.length; k++) {
                if (angles[k] - angles[k - 1] > gap) {
                    gap = angles[k] - angles[k - 1];
                    lo = angles[k];
                    hi = angles[k - 1] + TAU;
                }
            }
            if ((TAU - gap) < ARC_VOTE_SPAN * ARC_MIN_SPAN * DEG || (TAU - gap) * cand.r < ARC_VOTE_SPAN * ARC_MIN_LENGTH) continue;
            // Longueur couverte par les votants (tranches de 10 cm), et sa
            // part dans leur fenêtre.
            const covered = new Set(angles.map(a => Math.floor(wrap(a, lo) * cand.r / ARC_STEP))).size * ARC_STEP;
            const fill = covered / ((hi - lo) * cand.r + ARC_STEP);
            if (fill < ARC_VOTE_FILL) continue;
            // Orientations des votants : mieux expliquées par la tangente
            // que par leur moyenne (pas un mur droit).
            let sc = 0, ss = 0;
            for (const i of cand.voters) {
                sc += Math.cos(2 * theta[i]);
                ss += Math.sin(2 * theta[i]);
            }
            const mean = Math.atan2(ss, sc) / 2;
            let arcTurn = 0, lineTurn = 0;
            for (const i of cand.voters) {
                arcTurn += tangentGap(i, cand.cx, cand.cy);
                lineTurn += angleDiff(theta[i], mean);
            }
            if (arcTurn > ARC_BETTER * lineTurn) continue;
            const grow = ARC_GAP / cand.r;
            cand.rank = new Set(angles.map(a => Math.floor(a / (ARC_VOTE_BIN * DEG)))).size * fill;
            windows.set(cand, gap * cand.r <= 2 * ARC_GAP ? [0, TAU] : [lo - grow, hi + grow]);
        }
        const kept = candidates.filter(c => windows.has(c)).sort((p, q) => q.rank - p.rank).slice(0, ARC_CANDIDATES);

        const taken = new Uint8Array(count);
        const seen = new Int32Array(count);
        let seenGeneration = 0;
        // Points (du réservoir et libres, ou tous) à moins de `band` du
        // cercle, entre les angles lo et hi : cordes du cercle parcourues par
        // visit.
        const ring = (c: { cx: number; cy: number; r: number }, band: number, lo: number, hi: number, all: boolean, f: (i: number) => void) => {
            const { cx, cy, r } = c;
            const full = hi - lo >= TAU;
            const stamp = ++seenGeneration;
            const open = full ? TAU : hi - lo, from = full ? 0 : lo;
            const n = Math.max(2, Math.ceil(open * r / R));
            for (let k = 0; k < n; k++) {
                const t0 = from + open * k / n, t1 = from + open * (k + 1) / n;
                visit([cx + r * Math.cos(t0), cy + r * Math.sin(t0)], [cx + r * Math.cos(t1), cy + r * Math.sin(t1)], band + R / 4, (i) => {
                    if (seen[i] === stamp || (!all && (!pool[i] || taken[i]))) return;
                    seen[i] = stamp;
                    const x = pts[i * 2] - cx, y = pts[i * 2 + 1] - cy;
                    if (Math.abs(Math.hypot(x, y) - r) >= band) return;
                    if (full || wrap(Math.atan2(y, x), lo) <= hi) f(i);
                });
            }
        };
        const tangent = (i: number, cx: number, cy: number) => Number.isNaN(theta[i]) || tangentGap(i, cx, cy) < ARC_TANGENT * DEG;
        const distance = (i: number, c: { cx: number; cy: number; r: number }) => Math.abs(Math.hypot(pts[i * 2] - c.cx, pts[i * 2 + 1] - c.cy) - c.r);
        // Cercle géométrique (Gauss-Newton sur les distances), depuis c.
        // Chaque tranche de 10 cm de l'arc pèse autant : un paquet de points
        // serrés (scanner tout proche) ne tire pas le cercle à lui.
        const refine = (ids: number[], c: { cx: number; cy: number; r: number }) => {
            let { cx, cy, r } = c;
            const bins = new Map<number, number>();
            const binOf = ids.map(i => Math.floor(wrap(Math.atan2(pts[i * 2 + 1] - c.cy, pts[i * 2] - c.cx), 0) * c.r / ARC_STEP));
            for (const b of binOf) bins.set(b, (bins.get(b) ?? 0) + 1);
            const weight = binOf.map(b => 1 / bins.get(b));
            for (let it = 0; it < 6; it++) {
                const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
                for (let k = 0; k < ids.length; k++) {
                    const i = ids[k];
                    const dx = pts[i * 2] - cx, dy = pts[i * 2 + 1] - cy, d = Math.hypot(dx, dy);
                    if (d < 1e-9) continue;
                    const J = [-dx / d, -dy / d, -1], e = d - r, w = weight[k];
                    for (let a = 0; a < 3; a++) {
                        v[a] -= w * J[a] * e;
                        for (let b = 0; b < 3; b++) M[a][b] += w * J[a] * J[b];
                    }
                }
                const step = solve3(M, v);
                if (!step) return null;
                cx += step[0];
                cy += step[1];
                r += step[2];
                if (Math.hypot(step[0], step[1], step[2]) < 1e-5) break;
            }
            return r > 0 ? { cx, cy, r } : null;
        };
        // Tronçons d'un cercle : points triés par angle, coupés aux trous de
        // plus de ARC_GAP ; le premier et le dernier se rejoignent s'il n'y a
        // pas de trou en passant par 0. Ouverture de a0 à a1 (2π : tour
        // complet).
        const runsOf = (ids: number[], c: { cx: number; cy: number; r: number }) => {
            const ang = new Float64Array(ids.length);
            ids.forEach((i, k) => {
                ang[k] = wrap(Math.atan2(pts[i * 2 + 1] - c.cy, pts[i * 2] - c.cx), 0);
            });
            const order = Array.from(ids.keys()).sort((p, q) => ang[p] - ang[q]);
            const runs: { ids: number[]; a0: number; a1: number }[] = [];
            let cur: number[] = [], first = 0, last = 0;
            for (const k of order) {
                if (cur.length && (ang[k] - last) * c.r > ARC_GAP) {
                    runs.push({ ids: cur, a0: first, a1: last });
                    cur = [];
                }
                if (!cur.length) first = ang[k];
                cur.push(ids[k]);
                last = ang[k];
            }
            if (cur.length) runs.push({ ids: cur, a0: first, a1: last });
            if (!runs.length) return runs;
            const wrapGap = (runs[0].a0 + TAU - runs[runs.length - 1].a1) * c.r;
            if (runs.length === 1 && wrapGap <= ARC_GAP) {
                runs[0].a0 = 0;
                runs[0].a1 = TAU;
            } else if (runs.length > 1 && wrapGap <= ARC_GAP) {
                const tail = runs.pop();
                runs[0] = { ids: tail.ids.concat(runs[0].ids), a0: tail.a0, a1: runs[0].a1 + TAU };
            }
            return runs;
        };

        // Tronçon d'un cercle déjà ajusté, contrôlé.
        const accept = (c: { cx: number; cy: number; r: number }, tol: number, run: { ids: number[]; a0: number; a1: number }) => {
            const { cx, cy, r } = c, { ids, a0, a1 } = run;
            const open = a1 - a0, len = open * r;
            if (len < ARC_MIN_LENGTH || open < ARC_MIN_SPAN * DEG || ids.length < MIN_POINTS || ids.length < len / STEP) return false;
            if (r * (1 - Math.cos(Math.min(open, Math.PI) / 2)) < CURVE_SAGITTA) return false;
            // Occupation : une tranche compte si elle a 2 points, et 15 % du
            // nombre moyen par tranche (un paquet serré relié par quelques
            // points épars n'est pas un arc).
            const bins = Math.ceil(len / ARC_STEP - 1e-9);
            const perBin = new Map<number, number>();
            for (const i of ids) {
                const k = Math.floor((wrap(Math.atan2(pts[i * 2 + 1] - cy, pts[i * 2] - cx), a0) - a0) * r / ARC_STEP);
                perBin.set(k, (perBin.get(k) ?? 0) + 1);
            }
            const least = Math.max(2, ARC_EVEN * ids.length / bins);
            let occupied = 0;
            for (const n of perBin.values()) if (n >= least) occupied++;
            if (occupied < COVERAGE * bins) return false;
            // Orientations : tous les points orientés de la bande, pas
            // seulement ceux qui suivent la tangente ; et mieux qu'une droite,
            // en orientation comme en distance (droite des moindres carrés
            // totaux sur les points de l'arc).
            let mx = 0, my = 0;
            for (const i of ids) {
                mx += pts[i * 2];
                my += pts[i * 2 + 1];
            }
            mx /= ids.length;
            my /= ids.length;
            let sxx = 0, sxy = 0, syy = 0;
            for (const i of ids) {
                const dx = pts[i * 2] - mx, dy = pts[i * 2 + 1] - my;
                sxx += dx * dx;
                sxy += dx * dy;
                syy += dy * dy;
            }
            const lineTh = 0.5 * Math.atan2(2 * sxy, sxx - syy);
            const lx = Math.cos(lineTh), ly = Math.sin(lineTh);
            let oriented = 0, agree = 0, arcTurn = 0, lineTurn = 0, arcDist = 0, lineDist = 0;
            ring(c, tol, a0, a1, false, (i) => {
                const x = pts[i * 2], y = pts[i * 2 + 1];
                arcDist += (Math.hypot(x - cx, y - cy) - r) ** 2;
                lineDist += (-(x - mx) * ly + (y - my) * lx) ** 2;
                if (Number.isNaN(theta[i])) return;
                oriented++;
                const g = tangentGap(i, cx, cy);
                if (g < ARC_TANGENT * DEG) agree++;
                arcTurn += g;
                lineTurn += angleDiff(theta[i], lineTh);
            });
            if (agree < ARC_AGREE * oriented || arcTurn > ARC_BETTER * lineTurn || arcDist > ARC_CLOSER * ARC_CLOSER * lineDist) return false;
            // Nuage clairsemé : un cercle passe toujours par quelques points
            // épars, mais peu sont orientés, ou la bande est large pour le
            // rayon.
            let rms = 0;
            for (const i of ids) rms += (Math.hypot(pts[i * 2] - cx, pts[i * 2 + 1] - cy) - r) ** 2;
            rms = Math.sqrt(rms / ids.length);
            if (agree < ARC_ORIENTED * ids.length || rms > Math.max(ARC_THIN_MIN, ARC_THIN * r)) return false;
            // Coin : sur tous les points à ±8 cm de l'arc (les points
            // retenus par le cercle sont choisis courbes), deux droites
            // coupées au meilleur endroit (de 20 à 80 % des points pris dans
            // l'ordre de l'arc) font aussi bien que le cercle. Sommes
            // cumulées : écart quadratique d'une droite des moindres carrés
            // totaux = plus petite valeur propre de la dispersion.
            if (open < Math.PI * 1.5) {
                const band: number[] = [];
                ring(c, FACE_REACH, a0, a1, true, i => band.push(i));
                const angle = new Map(band.map(i => [i, wrap(Math.atan2(pts[i * 2 + 1] - cy, pts[i * 2] - cx), a0)]));
                band.sort((p, q) => angle.get(p) - angle.get(q));
                const n = band.length;
                const acc = new Float64Array((n + 1) * 5);
                let circle = 0;
                band.forEach((i, k) => {
                    const x = pts[i * 2] - cx, y = pts[i * 2 + 1] - cy;
                    circle += (Math.hypot(x, y) - r) ** 2;
                    const o = k * 5, q = o + 5;
                    acc[q] = acc[o] + x;
                    acc[q + 1] = acc[o + 1] + y;
                    acc[q + 2] = acc[o + 2] + x * x;
                    acc[q + 3] = acc[o + 3] + x * y;
                    acc[q + 4] = acc[o + 4] + y * y;
                });
                const sse = (from: number, to: number) => {
                    const m = to - from, A = to * 5, B = from * 5;
                    const sx = acc[A] - acc[B], sy = acc[A + 1] - acc[B + 1];
                    const a = acc[A + 2] - acc[B + 2] - sx * sx / m, b = acc[A + 3] - acc[B + 3] - sx * sy / m, d = acc[A + 4] - acc[B + 4] - sy * sy / m;
                    return (a + d) / 2 - Math.sqrt(Math.max(0, (a - d) * (a - d) / 4 + b * b));
                };
                let best = Infinity;
                for (let f = 0.2; f <= 0.8 + 1e-9; f += 0.05) {
                    const k = Math.round(n * f);
                    if (k >= 3 && n - k >= 3) best = Math.min(best, sse(0, k) + sse(k, n));
                }
                if (best <= ARC_CORNER * circle) return false;
            }
            // Côtés : tous les points (y compris ceux des droites), dans deux
            // anneaux de part et d'autre de l'arc.
            const lo = tol + FLANK_GAP, hi = lo + FLANK_WIDTH, mid = (lo + hi) / 2;
            let inner = 0, outer = 0;
            ring({ cx, cy, r: r + mid }, FLANK_WIDTH / 2, a0, a1, true, () => outer++);
            if (r > lo) ring({ cx, cy, r: r - mid }, FLANK_WIDTH / 2, a0, a1, true, () => inner++);
            const density = ids.length / (2 * tol * len);
            const outerArea = open / 2 * ((r + hi) ** 2 - (r + lo) ** 2);
            const innerArea = open / 2 * (Math.max(0, r - lo) ** 2 - Math.max(0, r - hi) ** 2);
            const di = innerArea > 1e-6 ? inner / innerArea : 0, dout = outer / outerArea;
            return Math.min(di, dout) <= FLANK_RATIO * density && Math.max(di, dout) <= FLANK_DENSER * density;
        };

        // Cercles déjà essayés (départ et arrivée) : plusieurs candidats
        // voisins mènent au même cercle.
        const tried: { cx: number; cy: number; r: number }[] = [];
        for (const cand of kept) {
            if (tried.some(t => Math.hypot(t.cx - cand.cx, t.cy - cand.cy) < cand.band && Math.abs(t.r - cand.r) < cand.band)) continue;
            tried.push(cand);
            // Cercle ajusté sur les points qui suivent la tangente : d'abord
            // le plus fourni des tronçons de la partie du cercle des votants,
            // puis de proche en proche (la fenêtre s'étend de 1 m de chaque
            // côté et garde les tronçons qui touchent les précédents).
            // Tolérance tirée des écarts, comme pour une face.
            let [lo, hi] = windows.get(cand);
            let c: { cx: number; cy: number; r: number } = cand, band = cand.band, tol = FACE_TOL_MAX;
            let ids: number[] = [], span = 0;
            for (let it = 0; it < ARC_ITERATIONS && c; it++) {
                const cc = c, grow = it ? ARC_GROW / cc.r : 0;
                const from = hi - lo + 2 * grow >= TAU ? 0 : lo - grow, to = hi - lo + 2 * grow >= TAU ? TAU : hi + grow;
                const near: number[] = [];
                ring(cc, band, from, to, false, (i) => {
                    if (tangent(i, cc.cx, cc.cy)) near.push(i);
                });
                if (near.length < MIN_POINTS) {
                    c = null;
                    break;
                }
                const dev = near.map(i => distance(i, cc)).sort((p, q) => p - q);
                const tolerance = Math.min(FACE_TOL_MAX, Math.max(FACE_TOL_MIN, FACE_TOL_MAD * dev[dev.length >> 1]));
                tol = tolerance;
                let runs = runsOf(near.filter(i => distance(i, cc) < tolerance), cc);
                if (it === 0) {
                    runs = runs.length ? [runs.reduce((p, q) => (q.ids.length > p.ids.length ? q : p))] : [];
                    // Graine trop courte pour faire un arc, même prolongée.
                    if (runs.length && (runs[0].a1 - runs[0].a0) * cc.r < ARC_VOTE_SPAN * ARC_MIN_LENGTH) runs = [];
                } else {
                    const [wLo, wHi] = [lo, hi];
                    runs = runs.filter(run => run.a1 - run.a0 >= TAU || wrap(run.a0, wLo) <= wHi || wrap(wLo, run.a0) <= run.a1);
                }
                if (!runs.length) {
                    c = null;
                    break;
                }
                ids = runs.flatMap(run => run.ids);
                if (runs.some(run => run.a1 - run.a0 >= TAU)) {
                    lo = 0;
                    hi = TAU;
                } else {
                    // Étendue des tronçons gardés, depuis le premier.
                    const first = runs.reduce((p, q) => (wrap(q.a0, from) < wrap(p.a0, from) ? q : p));
                    lo = first.a0;
                    hi = lo;
                    for (const run of runs) hi = Math.max(hi, wrap(run.a0, lo) + run.a1 - run.a0);
                }
                c = ids.length >= MIN_POINTS ? refine(ids, cc) : null;
                band = FACE_REACH;
                if (c && (c.r < ARC_R_MIN || c.r > ARC_R_MAX)) c = null;
                // Stable (5 mm) et la fenêtre ne grandit plus : fini.
                if (c && it > 0 && Math.hypot(c.cx - cc.cx, c.cy - cc.cy, c.r - cc.r) < ARC_STABLE && (hi - lo) * c.r <= span + ARC_GAP) break;
                span = (hi - lo) * cc.r;
            }
            if (!c) continue;
            const fit = c;
            if (tried.some(t => t !== cand && Math.hypot(t.cx - fit.cx, t.cy - fit.cy) < cand.band / 2 && Math.abs(t.r - fit.r) < cand.band / 2)) continue;
            tried.push(fit);
            ids = [];
            const margin = ARC_GAP / fit.r;
            ring(fit, tol, hi - lo + 2 * margin >= TAU ? 0 : lo - margin, hi - lo + 2 * margin >= TAU ? TAU : hi + margin, false, (i) => {
                if (tangent(i, fit.cx, fit.cy)) ids.push(i);
            });
            for (const run of runsOf(ids, fit)) {
                if (!accept(fit, tol, run)) continue;
                arcs.push({ ...fit, a0: run.a0, a1: run.a1, ids: run.ids, tol });
                for (const i of run.ids) taken[i] = 1;
            }
        }

        // Droites remplacées : cordes d'un arc, ou dont la moitié des points
        // sont pris.
        const onArc = (p: Vec) => arcs.some(a => Math.abs(Math.hypot(p[0] - a.cx, p[1] - a.cy) - a.r) < a.tol + ARC_CHORD_BAND &&
            wrap(Math.atan2(p[1] - a.cy, p[0] - a.cx), a.a0 - ARC_GAP / a.r) <= a.a1 + ARC_GAP / a.r);
        segments = segments.filter((s) => {
            let n = 0;
            for (const i of s.ids) n += taken[i];
            if (n >= 0.5 * s.ids.length) return false;
            return !(onArc(s.a) && onArc(s.b) && onArc([(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]));
        });
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

    // Paramètres t (sur p q) des points où la droite p q coupe l'arc a, à
    // plus de `margin` de ses bouts.
    const arcHits = (p: Vec, q: Vec, a: SectionArc, margin: number) => {
        const dx = q[0] - p[0], dy = q[1] - p[1], fx = p[0] - a.cx, fy = p[1] - a.cy;
        const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - a.r * a.r;
        const disc = B * B - 4 * A * C;
        if (A < 1e-12 || disc <= 0) return [];
        const hits: number[] = [];
        const m = margin / a.r, full = a.a1 - a.a0 >= TAU - 1e-9;
        for (const t of [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)]) {
            const ang = wrap(Math.atan2(p[1] + t * dy - a.cy, p[0] + t * dx - a.cx), a.a0);
            if (full || (ang > a.a0 + m && ang < a.a1 - m)) hits.push(t);
        }
        return hits;
    };
    const arcLength = (a: SectionArc) => a.r * (a.a1 - a.a0);
    const arcEnd = (a: SectionArc, end: 0 | 1): Vec => {
        const ang = end ? a.a1 : a.a0;
        return [a.cx + a.r * Math.cos(ang), a.cy + a.r * Math.sin(ang)];
    };

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
        if (arcs.some(a => arcHits(p, q, a, CROSS_MARGIN).some(t => t > CROSS_MARGIN / len && t <= 1))) return true;
        for (const o of segments) {
            if (skip.includes(o)) continue;
            const x = intersect(p, q, o.a, o.b);
            if (!x) continue;
            const lo = length(o);
            if (x[0] > CROSS_MARGIN / len && x[0] <= 1 && x[1] > CROSS_MARGIN / lo && x[1] < 1 - CROSS_MARGIN / lo) return true;
        }
        return false;
    };
    // Le point p est-il à moins de `band` du trait o ?
    const near = (p: Vec, o: Segment, band: number) => {
        const lo = length(o), ux = (o.b[0] - o.a[0]) / lo, uy = (o.b[1] - o.a[1]) / lo;
        const x = p[0] - o.a[0], y = p[1] - o.a[1], u = Math.max(0, Math.min(lo, x * ux + y * uy));
        return Math.hypot(x - u * ux, y - u * uy) < band;
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
                // Le bout le plus proche de x seulement, à moins de 45 cm, et
                // le trait raccourci de moitié au plus.
                if (ds >= CORNER || (se === 'a') !== (t[0] < 0.5)) continue;
                if (Math.hypot(x[0] - s[other(se)][0], x[1] - s[other(se)][1]) < 0.5 * ls) continue;
                const qe: End = t[1] < 0.5 ? 'a' : 'b';
                const dq = Math.hypot(x[0] - q[qe][0], x[1] - q[qe][1]);
                // q dépasse nettement le croisement et s'appuie au-delà sur un
                // autre trait (l'autre face du mur) : en T, q ne bouge pas.
                const inside = t[1] > 0 && t[1] < 1;
                if (inside && dq > T_OVERHANG && segments.some(o => o !== s && o !== q && near(q[qe], o, T_ANCHOR))) {
                    candidates.push({ s, se, q, qe: null, x, d: ds });
                } else if (dq < CORNER && Math.hypot(x[0] - q[other(qe)][0], x[1] - q[other(qe)][1]) >= 0.5 * lq) {
                    if (segments.indexOf(s) < segments.indexOf(q)) candidates.push({ s, se, q, qe, x, d: ds + dq });
                    // Si l'un des deux bouts sert déjà ailleurs : en T.
                    if (inside) candidates.push({ s, se, q, qe: null, x, d: ds + CORNER });
                } else if (inside) {
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
    // l'autre de moins de 45 cm est raccourci au croisement ; sinon le plus
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
    // Arcs et droites ne se traversent pas non plus : une droite qui dépasse
    // un arc de moins de 45 cm (et de moins de sa moitié) est raccourcie au
    // croisement ; sinon le plus court des deux est écarté. Deux arcs qui se
    // coupent : le plus court est écarté.
    for (const a of arcs) {
        for (const s of segments.slice()) {
            if (!arcs.includes(a)) break;
            const ls = length(s);
            const hits = arcHits(s.a, s.b, a, CROSS_MARGIN).filter(t => t > CROSS_MARGIN / ls && t < 1 - CROSS_MARGIN / ls);
            if (!hits.length) continue;
            // Deux croisements : la droite traverse l'arc de part en part.
            const t = hits[0];
            const x: Vec = [s.a[0] + t * (s.b[0] - s.a[0]), s.a[1] + t * (s.b[1] - s.a[1])];
            if (hits.length === 1 && t * ls < CORNER && t < 0.5) s.a = x;
            else if (hits.length === 1 && (1 - t) * ls < CORNER && t > 0.5) s.b = x;
            else if (ls < arcLength(a)) segments.splice(segments.indexOf(s), 1);
            else arcs = arcs.filter(o => o !== a);
        }
    }
    for (const a of arcs.slice()) {
        for (const b of arcs.slice()) {
            if (a === b || !arcs.includes(a) || !arcs.includes(b)) continue;
            const d = Math.hypot(b.cx - a.cx, b.cy - a.cy);
            if (d < 1e-9 || d > a.r + b.r || d < Math.abs(a.r - b.r)) continue;
            const along = (a.r * a.r - b.r * b.r + d * d) / (2 * d), h = Math.sqrt(Math.max(0, a.r * a.r - along * along));
            const mx = a.cx + along * (b.cx - a.cx) / d, my = a.cy + along * (b.cy - a.cy) / d;
            const hit = [-1, 1].some((k) => {
                const px = mx - k * h * (b.cy - a.cy) / d, py = my + k * h * (b.cx - a.cx) / d;
                const on = (o: SectionArc) => {
                    const m = CROSS_MARGIN / o.r, ang = wrap(Math.atan2(py - o.cy, px - o.cx), o.a0);
                    return o.a1 - o.a0 >= TAU - 1e-9 || (ang > o.a0 + m && ang < o.a1 - m);
                };
                return on(a) && on(b);
            });
            if (hit) arcs = arcs.filter(o => o !== (arcLength(a) < arcLength(b) ? a : b));
        }
    }
    // Bouts d'un arc : le bout de droite le plus proche (à moins de 45 cm)
    // est prolongé ou raccourci, sur sa ligne, jusqu'au cercle, et l'arc
    // jusqu'au même point (de 45 cm au plus, sans perdre la moitié de sa
    // longueur). Raccord sur des points, sans couper d'autre trait.
    {
        const used = new Set<Segment>();
        for (const a of arcs) {
            if (a.a1 - a.a0 >= TAU - 1e-9) continue;
            for (const end of [0, 1] as const) {
                const e = arcEnd(a, end);
                let best: { s: Segment; se: End; x: Vec; ang: number } | null = null, bestD = CORNER;
                for (const s of segments) {
                    if (used.has(s)) continue;
                    for (const se of ['a', 'b'] as End[]) {
                        const p = s[se], o = s[other(se)];
                        if (Math.hypot(p[0] - e[0], p[1] - e[1]) >= CORNER) continue;
                        // Croisements de la ligne du trait avec le cercle
                        // (paramètre sur o → p), le plus proche du bout.
                        const dx = p[0] - o[0], dy = p[1] - o[1], fx = o[0] - a.cx, fy = o[1] - a.cy;
                        const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - a.r * a.r;
                        const disc = B * B - 4 * A * C;
                        if (disc < 0) continue;
                        for (const t of [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)]) {
                            if (t < 0.5) continue;
                            const x: Vec = [o[0] + t * dx, o[1] + t * dy];
                            const d = Math.hypot(x[0] - p[0], x[1] - p[1]) + Math.hypot(x[0] - e[0], x[1] - e[1]);
                            if (d >= bestD || Math.hypot(x[0] - e[0], x[1] - e[1]) >= CORNER) continue;
                            // Nouvel angle du bout de l'arc, au plus près de l'ancien.
                            const old = end ? a.a1 : a.a0;
                            let ang = Math.atan2(x[1] - a.cy, x[0] - a.cx);
                            ang -= TAU * Math.round((ang - old) / TAU);
                            const open = end ? ang - a.a0 : a.a1 - ang;
                            if (open < 0.5 * (a.a1 - a.a0) || open >= TAU) continue;
                            best = { s, se, x, ang };
                            bestD = d;
                        }
                    }
                }
                if (!best) continue;
                const { s, se, x, ang } = best;
                const p = s[se], o = s[other(se)];
                const grows = Math.hypot(x[0] - o[0], x[1] - o[1]) > Math.hypot(p[0] - o[0], p[1] - o[1]);
                if (grows && (!supported(p, x) || crosses(p, x, [s]))) continue;
                // L'arc prolongé passe aussi sur des points.
                if (!supported(e, x)) continue;
                s[se] = x;
                if (end) a.a1 = ang;
                else a.a0 = ang;
                used.add(s);
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
    // Bruit d'un arc, le long de sa polyligne.
    const curves = arcs.map(a => arcPoints(a, ARC_SAGITTA));
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
    return {
        lines,
        arcs: arcs.map(({ cx, cy, r, a0, a1 }) => ({ cx, cy, r, a0, a1 })),
        details: trace.lines,
        walls: segments.length,
        curves: arcs.length,
        tolerance: trace.tolerance
    };
};
