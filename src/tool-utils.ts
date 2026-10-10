import { BoundingBox, Mat4, Vec3, Vec4 } from 'playcanvas';
import type { Entity, GSplatComponent } from 'playcanvas';

import { findShownGsplat } from './interior'; // ARTLIGHT (TKT-272)
import type { Global, State } from './types';

// ARTLIGHT: vrai dès qu'un de nos outils (mesure, surface, planéité, cubature,
// point, coupe) est actif. Ces outils s'approprient le clic canvas pour poser et
// déplacer leurs points ; la navigation au clic ajoutée en amont (clic pour se
// déplacer / recentrer, double-clic pour changer de mode) doit donc se taire
// tant qu'un outil est ouvert.
export function isToolActive(state: State): boolean {
    return state.measureMode ||
        state.areaMeasureMode ||
        state.flatnessMeasureMode ||
        state.volumeMeasureMode ||
        state.pointMode ||
        state.sectionMode;
}

// ARTLIGHT (TKT-242) : ferme l'outil ouvert ; les clics redeviennent de la
// navigation.
export function closeTools(state: State) {
    state.measureMode = false;
    state.areaMeasureMode = false;
    state.flatnessMeasureMode = false;
    state.volumeMeasureMode = false;
    state.pointMode = false;
    state.sectionMode = false;
}

// ── Calculs sur le nuage, partagés par la planéité et la coupe ──

export const median = (values: number[]) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Au plus `max` valeurs prises à pas régulier : assez pour une médiane ou une
// MAD, sans trier des centaines de milliers de valeurs.
export const subsample = (values: number[], max: number) => {
    if (values.length <= max) return values;
    const stride = values.length / max;
    const out: number[] = [];
    for (let k = 0; k < max; k++) out.push(values[Math.floor(k * stride)]);
    return out;
};

export interface Plane {
    origin: Vec3;
    normal: Vec3;
}

