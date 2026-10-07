// ARTLIGHT (TKT-224)
//
// Conversion des points du moteur vers le repère affiché à l'utilisateur.
// Voir la spec « Coordonnées et repères » (TKT-114).
//
// Le moteur travaille en Y vers le haut. Le repère « source » est celui du
// scan : X = Est, Y = Nord, Z = Haut. Avec le pipeline actuel (.lcc converti
// par splat-transform v3.3.3 ou v3.10.0 sans -r, ce qui donne (E, −H, N) dans les
// fichiers, puis 180° sur Z au chargement dans index.ts), un point (E, N, H)
// du .lcc arrive dans le moteur en (−E, H, N).
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
// mémorisé dans le navigateur pour toutes les scènes. H est la hauteur du
// .lcc (ellipsoïdale par défaut, voir `heightRef`).
//
// TKT-231 : une scène dont H est ellipsoïdale peut afficher l'altitude
// NGF-IGN69, par la grille RAF20 de l'IGN (geoid.ts), chargée à la demande.
// Choix mémorisé dans le navigateur pour toutes les scènes. Tant que la grille
// n'est pas là, ou si la scène est hors de la grille, H reste ellipsoïdale et
// frameName le dit.
//
// TKT-232 : troisième choix, la zone Lambert CC (CC42 à CC50, EPSG 3942 à
// 3950) du chantier, déduite de la latitude de l'origine de la scène, sauf si
// `displayEpsg` l'impose dans settings.json.
// Une scène déjà en Lambert-93 ou en CC propose les autres systèmes.

import type { EventHandler, Vec3 } from 'playcanvas';
import proj4 from 'proj4';

import { loadNgfGrid, undulation } from './geoid';
import type { Grid } from './geoid';
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

// Système affiché pour une scène géoréférencée : celui du .lcc, Lambert-93
// ou la zone Lambert CC du chantier.
type Projection = 'native' | 'lambert93' | 'cc';

const PROJECTIONS: Projection[] = ['native', 'lambert93', 'cc'];

const PROJECTION_STORAGE_KEY = 'artlight.projection';

// Altitude affichée pour une scène dont H est ellipsoïdale.
type HeightChoice = 'ellipsoid' | 'ngf';

const HEIGHT_STORAGE_KEY = 'artlight.height';

// Ce que dit la note sur H dans le panneau Point.
type HeightStatus = 'ngf' | 'ngf-converted' | 'ellipsoid' | 'loading' | 'uncovered' | 'error';

const LAMBERT93 = 2154;

const LAMBERT93_DEF = '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

// Zones Lambert CC : EPSG 3942 (CC42) à 3950 (CC50), latitude centrale 42° à 50° N.
const CC_FIRST_ZONE = 42;

const CC_LAST_ZONE = 50;

const CC_EPSG_BASE = 3900;

const ccZone = (epsg: number): number | null => {
    const zone = epsg - CC_EPSG_BASE;
    return zone >= CC_FIRST_ZONE && zone <= CC_LAST_ZONE ? zone : null;
};

