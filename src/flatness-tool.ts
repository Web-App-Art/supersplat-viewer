import { Vec3 } from 'playcanvas';

import { ToolPointerHandler } from './tool-pointer-handler';
import { worldToScreen, drawEdgeLabel, getSplatCenters, ACCENT_COLOR, accentRgba } from './tool-utils';
import type { Global } from './types';

type FlatnessMeasureState = 'idle' | 'placing' | 'closed';

// Grid cell data for heatmap
interface GridData {
    grid: (number | null)[][];  // signed deviation values per cell (null = no data)
    measured: boolean[][];      // true = valeur issue de splats, false = interpolée
    resX: number;
    resY: number;
    min: number;
    max: number;
}

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

// Au-delà, le polygone se ferme de lui-même.
const MAX_POINTS = 16;

// Délai avant de relancer le calcul après le déplacement d'un sommet.
const RECOMPUTE_DELAY = 150;

interface Plane {
    origin: Vec3;
    normal: Vec3;
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

    // Plane & grid results
    private planeOrigin: Vec3 | null = null;
    private planeNormal: Vec3 | null = null;
    private planeU: Vec3 | null = null;
    private planeV: Vec3 | null = null;
    private gridData: GridData | null = null;
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
    private rawSplatStats: { min: number; max: number } | null = null;

    // Post-processing toggles
    private interpolationEnabled = true;
    private bandHalfWidth = DEFAULT_BAND; // meters — splats plus loin du plan exclus
    private colorScale = 0.10; // meters — symmetric range [-scale, +scale]

    private overlay: HTMLDivElement | null = null;
    private drawCanvas: HTMLCanvasElement | null = null;
    private updateHandler: ((dt: number) => void) | null = null;

    // Heatmap panel elements
    private panel: HTMLDivElement | null = null;
    private heatmapCanvas: HTMLCanvasElement | null = null;

