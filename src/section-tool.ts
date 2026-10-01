import { Mat4, Vec3 } from 'playcanvas';

import { formatCoordsInline } from './coordinates';
import { getLocale } from './localization';
import { sectionDxf } from './section-dxf';
import type { DrawingDimension, DrawingKind, DrawingRule, SectionDrawing } from './section-dxf';
import { DARK_THEME, LIGHT_THEME, ProfileView, paintProfile, profileToScreen, scaleBarLength } from './section-profile';
import type { ProfileData, ProfileMeasure, ProfilePoint, ProfileRule, ProfileWindow } from './section-profile';
import { computeRule, spanFrame, spanIsUpright } from './section-rule';
import type { RuleOk, RuleResult } from './section-rule';
import { traceSection } from './section-trace';
import { SplatSectionHighlight } from './splat-highlight';
import {
    translator, formatNumber, formatCount, formatLength, readStoredNumber, storeNumber, readStoredText, storeText,
    sceneName, exportBaseName, exportNumber, decimalSeparator, downloadBlob, downloadCsv, createRow, createNote,
    createField, createSegmented, createStepper, createSwitch, createCollapseButton
} from './tool-panel';
import { ToolPointerHandler } from './tool-pointer-handler';
import {
    worldToScreen, screenToRay, getSplatCenters, displayedLodInBox, loadFinestCenters, orientedBoxAabb, median, subsample,
    fitPlaneLS, verticalAxis, ACCENT_COLOR, accentRgba, RULE_LENGTHS, RULE_MIN_SAMPLES, WAVE_WIDTHS
} from './tool-utils';
import type { FinestResult, LodUsage, OrientedBox, SplatCenters } from './tool-utils';
import type { Global } from './types';

// ARTLIGHT (TKT-238) : outil « Coupe ».
//
// Un clic pose la coupe :
// - verticale : plan vertical par le point cliqué, face à la vue, ou
//   perpendiculaire au mur si l'on clique un mur ;
// - horizontale : plan à la hauteur du point cliqué, ou 1 m au-dessus du sol
//   si l'on clique le sol (hauteur d'un plan d'architecte).
// Un autre clic la déplace ; des poignées dans la vue la décalent et la font
// tourner ; le panneau règle orientation, position et épaisseur. Le mode
// « Entre deux points » garde la coupe par A et B, pour un profil entre deux
// points précis (route, pente d'un toit).
//
// Seuls les splats d'une tranche fine autour du plan sont gardés. La vue 3D
// masque ce qui est devant la coupe (au-dessus pour une horizontale) et
// teinte la tranche ; le panneau, en bas de l'écran, montre le profil (vue
// en plan pour une horizontale) où l'on mesure.
//
// Première version (lot 1) : A et B seulement. Maxime a trouvé la pose de
// deux points trop peu intuitive ; le mode reste en option.
//
// Règle et flèche (TKT-246) : sur un profil (coupe verticale ou entre deux
// points), une règle posée sur les points hauts, de A à B ou entre deux
// clics sur le profil ; flèche maximale entre deux appuis, portée, L/xxx.
// Calcul : section-rule.ts.

type SectionMode = 'vertical' | 'horizontal' | 'points';
const SECTION_MODES: SectionMode[] = ['vertical', 'horizontal', 'points'];

type SectionState = 'idle' | 'placing' | 'done';

// Épaisseur de la tranche : quelques cm par défaut, réglable de 1 cm à 1 m.
const DEFAULT_THICKNESS = 0.05;
const MIN_THICKNESS_CM = 1;
const MAX_THICKNESS_CM = 100;

// Coupe horizontale posée sur un sol : hauteur de coupe par défaut, celle
// d'un plan d'architecte. Un sol : normale à moins de 25° de la verticale,
// tournée vers le haut.
const DEFAULT_CUT_HEIGHT = 1;
const FLOOR_COS = Math.cos(25 * Math.PI / 180);
// Coupe verticale posée sur un mur (normale à moins de 30° de l'horizontale) :
// perpendiculaire au mur.
const WALL_SIN = Math.sin(30 * Math.PI / 180);

// Décalage du plan dans le panneau (cm).
const MAX_OFFSET_CM = 5000;
const MAX_CUT_HEIGHT_CM = 2000;

// En dessous, A et B sont confondus.
const MIN_LENGTH = 0.02;

// Surface sous un point : plan ajusté sur les splats à moins de 8 cm (rayon
// doublé jusqu'à 32 cm tant qu'il y a moins de 60 splats : nuage LiDAR
// clairsemé), puis resserré sur les splats proches de ce plan. Un rayon plus
// grand attrapait le mur voisin d'un point pointé au pied du mur. Sans assez
// de splats, ou s'ils ne forment pas une surface (angle, végétation), la
// normale n'est pas retenue.
const NORMAL_RADIUS_MIN = 0.08;
const NORMAL_RADIUS_MAX = 0.32;
const NORMAL_TARGET_POINTS = 60;
const NORMAL_MIN_POINTS = 12;
const NORMAL_MIN_INLIERS = 0.5;
const NORMAL_MAX_POINTS = 20000;
// Les deux surfaces sont la même si leurs normales font moins de 30°.
const SURFACE_AGREE_COS = Math.cos(30 * Math.PI / 180);
// Sol ou mur à 10° près : la coupe est exactement verticale ou horizontale.
const SNAP_SIN = Math.sin(10 * Math.PI / 180);
const SNAP_COS = Math.cos(10 * Math.PI / 180);
// AB à moins de 17° de la normale de la surface (du sol au plafond, d'un mur
// à l'autre) : la surface ne dit rien de l'orientation du plan.
const PARALLEL_SIN = 0.3;

// Entre deux points, la coupe s'étend un peu au-delà de A et de B : un sol
// pointé en A reste dans la coupe même s'il est à la limite.
const STRIP_MARGIN_RATIO = 0.1;
const STRIP_MARGIN_MIN = 0.1;
const STRIP_MARGIN_MAX = 1;

// A et B recalés sur le nuage : le pointage donne une profondeur moyenne,
// parfois sous la surface. On les déplace selon la normale de la surface
// pointée (ramenée dans le plan de coupe) : splats à moins de 10 cm de A
// selon cette normale et de 3 cm en travers ; on prend la couche la plus
// dense (pas de 5 mm), puis la médiane des splats à moins de 1 cm de cette
// couche. Sans normale lisible, le point reste où il a été pointé.
const SNAP_ALONG = 0.03;
// Nuage clairsemé (niveau de détail grossier, LiDAR) : 10 cm en travers.
const SNAP_ALONG_WIDE = 0.1;
const SNAP_ACROSS = 0.1;
const SNAP_BIN = 0.005;
const SNAP_LAYER = 0.01;
const SNAP_MIN_POINTS = 5;

// Points isolés (splats flottants) : même idée que les cases isolées de la
// planéité. Grille du profil, de 1 cm au départ, agrandie jusqu'à ce qu'un
// point ait en général 16 voisins dans ses 3 × 3 cases (20 cm au plus) ; un
// point qui en a moins de 3 est écarté.
const ISOLATED_CELL_MIN = 0.01;
const ISOLATED_CELL_MAX = 0.2;
const ISOLATED_TARGET = 16;
const ISOLATED_MIN_NEIGHBORS = 3;
const ISOLATED_SAMPLE = 2000;
const ISOLATED_DENSE_MAX = 8e6;

// Entre deux points, en travers de AB, la tranche garde tout pour une coupe
// verticale d'un AB plutôt horizontal : la hauteur entière d'un bâtiment ou
// d'un terrain. Sinon elle traverserait toute la scène (aplomb d'un mur, du
// sol au plafond, profil le long d'un mur) : on s'en tient à 1 m (ou
// |AB| / 2) de part et d'autre de AB.
const ACROSS_LIMIT_MIN = 1;
const ACROSS_LIMIT_RATIO = 0.5;
// Vue de départ du profil : toute la coupe, sauf les quelques points les
// plus écartés.
const FIT_PERCENTILE = 0.002;

// Délai avant de relancer le calcul après un réglage ou un déplacement.
const RECOMPUTE_DELAY = 150;

// Modèles LOD : marge autour de la tranche pour le chargement du niveau fin.
const FINEST_MARGIN = 0.25;

const EXAGGERATIONS = [1, 2, 5, 10];

// Pente affichée jusqu'à 60° ; au-delà, faux aplomb en mm/m.
const SLOPE_MAX_ANGLE = 60 * Math.PI / 180;

// Export DXF : au plus 100 000 points (un sur n au-delà) ; le CSV les a tous.
// ArchiCAD fait un point chaud de chaque point, AutoCAD s'alourdit.
const DXF_MAX_POINTS = 100000;

const MODE_STORAGE_KEY = 'artlight.section.mode';
const THICKNESS_STORAGE_KEY = 'artlight.section.thickness';
const CUT_HEIGHT_STORAGE_KEY = 'artlight.section.cut-height';
const FILTER_STORAGE_KEY = 'artlight.section.filter';
const MASK_STORAGE_KEY = 'artlight.section.mask';
const EXAGGERATION_STORAGE_KEY = 'artlight.section.exaggeration';
const COLLAPSED_STORAGE_KEY = 'artlight.section.collapsed';
const LARGE_STORAGE_KEY = 'artlight.section.large';
// Règle : longueur, côté et tuiles sont mémorisés ; la règle elle-même est à
// rallumer (en coupe verticale, elle prend les clics du profil).
const RULE_LENGTH_STORAGE_KEY = 'artlight.section.rule-length';
const RULE_SIDE_STORAGE_KEY = 'artlight.section.rule-side';
const RULE_TILE_STORAGE_KEY = 'artlight.section.rule-tile';

const tr = translator('artlight.section');

// Coupe posée d'un clic. Le plan passe par anchor + normal × offset ; le
// profil a son origine à l'aplomb du point cliqué, et ne bouge donc pas
// quand on décale le plan.
interface Placement {
    anchor: Vec3;               // point cliqué
    along: Vec3;                // horizontale du profil (unitaire, horizontale)
    normal: Vec3;               // côté masqué : vers l'observateur (verticale), le haut (horizontale)
    offset: number;             // décalage du plan depuis le point cliqué, selon la normale (m)
    floor: boolean;             // point cliqué au sol ; horizontale : offset = hauteur de coupe
}

// Repère de la coupe (monde). Le plan passe par origin, de normale normal ;
// along et across sont deux directions du plan. Le profil se lit selon x
// (horizontale du profil) et y (verticale du profil) ; normal = x × y : on
// regarde le profil depuis le côté où pointe la normale, qui est le côté
// masqué dans la vue.
interface Frame {
    key: string;
    mode: SectionMode;
    origin: Vec3;
    normal: Vec3;
    along: Vec3;
    across: Vec3;
    x: Vec3;
    y: Vec3;
    kind: 'vertical' | 'horizontal' | 'inclined';
    tilt: number;               // angle du plan avec l'horizontale (rad)
    // Entre deux points seulement
    ends: {
        length: number;         // A → B, dans le plan
        bInPlane: Vec3;         // B projeté sur le plan
        snapA: Vec3 | null;     // direction de recalage de A et de B (dans le plan)
        snapB: Vec3 | null;
        facing: boolean;        // A et B l'un au-dessus de l'autre : plan face à la vue
    } | null;
}

interface Section {
    frame: Frame;
    thickness: number;
    uMin: number;               // étendue de la tranche selon along et across
    uMax: number;
    wMin: number;
    wMax: number;
    points: Float32Array;       // s, t des points retenus
    depth: Float32Array;        // leur écart au plan de coupe, selon sa normale (m)
    count: number;
    isolated: number;           // points isolés écartés
    // Entre deux points : A et B recalés sur le nuage
    ends: { a3: Vec3; b3: Vec3; a: ProfilePoint; b: ProfilePoint; snapped: boolean } | null;
    fit: ProfileData['fit'];
}

interface Dimensions {
    length: number;
    horizontal: number;
    rise: number;               // selon la verticale
}

type LodStatus = 'finest' | 'finer' | 'loading' | 'too-large' | 'failed';

// Première lettre en capitale : « Incliné à 35° ».
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// Flèche, toujours en mm : « 12,3 mm ».
const formatGap = (m: number) => `${formatNumber(m * 1000, 1)} mm`;

// Longueur de règle : « 20 cm », « 2 m ».
const formatRuleLength = (m: number) => (m < 1 ? `${Math.round(m * 100)} cm` : `${formatNumber(m, 0)} m`);

// Composante horizontale d'un vecteur, normalisée (null si presque verticale).
const horizontal = (v: Vec3, up: Vec3): Vec3 | null => {
    const h = v.clone().sub(up.clone().mulScalar(v.dot(up)));
    return h.length() > 1e-6 ? h.normalize() : null;
};

// Horizontale de l'écran : la droite de la caméra, à plat.
const screenRight = (camera: { right: Vec3; forward: Vec3 }, up: Vec3): Vec3 => horizontal(camera.right, up) ??
    new Vec3().cross(horizontal(camera.forward, up) ?? new Vec3(1, 0, 0), up).normalize();

// Les splats sont lus dans le repère local du modèle, sans passer chacun
// dans le monde : pour un écart e (local) à un point, l'écart dans le monde
// vaut M·e (M : partie 3 × 3 de la matrice monde) et sa projection sur un
// vecteur monde v vaut e · (Mᵀ v).
const localAxis = (m: Float32Array, v: Vec3): Vec3 => new Vec3(
    m[0] * v.x + m[1] * v.y + m[2] * v.z,
    m[4] * v.x + m[5] * v.y + m[6] * v.z,
    m[8] * v.x + m[9] * v.y + m[10] * v.z
);

// Point `p` (monde) dans le repère local, et borne de M⁻¹ : un écart monde
// de r correspond à un écart local d'au plus r × bound sur chaque axe.
const toLocal = (m: Float32Array, p: Vec3): { point: Vec3; bound: number } => {
    const inv = new Mat4().set(Array.from(m)).invert();
    const d = inv.data;
    const bound = Math.sqrt([0, 1, 2, 4, 5, 6, 8, 9, 10].reduce((sum, k) => sum + d[k] * d[k], 0));
    return { point: inv.transformPoint(p, new Vec3()), bound };
};

// Point origin + x·s + y·t (monde).
const framePoint = (frame: Frame, s: number, t: number): Vec3 => frame.origin.clone()
.add(frame.x.clone().mulScalar(s))
.add(frame.y.clone().mulScalar(t));

// La boîte `inner` est-elle entièrement dans `outer` ?
const obbInside = (inner: OrientedBox, outer: OrientedBox): boolean => {
    for (let q = 0; q < 8; q++) {
        const p = inner.center.clone();
        inner.axes.forEach((axis, a) => p.add(axis.clone().mulScalar(((q >> a) & 1 ? 1 : -1) * inner.half[a])));
        for (let a = 0; a < 3; a++) {
            const d = new Vec3().sub2(p, outer.center).dot(outer.axes[a]);
            if (Math.abs(d) > outer.half[a] + 1e-6) return false;
        }
    }
    return true;
};

// Couche la plus dense d'une liste d'écarts : pic de l'histogramme (pas de
// 5 mm, lissé), puis médiane des écarts proches de ce pic.
const densestLayer = (values: number[]): number | null => {
    if (values.length < SNAP_MIN_POINTS) return null;
    const bins = Math.round(2 * SNAP_ACROSS / SNAP_BIN);
    const hist = new Float64Array(bins);
    for (const v of values) {
        const i = Math.min(bins - 1, Math.max(0, Math.floor((v + SNAP_ACROSS) / SNAP_BIN)));
        hist[i]++;
    }
    let best = -1, peak = 0;
    for (let i = 0; i < bins; i++) {
        const smooth = (hist[i - 1] ?? 0) + 2 * hist[i] + (hist[i + 1] ?? 0);
        if (smooth > best) {
            best = smooth;
            peak = -SNAP_ACROSS + (i + 0.5) * SNAP_BIN;
        }
    }
    const layer = values.filter(v => Math.abs(v - peak) <= SNAP_LAYER);
    return layer.length >= SNAP_MIN_POINTS ? median(layer) : null;
};