// Plan des moindres carrés sur les points d'indices `indices` (xyz entrelacés).
// La normale est le vecteur propre de plus petite valeur propre de la
// covariance, obtenu par itération de puissance sur sa comatrice ; `hint`
// sert de départ et fixe le sens de la normale.
export const fitPlaneLS = (pts: Float64Array, indices: ArrayLike<number>, hint: Vec3): Plane | null => {
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

// Verticale du relevé : la direction de H, 3e axe du repère source
// (coordinates.ts). C'est Y pour les scènes du pipeline .lcc ; une scène
// qui déclare `coordinates.sourceFromWorld` dans son settings.json peut
// en avoir une autre. Un modèle non calé (Maison Nico : Z vers le haut,
// sans sourceFromWorld) donne une verticale fausse, ici comme dans
// l'outil Point.
export const verticalAxis = (global: Global): Vec3 => {
    const coords = global.coords;
    if (typeof coords?.toSource !== 'function') return Vec3.UP.clone();
    const h = (x: number, y: number, z: number) => coords.toSource(new Vec3(x, y, z))[2];
    const up = new Vec3(h(1, 0, 0), h(0, 1, 0), h(0, 0, 1));
    return up.length() > 1e-9 ? up.normalize() : Vec3.UP.clone();
};

// ── Couche visible, partagée par la planéité et la règle de la coupe ──
//
// Un sol vitrifié, un carrelage brillant ou une vitre sont souvent modélisés
// avec une couche de splats fantômes derrière la surface (le reflet vu comme
// une pièce en miroir). Dans une case, la couche visible est la première
// fenêtre de 2 cm qui contient 30 % des splats (4 au moins) en partant du
// côté visible ; les splats en retrait de plus de 1,5 cm (ou 3,5 σ de la
// couche) sont écartés. Calé sur le parquet de l'appartement de Yannick
// (voir la planéité).
export const HIDDEN_MIN_POINTS = 8;
export const HIDDEN_LAYER_WINDOW = 0.02;
export const HIDDEN_LAYER_SHARE = 0.3;
export const HIDDEN_MIN_DEPTH = 0.015;
export const HIDDEN_SIGMAS = 3.5;

// Première couche dense d'une case : `sorted` trié du côté visible vers
// l'arrière (décroissant). null si aucune fenêtre n'est assez fournie.
export const firstDenseLayer = (sorted: number[]): number[] | null => {
    const need = Math.max(4, Math.ceil(HIDDEN_LAYER_SHARE * sorted.length));
    let m = 0;
    for (let i = 0; i < sorted.length; i++) {
        if (m < i) m = i;
        while (m + 1 < sorted.length && sorted[m + 1] >= sorted[i] - HIDDEN_LAYER_WINDOW) m++;
        if (m - i + 1 >= need) return sorted.slice(i, m + 1);
    }
    return null;
};

// ── Règle virtuelle, partagée par la planéité et la coupe ──
//
// La règle repose sur les points hauts du profil, qui forment l'enveloppe
// convexe supérieure ; la flèche est le plus grand jour mesuré entre deux
// points d'appui, comme sous une règle réelle (DIN 18202 : Stichmaß entre
// appuis). Le jour au-delà des appuis, là où la règle bascule dans le vide,
// ne compte pas : il doublait la hauteur d'une bosse étroite.

// Longueurs proposées (m). 0 = d'un bout à l'autre : toute la zone
// (planéité), toute la portée (coupe) ; affaissement d'un pan, d'un plancher.
export const RULE_LENGTHS = [0.2, 1, 2, 3, 5, 0];
// Nombre minimal de cases sous la règle, et part de la règle qui doit porter
// sur des points mesurés.
export const RULE_MIN_SAMPLES = 8;
export const RULE_MIN_COVERAGE = 0.7;
// Grille propre à la règle : des cases de L/40 (5 cm pour 2 m), agrandies
// pour contenir 8 splats en moyenne (3 au moins par case). Le bruit d'une
// case baisse avec le nombre de splats ; la règle n'a pas besoin de la
// finesse de la carte.
export const RULE_CELLS_PER_LENGTH = 40;
export const RULE_POINTS_PER_CELL = 8;
export const RULE_MIN_CELL_POINTS = 3;
// Cases isolées sur la grille de la règle : le seuil suit le bruit (3 mm au
// moins). Un point haut isolé soulevait la règle, un point bas isolé
// creusait une flèche.
export const RULE_SPIKE_MIN = 0.003;

// Tuiles : largeurs d'ondulation proposées (0 = surface lisse). Régler sur la
// plus grande dimension visible de la tuile, souvent sa longueur (30 à
// 40 cm) : les recouvrements ondulent aussi.
export const WAVE_WIDTHS = [0, 0.15, 0.2, 0.3, 0.4, 0.6];

export interface WindowResult {
    gap: number;    // plus grand jour entre deux appuis
    a: number;      // appuis de l'arête qui le porte (gauche, droite)
    b: number;
    slope: number;  // pente de cette arête (par échantillon)
    iGap: number;   // échantillon du plus grand jour
}

// Règle posée sur le profil [i0, i1[ (NaN : pas de mesure) : elle repose sur
// l'enveloppe convexe supérieure (chaîne monotone) ; on garde le plus grand
// jour entre une arête et les points qu'elle enjambe. `hull` : tableau de
// travail d'au moins i1 − i0 cases.
export const measureWindow = (profile: Float64Array, i0: number, i1: number, hull: Int32Array, out: WindowResult) => {
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
    out.b = hull[0];
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
                out.b = ib;
                out.slope = slope;
                out.iGap = i;
            }
        }
    }
};

// Accent color — must match $clr-accent in index.scss
export const ACCENT_COLOR = '#84cc16';
export const ACCENT_R = 132;
export const ACCENT_G = 204;
export const ACCENT_B = 22;

export function accentRgba(alpha: number): string {
    return `rgba(${ACCENT_R}, ${ACCENT_G}, ${ACCENT_B}, ${alpha})`;
}

// ARTLIGHT: le moteur ne rafraîchit la matrice de vue de la caméra qu'au
// `prerender` ; `camera.worldToScreen` appelé pendant `update` projette donc
// avec la pose de l'image précédente, et les tracés « flottent » derrière la
// scène dès que la caméra bouge. On recalcule la vue depuis la transformée
// monde courante de la caméra.
const tmpView = new Mat4();
const tmpViewProj = new Mat4();
const tmpClip = new Vec4();

