import { GSplatComponent } from 'playcanvas';
import type { Entity } from 'playcanvas';
import type { Global } from '../types';

class FloorplanTool {
    private global: Global;
    private overlay: HTMLDivElement | null = null;
    private panel: HTMLDivElement | null = null;
    private canvas: HTMLCanvasElement | null = null;

    // Generated floorplan data
    private offscreen: HTMLCanvasElement | null = null;
    private coverageData: Float32Array | null = null;
    private gridMeta: { originX: number; originZ: number; cellSize: number; res: number } | null = null;

    // Pan/zoom state
    private panX = 0;
    private panY = 0;
    private zoom = 1;
    private isPanning = false;
    private lastPX = 0;
    private lastPY = 0;

    // Settings
    private gridResolution = 512;
    private colorMode = false;

    // Bound handlers for cleanup
    private _onWheel: ((e: WheelEvent) => void) | null = null;
    private _onPtrDown: ((e: PointerEvent) => void) | null = null;
    private _onPtrMove: ((e: PointerEvent) => void) | null = null;
    private _onPtrUp: ((e: PointerEvent) => void) | null = null;
    private _onResize: (() => void) | null = null;

    constructor(global: Global) {
        this.global = global;
    }

    // ── Lifecycle ──────────────────────────────────────────

    activate() {
        this.overlay = document.createElement('div');
        this.overlay.id = 'floorplanOverlay';
        const ui = document.querySelector('#ui');
        ui.insertBefore(this.overlay, ui.firstChild);

        // Canvas first (lower z-index)
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'floorplanCanvas';
        this.overlay.appendChild(this.canvas);

        // Panel on top
        this.panel = this.createPanel();
        this.overlay.appendChild(this.panel);

        this.resizeCanvas();
        this.setupEvents();
        this.renderCanvas();
    }

