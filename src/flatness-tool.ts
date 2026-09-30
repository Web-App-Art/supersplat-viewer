import { Vec3 } from 'playcanvas';

import { coordsForClipboard, formatCoordsInline } from './coordinates';
import { getLocale } from './localization';
import { ToolPointerHandler } from './tool-pointer-handler';
import { worldToScreen, drawEdgeLabel, getSplatCenters, copyTable, ACCENT_COLOR, accentRgba } from './tool-utils';
import type { Global } from './types';

type FlatnessMeasureState = 'idle' | 'placing' | 'closed';

// Plan de référence des écarts : le plan moyen (planéité), un plan horizontal
// (niveau d'un sol) ou vertical (aplomb d'un mur).
type ReferenceMode = 'mean' | 'horizontal' | 'vertical';

// Grid cell data for heatmap
interface GridData {
    grid: (number | null)[][];  // signed deviation values per cell (null = no data)
    measured: boolean[][];      // true = valeur issue de splats, false = interpolée
    hatched: boolean[][];       // cases estimées montrées hachurées (hors trous d'une case)
    resX: number;
    resY: number;
}

// Position de la grille dans le repère (U, V) du plan : coin et taille des cases.
interface GridGeometry {
    uMin: number;
    vMin: number;
    du: number;
    dv: number;
}

interface FlatnessStats {
    hollow: number;      // écart le plus creux (m, ≤ 0)
    bump: number;        // écart le plus en bosse (m, ≥ 0)
    rms: number;         // écart type au plan (m)
    area: number;        // surface de la zone (m²)
    emptyPct: number;    // part de la zone sans points
    noise: number;       // dispersion typique des splats dans une case (m)
    spikeCells: number;  // cases isolées écartées
}

// Point dans le repère du plan : (u, v) sur le plan, h selon la normale.
interface PlanePoint {
    u: number;
    v: number;
    h: number;
}

interface RuleOk {
    status: 'ok';
    worst: number;              // flèche maximale (m)
    fleches: Float32Array;      // flèche de chaque position de la règle, triée
    cellSize: number;           // pas de la grille de la règle (m)
    noiseFloor: number;         // flèche que le bruit seul produirait (m)
    start: PlanePoint;          // règle la plus défavorable
    end: PlanePoint;
    gapSurface: PlanePoint;     // surface sous la flèche maximale
    gapRule: PlanePoint;        // règle au-dessus
}

type RuleResult = RuleOk | {
    status: 'zone-too-small' | 'cells-too-coarse' | 'no-data';
    cellSize: number;
};

// ARTLIGHT (TKT-236) : le plan de référence est ajusté sur le nuage et non plus
// sur les sommets cliqués. Le pointage donne une profondeur moyenne pondérée
// par l'opacité : sur une surface clairsemée (toiture), un sommet peut tomber
// sous la surface ou vers le fond, et un plan passant par les sommets penchait
// alors toute la carte. Les sommets ne servent plus qu'à délimiter la zone.

// Demi-épaisseur de recherche autour du plan des sommets : couvre l'erreur de
// pointage des sommets plus l'épaisseur analysée maximale.
const SEARCH_BAND = 0.6;

// RANSAC : tolérance d'appartenance au plan, taille de l'échantillon, tirages.
const RANSAC_TOL = 0.02;
const RANSAC_SAMPLE = 4000;
const RANSAC_ITERATIONS = 256;
// Écart d'orientation maximal toléré avec le plan des sommets : écarte un mur
// voisin ou une poutre qui entrerait dans la zone.
const RANSAC_MAX_TILT_COS = Math.cos(45 * Math.PI / 180);

// Affinage par moindres carrés : on garde les points à moins de 3 σ (σ estimé
// par la MAD), avec un plancher pour ne pas s'effondrer sur une surface lisse.
const REFINE_ITERATIONS = 5;
const REFINE_SIGMAS = 3;
const REFINE_MIN_TOL = 0.005;

// Demi-épaisseur analysée par défaut, réglable dans le panneau. Au-delà, un
// splat est compté comme hors surface (objet posé, charpente, végétation).
const DEFAULT_BAND = 0.15;
const MIN_BAND_CM = 2;
const MAX_BAND_CM = 50;

// Reflets : un sol vitrifié, un carrelage brillant ou une vitre sont souvent
// modélisés avec une couche de splats fantômes derrière la surface (le reflet
// vu comme une pièce en miroir). Sur l'appartement de Yannick, 54 000 splats
// entre 2 et 12 cm sous le parquet, gros et épais, contre des pastilles fines
// pour la vraie surface. On ne garde que la couche visible depuis
// l'observateur : par case d'environ 4 cm (30 splats), la première fenêtre de
// 2 cm qui contient 30 % des splats de la case en partant de l'observateur.
// Une case en retrait de ses voisines (5 × 5 cases), ou trop peu fournie,
// prend leur niveau. Les splats en retrait de plus de 1,5 cm (ou 3,5 σ de la
// couche) sont écartés. Sur 7 dalles de 1 m du parquet : écart type de 16-24
// à 1-2,5 mm, flèche sous 1 m de 64-177 à 8-16 mm. Sur une toiture en tuiles
// canal synthétique, le relief des tuiles est conservé (seuil calé ici).
const HIDDEN_CELL_MIN = 0.04;
const HIDDEN_CELL_POINTS = 30;
const HIDDEN_MIN_POINTS = 8;
const HIDDEN_LAYER_WINDOW = 0.02;
const HIDDEN_LAYER_SHARE = 0.3;
const HIDDEN_MIN_DEPTH = 0.015;
const HIDDEN_SIGMAS = 3.5;
const HIDDEN_NEIGHBOR_RADIUS = 2;

// Sens des écarts : + = bosse. Pour une pente de moins de 60° (sol, dalle,
// toiture), la bosse est vers le haut ; pour un mur, vers l'observateur.
const UP_MIN_COS = Math.cos(60 * Math.PI / 180);

// Plan de référence : « Horizontal » n'est proposé que si le plan moyen est à
// moins de 10° de l'horizontale (sol, dalle, chape), « Vertical » que s'il est
// à moins de 10° de la verticale (mur). Entre les deux (toiture, rampe), seul
// le plan moyen a un sens.
const REFERENCE_MAX_TILT = 10 * Math.PI / 180;

// Cases isolées : écart à la médiane des voisines de plus de 4 σ (1 cm au
// moins) et moins de 2 voisines qui le confirment. C'est typiquement un splat
// flottant seul dans sa case ; une bosse ou une marche réelle couvre plusieurs
// cases et reste.
const SPIKE_SIGMAS = 4;
const SPIKE_MIN = 0.01;
// Sur la grille de la règle, le seuil suit le bruit (3 mm au moins) : un point
// haut isolé soulevait la règle, un point bas isolé creusait une flèche.
const RULE_SPIKE_MIN = 0.003;

// Règle : longueurs proposées, directions testées (tous les 22,5°), nombre
// minimal de cases sous la règle et part de la règle qui doit porter sur des
// points mesurés.
// 0 = toute la zone : la règle couvre la zone d'un bord à l'autre (affaissement
// d'un pan de toiture, d'un plancher).
const RULE_LENGTHS = [0.2, 1, 2, 3, 5, 0];
const RULE_DIRECTIONS = 8;
const RULE_MIN_SAMPLES = 8;
const RULE_MIN_COVERAGE = 0.7;
// Grille propre à la règle : des cases de L/40 (5 cm pour 2 m), agrandies
// pour contenir 8 splats en moyenne (3 au moins par case). Le bruit d'une
// case baisse avec le nombre de splats ; la règle n'a pas besoin de la
// finesse de la carte.
const RULE_CELLS_PER_LENGTH = 40;
const RULE_POINTS_PER_CELL = 8;
const RULE_MIN_CELL_POINTS = 3;
const RULE_MAX_CELLS = 300000;
const DEFAULT_RULE_LENGTH = 2;
const DEFAULT_TOLERANCE = 0.005;
const RULE_LENGTH_STORAGE_KEY = 'artlight.flatness.rule';
const TAB_STORAGE_KEY = 'artlight.flatness.tab';
const COLLAPSED_STORAGE_KEY = 'artlight.flatness.collapsed';

type FlatnessTab = 'deviations' | 'rule' | 'settings' | 'export';
const FLATNESS_TABS: FlatnessTab[] = ['deviations', 'rule', 'settings', 'export'];
const TOLERANCE_STORAGE_KEY = 'artlight.flatness.tolerance';

// Flèche produite par le bruit seul, en multiple du bruit d'une case de la
// règle : 6,3 à 7,5 sur des dalles parfaitement planes (bruit de 0,5 à 10 mm).
// Une tolérance plus fine mesure surtout le bruit : on le signale.
const RULE_NOISE_FACTOR = 7;
// Taille des échantillons pour les estimations de dispersion.
const NOISE_SAMPLE = 10000;

// Lissage des tuiles : largeurs d'ondulation proposées (0 = pas de lissage).
// Régler sur la plus grande dimension visible de la tuile : sur une toiture
// en tuiles canal affaissée de 4 cm (synthétique), lisser sur 40 cm donne une
// flèche de 43,7 mm, sur 20 cm 48,9 mm (les recouvrements restent).
// Moyenne gaussienne d'écart type λ/2 : une ondulation de période λ est
// atténuée à moins de 1 % (exp(−2π²σ²/λ²)), une forme de plusieurs mètres
// presque pas.
const WAVE_WIDTHS = [0, 0.15, 0.2, 0.3, 0.4, 0.6];
const WAVE_SIGMA_RATIO = 0.5;
// En dessous d'un tiers de case, le lissage n'a pas d'effet : on s'en passe.
const WAVE_MIN_SIGMA_CELLS = 0.33;

// Échelle des couleurs : valeurs prédéfinies et bornes du curseur (log).
const SCALE_PRESETS = [0.005, 0.01, 0.02, 0.05, 0.10];
const SCALE_MIN = 0.002;
const SCALE_MAX = 0.30;

// Au-delà, le polygone se ferme de lui-même.
const MAX_POINTS = 16;

// Délai avant de relancer le calcul après le déplacement d'un sommet.
const RECOMPUTE_DELAY = 150;

interface Plane {
    origin: Vec3;
    normal: Vec3;
}

// Splat retenu, dans le repère du plan de référence : position (pu, pv),
// écart au plan. `fit` : écart au plan moyen, qui sert à trier les splats
// (épaisseur analysée, reflets) quel que soit le plan de référence.
interface KeptPoint {
    dist: number;
    pu: number;
    pv: number;
    fit: number;
}

// Orientation de la caméra au moment du calcul : la carte et le côté de
// l'observateur ne changent pas quand on tourne autour de la zone.
interface ViewSnapshot {
    position: Vec3;
    right: Vec3;
    up: Vec3;
    forward: Vec3;
}

// Générateur pseudo-aléatoire à graine fixe (mulberry32) : deux calculs sur la
// même zone donnent le même plan.
const createRandom = (seed: number) => {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
};

const median = (values: number[]) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Au plus `max` valeurs prises à pas régulier : assez pour une médiane ou une
// MAD, sans trier des centaines de milliers de valeurs.
const subsample = (values: number[], max: number) => {
    if (values.length <= max) return values;
    const stride = values.length / max;
    const out: number[] = [];
    for (let k = 0; k < max; k++) out.push(values[Math.floor(k * stride)]);
    return out;
};

// Longueur lisible : mm sous le centimètre, cm sous le mètre, virgule décimale.
const formatLength = (m: number, signed = false) => {
    const a = Math.abs(m);
    let text: string;
    if (a < 0.01) {
        text = `${(a * 1000).toFixed(1)} mm`;
    } else if (a < 1) {
        text = `${(a * 100).toFixed(1)} cm`;
    } else {
        text = `${a.toFixed(2)} m`;
    }
    let sign = '';
    if (m < 0) sign = '−';
    else if (signed && m > 0) sign = '+';
    return sign + text.replace('.', ',');
};

// Lissage gaussien d'une grille à trous (convolution normalisée, séparable) :
// chaque case mesurée devient la moyenne pondérée des cases mesurées voisines.
// sx, sy : écart type en cases. Les cases vides restent vides.
const smoothGrid = (grid: (number | null)[][], resX: number, resY: number, sx: number, sy: number): (number | null)[][] => {
    const kernel = (sigma: number) => {
        const r = Math.max(1, Math.ceil(3 * sigma));
        const k = new Float64Array(2 * r + 1);
        for (let d = -r; d <= r; d++) k[d + r] = Math.exp(-0.5 * (d / sigma) ** 2);
        return { k, r };
    };
    const kx = kernel(sx), ky = kernel(sy);
    const values = new Float64Array(resX * resY);
    const weights = new Float64Array(resX * resY);

    for (let j = 0; j < resY; j++) {
        for (let i = 0; i < resX; i++) {
            let sv = 0, sw = 0;
            for (let d = -kx.r; d <= kx.r; d++) {
                const v = grid[j][i + d];
                if (v === null || v === undefined) continue;
                const w = kx.k[d + kx.r];
                sv += w * v;
                sw += w;
            }
            values[j * resX + i] = sv;
            weights[j * resX + i] = sw;
        }
    }

    const out: (number | null)[][] = [];
    for (let j = 0; j < resY; j++) {
        const row: (number | null)[] = [];
        for (let i = 0; i < resX; i++) {
            if (grid[j][i] === null) {
                row.push(null);
                continue;
            }
            let sv = 0, sw = 0;
            for (let d = -ky.r; d <= ky.r; d++) {
                const jj = j + d;
                if (jj < 0 || jj >= resY) continue;
                const w = ky.k[d + ky.r];
                sv += w * values[jj * resX + i];
                sw += w * weights[jj * resX + i];
            }
            row.push(sw > 0 ? sv / sw : null);
        }
        out.push(row);
    }
    return out;
};

interface WindowResult {
    gap: number;    // plus grand jour entre deux appuis
    a: number;      // appui de gauche de l'arête qui le porte
    slope: number;  // pente de cette arête (par échantillon)
    iGap: number;   // échantillon du plus grand jour
}