export function worldToScreen(camera: Entity, pos: Vec3): { x: number; y: number; behind: boolean } {
    const cameraPos = camera.getPosition();
    const forward = camera.forward;
    const toPoint = new Vec3().sub2(pos, cameraPos);
    const dot = toPoint.dot(forward);

    if (dot < 0) {
        return { x: 0, y: 0, behind: true };
    }

    const cam = camera.camera;
    tmpView.copy(camera.getWorldTransform()).invert();
    tmpViewProj.mul2(cam.projectionMatrix, tmpView);
    tmpViewProj.transformVec4(tmpClip.set(pos.x, pos.y, pos.z, 1), tmpClip);

    // Même passage NDC → pixels CSS que CameraComponent.worldToScreen.
    const { width, height } = cam.system.app.graphicsDevice.clientRect;
    const { x: rx, y: ry, z: rw, w: rh } = cam.rect;
    const nx = (tmpClip.x / tmpClip.w + 1) * 0.5;
    const ny = (1 - tmpClip.y / tmpClip.w) * 0.5;
    return {
        x: nx * rw * width + rx * width,
        y: ny * rh * height + (1 - ry - rh) * height,
        behind: false
    };
}

// ARTLIGHT (TKT-249) : segment monde à l'écran, coupé au ras de la caméra
// quand il passe derrière elle (contour d'une grande coupe vu de
// l'intérieur). null s'il est entièrement derrière.
const SEGMENT_NEAR = 0.05;

export function segmentToScreen(camera: Entity, p: Vec3, q: Vec3): [{ x: number; y: number }, { x: number; y: number }] | null {
    const eye = camera.getPosition();
    const forward = camera.forward;
    const dp = new Vec3().sub2(p, eye).dot(forward) - SEGMENT_NEAR;
    const dq = new Vec3().sub2(q, eye).dot(forward) - SEGMENT_NEAR;
    if (dp < 0 && dq < 0) return null;
    const cut = dp < 0 || dq < 0 ? new Vec3().lerp(p, q, dp / (dp - dq)) : null;
    const a = worldToScreen(camera, dp < 0 ? cut : p);
    const b = worldToScreen(camera, dq < 0 ? cut : q);
    return [a, b];
}

// ARTLIGHT (TKT-240) : rayon de la caméra passant par un point de l'écran
// (pixels CSS depuis le coin du canvas, comme worldToScreen), avec la pose
// courante de la caméra. Deux points de la droite pris à mi-profondeur :
// valable en perspective comme en orthographique, quel que soit le sens de
// la profondeur. Le point d'intersection doit être testé devant la caméra.
const tmpInvViewProj = new Mat4();

export function screenToRay(camera: Entity, x: number, y: number): { origin: Vec3; dir: Vec3 } | null {
    const cam = camera.camera;
    tmpView.copy(camera.getWorldTransform()).invert();
    tmpViewProj.mul2(cam.projectionMatrix, tmpView);
    tmpInvViewProj.copy(tmpViewProj).invert();

    const { width, height } = cam.system.app.graphicsDevice.clientRect;
    const { x: rx, y: ry, z: rw, w: rh } = cam.rect;
    const nx = (x - rx * width) / (rw * width) * 2 - 1;
    const ny = 1 - (y - (1 - ry - rh) * height) / (rh * height) * 2;
    const unproject = (z: number) => {
        tmpInvViewProj.transformVec4(tmpClip.set(nx, ny, z, 1), tmpClip);
        return new Vec3(tmpClip.x / tmpClip.w, tmpClip.y / tmpClip.w, tmpClip.z / tmpClip.w);
    };
    const origin = unproject(0);
    const dir = unproject(0.5).sub(origin);
    if (dir.lengthSq() < 1e-20) return null;
    return { origin, dir: dir.normalize() };
}

export function findPointNear(
    camera: Entity,
    points: Vec3[],
    clientX: number,
    clientY: number,
    threshold = 400
): number {
    for (let i = 0; i < points.length; i++) {
        const sp = worldToScreen(camera, points[i]);
        if (sp.behind) continue;
        const dx = clientX - sp.x;
        const dy = clientY - sp.y;
        if (dx * dx + dy * dy < threshold) {
            return i;
        }
    }
    return -1;
}

export function formatDistance(dist: number): string {
    // 0.9995 et non 1 : une longueur de 0.99999 m s'affiche « 1.00 m » et non « 100.0 cm ».
    if (dist >= 0.9995) {
        return `${dist.toFixed(2)} m`;
    }
    return `${(dist * 100).toFixed(1)} cm`;
}

