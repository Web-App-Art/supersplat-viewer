import { Vec3 } from 'playcanvas';

import { ToolPointerHandler } from './tool-pointer-handler';
import { worldToScreen, drawEdgeLabel, formatDistance, ACCENT_COLOR } from './tool-utils';
import type { Global } from './types';

type MeasureState = 'idle' | 'first_placed' | 'complete';

// Format a single coordinate component (signed, in meters or cm depending on magnitude)
function formatComponent(v: number): string {
    const abs = Math.abs(v);
    if (abs >= 1) return `${v >= 0 ? ' ' : ''}${v.toFixed(3)} m`;
    return `${v >= 0 ? ' ' : ''}${(v * 100).toFixed(1)} cm`;
}

class MeasureTool {
    private global: Global;
    private pointerHandler: ToolPointerHandler;
    private points: Vec3[] = [];
    private measureState: MeasureState = 'idle';

    private overlay: HTMLDivElement | null = null;
    private drawCanvas: HTMLCanvasElement | null = null;
    private updateHandler: ((dt: number) => void) | null = null;

    // Info panel (option 2): floating card showing distance + ΔX/ΔY/ΔZ
    private panel: HTMLDivElement | null = null;
    private panelDistEl: HTMLSpanElement | null = null;
    private panelDxEl: HTMLSpanElement | null = null;
    private panelDyEl: HTMLSpanElement | null = null;
    private panelDzEl: HTMLSpanElement | null = null;

    constructor(global: Global) {
        this.global = global;
        this.pointerHandler = new ToolPointerHandler(global, {
            onCanvasClick: (pos, clientX, clientY) => this.handleClick(pos, clientX, clientY),
            getDraggablePoints: () => this.measureState === 'complete' ? this.points : [],
            onClear: () => this.clearAll()
        });
    }

    activate() {
        const { app } = this.global;

        // Purely visual overlay — pointer-events: none
        this.overlay = document.createElement('div');
        this.overlay.id = 'measureOverlay';
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
        this.points = [];
        this.measureState = 'idle';
    }

    destroy() {
        this.deactivate();
        this.pointerHandler.destroy();
    }

    private handleClick(pos: Vec3, clientX: number, clientY: number) {
        if (this.measureState === 'idle') {
            this.points = [pos];
            this.measureState = 'first_placed';
        } else if (this.measureState === 'first_placed') {
            this.points.push(pos);
            this.measureState = 'complete';
            this.showPanel();
        } else if (this.measureState === 'complete') {
            // Vertex clicks are handled by the drag mechanism in ToolPointerHandler
            // (clicking a vertex starts a zero-length drag, setting selectedIndex).
            // Here we only handle clicks on empty space.
            if (this.pointerHandler.selectedIndex >= 0) {
                // A vertex was selected — clicking elsewhere deselects
                this.pointerHandler.selectedIndex = -1;
            } else {
                // No vertex selected — start new measurement
                this.points = [pos];
                this.measureState = 'first_placed';
                this.pointerHandler.reset();
                this.removePanel();
            }
        }
    }

    private clearAll() {
        this.points = [];
        this.measureState = 'idle';
        this.pointerHandler.reset();
        this.removePanel();
    }

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

        if (this.points.length === 0) return;

        const camera = this.global.camera;
        const screenPoints = this.points.map(p => worldToScreen(camera, p));
        const allVisible = screenPoints.every(s => !s.behind);
        if (!allVisible) return;

        // Draw line between points
        if (this.points.length === 2) {
            ctx.strokeStyle = ACCENT_COLOR;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
            ctx.lineTo(screenPoints[1].x, screenPoints[1].y);
            ctx.stroke();

            drawEdgeLabel(ctx, this.points[0], this.points[1], screenPoints[0], screenPoints[1]);
        }

        // Draw pins
        for (let i = 0; i < screenPoints.length; i++) {
            const sp = screenPoints[i];
            const isSelected = this.measureState === 'complete' && i === this.pointerHandler.selectedIndex;
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
        if (this.measureState === 'complete' && this.pointerHandler.selectedIndex >= 0) {
            const selIdx = this.pointerHandler.selectedIndex;
            if (selIdx < this.points.length) {
                this.pointerHandler.renderGizmo(ctx, camera, this.points[selIdx]);
            }
        }

        // Draw coordinate tooltip on selected point (option 3)
        if (this.measureState === 'complete' && this.pointerHandler.selectedIndex >= 0) {
            const selIdx = this.pointerHandler.selectedIndex;
            if (selIdx < this.points.length) {
                this.drawCoordTooltip(ctx, screenPoints[selIdx], this.points[selIdx], selIdx + 1);
            }
        }

        // Update floating panel values (cheap text-content updates)
        if (this.measureState === 'complete' && this.points.length === 2) {
            this.updatePanelValues();
        }
    }