// Règle posée sur le profil [i0, i1[ : elle repose sur l'enveloppe convexe
// supérieure (chaîne monotone) ; on garde le plus grand jour entre une arête
// et les points qu'elle enjambe.
const measureWindow = (profile: Float64Array, i0: number, i1: number, hull: Int32Array, out: WindowResult) => {
    let n = 0;
    for (let i = i0; i < i1; i++) {
        const y = profile[i];
        if (Number.isNaN(y)) continue;
        while (n >= 2) {
            const o = hull[n - 2], a = hull[n - 1];
            const cross = (a - o) * (y - profile[o]) - (profile[a] - profile[o]) * (i - o);
            if (cross < 0) break;
            n--;
        }
        hull[n++] = i;
    }

    out.gap = 0;
    out.a = hull[0];
    out.slope = 0;
    out.iGap = hull[0];
    for (let e = 0; e + 1 < n; e++) {
        const ia = hull[e], ib = hull[e + 1];
        if (ib - ia < 2) continue;
        const slope = (profile[ib] - profile[ia]) / (ib - ia);
        for (let i = ia + 1; i < ib; i++) {
            const y = profile[i];
            if (Number.isNaN(y)) continue;
            const g = profile[ia] + slope * (i - ia) - y;
            if (g > out.gap) {
                out.gap = g;
                out.a = ia;
                out.slope = slope;
                out.iGap = i;
            }
        }
    }
};

// Nom de la scène pour les exports : nom du projet, sinon dossier de l'URL.
const sceneName = (): string => {
    const projectName = (window as any).sse?.project?.project?.name;
    if (typeof projectName === 'string' && projectName) return projectName;
    const params = new URLSearchParams(location.search);
    for (const key of ['project', 'settings', 'content']) {
        const value = params.get(key);
        const parts = value?.split('/').filter(part => part && !part.includes('.')) ?? [];
        const folder = parts.filter(part => !/^lod-output/.test(part)).pop();
        if (folder) return folder;
    }
    return 'scene';
};

const slugify = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
.toLowerCase()
.replace(/[^a-z0-9]+/g, '-')
.replace(/^-|-$/g, '');

const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// Tolérance toujours en mm, comme dans le compteur : « 5 mm », « 12,5 mm ».
const formatTolerance = (m: number) => {
    const mm = Math.round(m * 10000) / 10;
    return `${(Number.isInteger(mm) ? String(mm) : mm.toFixed(1)).replace('.', ',')} mm`;
};

const readStoredNumber = (key: string, fallback: number, isValid: (v: number) => boolean) => {
    try {
        const value = parseFloat(localStorage.getItem(key) ?? '');
        return isValid(value) ? value : fallback;
    } catch {
        return fallback;
    }
};

const storeNumber = (key: string, value: number) => {
    try {
        localStorage.setItem(key, String(value));
    } catch {
        // stockage indisponible (navigation privée) : le choix vaut pour la session
    }
};

const readStoredText = (key: string, fallback: string, isValid: (v: string) => boolean) => {
    try {
        const value = localStorage.getItem(key);
        return value !== null && isValid(value) ? value : fallback;
    } catch {
        return fallback;
    }
};

const storeText = (key: string, value: string) => {
    try {
        localStorage.setItem(key, value);
    } catch {
        // stockage indisponible : le choix vaut pour la session
    }
};

// ── Composants du panneau (styles .tool-* dans index.scss) ──

const createRow = (label: string, value: string, kind?: 'hollow' | 'bump'): HTMLDivElement => {
    const row = document.createElement('div');
    row.className = 'tool-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'tool-row-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = kind ? `tool-row-value ${kind}` : 'tool-row-value';
    valueEl.textContent = value;
    row.append(labelEl, valueEl);
    return row;
};

const createNote = (text: string, warning = false): HTMLDivElement => {
    const note = document.createElement('div');
    note.className = warning ? 'tool-note warning' : 'tool-note';
    note.textContent = warning ? `⚠ ${text}` : text;
    return note;
};

// Libellé au-dessus, contrôle en dessous : le contrôle a toute la largeur.
const createField = (label: string, control: HTMLElement): HTMLDivElement => {
    const field = document.createElement('div');
    field.className = 'tool-field';
    const labelEl = document.createElement('div');
    labelEl.className = 'tool-field-label';
    labelEl.textContent = label;
    field.append(labelEl, control);
    return field;
};

interface SegmentOption<T> {
    value: T;
    label: string;
    title?: string;
}

// Boutons côte à côte, un seul actif : remplace les listes déroulantes.
const createSegmented = <T>(options: SegmentOption<T>[], current: T | null, onSelect: (value: T) => void): HTMLDivElement => {
    const group = document.createElement('div');
    group.className = 'tool-seg';
    for (const option of options) {
        const button = document.createElement('button');
        button.className = 'tool-seg-btn';
        button.textContent = option.label;
        if (option.title) button.title = option.title;
        const active = option.value === current;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
        button.addEventListener('click', () => {
            if (option.value !== current) onSelect(option.value);
        });
        group.appendChild(button);
    }
    return group;
};

interface StepperOptions {
    value: number;
    min: number;
    max: number;
    step: number;
    unit: string;
    label: string;      // nom lu par les lecteurs d'écran
    onChange: (value: number) => void;
}

// Compteur − / valeur / +. Maintenir un bouton répète le pas. La valeur se
// tape au clavier (virgule acceptée) : Entrée valide, Échap annule, ↑ et ↓
// ajoutent ou retirent un pas. Les touches ne remontent pas aux raccourcis
// du visualisateur (Échap effacerait la zone).
const createStepper = (opts: StepperOptions): HTMLDivElement => {
    let value = opts.value;
    const format = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1)).replace('.', ',');
    const clamp = (v: number) => Math.min(opts.max, Math.max(opts.min, Math.round(v / opts.step) * opts.step));

    const wrapper = document.createElement('div');
    wrapper.className = 'tool-stepper';

    const box = document.createElement('label');
    box.className = 'tool-stepper-value';
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.spellcheck = false;
    input.value = format(value);
    input.setAttribute('aria-label', opts.label);
    const unit = document.createElement('span');
    unit.textContent = opts.unit;
    box.append(input, unit);

    const set = (v: number) => {
        const next = clamp(v);
        input.value = format(next);
        if (next !== value) {
            value = next;
            opts.onChange(value);
        }
    };
    const commit = () => {
        const v = parseFloat(input.value.replace(',', '.'));
        if (Number.isFinite(v)) set(v);
        else input.value = format(value);
    };

    input.addEventListener('focus', () => input.select());
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
            commit();
            input.blur();
        } else if (event.key === 'Escape') {
            input.value = format(value);
            input.blur();
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            set(value + (event.key === 'ArrowUp' ? opts.step : -opts.step));
            input.select();
        }
    });

    const makeButton = (text: string, delta: number, label: string) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tool-stepper-btn';
        button.textContent = text;
        button.setAttribute('aria-label', label);
        let delay: ReturnType<typeof setTimeout> | null = null;
        let repeat: ReturnType<typeof setInterval> | null = null;
        const stop = () => {
            if (delay) clearTimeout(delay);
            if (repeat) clearInterval(repeat);
            delay = null;
            repeat = null;
        };
        button.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            set(value + delta);
            stop();
            delay = setTimeout(() => {
                repeat = setInterval(() => set(value + delta), 70);
            }, 400);
        });
        for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
            button.addEventListener(type, stop);
        }
        // Clavier (Entrée, Espace) : un pas par appui
        button.addEventListener('click', (event) => {
            if (event.detail === 0) set(value + delta);
        });
        return button;
    };

    wrapper.append(
        makeButton('−', -opts.step, `Diminuer : ${opts.label}`),
        box,
        makeButton('+', opts.step, `Augmenter : ${opts.label}`)
    );
    return wrapper;
};

interface RangeOptions {
    min: number;
    max: number;
    step: number;
    value: number;
    format: (value: number) => string;
    onCommit: (value: number) => void;
}

// Curseur stylé : partie gauche remplie, valeur affichée pendant le glissé,
// appliquée au relâchement.
const createRange = (opts: RangeOptions): HTMLDivElement => {
    const row = document.createElement('div');
    row.className = 'tool-range-row';
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'tool-range';
    input.min = String(opts.min);
    input.max = String(opts.max);
    input.step = String(opts.step);
    input.value = String(opts.value);
    const label = document.createElement('span');
    label.className = 'tool-range-value';
    const update = () => {
        const v = parseFloat(input.value);
        label.textContent = opts.format(v);
        input.style.setProperty('--fill', `${(v - opts.min) / (opts.max - opts.min) * 100}%`);
    };
    update();
    input.addEventListener('input', update);
    input.addEventListener('change', () => opts.onCommit(parseFloat(input.value)));
    row.append(input, label);
    return row;
};

const createSwitch = (label: string, value: boolean, onChange: (value: boolean) => void): HTMLDivElement => {
    const row = document.createElement('div');
    row.className = 'tool-switch-row';
    const text = document.createElement('span');
    text.textContent = label;
    const toggle = document.createElement('button');
    toggle.className = 'tool-switch';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(value));
    toggle.setAttribute('aria-label', label);
    toggle.addEventListener('click', () => {
        const next = toggle.getAttribute('aria-checked') !== 'true';
        toggle.setAttribute('aria-checked', String(next));
        onChange(next);
    });
    row.append(text, toggle);
    return row;
};

// Plan des moindres carrés sur les points d'indices `indices` (xyz entrelacés).
// La normale est le vecteur propre de plus petite valeur propre de la
// covariance, obtenu par itération de puissance sur sa comatrice ; `hint`
// sert de départ et fixe le sens de la normale.
const fitPlaneLS = (pts: Float64Array, indices: ArrayLike<number>, hint: Vec3): Plane | null => {
    const n = indices.length;
    if (n < 3) return null;

    let ox = 0, oy = 0, oz = 0;
    for (let k = 0; k < n; k++) {
        const i = indices[k] * 3;
        ox += pts[i]; oy += pts[i + 1]; oz += pts[i + 2];
    }
    ox /= n; oy /= n; oz /= n;

    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (let k = 0; k < n; k++) {
        const i = indices[k] * 3;
        const dx = pts[i] - ox, dy = pts[i + 1] - oy, dz = pts[i + 2] - oz;
        xx += dx * dx; xy += dx * dy; xz += dx * dz;
        yy += dy * dy; yz += dy * dz; zz += dz * dz;
    }

    const c00 = yy * zz - yz * yz;
    const c01 = xz * yz - xy * zz;
    const c02 = xy * yz - xz * yy;
    const c11 = xx * zz - xz * xz;
    const c12 = xy * xz - xx * yz;
    const c22 = xx * yy - xy * xy;

    let nx = hint.x, ny = hint.y, nz = hint.z;
    for (let iter = 0; iter < 30; iter++) {
        const tx = c00 * nx + c01 * ny + c02 * nz;
        const ty = c01 * nx + c11 * ny + c12 * nz;
        const tz = c02 * nx + c12 * ny + c22 * nz;
        const len = Math.sqrt(tx * tx + ty * ty + tz * tz);
        if (len < 1e-18) break;
        nx = tx / len; ny = ty / len; nz = tz / len;
    }

    const normal = new Vec3(nx, ny, nz);
    if (normal.dot(hint) < 0) normal.mulScalar(-1);
    return { origin: new Vec3(ox, oy, oz), normal };
};

class FlatnessTool {
    private global: Global;

    private pointerHandler: ToolPointerHandler;

    private state: FlatnessMeasureState = 'idle';

    private currentPoints: Vec3[] = [];

    // Sommets au moment du dernier calcul : détecte leur déplacement.
    private analyzedPoints: Vec3[] = [];

    private recomputeTimer: ReturnType<typeof setTimeout> | null = null;

    private view: ViewSnapshot | null = null;

    // Plan moyen ajusté sur le nuage, normale orientée côté bosse.
    private fittedPlane: Plane | null = null;

    // Plan de référence choisi. S'il n'a pas de sens pour la zone (horizontal
    // sur un mur), c'est le plan moyen qui s'applique ; le choix reste pour
    // la zone suivante.
    private reference: ReferenceMode = 'mean';

    // Plan de référence (repère planeOrigin, planeU, planeV, planeNormal).
    // Horizontal ou vertical, il passe par la médiane des écarts.
    private planeOrigin: Vec3 | null = null;

    private planeNormal: Vec3 | null = null;

    private planeU: Vec3 | null = null;

    private planeV: Vec3 | null = null;

    // Sens de la bosse (+) : vers le haut (sol, toiture) ou vers l'observateur (mur).
    private bumpTowards: 'up' | 'viewer' = 'viewer';

    private gridData: GridData | null = null;

    private gridGeom: GridGeometry | null = null;

    private gridResX = 50;

    private gridResY = 50;

    // Splats candidats (xyz monde) : ceux de la zone, proches du plan des sommets.
    private candidates: Float64Array | null = null;

    // Raw data for post-processing
    private rawGrid: (number | null)[][] | null = null;

    private insideMask: boolean[][] | null = null;

    private polyUV: { u: number; v: number }[] | null = null;

    private rawSplatCount = 0;

    private excludedSplatCount = 0;

    // Splats écartés parce que derrière la surface visible (reflets)
    private hiddenSplatCount = 0;

    private hiddenFilterEnabled = true;

    // Splats retenus, dans le repère du plan : (u, v, écart) entrelacés.
    private keptPoints: Float64Array | null = null;

    private stats: FlatnessStats | null = null;

    private rule: RuleResult | null = null;

    // Réglages
    private interpolationEnabled = true;

    private bandHalfWidth = DEFAULT_BAND; // meters — splats plus loin du plan exclus

    // Largeur d'ondulation lissée (tuiles, tôle ondulée), 0 = pas de lissage.
    private waveWidth = 0;

    private colorScale = 0.10; // meters — symmetric range [-scale, +scale]

    // Tant que l'utilisateur n'a pas choisi d'échelle, elle suit les données.
    private colorScaleManual = false;

    private ruleLength = readStoredNumber(RULE_LENGTH_STORAGE_KEY, DEFAULT_RULE_LENGTH, v => RULE_LENGTHS.includes(v));

    private tolerance = readStoredNumber(TOLERANCE_STORAGE_KEY, DEFAULT_TOLERANCE, v => v >= 0.0005 && v <= 0.1);

    private overlay: HTMLDivElement | null = null;

    private drawCanvas: HTMLCanvasElement | null = null;

    private hint: HTMLDivElement | null = null;

    private updateHandler: ((dt: number) => void) | null = null;

    private keyHandler: ((event: KeyboardEvent) => void) | null = null;

    // Heatmap panel elements
    private panel: HTMLDivElement | null = null;

    private banner: HTMLDivElement | null = null;

    private ruleResults: HTMLDivElement | null = null;

    private activeTab = readStoredText(TAB_STORAGE_KEY, 'deviations', v => FLATNESS_TABS.includes(v as FlatnessTab)) as FlatnessTab;

