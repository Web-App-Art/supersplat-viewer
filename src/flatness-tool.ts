import { Vec3, GSplatComponent } from 'playcanvas';
import type { Entity } from 'playcanvas';

import { ToolPointerHandler } from './tool-pointer-handler';
import { worldToScreen, drawEdgeLabel, ACCENT_COLOR, accentRgba } from './tool-utils';
import type { Global } from './types';

type FlatnessMeasureState = 'idle' | 'placing' | 'closed';

// Grid cell data for heatmap
interface GridData {
    grid: (number | null)[][];  // signed deviation values per cell (null = no data)
    resX: number;
    resY: number;
    min: number;
    max: number;
}

class FlatnessTool {
    private global: Global;
    private pointerHandler: ToolPointerHandler;
    private state: FlatnessMeasureState = 'idle';
    private currentPoints: Vec3[] = [];

    // Plane & grid results
    private planeOrigin: Vec3 | null = null;
    private planeNormal: Vec3 | null = null;
    private planeU: Vec3 | null = null;
    private planeV: Vec3 | null = null;
    private gridData: GridData | null = null;
    private gridResX = 50;
    private gridResY = 50;

    // Raw data for post-processing
    private rawGrid: (number | null)[][] | null = null;
    private insideMask: boolean[][] | null = null;
    private polyUV: { u: number; v: number }[] | null = null;
    private rawSplatCount = 0;
    private rawSplatStats: { min: number; max: number } | null = null;