export function drawEdgeLabel(
    ctx: CanvasRenderingContext2D,
    p1: Vec3, p2: Vec3,
    s1: { x: number; y: number },
    s2: { x: number; y: number }
) {
    const dist = new Vec3().sub2(p1, p2).length();
    const text = formatDistance(dist);
    const mx = (s1.x + s2.x) / 2;
    const my = (s1.y + s2.y) / 2;

    ctx.font = '13px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const metrics = ctx.measureText(text);
    const pw = 6, ph = 3;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.beginPath();
    ctx.roundRect(mx - metrics.width / 2 - pw, my - 7 - ph, metrics.width + pw * 2, 14 + ph * 2, 4);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(text, mx, my);
}

// Niveaux de détail lus sur un modèle LOD : 0 est le plus fin, levels − 1
// le plus grossier.
export type LodUsage = {
    min: number;
    max: number;
    levels: number;
};

export type SplatCenters = {
    centers: Float32Array;              // positions locales, xyz entrelacés
    numSplats: number;
    worldMatrix: Float32Array;          // local → monde (colonnes, format PlayCanvas)
    lod?: LodUsage;                     // modèle LOD seulement (TKT-240)
};

// Centres des splats de la scène, partagés par les outils qui analysent le
// nuage (planéité, cubature).
export function getSplatCenters(global: Global): SplatCenters | null {
    const entity = findShownGsplat(global); // ARTLIGHT (TKT-272) : le modèle affiché
    if (!entity) return null;

    const comp = (entity as any).gsplat as GSplatComponent;
    const resource = comp.resource ?? (comp.instance as any)?.resource;
    if (!resource) return null;

    const worldMatrix = entity.getWorldTransform().data as Float32Array;

    // Standard (non-LOD) path: resource has centers directly
    const directCenters = (resource as any).centers as Float32Array;
    if (directCenters && directCenters.length > 0) {
        return {
            centers: directCenters,
            numSplats: directCenters.length / 3,
            worldMatrix
        };
    }

    // LOD streaming path: collect centers from active placements via gsplatDirector.
    // ARTLIGHT: depuis PlayCanvas 2.20, les instances d'octree vivent dans
    // `gsplatManager.world._octreeInstances` (et non plus `manager.octreeInstances`) ;
    // sans ce chemin, rien n'était trouvé et les outils restaient sans données.
    // Un fichier du LOD porte plusieurs niveaux de détail : on ne garde que les
    // intervalles actifs (ceux rendus), sinon les splats seraient comptés en
    // double. Les données viennent de la caméra principale, donc du niveau de
    // détail vu depuis le point de vue courant.
    const director = (global.app as any).renderer?.gsplatDirector;
    if (director) {
        const mainCameraData = director.camerasMap.get(global.camera.camera?.camera);
        const camerasData = mainCameraData ? [mainCameraData] : [...director.camerasMap.values()];
        const chunks: Float32Array[] = [];
        let totalSplats = 0;
        const lod: LodUsage = { min: Infinity, max: -1, levels: 0 };

        for (const cameraData of camerasData) {
            for (const layerData of cameraData.layersMap.values()) {
                const manager = layerData.gsplatManager;
                const octreeInstances = manager?.world?._octreeInstances ?? manager?.octreeInstances;
                if (!octreeInstances) continue;

                for (const octreeInstance of octreeInstances.values()) {
                    // ARTLIGHT (TKT-272) : pas les splats du modèle masqué.
                    if (resource.octree && octreeInstance.octree !== resource.octree) continue;
                    lod.levels = Math.max(lod.levels, octreeInstance.octree?.lodLevels ?? 0);
                    for (const placement of octreeInstance.activePlacements) {
                        const placementCenters = placement.resource?.centers as Float32Array;
                        if (!placementCenters || placementCenters.length === 0) continue;
                        if (typeof placement.lodIndex === 'number') {
                            lod.min = Math.min(lod.min, placement.lodIndex);
                            lod.max = Math.max(lod.max, placement.lodIndex);
                        }

                        const intervals = placement.intervals as Map<number, { x: number; y: number }> | undefined;
                        if (!intervals || intervals.size === 0) {
                            chunks.push(placementCenters);
                            totalSplats += placementCenters.length / 3;
                            continue;
                        }
                        for (const interval of intervals.values()) {
                            // Intervalle inclusif [x, y] d'indices de splats.
                            const first = Math.max(0, interval.x);
                            const last = Math.min(placementCenters.length / 3 - 1, interval.y);
                            if (last < first) continue;
                            chunks.push(placementCenters.subarray(first * 3, (last + 1) * 3));
                            totalSplats += last - first + 1;
                        }
                    }
                }
            }
            if (totalSplats > 0) break;
        }

        if (totalSplats > 0) {
            const merged = new Float32Array(totalSplats * 3);
            let offset = 0;
            for (const c of chunks) {
                merged.set(c, offset);
                offset += c.length;
            }
            return {
                centers: merged,
                numSplats: totalSplats,
                worldMatrix,
                lod: lod.levels > 0 && lod.max >= 0 ? lod : undefined
            };
        }
    }

    return null;
}

