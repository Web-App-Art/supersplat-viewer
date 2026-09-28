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

import type { Vec3 } from 'playcanvas';

import { getLocale, localize } from './localization';
import type { Coordinates, Mat3Rows } from './settings';

type Triple = [number, number, number];

const DEFAULT_SOURCE_FROM_WORLD: Mat3Rows = [
    [-1, 0, 0],
    [0, 0, 1],
    [0, 1, 0]
];

class CoordinateSystem {
    private m: Mat3Rows;

    constructor(coordinates?: Coordinates) {
        this.m = coordinates?.sourceFromWorld ?? DEFAULT_SOURCE_FROM_WORLD;
    }

    /**
     * Nom du repère affiché à côté des coordonnées (« Local » pour le repère
     * source). TKT-226 (zéro) et TKT-227 (géoréférencement) le feront varier.
     *
     * @returns {string} Nom localisé du repère.
     */
    get frameName(): string {
        return localize('artlight.coords.frame-local');
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
     * Écart entre deux points du moteur (b − a) → écart dans le repère source.
     *
     * @param {Vec3} a - Point de départ, repère du moteur.
     * @param {Vec3} b - Point d'arrivée, repère du moteur.
     * @returns {Triple} Écart dans le repère source.
     */
    deltaToSource(a: Vec3, b: Vec3): Triple {
        return this.apply(b.x - a.x, b.y - a.y, b.z - a.z);
    }

    private apply(x: number, y: number, z: number): Triple {
        const m = this.m;
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

/**
 * Composante de coordonnée : toujours en mètres, au millimètre.
 *
 * @param {number} v - Valeur en mètres.
 * @returns {string} Valeur formatée.
 */
const formatCoordinate = (v: number): string => {
    return `${v < 0 ? '' : ' '}${v.toFixed(DECIMALS)} m`;
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
    const values = AXES.map((axis, i) => `${axis} ${c[i].toFixed(DECIMALS)}`);
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
    return c.map(v => v.toFixed(DECIMALS).replace('.', decimal));
};

export {
    CoordinateSystem,
    formatCoordinate,
    formatCoords,
    formatCoordsInline,
    coordsForClipboard,
    DEFAULT_SOURCE_FROM_WORLD
};
export type { Triple };
