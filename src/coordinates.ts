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
//
// TKT-227 : une scène géoréférencée (`epsg` ≠ 0 et `offset` dans settings.json)
// affiche geo = source + offset, calculé en double ici, jamais sur le GPU. Les
// scènes en UTM peuvent basculer en Lambert-93 (proj4js) ; ce choix est
// mémorisé dans le navigateur pour toutes les scènes. H n'est pas converti :
// c'est la hauteur du .lcc (ellipsoïdale par défaut, voir `heightRef`).

import type { EventHandler, Vec3 } from 'playcanvas';
import proj4 from 'proj4';

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

// Noms des axes du repère affiché : local ou relatif, géoréférencé.
const AXES = ['X', 'Y', 'Z'];

const GEO_AXES = ['E', 'N', 'H'];

// Système affiché pour une scène géoréférencée : celui du .lcc, ou Lambert-93.
type Projection = 'native' | 'lambert93';

const PROJECTION_STORAGE_KEY = 'artlight.projection';

const LAMBERT93 = 2154;

const LAMBERT93_DEF = '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

// Zone UTM WGS84 d'un code EPSG (326zz nord, 327zz sud), null sinon.
const utmZone = (epsg: number): { zone: number, south: boolean } | null => {
    const zone = epsg % 100;
    if (zone < 1 || zone > 60) return null;
    if (epsg - zone === 32600) return { zone, south: false };
    if (epsg - zone === 32700) return { zone, south: true };
    return null;
};

// Définition proj4 des systèmes gérés, null pour les autres.
const projDefinition = (epsg: number): string | null => {
    if (epsg === LAMBERT93) return LAMBERT93_DEF;
    const utm = utmZone(epsg);
    return utm ? `+proj=utm +zone=${utm.zone}${utm.south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs` : null;
};

// Nom court du système : « UTM 32N », « Lambert-93 », sinon « EPSG:xxxx ».
const epsgName = (epsg: number): string => {
    if (epsg === LAMBERT93) return 'Lambert-93';
    const utm = utmZone(epsg);
    return utm ? `UTM ${utm.zone}${utm.south ? 'S' : 'N'}` : `EPSG:${epsg}`;
};

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