// ARTLIGHT (TKT-240) : niveau de détail le plus fin d'un modèle LOD sur une
// zone, quelle que soit la distance de la caméra.
//
// L'octree d'un lod-meta.json range le modèle en nœuds ; chaque nœud a, par
// niveau (0 = le plus fin), une plage [offset, offset + count[ de splats dans
// un fichier qui ne contient que ce niveau. On prend une référence sur les
// fichiers du niveau choisi qui couvrent la zone (le rendu, lui, n'est pas
// touché), on attend leur chargement, on copie les plages utiles et on rend
// les références. Champs internes du moteur (PlayCanvas 2.20) : tout est
// vérifié, et l'appelant retombe sur le niveau affiché s'ils manquent.
//
// Au plus 16 fichiers (environ 3,5 Mo chacun sur Callian) : une zone de 3 m
// sur une façade dense touche 15 fichiers du niveau 0. Au-delà, on prend le
// niveau suivant, s'il reste plus fin que celui qui est affiché.

const FINEST_MAX_FILES = 16;
const FINEST_TIMEOUT = 60000;
const FINEST_POLL = 50;
// ARTLIGHT (TKT-280) : depuis le moteur 2.23, la file de chargement est servie
// par priorité (de 0 à 3 pour le streaming) et non plus dans l'ordre d'arrivée.
// Sans priorité, les fichiers demandés par l'outil passeraient après tout le
// streaming en cours.
const FINEST_PRIORITY = 10;

// Boîte orientée (repère monde) : axes unitaires orthogonaux, demi-dimensions
// selon chaque axe.
export type OrientedBox = {
    center: Vec3;
    axes: [Vec3, Vec3, Vec3];
    half: [number, number, number];
};

// Boîte alignée sur les axes qui contient une boîte orientée.
export const orientedBoxAabb = (obb: OrientedBox): BoundingBox => {
    const half = new Vec3();
    obb.axes.forEach((axis, a) => {
        half.x += Math.abs(axis.x) * obb.half[a];
        half.y += Math.abs(axis.y) * obb.half[a];
        half.z += Math.abs(axis.z) * obb.half[a];
    });
    return new BoundingBox(obb.center.clone(), half);
};

// Octree du modèle affiché et entité qui le porte, null pour un modèle simple.
const findOctree = (global: Global): { entity: Entity; octree: any } | null => {
    const entity = findShownGsplat(global); // ARTLIGHT (TKT-272) : le modèle affiché
    const octree = (entity as any)?.gsplat?.resource?.octree;
    if (!octree || !Array.isArray(octree.nodes) || !octree.nodeBoundsMinMax) return null;
    return { entity, octree };
};