// Points isolés du profil (voir ISOLATED_*) : renvoie un drapeau par point,
// 1 si le point est gardé.
const keepDenseProfilePoints = (st: Float32Array, count: number): Uint8Array => {
    const keep = new Uint8Array(count).fill(1);
    if (count < 20) return keep;

    let sMin = Infinity, sMax = -Infinity, tMin = Infinity, tMax = -Infinity;
    for (let i = 0; i < count; i++) {
        const s = st[i * 2], t = st[i * 2 + 1];
        if (s < sMin) sMin = s; if (s > sMax) sMax = s;
        if (t < tMin) tMin = t; if (t > tMax) tMax = t;
    }

    // Comptage par case : grille dense si elle tient en mémoire, sinon table.
    const countCells = (cell: number) => {
        const cols = Math.floor((sMax - sMin) / cell) + 3;
        const rows = Math.floor((tMax - tMin) / cell) + 3;
        const cellOf = (i: number) => (Math.floor((st[i * 2 + 1] - tMin) / cell) + 1) * cols + Math.floor((st[i * 2] - sMin) / cell) + 1;
        if (cols * rows <= ISOLATED_DENSE_MAX) {
            const grid = new Uint32Array(cols * rows);
            for (let i = 0; i < count; i++) grid[cellOf(i)]++;
            return { cols, cellOf, at: (k: number) => grid[k] };
        }
        const map = new Map<number, number>();
        for (let i = 0; i < count; i++) {
            const k = cellOf(i);
            map.set(k, (map.get(k) ?? 0) + 1);
        }
        return { cols, cellOf, at: (k: number) => map.get(k) ?? 0 };
    };
    const neighbors = (cells: ReturnType<typeof countCells>, i: number) => {
        const k = cells.cellOf(i);
        let n = 0;
        for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) n += cells.at(k + dj * cells.cols + di);
        }
        return n;
    };

    let cell = ISOLATED_CELL_MIN;
    let cells = countCells(cell);
    const stride = Math.max(1, Math.floor(count / ISOLATED_SAMPLE));
    for (;;) {
        const sample: number[] = [];
        for (let i = 0; i < count; i += stride) sample.push(neighbors(cells, i));
        if (median(sample) >= ISOLATED_TARGET || cell >= ISOLATED_CELL_MAX) break;
        cell = Math.min(ISOLATED_CELL_MAX, cell * 1.5);
        cells = countCells(cell);
    }
    for (let i = 0; i < count; i++) {
        if (neighbors(cells, i) < ISOLATED_MIN_NEIGHBORS) keep[i] = 0;
    }
    return keep;
};

// Direction dominante des murs dans une coupe horizontale : l'angle (−45° à
// 45°) dont il faut tourner les axes du profil pour y aligner le plus de
// cases occupées. Score : somme des carrés des effectifs des histogrammes
// sur les deux axes, grand quand les murs tombent dans peu de cases. Cases de
// 2,5 cm lues deux par deux (fenêtres glissantes de 5 cm) : un mur à cheval
// sur deux cases ne perd pas son score (avec des cases fixes, l'alignement
// sortait à 1° près). Tous les degrés, puis au dixième autour du meilleur.
// null sur trop peu de points.
const WALL_BIN = 0.025;
const WALL_SAMPLE = 20000;
const WALL_MIN_POINTS = 200;

const WALL_CELL = 0.05;

const dominantAngle = (points: Float32Array, count: number): number | null => {
    if (count < WALL_MIN_POINTS) return null;
    // Une voix par case de 5 cm occupée : on compte des longueurs de mur, pas
    // des points. Un objet très dense (radiateur de l'appartement) l'emportait
    // sinon sur les murs, plus clairsemés.
    // Position moyenne des points de chaque case, et non son centre : les
    // centres, alignés sur les axes du profil, favorisaient l'angle 0.
    const cells = new Map<string, [number, number, number]>();
    for (let i = 0; i < count; i++) {
        const x = points[i * 2], y = points[i * 2 + 1];
        const key = `${Math.floor(x / WALL_CELL)},${Math.floor(y / WALL_CELL)}`;
        const cell = cells.get(key);
        if (cell) {
            cell[0] += x;
            cell[1] += y;
            cell[2]++;
        } else {
            cells.set(key, [x, y, 1]);
        }
    }
    const xs: number[] = [], ys: number[] = [];
    let radius = 0;
    for (const [sx, sy, n] of cells.values()) {
        xs.push(sx / n);
        ys.push(sy / n);
        radius = Math.max(radius, Math.hypot(sx / n, sy / n));
    }
    if (xs.length > WALL_SAMPLE) {
        const stride = xs.length / WALL_SAMPLE;
        const pick = (v: number[]) => Array.from({ length: WALL_SAMPLE }, (_, k) => v[Math.floor(k * stride)]);
        xs.splice(0, xs.length, ...pick(xs));
        ys.splice(0, ys.length, ...pick(ys));
    }
    const bins = Math.ceil(2 * radius / WALL_BIN) + 2;
    const hx = new Int32Array(bins), hy = new Int32Array(bins);
    const score = (deg: number) => {
        const c = Math.cos(deg * Math.PI / 180), sn = Math.sin(deg * Math.PI / 180);
        hx.fill(0);
        hy.fill(0);
        for (let k = 0; k < xs.length; k++) {
            hx[Math.floor((xs[k] * c + ys[k] * sn + radius) / WALL_BIN)]++;
            hy[Math.floor((ys[k] * c - xs[k] * sn + radius) / WALL_BIN)]++;
        }
        let total = 0;
        for (let b = 0; b + 1 < bins; b++) {
            const x = hx[b] + hx[b + 1], y = hy[b] + hy[b + 1];
            total += x * x + y * y;
        }
        return total;
    };
    let best = 0, bestScore = -1;
    for (let deg = -45; deg < 45; deg++) {
        const v = score(deg);
        if (v > bestScore) {
            bestScore = v;
            best = deg;
        }
    }
    const coarse = best;
    for (let deg = coarse - 1; deg <= coarse + 1; deg += 0.1) {
        const v = score(deg);
        if (v > bestScore) {
            bestScore = v;
            best = deg;
        }
    }
    return best;
};

// Valeur au rang `q` (0 à 1) d'une liste, sans la trier en entier.
const quantile = (values: number[], q: number) => {
    const sorted = subsample(values, 20000).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
};

class SectionTool {
    private global: Global;

    private pointerHandler: ToolPointerHandler;

    // Côté avant masqué et tranche teintée dans la vue 3D.
    private highlight: SplatSectionHighlight;

    private mode = readStoredText(MODE_STORAGE_KEY, 'vertical', v => SECTION_MODES.includes(v as SectionMode)) as SectionMode;

    private state: SectionState = 'idle';

    // Coupe posée d'un clic (verticale, horizontale).
    private placement: Placement | null = null;

    // Poignées déplaçables : A et B (entre deux points), ou le plan et, pour
    // une verticale, la poignée de rotation. Le ToolPointerHandler les
    // déplace en place.
    private handles: Vec3[] = [];

    private lastHandles: Vec3[] = [];

    // Point du plan où se tient la poignée du plan (on peut la glisser le
    // long du plan) ; la poignée de rotation est à handleLength de lui.
    private grip = new Vec3();

    private handleLength = 1;

    // Géométrie changée par une poignée : calcul à relancer au lâcher.
    private geometryDirty = false;

    private recomputeTimer: ReturnType<typeof setTimeout> | null = null;

    // Verticale du relevé dans le repère du moteur (voir verticalAxis).
    private up = Vec3.UP.clone();

    // Repère de la dernière coupe : gardé tant que la coupe ne bouge pas
    // (épaisseur, filtre, niveau fin arrivé).
    private frame: Frame | null = null;

    private section: Section | null = null;

    // Raison de l'absence de coupe : A et B confondus, aucun point.
    private failure: 'too-short' | 'no-data' | 'no-points' | null = null;

    // Modèle LOD : niveaux de détail de la coupe (voir la planéité).
    private lod: { usage: LodUsage; status: LodStatus } | null = null;

    // Niveau le plus fin chargé, la tranche qu'il couvre.
    private finest: { key: string; obb: OrientedBox; data: SplatCenters } | null = null;

    private finestRequest = 0;

    // Réglages
    private thickness = readStoredNumber(THICKNESS_STORAGE_KEY, DEFAULT_THICKNESS, v => v >= MIN_THICKNESS_CM / 100 && v <= MAX_THICKNESS_CM / 100);

    private cutHeight = readStoredNumber(CUT_HEIGHT_STORAGE_KEY, DEFAULT_CUT_HEIGHT, v => v >= 0 && v <= MAX_CUT_HEIGHT_CM / 100);

    private filterIsolated = readStoredText(FILTER_STORAGE_KEY, '1', v => v === '0' || v === '1') === '1';

    private mask = readStoredText(MASK_STORAGE_KEY, '1', v => v === '0' || v === '1') === '1';

    private exaggeration = readStoredNumber(EXAGGERATION_STORAGE_KEY, 1, v => EXAGGERATIONS.includes(v));

    private collapsed = readStoredText(COLLAPSED_STORAGE_KEY, '0', v => v === '0' || v === '1') === '1';

    private large = readStoredText(LARGE_STORAGE_KEY, '0', v => v === '0' || v === '1') === '1';

    // Fenêtre du profil, gardée tant que son origine et ses axes ne changent
    // pas (null : ajuster aux données).
    private profileWindow: ProfileWindow | null = null;

    private measure: ProfileMeasure | null = null;

    private hover: ProfilePoint | null = null;

    // Règle sur le profil (TKT-246). Portée posée par deux clics sur le
    // profil ; entre deux points, de A à B tant qu'on n'en a pas posé une.
    private ruleOn = false;

    private ruleLength = readStoredNumber(RULE_LENGTH_STORAGE_KEY, 0, v => RULE_LENGTHS.includes(v));

    private ruleSide: 1 | -1 = readStoredText(RULE_SIDE_STORAGE_KEY, '1', v => v === '1' || v === '-1') === '-1' ? -1 : 1;

    private ruleTile = readStoredNumber(RULE_TILE_STORAGE_KEY, 0, v => WAVE_WIDTHS.includes(v));

    private ruleSpan: [ProfilePoint, ProfilePoint] | null = null;

    // Pose de la portée sur le profil, et son premier bout.
    private rulePicking = false;

    private rulePickFirst: ProfilePoint | null = null;

    private rule: RuleResult | null = null;

    private overlay: HTMLDivElement | null = null;

    private drawCanvas: HTMLCanvasElement | null = null;

    private hint: HTMLDivElement | null = null;

    private panel: HTMLDivElement | null = null;

    private summary: HTMLSpanElement | null = null;

    private main: HTMLDivElement | null = null;

    private results: HTMLDivElement | null = null;

    private profileView: ProfileView | null = null;

    private readout: HTMLDivElement | null = null;

    private resizeObserver: ResizeObserver | null = null;

    private updateHandler: ((dt: number) => void) | null = null;

    private keyHandler: ((event: KeyboardEvent) => void) | null = null;

    // Repère changé dans le panneau Point (zéro, système, altitude NGF) :
    // altitudes, graduations et textes du panneau sont refaits.
    private coordsHandler = () => {
        if (this.state === 'done') this.showPanel();
    };

    constructor(global: Global) {
        this.global = global;
        this.highlight = new SplatSectionHighlight(global);
        this.pointerHandler = new ToolPointerHandler(global, {
            onCanvasClick: pos => this.handleClick(pos),
            getDraggablePoints: () => (this.state === 'done' ? this.handles : []),
            onClear: () => this.clearAll(),
            isEmpty: () => this.state === 'idle'
        });
    }