    deactivate() {
        this.cleanupEvents();
        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }
        this.panel = null;
        this.canvas = null;
        this.offscreen = null;
        this.coverageData = null;
        this.gridMeta = null;
        this.panX = 0;
        this.panY = 0;
        this.zoom = 1;
    }

    destroy() {
        this.deactivate();
    }

    // ── Panel UI ──────────────────────────────────────────

    private createPanel(): HTMLDivElement {
        const panel = document.createElement('div');
        panel.id = 'floorplanPanel';

        const title = document.createElement('div');
        title.className = 'floorplan-title';
        title.textContent = 'Floorplan';
        panel.appendChild(title);

        const desc = document.createElement('div');
        desc.className = 'floorplan-desc';
        desc.textContent = 'Auto wall detection — columns of splats spanning the full height are detected as walls.';
        panel.appendChild(desc);

        // Grid resolution slider
        panel.appendChild(this.createSliderRow(
            'Resolution', 128, 1024, this.gridResolution, 1, 'px',
            (v) => { this.gridResolution = v; }
        ));

        // Color mode toggle
        const colorRow = document.createElement('div');
        colorRow.className = 'floorplan-row floorplan-row-inline';
        const colorLabel = document.createElement('label');
        colorLabel.className = 'floorplan-check-label';
        const colorCheck = document.createElement('input');
        colorCheck.type = 'checkbox';
        colorCheck.checked = this.colorMode;
        colorCheck.addEventListener('change', () => {
            this.colorMode = colorCheck.checked;
        });
        colorLabel.appendChild(colorCheck);
        colorLabel.appendChild(document.createTextNode(' Color mode'));
        colorRow.appendChild(colorLabel);
        panel.appendChild(colorRow);

        // Generate button
        const genBtn = document.createElement('button');
        genBtn.className = 'floorplan-btn floorplan-btn-primary';
        genBtn.textContent = 'Generate';
        genBtn.addEventListener('click', () => this.generate());
        panel.appendChild(genBtn);

        // Export button
        const expBtn = document.createElement('button');
        expBtn.className = 'floorplan-btn';
        expBtn.textContent = 'Export PNG';
        expBtn.addEventListener('click', () => {
            // Step 5
        });
        panel.appendChild(expBtn);

        return panel;
    }

    private createSliderRow(
        label: string, min: number, max: number, value: number,
        step: number, unit: string, onChange: (v: number) => void
    ): HTMLDivElement {
        const row = document.createElement('div');
        row.className = 'floorplan-row';

        const lbl = document.createElement('div');
        lbl.className = 'floorplan-slider-label';
        lbl.textContent = label;
        row.appendChild(lbl);

        const wrap = document.createElement('div');
        wrap.className = 'floorplan-slider-wrap';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = String(min);
        slider.max = String(max);
        slider.step = String(step);
        slider.value = String(value);
        slider.className = 'floorplan-slider';

        const val = document.createElement('span');
        val.className = 'floorplan-slider-value';
        val.textContent = `${value}${unit}`;

        slider.addEventListener('input', () => {
            const v = parseFloat(slider.value);
            val.textContent = `${step >= 1 ? v : v.toFixed(2)}${unit}`;
            onChange(v);
        });

        wrap.appendChild(slider);
        wrap.appendChild(val);
        row.appendChild(wrap);
        return row;
    }

    // ── Splat data access ─────────────────────────────────

    private getSplatInfo() {
        const entity = this.global.app.root.findOne((node: any) => !!node.gsplat) as Entity | null;
        if (!entity) {
            console.warn('[FloorplanTool] No gsplat entity found');
            return null;
        }

        const comp = (entity as any).gsplat as GSplatComponent;
        const resource = comp.resource ?? (comp.instance as any)?.resource;
        if (!resource) {
            console.warn('[FloorplanTool] No gsplat resource');
            return null;
        }

        // Use resource.centers (Float32Array used for CPU sorting)
        // This works for all formats (PLY, compressed, SOG)
        const centers = (resource as any).centers as Float32Array;
        if (!centers || centers.length === 0) {
            console.warn('[FloorplanTool] No centers on resource');
            return null;
        }

        const numSplats = centers.length / 3;
        console.log(`[FloorplanTool] Found ${numSplats} splats via resource.centers`);

        return {
            centers,
            numSplats,
            worldMatrix: entity.getWorldTransform().data as Float32Array
        };
    }

    // ── Generation ────────────────────────────────────────

    private generate() {
        const info = this.getSplatInfo();
        if (!info) return;

        const { centers, numSplats, worldMatrix: m } = info;
        const res = this.gridResolution;

        console.log(`[FloorplanTool] Generating: ${numSplats} splats, ${res}px grid`);
        const t0 = performance.now();

        // ── Pass 1: compute world-space bounds ──
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        let minZ = Infinity, maxZ = -Infinity;

        for (let i = 0; i < numSplats; i++) {
            const idx = i * 3;
            const lx = centers[idx], ly = centers[idx + 1], lz = centers[idx + 2];
            const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
            const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
            const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
            if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
            if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
            if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
        }

        // Square grid using the larger XZ range
        const rangeX = maxX - minX || 1;
        const rangeZ = maxZ - minZ || 1;
        const maxRange = Math.max(rangeX, rangeZ) * 1.02; // 1% margin
        const cellSize = maxRange / res;
        const originX = (minX + maxX) / 2 - maxRange / 2;
        const originZ = (minZ + maxZ) / 2 - maxRange / 2;

        // Y bins for vertical coverage
        const rangeY = maxY - minY || 1;
        const NUM_Y_BINS = 24;
        const yBinScale = NUM_Y_BINS / rangeY;

        // Allocate bins: one byte per (cell, yBin)
        const gridBins = new Uint8Array(res * res * NUM_Y_BINS);

        // ── Pass 2: bin each splat ──
        const invCell = 1 / cellSize;
        for (let i = 0; i < numSplats; i++) {
            const idx = i * 3;
            const lx = centers[idx], ly = centers[idx + 1], lz = centers[idx + 2];
            const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
            const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
            const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];

            const gx = (wx - originX) * invCell | 0;
            const gz = (wz - originZ) * invCell | 0;
            if (gx < 0 || gx >= res || gz < 0 || gz >= res) continue;

            let yBin = ((wy - minY) * yBinScale) | 0;
            if (yBin >= NUM_Y_BINS) yBin = NUM_Y_BINS - 1;

            gridBins[(gz * res + gx) * NUM_Y_BINS + yBin] = 1;
        }

        // ── Compute vertical coverage per cell ──
        const coverage = new Float32Array(res * res);
        const invBins = 1 / NUM_Y_BINS;
        for (let i = 0; i < res * res; i++) {
            let count = 0;
            const base = i * NUM_Y_BINS;
            for (let b = 0; b < NUM_Y_BINS; b++) {
                count += gridBins[base + b];
            }
            coverage[i] = count * invBins;
        }

        const t1 = performance.now();
        console.log(`[FloorplanTool] Computed in ${(t1 - t0).toFixed(1)}ms`);

        // Store results
        this.coverageData = coverage;
        this.gridMeta = { originX, originZ, cellSize, res };

        // Render to offscreen canvas
        this.renderOffscreen();

        // Reset pan/zoom and draw
        this.panX = 0;
        this.panY = 0;
        this.zoom = 1;
        this.renderCanvas();
    }

    // ── Offscreen rendering ───────────────────────────────

    private renderOffscreen() {
        if (!this.coverageData || !this.gridMeta) return;

        const { res } = this.gridMeta;
        const coverage = this.coverageData;

        this.offscreen = document.createElement('canvas');
        this.offscreen.width = res;
        this.offscreen.height = res;
        const ctx = this.offscreen.getContext('2d')!;
        const img = ctx.createImageData(res, res);
        const px = img.data;

        for (let i = 0; i < res * res; i++) {
            const v = coverage[i];
            // gamma < 1 compresses highlights, making walls pop against light bg
            const darkness = Math.pow(v, 0.4);
            const c = ((1 - darkness) * 255 + 0.5) | 0;
            const off = i * 4;
            px[off] = c;
            px[off + 1] = c;
            px[off + 2] = c;
            px[off + 3] = 255;
        }

        ctx.putImageData(img, 0, 0);
    }

    // ── Canvas rendering (viewport with pan/zoom) ─────────

    private renderCanvas() {
        if (!this.canvas) return;
        const ctx = this.canvas.getContext('2d');
        if (!ctx) return;

        const w = this.canvas.width;
        const h = this.canvas.height;

        // Clear with light background
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#e8e8e8';
        ctx.fillRect(0, 0, w, h);

        if (this.offscreen) {
            const ow = this.offscreen.width;
            const oh = this.offscreen.height;

            // Fit the image initially so it fills the canvas with some padding
            const fitScale = Math.min(w, h) / Math.max(ow, oh) * 0.9;

            ctx.translate(w / 2 + this.panX, h / 2 + this.panY);
            ctx.scale(this.zoom * fitScale, this.zoom * fitScale);
            ctx.translate(-ow / 2, -oh / 2);

            ctx.imageSmoothingEnabled = this.zoom * fitScale < 2;
            ctx.drawImage(this.offscreen, 0, 0);
        } else {
            // Placeholder
            ctx.fillStyle = '#bbb';
            ctx.font = '14px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Click "Generate" to create floorplan', w / 2, h / 2);
        }
    }

    // ── Canvas sizing ─────────────────────────────────────

    private resizeCanvas() {
        if (!this.canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const cw = this.canvas.clientWidth;
        const ch = this.canvas.clientHeight;
        if (this.canvas.width !== cw * dpr || this.canvas.height !== ch * dpr) {
            this.canvas.width = cw * dpr;
            this.canvas.height = ch * dpr;
        }
    }

    // ── Events ────────────────────────────────────────────

    private setupEvents() {
        if (!this.canvas) return;

        this._onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            this.zoom = Math.max(0.1, Math.min(30, this.zoom * factor));
            this.renderCanvas();
        };

        this._onPtrDown = (e: PointerEvent) => {
            this.isPanning = true;
            this.lastPX = e.clientX;
            this.lastPY = e.clientY;
            this.canvas!.setPointerCapture(e.pointerId);
        };

        this._onPtrMove = (e: PointerEvent) => {
            if (!this.isPanning) return;
            this.panX += e.clientX - this.lastPX;
            this.panY += e.clientY - this.lastPY;
            this.lastPX = e.clientX;
            this.lastPY = e.clientY;
            this.renderCanvas();
        };

        this._onPtrUp = (e: PointerEvent) => {
            if (!this.isPanning) return;
            this.isPanning = false;
            this.canvas!.releasePointerCapture(e.pointerId);
        };

        this._onResize = () => {
            this.resizeCanvas();
            this.renderCanvas();
        };

        this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
        this.canvas.addEventListener('pointerdown', this._onPtrDown);
        this.canvas.addEventListener('pointermove', this._onPtrMove);
        this.canvas.addEventListener('pointerup', this._onPtrUp);
        window.addEventListener('resize', this._onResize);
    }

    private cleanupEvents() {
        if (this.canvas) {
            if (this._onWheel) this.canvas.removeEventListener('wheel', this._onWheel);
            if (this._onPtrDown) this.canvas.removeEventListener('pointerdown', this._onPtrDown);
            if (this._onPtrMove) this.canvas.removeEventListener('pointermove', this._onPtrMove);
            if (this._onPtrUp) this.canvas.removeEventListener('pointerup', this._onPtrUp);
        }
        if (this._onResize) window.removeEventListener('resize', this._onResize);
    }
}

export { FloorplanTool };