// Nœuds de l'octree dont la boîte (repère local du modèle) touche `box` (monde).
// ARTLIGHT (TKT-238) : `obb`, facultative, resserre la sélection aux nœuds qui
// touchent une boîte orientée (la tranche fine et longue d'une coupe, dont la
// boîte alignée sur les axes peut couvrir tout un bâtiment). Test des axes de
// la boîte orientée seulement : quelques nœuds de trop, jamais un de moins.
const nodesInBox = (entity: Entity, octree: any, box: BoundingBox, obb?: OrientedBox): number[] => {
    const local = new BoundingBox();
    local.setFromTransformedAabb(box, new Mat4().copy(entity.getWorldTransform()).invert());
    const mn = local.getMin(), mx = local.getMax();
    const b = octree.nodeBoundsMinMax as Float32Array;
    const m = entity.getWorldTransform().data;
    const corner = new Vec3();
    const out: number[] = [];
    for (let i = 0; i < octree.nodes.length; i++) {
        const k = i * 6;
        if (!(b[k] <= mx.x && b[k + 3] >= mn.x && b[k + 1] <= mx.y && b[k + 4] >= mn.y && b[k + 2] <= mx.z && b[k + 5] >= mn.z)) continue;
        if (obb) {
            let separated = false;
            for (let a = 0; a < 3 && !separated; a++) {
                const axis = obb.axes[a];
                const c = obb.center.dot(axis);
                let lo = Infinity, hi = -Infinity;
                for (let q = 0; q < 8; q++) {
                    const x = b[k + (q & 1 ? 3 : 0)], y = b[k + 1 + (q & 2 ? 3 : 0)], z = b[k + 2 + (q & 4 ? 3 : 0)];
                    corner.set(
                        m[0] * x + m[4] * y + m[8] * z + m[12],
                        m[1] * x + m[5] * y + m[9] * z + m[13],
                        m[2] * x + m[6] * y + m[10] * z + m[14]
                    );
                    const d = corner.dot(axis);
                    if (d < lo) lo = d;
                    if (d > hi) hi = d;
                }
                separated = hi < c - obb.half[a] || lo > c + obb.half[a];
            }
            if (separated) continue;
        }
        out.push(i);
    }
    return out;
};

/**
 * Niveaux de détail affichés sur la zone `box` (monde) d'un modèle LOD.
 *
 * @param {Global} global - Contexte du visualisateur.
 * @param {BoundingBox} box - Zone, repère monde.
 * @param {OrientedBox} [obb] - Boîte orientée incluse dans `box` : seuls les nœuds qui la touchent comptent.
 * @returns {LodUsage | null} null pour un modèle simple ou si l'octree n'est pas lisible.
 */
export function displayedLodInBox(global: Global, box: BoundingBox, obb?: OrientedBox): LodUsage | null {
    const found = findOctree(global);
    if (!found) return null;
    const { entity, octree } = found;
    const director = (global.app as any).renderer?.gsplatDirector;
    const cameraData = director?.camerasMap?.get(global.camera.camera?.camera);
    let instance: any = null;
    for (const layerData of cameraData?.layersMap?.values() ?? []) {
        const instances = layerData.gsplatManager?.world?._octreeInstances ?? layerData.gsplatManager?.octreeInstances;
        for (const candidate of instances?.values() ?? []) {
            if (candidate.octree === octree) instance = candidate;
        }
    }
    if (!instance?.nodeInfos) return null;

    const usage: LodUsage = { min: Infinity, max: -1, levels: octree.lodLevels };
    for (const n of nodesInBox(entity, octree, box, obb)) {
        const lod = instance.nodeInfos[n]?.currentLod;
        if (typeof lod !== 'number' || lod < 0) continue;
        usage.min = Math.min(usage.min, lod);
        usage.max = Math.max(usage.max, lod);
    }
    return usage.max >= 0 ? usage : null;
}

export type FinestResult =
    | { status: 'ok'; data: SplatCenters }
    | { status: 'unsupported' | 'too-large' | 'failed' | 'cancelled' };

/**
 * Centres des splats du niveau de détail le plus fin possible sur la zone
 * `box` (monde) : les splats des nœuds qui touchent la zone, pas au-delà.
 *
 * @param {Global} global - Contexte du visualisateur.
 * @param {BoundingBox} box - Zone, repère monde.
 * @param {number} coarsest - Niveau affiché : un niveau aussi grossier n'apporte rien.
 * @param {() => boolean} cancelled - Vrai si le résultat n'est plus attendu : on rend les fichiers sans attendre.
 * @param {OrientedBox} [obb] - Boîte orientée incluse dans `box` : seuls les nœuds qui la touchent sont lus.
 * @returns {Promise<FinestResult>} Centres, ou la raison de l'échec.
 */
