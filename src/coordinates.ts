// ARTLIGHT (TKT-224)
//
// Conversion des points du moteur vers le repère affiché à l'utilisateur.
// Voir la spec « Coordonnées et repères » (TKT-114).
//
// Le moteur travaille en Y vers le haut. Le repère « source » est celui du
// scan : X = Est, Y = Nord, Z = Haut. Avec le pipeline actuel (.lcc converti
// par `splat-transform -r 90,0,0`, puis 180° sur Z au chargement dans
// index.ts), un point (E, N, H) du .lcc arrive dans le moteur en (−E, H, N).
// La matrice par défaut défait cet enchaînement. Une scène issue d'un autre
// pipeline déclare la sienne dans `settings.coordinates.sourceFromWorld`.
//
// TKT-226 : l'utilisateur peut choisir un point comme zéro. Les coordonnées
// affichées deviennent alors relatif = R · (source − zéro) + valeur saisie,
// R étant l'identité ou une rotation autour de Z (axe X orienté par un 2e
// point). Le zéro est mémorisé par scène dans le navigateur.

import type { EventHandler, Vec3 } from 'playcanvas';

import { getLocale, localize } from './localization';
import type { Coordinates, Mat3Rows } from './settings';

type Triple = [number, number, number];

// Zéro utilisateur, exprimé dans le repère source.
type UserZero = {
    origin: Triple;         // point choisi comme zéro
    angle: number;          // orientation de l'axe X, en radians (0 = X source)
    known: Triple;          // coordonnées saisies pour ce point (0 par défaut)
};

// Écart horizontal minimal entre le zéro et le point qui oriente X.
const MIN_AXIS_DISTANCE = 0.01;

const STORAGE_PREFIX = 'artlight.zero:';

const isTriple = (v: unknown): v is Triple => {
    return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
};