const loadProjection = (): Projection => {
    try {
        return localStorage.getItem(PROJECTION_STORAGE_KEY) === 'lambert93' ? 'lambert93' : 'native';
    } catch {
        return 'native';
    }
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

    // Géoréférencement, null pour un modèle local.
    private geo: { epsg: number, offset: Triple, heightRef: 'ellipsoid' | 'ngf' } | null;

    // Système du .lcc → Lambert-93, null si la conversion n'est pas proposée.
    private toLambert93: proj4.Converter | null = null;

    private _projection: Projection;

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

        const epsg = coordinates?.epsg ?? 0;
        const offset = coordinates?.offset;
        this.geo = epsg !== 0 && isTriple(offset) ?
            { epsg, offset: [...offset], heightRef: coordinates.heightRef ?? 'ellipsoid' } :
            null;
        const def = this.geo ? projDefinition(epsg) : null;
        if (def && epsg !== LAMBERT93) {
            this.toLambert93 = proj4(def, LAMBERT93_DEF);
        }
        this._projection = loadProjection();

        this.load();
    }

    /**
     * Nom du repère affiché à côté des coordonnées : « Relatif » quand un zéro
     * est défini, sinon le système géoréférencé (« UTM 32N », « Lambert-93 »),
     * sinon « Local ».
     *
     * @returns {string} Nom localisé du repère.
     */
    get frameName(): string {
        if (this._zero) return localize('artlight.coords.frame-relative');
        if (this.geo) return this.lambert93 ? epsgName(LAMBERT93) : epsgName(this.geo.epsg);
        return localize('artlight.coords.frame-local');
    }

    /**
     * @returns {string[]} Noms des 3 axes affichés : E, N, H en géoréférencé,
     * X, Y, Z en local ou relatif au zéro.
     */
    get axisNames(): string[] {
        return this.geo && !this._zero ? GEO_AXES : AXES;
    }

    /**
     * @returns {string | null} Nom du système du .lcc (« UTM 32N »), null pour
     * un modèle local.
     */
    get nativeName(): string | null {
        return this.geo ? epsgName(this.geo.epsg) : null;
    }

    /**
     * @returns {'ellipsoid' | 'ngf' | null} Ce que représente H, null pour un
     * modèle local.
     */
    get heightRef(): 'ellipsoid' | 'ngf' | null {
        return this.geo?.heightRef ?? null;
    }

    /**
     * @returns {boolean} true si la scène peut s'afficher en Lambert-93 sans
     * l'être déjà.
     */
    get canUseLambert93(): boolean {
        return this.toLambert93 !== null;
    }

    /**
     * Choisit le système affiché pour les scènes géoréférencées, mémorisé pour
     * toutes les scènes.
     *
     * @param {Projection} value - 'native' (système du .lcc) ou 'lambert93'.
     */
    set projection(value: Projection) {
        if (value === this._projection) return;
        this._projection = value;
        try {
            localStorage.setItem(PROJECTION_STORAGE_KEY, value);
        } catch {
            // stockage indisponible : choix valable pour cette page seulement
        }
        this.events?.fire('coords:changed');
    }

    /**
     * @returns {Projection} Système choisi par l'utilisateur.
     */
    get projection(): Projection {
        return this._projection;
    }

    // Conversion Lambert-93 active pour cette scène.
    private get lambert93(): boolean {
        return this._projection === 'lambert93' && this.toLambert93 !== null;
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
     * Point du moteur → repère affiché (relatif au zéro, géoréférencé ou source).
     *
     * @param {Vec3} p - Point dans le repère du moteur.
     * @returns {Triple} Coordonnées à afficher.
     */
    toDisplay(p: Vec3): Triple {
        const s = this.toSource(p);
        const z = this._zero;
        if (!z) return this.geo ? this.toGeo(s) : s;
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
        // Lambert-93 : la projection déforme légèrement les écarts, on prend
        // la différence des coordonnées affichées.
        if (!this._zero && this.lambert93) {
            const ga = this.toDisplay(a);
            const gb = this.toDisplay(b);
            return [gb[0] - ga[0], gb[1] - ga[1], gb[2] - ga[2]];
        }
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

    // Source → géoréférencé : geo = source + offset, puis Lambert-93 si choisi.
    // H n'est jamais converti.
    private toGeo(s: Triple): Triple {
        const { offset } = this.geo;
        const e = s[0] + offset[0];
        const n = s[1] + offset[1];
        const h = s[2] + offset[2];
        if (!this.lambert93) return [e, n, h];
        const [x, y] = this.toLambert93.forward([e, n]);
        return [x, y, h];
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
 * @param {string[]} [axes] - Noms des axes (CoordinateSystem.axisNames).
 * @returns {string[]} Une ligne par axe.
 */
const formatCoords = (c: Triple, axes: string[] = AXES): string[] => {
    return axes.map((axis, i) => `${axis} ${formatCoordinate(c[i])}`);
};

/**
 * Coordonnées sur une ligne, repère en tête s'il est fourni :
 * « Local · X 12.345 · Y -3.210 · Z 1.050 m » ou
 * « UTM 32N · E 318379.045 · N 4829596.951 · H 254.640 m ». Mêmes valeurs que
 * formatCoords().
 *
 * @param {Triple} c - Coordonnées à afficher.
 * @param {string} [frame] - Nom du repère (CoordinateSystem.frameName).
 * @param {string[]} [axes] - Noms des axes (CoordinateSystem.axisNames).
 * @returns {string} Libellé d'une ligne.
 */
const formatCoordsInline = (c: Triple, frame?: string, axes: string[] = AXES): string => {
    const values = axes.map((axis, i) => `${axis} ${toFixedMm(c[i])}`);
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
export type { Projection, Triple, UserZero };
