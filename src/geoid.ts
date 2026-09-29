// ARTLIGHT (TKT-231)
//
// Grille de conversion hauteur ellipsoïdale → altitude NGF-IGN69 : RAF20 de
// l'IGN, France continentale (hors Corse : NGF-IGN78, grille distincte).
// Fichier GTX (static/geoid/, copié à côté du viewer au build), converti avec
//   gdal_translate -of GTX fr_ign_RAF20.tif fr_ign_RAF20.gtx
// depuis la grille diffusée par PROJ (cdn.proj.org), elle-même tirée de
// RAF20.tac. Chargé à la demande, une seule fois par page.
//
// Altitude NGF = h − N, N interpolé bilinéairement aux 4 nœuds qui entourent
// le point, comme PROJ (vgridshift). Latitude et longitude en RGF93 ; on les
// confond avec WGS84, l'écart (quelques dm en planimétrie) change N de moins
// d'un millimètre.

const GRID_URL = 'geoid/fr_ign_RAF20.gtx';

// En-tête GTX : 4 float64 + 2 int32, big-endian.
const HEADER_BYTES = 40;

type Grid = {
    lat0: number;           // latitude du 1er nœud (sud), degrés
    lon0: number;           // longitude du 1er nœud (ouest), degrés
    dlat: number;
    dlon: number;
    rows: number;
    cols: number;
    values: Float32Array;   // ligne par ligne, du sud au nord
};

const parseGtx = (buffer: ArrayBuffer): Grid => {
    const view = new DataView(buffer);
    const lat0 = view.getFloat64(0);
    const lon0 = view.getFloat64(8);
    const dlat = view.getFloat64(16);
    const dlon = view.getFloat64(24);
    const rows = view.getInt32(32);
    const cols = view.getInt32(36);
    if (!(rows > 1 && cols > 1 && dlat > 0 && dlon > 0) || buffer.byteLength !== HEADER_BYTES + rows * cols * 4) {
        throw new Error('grille GTX illisible');
    }
    const values = new Float32Array(rows * cols);
    for (let i = 0; i < values.length; i++) {
        values[i] = view.getFloat32(HEADER_BYTES + i * 4);
    }
    return { lat0, lon0: lon0 > 180 ? lon0 - 360 : lon0, dlat, dlon, rows, cols, values };
};

/**
 * Ondulation N (m) au point, par interpolation bilinéaire. null hors de la
 * grille, ou si un des nœuds voisins n'a pas de valeur (−88.8888 en GTX).
 *
 * @param {Grid} grid - Grille chargée.
 * @param {number} lat - Latitude, degrés.
 * @param {number} lon - Longitude, degrés.
 * @returns {number | null} Ondulation en mètres.
 */
const undulation = (grid: Grid, lat: number, lon: number): number | null => {
    const y = (lat - grid.lat0) / grid.dlat;
    const x = (lon - grid.lon0) / grid.dlon;
    // Petite tolérance : le dernier nœud tombe à 1e-12 près sur le bord.
    const eps = 1e-9;
    if (!(y >= -eps && x >= -eps && y <= grid.rows - 1 + eps && x <= grid.cols - 1 + eps)) return null;
    const r = Math.min(Math.max(Math.floor(y), 0), grid.rows - 2);
    const c = Math.min(Math.max(Math.floor(x), 0), grid.cols - 2);
    const fy = y - r;
    const fx = x - c;
    const v = grid.values;
    const i = r * grid.cols + c;
    const n00 = v[i];
    const n01 = v[i + 1];
    const n10 = v[i + grid.cols];
    const n11 = v[i + grid.cols + 1];
    if ([n00, n01, n10, n11].some(n => !Number.isFinite(n) || n < -88)) return null;
    return (1 - fy) * ((1 - fx) * n00 + fx * n01) + fy * ((1 - fx) * n10 + fx * n11);
};

let pending: Promise<Grid> | null = null;

/**
 * Charge la grille RAF20 (une fois). Rejetée si le fichier manque ou est
 * illisible ; un nouvel appel retente alors le chargement.
 *
 * @returns {Promise<Grid>} Grille prête à interpoler.
 */
const loadNgfGrid = (): Promise<Grid> => {
    pending ??= fetch(new URL(GRID_URL, document.baseURI).href)
    .then((response) => {
        if (!response.ok) throw new Error(`${GRID_URL} : HTTP ${response.status}`);
        return response.arrayBuffer();
    })
    .then(parseGtx)
    .catch((err) => {
        pending = null;
        throw err;
    });
    return pending;
};

export { loadNgfGrid, parseGtx, undulation };
export type { Grid };