    private collapsed = readStoredText(COLLAPSED_STORAGE_KEY, '0', v => v === '0' || v === '1') === '1';

    private heatmapCanvas: HTMLCanvasElement | null = null;

    constructor(global: Global) {
        this.global = global;
        this.pointerHandler = new ToolPointerHandler(global, {
            onCanvasClick: (pos, clientX, clientY) => this.handleClick(pos, clientX, clientY),
            getDraggablePoints: () => (this.state === 'closed' ? this.currentPoints : []),
            onClear: () => this.clearAll()
        });
    }

    activate() {
        const { app } = this.global;

        this.overlay = document.createElement('div');
        this.overlay.id = 'flatnessMeasureOverlay';
        const ui = document.querySelector('#ui');
        ui.insertBefore(this.overlay, ui.firstChild);

        this.drawCanvas = document.createElement('canvas');
        this.drawCanvas.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;';
        this.overlay.appendChild(this.drawCanvas);

        this.hint = document.createElement('div');
        this.hint.id = 'flatnessHint';
        this.overlay.appendChild(this.hint);
        this.updateHint();

        this.pointerHandler.activate();

        // Entrée ferme la zone, Retour arrière retire le dernier sommet.
        this.keyHandler = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest?.('input, textarea, select, [contenteditable]')) return;
            if (this.state !== 'placing') return;
            if (event.key === 'Enter' && this.currentPoints.length >= 3) {
                event.preventDefault();
                this.closePolygon();
            } else if (event.key === 'Backspace' || event.key === 'Delete') {
                event.preventDefault();
                this.undoLastPoint();
            }
        };
        document.addEventListener('keydown', this.keyHandler);

        this.updateHandler = () => {
            this.syncFromPoints();
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
        this.cancelRecompute();
        this.removePanel();

        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }

        this.drawCanvas = null;
        this.hint = null;
        this.currentPoints = [];
        this.analyzedPoints = [];
        this.candidates = null;
        this.state = 'idle';
    }

    destroy() {
        this.deactivate();
        this.pointerHandler.destroy();
    }

    private handleClick(pos: Vec3, clientX: number, clientY: number) {
        if (this.state === 'idle') {
            this.currentPoints = [pos];
            this.state = 'placing';
        } else if (this.state === 'closed') {
            this.pointerHandler.selectedIndex = -1;
        } else if (this.state === 'placing') {
            // Snap to first point to close polygon (>= 3 points, within 20px)
            if (this.currentPoints.length >= 3) {
                const firstScreen = worldToScreen(this.global.camera, this.currentPoints[0]);
                if (!firstScreen.behind) {
                    const sdx = clientX - firstScreen.x;
                    const sdy = clientY - firstScreen.y;
                    if (sdx * sdx + sdy * sdy < 400) {
                        this.closePolygon();
                        return;
                    }
                }
            }
            this.currentPoints.push(pos);
            if (this.currentPoints.length >= MAX_POINTS) {
                this.closePolygon();
                return;
            }
        }
        this.updateHint();
    }

    private closePolygon() {
        this.state = 'closed';
        this.analyze();
        this.showPanel();
        this.updateHint();
        this.global.app.renderNextFrame = true;
    }

    private undoLastPoint() {
        this.currentPoints.pop();
        if (this.currentPoints.length === 0) this.state = 'idle';
        this.updateHint();
        this.global.app.renderNextFrame = true;
    }

    private clearAll() {
        this.cancelRecompute();
        this.currentPoints = [];
        this.analyzedPoints = [];
        this.state = 'idle';
        this.view = null;
        this.fittedPlane = null;
        this.planeOrigin = null;
        this.planeNormal = null;
        this.planeU = null;
        this.planeV = null;
        this.gridData = null;
        this.gridGeom = null;
        this.candidates = null;
        this.rawGrid = null;
        this.insideMask = null;
        this.polyUV = null;
        this.rawSplatCount = 0;
        this.excludedSplatCount = 0;
        this.keptPoints = null;
        this.stats = null;
        this.rule = null;
        this.colorScaleManual = false;
        this.removePanel();
        this.pointerHandler.reset();
        this.updateHint();
        this.global.app.renderNextFrame = true;
    }

    // ── Aide contextuelle en haut de l'écran ──

    private updateHint() {
        if (!this.hint) return;

        const n = this.currentPoints.length;
        let text: string;
        if (this.state === 'idle') {
            text = 'Cliquez les sommets de la zone à analyser.';
        } else if (this.state === 'placing' && n < 3) {
            text = `Cliquez les sommets suivants (encore ${3 - n} au moins).`;
        } else if (this.state === 'placing') {
            text = 'Cliquez le premier sommet ou Entrée pour fermer la zone.';
        } else {
            text = 'Glissez un sommet pour ajuster la zone · Échap pour effacer.';
        }

        this.hint.textContent = '';
        const label = document.createElement('span');
        label.textContent = text;
        this.hint.appendChild(label);

        const addButton = (caption: string, primary: boolean, onClick: () => void) => {
            const button = document.createElement('button');
            button.textContent = caption;
            button.className = primary ? 'tool-btn primary' : 'tool-btn';
            button.addEventListener('click', onClick);
            this.hint.appendChild(button);
        };

        if (this.state === 'placing') {
            if (n >= 3) addButton('Fermer la zone', true, () => this.closePolygon());
            addButton('Annuler le point', false, () => this.undoLastPoint());
            addButton('Effacer', false, () => this.clearAll());
        }
    }

    // ── Relance du calcul quand un sommet a été déplacé ──

    private syncFromPoints() {
        if (this.state !== 'closed' || this.pointerHandler.isDragging) return;

        const pts = this.currentPoints;
        const changed = pts.length !== this.analyzedPoints.length ||
            pts.some((p, i) => !p.equals(this.analyzedPoints[i]));
        if (!changed) return;

        this.analyzedPoints = pts.map(p => p.clone());
        this.cancelRecompute();
        this.recomputeTimer = setTimeout(() => {
            this.recomputeTimer = null;
            this.analyze();
            this.showPanel();
            this.global.app.renderNextFrame = true;
        }, RECOMPUTE_DELAY);
    }

    private cancelRecompute() {
        if (this.recomputeTimer) {
            clearTimeout(this.recomputeTimer);
            this.recomputeTimer = null;
        }
    }

    // ── Analyse complète : zone, plan de référence, écarts ──

    private analyze() {
        this.analyzedPoints = this.currentPoints.map(p => p.clone());
        this.gridData = null;
        this.gridGeom = null;
        this.rawGrid = null;
        this.insideMask = null;
        this.stats = null;
        this.rule = null;
        this.fittedPlane = null;

        const camera = this.global.camera;
        this.view = {
            position: camera.getPosition().clone(),
            right: camera.right.clone(),
            up: camera.up.clone(),
            forward: camera.forward.clone()
        };

        const footprint = this.computeFootprintPlane();
        if (!footprint) return;

        this.candidates = this.gatherCandidates(footprint);
        if (!this.candidates) return;

        const plane = this.fitReferencePlane(this.candidates, footprint) ?? footprint;
        this.orientNormal(plane);
        this.fittedPlane = plane;
        this.applyReference();
        this.computeDeviations();
    }

    // Plans de référence qui ont un sens pour la zone, selon l'orientation du
    // plan moyen.
    private availableReferences(): ReferenceMode[] {
        const fit = this.fittedPlane;
        if (!fit) return ['mean'];
        const tilt = Math.acos(Math.min(1, Math.abs(fit.normal.dot(Vec3.UP))));
        if (tilt <= REFERENCE_MAX_TILT) return ['mean', 'horizontal'];
        if (tilt >= Math.PI / 2 - REFERENCE_MAX_TILT) return ['mean', 'vertical'];
        return ['mean'];
    }

    private activeReference(): ReferenceMode {
        return this.availableReferences().includes(this.reference) ? this.reference : 'mean';
    }

    // Orientation du plan de référence, tirée du plan moyen. Sa position
    // (horizontal, vertical) est fixée ensuite sur la médiane des écarts,
    // dans computeDeviations. Les normales gardent le sens de la bosse :
    // vers le haut pour un sol (pente < 10°), vers l'observateur pour un mur.
    private applyReference() {
        const fit = this.fittedPlane;
        if (!fit) return;
        const normal = fit.normal.clone();
        const mode = this.activeReference();
        if (mode === 'horizontal') {
            normal.copy(Vec3.UP);
        } else if (mode === 'vertical') {
            const up = normal.dot(Vec3.UP);
            normal.sub(Vec3.UP.clone().mulScalar(up)).normalize();
        }
        this.setPlane({ origin: fit.origin.clone(), normal });
    }

    // Pente du plan moyen : par rapport à l'horizontale pour un sol ou une
    // toiture, faux aplomb (écart à la verticale) pour un mur. ratio = tangente
    // de l'angle ; lean : +1 si le haut du mur part en arrière, −1 s'il penche
    // vers l'observateur.
    private fittedSlope(): { kind: 'slope' | 'plumb'; ratio: number; angle: number; lean: number } | null {
        const fit = this.fittedPlane;
        if (!fit) return null;
        const up = fit.normal.dot(Vec3.UP);
        const cos = Math.min(1, Math.abs(up));
        const sin = Math.sqrt(1 - cos * cos);
        if (this.bumpTowards === 'up') {
            return { kind: 'slope', ratio: sin / Math.max(cos, 1e-9), angle: Math.acos(cos), lean: 0 };
        }
        return { kind: 'plumb', ratio: cos / Math.max(sin, 1e-9), angle: Math.asin(cos), lean: Math.sign(up) };
    }

    // Plan des sommets : ne sert qu'à délimiter la zone et à orienter la recherche.
    private computeFootprintPlane(): Plane | null {
        const pts = this.currentPoints;
        if (pts.length < 3) return null;

        const flat = new Float64Array(pts.length * 3);
        pts.forEach((p, i) => {
            flat[i * 3] = p.x; flat[i * 3 + 1] = p.y; flat[i * 3 + 2] = p.z;
        });
        const indices = pts.map((_, i) => i);

        // Départ de l'itération : la normale du triangle formé par les trois
        // premiers sommets, orientée vers la caméra.
        const hint = new Vec3().cross(new Vec3().sub2(pts[1], pts[0]), new Vec3().sub2(pts[2], pts[0]));
        if (hint.length() < 1e-12) hint.copy(this.global.camera.forward).mulScalar(-1);
        hint.normalize();
        const toCamera = new Vec3().sub2(this.global.camera.getPosition(), pts[0]);
        if (hint.dot(toCamera) < 0) hint.mulScalar(-1);

        const plane = fitPlaneLS(flat, indices, hint);
        if (!plane) return null;

        // Ensure normal points towards camera
        const toCam = new Vec3().sub2(this.global.camera.getPosition(), plane.origin);
        if (toCam.dot(plane.normal) < 0) plane.normal.mulScalar(-1);
        return plane;
    }

    // + = bosse : vers le haut pour une surface peu pentue, vers l'observateur sinon.
    private orientNormal(plane: Plane) {
        const N = plane.normal;
        const up = N.dot(Vec3.UP);
        if (Math.abs(up) >= UP_MIN_COS) {
            if (up < 0) N.mulScalar(-1);
            this.bumpTowards = 'up';
        } else {
            const toCamera = new Vec3().sub2(this.view.position, plane.origin);
            if (toCamera.dot(N) < 0) N.mulScalar(-1);
            this.bumpTowards = 'viewer';
        }
    }

    // Base 2D du plan alignée sur la caméra au moment du calcul :
    // U = droite caméra projetée sur le plan (horizontale de la carte ≈ écran),
    // V = N × U, calculé avec la normale tournée vers la caméra pour que la
    // verticale de la carte descende comme l'écran, quel que soit le sens de N.
    private planeBasis(normal: Vec3) {
        const view = this.view;
        const N = normal.dot(view.forward) > 0 ? normal.clone().mulScalar(-1) : normal;
        const camRight = view.right.clone();
        const dotNR = camRight.dot(N);
        const U = new Vec3(camRight.x - dotNR * N.x, camRight.y - dotNR * N.y, camRight.z - dotNR * N.z);
        const uLen = U.length();
        if (uLen < 1e-10) {
            // Camera looking straight at the plane normal — fallback
            const camUp = view.up.clone();
            const dotNU = camUp.dot(N);
            U.set(camUp.x - dotNU * N.x, camUp.y - dotNU * N.y, camUp.z - dotNU * N.z).normalize();
        } else {
            U.mulScalar(1 / uLen);
        }
        const V = new Vec3().cross(U, N).normalize();
        return { U, V };
    }

    private setPlane(plane: Plane) {
        this.planeOrigin = plane.origin;
        this.planeNormal = plane.normal;
        const { U, V } = this.planeBasis(plane.normal);
        this.planeU = U;
        this.planeV = V;
    }

    private projectPolygon(O: Vec3, U: Vec3, V: Vec3) {
        return this.currentPoints.map((p) => {
            const dx = p.x - O.x, dy = p.y - O.y, dz = p.z - O.z;
            return { u: dx * U.x + dy * U.y + dz * U.z, v: dx * V.x + dy * V.y + dz * V.z };
        });
    }

    // Point du repère du plan → monde.
    private toWorld(p: PlanePoint): Vec3 {
        const O = this.planeOrigin, U = this.planeU, V = this.planeV, N = this.planeNormal;
        return new Vec3(
            O.x + U.x * p.u + V.x * p.v + N.x * p.h,
            O.y + U.y * p.u + V.y * p.v + N.y * p.h,
            O.z + U.z * p.u + V.z * p.v + N.z * p.h
        );
    }

    // Splats de la zone (polygone projeté sur le plan des sommets) à moins de
    // SEARCH_BAND de ce plan, en coordonnées monde.
    private gatherCandidates(footprint: Plane): Float64Array | null {
        const info = getSplatCenters(this.global);
        if (!info) return null;

        const { centers, numSplats, worldMatrix: m } = info;
        const O = footprint.origin;
        const N = footprint.normal;
        const { U, V } = this.planeBasis(N);
        const polyUV = this.projectPolygon(O, U, V);

        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (const q of polyUV) {
            if (q.u < uMin) uMin = q.u; if (q.u > uMax) uMax = q.u;
            if (q.v < vMin) vMin = q.v; if (q.v > vMax) vMax = q.v;
        }

        const out: number[] = [];
        for (let i = 0; i < numSplats; i++) {
            const idx = i * 3;
            const lx = centers[idx], ly = centers[idx + 1], lz = centers[idx + 2];
            const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
            const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
            const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
            const dx = wx - O.x, dy = wy - O.y, dz = wz - O.z;
            const dist = dx * N.x + dy * N.y + dz * N.z;
            if (Math.abs(dist) > SEARCH_BAND) continue;
            const pu = dx * U.x + dy * U.y + dz * U.z;
            const pv = dx * V.x + dy * V.y + dz * V.z;
            if (pu < uMin || pu > uMax || pv < vMin || pv > vMax) continue;
            if (!this.pointInPolygon(pu, pv, polyUV)) continue;
            out.push(wx, wy, wz);
        }

        return out.length >= 9 ? new Float64Array(out) : null;
    }

    // Plan de référence robuste : RANSAC sur un échantillon pour trouver la
    // surface dominante (sans se laisser tirer par la charpente, un objet posé
    // ou des splats isolés), puis moindres carrés sur ses points proches.
    private fitReferencePlane(pts: Float64Array, footprint: Plane): Plane | null {
        const count = pts.length / 3;
        const random = createRandom(0x236);
        const N0 = footprint.normal;

        // Échantillon : indices tirés sans remise partielle (suffisant ici).
        const sampleSize = Math.min(count, RANSAC_SAMPLE);
        const sample = new Uint32Array(sampleSize);
        for (let k = 0; k < sampleSize; k++) {
            sample[k] = sampleSize === count ? k : Math.floor(random() * count);
        }

        let bestInliers = 0;
        let best: Plane | null = null;
        const a = new Vec3(), b = new Vec3(), c = new Vec3(), n = new Vec3();

        for (let iter = 0; iter < RANSAC_ITERATIONS; iter++) {
            const i0 = sample[Math.floor(random() * sampleSize)] * 3;
            const i1 = sample[Math.floor(random() * sampleSize)] * 3;
            const i2 = sample[Math.floor(random() * sampleSize)] * 3;
            a.set(pts[i0], pts[i0 + 1], pts[i0 + 2]);
            b.set(pts[i1] - a.x, pts[i1 + 1] - a.y, pts[i1 + 2] - a.z);
            c.set(pts[i2] - a.x, pts[i2 + 1] - a.y, pts[i2 + 2] - a.z);
            n.cross(b, c);
            const len = n.length();
            if (len < 1e-9) continue;
            n.mulScalar(1 / len);
            if (Math.abs(n.dot(N0)) < RANSAC_MAX_TILT_COS) continue;

            let inliers = 0;
            for (let k = 0; k < sampleSize; k++) {
                const j = sample[k] * 3;
                const d = (pts[j] - a.x) * n.x + (pts[j + 1] - a.y) * n.y + (pts[j + 2] - a.z) * n.z;
                if (Math.abs(d) < RANSAC_TOL) inliers++;
            }
            if (inliers > bestInliers) {
                bestInliers = inliers;
                best = { origin: a.clone(), normal: n.clone() };
            }
        }

        if (!best) return null;
        if (best.normal.dot(N0) < 0) best.normal.mulScalar(-1);

        // Affinage : moindres carrés sur les points proches, tolérance resserrée
        // à chaque passe selon la dispersion mesurée.
        let plane = best;
        let tol = RANSAC_TOL;
        for (let iter = 0; iter < REFINE_ITERATIONS; iter++) {
            const inliers: number[] = [];
            const residuals: number[] = [];
            const O = plane.origin, N = plane.normal;
            for (let k = 0; k < count; k++) {
                const j = k * 3;
                const d = (pts[j] - O.x) * N.x + (pts[j + 1] - O.y) * N.y + (pts[j + 2] - O.z) * N.z;
                if (Math.abs(d) < tol) {
                    inliers.push(k);
                    residuals.push(d);
                }
            }
            const refined = fitPlaneLS(pts, inliers, N0);
            if (!refined) break;
            plane = refined;

            const sub = subsample(residuals, NOISE_SAMPLE);
            const med = median(sub);
            const sigma = 1.4826 * median(sub.map(r => Math.abs(r - med)));
            tol = Math.max(REFINE_SIGMAS * sigma, REFINE_MIN_TOL);
        }

        return plane;
    }

    // ── Point-in-polygon test (winding number) ──

    private pointInPolygon(pu: number, pv: number, polyUV: { u: number; v: number }[]): boolean {
        let winding = 0;
        const n = polyUV.length;
        for (let i = 0; i < n; i++) {
            const a = polyUV[i];
            const b = polyUV[(i + 1) % n];
            if (a.v <= pv) {
                if (b.v > pv) {
                    const cross = (b.u - a.u) * (pv - a.v) - (pu - a.u) * (b.v - a.v);
                    if (cross > 0) winding++;
                }
            } else {
                if (b.v <= pv) {
                    const cross = (b.u - a.u) * (pv - a.v) - (pu - a.u) * (b.v - a.v);
                    if (cross < 0) winding--;
                }
            }
        }
        return winding !== 0;
    }

    // ── Écarts au plan de référence, rangés dans la grille ──

    // Les splats sont triés selon leur écart au plan moyen (épaisseur
    // analysée, reflets), puis mesurés par rapport au plan de référence.
    private computeDeviations() {
        this.gridData = null;
        this.stats = null;
        this.rule = null;
        const fit = this.fittedPlane;
        if (!fit || !this.planeOrigin || !this.planeNormal || !this.planeU || !this.planeV || !this.candidates) return;

        const pts = this.candidates;
        const mode = this.activeReference();
        // Horizontal ou vertical : le plan est recalé plus bas sur la médiane.
        if (mode !== 'mean') this.planeOrigin = fit.origin.clone();
        const O = this.planeOrigin;
        const N = this.planeNormal;
        const U = this.planeU;
        const V = this.planeV;
        const Of = fit.origin, Nf = fit.normal;
        const band = this.bandHalfWidth;

        // Polygone projeté sur le plan de référence
        const polyUV = this.projectPolygon(O, U, V);
        this.polyUV = polyUV;

        // Compute UV bounding box of the polygon
        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (const q of polyUV) {
            if (q.u < uMin) uMin = q.u; if (q.u > uMax) uMax = q.u;
            if (q.v < vMin) vMin = q.v; if (q.v > vMax) vMax = q.v;
        }
        const uRange = uMax - uMin;
        const vRange = vMax - vMin;
        if (uRange < 1e-6 || vRange < 1e-6) return;

        let kept: KeptPoint[] = [];
        let excluded = 0;
        for (let k = 0; k < pts.length; k += 3) {
            const dx = pts[k] - O.x, dy = pts[k + 1] - O.y, dz = pts[k + 2] - O.z;
            const pu = dx * U.x + dy * U.y + dz * U.z;
            const pv = dx * V.x + dy * V.y + dz * V.z;
            if (pu < uMin || pu > uMax || pv < vMin || pv > vMax) continue;
            if (!this.pointInPolygon(pu, pv, polyUV)) continue;
            const fitDist = (pts[k] - Of.x) * Nf.x + (pts[k + 1] - Of.y) * Nf.y + (pts[k + 2] - Of.z) * Nf.z;
            if (Math.abs(fitDist) > band) {
                excluded++;
                continue;
            }
            kept.push({ dist: dx * N.x + dy * N.y + dz * N.z, pu, pv, fit: fitDist });
        }

        this.excludedSplatCount = excluded;
        this.hiddenSplatCount = 0;
        if (this.hiddenFilterEnabled && kept.length > 0) {
            let polyArea = 0;
            for (let i = 0; i < polyUV.length; i++) {
                const a = polyUV[i], b = polyUV[(i + 1) % polyUV.length];
                polyArea += a.u * b.v - b.u * a.v;
            }
            const toCamera = new Vec3().sub2(this.view.position, Of);
            const visible = this.removeHiddenLayer(kept, toCamera.dot(Nf) >= 0 ? 1 : -1, Math.abs(polyArea) / 2, uMin, vMin, uRange, vRange);
            this.hiddenSplatCount = kept.length - visible.length;
            kept = visible;
        }
        this.rawSplatCount = kept.length;
        if (kept.length === 0) return;

        this.keptPoints = new Float64Array(kept.length * 3);
        kept.forEach((s, k) => {
            this.keptPoints[k * 3] = s.pu;
            this.keptPoints[k * 3 + 1] = s.pv;
            this.keptPoints[k * 3 + 2] = s.dist;
        });

        // Adaptive resolution with aspect ratio: target ~3 splats per cell
        const TARGET_SPLATS_PER_CELL = 3;
        const totalCells = kept.length / TARGET_SPLATS_PER_CELL;
        const aspect = uRange / vRange;
        // resX * resY ≈ totalCells, resX/resY ≈ aspect
        const resY = Math.max(20, Math.min(200, Math.round(Math.sqrt(totalCells / aspect))));
        const resX = Math.max(20, Math.min(200, Math.round(resY * aspect)));
        this.gridResX = resX;
        this.gridResY = resY;
        const du = uRange / resX, dv = vRange / resY;
        this.gridGeom = { uMin, vMin, du, dv };

        // Bucket into grid
        const gridValues: number[][] = new Array(resX * resY);
        for (let k = 0; k < resX * resY; k++) gridValues[k] = [];

        for (const s of kept) {
            const gi = Math.min(Math.floor((s.pu - uMin) / uRange * resX), resX - 1);
            const gj = Math.min(Math.floor((s.pv - vMin) / vRange * resY), resY - 1);
            gridValues[gj * resX + gi].push(s.dist);
        }

        // Build raw grid with MEDIAN signed deviation per cell, and the noise:
        // écarts des splats à la moyenne de leur case, corrigés du biais des
        // petits effectifs (√(n / (n − 1))), puis MAD de l'ensemble. La MAD
        // case par case sous-estimait le bruit avec 2 ou 3 splats par case.
        const rawGrid: (number | null)[][] = [];
        const residuals: number[] = [];
        for (let j = 0; j < resY; j++) {
            const row: (number | null)[] = [];
            for (let i = 0; i < resX; i++) {
                const vals = gridValues[j * resX + i];
                if (vals.length === 0) {
                    row.push(null);
                    continue;
                }
                row.push(median(vals));
                if (vals.length >= 2) {
                    let mean = 0;
                    for (const v of vals) mean += v;
                    mean /= vals.length;
                    const correction = Math.sqrt(vals.length / (vals.length - 1));
                    for (const v of vals) residuals.push((v - mean) * correction);
                }
            }
            rawGrid.push(row);
        }
        const noise = 1.4826 * median(subsample(residuals, NOISE_SAMPLE).map(r => Math.abs(r)));

        // Horizontal ou vertical : le plan passe par la médiane des cases, pour
        // que chaque partie de la zone compte selon sa surface et non selon sa
        // densité de points.
        if (mode !== 'mean') {
            const values: number[] = [];
            for (const row of rawGrid) {
                for (const v of row) if (v !== null) values.push(v);
            }
            const offset = median(values);
            for (const row of rawGrid) {
                for (let i = 0; i < resX; i++) if (row[i] !== null) row[i] -= offset;
            }
            for (let k = 2; k < this.keptPoints.length; k += 3) this.keptPoints[k] -= offset;
            O.add(N.clone().mulScalar(offset));
        }

        const spikeCells = this.removeSpikes(rawGrid, resX, resY);

        // Lissage des tuiles : l'ondulation disparaît, la forme du pan reste.
        let grid = rawGrid;
        if (this.waveWidth > 0) {
            const sigma = this.waveWidth * WAVE_SIGMA_RATIO;
            if (sigma / Math.max(du, dv) >= WAVE_MIN_SIGMA_CELLS) {
                grid = smoothGrid(rawGrid, resX, resY, sigma / du, sigma / dv);
            }
        }

        // Build inside mask
        const insideMask: boolean[][] = [];
        for (let j = 0; j < resY; j++) {
            const row: boolean[] = [];
            for (let i = 0; i < resX; i++) {
                const cellU = uMin + (i + 0.5) / resX * uRange;
                const cellV = vMin + (j + 0.5) / resY * vRange;
                row.push(this.pointInPolygon(cellU, cellV, polyUV));
            }
            insideMask.push(row);
        }

        // Statistiques sur les cases mesurées de la zone
        const cellValues: number[] = [];
        let insideCells = 0;
        for (let j = 0; j < resY; j++) {
            for (let i = 0; i < resX; i++) {
                if (!insideMask[j][i]) continue;
                insideCells++;
                if (grid[j][i] !== null) cellValues.push(grid[j][i]);
            }
        }
        if (cellValues.length === 0) return;

        let hollow = Infinity, bump = -Infinity, sumSq = 0;
        for (const v of cellValues) {
            if (v < hollow) hollow = v;
            if (v > bump) bump = v;
            sumSq += v * v;
        }

        let area = 0;
        for (let i = 0; i < polyUV.length; i++) {
            const a = polyUV[i], b = polyUV[(i + 1) % polyUV.length];
            area += a.u * b.v - b.u * a.v;
        }

        this.stats = {
            hollow: Math.min(0, hollow),
            bump: Math.max(0, bump),
            rms: Math.sqrt(sumSq / cellValues.length),
            area: Math.abs(area) / 2,
            emptyPct: insideCells > 0 ? (insideCells - cellValues.length) / insideCells * 100 : 0,
            noise,
            spikeCells
        };

        // Échelle automatique : la plus petite valeur prédéfinie qui couvre
        // 98 % des écarts, tant que l'utilisateur n'en a pas choisi.
        if (!this.colorScaleManual) {
            const abs = cellValues.map(v => Math.abs(v)).sort((a, b) => a - b);
            const p98 = abs[Math.min(abs.length - 1, Math.floor(0.98 * abs.length))];
            this.colorScale = SCALE_PRESETS.find(s => s >= p98) ?? Math.min(SCALE_MAX, Math.ceil(p98 * 100) / 100);
        }

        this.rawGrid = grid;
        this.insideMask = insideMask;

        this.postProcessGrid();
        this.computeRule();
    }

    // Ne garde que la couche visible depuis l'observateur (voir HIDDEN_*),
    // d'après l'écart au plan moyen des splats (`fit`).
    // side : +1 si l'observateur est du côté de sa normale, −1 sinon.
    private removeHiddenLayer(points: KeptPoint[], side: number, area: number,
        uMin: number, vMin: number, uRange: number, vRange: number): KeptPoint[] {
        const density = points.length / Math.max(area, 1e-6);
        const cell = Math.max(HIDDEN_CELL_MIN, Math.sqrt(HIDDEN_CELL_POINTS / density));
        const resX = Math.max(1, Math.ceil(uRange / cell));
        const resY = Math.max(1, Math.ceil(vRange / cell));
        const cellOf = (p: KeptPoint) => Math.min(resY - 1, Math.max(0, Math.floor((p.pv - vMin) / cell))) * resX +
            Math.min(resX - 1, Math.max(0, Math.floor((p.pu - uMin) / cell)));

        // Écart compté vers l'observateur : plus grand = plus près de lui
        const buckets: number[][] = new Array(resX * resY);
        for (let k = 0; k < resX * resY; k++) buckets[k] = [];
        for (const p of points) buckets[cellOf(p)].push(side * p.fit);

        // 1. Niveau de la première couche dense en partant de l'observateur
        const levels = new Float64Array(resX * resY).fill(NaN);
        const residuals: number[] = [];
        for (let k = 0; k < buckets.length; k++) {
            const b = buckets[k];
            if (b.length < HIDDEN_MIN_POINTS) continue;
            b.sort((x, y) => y - x);
            const need = Math.max(4, Math.ceil(HIDDEN_LAYER_SHARE * b.length));
            let m = 0;
            for (let i = 0; i < b.length; i++) {
                if (m < i) m = i;
                while (m + 1 < b.length && b[m + 1] >= b[i] - HIDDEN_LAYER_WINDOW) m++;
                if (m - i + 1 < need) continue;
                const layer = b.slice(i, m + 1);
                const level = median(layer);
                levels[k] = level;
                for (const v of layer) residuals.push(v - level);
                break;
            }
        }
        if (residuals.length === 0) return points;

        const sigma = 1.4826 * median(subsample(residuals, NOISE_SAMPLE).map(r => Math.abs(r)));
        const depth = Math.max(HIDDEN_MIN_DEPTH, HIDDEN_SIGMAS * sigma);

        // 2. Case en retrait de ses voisines (tache de reflet sans surface
        // au-dessus), ou trop peu fournie pour avoir un niveau (la surface y
        // est clairsemée, le reflet parfois majoritaire) : elle prend le
        // niveau de ses voisines.
        const fixed = levels.slice();
        const neighbors: number[] = [];
        const r = HIDDEN_NEIGHBOR_RADIUS;
        for (let j = 0; j < resY; j++) {
            for (let i = 0; i < resX; i++) {
                const level = levels[j * resX + i];
                neighbors.length = 0;
                for (let dj = -r; dj <= r; dj++) {
                    for (let di = -r; di <= r; di++) {
                        const ni = i + di, nj = j + dj;
                        if ((di === 0 && dj === 0) || ni < 0 || ni >= resX || nj < 0 || nj >= resY) continue;
                        const nl = levels[nj * resX + ni];
                        if (!Number.isNaN(nl)) neighbors.push(nl);
                    }
                }
                if (Number.isNaN(level)) {
                    if (neighbors.length >= 3) fixed[j * resX + i] = median(neighbors);
                    continue;
                }
                if (neighbors.length < 6) continue;
                const around = median(neighbors);
                if (level < around - depth) fixed[j * resX + i] = around;
            }
        }

        // 3. Écarter ce qui est en retrait de la couche visible
        return points.filter((p) => {
            const level = fixed[cellOf(p)];
            return Number.isNaN(level) || side * p.fit >= level - depth;
        });
    }

    // Écarte les cases isolées : un splat flottant seul dans sa case donne une
    // valeur loin de ses voisines, sans voisine pour la confirmer. Retourne le
    // nombre de cases écartées.
    private removeSpikes(grid: (number | null)[][], resX: number, resY: number, minThreshold = SPIKE_MIN): number {
        const deltas = new Float64Array(resX * resY).fill(NaN);
        const absDeltas: number[] = [];
        const neighbors: number[] = [];

        for (let j = 0; j < resY; j++) {
            for (let i = 0; i < resX; i++) {
                const v = grid[j][i];
                if (v === null) continue;
                neighbors.length = 0;
                for (let dj = -1; dj <= 1; dj++) {
                    for (let di = -1; di <= 1; di++) {
                        if (di === 0 && dj === 0) continue;
                        const nv = grid[j + dj]?.[i + di];
                        if (nv !== null && nv !== undefined) neighbors.push(nv);
                    }
                }
                if (neighbors.length < 3) continue;
                const d = v - median(neighbors);
                deltas[j * resX + i] = d;
                absDeltas.push(Math.abs(d));
            }
        }
        if (absDeltas.length < 10) return 0;

        const threshold = Math.max(SPIKE_SIGMAS * 1.4826 * median(absDeltas), minThreshold);
        const spikes: number[] = [];
        for (let j = 0; j < resY; j++) {
            for (let i = 0; i < resX; i++) {
                const d = deltas[j * resX + i];
                if (!(Math.abs(d) > threshold)) continue;
                const v = grid[j][i];
                let support = 0;
                for (let dj = -1; dj <= 1; dj++) {
                    for (let di = -1; di <= 1; di++) {
                        if (di === 0 && dj === 0) continue;
                        const nv = grid[j + dj]?.[i + di];
                        if (nv !== null && nv !== undefined && Math.abs(nv - v) <= Math.abs(d) / 2) support++;
                    }
                }
                if (support < 2) spikes.push(j * resX + i);
            }
        }

        for (const k of spikes) {
            grid[Math.floor(k / resX)][k % resX] = null;
        }
        return spikes.length;
    }

    // ── Post-processing: interpolation des cases vides ──

    private postProcessGrid() {
        this.gridData = null;
        if (!this.rawGrid || !this.insideMask) return;

        const resX = this.gridResX;
        const resY = this.gridResY;

        const grid: (number | null)[][] = this.rawGrid.map(row => [...row]);
        const measured: boolean[][] = this.rawGrid.map(row => row.map(v => v !== null));
        const mask = this.insideMask;

        // Interpolation: fill null cells INSIDE the polygon by averaging neighbors
        if (this.interpolationEnabled) {
            for (let pass = 0; pass < 20; pass++) {
                let filled = false;
                for (let j = 0; j < resY; j++) {
                    for (let i = 0; i < resX; i++) {
                        if (grid[j][i] !== null || !mask[j][i]) continue;
                        let sum = 0;
                        let count = 0;
                        for (let dj = -1; dj <= 1; dj++) {
                            for (let di = -1; di <= 1; di++) {
                                if (di === 0 && dj === 0) continue;
                                const ni = i + di, nj = j + dj;
                                if (ni >= 0 && ni < resX && nj >= 0 && nj < resY && grid[nj][ni] !== null) {
                                    sum += grid[nj][ni];
                                    count++;
                                }
                            }
                        }
                        if (count >= 2) {
                            grid[j][i] = sum / count;
                            filled = true;
                        }
                    }
                }
                if (!filled) break;
            }
        }

        // Nullify cells outside the polygon
        for (let j = 0; j < resY; j++) {
            for (let i = 0; i < resX; i++) {
                if (!mask[j][i]) grid[j][i] = null;
            }
        }

        // Hachures : une case vide entourée de cases mesurées est estimée de
        // façon fiable, la hachurer ne ferait que moucheter la carte. On ne
        // hachure que les trous de plus d'une case.
        const hole = (j: number, i: number) => mask[j]?.[i] === true && !measured[j][i];
        const hatched = measured.map((row, j) => row.map((m, i) => !m && grid[j][i] !== null &&
            (hole(j - 1, i) || hole(j + 1, i) || hole(j, i - 1) || hole(j, i + 1))));

        this.gridData = { grid, measured, hatched, resX, resY };
    }

    // ── Règle virtuelle ──
    //
    // La règle est posée côté bosse (+) et promenée sur toute la zone dans 8
    // directions, sur une grille propre (voir RULE_CELLS_PER_LENGTH). Elle
    // repose sur les points hauts du profil, qui forment l'enveloppe convexe
    // supérieure de la portée ; la flèche est le plus grand jour mesuré entre
    // deux points d'appui, comme sous une règle réelle (DIN 18202 : Stichmaß
    // entre appuis). Le jour au-delà des appuis, là où la règle bascule dans
    // le vide, ne compte pas : il doublait la hauteur d'une bosse étroite.
    // Une position n'est retenue que si la règle porte sur des points à ses
    // deux bouts et sur au moins 70 % de sa longueur.

    private computeRule() {
        this.rule = null;
        const pts = this.keptPoints, poly = this.polyUV, stats = this.stats;
        if (!pts || !poly || !stats) return;

        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (const q of poly) {
            if (q.u < uMin) uMin = q.u; if (q.u > uMax) uMax = q.u;
            if (q.v < vMin) vMin = q.v; if (q.v > vMax) vMax = q.v;
        }
        const uRange = uMax - uMin, vRange = vMax - vMin;

        // Toute la zone : la règle couvre, sur chaque ligne, la zone d'un bord à l'autre.
        const wholeZone = this.ruleLength === 0;
        const L = wholeZone ? Math.hypot(uRange, vRange) : this.ruleLength;
        const density = pts.length / 3 / Math.max(stats.area, 1e-6);
        const cell = Math.max(
            L / RULE_CELLS_PER_LENGTH,
            Math.sqrt(RULE_POINTS_PER_CELL / density),
            Math.sqrt(uRange * vRange / RULE_MAX_CELLS)
        );
        const W = Math.round(L / cell) + 1;
        if (W - 1 < RULE_MIN_SAMPLES) {
            this.rule = { status: 'cells-too-coarse', cellSize: cell };
            return;
        }

        // Grille de la règle : médiane des splats de chaque case
        const resX = Math.max(1, Math.ceil(uRange / cell));
        const resY = Math.max(1, Math.ceil(vRange / cell));
        const buckets: number[][] = new Array(resX * resY);
        for (let k = 0; k < resX * resY; k++) buckets[k] = [];
        for (let k = 0; k < pts.length; k += 3) {
            const gi = Math.min(resX - 1, Math.floor((pts[k] - uMin) / cell));
            const gj = Math.min(resY - 1, Math.floor((pts[k + 1] - vMin) / cell));
            buckets[gj * resX + gi].push(pts[k + 2]);
        }
        let grid: (number | null)[][] = [];
        let filled = 0, filledPoints = 0;
        for (let j = 0; j < resY; j++) {
            const row: (number | null)[] = [];
            for (let i = 0; i < resX; i++) {
                const b = buckets[j * resX + i];
                if (b.length >= RULE_MIN_CELL_POINTS) {
                    row.push(median(b));
                    filled++;
                    filledPoints += b.length;
                } else {
                    row.push(null);
                }
            }
            grid.push(row);
        }
        this.removeSpikes(grid, resX, resY, RULE_SPIKE_MIN);

        // Lissage des tuiles, comme pour la carte. La moyenne porte alors sur
        // environ 4πσ² cases : le bruit d'une case baisse d'autant.
        let smoothedCells = 1;
        if (this.waveWidth > 0) {
            const sigma = this.waveWidth * WAVE_SIGMA_RATIO / cell;
            if (sigma >= WAVE_MIN_SIGMA_CELLS) {
                grid = smoothGrid(grid, resX, resY, sigma, sigma);
                smoothedCells = Math.max(1, 4 * Math.PI * sigma * sigma);
            }
        }

        // Bruit d'une case : celui des splats, divisé par √n (médiane de n splats)
        const cellNoise = filled > 0 ? stats.noise * 1.2533 / Math.sqrt(filledPoints / filled * smoothedCells) : 0;

        const edge = Math.max(1, Math.floor(W * 0.2));
        const minValid = Math.ceil(W * RULE_MIN_COVERAGE);
        const win: WindowResult = { gap: 0, a: 0, slope: 0, iGap: 0 };
        const fleches: number[] = [];
        const worst: { gap: number; at: Pick<RuleOk, 'start' | 'end' | 'gapSurface' | 'gapRule'> | null } = { gap: -1, at: null };
        let fits = false;

        for (let k = 0; k < RULE_DIRECTIONS; k++) {
            const angle = k * Math.PI / RULE_DIRECTIONS;
            const dx = Math.cos(angle), dy = Math.sin(angle);

            // s le long de la règle, t en travers
            let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
            for (const q of poly) {
                const s = q.u * dx + q.v * dy;
                const t = -q.u * dy + q.v * dx;
                if (s < s0) s0 = s; if (s > s1) s1 = s;
                if (t < t0) t0 = t; if (t > t1) t1 = t;
            }
            if (!wholeZone && s1 - s0 < L) continue;
            const start = s0;

            const ns = Math.floor((s1 - s0) / cell) + 1;
            if (wholeZone && ns - 1 < RULE_MIN_SAMPLES) continue;
            fits = true;

            const profile = new Float64Array(ns);
            const validPrefix = new Int32Array(ns + 1);
            const hull = new Int32Array(ns);

            for (let t = t0 + cell / 2; t < t1; t += cell) {
                let first = -1, last = -1;
                for (let i = 0; i < ns; i++) {
                    const s = s0 + i * cell;
                    const gi = Math.floor((s * dx - t * dy - uMin) / cell);
                    const gj = Math.floor((s * dy + t * dx - vMin) / cell);
                    const val = gi >= 0 && gi < resX && gj >= 0 && gj < resY ? grid[gj][gi] : null;
                    profile[i] = val === null ? NaN : val;
                    validPrefix[i + 1] = validPrefix[i] + (val === null ? 0 : 1);
                    if (val !== null) {
                        if (first < 0) first = i;
                        last = i;
                    }
                }

                const measure = (i0: number, i1: number) => {
                    measureWindow(profile, i0, i1, hull, win);
                    fleches.push(win.gap);
                    if (win.gap <= worst.gap) return;
                    worst.gap = win.gap;
                    const { a, slope } = win;
                    const ruleAt = (i: number) => profile[a] + slope * (i - a);
                    const point = (i: number, h: number): PlanePoint => {
                        const s = start + i * cell;
                        return { u: s * dx - t * dy, v: s * dy + t * dx, h };
                    };
                    worst.at = {
                        start: point(i0, ruleAt(i0)),
                        end: point(i1 - 1, ruleAt(i1 - 1)),
                        gapSurface: point(win.iGap, profile[win.iGap]),
                        gapRule: point(win.iGap, ruleAt(win.iGap))
                    };
                };

                if (wholeZone) {
                    // Une règle par ligne, d'un bord à l'autre de la zone. Les
                    // lignes trop courtes (coins de la zone) ne comptent pas.
                    if (first < 0) continue;
                    const span = last - first + 1;
                    if (span - 1 < Math.max(RULE_MIN_SAMPLES, (ns - 1) / 2)) continue;
                    if (validPrefix[last + 1] - validPrefix[first] < span * RULE_MIN_COVERAGE) continue;
                    measure(first, last + 1);
                    continue;
                }

                if (validPrefix[ns] < minValid) continue;
                for (let i0 = 0; i0 + W <= ns; i0++) {
                    const i1 = i0 + W;
                    if (validPrefix[i1] - validPrefix[i0] < minValid) continue;
                    if (validPrefix[i0 + edge] === validPrefix[i0]) continue;
                    if (validPrefix[i1] === validPrefix[i1 - edge]) continue;
                    measure(i0, i1);
                }
            }
        }

        if (!fits) {
            this.rule = { status: wholeZone ? 'cells-too-coarse' : 'zone-too-small', cellSize: cell };
        } else if (!worst.at) {
            this.rule = { status: 'no-data', cellSize: cell };
        } else {
            this.rule = {
                status: 'ok',
                worst: worst.gap,
                fleches: Float32Array.from(fleches).sort(),
                cellSize: cell,
                noiseFloor: RULE_NOISE_FACTOR * cellNoise,
                ...worst.at
            };
        }
    }

    // Part des positions de la règle dont la flèche dépasse la tolérance.
    private exceedPct(fleches: Float32Array): number {
        let lo = 0, hi = fleches.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (fleches[mid] <= this.tolerance) lo = mid + 1;
            else hi = mid;
        }
        return fleches.length > 0 ? (fleches.length - lo) / fleches.length * 100 : 0;
    }

    // ── Heatmap color mapping (diverging: blue → green → red) ──

    private deviationToColor(signedDeviation: number): { r: number; g: number; b: number } {
        const scale = this.colorScale;
        // Normalize to [-1, 1] and clamp
        const t = Math.max(-1, Math.min(1, signedDeviation / scale));

        if (t < 0) {
            // Negative (creux): blue (#3b82f6) → green (#4ade80)
            const s = -t; // 0..1
            return {
                r: Math.round(74 + s * (59 - 74)),
                g: Math.round(222 + s * (130 - 222)),
                b: Math.round(128 + s * (246 - 128))
            };
        }
        // Positive (bosse): green (#4ade80) → red (#ef4444)
        return {
            r: Math.round(74 + t * (239 - 74)),
            g: Math.round(222 + t * (68 - 222)),
            b: Math.round(128 + t * (68 - 128))
        };
    }

    // ── Panneau ──
    //
    // En-tête (réduire, nouvelle zone) et bandeau du verdict toujours visibles,
    // puis légende, carte et quatre onglets. Réduit, le panneau ne garde que
    // l'en-tête et le bandeau. Chaque réglage reconstruit le panneau, sauf le
    // compteur de tolérance, qui ne met à jour que le verdict : on peut ainsi
    // le maintenir enfoncé.

    private showPanel() {
        const scrollTop = this.panel?.scrollTop ?? 0;
        this.removePanel();
        if (!this.gridData || !this.stats) return;

        const data = this.gridData;

        this.panel = document.createElement('div');
        this.panel.id = 'flatnessPanel';
        this.panel.classList.toggle('collapsed', this.collapsed);
        this.panel.appendChild(this.createHeader());

        this.banner = document.createElement('div');
        this.banner.className = 'flatness-banner';
        this.panel.appendChild(this.banner);
        this.renderBanner();

        const body = document.createElement('div');
        body.className = 'flatness-body';
        body.appendChild(this.createLegend());

        // Heatmap canvas — match polygon aspect ratio. Hauteur plafonnée : une
        // zone en hauteur ne doit pas pousser les onglets hors de l'écran.
        const MAX_WIDTH = 288, MAX_HEIGHT = 220;
        const aspect = data.resX / data.resY;
        const width = Math.min(MAX_WIDTH, MAX_HEIGHT * aspect);
        this.heatmapCanvas = document.createElement('canvas');
        this.heatmapCanvas.className = 'flatness-map';
        this.heatmapCanvas.width = Math.round(width);
        this.heatmapCanvas.height = Math.round(width / aspect);
        body.appendChild(this.heatmapCanvas);
        this.drawHeatmap();

        body.appendChild(this.createTabs());
        this.panel.appendChild(body);

        // Insert into overlay
        this.overlay.appendChild(this.panel);
        this.panel.scrollTop = scrollTop;
    }

    private removePanel() {
        if (this.panel) {
            this.panel.remove();
            this.panel = null;
            this.heatmapCanvas = null;
            this.banner = null;
            this.ruleResults = null;
        }
    }

    private createHeader(): HTMLDivElement {
        const header = document.createElement('div');
        header.className = 'tool-header';

        const title = document.createElement('div');
        title.className = 'tool-title';
        title.textContent = 'Planéité';

        const actions = document.createElement('div');
        actions.className = 'tool-header-actions';

        const reset = document.createElement('button');
        reset.className = 'tool-btn';
        reset.textContent = 'Nouvelle zone';
        reset.addEventListener('click', () => this.clearAll());

        // Réduire / agrandir : le panneau garde l'en-tête et le verdict.
        const collapse = document.createElement('button');
        collapse.className = 'tool-icon-btn';
        const updateCollapse = () => {
            collapse.title = this.collapsed ? 'Agrandir le panneau' : 'Réduire le panneau';
            collapse.setAttribute('aria-label', collapse.title);
            collapse.setAttribute('aria-expanded', String(!this.collapsed));
            collapse.innerHTML = this.collapsed ?
                '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>' :
                '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4"/></svg>';
        };
        updateCollapse();
        collapse.addEventListener('click', () => {
            this.collapsed = !this.collapsed;
            storeText(COLLAPSED_STORAGE_KEY, this.collapsed ? '1' : '0');
            this.panel?.classList.toggle('collapsed', this.collapsed);
            updateCollapse();
        });

        actions.append(reset, collapse);
        header.append(title, actions);
        return header;
    }

    // Verdict de la règle et chiffres clés, visibles même panneau réduit.
    private renderBanner() {
        const banner = this.banner;
        const stats = this.stats;
        if (!banner || !stats) return;

        const rule = this.rule;
        banner.textContent = '';

        const main = document.createElement('div');
        main.className = 'flatness-banner-main';
        const dot = document.createElement('span');
        dot.className = 'flatness-dot';
        const text = document.createElement('span');
        if (rule?.status === 'ok') {
            const ok = rule.worst <= this.tolerance;
            const where = this.ruleLength === 0 ? 'sur la zone' : `sous ${this.ruleLabel(this.ruleLength)}`;
            banner.dataset.state = ok ? 'ok' : 'ko';
            text.textContent = `${ok ? 'Conforme' : 'Hors tolérance'} · flèche ${formatLength(rule.worst)} ${where}`;
        } else {
            banner.dataset.state = 'na';
            text.textContent = `Règle non calculée : ${this.ruleStatusText()}`;
        }
        main.append(dot, text);

        const sub = document.createElement('div');
        sub.className = 'flatness-banner-sub';
        const parts = [
            `tolérance ${formatTolerance(this.tolerance)}`,
            `creux ${formatLength(stats.hollow, true)}`,
            `bosse ${formatLength(stats.bump, true)}`
        ];
        if (rule?.status === 'ok' && this.tolerance < rule.noiseFloor) parts.push('peu fiable (bruit)');
        // Une ligne qui ne se coupe qu'entre deux éléments
        parts.forEach((part, i) => {
            if (i > 0) sub.append(' · ');
            const span = document.createElement('span');
            span.textContent = part;
            sub.appendChild(span);
        });

        banner.append(main, sub);
    }

    private ruleStatusText(): string {
        switch (this.rule?.status) {
            case 'zone-too-small': return 'zone plus courte que la règle';
            case 'cells-too-coarse': return 'relevé trop peu dense';
            default: return 'pas assez de points sous la règle';
        }
    }

    private createLegend(): HTMLDivElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'flatness-legend';

        const bar = document.createElement('div');
        bar.className = 'flatness-gradient';
        wrapper.appendChild(bar);

        const labels = document.createElement('div');
        labels.className = 'flatness-legend-labels';
        const scale = formatLength(this.colorScale);
        for (const text of [`creux −${scale}`, '0', `+${scale} bosse`]) {
            const span = document.createElement('span');
            span.textContent = text;
            labels.appendChild(span);
        }
        wrapper.appendChild(labels);

        const note = document.createElement('div');
        note.className = 'flatness-legend-note';
        note.textContent = `${this.deviationsTitle()} · ${this.bumpText()}`;
        wrapper.appendChild(note);

        return wrapper;
    }

    // ── Onglets ──

    private createTabs(): HTMLDivElement {
        const wrapper = document.createElement('div');
        const bar = document.createElement('div');
        bar.className = 'tool-tabs';
        bar.setAttribute('role', 'tablist');
        const content = document.createElement('div');
        content.className = 'tool-tab-content';
        content.setAttribute('role', 'tabpanel');

        const tabs: { id: FlatnessTab; label: string }[] = [
            { id: 'deviations', label: 'Écarts' },
            { id: 'rule', label: 'Règle' },
            { id: 'settings', label: 'Réglages' },
            { id: 'export', label: 'Export' }
        ];
        const buttons: HTMLButtonElement[] = [];
        const render = () => {
            tabs.forEach((tab, i) => {
                buttons[i].classList.toggle('active', tab.id === this.activeTab);
                buttons[i].setAttribute('aria-selected', String(tab.id === this.activeTab));
            });
            this.ruleResults = null;
            content.textContent = '';
            if (this.activeTab === 'rule') content.appendChild(this.createRuleTab());
            else if (this.activeTab === 'settings') content.appendChild(this.createSettingsTab());
            else if (this.activeTab === 'export') content.appendChild(this.createExportTab());
            else content.appendChild(this.createDeviationsTab());
        };

        for (const tab of tabs) {
            const button = document.createElement('button');
            button.className = 'tool-tab';
            button.textContent = tab.label;
            button.setAttribute('role', 'tab');
            button.addEventListener('click', () => {
                this.activeTab = tab.id;
                storeText(TAB_STORAGE_KEY, tab.id);
                render();
            });
            bar.appendChild(button);
            buttons.push(button);
        }
        render();

        wrapper.append(bar, content);
        return wrapper;
    }

    private createDeviationsTab(): HTMLDivElement {
        const stats = this.stats;
        const geo = this.gridGeom;
        const tab = document.createElement('div');

        tab.appendChild(createRow('Creux max', formatLength(stats.hollow, true), 'hollow'));
        tab.appendChild(createRow('Bosse max', formatLength(stats.bump, true), 'bump'));
        tab.appendChild(createRow('Amplitude', formatLength(stats.bump - stats.hollow)));
        tab.appendChild(createRow('Écart type', formatLength(stats.rms)));
        tab.appendChild(createRow('Surface', `${stats.area.toFixed(2).replace('.', ',')} m²`));
        tab.appendChild(createRow('Taille des cases', `${formatLength(geo.du)} × ${formatLength(geo.dv)}`));
        for (const row of [this.slopeRow(), this.levelRow()]) {
            if (row) tab.appendChild(createRow(row[0], row[1]));
        }
        if (stats.emptyPct >= 0.5) {
            const estimated = this.interpolationEnabled ? ' (hachurée)' : '';
            tab.appendChild(createRow(`Zone sans points${estimated}`, `${Math.round(stats.emptyPct)} %`));
        }

        const info = document.createElement('div');
        info.className = 'tool-info';
        const total = this.rawSplatCount + this.excludedSplatCount;
        const lines = [`${this.deviationsTitle()}.`];
        lines.push(`${this.rawSplatCount.toLocaleString('fr-FR')} points analysés`);
        if (this.excludedSplatCount > 0) {
            const pct = Math.round(this.excludedSplatCount / total * 100);
            lines.push(`${this.excludedSplatCount.toLocaleString('fr-FR')} hors épaisseur ignorés (${pct} %)`);
        }
        if (this.hiddenSplatCount > 0) {
            lines.push(`${this.hiddenSplatCount.toLocaleString('fr-FR')} splats derrière la surface écartés (reflets)`);
        }
        if (stats.spikeCells > 0) {
            lines.push(`${stats.spikeCells.toLocaleString('fr-FR')} cases isolées écartées (points flottants)`);
        }
        lines.push(`Bruit du relevé : ±${formatLength(stats.noise)}`);
        if (this.interpolationEnabled && stats.emptyPct >= 0.5) lines.push('Hachures : zones sans points, valeurs estimées');
        for (const line of lines) {
            const div = document.createElement('div');
            div.textContent = line;
            info.appendChild(div);
        }
        tab.appendChild(info);

        if (this.colorScale < stats.noise) {
            tab.appendChild(createNote('Échelle plus fine que le bruit du relevé : la carte montre surtout le bruit.', true));
        }
        return tab;
    }

    private createRuleTab(): HTMLDivElement {
        const tab = document.createElement('div');

        const lengths = RULE_LENGTHS.map(length => ({
            value: length,
            label: length === 0 ? 'Zone' : this.ruleLabel(length),
            title: length === 0 ? 'La règle traverse la zone d\'un bord à l\'autre (affaissement d\'un pan)' : undefined
        }));
        tab.appendChild(createField('Longueur de la règle', createSegmented(lengths, this.ruleLength, (length) => {
            this.ruleLength = length;
            storeNumber(RULE_LENGTH_STORAGE_KEY, length);
            this.computeRule();
            this.showPanel();
            this.global.app.renderNextFrame = true;
        })));

        // Tolérance : met à jour le verdict sans reconstruire le panneau.
        tab.appendChild(createField('Tolérance (jour maximal sous la règle)', createStepper({
            value: Math.round(this.tolerance * 10000) / 10,
            min: 0.5,
            max: 100,
            step: 0.5,
            unit: 'mm',
            label: 'Tolérance en millimètres',
            onChange: (mm) => {
                this.tolerance = mm / 1000;
                storeNumber(TOLERANCE_STORAGE_KEY, this.tolerance);
                this.renderBanner();
                this.renderRuleResults();
            }
        })));

        this.ruleResults = document.createElement('div');
        this.ruleResults.style.marginTop = '12px';
        tab.appendChild(this.ruleResults);
        this.renderRuleResults();
        return tab;
    }

    private renderRuleResults() {
        const el = this.ruleResults;
        const rule = this.rule;
        if (!el) return;
        el.textContent = '';

        const lengthText = this.ruleLabel(this.ruleLength);
        const wholeZone = this.ruleLength === 0;
        if (!rule || rule.status === 'no-data') {
            el.appendChild(createNote('Pas assez de points mesurés sous la règle pour conclure.'));
            return;
        }
        if (rule.status === 'zone-too-small') {
            el.appendChild(createNote(`La zone est plus courte que la règle (${lengthText}) dans toutes les directions.`));
            return;
        }
        if (rule.status === 'cells-too-coarse') {
            el.appendChild(createNote(`Relevé trop peu dense pour cette règle (${lengthText}) : le nuage ne permet que des cases de ${formatLength(rule.cellSize)}, il en faut ${RULE_MIN_SAMPLES} au moins sous la règle.`));
            return;
        }
        if (rule.status !== 'ok') return;

        el.appendChild(createRow(wholeZone ? 'Flèche max sur la zone' : `Flèche max sous ${lengthText}`, formatLength(rule.worst)));
        el.appendChild(createRow('Positions hors tolérance', `${Math.round(this.exceedPct(rule.fleches))} %`));
        el.appendChild(createRow('Flèche due au seul bruit', `≈ ${formatLength(rule.noiseFloor)}`));
        const how = wholeZone ? 'règle d\'un bord à l\'autre' : 'règle promenée';
        el.appendChild(createNote(`Trait blanc : position la plus défavorable (${how}, 8 directions, cases de ${formatLength(rule.cellSize)}).`));
        if (this.tolerance < rule.noiseFloor) {
            el.appendChild(createNote(`Tolérance plus fine que la flèche que produit le bruit du relevé (≈ ${formatLength(rule.noiseFloor)}) : verdict peu fiable.`, true));
        }
    }

    private createSettingsTab(): HTMLDivElement {
        const tab = document.createElement('div');

        // Plan de référence : seuls les choix qui ont un sens pour la zone.
        const titles: Record<ReferenceMode, [string, string]> = {
            mean: ['Plan moyen', 'Planéité : écarts au plan qui épouse au mieux la surface'],
            horizontal: ['Horizontal', 'Niveau : écarts à un plan horizontal passant par la hauteur médiane de la zone'],
            vertical: ['Vertical', 'Aplomb : écarts à un plan vertical passant par la position médiane de la zone']
        };
        const refs = this.availableReferences();
        const refField = createField('Plan de référence', refs.length > 1 ?
            createSegmented(refs.map(mode => ({ value: mode, label: titles[mode][0], title: titles[mode][1] })), this.activeReference(), (mode) => {
                this.reference = mode;
                this.applyReference();
                this.computeDeviations();
                this.showPanel();
                this.global.app.renderNextFrame = true;
            }) :
            createNote('Plan moyen : surface ni horizontale ni verticale (à plus de 10°).'));
        const slope = this.slopeRow();
        if (slope) refField.appendChild(createNote(`${slope[0]} : ${slope[1]}`));
        tab.appendChild(refField);

        // Échelle des couleurs : automatique, valeurs prédéfinies, puis curseur
        // logarithmique de 2 mm à 30 cm pour un réglage fin.
        const presetActive = SCALE_PRESETS.find(p => Math.abs(p - this.colorScale) < 1e-6);
        const scaleOptions = [
            { value: -1, label: 'Auto', title: 'Suit les écarts mesurés (98 % couverts)' },
            ...SCALE_PRESETS.map(p => ({ value: p, label: p < 0.01 ? `${Math.round(p * 1000)} mm` : `${Math.round(p * 100)} cm` }))
        ];
        let current: number | null = null;
        if (!this.colorScaleManual) current = -1;
        else if (presetActive !== undefined) current = presetActive;
        const scaleField = createField('Échelle des couleurs (±)', createSegmented(scaleOptions, current, (value) => {
            this.colorScaleManual = value >= 0;
            if (value >= 0) {
                this.colorScale = value;
                this.showPanel();
            } else {
                this.computeDeviations();
                this.showPanel();
            }
        }));
        const toSlider = (scale: number) => Math.log(scale / SCALE_MIN) / Math.log(SCALE_MAX / SCALE_MIN) * 100;
        const fromSlider = (value: number) => {
            const raw = SCALE_MIN * (SCALE_MAX / SCALE_MIN) ** (value / 100);
            // Arrondi lisible : 0,5 mm sous 1 cm, 1 mm sous 5 cm, 5 mm au-delà
            let q = 0.005;
            if (raw < 0.01) q = 0.0005;
            else if (raw < 0.05) q = 0.001;
            return Math.max(SCALE_MIN, Math.round(raw / q) * q);
        };
        scaleField.appendChild(createRange({
            min: 0,
            max: 100,
            step: 0.5,
            value: toSlider(this.colorScale),
            format: v => `± ${formatLength(fromSlider(v))}`,
            onCommit: (v) => {
                this.colorScale = fromSlider(v);
                this.colorScaleManual = true;
                this.showPanel();
            }
        }));
        tab.appendChild(scaleField);

        const bandField = createField('Épaisseur analysée autour du plan', createRange({
            min: MIN_BAND_CM,
            max: MAX_BAND_CM,
            step: 1,
            value: Math.round(this.bandHalfWidth * 100),
            format: v => `± ${v} cm`,
            onCommit: (v) => {
                const band = v / 100;
                if (band === this.bandHalfWidth) return;
                this.bandHalfWidth = band;
                this.computeDeviations();
                this.showPanel();
                this.global.app.renderNextFrame = true;
            }
        }));
        bandField.title = 'Les splats plus éloignés du plan moyen sont ignorés (objets posés, charpente, végétation…)';
        tab.appendChild(bandField);

        // Lissage des tuiles (ou d'une tôle ondulée)
        const waves = WAVE_WIDTHS.map(width => ({ value: width, label: width === 0 ? 'Non' : `${Math.round(width * 100)} cm` }));
        const waveField = createField('Lisser les tuiles', createSegmented(waves, this.waveWidth, (width) => {
            this.waveWidth = width;
            this.computeDeviations();
            this.showPanel();
            this.global.app.renderNextFrame = true;
        }));
        waveField.title = 'Efface l\'ondulation des tuiles ou d\'une tôle ondulée pour ne garder que la forme du pan. Choisissez la plus grande dimension visible d\'une tuile, souvent sa longueur (30 à 40 cm) : les recouvrements ondulent aussi.';
        if (this.waveWidth > 0 && this.ruleLength !== 0) {
            waveField.appendChild(createNote('Pour mesurer l\'affaissement d\'un pan, choisissez la règle « Zone » (onglet Règle).'));
        } else if (this.waveWidth === 0) {
            waveField.appendChild(createNote('Réglez sur la plus grande dimension visible d\'une tuile (souvent 30 à 40 cm).'));
        }
        tab.appendChild(waveField);

        const hidden = createSwitch('Ignorer les reflets', this.hiddenFilterEnabled, (enabled) => {
            this.hiddenFilterEnabled = enabled;
            this.computeDeviations();
            this.showPanel();
            this.global.app.renderNextFrame = true;
        });
        hidden.title = 'Un sol vitrifié, un carrelage brillant ou une vitre créent des splats fantômes derrière la surface (le reflet). Ils sont écartés : seule la couche visible depuis l\'observateur est mesurée.';
        tab.appendChild(hidden);

        tab.appendChild(createSwitch('Combler les trous', this.interpolationEnabled, (enabled) => {
            this.interpolationEnabled = enabled;
            this.postProcessGrid();
            this.showPanel();
        }));

        return tab;
    }

    private createExportTab(): HTMLDivElement {
        const tab = document.createElement('div');
        const addItem = (caption: string, description: string, onClick: (button: HTMLButtonElement) => void) => {
            const item = document.createElement('div');
            item.className = 'tool-export-item';
            const button = document.createElement('button');
            button.className = 'tool-btn block';
            button.textContent = caption;
            button.addEventListener('click', () => onClick(button));
            item.append(button, createNote(description));
            tab.appendChild(item);
        };
        addItem('Image PNG', 'Carte, légende, échelle et résultats sur une image, pour un rapport.', () => this.exportPng());
        addItem('Tableau CSV', 'Une ligne par case : position dans le repère affiché et écart en mm, pour Excel.', () => this.exportCsv());
        addItem('Copier le résumé', 'Résultats dans le presse-papier, à coller dans Excel ou Word.', button => this.copySummary(button));
        return tab;
    }

    private drawHeatmap() {
        if (this.heatmapCanvas) this.paintHeatmap(this.heatmapCanvas);
    }

    // Carte des écarts dans `canvas` (panneau ou export), avec la position la
    // plus défavorable de la règle.
    private paintHeatmap(canvas: HTMLCanvasElement) {
        if (!this.gridData) return;

        const data = this.gridData;
        const { resX, resY } = data;
        const dispW = canvas.width;
        const dispH = canvas.height;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(dispW, dispH);
        const pixels = imageData.data;
        const scaleX = dispW / resX;
        const scaleY = dispH / resY;

        for (let dj = 0; dj < dispH; dj++) {
            const gj = Math.min(Math.floor(dj / scaleY), resY - 1);
            for (let di = 0; di < dispW; di++) {
                const gi = Math.min(Math.floor(di / scaleX), resX - 1);
                const k = (dj * dispW + di) * 4;
                const val = data.grid[gj][gi];
                if (val === null) {
                    pixels[k] = 63;
                    pixels[k + 1] = 63;
                    pixels[k + 2] = 70;
                    pixels[k + 3] = 255;
                } else {
                    const c = this.deviationToColor(val);
                    // Cases interpolées : hachures claires, pour ne pas les
                    // confondre avec une mesure.
                    const hatch = data.hatched[gj][gi] && (di + dj) % 6 < 2;
                    pixels[k] = hatch ? (c.r + 255) >> 1 : c.r;
                    pixels[k + 1] = hatch ? (c.g + 255) >> 1 : c.g;
                    pixels[k + 2] = hatch ? (c.b + 255) >> 1 : c.b;
                    pixels[k + 3] = 255;
                }
            }
        }

        ctx.putImageData(imageData, 0, 0);

        // Position la plus défavorable de la règle
        const rule = this.rule;
        const geo = this.gridGeom;
        if (rule?.status !== 'ok' || !geo) return;
        const toCanvas = (p: PlanePoint) => ({
            x: (p.u - geo.uMin) / geo.du * scaleX,
            y: (p.v - geo.vMin) / geo.dv * scaleY
        });
        const a = toCanvas(rule.start), b = toCanvas(rule.end), g = toCanvas(rule.gapSurface);
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(g.x, g.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    private ruleLabel(length: number): string {
        if (length === 0) return 'toute la zone';
        return length < 1 ? `${Math.round(length * 100)} cm` : `${length} m`;
    }

    // Plan de référence en toutes lettres : « plan moyen », « plan horizontal ».
    private referenceName(): string {
        switch (this.activeReference()) {
            case 'horizontal': return 'plan horizontal';
            case 'vertical': return 'plan vertical';
            default: return 'plan moyen';
        }
    }

    // Titre des écarts : « Écarts au plan moyen (tuiles lissées) ».
    private deviationsTitle(): string {
        return `Écarts au ${this.referenceName()}${this.waveWidth > 0 ? ' (tuiles lissées)' : ''}`;
    }

    private bumpText(): string {
        return this.bumpTowards === 'up' ? 'Bosse = vers le haut' : 'Bosse = vers l\'observateur';
    }

    // Pente du plan moyen (sol, toiture) ou son faux aplomb (mur) :
    // « 0,8 % · 8 mm/m » pour une faible pente, « 35,0° · 70 % » au-delà.
    private slopeRow(): [string, string] | null {
        const slope = this.fittedSlope();
        if (!slope) return null;
        const num = (v: number, digits: number) => v.toFixed(digits).replace('.', ',');
        const pct = slope.ratio * 100;
        const mmPerM = slope.ratio * 1000;
        const value = slope.ratio < 0.2 ?
            `${num(pct, pct < 1 ? 2 : 1)} % · ${num(mmPerM, mmPerM < 10 ? 1 : 0)} mm/m` :
            `${num(slope.angle * 180 / Math.PI, 1)}° · ${num(pct, 0)} %`;
        if (slope.kind === 'slope') return ['Pente du plan moyen', value];
        // Sens du faux aplomb, sauf pour un mur d'aplomb au demi-millimètre par mètre près
        let lean = '';
        if (mmPerM >= 0.5) lean = slope.lean > 0 ? ', haut en arrière' : ', haut vers l\'observateur';
        return ['Faux aplomb du plan moyen', value + lean];
    }

    // Hauteur du plan horizontal de référence dans le repère affiché.
    private levelRow(): [string, string] | null {
        if (this.activeReference() !== 'horizontal' || !this.planeOrigin) return null;
        const coords = this.global.coords;
        const level = coords.toDisplay(this.planeOrigin);
        return ['Niveau de référence (médiane)', formatCoordsInline([level[2], 0, 0], coords.frameName, [coords.axisNames[2]])];
    }

    // ── Exports ──

    // Résumé de l'analyse, partagé par l'image et le presse-papier.
    private summarySections(): { title: string; rows: [string, string][] }[] {
        const stats = this.stats, geo = this.gridGeom, rule = this.rule, poly = this.polyUV;
        const coords = this.global.coords;

        let cu = 0, cv = 0;
        for (const q of poly) {
            cu += q.u / poly.length;
            cv += q.v / poly.length;
        }
        const center = coords.toDisplay(this.toWorld({ u: cu, v: cv, h: 0 }));

        const zone: [string, string][] = [
            ['Scène', sceneName()],
            ['Date', new Date().toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })],
            ['Centre de la zone', formatCoordsInline(center, coords.frameName, coords.axisNames)],
            ['Surface', `${stats.area.toFixed(2).replace('.', ',')} m²`],
            ['Plan de référence', this.referenceName()],
            ['Sens des écarts', this.bumpTowards === 'up' ? '+ = bosse vers le haut' : '+ = bosse vers l\'observateur']
        ];
        for (const row of [this.slopeRow(), this.levelRow()]) {
            if (row) zone.push(row);
        }

        const deviations: [string, string][] = [
            ['Creux max', formatLength(stats.hollow, true)],
            ['Bosse max', formatLength(stats.bump, true)],
            ['Amplitude', formatLength(stats.bump - stats.hollow)],
            ['Écart type', formatLength(stats.rms)],
            ['Zone sans points', `${Math.round(stats.emptyPct)} %`]
        ];

        const ruleRows: [string, string][] = [
            ['Règle', this.ruleLabel(this.ruleLength)],
            ['Tolérance', formatTolerance(this.tolerance)]
        ];
        if (rule?.status === 'ok') {
            ruleRows.push(
                ['Verdict', rule.worst <= this.tolerance ? 'Conforme' : 'Hors tolérance'],
                ['Flèche max', formatLength(rule.worst)],
                ['Positions hors tolérance', `${Math.round(this.exceedPct(rule.fleches))} %`],
                ['Flèche due au seul bruit', `≈ ${formatLength(rule.noiseFloor)}`]
            );
        } else {
            ruleRows.push(['Verdict', 'non calculé (voir le panneau)']);
        }

        const settings: [string, string][] = [
            ['Épaisseur analysée', `± ${formatLength(this.bandHalfWidth)}`],
            ['Lissage des tuiles', this.waveWidth > 0 ? formatLength(this.waveWidth) : 'non'],
            ['Taille des cases', `${formatLength(geo.du)} × ${formatLength(geo.dv)}`],
            ['Points analysés', this.rawSplatCount.toLocaleString('fr-FR')],
            ['Points hors épaisseur ignorés', this.excludedSplatCount.toLocaleString('fr-FR')],
            ['Reflets écartés (derrière la surface)', this.hiddenFilterEnabled ? this.hiddenSplatCount.toLocaleString('fr-FR') : 'filtre désactivé'],
            ['Cases isolées écartées', stats.spikeCells.toLocaleString('fr-FR')],
            ['Bruit du relevé', `± ${formatLength(stats.noise)}`]
        ];

        return [
            { title: 'Zone', rows: zone },
            { title: this.deviationsTitle(), rows: deviations },
            { title: 'Règle', rows: ruleRows },
            { title: 'Réglages et relevé', rows: settings }
        ];
    }

    private exportBaseName(): string {
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}h${pad(d.getMinutes())}`;
        return `planeite-${slugify(sceneName()) || 'scene'}-${stamp}`;
    }

    // Image de rapport : carte à gauche avec légende et échelle, résultats à droite.
    private exportPng() {
        const data = this.gridData, geo = this.gridGeom;
        if (!data || !geo || !this.stats) return;

        const sections = this.summarySections();
        const margin = 40, gap = 48, colW = 560, mapBox = 720, rowH = 24;
        const aspect = data.resX / data.resY;
        const mapW = aspect >= 1 ? mapBox : Math.round(mapBox * aspect);
        const mapH = aspect >= 1 ? Math.round(mapBox / aspect) : mapBox;
        const top = margin + 76;
        const colX = margin + mapBox + gap;
        const font = (size: number, weight = 400) => `${weight} ${size}px -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`;

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // Colonne de résultats ; une valeur trop longue passe à la ligne.
        const drawColumn = (draw: boolean) => {
            let y = top;
            for (const section of sections) {
                if (draw) {
                    ctx.font = font(13, 700);
                    ctx.fillStyle = '#71717a';
                    ctx.textAlign = 'left';
                    ctx.fillText(section.title.toUpperCase(), colX, y + 14);
                    ctx.fillStyle = '#e4e4e7';
                    ctx.fillRect(colX, y + 22, colW, 1);
                }
                y += 34;
                for (const [label, value] of section.rows) {
                    ctx.font = font(15);
                    const labelW = ctx.measureText(label).width;
                    ctx.font = font(15, 600);
                    const wrap = labelW + ctx.measureText(value).width + 16 > colW;
                    if (draw) {
                        ctx.font = font(15);
                        ctx.fillStyle = '#52525b';
                        ctx.textAlign = 'left';
                        ctx.fillText(label, colX, y + 16);
                        ctx.font = font(15, 600);
                        ctx.fillStyle = '#18181b';
                        if (label === 'Verdict') ctx.fillStyle = value === 'Conforme' ? '#4d7c0f' : '#b91c1c';
                        ctx.textAlign = 'right';
                        ctx.fillText(value, colX + colW, y + 16 + (wrap ? 20 : 0));
                    }
                    y += rowH + (wrap ? 20 : 0);
                }
                y += 16;
            }
            return y;
        };

        const legendH = 150;
        canvas.width = margin * 2 + mapBox + gap + colW;
        canvas.height = Math.max(top + mapH + legendH, drawColumn(false)) + margin;

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // En-tête
        ctx.textAlign = 'left';
        ctx.fillStyle = '#18181b';
        ctx.font = font(26, 700);
        ctx.fillText(`Planéité — ${sceneName()}`, margin, margin + 26);
        ctx.fillStyle = '#71717a';
        ctx.font = font(15);
        ctx.fillText(`${new Date().toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })} · ${this.global.coords.frameName}`, margin, margin + 52);

        // Carte
        const map = document.createElement('canvas');
        map.width = mapW;
        map.height = mapH;
        this.paintHeatmap(map);
        ctx.drawImage(map, margin, top);
        ctx.strokeStyle = '#d4d4d8';
        ctx.lineWidth = 1;
        ctx.strokeRect(margin + 0.5, top + 0.5, mapW - 1, mapH - 1);

        // Légende
        let y = top + mapH + 24;
        const barW = 320;
        const gradient = ctx.createLinearGradient(margin, 0, margin + barW, 0);
        gradient.addColorStop(0, '#3b82f6');
        gradient.addColorStop(0.5, '#4ade80');
        gradient.addColorStop(1, '#ef4444');
        ctx.fillStyle = gradient;
        ctx.fillRect(margin, y, barW, 14);
        y += 32;
        ctx.font = font(13);
        ctx.fillStyle = '#52525b';
        const scale = formatLength(this.colorScale);
        ctx.textAlign = 'left';
        ctx.fillText(`creux −${scale}`, margin, y);
        ctx.textAlign = 'center';
        ctx.fillText('0', margin + barW / 2, y);
        ctx.textAlign = 'right';
        ctx.fillText(`+${scale} bosse`, margin + barW, y);

        ctx.textAlign = 'left';
        ctx.fillStyle = '#71717a';
        const notes = [
            `${this.deviationsTitle()}. ${this.bumpText()}.`,
            'Carte vue depuis le point de vue du calcul. Trait blanc : position la plus défavorable de la règle.'
        ];
        if (this.waveWidth > 0) notes.push(`Ondulation de ${formatLength(this.waveWidth)} lissée (tuiles).`);
        if (this.interpolationEnabled && this.stats.emptyPct >= 0.5) notes.push('Hachures : zones sans points, valeurs estimées.');
        for (const note of notes) {
            y += 20;
            ctx.fillText(note, margin, y);
        }

        // Échelle graphique, sous la carte à droite
        const metersPerPx = geo.du * data.resX / mapW;
        const nice = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100];
        const length = nice.filter(l => l / metersPerPx <= mapW * 0.3).pop() ?? nice[0];
        const px = length / metersPerPx;
        const sx = margin + mapW - px, sy = top + mapH + 28;
        ctx.strokeStyle = '#18181b';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx, sy - 5);
        ctx.lineTo(sx, sy);
        ctx.lineTo(sx + px, sy);
        ctx.lineTo(sx + px, sy - 5);
        ctx.stroke();
        ctx.font = font(13);
        ctx.fillStyle = '#18181b';
        ctx.textAlign = 'center';
        ctx.fillText(length < 1 ? `${Math.round(length * 100)} cm` : `${length} m`, sx + px / 2, sy + 18);

        drawColumn(true);

        canvas.toBlob((blob) => {
            if (blob) downloadBlob(blob, `${this.exportBaseName()}.png`);
        }, 'image/png');
    }

    // Une ligne par case de la carte : position sur la surface dans le repère
    // affiché (celui du panneau Point) et écart au plan. Séparateur « ; » et
    // décimale de la langue de l'interface, pour Excel.
    private exportCsv() {
        const data = this.gridData, geo = this.gridGeom;
        if (!data || !geo) return;

        const coords = this.global.coords;
        const decimal = new Intl.NumberFormat(getLocale()).formatToParts(1.5).find(part => part.type === 'decimal')?.value ?? '.';
        const num = (v: number, digits: number) => v.toFixed(digits).replace('.', decimal);

        const rows: string[][] = [[
            'i', 'j', 'u (m)', 'v (m)',
            ...coords.axisNames.map(axis => `${axis} (m, ${coords.frameName})`),
            'écart (mm)', 'donnée'
        ]];
        for (let j = 0; j < data.resY; j++) {
            for (let i = 0; i < data.resX; i++) {
                const value = data.grid[j][i];
                if (value === null) continue;
                const u = geo.uMin + (i + 0.5) * geo.du;
                const v = geo.vMin + (j + 0.5) * geo.dv;
                const p = coords.toDisplay(this.toWorld({ u, v, h: value }));
                rows.push([
                    String(i), String(j), num(u, 3), num(v, 3),
                    ...coordsForClipboard(p),
                    num(value * 1000, 1),
                    data.measured[j][i] ? 'mesurée' : 'estimée'
                ]);
            }
        }

        const text = `\uFEFF${rows.map(r => r.join(';')).join('\r\n')}`;
        downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), `${this.exportBaseName()}.csv`);
    }

    private copySummary(button: HTMLButtonElement) {
        const rows: string[][] = [];
        for (const section of this.summarySections()) {
            rows.push([section.title, '']);
            for (const [label, value] of section.rows) rows.push([label, value]);
        }
        const caption = button.textContent;
        copyTable(rows).then((ok) => {
            button.textContent = ok ? 'Copié ✓' : 'Copie impossible';
            setTimeout(() => {
                button.textContent = caption;
            }, 1500);
        });
    }

    // ── Render loop (overlay canvas) ──

    private render() {
        if (!this.drawCanvas) return;

        const dpr = window.devicePixelRatio || 1;
        const width = window.innerWidth;
        const height = window.innerHeight;

        if (this.drawCanvas.width !== width * dpr || this.drawCanvas.height !== height * dpr) {
            this.drawCanvas.width = width * dpr;
            this.drawCanvas.height = height * dpr;
            this.drawCanvas.style.width = `${width}px`;
            this.drawCanvas.style.height = `${height}px`;
        }

        const ctx = this.drawCanvas.getContext('2d');
        ctx.clearRect(0, 0, this.drawCanvas.width, this.drawCanvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        if (this.currentPoints.length > 0) {
            this.drawPolygon(ctx, this.currentPoints, this.state === 'closed');
        }

        if (this.state === 'closed') {
            this.drawRule(ctx);
        }
    }

    // Règle la plus défavorable, dans la vue : la règle, le jour sous la règle
    // et la valeur de la flèche.
    private drawRule(ctx: CanvasRenderingContext2D) {
        const rule = this.rule;
        if (rule?.status !== 'ok' || !this.planeOrigin || this.pointerHandler.isDragging) return;
        // Zone modifiée, calcul en attente : la règle affichée serait périmée.
        if (this.recomputeTimer) return;

        const camera = this.global.camera;
        const a = worldToScreen(camera, this.toWorld(rule.start));
        const b = worldToScreen(camera, this.toWorld(rule.end));
        const gs = worldToScreen(camera, this.toWorld(rule.gapSurface));
        const gr = worldToScreen(camera, this.toWorld(rule.gapRule));
        if (a.behind || b.behind || gs.behind || gr.behind) return;

        ctx.lineCap = 'round';
        for (const [color, width] of [['rgba(0, 0, 0, 0.8)', 6], ['#ffffff', 3]] as const) {
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
        }

        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(gr.x, gr.y);
        ctx.lineTo(gs.x, gs.y);
        ctx.stroke();

        const text = `flèche ${formatLength(rule.worst)}`;
        ctx.font = '13px Arial';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const metrics = ctx.measureText(text);
        const x = gr.x + 10, y = gr.y - 14;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.beginPath();
        ctx.roundRect(x - 6, y - 10, metrics.width + 12, 20, 4);
        ctx.fill();
        ctx.fillStyle = '#fbbf24';
        ctx.fillText(text, x, y);
    }

    private drawPolygon(ctx: CanvasRenderingContext2D, points: Vec3[], closed: boolean) {
        const camera = this.global.camera;
        const screenPoints = points.map(p => worldToScreen(camera, p));
        const allVisible = screenPoints.every(s => !s.behind);
        if (!allVisible) return;

        // Draw filled polygon
        if (closed && screenPoints.length >= 3) {
            ctx.beginPath();
            ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
            for (let i = 1; i < screenPoints.length; i++) {
                ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
            }
            ctx.closePath();
            ctx.fillStyle = accentRgba(0.2);
            ctx.fill();
        }

        // Draw edges
        ctx.strokeStyle = ACCENT_COLOR;
        ctx.lineWidth = 2;
        for (let i = 0; i < screenPoints.length - 1; i++) {
            ctx.beginPath();
            ctx.moveTo(screenPoints[i].x, screenPoints[i].y);
            ctx.lineTo(screenPoints[i + 1].x, screenPoints[i + 1].y);
            ctx.stroke();
        }

        // Close line
        if (closed && screenPoints.length >= 3) {
            ctx.beginPath();
            ctx.moveTo(screenPoints[screenPoints.length - 1].x, screenPoints[screenPoints.length - 1].y);
            ctx.lineTo(screenPoints[0].x, screenPoints[0].y);
            ctx.stroke();
        }

        // Preview line to cursor
        if (!closed && this.state === 'placing' && screenPoints.length > 0) {
            const last = screenPoints[screenPoints.length - 1];
            ctx.beginPath();
            ctx.moveTo(last.x, last.y);
            ctx.lineTo(this.pointerHandler.mouseX, this.pointerHandler.mouseY);
            ctx.setLineDash([6, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Draw pins
        for (let i = 0; i < screenPoints.length; i++) {
            const sp = screenPoints[i];
            const isSelected = closed && i === this.pointerHandler.selectedIndex;

            // Highlight first point when placing and >= 3 points
            const isSnapTarget = !closed && this.state === 'placing' && i === 0 && points.length >= 3;

            const pinRadius = isSelected || isSnapTarget ? 8 : 6;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, pinRadius, 0, Math.PI * 2);
            ctx.fillStyle = isSelected || isSnapTarget ? '#FFFFFF' : ACCENT_COLOR;
            ctx.fill();
            ctx.strokeStyle = isSelected || isSnapTarget ? ACCENT_COLOR : '#FFFFFF';
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        // Draw gizmo on selected point
        if (closed && this.pointerHandler.selectedIndex >= 0) {
            const selIdx = this.pointerHandler.selectedIndex;
            if (selIdx < points.length) {
                this.pointerHandler.renderGizmo(ctx, camera, points[selIdx]);
            }
        }

        // Draw distance labels on edges
        for (let i = 0; i < screenPoints.length - 1; i++) {
            drawEdgeLabel(ctx, points[i], points[i + 1], screenPoints[i], screenPoints[i + 1]);
        }
        if (closed && screenPoints.length >= 3) {
            const last = screenPoints.length - 1;
            drawEdgeLabel(ctx, points[last], points[0], screenPoints[last], screenPoints[0]);
        }
    }
}

export { FlatnessTool };
