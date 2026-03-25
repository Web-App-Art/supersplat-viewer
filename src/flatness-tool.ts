import { Vec3, GSplatComponent } from 'playcanvas';
import type { Entity } from 'playcanvas';

import { ToolPointerHandler } from './tool-pointer-handler';
import { worldToScreen, drawEdgeLabel, ACCENT_COLOR, accentRgba } from './tool-utils';
import type { Global } from './types';

type FlatnessMeasureState = 'idle' | 'placing' | 'closed';

// Grid cell data for heatmap
interface GridData {
    grid: (number | null)[][];  // deviation values per cell (null = no data)
    resolution: number;
    min: number;
    max: number;
    mean: number;
    stdDev: number;
    splatCount: number;
}

// Heatmap color thresholds (in meters)
const THRESH_GREEN = 0.02;  // 0–2cm = green (flat)
const THRESH_ORANGE = 0.05; // 2–5cm = orange (moderate)
// > 5cm = red (significant)

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
    private gridResolution = 100;

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
            if (this.currentPoints.length >= 3) {
                this.currentPoints.push(pos);
                this.state = 'closed';
                this.computePlane();
                this.computeDeviations();
                this.showPanel();
                return;
            }
            this.currentPoints.push(pos);
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
        this.removePanel();
        this.pointerHandler.reset();
    }

    // ── Splat data access (same pattern as floorplan-tool) ──

    private getSplatInfo() {
        const entity = this.global.app.root.findOne((node: any) => !!node.gsplat) as Entity | null;
        if (!entity) return null;

        const comp = (entity as any).gsplat as GSplatComponent;
        const resource = comp.resource ?? (comp.instance as any)?.resource;
        if (!resource) return null;

        const centers = (resource as any).centers as Float32Array;
        if (!centers || centers.length === 0) return null;

        return {
            centers,
            numSplats: centers.length / 3,
            worldMatrix: entity.getWorldTransform().data as Float32Array
        };
    }

    // ── Best-fit plane from 4 points (least squares) ──

    private computePlane() {
        const pts = this.currentPoints;
        if (pts.length !== 4) return;

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

        // Build local 2D basis on the plane
        const toP0 = new Vec3().sub2(pts[0], O);
        const dotN = toP0.dot(N);
        const U = new Vec3(toP0.x - dotN * N.x, toP0.y - dotN * N.y, toP0.z - dotN * N.z);
        const uLen = U.length();
        if (uLen < 1e-10) {
            const absX = Math.abs(N.x), absY = Math.abs(N.y), absZ = Math.abs(N.z);
            const up = absX <= absY && absX <= absZ ? new Vec3(1, 0, 0) :
                       absY <= absZ ? new Vec3(0, 1, 0) : new Vec3(0, 0, 1);
            U.cross(up, N).normalize();
        } else {
            U.mulScalar(1 / uLen);
        }
        const V = new Vec3().cross(N, U).normalize();

        this.planeU = U;
        this.planeV = V;
    }

    // ── Point-in-quad test (split into 2 triangles) ──

    private pointInTriangle(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
        const v0x = cx - ax, v0y = cy - ay;
        const v1x = bx - ax, v1y = by - ay;
        const v2x = px - ax, v2y = py - ay;
        const dot00 = v0x * v0x + v0y * v0y;
        const dot01 = v0x * v1x + v0y * v1y;
        const dot02 = v0x * v2x + v0y * v2y;
        const dot11 = v1x * v1x + v1y * v1y;
        const dot12 = v1x * v2x + v1y * v2y;
        const inv = 1 / (dot00 * dot11 - dot01 * dot01);
        const u = (dot11 * dot02 - dot01 * dot12) * inv;
        const v = (dot00 * dot12 - dot01 * dot02) * inv;
        return u >= 0 && v >= 0 && u + v <= 1;
    }

    private pointInQuad(pu: number, pv: number, quadUV: { u: number; v: number }[]): boolean {
        const [a, b, c, d] = quadUV;
        return this.pointInTriangle(pu, pv, a.u, a.v, b.u, b.v, c.u, c.v) ||
               this.pointInTriangle(pu, pv, a.u, a.v, c.u, c.v, d.u, d.v);
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
        const res = this.gridResolution;
        const MAX_DIST = 0.5;

        // Project the 4 quad corners into UV space
        const quadUV = this.currentPoints.map(p => {
            const dx = p.x - O.x, dy = p.y - O.y, dz = p.z - O.z;
            return { u: dx * U.x + dy * U.y + dz * U.z, v: dx * V.x + dy * V.y + dz * V.z };
        });

        // Compute UV bounding box of the quad
        let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
        for (const q of quadUV) {
            if (q.u < uMin) uMin = q.u; if (q.u > uMax) uMax = q.u;
            if (q.v < vMin) vMin = q.v; if (q.v > vMax) vMax = q.v;
        }
        const uRange = uMax - uMin;
        const vRange = vMax - vMin;

        // Grid accumulators
        const gridSum: number[] = new Array(res * res).fill(0);
        const gridCount: number[] = new Array(res * res).fill(0);
        let totalSplats = 0;

        for (let i = 0; i < numSplats; i++) {
            const idx = i * 3;
            const lx = centers[idx], ly = centers[idx + 1], lz = centers[idx + 2];

            const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
            const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
            const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];

            const dx = wx - O.x, dy = wy - O.y, dz = wz - O.z;
            const dist = dx * N.x + dy * N.y + dz * N.z;

            if (Math.abs(dist) > MAX_DIST) continue;

            const pu = dx * U.x + dy * U.y + dz * U.z;
            const pv = dx * V.x + dy * V.y + dz * V.z;

            if (pu < uMin || pu > uMax || pv < vMin || pv > vMax) continue;
            if (!this.pointInQuad(pu, pv, quadUV)) continue;

            const gi = Math.min(Math.floor((pu - uMin) / uRange * res), res - 1);
            const gj = Math.min(Math.floor((pv - vMin) / vRange * res), res - 1);

            gridSum[gj * res + gi] += dist;
            gridCount[gj * res + gi]++;
            totalSplats++;
        }

        // Build grid with average deviation per cell
        const grid: (number | null)[][] = [];
        const allValues: number[] = [];

        for (let j = 0; j < res; j++) {
            const row: (number | null)[] = [];
            for (let i = 0; i < res; i++) {
                const k = j * res + i;
                if (gridCount[k] > 0) {
                    const avg = gridSum[k] / gridCount[k];
                    row.push(avg);
                    allValues.push(avg);
                } else {
                    row.push(null);
                }
            }
            grid.push(row);
        }

        if (allValues.length === 0) return;

        const absValues = allValues.map(v => Math.abs(v));
        const min = Math.min(...absValues);
        const max = Math.max(...absValues);
        const mean = absValues.reduce((a, b) => a + b, 0) / absValues.length;
        const variance = absValues.reduce((a, v) => a + (v - mean) * (v - mean), 0) / absValues.length;
        const stdDev = Math.sqrt(variance);

        this.gridData = { grid, resolution: res, min, max, mean, stdDev, splatCount: totalSplats };
    }

    // ── Heatmap color mapping ──

    private deviationToColor(absDeviation: number): { r: number; g: number; b: number } {
        if (absDeviation <= THRESH_GREEN) {
            // Green: #4ade80
            return { r: 74, g: 222, b: 128 };
        } else if (absDeviation <= THRESH_ORANGE) {
            // Interpolate green → orange
            const t = (absDeviation - THRESH_GREEN) / (THRESH_ORANGE - THRESH_GREEN);
            return {
                r: Math.round(74 + t * (251 - 74)),
                g: Math.round(222 + t * (146 - 222)),
                b: Math.round(128 + t * (60 - 128))
            };
        } else {
            // Interpolate orange → red (cap at 10cm for full red)
            const t = Math.min((absDeviation - THRESH_ORANGE) / (0.10 - THRESH_ORANGE), 1);
            return {
                r: Math.round(251 + t * (239 - 251)),
                g: Math.round(146 + t * (68 - 146)),
                b: Math.round(60 + t * (68 - 60))
            };
        }
    }

    // ── Heatmap panel ──

    private showPanel() {
        if (!this.gridData) return;

        this.removePanel();

        const data = this.gridData;
        const res = data.resolution;

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

        // Stats
        this.panel.appendChild(this.createStats(data));

        // Resolution slider
        this.panel.appendChild(this.createResolutionControl());

        // Heatmap canvas (last child)
        this.heatmapCanvas = document.createElement('canvas');
        this.heatmapCanvas.width = res;
        this.heatmapCanvas.height = res;
        this.heatmapCanvas.style.cssText = `
            position: relative;
            width: 100%;
            height: auto;
            aspect-ratio: 1;
            border-radius: 6px;
            image-rendering: pixelated;
            display: block;
            margin-top: 25px;
        `;
        this.panel.appendChild(this.heatmapCanvas);
        this.drawHeatmap();

        // Insert into UI layer (above the overlay canvas)
        const ui = document.querySelector('#ui');
        ui.appendChild(this.panel);
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
        const res = data.resolution;
        const ctx = this.heatmapCanvas.getContext('2d');
        const imageData = ctx.createImageData(res, res);
        const pixels = imageData.data;

        for (let j = 0; j < res; j++) {
            for (let i = 0; i < res; i++) {
                const k = (j * res + i) * 4;
                const val = data.grid[j][i];
                if (val === null) {
                    // No data — dark gray
                    pixels[k] = 63;
                    pixels[k + 1] = 63;
                    pixels[k + 2] = 70;
                    pixels[k + 3] = 255;
                } else {
                    const c = this.deviationToColor(Math.abs(val));
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

        // Gradient bar
        const bar = document.createElement('div');
        bar.style.cssText = `
            height: 12px;
            border-radius: 3px;
            background: linear-gradient(to right, #4ade80 0%, #fb923c 50%, #ef4444 100%);
            margin-bottom: 4px;
        `;
        wrapper.appendChild(bar);

        // Labels
        const labels = document.createElement('div');
        labels.style.cssText = 'display: flex; justify-content: space-between; font-size: 11px; color: #a1a1aa;';
        labels.innerHTML = '<span>0 cm</span><span>2 cm</span><span>5 cm</span><span>&gt;10 cm</span>';
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
            ['Écart max', `${(data.max * 100).toFixed(2)} cm`],
            ['Moyenne', `${(data.mean * 100).toFixed(2)} cm`],
            ['Écart-type', `${(data.stdDev * 100).toFixed(2)} cm`],
            ['Splats', data.splatCount.toLocaleString()]
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

    private createResolutionControl(): HTMLDivElement {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display: flex; align-items: center; gap: 10px;';

        const label = document.createElement('span');
        label.style.cssText = 'color: #a1a1aa; font-size: 12px; white-space: nowrap;';
        label.textContent = 'Résolution';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '50';
        slider.max = '250';
        slider.value = String(this.gridResolution);
        slider.style.cssText = 'flex: 1; accent-color: #84cc16; cursor: pointer;';

        const valueLabel = document.createElement('span');
        valueLabel.style.cssText = 'color: #fafafa; font-size: 12px; min-width: 40px; text-align: right;';
        valueLabel.textContent = `${this.gridResolution}×${this.gridResolution}`;

        slider.addEventListener('input', () => {
            const newRes = parseInt(slider.value, 10);
            valueLabel.textContent = `${newRes}×${newRes}`;
        });

        slider.addEventListener('change', () => {
            const newRes = parseInt(slider.value, 10);
            if (newRes !== this.gridResolution) {
                this.gridResolution = newRes;
                this.computeDeviations();
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
            this.drawQuad(ctx, this.currentPoints, this.state === 'closed');
        }
    }

    private drawQuad(ctx: CanvasRenderingContext2D, points: Vec3[], closed: boolean) {
        const camera = this.global.camera;
        const screenPoints = points.map(p => worldToScreen(camera, p));
        const allVisible = screenPoints.every(s => !s.behind);
        if (!allVisible) return;

        // Draw filled quad
        if (closed && screenPoints.length === 4) {
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
        if (closed && screenPoints.length === 4) {
            ctx.beginPath();
            ctx.moveTo(screenPoints[3].x, screenPoints[3].y);
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
            const pinRadius = isSelected ? 8 : 6;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, pinRadius, 0, Math.PI * 2);
            ctx.fillStyle = isSelected ? '#FFFFFF' : ACCENT_COLOR;
            ctx.fill();
            ctx.strokeStyle = isSelected ? ACCENT_COLOR : '#FFFFFF';
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
        if (closed && screenPoints.length === 4) {
            drawEdgeLabel(ctx, points[3], points[0], screenPoints[3], screenPoints[0]);
        }
    }
}

export { FlatnessTool };