export async function loadFinestCenters(global: Global, box: BoundingBox, coarsest: number, cancelled: () => boolean = () => false, obb?: OrientedBox): Promise<FinestResult> {
    const found = findOctree(global);
    if (!found) return { status: 'unsupported' };
    const { entity, octree } = found;
    if (typeof octree.incRefCount !== 'function' || typeof octree.decRefCount !== 'function' ||
        typeof octree.ensureFileResource !== 'function' || typeof octree.getFileResource !== 'function') {
        return { status: 'unsupported' };
    }

    // Plages de splats à lire, par fichier : pour chaque nœud, son premier
    // niveau disponible à partir de `level`.
    const nodes = nodesInBox(entity, octree, box, obb);
    const collect = (level: number) => {
        const ranges = new Map<number, [number, number][]>();
        const usage: LodUsage = { min: Infinity, max: -1, levels: octree.lodLevels };
        for (const n of nodes) {
            const lods = octree.nodes[n].lods as { fileIndex: number; offset: number; count: number }[];
            let l = level;
            while (l < lods.length && !(lods[l].fileIndex >= 0 && lods[l].count > 0)) l++;
            if (l >= lods.length) continue;
            const { fileIndex, offset, count } = lods[l];
            if (!ranges.has(fileIndex)) ranges.set(fileIndex, []);
            ranges.get(fileIndex).push([offset, count]);
            usage.min = Math.min(usage.min, l);
            usage.max = Math.max(usage.max, l);
        }
        return { ranges, usage };
    };
    let level = 0;
    let { ranges, usage } = collect(0);
    while (ranges.size > FINEST_MAX_FILES && level + 1 < coarsest) {
        ({ ranges, usage } = collect(++level));
    }
    if (ranges.size === 0) return { status: 'failed' };
    if (ranges.size > FINEST_MAX_FILES) return { status: 'too-large' };

    const files = [...ranges.keys()];
    files.forEach(fi => octree.incRefCount(fi));
    try {
        const start = performance.now();
        for (;;) {
            files.forEach((fi) => {
                octree.ensureFileResource(fi);
                if (!octree.getFileResource(fi)) octree.assetLoader?.load?.(octree.files[fi].url, FINEST_PRIORITY);
            });
            if (files.every(fi => octree.getFileResource(fi)?.centers?.length > 0)) break;
            if (cancelled()) return { status: 'cancelled' };
            const failed = files.some(fi => octree.assetLoader?.hasFailed?.(octree.files[fi]?.url));
            if (octree.destroyed || failed || performance.now() - start > FINEST_TIMEOUT) return { status: 'failed' };
            // Attente volontairement séquentielle : on sonde le chargement.
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => {
                setTimeout(resolve, FINEST_POLL);
            });
        }

        let total = 0;
        ranges.forEach(list => list.forEach(([, count]) => {
            total += count;
        }));
        const centers = new Float32Array(total * 3);
        let write = 0;
        for (const [fi, list] of ranges) {
            const source = octree.getFileResource(fi).centers as Float32Array;
            for (const [offset, count] of list) {
                centers.set(source.subarray(offset * 3, (offset + count) * 3), write);
                write += count * 3;
            }
        }
        return {
            status: 'ok',
            data: {
                centers,
                numSplats: total,
                worldMatrix: (entity.getWorldTransform().data as Float32Array).slice(),
                lod: usage
            }
        };
    } finally {
        // Délai de grâce du moteur : le rendu peut reprendre ces fichiers
        files.forEach(fi => octree.decRefCount(fi, global.app.scene.gsplat?.cooldownTicks ?? 100));
    }
}

// ARTLIGHT (TKT-225) : copie un tableau de valeurs dans le presse-papier.
// En texte brut, une ligne par entrée et « ; » entre les valeurs, comme le
// demande la spec. Excel ne découpe pas un collage de texte sur « ; » (il ne
// découpe que sur les tabulations) : on joint donc une version HTML, que
// Word, Excel, Numbers et LibreOffice collent en autant de colonnes.
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function copyTable(rows: string[][]): Promise<boolean> {
    const text = rows.map(r => r.join(';')).join('\r\n');
    const html = `<table>${rows.map(r => `<tr>${r.map(v => `<td>${escapeHtml(v)}</td>`).join('')}</tr>`).join('')}</table>`;

    try {
        if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
            await navigator.clipboard.write([new ClipboardItem({
                'text/plain': new Blob([text], { type: 'text/plain' }),
                'text/html': new Blob([html], { type: 'text/html' })
            })]);
            return true;
        }
    } catch {
        // on retombe sur le texte seul
    }

    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // contexte non sécurisé ou permission refusée
    }

    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
        ok = document.execCommand('copy');
    } catch {
        ok = false;
    }
    textarea.remove();
    return ok;
}