    activate() {
        const { app } = this.global;

        this.overlay = document.createElement('div');
        this.overlay.id = 'sectionOverlay';
        const ui = document.querySelector('#ui');
        ui.insertBefore(this.overlay, ui.firstChild);

        this.drawCanvas = document.createElement('canvas');
        this.drawCanvas.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;';
        this.overlay.appendChild(this.drawCanvas);

        this.hint = document.createElement('div');
        this.hint.id = 'sectionHint';
        this.hint.className = 'tool-hint';
        this.overlay.appendChild(this.hint);
        this.updateHint();

        this.pointerHandler.activate();
        this.global.events.on('coords:changed', this.coordsHandler);

        // Retour arrière retire A pendant la pose de B.
        this.keyHandler = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest?.('input, textarea, select, [contenteditable]')) return;
            if (this.state === 'placing' && (event.key === 'Backspace' || event.key === 'Delete')) {
                event.preventDefault();
                this.clearAll();
            }
        };
        document.addEventListener('keydown', this.keyHandler);

        this.updateHandler = () => {
            this.syncFromHandles();
            this.render();
        };
        app.on('update', this.updateHandler);
    }

    deactivate() {
        const { app } = this.global;

        if (this.updateHandler) {
            app.off('update', this.updateHandler);
            this.updateHandler = null;
        }
        if (this.keyHandler) {
            document.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
        }

        this.pointerHandler.deactivate();
        this.global.events.off('coords:changed', this.coordsHandler);
        this.cancelRecompute();
        this.removePanel();
        this.highlight.clear();

        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }

        this.drawCanvas = null;
        this.hint = null;
        this.resetAnalysis();
        this.placement = null;
        this.handles = [];
        this.lastHandles = [];
        this.state = 'idle';
    }

    destroy() {
        this.deactivate();
        this.pointerHandler.destroy();
    }

    // ── Pose et réglage de la coupe ──

    private handleClick(pos: Vec3) {
        this.pointerHandler.selectedIndex = -1;
        if (this.mode === 'points') {
            if (this.state === 'idle') {
                this.handles = [pos];
                this.state = 'placing';
            } else if (this.state === 'placing') {
                this.handles.push(pos);
                this.state = 'done';
                this.newView();
                this.analyze();
                this.showPanel();
            }
            // Coupe posée : A et B se déplacent par le glisser.
        } else {
            this.place(pos);
        }
        this.storeHandles();
        this.updateHint();
        this.global.app.renderNextFrame = true;
    }

    // Coupe verticale ou horizontale par le point cliqué. Une coupe déjà
    // posée garde son orientation.
    private place(pos: Vec3) {
        this.up = verticalAxis(this.global);
        const up = this.up;
        const camera = this.global.camera;
        const toCamera = new Vec3().sub2(camera.getPosition(), pos);
        const info = getSplatCenters(this.global);
        const n = info ? this.localNormalAt(pos, info) : null;
        if (n && n.dot(toCamera) < 0) n.mulScalar(-1);

        const previous = this.placement && this.state === 'done' ? this.placement : null;
        const facing = screenRight(camera, up);
        const floor = !!n && n.dot(up) >= FLOOR_COS;

        if (this.mode === 'vertical') {
            let along = previous ? previous.along.clone() : facing.clone();
            // Mur cliqué : la coupe le traverse, perpendiculairement.
            const wall = !previous && n && Math.abs(n.dot(up)) < WALL_SIN ? horizontal(n, up) : null;
            if (wall) along = wall;
            const normal = new Vec3().cross(along, up).normalize();
            if (!previous && normal.dot(toCamera) < 0) {
                along.mulScalar(-1);
                normal.mulScalar(-1);
            }
            this.placement = { anchor: pos.clone(), along, normal, offset: 0, floor };
        } else {
            this.placement = {
                anchor: pos.clone(),
                along: previous ? previous.along.clone() : facing.clone(),
                normal: up.clone(),
                offset: floor ? this.cutHeight : 0,
                floor
            };
        }
        this.resetGrip(camera.getPosition().dot(up));
        if (this.mode === 'vertical') this.grip = this.screenGrip() ?? this.grip;
        this.handleLength = Math.min(5, Math.max(0.3, 0.2 * this.grip.distance(camera.getPosition())));
        this.state = 'done';
        this.newView();
        this.placeHandles();
        this.analyze();
        // Nouveau plan : les murs droits, plutôt que la vue de biais.
        if (this.mode === 'horizontal' && !previous && this.alignToWalls()) this.analyze();
        this.showPanel();
    }

    // Poignée du plan à l'aplomb du point cliqué. Coupe verticale : à la
    // hauteur donnée (celle des yeux à la pose) ou à celle qu'elle avait,
    // et non au sol, où le panneau du bas la cacherait souvent.
    private resetGrip(height?: number) {
        const origin = this.planeOrigin();
        if (this.mode === 'vertical') {
            const h = height ?? this.grip.dot(this.up);
            origin.add(this.up.clone().mulScalar(h - origin.dot(this.up)));
        }
        this.grip = origin;
    }

    // Point du plan vu dans le tiers haut de l'écran, à l'aplomb du point
    // cliqué : la poignée reste visible au-dessus du panneau. null si le
    // plan est vu par la tranche ou trop loin.
    private screenGrip(): Vec3 | null {
        const camera = this.global.camera;
        const origin = this.planeOrigin();
        const s = worldToScreen(camera, origin);
        if (s.behind) return null;
        const { width, height } = this.global.app.graphicsDevice.clientRect;
        const ray = screenToRay(camera, Math.min(width * 0.9, Math.max(width * 0.1, s.x)), height * 0.3);
        if (!ray) return null;
        const n = this.placement.normal;
        const denom = ray.dir.dot(n);
        if (Math.abs(denom) < 0.2) return null;
        const t = new Vec3().sub2(origin, ray.origin).dot(n) / denom;
        const p = ray.origin.clone().add(ray.dir.clone().mulScalar(t));
        return t > 0 && p.distance(origin) < 20 ? p : null;
    }

    // Point du plan à l'aplomb du point cliqué.
    private planeOrigin(): Vec3 {
        const p = this.placement;
        return p.anchor.clone().add(p.normal.clone().mulScalar(p.offset));
    }

    // Poignées d'après la coupe posée : le plan (grip) et, pour une
    // verticale, la rotation. Les Vec3 sont modifiés en place, le
    // ToolPointerHandler garde leurs références pendant un glisser.
    private placeHandles() {
        const p = this.placement;
        if (!p) return;
        const count = this.mode === 'vertical' ? 2 : 1;
        if (this.handles.length !== count) this.handles = Array.from({ length: count }, () => new Vec3());
        this.handles[0].copy(this.grip);
        if (count === 2) this.handles[1].copy(this.grip).add(p.along.clone().mulScalar(this.handleLength));
        this.storeHandles();
    }

    private storeHandles() {
        this.lastHandles = this.handles.map(h => h.clone());
    }

    // Orientation d'une coupe verticale : direction horizontale du profil.
    // La normale, côté masqué, vaut along × up.
    private setAlong(along: Vec3) {
        const p = this.placement;
        p.along = along.clone().normalize();
        p.normal = this.mode === 'horizontal' ? this.up.clone() : new Vec3().cross(p.along, this.up).normalize();
    }

    // Tourne l'horizontale du profil de `deg` degrés autour de la verticale.
    private rotateAlong(deg: number) {
        const p = this.placement;
        const rad = deg * Math.PI / 180;
        const y = new Vec3().cross(this.up, p.along);
        this.setAlong(p.along.clone().mulScalar(Math.cos(rad)).add(y.mulScalar(Math.sin(rad))));
    }

    // Aligne la coupe sur les murs : horizontale, les murs droits dans le
    // plan ; verticale, la coupe parallèle ou perpendiculaire au mur le plus
    // proche de son orientation, lus dans une coupe horizontale à 1 m
    // au-dessus du point cliqué s'il est au sol, à sa hauteur sinon.
    private alignToWalls(): boolean {
        const p = this.placement;
        let points: Float32Array, count: number;
        if (this.mode === 'horizontal') {
            if (!this.section) return false;
            ({ points, count } = this.section);
        } else {
            const info = getSplatCenters(this.global);
            if (!info) return false;
            const origin = p.anchor.clone().add(this.up.clone().mulScalar(p.floor ? this.cutHeight : 0));
            const y = new Vec3().cross(this.up, p.along).normalize();
            const frame: Frame = {
                key: '',
                mode: 'horizontal',
                origin,
                normal: this.up.clone(),
                along: p.along.clone(),
                across: y.clone(),
                x: p.along.clone(),
                y,
                kind: 'horizontal',
                tilt: 0,
                ends: null
            };
            const plan = this.slice(frame, info);
            if (!plan) return false;
            ({ points, count } = plan);
        }
        const angle = dominantAngle(points, count);
        if (angle === null) return false;
        this.rotateAlong(angle);
        if (this.mode === 'vertical') this.faceCamera();
        return true;
    }

    // Glisser d'une poignée : relu à chaque image. La coupe suit en direct
    // dans la vue ; le profil est recalculé au lâcher.
    private syncFromHandles() {
        if (this.state !== 'done') return;
        const dragging = this.pointerHandler.isDragging;
        const moved = this.handles.findIndex((h, i) => !h.equals(this.lastHandles[i]));
        if (moved >= 0) {
            if (this.mode === 'points') {
                this.newView();
                this.storeHandles();
            } else if (moved === 0) {
                // Poignée du plan : le plan passe par elle.
                const p = this.placement;
                this.grip.copy(this.handles[0]);
                p.offset = new Vec3().sub2(this.grip, p.anchor).dot(p.normal);
                this.placeHandles();
            } else {
                // Poignée de rotation : la coupe tourne autour de la poignée du plan.
                const dir = horizontal(new Vec3().sub2(this.handles[1], this.grip), this.up);
                if (dir) {
                    this.setAlong(dir);
                    // Le point cliqué reste sur le plan : décalage remis à zéro.
                    this.placement.anchor.copy(this.grip);
                    this.placement.offset = 0;
                    this.newView();
                }
                this.storeHandles();
            }
            this.geometryDirty = true;
            this.updateHighlight();
            this.global.app.renderNextFrame = true;
        }
        if (this.geometryDirty && !dragging) {
            this.geometryDirty = false;
            if (this.mode !== 'points') this.placeHandles();
            this.scheduleRecompute(true);
        }
    }

    // Réglage du panneau : la vue suit en direct, le calcul attend la fin des
    // appuis répétés. Les réglages ne sont pas reconstruits (on peut
    // maintenir un bouton), sauf `rebuild`.
    private scheduleRecompute(rebuild = false) {
        this.cancelRecompute();
        this.recomputeTimer = setTimeout(() => {
            this.recomputeTimer = null;
            this.analyze();
            if (rebuild || !this.panel) this.showPanel();
            else this.refreshResults();
            this.global.app.renderNextFrame = true;
        }, RECOMPUTE_DELAY);
    }

    private cancelRecompute() {
        if (this.recomputeTimer) {
            clearTimeout(this.recomputeTimer);
            this.recomputeTimer = null;
        }
    }

    // Nouvelle origine ou nouveaux axes du profil : il se recadre, la mesure
    // est effacée.
    private newView() {
        this.profileWindow = null;
        this.measure = null;
        this.hover = null;
        this.resetRuleSpan();
    }

    private resetAnalysis() {
        this.frame = null;
        this.section = null;
        this.failure = null;
        this.lod = null;
        this.finest = null;
        this.finestRequest++;
        this.geometryDirty = false;
        this.newView();
    }

    private clearAll() {
        this.cancelRecompute();
        this.placement = null;
        this.handles = [];
        this.lastHandles = [];
        this.state = 'idle';
        this.resetAnalysis();
        this.removePanel();
        this.highlight.clear();
        this.pointerHandler.reset();
        this.updateHint();
        this.global.app.renderNextFrame = true;
    }

    // Type de coupe. Entre verticale et horizontale, la coupe reste au même
    // endroit (à 1 m au-dessus d'un sol cliqué pour une horizontale) ; vers
    // ou depuis « Entre deux points », elle est à reposer.
    private setMode(mode: SectionMode) {
        if (mode === this.mode) return;
        const previous = this.mode;
        this.mode = mode;
        storeText(MODE_STORAGE_KEY, mode);
        if (this.state !== 'done' || mode === 'points' || previous === 'points') {
            this.clearAll();
            return;
        }
        const { anchor, floor } = this.placement;
        const facing = screenRight(this.global.camera, this.up);
        if (mode === 'vertical') {
            this.placement = { anchor, along: facing.clone(), normal: new Vec3(), offset: 0, floor };
            this.setAlong(facing);
        } else {
            this.placement = { anchor, along: this.placement.along.clone(), normal: this.up.clone(), offset: floor ? this.cutHeight : 0, floor };
        }
        this.resetGrip(this.global.camera.getPosition().dot(this.up));
        if (mode === 'vertical') this.grip = this.screenGrip() ?? this.grip;
        this.newView();
        this.placeHandles();
        this.analyze();
        this.showPanel();
        this.updateHint();
        this.global.app.renderNextFrame = true;
    }

    // Côté vu (et masqué) : la coupe est regardée de l'autre côté.
    private flip() {
        if (this.mode === 'points') {
            if (this.handles.length !== 2) return;
            this.handles.reverse();
            this.storeHandles();
        } else if (this.mode === 'vertical') {
            this.setAlong(this.placement.along.clone().mulScalar(-1));
            this.placement.offset = -this.placement.offset;
            this.placeHandles();
        }
        this.newView();
        this.analyze();
        this.showPanel();
        this.global.app.renderNextFrame = true;
    }

    // ── Aide contextuelle en haut de l'écran ──

    private updateHint() {
        if (!this.hint) return;
        this.hint.textContent = '';
        if (this.state === 'idle') {
            const modes = createSegmented(SECTION_MODES.map(m => ({ value: m, label: tr(`mode.${m}`), title: tr(`mode.${m}-title`) })), this.mode, (mode) => {
                this.setMode(mode);
                this.updateHint();
            });
            modes.classList.add('section-hint-modes');
            this.hint.appendChild(modes);
        }
        const label = document.createElement('span');
        label.textContent = tr(`hint.${this.mode}-${this.state}`);
        this.hint.appendChild(label);
        if (this.state === 'placing') {
            const button = document.createElement('button');
            button.textContent = tr('hint.clear');
            button.className = 'tool-btn';
            button.addEventListener('click', () => this.clearAll());
            this.hint.appendChild(button);
        }
    }

    // ── Calcul de la coupe ──

    private frameKey(): string {
        const values = this.mode === 'points' ?
            this.handles.flatMap(p => [p.x, p.y, p.z]) :
            [this.placement.anchor, this.placement.along, this.placement.normal].flatMap(v => [v.x, v.y, v.z]).concat(this.placement.offset);
        return [this.mode, ...values].join(',');
    }

    private analyze() {
        this.section = null;
        this.failure = null;
        this.lod = null;
        this.rule = null;
        if (this.state !== 'done') return;

        const key = this.frameKey();
        if (this.frame?.key !== key) {
            this.frame = null;
            this.measure = null;
            this.hover = null;
            this.resetRuleSpan();
        }
        // Un chargement lancé pour une autre tranche est abandonné.
        this.finestRequest++;

        if (this.mode === 'points' && this.handles[0].distance(this.handles[1]) < MIN_LENGTH) {
            this.failure = 'too-short';
            this.updateHighlight();
            return;
        }

        const finest = this.finest;
        let data: SplatCenters | null = null;
        if (finest && finest.key === key && this.frame && this.thickness / 2 <= finest.obb.half[2]) {
            data = finest.data;
            this.lod = { usage: finest.data.lod, status: finest.data.lod.min === 0 ? 'finest' : 'finer' };
        }
        const displayed = data ? null : getSplatCenters(this.global);
        if (!data && !displayed) {
            this.failure = 'no-data';
            this.updateHighlight();
            return;
        }

        if (!this.frame) {
            this.up = verticalAxis(this.global);
            this.frame = this.mode === 'points' ?
                this.buildPointsFrame(key, this.handles[0], this.handles[1], displayed) :
                this.placementFrame(key);
            if (!this.frame) {
                this.failure = 'too-short';
                this.updateHighlight();
                return;
            }
        }

        let section = this.slice(this.frame, data ?? displayed);

        // Modèle LOD : la tranche sur le niveau affiché, puis sur le plus fin.
        // Un niveau fin déjà chargé sert encore si la tranche y tient (plan
        // décalé de quelques centimètres).
        if (!data && section) {
            const obb = this.sliceBox(section);
            if (finest && obbInside(obb, finest.obb)) {
                this.lod = { usage: finest.data.lod, status: finest.data.lod.min === 0 ? 'finest' : 'finer' };
                this.finest.key = key;
                section = this.slice(this.frame, finest.data) ?? section;
            } else if (!displayed.lod) {
                this.lod = null;
            } else {
                const usage = displayedLodInBox(this.global, orientedBoxAabb(obb), obb) ?? displayed.lod;
                if (usage.max === 0) {
                    this.lod = { usage, status: 'finest' };
                } else {
                    this.lod = { usage, status: 'loading' };
                    this.requestFinest(key, obb, usage);
                }
            }
        }

        this.section = section;
        if (!section) this.failure = 'no-points';
        this.updateRule();
        this.updateHighlight();
    }

    // Charge le niveau le plus fin possible sur la tranche (élargie de
    // 25 cm), puis refait la coupe.
    private requestFinest(key: string, obb: OrientedBox, displayed: LodUsage) {
        const request = this.finestRequest;
        const cancelled = () => request !== this.finestRequest || this.state !== 'done';
        const padded: OrientedBox = {
            center: obb.center.clone(),
            axes: obb.axes,
            half: [obb.half[0] + FINEST_MARGIN, obb.half[1] + FINEST_MARGIN, obb.half[2] + FINEST_MARGIN]
        };
        loadFinestCenters(this.global, orientedBoxAabb(padded), displayed.min, cancelled, padded)
        .catch((): FinestResult => ({ status: 'failed' }))
        .then((result) => {
            if (cancelled() || this.lod?.status !== 'loading') return;
            if (result.status === 'ok') {
                this.finest = { key, obb: padded, data: result.data };
                this.analyze();
            } else {
                this.lod.status = result.status === 'too-large' ? 'too-large' : 'failed';
            }
            this.refreshResults();
            this.global.app.renderNextFrame = true;
        });
    }

    // Boîte orientée de la tranche : selon along, across, épaisseur.
    private sliceBox(section: Section): OrientedBox {
        const f = section.frame;
        const uMid = (section.uMin + section.uMax) / 2, wMid = (section.wMin + section.wMax) / 2;
        return {
            center: f.origin.clone().add(f.along.clone().mulScalar(uMid)).add(f.across.clone().mulScalar(wMid)),
            axes: [f.along.clone(), f.across.clone(), f.normal.clone()],
            half: [(section.uMax - section.uMin) / 2, (section.wMax - section.wMin) / 2, section.thickness / 2]
        };
    }

    // Repère d'une coupe posée d'un clic.
    private placementFrame(key: string): Frame {
        const p = this.placement;
        const up = this.up;
        const origin = this.planeOrigin();
        if (this.mode === 'vertical') {
            return {
                key,
                mode: 'vertical',
                origin,
                normal: p.normal.clone(),
                along: p.along.clone(),
                across: up.clone(),
                x: p.along.clone(),
                y: up.clone(),
                kind: 'vertical',
                tilt: Math.PI / 2,
                ends: null
            };
        }
        // Vue en plan : x vers la droite de la vue au moment de la pose, y
        // vers le fond ; vue d'en haut (normale vers le haut).
        const y = new Vec3().cross(up, p.along).normalize();
        return {
            key,
            mode: 'horizontal',
            origin,
            normal: up.clone(),
            along: p.along.clone(),
            across: y.clone(),
            x: p.along.clone(),
            y,
            kind: 'horizontal',
            tilt: 0,
            ends: null
        };
    }

    // Normale de la surface sous un point (null si elle n'est pas lisible).
    private localNormalAt(target: Vec3, info: SplatCenters): Vec3 | null {
        const { centers, numSplats, worldMatrix: m } = info;
        const rMax2 = NORMAL_RADIUS_MAX * NORMAL_RADIUS_MAX;
        // Splats à moins du rayon maximal : écart monde et distance².
        const { point: L, bound } = toLocal(m, target);
        const reach = NORMAL_RADIUS_MAX * bound;
        const offsets: number[] = [];
        const dist2: number[] = [];
        for (let i = 0; i < numSplats; i++) {
            const ex = centers[i * 3] - L.x;
            if (ex > reach || ex < -reach) continue;
            const ey = centers[i * 3 + 1] - L.y;
            if (ey > reach || ey < -reach) continue;
            const ez = centers[i * 3 + 2] - L.z;
            if (ez > reach || ez < -reach) continue;
            const wx = m[0] * ex + m[4] * ey + m[8] * ez;
            const wy = m[1] * ex + m[5] * ey + m[9] * ez;
            const wz = m[2] * ex + m[6] * ey + m[10] * ez;
            const d2 = wx * wx + wy * wy + wz * wz;
            if (d2 >= rMax2) continue;
            offsets.push(wx, wy, wz);
            dist2.push(d2);
        }
        // Le plus petit rayon qui réunit assez de splats
        let radius = NORMAL_RADIUS_MIN;
        const within = (r: number) => dist2.reduce((n, d2) => n + (d2 < r * r ? 1 : 0), 0);
        while (radius < NORMAL_RADIUS_MAX && within(radius) < NORMAL_TARGET_POINTS) radius *= 2;
        const r2 = radius * radius;
        const pts: number[] = [];
        dist2.forEach((d2, k) => {
            if (d2 < r2) pts.push(target.x + offsets[k * 3], target.y + offsets[k * 3 + 1], target.z + offsets[k * 3 + 2]);
        });
        return this.fitNormal(pts, target);
    }

    private fitNormal(values: number[], at: Vec3): Vec3 | null {
        let count = values.length / 3;
        if (count < NORMAL_MIN_POINTS) return null;
        let pts = Float64Array.from(values);
        if (count > NORMAL_MAX_POINTS) {
            const stride = count / NORMAL_MAX_POINTS;
            const reduced = new Float64Array(NORMAL_MAX_POINTS * 3);
            for (let k = 0; k < NORMAL_MAX_POINTS; k++) {
                const i = Math.floor(k * stride) * 3;
                reduced.set(pts.subarray(i, i + 3), k * 3);
            }
            pts = reduced;
            count = NORMAL_MAX_POINTS;
        }
        const hint = new Vec3().sub2(this.global.camera.getPosition(), at).normalize();
        let plane = fitPlaneLS(pts, Array.from({ length: count }, (_, i) => i), hint);
        // Deux passes resserrées sur les splats proches du plan : la surface
        // pointée, sans le mur voisin ni les splats flottants.
        for (let iter = 0; iter < 2 && plane; iter++) {
            const O = plane.origin, N = plane.normal;
            const residuals = new Float64Array(count);
            for (let k = 0; k < count; k++) {
                residuals[k] = (pts[k * 3] - O.x) * N.x + (pts[k * 3 + 1] - O.y) * N.y + (pts[k * 3 + 2] - O.z) * N.z;
            }
            const med = median(Array.from(residuals));
            const sigma = 1.4826 * median(Array.from(residuals, r => Math.abs(r - med)));
            const tol = Math.max(0.01, 2.5 * sigma);
            const inliers: number[] = [];
            for (let k = 0; k < count; k++) if (Math.abs(residuals[k] - med) <= tol) inliers.push(k);
            if (inliers.length < Math.max(NORMAL_MIN_POINTS, count * NORMAL_MIN_INLIERS)) return null;
            plane = fitPlaneLS(pts, inliers, N);
        }
        return plane?.normal ?? null;
    }

    // Repère d'une coupe entre deux points : plan vertical par A et B, sauf
    // s'il se confond avec la surface pointée (A et B à la même hauteur le
    // long d'un mur) ; A et B l'un au-dessus de l'autre : perpendiculaire au
    // mur (aplomb), ou face à la vue (du sol au plafond).
    private buildPointsFrame(key: string, A: Vec3, B: Vec3, info: SplatCenters): Frame | null {
        const up = this.up;
        const dir = new Vec3().sub2(B, A).normalize();
        const nA = this.localNormalAt(A, info), nB = this.localNormalAt(B, info);

        // Surface commune à A et B : sol et mur à 10° près redressés.
        let surface: Vec3 | null = null;
        if (nA && nB) {
            const c = nA.dot(nB);
            if (Math.abs(c) >= SURFACE_AGREE_COS) surface = nA.clone().add(nB.clone().mulScalar(Math.sign(c))).normalize();
        } else {
            surface = nA ?? nB;
        }
        if (surface) {
            const c = surface.dot(up);
            if (Math.abs(c) >= SNAP_COS) surface = up.clone();
            else if (Math.abs(c) <= SNAP_SIN) surface = surface.clone().sub(up.clone().mulScalar(c)).normalize();
        }

        let normal: Vec3 | null = null;
        let facing = false;
        const c0 = new Vec3().cross(dir, up);
        if (c0.length() >= SNAP_SIN) {
            normal = c0.normalize();
            const across = surface && new Vec3().cross(dir, surface);
            if (across && Math.abs(normal.dot(surface)) >= SURFACE_AGREE_COS && across.length() >= PARALLEL_SIN) {
                normal = across.normalize();
            }
        }
        if (!normal && surface && Math.abs(surface.dot(up)) < 0.5) {
            normal = new Vec3().cross(surface, up).normalize();
        }
        if (!normal) {
            normal = horizontal(this.global.camera.forward, up) ?? horizontal(this.global.camera.up, up);
            facing = true;
        }

        // Plan vertical ou horizontal à 10° près : exactement. B est ramené
        // sur le plan.
        let kind: Frame['kind'] = 'inclined';
        const c = normal.dot(up);
        if (Math.abs(c) <= SNAP_SIN) {
            normal.sub(up.clone().mulScalar(c)).normalize();
            kind = 'vertical';
        } else if (Math.abs(c) >= SNAP_COS) {
            normal = up.clone();
            kind = 'horizontal';
        }
        const bInPlane = B.clone().sub(normal.clone().mulScalar(new Vec3().sub2(B, A).dot(normal)));
        const along = new Vec3().sub2(bInPlane, A);
        const length = along.length();
        if (length < MIN_LENGTH) return null;
        along.mulScalar(1 / length);

        // Axes du profil ; A à gauche, B à droite.
        const toCamera = new Vec3().sub2(this.global.camera.getPosition(), A);
        let x: Vec3, y: Vec3;
        if (kind === 'vertical') {
            y = up.clone();
            x = new Vec3().cross(y, normal);
            const h = along.dot(x);
            // A et B l'un au-dessus de l'autre : vu depuis la caméra.
            if (Math.abs(h) > 0.05 ? h < 0 : normal.dot(toCamera) < 0) {
                normal.mulScalar(-1);
                x.mulScalar(-1);
            }
        } else {
            x = along.clone();
            y = new Vec3().cross(normal, x);
            // Incliné : le haut du profil vers le haut ; horizontal (le long
            // d'un mur) : vers l'observateur.
            if (kind === 'inclined' ? y.dot(up) < 0 : y.dot(toCamera) < 0) {
                normal.mulScalar(-1);
                y.mulScalar(-1);
            }
        }
        const across = new Vec3().cross(normal, along);

        // Normale de la surface sous A (sous B) ramenée dans le plan de coupe.
        const snapDir = (n: Vec3 | null) => {
            if (!n) return null;
            const p = n.clone().sub(normal.clone().mulScalar(n.dot(normal)));
            return p.length() >= 0.5 ? p.normalize() : null;
        };

        return {
            key,
            mode: 'points',
            origin: A.clone(),
            normal,
            along,
            across,
            x,
            y,
            kind,
            tilt: Math.acos(Math.min(1, Math.abs(normal.dot(up)))),
            ends: { length, bInPlane, snapA: snapDir(nA), snapB: snapDir(nB), facing }
        };
    }

    // Splats de la tranche, points isolés écartés ; entre deux points, A et
    // B recalés.
    private slice(frame: Frame, info: SplatCenters): Section | null {
        const { centers, numSplats, worldMatrix: m } = info;
        const O = frame.origin, N = frame.normal, U = frame.along, W = frame.across, X = frame.x, Y = frame.y;
        const ends = frame.ends;
        // Axes de la coupe dans le repère local du modèle (voir localAxis)
        const Ol = toLocal(m, O).point;
        const Nl = localAxis(m, N), Ul = localAxis(m, U), Wl = localAxis(m, W), Xl = localAxis(m, X), Yl = localAxis(m, Y);
        const half = this.thickness / 2;

        // Entre deux points : bande de A à B, et en travers (voir ACROSS_LIMIT_*).
        let uLo = -Infinity, uHi = Infinity, limit = Infinity;
        if (ends) {
            const margin = Math.min(STRIP_MARGIN_MAX, Math.max(STRIP_MARGIN_MIN, ends.length * STRIP_MARGIN_RATIO));
            uLo = -margin;
            uHi = ends.length + margin;
            if (!(frame.kind === 'vertical' && Math.abs(U.dot(this.up)) < Math.SQRT1_2)) {
                limit = Math.max(ACROSS_LIMIT_MIN, ends.length * ACROSS_LIMIT_RATIO);
            }
        }
        // Recalage de A et de B : direction et perpendiculaire dans le plan,
        // en local, et leur valeur au point recalé (A, ou B ramené sur le plan).
        const snaps = ends ? [ends.snapA, ends.snapB].map((dir, k) => {
            if (!dir) return null;
            const perp = new Vec3().cross(N, dir);
            const offset = k === 0 ? new Vec3() : new Vec3().sub2(ends.bInPlane, O);
            return { dir: localAxis(m, dir), perp: localAxis(m, perp), q0: offset.dot(dir), r0: offset.dot(perp) };
        }) : [null, null];

        const st: number[] = [];
        const dist: number[] = [];
        // Écarts candidats au recalage de A et de B, fenêtre étroite et large
        const near: number[][] = [[], [], [], []];
        for (let i = 0; i < numSplats; i++) {
            const ex = centers[i * 3] - Ol.x, ey = centers[i * 3 + 1] - Ol.y, ez = centers[i * 3 + 2] - Ol.z;
            const d = ex * Nl.x + ey * Nl.y + ez * Nl.z;
            if (d > half || d < -half) continue;
            if (ends) {
                const u = ex * Ul.x + ey * Ul.y + ez * Ul.z;
                if (u < uLo || u > uHi) continue;
                const w = ex * Wl.x + ey * Wl.y + ez * Wl.z;
                if (w > limit || w < -limit) continue;
            }
            st.push(ex * Xl.x + ey * Xl.y + ez * Xl.z, ex * Yl.x + ey * Yl.y + ez * Yl.z);
            dist.push(d);
            for (let k = 0; k < 2; k++) {
                const snap = snaps[k];
                if (!snap) continue;
                const q = ex * snap.dir.x + ey * snap.dir.y + ez * snap.dir.z - snap.q0;
                if (q > SNAP_ACROSS || q < -SNAP_ACROSS) continue;
                const r = Math.abs(ex * snap.perp.x + ey * snap.perp.y + ez * snap.perp.z - snap.r0);
                if (r <= SNAP_ALONG) near[k].push(q);
                if (r <= SNAP_ALONG_WIDE) near[k + 2].push(q);
            }
        }
        let count = st.length / 2;
        if (count === 0) return null;

        let points = Float32Array.from(st);
        let depth = Float32Array.from(dist);
        let isolated = 0;
        if (this.filterIsolated) {
            const keep = keepDenseProfilePoints(points, count);
            const kept = new Float32Array(points.length);
            const keptDepth = new Float32Array(count);
            let n = 0;
            for (let i = 0; i < count; i++) {
                if (!keep[i]) continue;
                kept[n * 2] = points[i * 2];
                kept[n * 2 + 1] = points[i * 2 + 1];
                keptDepth[n] = depth[i];
                n++;
            }
            isolated = count - n;
            count = n;
            points = kept.subarray(0, n * 2);
            depth = keptDepth.subarray(0, n);
            if (count === 0) return null;
        }

        const toProfile = (p: Vec3): ProfilePoint => {
            const d = new Vec3().sub2(p, O);
            return { s: d.dot(X), t: d.dot(Y) };
        };

        // Entre deux points : A et B recalés sur la couche de splats la plus
        // dense sous eux.
        let sectionEnds: Section['ends'] = null;
        if (ends) {
            const qA = ends.snapA ? densestLayer(near[0]) ?? densestLayer(near[2]) : null;
            const qB = ends.snapB ? densestLayer(near[1]) ?? densestLayer(near[3]) : null;
            const a3 = O.clone();
            if (qA !== null) a3.add(ends.snapA.clone().mulScalar(qA));
            const b3 = ends.bInPlane.clone();
            if (qB !== null) b3.add(ends.snapB.clone().mulScalar(qB));
            sectionEnds = { a3, b3, a: toProfile(a3), b: toProfile(b3), snapped: qA !== null || qB !== null };
        }

        // Étendue de la tranche selon along et across, et vue de départ.
        const xu = X.dot(U), yu = Y.dot(U), xw = X.dot(W), yw = Y.dot(W);
        const us: number[] = [], ws: number[] = [];
        let uMin = Infinity, uMax = -Infinity, wMin = Infinity, wMax = -Infinity;
        for (let i = 0; i < count; i++) {
            const s = points[i * 2], t = points[i * 2 + 1];
            const u = xu * s + yu * t, w = xw * s + yw * t;
            if (u < uMin) uMin = u;
            if (u > uMax) uMax = u;
            if (w < wMin) wMin = w;
            if (w > wMax) wMax = w;
            us.push(u);
            ws.push(w);
        }
        if (ends) {
            uMin = uLo;
            uMax = uHi;
        }
        // Coins de la vue de départ, dans le repère (along, across)
        const u0 = ends ? uLo : Math.min(quantile(us, FIT_PERCENTILE), 0);
        const u1 = ends ? uHi : Math.max(quantile(us, 1 - FIT_PERCENTILE), 0);
        let w0 = Math.min(quantile(ws, FIT_PERCENTILE), 0), w1 = Math.max(quantile(ws, 1 - FIT_PERCENTILE), 0);
        if (sectionEnds) {
            const wA = new Vec3().sub2(sectionEnds.a3, O).dot(W), wB = new Vec3().sub2(sectionEnds.b3, O).dot(W);
            w0 = Math.min(w0, wA, wB);
            w1 = Math.max(w1, wA, wB);
        }
        const fit = { s0: Infinity, s1: -Infinity, t0: Infinity, t1: -Infinity };
        for (const u of [u0, u1]) {
            for (const w of [w0, w1]) {
                const p = toProfile(O.clone().add(U.clone().mulScalar(u)).add(W.clone().mulScalar(w)));
                fit.s0 = Math.min(fit.s0, p.s);
                fit.s1 = Math.max(fit.s1, p.s);
                fit.t0 = Math.min(fit.t0, p.t);
                fit.t1 = Math.max(fit.t1, p.t);
            }
        }
        const padS = ends ? 0 : Math.max(0.05, (fit.s1 - fit.s0) * 0.04);
        const padT = Math.max(0.02, (fit.t1 - fit.t0) * 0.06);
        fit.s0 -= padS;
        fit.s1 += padS;
        fit.t0 -= padT;
        fit.t1 += padT;

        return { frame, thickness: this.thickness, uMin, uMax, wMin, wMax, points, depth, count, isolated, ends: sectionEnds, fit };
    }

    private dimensions(section: Section): Dimensions | null {
        const ends = section.ends;
        if (!ends) return null;
        return this.between(ends.a3, ends.b3);
    }

    private between(a: Vec3, b: Vec3): Dimensions {
        const d = new Vec3().sub2(b, a);
        const rise = d.dot(this.up);
        const length = d.length();
        return { length, rise, horizontal: Math.sqrt(Math.max(0, length * length - rise * rise)) };
    }

    // ── Règle sur le profil ──

    // Un profil seulement : une vue en plan n'a ni dessus ni dessous.
    private ruleAvailable(): boolean {
        return this.mode !== 'horizontal';
    }

    // Portée de la règle : posée sur le profil, sinon de A à B ; aucune
    // pendant qu'on en pose une autre (Annuler fait revenir la précédente).
    private currentRuleSpan(): [ProfilePoint, ProfilePoint] | null {
        if (this.rulePicking) return null;
        if (this.ruleSpan) return this.ruleSpan;
        const ends = this.section?.ends;
        return this.mode === 'points' && ends ? [ends.a, ends.b] : null;
    }

    private updateRule() {
        this.rule = null;
        const section = this.section;
        const span = this.currentRuleSpan();
        if (!this.ruleOn || !this.ruleAvailable() || !section || !span) return;
        this.rule = computeRule(section.points, section.count, {
            span,
            side: this.ruleSide,
            length: this.ruleLength,
            tile: this.ruleTile
        }, section.depth);
    }

    private ruleOk(): RuleOk | null {
        return this.ruleOn && this.rule?.status === 'ok' ? this.rule : null;
    }

    // Nouvelle coupe : la portée posée sur l'ancien profil ne vaut plus ; en
    // coupe verticale, elle est à reposer.
    private resetRuleSpan() {
        this.ruleSpan = null;
        this.rulePickFirst = null;
        this.rulePicking = this.ruleOn && this.mode === 'vertical';
        this.rule = null;
    }

    // Pose de la portée : clic sur le profil (accroché au point le plus
    // proche). Le premier bout, puis le second ; la portée va de gauche à
    // droite (de bas en haut si elle est presque verticale).
    private pickRule = (p: ProfilePoint): boolean => {
        if (!this.rulePicking || !this.ruleOn) return false;
        const first = this.rulePickFirst;
        if (!first) {
            this.rulePickFirst = p;
        } else if (Math.hypot(p.s - first.s, p.t - first.t) > 1e-3) {
            const span: [ProfilePoint, ProfilePoint] = [first, p];
            const upright = spanIsUpright(span);
            if (upright ? p.t < first.t : p.s < first.s) span.reverse();
            this.ruleSpan = span;
            this.rulePickFirst = null;
            this.rulePicking = false;
            this.updateRule();
        }
        this.refreshRule();
        return true;
    };

    private startRulePick() {
        this.rulePicking = true;
        this.rulePickFirst = null;
        this.updateRule();
        this.refreshRule();
    }

    // Annule la pose : la portée d'avant (ou A B) revient.
    private cancelRulePick() {
        this.rulePicking = false;
        this.rulePickFirst = null;
        this.updateRule();
        this.refreshRule();
    }

    // Règle changée : profil, résultats, lecture, résumé et vue, sans
    // refaire la coupe ni reconstruire le profil (cadrage, survol).
    private refreshRule() {
        this.profileView?.setRule(this.profileRule());
        this.renderResults();
        this.updateReadout();
        if (this.summary) {
            this.summary.textContent = this.summaryText();
            this.summary.title = this.summary.textContent;
        }
        this.global.app.renderNextFrame = true;
    }

    // Règle à dessiner sur le profil.
    private profileRule(): ProfileRule | null {
        if (!this.ruleOn || !this.ruleAvailable()) return null;
        const span = this.currentRuleSpan();
        const rule = this.ruleOk();
        return {
            span,
            pending: this.rulePicking ? this.rulePickFirst : null,
            normal: rule?.normal ?? (span ? spanFrame(span, this.ruleSide)?.normal ?? null : null),
            line: rule ? {
                start: rule.start,
                end: rule.end,
                supports: rule.supports,
                gapRule: rule.gapRule,
                gapSurface: rule.gapSurface,
                label: tr('rule.tag', { value: formatGap(rule.gap) })
            } : null
        };
    }

    // Rapport portée / flèche : « L/650 ».
    private ruleRatio(rule: RuleOk): string {
        return rule.gap > 1e-5 ? `L/${formatCount(Math.round(rule.reach / rule.gap))}` : '—';
    }

    // Position de la flèche sur le profil : depuis A, ou abscisse du profil
    // (signée : le profil a son origine au point cliqué).
    private rulePosition(rule: RuleOk): string {
        const s = rule.gapSurface.s;
        return this.mode === 'points' ? tr('rule.position-from-a', { s: formatLength(s) }) : tr('rule.position-profile', { s: formatLength(s, true) });
    }

    // Côtés de la règle (1, puis −1), selon l'orientation de la portée :
    // dessus et dessous, ou gauche et droite pour un mur vu de profil.
    private ruleSideKeys(): [string, string] {
        const span = this.currentRuleSpan();
        return span && spanIsUpright(span) ? ['left', 'right'] : ['above', 'below'];
    }

    // Réglages et résultats de la règle (colonne de gauche).
    private renderRule(el: HTMLElement) {
        if (!this.ruleAvailable() || !this.section) return;
        const box = document.createElement('div');
        box.className = 'section-rule';
        const toggle = createSwitch(tr('rule.label'), this.ruleOn, (on) => {
            this.ruleOn = on;
            this.ruleSpan = null;
            this.rulePickFirst = null;
            this.rulePicking = on && this.mode === 'vertical';
            this.updateRule();
            this.refreshRule();
        });
        toggle.title = tr('rule.title');
        box.appendChild(toggle);
        el.appendChild(box);
        if (!this.ruleOn) return;

        // Portée : de A à B, ou posée sur le profil
        const buttons = document.createElement('div');
        buttons.className = 'section-buttons';
        const addButton = (caption: string, title: string, onClick: () => void, disabled = false) => {
            const button = document.createElement('button');
            button.className = 'tool-btn';
            button.disabled = disabled;
            button.textContent = caption;
            button.title = title;
            button.addEventListener('click', onClick);
            buttons.appendChild(button);
        };
        if (this.rulePicking) {
            addButton(tr('rule.pick-cancel'), tr('rule.pick-cancel-title'), () => this.cancelRulePick());
        } else {
            if (this.mode === 'points') {
                addButton(tr('rule.span-ab'), tr('rule.span-ab-title'), () => {
                    this.ruleSpan = null;
                    this.updateRule();
                    this.refreshRule();
                }, !this.ruleSpan);
            }
            addButton(tr(this.ruleSpan ? 'rule.span-repick' : 'rule.span-pick'), tr('rule.span-pick-title'), () => this.startRulePick());
        }
        const span = this.currentRuleSpan();
        const spanField = createField(span ? tr('rule.span-length', { length: formatLength(Math.hypot(span[1].s - span[0].s, span[1].t - span[0].t)) }) : tr('rule.span'), buttons);
        box.appendChild(spanField);

        const update = () => {
            this.updateRule();
            this.refreshRule();
        };
        box.appendChild(createField(tr('rule.length'), createSegmented(RULE_LENGTHS.map(length => ({
            value: length,
            label: length === 0 ? tr('rule.length-span') : formatRuleLength(length),
            title: length === 0 ? tr('rule.length-span-title') : tr('rule.length-title', { length: formatRuleLength(length) })
        })), this.ruleLength, (length) => {
            this.ruleLength = length;
            storeNumber(RULE_LENGTH_STORAGE_KEY, length);
            update();
        })));
        const [first, second] = this.ruleSideKeys();
        box.appendChild(createField(tr('rule.side'), createSegmented<1 | -1>([
            { value: 1, label: tr(`rule.side-${first}`), title: tr(`rule.side-${first}-title`) },
            { value: -1, label: tr(`rule.side-${second}`), title: tr(`rule.side-${second}-title`) }
        ], this.ruleSide, (side) => {
            this.ruleSide = side;
            storeText(RULE_SIDE_STORAGE_KEY, String(side));
            update();
        })));
        const tiles = createField(tr('rule.tiles'), createSegmented(WAVE_WIDTHS.map(width => ({
            value: width,
            label: width === 0 ? tr('rule.tiles-none') : formatNumber(width * 100, 0)
        })), this.ruleTile, (width) => {
            this.ruleTile = width;
            storeNumber(RULE_TILE_STORAGE_KEY, width);
            update();
        }));
        tiles.title = tr('rule.tiles-title');
        box.appendChild(tiles);

        // Résultats
        const results = document.createElement('div');
        results.className = 'section-rule-results';
        box.appendChild(results);
        if (this.rulePicking) {
            results.appendChild(createNote(tr(this.rulePickFirst ? 'rule.pick-second' : 'rule.pick-first')));
            return;
        }
        const rule = this.rule;
        if (!rule) return;
        if (rule.status !== 'ok') {
            results.appendChild(createNote(tr(`rule.status.${rule.status}`, {
                length: formatRuleLength(this.ruleLength),
                cell: formatLength(rule.cell),
                n: RULE_MIN_SAMPLES
            }), true));
            return;
        }
        results.appendChild(createRow(this.ruleLength > 0 ? tr('rule.gap-under', { length: formatRuleLength(this.ruleLength) }) : tr('rule.gap'), formatGap(rule.gap)));
        results.appendChild(createRow(tr('rule.position'), this.rulePosition(rule)));
        results.appendChild(createRow(tr('rule.reach'), formatLength(rule.reach)));
        results.appendChild(createRow(tr('rule.ratio'), this.ruleRatio(rule)));
        results.appendChild(createRow(tr('rule.noise-floor'), `≈ ${formatGap(rule.noiseFloor)}`));
        results.appendChild(createNote(tr('rule.how', {
            cell: formatLength(rule.cell),
            tiles: rule.tiles ? tr('rule.how-tiles', { width: formatLength(this.ruleTile) }) : ''
        })));
        if (this.ruleTile > 0 && !rule.tiles) results.appendChild(createNote(tr('rule.tiles-coarse', { cell: formatLength(rule.cell) }), true));
        if (rule.gap < rule.noiseFloor) results.appendChild(createNote(tr('rule.warn-noise', { value: formatGap(rule.noiseFloor) }), true));
    }

    // ── Masquage et surbrillance dans la vue ──

    // D'après la coupe posée (suit un glisser en direct) ou, entre deux
    // points, d'après la tranche calculée.
    private updateHighlight() {
        if (this.state !== 'done') {
            this.highlight.clear();
            return;
        }
        const half = this.thickness / 2;
        if (this.mode !== 'points') {
            const p = this.placement;
            const across = this.mode === 'vertical' ? this.up : new Vec3().cross(this.up, p.along);
            this.highlight.set(this.planeOrigin(), p.along, across, p.normal, 1e6, 1e6, half, this.mask);
            return;
        }
        const section = this.section;
        if (!section) {
            this.highlight.clear();
            return;
        }
        // Entre deux points, le profil a A à gauche : sa normale peut
        // s'éloigner de la caméra. On masque toujours le côté de la caméra.
        const obb = this.sliceBox(section);
        const normal = obb.axes[2].clone();
        if (normal.dot(new Vec3().sub2(this.global.camera.getPosition(), obb.center)) < 0) normal.mulScalar(-1);
        this.highlight.set(obb.center, obb.axes[0], obb.axes[1], normal, obb.half[0], obb.half[1] + 0.02, half, this.mask);
    }

    // ── Textes ──

    // Pente de a vers b, ou faux aplomb au-delà de 60°.
    private slopeRow(dim: Dimensions): [string, string] {
        const angle = Math.atan2(Math.abs(dim.rise), dim.horizontal);
        if (angle < SLOPE_MAX_ANGLE) {
            return [tr('slope'), this.slopeText(dim.rise, dim.horizontal)];
        }
        const mmPerM = dim.horizontal / Math.abs(dim.rise) * 1000;
        return [tr('plumb'), `${formatLength(dim.horizontal)} · ${formatNumber(mmPerM, mmPerM < 10 ? 1 : 0)} mm/m`];
    }

    // « +4,2 % (2,4°) »
    private slopeText(rise: number, run: number): string {
        const pct = run > 0 ? rise / run * 100 : 0;
        let sign = '';
        if (pct > 0) sign = '+';
        else if (pct < 0) sign = '−';
        const deg = Math.atan2(Math.abs(rise), run) * 180 / Math.PI;
        return `${sign}${formatNumber(Math.abs(pct), Math.abs(pct) < 10 ? 1 : 0)} % (${formatNumber(deg, 1)}°)`;
    }

    // « vertical », « incliné à 35° »
    private planeText(frame: Frame): string {
        if (frame.kind === 'vertical') return tr('plane.vertical');
        if (frame.kind === 'horizontal') return tr('plane.horizontal');
        return tr('plane.inclined', { angle: formatNumber(frame.tilt * 180 / Math.PI, 0) });
    }

    // Altitude dans le repère affiché : « H 254.123 m ».
    private heightText(p: Vec3): string {
        const coords = this.global.coords;
        return formatCoordsInline([coords.toDisplay(p)[2], 0, 0], undefined, [coords.axisNames[2]]);
    }

    // Matrice 3 × 3 du repère source (lignes) vers le moteur : directions
    // du repère source (Est, Nord) dans la scène.
    private sourceToWorld(): Mat4 | null {
        const coords = this.global.coords;
        if (typeof coords?.toSource !== 'function') return null;
        const cols = [new Vec3(1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, 0, 1)].map(v => coords.toSource(v));
        // Colonnes : image des axes du moteur dans le repère source
        const m = new Mat4().set([
            cols[0][0], cols[0][1], cols[0][2], 0,
            cols[1][0], cols[1][1], cols[1][2], 0,
            cols[2][0], cols[2][1], cols[2][2], 0,
            0, 0, 0, 1
        ]);
        return m.invert();
    }

    // Orientation d'une coupe verticale : angle (0 à 180°) de sa direction
    // avec l'axe Nord (Y) du repère source, compté vers l'Est.
    private azimuth(): number {
        const coords = this.global.coords;
        const along = this.placement.along;
        const d = typeof coords?.toSource === 'function' ? coords.toSource(along) : [along.x, -along.z, along.y];
        const deg = Math.atan2(d[0], d[1]) * 180 / Math.PI;
        return ((deg % 180) + 180) % 180;
    }

    // Tourne une coupe verticale vers l'angle donné ; le côté masqué reste
    // celui de la caméra.
    private setAzimuth(deg: number) {
        const toWorld = this.sourceToWorld();
        const rad = deg * Math.PI / 180;
        const source = new Vec3(Math.sin(rad), Math.cos(rad), 0);
        const world = toWorld ? toWorld.transformVector(source, new Vec3()) : new Vec3(source.x, source.z, -source.y);
        const along = horizontal(world, this.up);
        if (!along) return;
        this.setAlong(along);
        this.faceCamera();
    }

    // Normale (côté masqué) tournée vers la caméra.
    private faceCamera() {
        const p = this.placement;
        if (this.mode !== 'vertical') return;
        const toCamera = new Vec3().sub2(this.global.camera.getPosition(), this.planeOrigin());
        if (p.normal.dot(toCamera) < 0) {
            p.along.mulScalar(-1);
            p.normal.mulScalar(-1);
            p.offset = -p.offset;
        }
    }

    // Réglage d'orientation ou de position : poignées et vue en direct,
    // calcul au repos.
    private afterPlacementChange(newAxes: boolean) {
        if (newAxes) {
            // Nouvelle orientation : le point cliqué est ramené sur le plan.
            this.placement.anchor = this.planeOrigin();
            this.placement.offset = 0;
            this.newView();
        }
        this.resetGrip();
        this.placeHandles();
        this.updateHighlight();
        this.global.app.renderNextFrame = true;
        // Nouvelle orientation : le décalage revient à zéro, les réglages
        // sont redessinés une fois le calcul fait.
        this.scheduleRecompute(newAxes);
    }

    private lodText(): string | null {
        const lod = this.lod;
        if (!lod) return null;
        const { min, max, levels } = lod.usage;
        const used = min === max ? tr('lod.level', { level: min }) : tr('lod.levels', { min, max });
        const range = tr('lod.range', { levels: used, last: levels - 1 });
        if (lod.status === 'finest') return tr('lod.finest', { range });
        if (lod.status === 'finer') return tr('lod.finer', { range });
        return tr('lod.displayed', { range });
    }

    private lodWarning(): string | null {
        switch (this.lod?.status) {
            case 'loading': return tr('lod.warn-loading');
            case 'finer': return tr('lod.warn-finer');
            case 'too-large': return tr('lod.warn-too-large');
            case 'failed': return tr('lod.warn-failed');
            default: return null;
        }
    }

    // Le profil gradue-t-il des hauteurs ? (coupe verticale)
    private profileIsVertical(): boolean {
        return this.section?.frame.kind === 'vertical';
    }

    // Écart entre les deux points de la mesure : selon les deux axes du
    // profil, et en direct.
    private measureParts(m: ProfileMeasure): { ds: number; dt: number; length: number } | null {
        if (!m.p2) return null;
        const ds = m.p2.s - m.p1.s, dt = m.p2.t - m.p1.t;
        return { ds, dt, length: Math.hypot(ds, dt) };
    }

    private measureLabel = (m: ProfileMeasure): string => {
        const parts = this.measureParts(m);
        if (!parts) return '';
        return `↔ ${formatLength(Math.abs(parts.ds))} · ↕ ${formatLength(Math.abs(parts.dt))}`;
    };

    // Pente de la mesure, sur un profil en hauteur et jusqu'à 60°.
    private measureSlope(parts: { ds: number; dt: number }): string | null {
        if (!this.profileIsVertical() || Math.atan2(Math.abs(parts.dt), Math.abs(parts.ds)) >= SLOPE_MAX_ANGLE) return null;
        return this.slopeText(parts.ds >= 0 ? parts.dt : -parts.dt, Math.abs(parts.ds));
    }

    // Position lue sur le profil.
    private positionText(p: ProfilePoint): string {
        const frame = this.section.frame;
        const coords = this.global.coords;
        const world = framePoint(frame, p.s, p.t);
        if (frame.mode === 'horizontal') {
            const d = coords.toDisplay(world);
            return formatCoordsInline([d[0], d[1], 0], undefined, coords.axisNames.slice(0, 2));
        }
        const s = formatLength(p.s, frame.mode !== 'points');
        if (frame.kind === 'vertical') {
            return tr(frame.mode === 'points' ? 'readout.height-from-a' : 'readout.height', { s, height: this.heightText(world) });
        }
        return tr('readout.offset', { s, offset: formatLength(p.t, true) });
    }

    // Résumé d'une ligne dans l'en-tête du panneau.
    private summaryText(): string {
        const section = this.section;
        if (!section) return tr(`failure.${this.failure ?? 'no-points'}`);
        const parts: string[] = [];
        if (this.mode === 'vertical') {
            parts.push(tr('summary-line.vertical', { angle: formatNumber(this.azimuth(), 0) }));
        } else if (this.mode === 'horizontal') {
            const p = this.placement;
            parts.push(p.floor ?
                tr('summary-line.horizontal-floor', { height: formatLength(p.offset), level: this.heightText(this.planeOrigin()) }) :
                tr('summary-line.horizontal', { level: this.heightText(this.planeOrigin()) }));
        } else {
            const dim = this.dimensions(section);
            const [slopeLabel, slopeValue] = this.slopeRow(dim);
            parts.push(tr('summary-line.points', { length: formatLength(dim.length), rise: formatLength(dim.rise, true), slope: `${slopeLabel.toLowerCase()} ${slopeValue}` }));
        }
        const rule = this.ruleOk();
        if (rule) parts.push(tr('summary-line.rule', { value: formatGap(rule.gap), ratio: this.ruleRatio(rule) }));
        parts.push(tr('summary-line.thickness', { value: formatLength(section.thickness) }));
        parts.push(tr('summary-line.points-count', { n: formatCount(section.count) }));
        if (this.lod?.status === 'loading') parts.push(tr('summary-line.lod-loading'));
        else if (this.lod?.status === 'too-large' || this.lod?.status === 'failed') parts.push(tr('summary-line.lod-displayed'));
        return parts.join(' · ');
    }

    // ── Panneau, en bas de l'écran ──
    //
    // En-tête (titre, résumé, nouvelle coupe, agrandir, réduire) ; à gauche
    // les réglages et les résultats, à droite le profil, sa barre d'outils et
    // la lecture au survol ou la mesure.

    private showPanel() {
        const sideScroll = this.panel?.querySelector('.section-side')?.scrollTop ?? 0;
        this.removePanel();
        if (this.state !== 'done') return;

        this.panel = document.createElement('div');
        this.panel.id = 'sectionPanel';
        this.panel.className = 'tool-panel section-dock';
        this.panel.classList.toggle('collapsed', this.collapsed);
        this.panel.classList.toggle('large', this.large);
        this.panel.appendChild(this.createHeader());

        const body = document.createElement('div');
        body.className = 'tool-body section-body';
        const side = document.createElement('div');
        side.className = 'section-side';
        side.appendChild(this.createSettings());
        this.results = document.createElement('div');
        this.results.className = 'section-results';
        side.appendChild(this.results);
        this.main = document.createElement('div');
        this.main.className = 'section-main';
        body.append(side, this.main);
        this.panel.appendChild(body);

        this.overlay.appendChild(this.panel);
        side.scrollTop = sideScroll;
        this.refreshResults();
    }

    // Résultats seuls : résumé, profil, cotes et informations. Les réglages
    // restent en place (un compteur peut être maintenu enfoncé).
    private refreshResults() {
        if (!this.panel) {
            if (this.state === 'done') this.showPanel();
            return;
        }
        this.summary.textContent = this.summaryText();
        this.summary.title = this.summary.textContent;

        // Profil
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.profileView?.destroy();
        this.profileView = null;
        this.readout = null;
        const main = this.main;
        main.textContent = '';
        const section = this.section;
        if (section) {
            const wrap = document.createElement('div');
            wrap.className = 'section-profile-wrap';
            this.profileView = new ProfileView(this.profileData(section), this.profileWindow, this.viewExaggeration(), this.measure, {
                onHover: (p) => {
                    this.hover = p;
                    this.updateReadout();
                    this.global.app.renderNextFrame = true;
                },
                onMeasure: (m) => {
                    this.measure = m;
                    this.updateReadout();
                    this.global.app.renderNextFrame = true;
                },
                onWindow: (w) => {
                    this.profileWindow = w;
                },
                measureLabel: this.measureLabel,
                onPick: this.pickRule
            });
            this.profileView.setRule(this.profileRule());
            wrap.appendChild(this.profileView.canvas);
            main.appendChild(wrap);
            main.appendChild(this.createProfileBar());
            this.readout = document.createElement('div');
            this.readout.className = 'section-readout';
            main.appendChild(this.readout);
            this.updateReadout();

            const fitSize = () => {
                if (wrap.clientWidth > 0 && wrap.clientHeight > 0) this.profileView?.resize(wrap.clientWidth, wrap.clientHeight);
            };
            fitSize();
            this.resizeObserver = new ResizeObserver(fitSize);
            this.resizeObserver.observe(wrap);
        } else {
            main.appendChild(createNote(tr(`failure.${this.failure ?? 'no-points'}-help`), true));
        }

        this.renderResults();
    }

    private removePanel() {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        this.profileView?.destroy();
        this.profileView = null;
        this.readout = null;
        this.summary = null;
        this.main = null;
        this.results = null;
        if (this.panel) {
            this.panel.remove();
            this.panel = null;
        }
        // Le profil disparaît sans « pointerleave » : le survol ne doit pas
        // rester affiché dans la vue.
        this.hover = null;
    }

    // Exagération : pour un profil en hauteur seulement (pas pour un plan).
    private viewExaggeration(): number {
        return this.mode === 'horizontal' ? 1 : this.exaggeration;
    }

    private profileData(section: Section): ProfileData {
        const frame = section.frame;
        const coords = this.global.coords;
        const vertical = frame.kind === 'vertical';
        let tTitle = tr('axis.offset');
        if (vertical) tTitle = tr('axis.height', { axis: coords.axisNames[2] });
        else if (frame.mode === 'horizontal') tTitle = tr('axis.depth');
        return {
            points: section.points,
            count: section.count,
            markers: section.ends ? {
                a: section.ends.a,
                b: section.ends.b,
                dir: { s: frame.along.dot(frame.x), t: frame.along.dot(frame.y) }
            } : undefined,
            tOffset: vertical ? coords.toDisplay(frame.origin)[2] : 0,
            sTitle: tr(frame.mode === 'points' ? 'axis.distance-from-a' : 'axis.distance'),
            tTitle,
            fit: section.fit
        };
    }

    private createHeader(): HTMLDivElement {
        const header = document.createElement('div');
        header.className = 'tool-header';

        const title = document.createElement('div');
        title.className = 'tool-title';
        title.textContent = tr('title');

        this.summary = document.createElement('span');
        this.summary.className = 'section-summary';

        const actions = document.createElement('div');
        actions.className = 'tool-header-actions';

        const reset = document.createElement('button');
        reset.className = 'tool-btn';
        reset.textContent = tr('new');
        reset.addEventListener('click', () => this.clearAll());

        // Profil agrandi : le panneau prend presque toute la hauteur.
        const large = document.createElement('button');
        large.className = 'tool-icon-btn';
        large.title = tr(this.large ? 'shrink' : 'enlarge');
        large.setAttribute('aria-label', large.title);
        large.setAttribute('aria-pressed', String(this.large));
        large.innerHTML = this.large ?
            '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6h4V2M14 10h-4v4M6 6L2 2M10 10l4 4"/></svg>' :
            '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2h4v4M6 14H2v-4M14 2l-5 5M2 14l5-5"/></svg>';
        large.addEventListener('click', () => {
            this.large = !this.large;
            storeText(LARGE_STORAGE_KEY, this.large ? '1' : '0');
            this.showPanel();
        });

        const collapse = createCollapseButton(this.collapsed, (collapsed) => {
            this.collapsed = collapsed;
            storeText(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
            this.panel?.classList.toggle('collapsed', collapsed);
        });

        actions.append(reset, large, collapse);
        header.append(title, this.summary, actions);
        return header;
    }

    // Réglages de la coupe (colonne de gauche).
    private createSettings(): HTMLDivElement {
        const box = document.createElement('div');

        box.appendChild(createField(tr('mode.label'), createSegmented(
            SECTION_MODES.map(m => ({ value: m, label: tr(`mode.${m}`), title: tr(`mode.${m}-title`) })),
            this.mode,
            mode => this.setMode(mode)
        )));

        const p = this.placement;
        if (this.mode !== 'points') {
            // Orientation : de la coupe (verticale) ou de la vue en plan
            // (horizontale, la coupe ne change pas).
            const vertical = this.mode === 'vertical';
            const label = tr(vertical ? 'orientation.label' : 'orientation.plan-label');
            const orientation = createField(label, createStepper({
                value: Math.round(this.azimuth()),
                min: 0,
                max: 179,
                step: 1,
                unit: '°',
                label,
                onChange: (deg) => {
                    this.setAzimuth(deg);
                    this.afterPlacementChange(true);
                }
            }));
            orientation.title = tr(vertical ? 'orientation.title' : 'orientation.plan-title');
            const buttons = document.createElement('div');
            buttons.className = 'section-buttons';
            const addButton = (caption: string, title: string, onClick: () => void) => {
                const button = document.createElement('button');
                button.className = 'tool-btn';
                button.textContent = caption;
                button.title = title;
                button.addEventListener('click', onClick);
                buttons.appendChild(button);
            };
            addButton(tr('orientation.walls'), tr(vertical ? 'orientation.walls-title' : 'orientation.walls-plan-title'), () => {
                if (this.alignToWalls()) this.afterPlacementChange(true);
            });
            addButton(tr('orientation.turn'), tr(vertical ? 'orientation.turn-title' : 'orientation.turn-plan-title'), () => {
                this.rotateAlong(90);
                this.faceCamera();
                this.afterPlacementChange(true);
            });
            addButton(tr('orientation.face'), tr(vertical ? 'orientation.face-title' : 'orientation.face-plan-title'), () => {
                this.setAlong(screenRight(this.global.camera, this.up));
                this.faceCamera();
                this.afterPlacementChange(true);
            });
            if (vertical) addButton(tr('flip'), tr('flip-title'), () => this.flip());
            orientation.appendChild(buttons);
            box.appendChild(orientation);
        }

        if (this.mode !== 'points') {
            const floor = this.mode === 'horizontal' && p.floor;
            const key = floor ? 'position.floor' : `position.${this.mode}`;
            box.appendChild(createField(tr(key), createStepper({
                value: Math.round(p.offset * 100),
                min: floor ? 0 : -MAX_OFFSET_CM,
                max: floor ? MAX_CUT_HEIGHT_CM : MAX_OFFSET_CM,
                step: 1,
                unit: 'cm',
                label: tr(key),
                onChange: (cm) => {
                    p.offset = cm / 100;
                    if (floor) {
                        this.cutHeight = p.offset;
                        storeNumber(CUT_HEIGHT_STORAGE_KEY, this.cutHeight);
                    }
                    this.afterPlacementChange(false);
                }
            })));
        } else if (this.handles.length === 2) {
            const flip = document.createElement('button');
            flip.className = 'tool-btn block';
            flip.textContent = tr('swap');
            flip.title = tr('swap-note');
            flip.addEventListener('click', () => this.flip());
            box.appendChild(createField(tr('points.label'), flip));
        }

        const thickness = createField(tr('thickness.label'), createStepper({
            value: Math.round(this.thickness * 100),
            min: MIN_THICKNESS_CM,
            max: MAX_THICKNESS_CM,
            step: 1,
            unit: 'cm',
            label: tr('thickness.label'),
            onChange: (cm) => {
                this.thickness = cm / 100;
                storeNumber(THICKNESS_STORAGE_KEY, this.thickness);
                this.updateHighlight();
                this.global.app.renderNextFrame = true;
                this.scheduleRecompute();
            }
        }));
        thickness.title = tr('thickness.note');
        box.appendChild(thickness);

        const mask = createSwitch(tr(this.mode === 'horizontal' ? 'mask.above' : 'mask.front'), this.mask, (enabled) => {
            this.mask = enabled;
            storeText(MASK_STORAGE_KEY, enabled ? '1' : '0');
            this.updateHighlight();
            this.global.app.renderNextFrame = true;
        });
        mask.title = tr('mask.title');
        box.appendChild(mask);

        const filter = createSwitch(tr('filter.label'), this.filterIsolated, (enabled) => {
            this.filterIsolated = enabled;
            storeText(FILTER_STORAGE_KEY, enabled ? '1' : '0');
            this.scheduleRecompute();
        });
        filter.title = tr('filter.title');
        box.appendChild(filter);

        // Exports : image pour un rapport, dessin pour la CAO, tableau pour Excel.
        const exports = document.createElement('div');
        exports.className = 'section-export-buttons';
        const frame = this.global.coords.frameName;
        for (const [key, run] of [['png', () => this.exportPng()], ['dxf', () => this.exportDxf()], ['csv', () => this.exportCsv()]] as const) {
            const button = document.createElement('button');
            button.className = 'tool-btn';
            button.textContent = tr(`export.${key}`);
            button.title = tr(`export.${key}-note`, { frame });
            button.addEventListener('click', run);
            exports.appendChild(button);
        }
        const exportField = createField(tr('export.label'), exports);
        exportField.classList.add('section-export');
        box.appendChild(exportField);
        return box;
    }

    // Cotes (entre deux points), altitude de la coupe, informations.
    private renderResults() {
        const el = this.results;
        if (!el) return;
        el.textContent = '';
        const section = this.section;
        this.panel?.querySelectorAll<HTMLButtonElement>('.section-export button').forEach((button) => {
            button.disabled = !section;
        });
        if (!section) return;

        const dim = this.dimensions(section);
        if (dim) {
            el.appendChild(createRow(tr('length'), formatLength(dim.length)));
            el.appendChild(createRow(tr('horizontal'), formatLength(dim.horizontal)));
            el.appendChild(createRow(tr('rise'), formatLength(dim.rise, true)));
            const [slopeLabel, slopeValue] = this.slopeRow(dim);
            el.appendChild(createRow(slopeLabel, slopeValue));
            el.appendChild(createRow(tr('height-a'), this.heightText(section.ends.a3)));
            el.appendChild(createRow(tr('height-b'), this.heightText(section.ends.b3)));
            el.appendChild(createRow(tr('plane.label'), capitalize(this.planeText(section.frame))));
        } else if (this.mode === 'horizontal') {
            el.appendChild(createRow(tr('level'), this.heightText(this.planeOrigin())));
        }

        this.renderRule(el);

        const info = document.createElement('div');
        info.className = 'tool-info';
        const lines = [tr('info.points', { n: formatCount(section.count), thickness: formatLength(section.thickness) })];
        if (section.isolated > 0) lines.push(tr('info.isolated', { n: formatCount(section.isolated) }));
        if (section.ends?.snapped) lines.push(tr('info.snapped'));
        if (section.frame.ends?.facing) lines.push(tr('info.facing'));
        lines.push(tr('info.frame', { frame: this.global.coords.frameName }));
        const lod = this.lodText();
        if (lod) lines.push(tr('info.lod', { value: lod }));
        for (const line of lines) {
            const div = document.createElement('div');
            div.textContent = line;
            info.appendChild(div);
        }
        el.appendChild(info);

        const warning = this.lodWarning();
        if (warning) el.appendChild(createNote(warning, this.lod.status !== 'loading' && this.lod.status !== 'finer'));
    }

    // Sous le profil : zoom, tout voir, exagération verticale.
    private createProfileBar(): HTMLDivElement {
        const bar = document.createElement('div');
        bar.className = 'section-bar';

        const button = (text: string, title: string, onClick: () => void) => {
            const b = document.createElement('button');
            b.className = 'tool-btn';
            b.textContent = text;
            b.title = title;
            b.setAttribute('aria-label', title);
            b.addEventListener('click', onClick);
            return b;
        };
        const zoom = document.createElement('div');
        zoom.className = 'section-bar-group';
        zoom.append(
            button('−', tr('bar.zoom-out'), () => this.profileView?.zoom(1 / 1.5)),
            button('+', tr('bar.zoom-in'), () => this.profileView?.zoom(1.5)),
            button(tr('bar.fit'), tr('bar.fit-title'), () => this.profileView?.fit())
        );
        bar.appendChild(zoom);

        if (this.mode !== 'horizontal') {
            const exaggeration = document.createElement('div');
            exaggeration.className = 'section-bar-group';
            const label = document.createElement('span');
            label.className = 'section-bar-label';
            label.textContent = tr('bar.exaggeration');
            label.title = tr('bar.exaggeration-title');
            const makeSeg = (): HTMLDivElement => {
                const seg = createSegmented(EXAGGERATIONS.map(e => ({ value: e, label: `×${e}` })), this.exaggeration, (value) => {
                    this.exaggeration = value;
                    storeNumber(EXAGGERATION_STORAGE_KEY, value);
                    this.profileView?.setExaggeration(value);
                    seg.replaceWith(makeSeg());
                });
                seg.title = tr('bar.exaggeration-title');
                return seg;
            };
            exaggeration.append(label, makeSeg());
            bar.appendChild(exaggeration);
        }
        return bar;
    }

    // Ligne sous le profil : position survolée, mesure, ou mode d'emploi.
    private updateReadout() {
        const el = this.readout;
        if (!el || !this.section) return;
        el.textContent = '';
        const text = document.createElement('span');
        const m = this.measure;
        const parts = m && this.measureParts(m);
        if (this.rulePicking && this.ruleOn) {
            // Pose de la règle : la consigne, puis la position survolée
            const step = tr(this.rulePickFirst ? 'rule.pick-second' : 'rule.pick-first');
            text.textContent = this.hover ? `${step} · ${this.positionText(this.hover)}` : step;
            text.className = 'rule';
            el.appendChild(text);
            const cancel = document.createElement('button');
            cancel.className = 'tool-btn';
            cancel.textContent = tr('rule.pick-cancel');
            cancel.addEventListener('click', () => this.cancelRulePick());
            el.appendChild(cancel);
            return;
        }
        if (this.hover) {
            text.textContent = this.positionText(this.hover);
        } else if (parts) {
            const slope = this.measureSlope(parts);
            const values = {
                length: formatLength(parts.length),
                ds: formatLength(Math.abs(parts.ds)),
                dt: formatLength(Math.abs(parts.dt)),
                slope
            };
            text.textContent = tr(slope ? 'readout.measure-slope' : 'readout.measure', values);
            text.className = 'measure';
        } else if (m) {
            text.textContent = tr('readout.measure-next');
        } else {
            text.textContent = tr('readout.help');
        }
        el.appendChild(text);

        if (m) {
            const clear = document.createElement('button');
            clear.className = 'tool-btn';
            clear.textContent = tr('readout.clear');
            clear.addEventListener('click', () => {
                this.measure = null;
                this.profileView?.setMeasure(null);
                this.updateReadout();
                this.global.app.renderNextFrame = true;
            });
            el.appendChild(clear);
        }
    }

    // ── Export PNG ──

    // Résultats de l'image, par colonnes.
    private summarySections(): { title: string; rows: [string, string][] }[] {
        const section = this.section;
        const coords = this.global.coords;
        const point = (p: Vec3) => formatCoordsInline(coords.toDisplay(p), undefined, coords.axisNames);
        const out: { title: string; rows: [string, string][] }[] = [];

        const settings: [string, string][] = [[tr('mode.label'), tr(`mode.${this.mode}`)]];
        const dim = this.dimensions(section);
        if (dim) {
            out.push({
                title: tr('summary.dimensions'),
                rows: [
                    [tr('length'), formatLength(dim.length)],
                    [tr('horizontal'), formatLength(dim.horizontal)],
                    [tr('rise'), formatLength(dim.rise, true)],
                    this.slopeRow(dim)
                ]
            });
            out.push({
                title: tr('summary.points-title'),
                rows: [
                    [tr('summary.point-a'), point(section.ends.a3)],
                    [tr('summary.point-b'), point(section.ends.b3)]
                ]
            });
            settings.push([tr('plane.label'), capitalize(this.planeText(section.frame))]);
        } else if (this.mode === 'vertical') {
            settings.push([tr('orientation.label'), `${formatNumber(this.azimuth(), 0)}°`]);
            settings.push([tr('summary.through'), point(this.planeOrigin())]);
        } else {
            if (this.placement.floor) settings.push([tr('position.floor'), formatLength(this.placement.offset)]);
            settings.push([tr('level'), this.heightText(this.planeOrigin())]);
            settings.push([tr('orientation.plan-label'), `${formatNumber(this.azimuth(), 0)}°`]);
        }
        settings.push(
            [tr('thickness.label'), formatLength(section.thickness)],
            [tr('summary.points'), formatCount(section.count)],
            [tr('summary.isolated'), this.filterIsolated ? formatCount(section.isolated) : tr('summary.filter-off')]
        );
        const lod = this.lodText();
        if (lod) settings.push([tr('summary.lod'), lod]);
        out.push({ title: tr('summary.settings'), rows: settings });

        const parts = this.measure && this.measureParts(this.measure);
        if (parts) {
            const rows: [string, string][] = [
                [tr('summary.measure-length'), formatLength(parts.length)],
                [tr('summary.measure-ds'), formatLength(Math.abs(parts.ds))],
                [tr('summary.measure-dt'), formatLength(Math.abs(parts.dt))]
            ];
            const slope = this.measureSlope(parts);
            if (slope) rows.push([tr('slope'), slope]);
            out.push({ title: tr('summary.measure'), rows });
        }

        const rule = this.ruleOk();
        if (rule) {
            const [first, second] = this.ruleSideKeys();
            out.push({
                title: tr('summary.rule'),
                rows: [
                    [this.ruleLength > 0 ? tr('rule.gap-under', { length: formatRuleLength(this.ruleLength) }) : tr('rule.gap'), formatGap(rule.gap)],
                    [tr('rule.position'), this.rulePosition(rule)],
                    [tr('rule.reach'), formatLength(rule.reach)],
                    [tr('rule.ratio'), this.ruleRatio(rule)],
                    [tr('rule.noise-floor'), `≈ ${formatGap(rule.noiseFloor)}`],
                    [tr('rule.length'), this.ruleLength > 0 ? formatRuleLength(this.ruleLength) : tr('rule.length-span')],
                    [tr('rule.side'), tr(`rule.side-${this.ruleSide > 0 ? first : second}`)],
                    [tr('summary.rule-tiles'), rule.tiles ? formatLength(this.ruleTile) : tr('rule.tiles-none')]
                ]
            });
        }
        return out;
    }

    // Image de rapport : le profil tel qu'il est cadré dans le panneau, plus
    // grand, avec graduations, échelle, cotes, date, projet et repère.
    private exportPng() {
        const section = this.section;
        const view = this.profileView;
        const win = view?.getWindow();
        if (!section || !view || !win) return;

        const size = view.getSize();
        const margin = 40, width = 1600;
        const plotW = width - margin * 2;
        const scale = plotW / size.width;
        const plotH = Math.round(Math.min(900, Math.max(420, size.height * scale)));
        const theme = { ...LIGHT_THEME, scale: Math.max(1.4, Math.min(2, scale * 0.6)) };
        const exportWindow: ProfileWindow = { cs: win.cs, ct: win.ct, k: win.k * scale };
        const exaggeration = this.viewExaggeration();
        const font = (px: number, weight = 400) => `${weight} ${px}px ${theme.font}`;

        const sections = this.summarySections();
        const columns = Math.min(3, sections.length);
        const colGap = 40;
        const colW = (plotW - colGap * (columns - 1)) / columns;
        const top = margin + 76;
        const legendY = top + plotH + 16;

        // Légende sous le profil, puis les résultats
        const notes = [tr('png.slice', { thickness: formatLength(section.thickness), plane: this.planeText(section.frame) })];
        if (this.mode === 'horizontal') notes.push(tr('png.plan', { angle: formatNumber(this.azimuth(), 0) }));
        else notes.push(exaggeration > 1 ? tr('png.exaggeration', { n: exaggeration }) : tr('png.no-exaggeration'));
        const rule = this.ruleOk();
        if (rule) {
            notes.push(tr('png.rule'));
            if (rule.gap < rule.noiseFloor) notes.push(tr('rule.warn-noise', { value: formatGap(rule.noiseFloor) }));
        }
        const tableY = legendY + 24 + Math.max(2, notes.length) * 20;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // Colonnes de résultats ; une valeur trop longue passe à la ligne.
        const drawTable = (draw: boolean) => {
            const bottoms: number[] = new Array(columns).fill(tableY);
            sections.forEach((sec, i) => {
                const col = i % columns;
                const x = margin + col * (colW + colGap);
                let y = bottoms[col] + (i >= columns ? 16 : 0);
                if (draw) {
                    ctx.font = font(13, 700);
                    ctx.fillStyle = '#71717a';
                    ctx.textAlign = 'left';
                    ctx.fillText(sec.title.toUpperCase(), x, y + 14);
                    ctx.fillStyle = '#e4e4e7';
                    ctx.fillRect(x, y + 22, colW, 1);
                }
                y += 34;
                for (const [label, value] of sec.rows) {
                    ctx.font = font(15);
                    const labelW = ctx.measureText(label).width;
                    ctx.font = font(15, 600);
                    const wrap = labelW + ctx.measureText(value).width + 16 > colW;
                    if (draw) {
                        ctx.font = font(15);
                        ctx.fillStyle = '#52525b';
                        ctx.textAlign = 'left';
                        ctx.fillText(label, x, y + 16);
                        ctx.font = font(15, 600);
                        ctx.fillStyle = '#18181b';
                        ctx.textAlign = 'right';
                        ctx.fillText(value, x + colW, y + 16 + (wrap ? 20 : 0));
                    }
                    y += 24 + (wrap ? 20 : 0);
                }
                bottoms[col] = y;
            });
            return Math.max(...bottoms);
        };

        canvas.width = width;
        canvas.height = drawTable(false) + margin;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // En-tête
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#18181b';
        ctx.font = font(26, 700);
        ctx.fillText(tr(`png.title-${this.mode}`, { scene: sceneName() }), margin, margin + 26);
        ctx.fillStyle = '#71717a';
        ctx.font = font(15);
        ctx.fillText(`${new Date().toLocaleString(getLocale(), { dateStyle: 'long', timeStyle: 'short' })} · ${this.global.coords.frameName}`, margin, margin + 52);

        // Profil
        const plot = document.createElement('canvas');
        plot.width = plotW;
        plot.height = plotH;
        paintProfile(plot.getContext('2d'), this.profileData(section), {
            width: plotW,
            height: plotH,
            dpr: 1,
            window: exportWindow,
            exaggeration,
            theme,
            measure: this.measure,
            measureLabel: this.measureLabel,
            rule: this.ruleOk() ? { ...this.profileRule(), pending: null } : null
        });
        ctx.drawImage(plot, margin, top);
        ctx.strokeStyle = '#d4d4d8';
        ctx.lineWidth = 1;
        ctx.strokeRect(margin + 0.5, top + 0.5, plotW - 1, plotH - 1);

        // Légende et échelle graphique sous le profil
        ctx.font = font(13);
        ctx.fillStyle = '#52525b';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        notes.forEach((note, i) => ctx.fillText(note, margin, legendY + 16 + i * 20));

        const map = profileToScreen({ width: plotW, height: plotH, window: exportWindow, exaggeration, theme });
        const length = scaleBarLength(exportWindow.k, plotW * 0.25);
        const px = length * exportWindow.k;
        const sx = margin + map.plot.x1 - px, sy = legendY + 14;
        ctx.strokeStyle = '#18181b';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx, sy - 5);
        ctx.lineTo(sx, sy);
        ctx.lineTo(sx + px, sy);
        ctx.lineTo(sx + px, sy - 5);
        ctx.stroke();
        ctx.fillStyle = '#18181b';
        ctx.textAlign = 'center';
        ctx.fillText(formatLength(length), sx + px / 2, sy + 18);

        drawTable(true);

        canvas.toBlob((blob) => {
            if (blob) downloadBlob(blob, `${exportBaseName(tr('export.file'))}.png`);
        }, 'image/png');
    }

    // ── Exports DXF et CSV ──

    // Repère du dessin DXF : profil en hauteur (plan vertical), vue en plan
    // (plan horizontal) ou plan incliné.
    private drawingKind(frame: Frame): DrawingKind {
        if (frame.kind === 'vertical') return 'profile';
        return frame.kind === 'horizontal' ? 'plan' : 'plane';
    }

    // Point du profil dans le repère du dessin. Profil en hauteur : X =
    // distance, Y = altitude affichée ; vue en plan : X Y Z du repère affiché
    // (coordonnées réelles d'une scène géoréférencée) ; plan incliné : X Y
    // du profil.
    private drawingPoint(frame: Frame, kind: DrawingKind, s: number, t: number): [number, number, number] {
        if (kind === 'plane') return [s, t, 0];
        const d = this.global.coords.toDisplay(framePoint(frame, s, t));
        return kind === 'plan' ? d : [s, d[2], 0];
    }

    // Dessin pour la CAO : points de la tranche, traits de coupe, cotes (A
    // et B, cotes de niveau, pente), mesure, cadre gradué et cartouche. Mise
    // en page : section-dxf.ts ; format : dxf.ts.
    private exportDxf() {
        const section = this.section;
        if (!section) return;
        const frame = section.frame;
        const kind = this.drawingKind(frame);
        const coords = this.global.coords;
        const at = (p: ProfilePoint): [number, number] => {
            const d = this.drawingPoint(frame, kind, p.s, p.t);
            return [d[0], d[1]];
        };

        const stride = Math.max(1, Math.ceil(section.count / DXF_MAX_POINTS));
        const count = Math.ceil(section.count / stride);
        const points = new Float64Array(count * 3);
        let sMin = Infinity, sMax = -Infinity;
        for (let k = 0; k < count; k++) {
            const i = k * stride;
            points.set(this.drawingPoint(frame, kind, section.points[i * 2], section.points[i * 2 + 1]), k * 3);
        }
        for (let i = 0; i < section.count; i++) {
            sMin = Math.min(sMin, section.points[i * 2]);
            sMax = Math.max(sMax, section.points[i * 2]);
        }

        const trace = traceSection(section.points, section.count);
        const lines = trace.lines.map((line) => {
            const out: number[] = [];
            for (let i = 0; i < line.points.length; i += 2) out.push(...at({ s: line.points[i], t: line.points[i + 1] }));
            return { points: out, closed: line.closed };
        });

        // A et B : cote de A à B ; en hauteur, ses composantes si AB est en
        // biais, les cotes de niveau et la pente.
        const dims: DrawingDimension[] = [];
        const notes: SectionDrawing['notes'] = [];
        let ends: SectionDrawing['ends'];
        const dim = this.dimensions(section);
        if (section.ends && dim) {
            const a = at(section.ends.a), b = at(section.ends.b);
            ends = { a, b };
            dims.push({ p1: a, p2: b, kind: 'aligned' });
            if (kind === 'profile') {
                ends.levels = [exportNumber(a[1], 3), exportNumber(b[1], 3)];
                if (Math.abs(dim.rise) > 0.02 * dim.length && dim.horizontal > 0.02 * dim.length) {
                    dims.push({ p1: a, p2: b, kind: 'horizontal' }, { p1: a, p2: b, kind: 'vertical' });
                }
                const [label, value] = this.slopeRow(dim);
                notes.push({ text: `${label} ${value}`, p1: a, p2: b });
            }
        }
        const parts = this.measure && this.measureParts(this.measure);
        if (parts) {
            // Cote de la mesure sous le segment mesuré (celle de AB est
            // au-dessus), pente au-dessus.
            const p1 = at(this.measure.p1), p2 = at(this.measure.p2);
            dims.push({ p1, p2, kind: 'aligned', layer: 'measure', side: -1 });
            if (kind !== 'plan' && Math.abs(parts.ds) > 0.05 * parts.length && Math.abs(parts.dt) > 0.05 * parts.length) {
                dims.push({ p1, p2, kind: 'horizontal', layer: 'measure' }, { p1, p2, kind: 'vertical', layer: 'measure' });
            }
            const slope = this.measureSlope(parts);
            if (slope) notes.push({ text: `${tr('slope')} ${slope}`, p1, p2, layer: 'measure', side: 1 });
        }

        // Règle la plus défavorable, sa flèche cotée, et ses résultats le long
        // de la règle (au-dessus).
        let drawingRule: DrawingRule | undefined;
        const rule = this.ruleOk();
        if (rule) {
            const start = at(rule.start), end = at(rule.end);
            drawingRule = {
                line: [start, end],
                supports: rule.supports.map(at),
                gap: [at(rule.gapRule), at(rule.gapSurface)],
                gapText: formatGap(rule.gap)
            };
            notes.push({
                text: tr('dxf.rule-note', { gap: formatGap(rule.gap), reach: formatLength(rule.reach), ratio: this.ruleRatio(rule) }),
                p1: start,
                p2: end,
                layer: 'rule',
                side: 1
            });
        }

        // Cartouche : les résultats de l'image PNG, puis le repère du dessin.
        const data = this.profileData(section);
        const axes = kind === 'plan' ?
            { x: `${coords.axisNames[0]} (m)`, y: `${coords.axisNames[1]} (m)` } :
            { x: data.sTitle, y: data.tTitle };
        const rows: [string, string][] = [];
        if (kind === 'profile') rows.push([tr('dxf.axes'), tr('dxf.axes-profile', { axis: coords.axisNames[2], frame: coords.frameName })]);
        else if (kind === 'plan') rows.push([tr('dxf.axes'), tr('dxf.axes-plan', { axes: coords.axisNames.join(', '), frame: coords.frameName })]);
        else rows.push([tr('dxf.axes'), tr('dxf.axes-plane')]);
        rows.push([tr('dxf.unit'), tr('dxf.meter')]);
        if (kind === 'profile') {
            const end = (s: number) => {
                const d = coords.toDisplay(framePoint(frame, s, 0));
                return formatCoordsInline([d[0], d[1], 0], undefined, coords.axisNames.slice(0, 2));
            };
            rows.push([tr('dxf.left-end', { s: exportNumber(sMin, 3) }), end(sMin)], [tr('dxf.right-end', { s: exportNumber(sMax, 3) }), end(sMax)]);
        }
        rows.push([tr('dxf.points'), stride > 1 ?
            tr('dxf.points-decimated', { n: formatCount(count), total: formatCount(section.count), step: stride }) :
            formatCount(count)]);
        rows.push([tr('dxf.lines'), tr('dxf.lines-value', { n: formatCount(lines.length), tolerance: formatLength(trace.tolerance) })]);

        const blob = sectionDxf({
            kind,
            points,
            count,
            lines,
            z: kind === 'plan' ? this.drawingPoint(frame, kind, 0, 0)[2] : 0,
            ends,
            dims,
            rule: drawingRule,
            notes,
            axes,
            north: kind === 'plan' ? coords.axisNames[1] : undefined,
            title: tr(`png.title-${this.mode}`, { scene: sceneName() }),
            subtitle: `${new Date().toLocaleString(getLocale(), { dateStyle: 'long', timeStyle: 'short' })} · ${coords.frameName}`,
            sections: [...this.summarySections(), { title: tr('dxf.drawing'), rows }].map(sec => ({
                title: sec.title,
                lines: sec.rows.map(([label, value]) => tr('dxf.row', { label, value }))
            })),
            layers: {
                points: tr('dxf.layer.points'),
                lines: tr('dxf.layer.lines'),
                dims: tr('dxf.layer.dims'),
                measure: tr('dxf.layer.measure'),
                rule: tr('dxf.layer.rule'),
                grid: tr('dxf.layer.grid'),
                title: tr('dxf.layer.title')
            },
            decimal: decimalSeparator()
        });
        downloadBlob(blob, `${exportBaseName(tr('export.file'))}.dxf`);
    }

    // Tableau pour Excel : une ligne par point de la coupe, dans l'ordre des
    // distances. Les deux coordonnées du profil (distance, puis altitude ou
    // écart), puis X Y Z dans le repère affiché ; avec une règle, l'écart à la
    // règle (mm, positif sous la règle) des points de la surface qu'elle
    // enjambe.
    private exportCsv() {
        const section = this.section;
        if (!section) return;
        const frame = section.frame;
        const coords = this.global.coords;
        const data = this.profileData(section);
        const vertical = frame.kind === 'vertical';
        const rows: string[][] = [[
            data.sTitle, data.tTitle,
            ...coords.axisNames.map(axis => tr('csv.axis', { axis, frame: coords.frameName }))
        ]];
        const decimal = decimalSeparator();
        const rule = this.ruleOk();
        let ruleGap: ((i: number) => string) | null = null;
        if (rule) {
            rows[0].push(tr('csv.rule'));
            // Repère de la règle : u le long (0 à len), n vers la surface (à
            // l'opposé du côté de la règle)
            const ds = rule.end.s - rule.start.s, dt = rule.end.t - rule.start.t;
            const len = Math.hypot(ds, dt) || 1;
            const us = ds / len, ut = dt / len;
            const flip = ut * rule.normal.s - us * rule.normal.t > 0 ? -1 : 1;
            const ns = ut * flip, nt = -us * flip;
            ruleGap = (i: number) => {
                if (!rule.used[i]) return '';
                // Point ramené sur le plan de coupe en suivant la surface (voir section-rule.ts)
                const shift = rule.crossSlope * section.depth[i];
                const ps = section.points[i * 2] - shift * rule.normal.s - rule.start.s;
                const pt = section.points[i * 2 + 1] - shift * rule.normal.t - rule.start.t;
                const u = ps * us + pt * ut;
                if (u < 0 || u > len) return '';
                return exportNumber((ps * ns + pt * nt) * 1000, 1, decimal);
            };
        }
        const pts = section.points;
        const num = (v: number) => exportNumber(v, 3, decimal);
        const order = Array.from({ length: section.count }, (_, i) => i)
        .sort((a, b) => pts[a * 2] - pts[b * 2] || pts[a * 2 + 1] - pts[b * 2 + 1]);
        const { origin: o, x: X, y: Y } = frame;
        const p = new Vec3();
        for (const i of order) {
            const s = pts[i * 2], t = pts[i * 2 + 1];
            const d = coords.toDisplay(p.set(o.x + X.x * s + Y.x * t, o.y + X.y * s + Y.y * t, o.z + X.z * s + Y.z * t));
            const row = [num(s), num(vertical ? d[2] : t), num(d[0]), num(d[1]), num(d[2])];
            if (ruleGap) row.push(ruleGap(i));
            rows.push(row);
        }
        downloadCsv(rows, `${exportBaseName(tr('export.file'))}.csv`);
    }

    // ── Tracé dans la vue 3D ──

    private render() {
        const canvas = this.drawCanvas;
        if (!canvas) return;

        const dpr = window.devicePixelRatio || 1;
        const width = window.innerWidth, height = window.innerHeight;
        if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
            canvas.width = width * dpr;
            canvas.height = height * dpr;
            canvas.style.width = `${width}px`;
            canvas.style.height = `${height}px`;
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (this.handles.length === 0) return;

        const camera = this.global.camera;
        const stale = this.pointerHandler.isDragging || !!this.recomputeTimer || this.geometryDirty;
        const section = this.section;
        if (section && !stale) this.drawPlane(ctx, section);

        if (this.mode === 'points') this.drawEnds(ctx);
        else this.drawHandles(ctx);

        const selected = this.pointerHandler.selectedIndex;
        if (this.state === 'done' && selected >= 0 && selected < this.handles.length) {
            this.pointerHandler.renderGizmo(ctx, camera, this.handles[selected]);
        }

        if (section && !stale) {
            this.drawRule(ctx, section);
            this.drawMeasure(ctx, section);
            this.drawHover(ctx, section);
        }
    }

    // Entre deux points : ligne AB (ou A → curseur pendant la pose de B), A et B.
    private drawEnds(ctx: CanvasRenderingContext2D) {
        const screen = this.handles.map(p => worldToScreen(this.global.camera, p));
        if (screen.every(s => !s.behind)) {
            ctx.strokeStyle = ACCENT_COLOR;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(screen[0].x, screen[0].y);
            if (screen.length > 1) {
                ctx.lineTo(screen[1].x, screen[1].y);
            } else {
                ctx.setLineDash([6, 4]);
                ctx.lineTo(this.pointerHandler.mouseX, this.pointerHandler.mouseY);
            }
            ctx.stroke();
            ctx.setLineDash([]);
        }
        screen.forEach((s, i) => {
            if (s.behind) return;
            const selected = this.state === 'done' && i === this.pointerHandler.selectedIndex;
            ctx.beginPath();
            ctx.arc(s.x, s.y, 9, 0, Math.PI * 2);
            ctx.fillStyle = selected ? '#ffffff' : ACCENT_COLOR;
            ctx.fill();
            ctx.strokeStyle = selected ? ACCENT_COLOR : '#ffffff';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = '#18181b';
            ctx.font = '700 11px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(i === 0 ? 'A' : 'B', s.x, s.y + 0.5);
        });
    }

    // Coupe posée : poignée du plan (déplacer) et, pour une verticale,
    // poignée de rotation au bout d'un trait pointillé.
    private drawHandles(ctx: CanvasRenderingContext2D) {
        const camera = this.global.camera;
        const screen = this.handles.map(p => worldToScreen(camera, p));
        const selected = this.pointerHandler.selectedIndex;
        if (screen.length === 2 && !screen[0].behind && !screen[1].behind) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(screen[0].x, screen[0].y);
            ctx.lineTo(screen[1].x, screen[1].y);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        screen.forEach((s, i) => {
            if (s.behind) return;
            const active = i === selected;
            const r = i === 0 ? 11 : 9;
            ctx.beginPath();
            ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
            ctx.fillStyle = active ? '#ffffff' : ACCENT_COLOR;
            ctx.fill();
            ctx.strokeStyle = active ? ACCENT_COLOR : '#ffffff';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.strokeStyle = '#18181b';
            ctx.fillStyle = '#18181b';
            ctx.lineWidth = 1.6;
            ctx.lineCap = 'round';
            ctx.beginPath();
            if (i === 0) {
                // Quatre flèches : déplacer
                for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const ex = s.x + dx * 6, ey = s.y + dy * 6;
                    ctx.moveTo(s.x, s.y);
                    ctx.lineTo(ex, ey);
                    ctx.moveTo(ex - dy * 2 - dx * 2, ey - dx * 2 - dy * 2);
                    ctx.lineTo(ex, ey);
                    ctx.lineTo(ex + dy * 2 - dx * 2, ey + dx * 2 - dy * 2);
                }
            } else {
                // Flèche en arc : tourner
                ctx.arc(s.x, s.y, 4.5, -Math.PI * 0.8, Math.PI * 0.6);
                const ax = s.x + 4.5 * Math.cos(Math.PI * 0.6), ay = s.y + 4.5 * Math.sin(Math.PI * 0.6);
                ctx.moveTo(ax - 3, ay);
                ctx.lineTo(ax, ay);
                ctx.lineTo(ax, ay - 3);
            }
            ctx.stroke();
            ctx.lineCap = 'butt';
        });
    }

    // Contour du plan de coupe, sur l'étendue des points retenus.
    private drawPlane(ctx: CanvasRenderingContext2D, section: Section) {
        const f = section.frame;
        const corner = (u: number, w: number) => worldToScreen(this.global.camera,
            f.origin.clone().add(f.along.clone().mulScalar(u)).add(f.across.clone().mulScalar(w)));
        const corners = [
            corner(section.uMin, section.wMin), corner(section.uMax, section.wMin),
            corner(section.uMax, section.wMax), corner(section.uMin, section.wMax)
        ];
        if (corners.some(c => c.behind)) return;
        ctx.beginPath();
        corners.forEach((c, i) => (i === 0 ? ctx.moveTo(c.x, c.y) : ctx.lineTo(c.x, c.y)));
        ctx.closePath();
        ctx.fillStyle = accentRgba(0.05);
        ctx.fill();
        ctx.strokeStyle = accentRgba(0.7);
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    private drawMeasure(ctx: CanvasRenderingContext2D, section: Section) {
        const m = this.measure;
        if (!m) return;
        const camera = this.global.camera;
        const p1 = worldToScreen(camera, framePoint(section.frame, m.p1.s, m.p1.t));
        if (p1.behind) return;
        ctx.fillStyle = DARK_THEME.measure;
        ctx.strokeStyle = DARK_THEME.measure;
        if (m.p2) {
            const p2 = worldToScreen(camera, framePoint(section.frame, m.p2.s, m.p2.t));
            if (p2.behind) return;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(p2.x, p2.y, 4, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(p1.x, p1.y, 4, 0, Math.PI * 2);
        ctx.fill();
    }

    // Règle la plus défavorable sur la coupe, ses appuis et sa flèche.
    private drawRule(ctx: CanvasRenderingContext2D, section: Section) {
        const rule = this.ruleOk();
        if (!rule) return;
        const camera = this.global.camera;
        const at = (p: ProfilePoint) => worldToScreen(camera, framePoint(section.frame, p.s, p.t));
        const a = at(rule.start), b = at(rule.end), gr = at(rule.gapRule), gs = at(rule.gapSurface);
        if (a.behind || b.behind || gr.behind || gs.behind) return;

        ctx.lineCap = 'round';
        for (const [color, width] of [['rgba(0, 0, 0, 0.8)', 5], [DARK_THEME.rule, 2.5]] as const) {
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
        }
        ctx.lineCap = 'butt';
        ctx.fillStyle = DARK_THEME.rule;
        for (const p of rule.supports) {
            const q = at(p);
            if (q.behind) continue;
            ctx.beginPath();
            ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(gr.x, gr.y);
        ctx.lineTo(gs.x, gs.y);
        ctx.stroke();

        const text = tr('rule.tag', { value: formatGap(rule.gap) });
        ctx.font = '13px Arial';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const width = ctx.measureText(text).width;
        const x = gr.x + 10, y = gr.y - 14;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.beginPath();
        ctx.roundRect(x - 6, y - 10, width + 12, 20, 4);
        ctx.fill();
        ctx.fillStyle = DARK_THEME.rule;
        ctx.fillText(text, x, y);
    }

    // Point survolé sur le profil, montré dans la vue.
    private drawHover(ctx: CanvasRenderingContext2D, section: Section) {
        const p = this.hover;
        if (!p) return;
        const s = worldToScreen(this.global.camera, framePoint(section.frame, p.s, p.t));
        if (s.behind) return;
        ctx.beginPath();
        ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
}

export { SectionTool };
