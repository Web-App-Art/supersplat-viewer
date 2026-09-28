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

/**
 * Composante de coordonnée : toujours en mètres, au millimètre.
 *
 * @param {number} v - Valeur en mètres.
 * @returns {string} Valeur formatée.
 */
const formatCoordinate = (v: number): string => {
    return `${v < 0 ? '' : ' '}${v.toFixed(3)} m`;
};

/**
 * Lignes « X … / Y … / Z … » prêtes à afficher.
 *
 * @param {Triple} c - Coordonnées à afficher.
 * @returns {string[]} Une ligne par axe.
 */
const formatCoords = (c: Triple): string[] => {
    return [
        `X ${formatCoordinate(c[0])}`,
        `Y ${formatCoordinate(c[1])}`,
        `Z ${formatCoordinate(c[2])}`
    ];
};

export { CoordinateSystem, formatCoordinate, formatCoords, DEFAULT_SOURCE_FROM_WORLD };