    // Post-processing toggles
    private interpolationEnabled = true;
    private localPlaneEnabled = false;
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
        this.removePanel();

        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }

        this.drawCanvas = null;
        this.currentPoints = [];
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
                        this.state = 'closed';
                        this.computePlane();
                        this.computeDeviations();
                        this.showPanel();
                        return;
                    }
                }
            }
            // Max 8 sides
            if (this.currentPoints.length < 8) {
                this.currentPoints.push(pos);
            }
        }
    }

    private clearAll() {
        this.currentPoints = [];
        this.state = 'idle';
        this.planeOrigin = null;
        this.planeNormal = null;
        this.planeU = null;
        this.planeV = null;
        this.gridData = null;
        this.rawGrid = null;
        this.insideMask = null;
        this.polyUV = null;
        this.rawSplatCount = 0;
        this.rawSplatStats = null;
        this.removePanel();
        this.pointerHandler.reset();
    }

    // ── Splat data access ──

    private getSplatInfo() {
        const entity = this.global.app.root.findOne((node: any) => !!node.gsplat) as Entity | null;
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

        // LOD streaming path: collect centers from active placements via gsplatDirector
        const director = (this.global.app as any).renderer?.gsplatDirector;
        if (director) {
            const allCenters: Float32Array[] = [];
            let totalSplats = 0;

            for (const cameraData of director.camerasMap.values()) {
                for (const layerData of cameraData.layersMap.values()) {
                    const manager = layerData.gsplatManager;
                    if (!manager?.octreeInstances) continue;

                    for (const octreeInstance of manager.octreeInstances.values()) {
                        for (const placement of octreeInstance.activePlacements) {
                            const placementCenters = placement.resource?.centers as Float32Array;
                            if (placementCenters && placementCenters.length > 0) {
                                allCenters.push(placementCenters);
                                totalSplats += placementCenters.length / 3;
                            }
                        }
                    }
                }
            }

            if (totalSplats > 0) {
                const merged = new Float32Array(totalSplats * 3);
                let offset = 0;
                for (const c of allCenters) {
                    merged.set(c, offset);
                    offset += c.length;
                }
                return {
                    centers: merged,
                    numSplats: totalSplats,
                    worldMatrix
                };
            }
        }

        return null;
    }

    // ── Best-fit plane from N points (least squares) ──

    private computePlane() {
        const pts = this.currentPoints;
        if (pts.length < 3) return;

        // Centroid
        const O = new Vec3(0, 0, 0);
        for (const p of pts) {
            O.x += p.x; O.y += p.y; O.z += p.z;
        }
        O.mulScalar(1 / pts.length);

        // Covariance matrix (symmetric 3×3)
        let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
        for (const p of pts) {
            const dx = p.x - O.x, dy = p.y - O.y, dz = p.z - O.z;
            xx += dx * dx; xy += dx * dy; xz += dx * dz;
            yy += dy * dy; yz += dy * dz; zz += dz * dz;
        }

        // Find normal via power iteration on the cofactor (adjugate) matrix
        const c00 = yy * zz - yz * yz;
        const c01 = xz * yz - xy * zz;
        const c02 = xy * yz - xz * yy;
        const c11 = xx * zz - xz * xz;
        const c12 = xy * xz - xx * yz;
        const c22 = xx * yy - xy * xy;

        let nx = 1, ny = 1, nz = 1;
        for (let iter = 0; iter < 20; iter++) {
            const tx = c00 * nx + c01 * ny + c02 * nz;
            const ty = c01 * nx + c11 * ny + c12 * nz;
            const tz = c02 * nx + c12 * ny + c22 * nz;
            const len = Math.sqrt(tx * tx + ty * ty + tz * tz);
            if (len < 1e-12) break;
            nx = tx / len; ny = ty / len; nz = tz / len;
        }

        const N = new Vec3(nx, ny, nz);

        // Ensure normal points towards camera
        const camPos = this.global.camera.getPosition();
        const toCamera = new Vec3().sub2(camPos, O);
        if (toCamera.dot(N) < 0) {
            N.mulScalar(-1);
        }

        this.planeOrigin = O;
        this.planeNormal = N;

        // Build local 2D basis aligned with camera orientation:
        // U = camera right projected onto plane (→ heatmap horizontal ≈ screen horizontal)
        // V = N × U (→ heatmap vertical ≈ screen vertical, but pointing down)
        const camRight = this.global.camera.right.clone();
        // Project camera right onto the plane: remove the normal component
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
        // V points "down" on screen (camera up projected, but inverted so grid row 0 = top)
        const V = new Vec3().cross(U, N).normalize();

        this.planeU = U;
        this.planeV = V;
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

    // ── Compute deviations: iterate splats, project, bucket into grid ──

    private computeDeviations() {
        if (!this.planeOrigin || !this.planeNormal || !this.planeU || !this.planeV) return;

        const info = this.getSplatInfo();
        if (!info) return;

        const { centers, numSplats, worldMatrix: m } = info;
        const O = this.planeOrigin;
        const N = this.planeNormal;
        const U = this.planeU;
        const V = this.planeV;
        const COARSE_DIST = 0.15;  // first pass: generous filter to find plane offset
        const FINE_DIST = 0.05;    // second pass: tight filter for actual measurements

        // Project polygon corners into UV space
        const polyUV = this.currentPoints.map(p => {
            const dx = p.x - O.x, dy = p.y - O.y, dz = p.z - O.z;
            return { u: dx * U.x + dy * U.y + dz * U.z, v: dx * V.x + dy * V.y + dz * V.z };
        });
        this.polyUV = polyUV;

        // Compute UV bounding box of the polygon
        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (const q of polyUV) {
            if (q.u < uMin) uMin = q.u; if (q.u > uMax) uMax = q.u;
            if (q.v < vMin) vMin = q.v; if (q.v > vMax) vMax = q.v;
        }
        const uRange = uMax - uMin;
        const vRange = vMax - vMin;

        // Helper: collect splats within maxDist of plane, return signed distances
        const collectSplats = (maxDist: number, planeShift: number) => {
            const dists: { dist: number; pu: number; pv: number }[] = [];
            for (let i = 0; i < numSplats; i++) {
                const idx = i * 3;
                const lx = centers[idx], ly = centers[idx + 1], lz = centers[idx + 2];
                const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
                const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
                const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
                const dx = wx - O.x, dy = wy - O.y, dz = wz - O.z;
                const rawDist = dx * N.x + dy * N.y + dz * N.z;
                const dist = rawDist - planeShift;
                if (Math.abs(dist) > maxDist) continue;
                const pu = dx * U.x + dy * U.y + dz * U.z;
                const pv = dx * V.x + dy * V.y + dz * V.z;
                if (pu < uMin || pu > uMax || pv < vMin || pv > vMax) continue;
                if (!this.pointInPolygon(pu, pv, polyUV)) continue;
                dists.push({ dist, pu, pv });
            }
            return dists;
        };

        // === Pass 1: Find plane offset with coarse filter ===
        const coarseSplats = collectSplats(COARSE_DIST, 0);
        if (coarseSplats.length === 0) return;

        // Median of all coarse distances = plane offset
        const coarseDists = coarseSplats.map(s => s.dist + 0); // copy raw dists (shift=0)
        coarseDists.sort((a, b) => a - b);
        const planeOffset = coarseDists[Math.floor(coarseDists.length / 2)];


        // === Pass 2: Re-collect with recentered plane and tight filter ===
        const fineSplats = collectSplats(FINE_DIST, planeOffset);


        if (fineSplats.length === 0) return;

        // Adaptive resolution with aspect ratio: target ~3 splats per cell
        const TARGET_SPLATS_PER_CELL = 3;
        const totalCells = fineSplats.length / TARGET_SPLATS_PER_CELL;
        const aspect = uRange / vRange;
        // resX * resY ≈ totalCells, resX/resY ≈ aspect
        const resY = Math.max(20, Math.min(200, Math.round(Math.sqrt(totalCells / aspect))));
        const resX = Math.max(20, Math.min(200, Math.round(resY * aspect)));
        this.gridResX = resX;
        this.gridResY = resY;

        // Bucket into grid
        const gridValues: number[][] = new Array(resX * resY);
        for (let k = 0; k < resX * resY; k++) gridValues[k] = [];

        for (const s of fineSplats) {
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
                if (vals.length >= 1) {
                    vals.sort((a, b) => a - b);
                    const mid = Math.floor(vals.length / 2);
                    row.push(vals.length % 2 === 1 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2);
                } else {
                    row.push(null);
                }
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
        this.rawSplatCount = fineSplats.length;

        this.postProcessGrid();
    }

    // ── Post-processing: interpolation + local plane smoothing ──

    private postProcessGrid() {
        if (!this.rawGrid || !this.insideMask) return;

        const resX = this.gridResX;
        const resY = this.gridResY;

        const grid: (number | null)[][] = this.rawGrid.map(row => [...row]);
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

        // Local plane smoothing: box blur
        if (this.localPlaneEnabled) {
            const radius = Math.max(3, Math.round(Math.min(resX, resY) * 0.08));
            const hBlur: (number | null)[][] = grid.map(row => [...row]);
            for (let j = 0; j < resY; j++) {
                for (let i = 0; i < resX; i++) {
                    if (!mask[j][i]) continue;
                    let sum = 0, count = 0;
                    for (let di = -radius; di <= radius; di++) {
                        const ni = i + di;
                        if (ni >= 0 && ni < resX && grid[j][ni] !== null) { sum += grid[j][ni]; count++; }
                    }
                    hBlur[j][i] = count > 0 ? sum / count : null;
                }
            }
            for (let j = 0; j < resY; j++) {
                for (let i = 0; i < resX; i++) {
                    if (!mask[j][i]) continue;
                    let sum = 0, count = 0;
                    for (let dj = -radius; dj <= radius; dj++) {
                        const nj = j + dj;
                        if (nj >= 0 && nj < resY && hBlur[nj][i] !== null) { sum += hBlur[nj][i]; count++; }
                    }
                    grid[j][i] = count > 0 ? sum / count : null;
                }
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

        this.gridData = { grid, resX, resY, min, max };
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
        if (!this.gridData) return;

        this.removePanel();

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
        this.panel.appendChild(this.createToggle('Lissage local', this.localPlaneEnabled, (enabled) => {
            this.localPlaneEnabled = enabled;
            this.postProcessGrid();
            this.showPanel();
        }));

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
                    pixels[k] = c.r;
                    pixels[k + 1] = c.g;
                    pixels[k + 2] = c.b;
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