    constructor(global: Global) {
        this.global = global;
        this.pointerHandler = new ToolPointerHandler(global, {
            onCanvasClick: (pos, clientX, clientY) => this.handleClick(pos, clientX, clientY),
            getDraggablePoints: () => this.state === 'closed' ? this.currentPoints : [],
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

        this.pointerHandler.activate();

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

        this.pointerHandler.deactivate();
        this.cancelRecompute();
        this.removePanel();

        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }

        this.drawCanvas = null;
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
            }
        }
    }

    private closePolygon() {
        this.state = 'closed';
        this.analyze();
        this.showPanel();
    }

    private clearAll() {
        this.cancelRecompute();
        this.currentPoints = [];
        this.analyzedPoints = [];
        this.state = 'idle';
        this.planeOrigin = null;
        this.planeNormal = null;
        this.planeU = null;
        this.planeV = null;
        this.gridData = null;
        this.candidates = null;
        this.rawGrid = null;
        this.insideMask = null;
        this.polyUV = null;
        this.rawSplatCount = 0;
        this.excludedSplatCount = 0;
        this.rawSplatStats = null;
        this.removePanel();
        this.pointerHandler.reset();
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
        this.rawGrid = null;
        this.insideMask = null;

        const footprint = this.computeFootprintPlane();
        if (!footprint) return;

        this.candidates = this.gatherCandidates(footprint);
        if (!this.candidates) return;

        const plane = this.fitReferencePlane(this.candidates, footprint) ?? footprint;
        this.setPlane(plane);
        this.computeDeviations();
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

    // Base 2D du plan alignée sur la caméra :
    // U = droite caméra projetée sur le plan (horizontale de la carte ≈ écran),
    // V = N × U (verticale de la carte, vers le bas pour que la ligne 0 soit en haut).
    private planeBasis(N: Vec3) {
        const camRight = this.global.camera.right.clone();
        const dotNR = camRight.dot(N);
        const U = new Vec3(camRight.x - dotNR * N.x, camRight.y - dotNR * N.y, camRight.z - dotNR * N.z);
        const uLen = U.length();
        if (uLen < 1e-10) {
            // Camera looking straight at the plane normal — fallback
            const camUp = this.global.camera.up.clone();
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

            const med = median(residuals);
            const sigma = 1.4826 * median(residuals.map(r => Math.abs(r - med)));
            tol = Math.max(REFINE_SIGMAS * sigma, REFINE_MIN_TOL);
        }

        // Ensure normal points towards camera
        const toCamera = new Vec3().sub2(this.global.camera.getPosition(), plane.origin);
        if (toCamera.dot(plane.normal) < 0) plane.normal.mulScalar(-1);
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

    private computeDeviations() {
        if (!this.planeOrigin || !this.planeNormal || !this.planeU || !this.planeV || !this.candidates) return;

        const pts = this.candidates;
        const O = this.planeOrigin;
        const N = this.planeNormal;
        const U = this.planeU;
        const V = this.planeV;
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

        const kept: { dist: number; pu: number; pv: number }[] = [];
        let excluded = 0;
        for (let k = 0; k < pts.length; k += 3) {
            const dx = pts[k] - O.x, dy = pts[k + 1] - O.y, dz = pts[k + 2] - O.z;
            const pu = dx * U.x + dy * U.y + dz * U.z;
            const pv = dx * V.x + dy * V.y + dz * V.z;
            if (pu < uMin || pu > uMax || pv < vMin || pv > vMax) continue;
            if (!this.pointInPolygon(pu, pv, polyUV)) continue;
            const dist = dx * N.x + dy * N.y + dz * N.z;
            if (Math.abs(dist) > band) {
                excluded++;
                continue;
            }
            kept.push({ dist, pu, pv });
        }

        this.excludedSplatCount = excluded;
        if (kept.length === 0) return;

        // Adaptive resolution with aspect ratio: target ~3 splats per cell
        const TARGET_SPLATS_PER_CELL = 3;
        const totalCells = kept.length / TARGET_SPLATS_PER_CELL;
        const aspect = uRange / vRange;
        // resX * resY ≈ totalCells, resX/resY ≈ aspect
        const resY = Math.max(20, Math.min(200, Math.round(Math.sqrt(totalCells / aspect))));
        const resX = Math.max(20, Math.min(200, Math.round(resY * aspect)));
        this.gridResX = resX;
        this.gridResY = resY;

        // Bucket into grid
        const gridValues: number[][] = new Array(resX * resY);
        for (let k = 0; k < resX * resY; k++) gridValues[k] = [];

        for (const s of kept) {
            const gi = Math.min(Math.floor((s.pu - uMin) / uRange * resX), resX - 1);
            const gj = Math.min(Math.floor((s.pv - vMin) / vRange * resY), resY - 1);
            gridValues[gj * resX + gi].push(s.dist);
        }

        // Build raw grid with MEDIAN signed deviation per cell
        const rawGrid: (number | null)[][] = [];
        for (let j = 0; j < resY; j++) {
            const row: (number | null)[] = [];
            for (let i = 0; i < resX; i++) {
                const vals = gridValues[j * resX + i];
                row.push(vals.length >= 1 ? median(vals) : null);
            }
            rawGrid.push(row);
        }

        // Compute stats from valid cells
        const cellValues: number[] = [];
        for (let j = 0; j < resY; j++) {
            for (let i = 0; i < resX; i++) {
                if (rawGrid[j][i] !== null) cellValues.push(rawGrid[j][i]);
            }
        }

        if (cellValues.length > 0) {
            cellValues.sort((a, b) => a - b);
            const p5 = cellValues[Math.floor(0.05 * cellValues.length)];
            const p95 = cellValues[Math.min(Math.floor(0.95 * cellValues.length), cellValues.length - 1)];
            this.rawSplatStats = { min: p5, max: p95 };
        } else {
            this.rawSplatStats = null;
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

        this.rawGrid = rawGrid;
        this.insideMask = insideMask;
        this.rawSplatCount = kept.length;

        this.postProcessGrid();
    }

    // ── Post-processing: interpolation des cases vides ──

    private postProcessGrid() {
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

        if (!this.rawSplatStats) return;
        const { min, max } = this.rawSplatStats;

        this.gridData = { grid, measured, resX, resY, min, max };
    }

    // ── Heatmap color mapping (diverging: blue → green → red) ──

    private deviationToColor(signedDeviation: number): { r: number; g: number; b: number } {
        const scale = this.colorScale;
        // Normalize to [-1, 1] and clamp
        const t = Math.max(-1, Math.min(1, signedDeviation / scale));

        if (t < 0) {
            // Negative (inward): blue (#3b82f6) → green (#4ade80)
            const s = -t; // 0..1
            return {
                r: Math.round(74 + s * (59 - 74)),
                g: Math.round(222 + s * (130 - 222)),
                b: Math.round(128 + s * (246 - 128))
            };
        } else {
            // Positive (outward): green (#4ade80) → red (#ef4444)
            const s = t; // 0..1
            return {
                r: Math.round(74 + s * (239 - 74)),
                g: Math.round(222 + s * (68 - 222)),
                b: Math.round(128 + s * (68 - 128))
            };
        }
    }

    // ── Heatmap panel ──

    private showPanel() {
        this.removePanel();
        if (!this.gridData) return;

        const data = this.gridData;

        // Create panel container
        this.panel = document.createElement('div');
        this.panel.id = 'flatnessPanel';
        this.panel.style.cssText = `
            position: fixed;
            top: 80px;
            right: 16px;
            width: 300px;
            box-sizing: border-box;
            overflow: hidden;
            background: rgba(24, 24, 27, 0.92);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 12px;
            padding: 16px;
            color: #e4e4e7;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 13px;
            z-index: 1000;
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            pointer-events: auto;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        `;

        // Title
        const title = document.createElement('div');
        title.textContent = 'Planéité';
        title.style.cssText = 'font-size: 15px; font-weight: 600; margin-bottom: 12px; color: #fafafa;';
        this.panel.appendChild(title);

        // Color legend bar
        this.panel.appendChild(this.createLegend());

        // Toggles
        this.panel.appendChild(this.createToggle('Combler les trous', this.interpolationEnabled, (enabled) => {
            this.interpolationEnabled = enabled;
            this.postProcessGrid();
            this.showPanel();
        }));

        // Épaisseur analysée autour du plan
        this.panel.appendChild(this.createBandControl());

        // Color scale slider
        this.panel.appendChild(this.createColorScaleControl());

        // Heatmap canvas — match polygon aspect ratio
        const MAX_DISPLAY = 268;
        const aspect = data.resX / data.resY;
        const dispW = aspect >= 1 ? MAX_DISPLAY : Math.round(MAX_DISPLAY * aspect);
        const dispH = aspect >= 1 ? Math.round(MAX_DISPLAY / aspect) : MAX_DISPLAY;
        this.heatmapCanvas = document.createElement('canvas');
        this.heatmapCanvas.width = dispW;
        this.heatmapCanvas.height = dispH;
        this.heatmapCanvas.style.cssText = `
            position: relative;
            width: 100%;
            height: auto;
            border-radius: 6px;
            display: block;
            margin-top: 25px;
        `;
        this.panel.appendChild(this.heatmapCanvas);
        this.drawHeatmap();

        this.panel.appendChild(this.createInfo());

        // Insert into overlay
        this.overlay.appendChild(this.panel);
    }

    private removePanel() {
        if (this.panel) {
            this.panel.remove();
            this.panel = null;
            this.heatmapCanvas = null;
        }
    }

    private drawHeatmap() {
        if (!this.heatmapCanvas || !this.gridData) return;

        const data = this.gridData;
        const { resX, resY } = data;
        const dispW = this.heatmapCanvas.width;
        const dispH = this.heatmapCanvas.height;
        const ctx = this.heatmapCanvas.getContext('2d');
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
                    const hatch = !data.measured[gj][gi] && (di + dj) % 6 < 2;
                    pixels[k] = hatch ? (c.r + 255) >> 1 : c.r;
                    pixels[k + 1] = hatch ? (c.g + 255) >> 1 : c.g;
                    pixels[k + 2] = hatch ? (c.b + 255) >> 1 : c.b;
                    pixels[k + 3] = 255;
                }
            }
        }

        ctx.putImageData(imageData, 0, 0);
    }

    private createLegend(): HTMLDivElement {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'margin-bottom: 12px;';

        // Gradient bar: blue → green → red
        const bar = document.createElement('div');
        bar.style.cssText = `
            height: 12px;
            border-radius: 3px;
            background: linear-gradient(to right, #3b82f6 0%, #4ade80 50%, #ef4444 100%);
            margin-bottom: 4px;
        `;
        wrapper.appendChild(bar);

        // Labels (symmetric)
        const labels = document.createElement('div');
        labels.style.cssText = 'display: flex; justify-content: space-between; font-size: 11px; color: #a1a1aa;';
        const scaleCm = (this.colorScale * 100).toFixed(0);
        labels.innerHTML = `<span>-${scaleCm} cm</span><span>0</span><span>+${scaleCm} cm</span>`;
        wrapper.appendChild(labels);

        return wrapper;
    }

    private createStats(data: GridData): HTMLDivElement {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = `
            background: rgba(255, 255, 255, 0.05);
            border-radius: 8px;
            padding: 10px 12px;
            margin-bottom: 12px;
            font-variant-numeric: tabular-nums;
        `;

        const rows = [
            ['Écart min', `${(data.min * 100).toFixed(2)} cm`],
            ['Écart max', `${(data.max * 100).toFixed(2)} cm`]
        ];

        for (const [label, value] of rows) {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; justify-content: space-between; padding: 2px 0;';
            const labelEl = document.createElement('span');
            labelEl.style.color = '#a1a1aa';
            labelEl.textContent = label;
            const valueEl = document.createElement('span');
            valueEl.style.cssText = 'font-weight: 500; color: #fafafa;';
            valueEl.textContent = value;
            row.appendChild(labelEl);
            row.appendChild(valueEl);
            wrapper.appendChild(row);
        }

        return wrapper;
    }

    private createToggle(labelText: string, initialValue: boolean, onChange: (enabled: boolean) => void): HTMLDivElement {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display: flex; align-items: center; justify-content: space-between; margin-top: 8px;';

        const label = document.createElement('span');
        label.style.cssText = 'color: #a1a1aa; font-size: 12px;';
        label.textContent = labelText;

        const toggle = document.createElement('div');
        const updateStyle = (on: boolean) => {
            toggle.style.cssText = `
                width: 36px; height: 20px; border-radius: 10px; cursor: pointer; position: relative; transition: background 0.2s;
                background: ${on ? '#84cc16' : 'rgba(255,255,255,0.15)'};
            `;
            toggle.innerHTML = `<div style="
                width: 16px; height: 16px; border-radius: 50%; background: #fff; position: absolute; top: 2px; transition: left 0.2s;
                left: ${on ? '18px' : '2px'};
            "></div>`;
        };

        let state = initialValue;
        updateStyle(state);

        toggle.addEventListener('click', () => {
            state = !state;
            updateStyle(state);
            onChange(state);
        });

        wrapper.appendChild(label);
        wrapper.appendChild(toggle);

        return wrapper;
    }

    private createBandControl(): HTMLDivElement {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-top: 8px;';
        wrapper.title = 'Les splats plus éloignés du plan de référence sont ignorés (objets posés, charpente, végétation…)';

        const label = document.createElement('span');
        label.style.cssText = 'color: #a1a1aa; font-size: 12px; white-space: nowrap;';
        label.textContent = 'Épaisseur';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = String(MIN_BAND_CM);
        slider.max = String(MAX_BAND_CM);
        slider.value = String(Math.round(this.bandHalfWidth * 100));
        slider.style.cssText = 'flex: 1; accent-color: #84cc16; cursor: pointer;';

        const valueLabel = document.createElement('span');
        valueLabel.style.cssText = 'color: #fafafa; font-size: 12px; min-width: 50px; text-align: right;';
        valueLabel.textContent = `± ${slider.value} cm`;

        slider.addEventListener('input', () => {
            valueLabel.textContent = `± ${slider.value} cm`;
        });

        slider.addEventListener('change', () => {
            const newBand = parseInt(slider.value, 10) / 100;
            if (newBand !== this.bandHalfWidth) {
                this.bandHalfWidth = newBand;
                this.computeDeviations();
                this.showPanel();
            }
        });

        wrapper.appendChild(label);
        wrapper.appendChild(slider);
        wrapper.appendChild(valueLabel);

        return wrapper;
    }

    private createInfo(): HTMLDivElement {
        const info = document.createElement('div');
        info.style.cssText = 'margin-top: 8px; font-size: 11px; color: #a1a1aa; line-height: 1.5;';

        const total = this.rawSplatCount + this.excludedSplatCount;
        const lines = [`${this.rawSplatCount.toLocaleString('fr-FR')} points analysés`];
        if (this.excludedSplatCount > 0) {
            const pct = Math.round(this.excludedSplatCount / total * 100);
            lines.push(`${this.excludedSplatCount.toLocaleString('fr-FR')} hors épaisseur ignorés (${pct} %)`);
        }
        if (this.interpolationEnabled) lines.push('Hachures : zones sans points, valeurs estimées');
        info.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
        return info;
    }

    private createColorScaleControl(): HTMLDivElement {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-top: 8px;';

        const label = document.createElement('span');
        label.style.cssText = 'color: #a1a1aa; font-size: 12px; white-space: nowrap;';
        label.textContent = 'Échelle';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '1';
        slider.max = '30';
        slider.value = String(Math.round(this.colorScale * 100));
        slider.style.cssText = 'flex: 1; accent-color: #84cc16; cursor: pointer;';

        const valueLabel = document.createElement('span');
        valueLabel.style.cssText = 'color: #fafafa; font-size: 12px; min-width: 50px; text-align: right;';
        valueLabel.textContent = `± ${Math.round(this.colorScale * 100)} cm`;

        slider.addEventListener('input', () => {
            valueLabel.textContent = `± ${slider.value} cm`;
        });

        slider.addEventListener('change', () => {
            const newScale = parseInt(slider.value, 10) / 100;
            if (newScale !== this.colorScale) {
                this.colorScale = newScale;
                this.showPanel();
            }
        });

        wrapper.appendChild(label);
        wrapper.appendChild(slider);
        wrapper.appendChild(valueLabel);

        return wrapper;
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

            const pinRadius = isSelected ? 8 : isSnapTarget ? 8 : 6;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, pinRadius, 0, Math.PI * 2);
            ctx.fillStyle = isSelected ? '#FFFFFF' : isSnapTarget ? '#FFFFFF' : ACCENT_COLOR;
            ctx.fill();
            ctx.strokeStyle = isSelected ? ACCENT_COLOR : isSnapTarget ? ACCENT_COLOR : '#FFFFFF';
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