    // Draw a small label near a pin showing its world X/Y/Z coordinates
    private drawCoordTooltip(
        ctx: CanvasRenderingContext2D,
        screen: { x: number; y: number },
        p: Vec3,
        index: number
    ) {
        // Display convention: surveying axes (Z = vertical).
        // PlayCanvas world Y is up, so we map display Y ← world Z and display Z ← world Y.
        const lines = [
            `P${index}`,
            `X ${formatComponent(p.x)}`,
            `Y ${formatComponent(p.z)}`,
            `Z ${formatComponent(p.y)}`
        ];

        ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';

        const padX = 8;
        const padY = 6;
        const lineHeight = 15;
        let maxW = 0;
        for (const line of lines) {
            const w = ctx.measureText(line).width;
            if (w > maxW) maxW = w;
        }
        const boxW = maxW + padX * 2;
        const boxH = lineHeight * lines.length + padY * 2;

        // Position to the right of the pin, offset to avoid overlapping it.
        // Flip to the left if it would overflow the viewport.
        const offset = 16;
        let x = screen.x + offset;
        let y = screen.y - boxH / 2;
        if (x + boxW > window.innerWidth - 8) {
            x = screen.x - offset - boxW;
        }
        if (y < 8) y = 8;
        if (y + boxH > window.innerHeight - 8) y = window.innerHeight - 8 - boxH;

        ctx.fillStyle = 'rgba(24, 24, 27, 0.92)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x, y, boxW, boxH, 6);
        ctx.fill();
        ctx.stroke();

        // First line (P1/P2 label) in accent color, others in white
        ctx.fillStyle = ACCENT_COLOR;
        ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.fillText(lines[0], x + padX, y + padY);
        ctx.fillStyle = '#e4e4e7';
        for (let i = 1; i < lines.length; i++) {
            ctx.fillText(lines[i], x + padX, y + padY + lineHeight * i);
        }
    }

    // ── Floating info panel (option 2) ──

    private showPanel() {
        if (!this.overlay) return;
        this.removePanel();

        this.panel = document.createElement('div');
        this.panel.id = 'measurePanel';
        this.panel.style.cssText = `
            position: fixed;
            top: 80px;
            right: 16px;
            width: 220px;
            box-sizing: border-box;
            background: rgba(24, 24, 27, 0.92);
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 12px;
            padding: 14px 16px;
            color: #e4e4e7;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 13px;
            z-index: 1000;
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            pointer-events: auto;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        `;

        const title = document.createElement('div');
        title.textContent = 'Mesure';
        title.style.cssText = 'font-size: 12px; font-weight: 600; color: #a1a1aa; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 8px;';
        this.panel.appendChild(title);

        // Distance (large)
        const distRow = document.createElement('div');
        distRow.style.cssText = 'font-size: 22px; font-weight: 600; color: #fafafa; margin-bottom: 12px; font-variant-numeric: tabular-nums;';
        this.panelDistEl = document.createElement('span');
        distRow.appendChild(this.panelDistEl);
        this.panel.appendChild(distRow);

        // Separator
        const sep = document.createElement('div');
        sep.style.cssText = 'height: 1px; background: rgba(255,255,255,0.08); margin: 0 -16px 10px;';
        this.panel.appendChild(sep);

        // Delta rows
        const makeDeltaRow = (label: string) => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; justify-content: space-between; align-items: baseline; padding: 3px 0; font-variant-numeric: tabular-nums;';
            const lbl = document.createElement('span');
            lbl.textContent = label;
            lbl.style.cssText = `color: ${ACCENT_COLOR}; font-weight: 600; font-size: 12px;`;
            const val = document.createElement('span');
            val.style.cssText = 'color: #e4e4e7; font-size: 13px;';
            row.appendChild(lbl);
            row.appendChild(val);
            this.panel.appendChild(row);
            return val;
        };

        this.panelDxEl = makeDeltaRow('ΔX');
        this.panelDyEl = makeDeltaRow('ΔY');
        this.panelDzEl = makeDeltaRow('ΔZ');

        this.overlay.appendChild(this.panel);
        this.updatePanelValues();
    }

    private updatePanelValues() {
        if (!this.panel || this.points.length !== 2) return;
        const p1 = this.points[0];
        const p2 = this.points[1];
        // World deltas (PlayCanvas: Y = up)
        const wdx = p2.x - p1.x;
        const wdy = p2.y - p1.y;
        const wdz = p2.z - p1.z;
        const dist = Math.sqrt(wdx * wdx + wdy * wdy + wdz * wdz);
        // Display deltas (surveying convention: Z = vertical)
        if (this.panelDistEl) this.panelDistEl.textContent = formatDistance(dist);
        if (this.panelDxEl) this.panelDxEl.textContent = formatComponent(wdx);
        if (this.panelDyEl) this.panelDyEl.textContent = formatComponent(wdz);
        if (this.panelDzEl) this.panelDzEl.textContent = formatComponent(wdy);
    }

    private removePanel() {
        if (this.panel) {
            this.panel.remove();
            this.panel = null;
            this.panelDistEl = null;
            this.panelDxEl = null;
            this.panelDyEl = null;
            this.panelDzEl = null;
        }
    }
}

export { MeasureTool };