const invert3 = (m: Mat3Rows): Mat3Rows => {
    const [[a, b, c], [d, e, f], [g, h, i]] = m;
    const A = e * i - f * h;
    const B = f * g - d * i;
    const C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [
        [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
        [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
        [C / det, (b * g - a * h) / det, (a * e - b * d) / det]
    ];
};

const DEFAULT_SOURCE_FROM_WORLD: Mat3Rows = [
    [-1, 0, 0],
    [0, 0, 1],
    [0, 1, 0]
];

/**
 * Passage du repère du moteur au repère affiché. Une seule instance par scène
 * (Global.coords) : le zéro est partagé par tous les outils.
 */
class CoordinateSystem {
    private m: Mat3Rows;

    private mInv: Mat3Rows;

    private events: EventHandler | null;

    private storageKey: string | null;

    private _zero: UserZero | null = null;

    /**
     * @param {Coordinates} [coordinates] - Bloc `coordinates` du settings.json.
     * @param {EventHandler} [events] - Reçoit `coords:changed` à chaque changement de zéro.
     * @param {string} [storageKey] - Identifiant de la scène (URL du contenu) pour mémoriser le zéro.
     */
    constructor(coordinates?: Coordinates, events?: EventHandler, storageKey?: string) {
        this.m = coordinates?.sourceFromWorld ?? DEFAULT_SOURCE_FROM_WORLD;
        this.mInv = invert3(this.m);
        this.events = events ?? null;
        this.storageKey = storageKey ? STORAGE_PREFIX + storageKey : null;
        this.load();
    }

    /**
     * Nom du repère affiché à côté des coordonnées : « Local » pour le repère
     * source, « Relatif » quand un zéro est défini. TKT-227 ajoutera le
     * géoréférencé.
     *
     * @returns {string} Nom localisé du repère.
     */
    get frameName(): string {
        return localize(this._zero ? 'artlight.coords.frame-relative' : 'artlight.coords.frame-local');
    }

    /**
     * @returns {UserZero | null} Zéro actif, ou null pour le repère source.
     */
    get zero(): UserZero | null {
        return this._zero;
    }

    /**
     * Point du moteur → repère source.
     *
     * @param {Vec3} p - Point dans le repère du moteur.
     * @returns {Triple} Coordonnées dans le repère source.
     */
    toSource(p: Vec3): Triple {
        return this.apply(p.x, p.y, p.z);
    }

    /**
     * Point du moteur → repère affiché (source, ou relatif au zéro).
     *
     * @param {Vec3} p - Point dans le repère du moteur.
     * @returns {Triple} Coordonnées à afficher.
     */
    toDisplay(p: Vec3): Triple {
        const s = this.toSource(p);
        const z = this._zero;
        if (!z) return s;
        const [x, y, h] = this.rotate(s[0] - z.origin[0], s[1] - z.origin[1], s[2] - z.origin[2]);
        return [x + z.known[0], y + z.known[1], h + z.known[2]];
    }

    /**
     * Écart entre deux points du moteur (b − a) → écart dans le repère affiché.
     * Seule l'orientation du zéro compte : les distances ne changent pas.
     *
     * @param {Vec3} a - Point de départ, repère du moteur.
     * @param {Vec3} b - Point d'arrivée, repère du moteur.
     * @returns {Triple} Écart dans le repère affiché.
     */
    deltaToDisplay(a: Vec3, b: Vec3): Triple {
        const [x, y, z] = this.apply(b.x - a.x, b.y - a.y, b.z - a.z);
        return this.rotate(x, y, z);
    }

    /**
     * Prend un point du modèle comme zéro. L'orientation est remise à zéro,
     * les coordonnées saisies aussi.
     *
     * @param {Vec3} p - Point dans le repère du moteur.
     */
    setZero(p: Vec3) {
        this._zero = { origin: this.toSource(p), angle: 0, known: [0, 0, 0] };
        this.changed();
    }

    /**
     * Oriente l'axe X du zéro vers un 2e point, par une rotation autour de la
     * verticale : ce point aura Y = 0.
     *
     * @param {Vec3} p - Point dans le repère du moteur.
     * @returns {boolean} false s'il n'y a pas de zéro ou si le point est à la
     * verticale du zéro (direction indéterminée).
     */
    orientX(p: Vec3): boolean {
        const z = this._zero;
        if (!z) return false;
        const s = this.toSource(p);
        const dx = s[0] - z.origin[0];
        const dy = s[1] - z.origin[1];
        if (Math.hypot(dx, dy) < MIN_AXIS_DISTANCE) return false;
        z.angle = Math.atan2(dy, dx);
        this.changed();
        return true;
    }

    /**
     * Coordonnées réelles du point zéro (repère d'altitude connu, par exemple).
     *
     * @param {Triple} known - Valeurs affichées pour le point zéro.
     */
    setKnown(known: Triple) {
        if (!this._zero || !isTriple(known)) return;
        this._zero.known = [...known];
        this.changed();
    }

    /**
     * Revient au repère source.
     */
    clearZero() {
        if (!this._zero) return;
        this._zero = null;
        this.changed();
    }

    /**
     * Repère affiché vu du moteur, pour dessiner le zéro dans la scène.
     *
     * @returns {{ origin: Triple, axes: Triple[] } | null} Origine et
     * direction unitaire de chaque axe affiché (X, Y, Z), dans le repère du
     * moteur. null sans zéro.
     */
    zeroInWorld(): { origin: Triple, axes: Triple[] } | null {
        const z = this._zero;
        if (!z) return null;
        const c = Math.cos(z.angle);
        const s = Math.sin(z.angle);
        // Axes affichés exprimés dans le repère source (colonnes de Rᵀ).
        const sourceAxes: Triple[] = [[c, s, 0], [-s, c, 0], [0, 0, 1]];
        const toWorld = (v: Triple) => this.applyMatrix(this.mInv, v[0], v[1], v[2]);
        const axes = sourceAxes.map((v) => {
            const w = toWorld(v);
            const len = Math.hypot(w[0], w[1], w[2]) || 1;
            return [w[0] / len, w[1] / len, w[2] / len] as Triple;
        });
        return { origin: toWorld(z.origin), axes };
    }

    // R · v : rotation de −angle autour de Z, pour que X pointe vers le 2e point.
    private rotate(x: number, y: number, z: number): Triple {
        const angle = this._zero?.angle ?? 0;
        if (angle === 0) return [x, y, z];
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        return [c * x + s * y, -s * x + c * y, z];
    }

    private changed() {
        this.save();
        this.events?.fire('coords:changed');
    }

    private load() {
        if (!this.storageKey) return;
        try {
            const raw = localStorage.getItem(this.storageKey);
            if (!raw) return;
            const data = JSON.parse(raw);
            if (isTriple(data?.origin) && isTriple(data?.known) && Number.isFinite(data?.angle)) {
                this._zero = { origin: data.origin, angle: data.angle, known: data.known };
            }
        } catch {
            // stockage indisponible ou valeur illisible : repère source
        }
    }

    private save() {
        if (!this.storageKey) return;
        try {
            if (this._zero) {
                localStorage.setItem(this.storageKey, JSON.stringify(this._zero));
            } else {
                localStorage.removeItem(this.storageKey);
            }
        } catch {
            // stockage indisponible (navigation privée, quota) : zéro non mémorisé
        }
    }

    private apply(x: number, y: number, z: number): Triple {
        return this.applyMatrix(this.m, x, y, z);
    }

    private applyMatrix(m: Mat3Rows, x: number, y: number, z: number): Triple {
        return [
            m[0][0] * x + m[0][1] * y + m[0][2] * z,
            m[1][0] * x + m[1][1] * y + m[1][2] * z,
            m[2][0] * x + m[2][1] * y + m[2][2] * z
        ];
    }
}

// Noms des axes du repère affiché.
const AXES = ['X', 'Y', 'Z'];

// Toujours en mètres, au millimètre.
const DECIMALS = 3;

// Arrondi au mm, sans « -0.000 » pour un écart de l'ordre de 1e-12 (le point
// zéro doit afficher 0.000 · 0.000 · 0.000).
const toFixedMm = (v: number): string => {
    const r = Math.round(v * 10 ** DECIMALS) / 10 ** DECIMALS;
    return (r === 0 ? 0 : r).toFixed(DECIMALS);
};

/**
 * Composante de coordonnée : toujours en mètres, au millimètre.
 *
 * @param {number} v - Valeur en mètres.
 * @returns {string} Valeur formatée.
 */
const formatCoordinate = (v: number): string => {
    const text = toFixedMm(v);
    return `${text.startsWith('-') ? '' : ' '}${text} m`;
};

/**
 * Lignes « X … / Y … / Z … » prêtes à afficher.
 *
 * @param {Triple} c - Coordonnées à afficher.
 * @returns {string[]} Une ligne par axe.
 */
const formatCoords = (c: Triple): string[] => {
    return AXES.map((axis, i) => `${axis} ${formatCoordinate(c[i])}`);
};

/**
 * Coordonnées sur une ligne, repère en tête s'il est fourni :
 * « Local · X 12.345 · Y -3.210 · Z 1.050 m ». Mêmes valeurs que formatCoords().
 *
 * @param {Triple} c - Coordonnées à afficher.
 * @param {string} [frame] - Nom du repère (CoordinateSystem.frameName).
 * @returns {string} Libellé d'une ligne.
 */
const formatCoordsInline = (c: Triple, frame?: string): string => {
    const values = AXES.map((axis, i) => `${axis} ${toFixedMm(c[i])}`);
    return `${(frame ? [frame, ...values] : values).join(' · ')} m`;
};

/**
 * Valeurs d'un point pour le presse-papier, une chaîne par axe, sans unité.
 * Le séparateur décimal suit la langue de l'interface (virgule en français),
 * sans quoi Excel lit « 9.138 » comme du texte ou une date.
 *
 * @param {Triple} c - Coordonnées à copier.
 * @returns {string[]} Une valeur par axe.
 */
const coordsForClipboard = (c: Triple): string[] => {
    const parts = new Intl.NumberFormat(getLocale()).formatToParts(1.5);
    const decimal = parts.find(part => part.type === 'decimal')?.value ?? '.';
    return c.map(v => toFixedMm(v).replace('.', decimal));
};

export {
    CoordinateSystem,
    formatCoordinate,
    formatCoords,
    formatCoordsInline,
    coordsForClipboard,
    DEFAULT_SOURCE_FROM_WORLD
};
export type { Triple, UserZero };