// Définition EPSG des zones CC : parallèles standard à ±0,75° de la latitude
// centrale, X = 1 700 000 m, Y = (zone − 41) × 1 000 000 + 200 000 m.
const ccDefinition = (zone: number): string => {
    return `+proj=lcc +lat_0=${zone} +lon_0=3 +lat_1=${zone - 0.75} +lat_2=${zone + 0.75} +x_0=1700000 +y_0=${(zone - 41) * 1000000 + 200000} +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
};

// Zone CC d'une latitude : partie entière, bornée à CC42–CC50. Les zones se
// recouvrent (parallèles standard à ±0,75°) ; la partie entière colle à
// l'usage des géomètres sur nos chantiers (Callian, 43,62° N, en CC43 et non
// CC44 comme le donnerait l'arrondi). `displayEpsg` tranche au besoin.
const ccZoneAt = (lat: number): number => {
    return Math.min(CC_LAST_ZONE, Math.max(CC_FIRST_ZONE, Math.floor(lat)));
};

const LONGLAT_DEF = '+proj=longlat +datum=WGS84 +no_defs';

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
    const cc = ccZone(epsg);
    if (cc !== null) return ccDefinition(cc);
    const utm = utmZone(epsg);
    return utm ? `+proj=utm +zone=${utm.zone}${utm.south ? ' +south' : ''} +datum=WGS84 +units=m +no_defs` : null;
};

// Nom court du système : « UTM 32N », « Lambert-93 », « CC43 », sinon « EPSG:xxxx ».
const epsgName = (epsg: number): string => {
    if (epsg === LAMBERT93) return 'Lambert-93';
    const cc = ccZone(epsg);
    if (cc !== null) return `CC${cc}`;
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
        const value = localStorage.getItem(PROJECTION_STORAGE_KEY) as Projection;
        return PROJECTIONS.includes(value) ? value : 'native';
    } catch {
        return 'native';
    }
};

const loadHeightChoice = (): HeightChoice => {
    try {
        return localStorage.getItem(HEIGHT_STORAGE_KEY) === 'ngf' ? 'ngf' : 'ellipsoid';
    } catch {
        return 'ellipsoid';
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

    // Système du .lcc → système affiché, par choix proposé autre que
    // 'native'. Absent si la scène y est déjà ou si la conversion est
    // impossible.
    private converters: Partial<Record<Projection, { epsg: number, converter: proj4.Converter }>> = {};

    private _projection: Projection;

    // Système du .lcc → longitude/latitude, null si H ne peut pas être
    // convertie (déjà en NGF, ou système inconnu).
    private toLongLat: proj4.Converter | null = null;

    private _height: HeightChoice;

    private grid: Grid | null = null;

    private gridState: 'idle' | 'loading' | 'ready' | 'error' = 'idle';

    // Origine de la scène dans la grille NGF (connu une fois la grille chargée).
    private ngfCovered = false;

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
        if (def) {
            if (epsg !== LAMBERT93) {
                this.converters.lambert93 = { epsg: LAMBERT93, converter: proj4(def, LAMBERT93_DEF) };
            }
            const cc = this.chooseCcZone(def, coordinates.displayEpsg);
            if (cc !== ccZone(epsg)) {
                this.converters.cc = { epsg: CC_EPSG_BASE + cc, converter: proj4(def, ccDefinition(cc)) };
            }
        }
        this._projection = loadProjection();
        if (def && this.geo.heightRef === 'ellipsoid') {
            this.toLongLat = proj4(def, LONGLAT_DEF);
        }
        this._height = loadHeightChoice();
        if (this._height === 'ngf') this.ensureGrid();

        this.load();
    }

    // Zone CC du chantier : imposée par `displayEpsg` (3942 à 3950), sinon
    // déduite de la latitude de l'origine de la scène.
    private chooseCcZone(def: string, displayEpsg?: number): number {
        const imposed = displayEpsg !== undefined ? ccZone(displayEpsg) : null;
        if (imposed !== null) return imposed;
        const [, lat] = proj4(def, LONGLAT_DEF).forward([this.geo.offset[0], this.geo.offset[1]]);
        return ccZoneAt(lat);
    }

    /**
     * Nom du repère affiché à côté des coordonnées : « Relatif » quand un zéro
     * est défini, sinon le système géoréférencé (« UTM 32N », « CC43 »),
     * sinon « Local ».
     *
     * @returns {string} Nom localisé du repère.
     */
    get frameName(): string {
        if (this._zero) return localize('artlight.coords.frame-relative');
        if (this.geo) {
            const system = epsgName(this.activeConverter?.epsg ?? this.geo.epsg);
            return `${system} · ${localize(`artlight.coords.height-short-${this.heightSystem}`)}`;
        }
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
     * @returns {'ellipsoid' | 'ngf' | null} Ce que représente H, null pour un
     * modèle local.
     */
    get heightRef(): 'ellipsoid' | 'ngf' | null {
        return this.geo?.heightRef ?? null;
    }

    /**
     * @returns {'ellipsoid' | 'ngf' | null} Ce que représente le H affiché :
     * NGF si la scène l'est déjà ou si la conversion est active, null pour un
     * modèle local.
     */
    get heightSystem(): 'ellipsoid' | 'ngf' | null {
        if (!this.geo) return null;
        return this.geo.heightRef === 'ngf' || this.ngfActive ? 'ngf' : 'ellipsoid';
    }

    /**
     * @returns {HeightStatus | null} État de H pour la note du panneau Point,
     * null pour un modèle local.
     */
    get heightStatus(): HeightStatus | null {
        if (!this.geo) return null;
        if (this.geo.heightRef === 'ngf') return 'ngf';
        if (this._height === 'ellipsoid' || !this.toLongLat) return 'ellipsoid';
        if (this.gridState === 'ready') return this.ngfCovered ? 'ngf-converted' : 'uncovered';
        return this.gridState === 'error' ? 'error' : 'loading';
    }

    /**
     * @returns {boolean} true si H est ellipsoïdale et peut être convertie en
     * altitude NGF.
     */
    get canConvertHeight(): boolean {
        return this.toLongLat !== null;
    }

    /**
     * Choisit l'altitude affichée pour les scènes dont H est ellipsoïdale,
     * mémorisé pour toutes les scènes. La grille NGF est chargée au besoin ;
     * `coords:changed` est relancé quand elle arrive.
     *
     * @param {HeightChoice} value - 'ellipsoid' ou 'ngf'.
     */
    set height(value: HeightChoice) {
        if (value === this._height) return;
        this._height = value;
        try {
            localStorage.setItem(HEIGHT_STORAGE_KEY, value);
        } catch {
            // stockage indisponible : choix valable pour cette page seulement
        }
        if (value === 'ngf') this.ensureGrid();
        this.events?.fire('coords:changed');
    }

    /**
     * @returns {HeightChoice} Altitude choisie par l'utilisateur.
     */
    get height(): HeightChoice {
        return this._height;
    }

    /**
     * Choix de système proposés pour la scène, dans l'ordre d'affichage :
     * celui du .lcc, puis Lambert-93 et la zone CC quand la scène n'y est pas
     * déjà. Vide pour un modèle local ou un système inconnu.
     *
     * @returns {{ value: Projection, name: string }[]} Choix et nom court.
     */
    get projectionChoices(): { value: Projection, name: string }[] {
        if (!this.geo) return [];
        const others = PROJECTIONS
        .filter(p => this.converters[p])
        .map(p => ({ value: p, name: epsgName(this.converters[p].epsg) }));
        return others.length ? [{ value: 'native', name: epsgName(this.geo.epsg) }, ...others] : [];
    }

    /**
     * Choisit le système affiché pour les scènes géoréférencées, mémorisé pour
     * toutes les scènes.
     *
     * @param {Projection} value - 'native' (système du .lcc), 'lambert93' ou
     * 'cc' (zone Lambert CC du chantier).
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
     * @returns {Projection} Système affiché pour cette scène : le choix de
     * l'utilisateur, ou 'native' si la scène y est déjà.
     */
    get projection(): Projection {
        return this.activeConverter ? this._projection : 'native';
    }

    // Conversion de système active pour cette scène, null en natif.
    private get activeConverter() {
        return this.converters[this._projection] ?? null;
    }

    // Conversion de H en altitude NGF active pour cette scène.
    private get ngfActive(): boolean {
        return this._height === 'ngf' && this.toLongLat !== null && this.gridState === 'ready' && this.ngfCovered;
    }

    // Charge la grille NGF si la scène en a besoin et qu'elle n'est pas déjà
    // là. Un échec est retenté au prochain choix « Altitude NGF ».
    private ensureGrid() {
        if (!this.toLongLat || this.gridState === 'loading' || this.gridState === 'ready') return;
        this.gridState = 'loading';
        loadNgfGrid().then((grid) => {
            this.grid = grid;
            this.gridState = 'ready';
            // L'origine suffit : une scène fait au plus quelques km, la grille
            // couvre la France continentale et ses abords.
            this.ngfCovered = this.undulationAt(this.geo.offset[0], this.geo.offset[1]) !== null;
        }, (err) => {
            console.warn('Grille NGF indisponible :', err);
            this.gridState = 'error';
        }).finally(() => {
            this.events?.fire('coords:changed');
        });
    }

    // Ondulation N (m) sous un point du système du .lcc, null hors grille.
    private undulationAt(e: number, n: number): number | null {
        const [lon, lat] = this.toLongLat.forward([e, n]);
        return undulation(this.grid, lat, lon);
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
        // Autre système : la projection déforme légèrement les écarts ; altitude
        // NGF : N varie d'un point à l'autre. On prend la différence des
        // coordonnées affichées.
        if (!this._zero && (this.activeConverter || this.ngfActive)) {
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

    // Source → géoréférencé : geo = source + offset, puis système choisi et
    // altitude NGF (h − N) si choisis. Un point hors grille (impossible pour
    // une scène dont l'origine y est) donne NaN plutôt qu'une valeur fausse.
    private toGeo(s: Triple): Triple {
        const { offset } = this.geo;
        const e = s[0] + offset[0];
        const n = s[1] + offset[1];
        let h = s[2] + offset[2];
        if (this.ngfActive) {
            h -= this.undulationAt(e, n) ?? NaN;
        }
        const target = this.activeConverter;
        if (!target) return [e, n, h];
        const [x, y] = target.converter.forward([e, n]);
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
export type { HeightChoice, HeightStatus, Projection, Triple, UserZero };
