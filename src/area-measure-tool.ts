import { Vec3 } from 'playcanvas';

import { ToolPointerHandler } from './tool-pointer-handler';
import { worldToScreen, drawEdgeLabel } from './tool-utils';
import type { Global } from './types';

type AreaMeasureState = 'idle' | 'placing' | 'closed';

class AreaMeasureTool {
    private global: Global;
    private pointerHandler: ToolPointerHandler;
    private state: AreaMeasureState = 'idle';
    private currentPoints: Vec3[] = [];

    private overlay: HTMLDivElement | null = null;
    private drawCanvas: HTMLCanvasElement | null = null;
    private updateHandler: ((dt: number) => void) | null = null;

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

        // Purely visual overlay — pointer-events: none
        this.overlay = document.createElement('div');
        this.overlay.id = 'areaMeasureOverlay';
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
            // Vertex clicks are handled by the drag mechanism in ToolPointerHandler.
            // Here we only handle clicks on empty space → deselect.
            this.pointerHandler.selectedIndex = -1;
        } else if (this.state === 'placing') {
            // Snap to first point to close polygon
            if (this.currentPoints.length >= 3) {
                const firstScreen = worldToScreen(this.global.camera, this.currentPoints[0]);
                if (!firstScreen.behind) {
                    const sdx = clientX - firstScreen.x;
                    const sdy = clientY - firstScreen.y;
                    if (sdx * sdx + sdy * sdy < 400) {
                        this.state = 'closed';
                        return;
                    }
                }
            }
            this.currentPoints.push(pos);
        }
    }

    private clearAll() {
        this.currentPoints = [];
        this.state = 'idle';
        this.pointerHandler.reset();
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
            ctx.fillStyle = 'rgba(255, 102, 0, 0.2)';
            ctx.fill();
        }

        // Draw edges
        ctx.strokeStyle = '#FF6600';
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
            const pinRadius = isSelected ? 8 : 6;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, pinRadius, 0, Math.PI * 2);
            ctx.fillStyle = isSelected ? '#FFFFFF' : '#FF6600';
            ctx.fill();
            ctx.strokeStyle = isSelected ? '#FF6600' : '#FFFFFF';
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        // Draw distance labels on edges
        for (let i = 0; i < screenPoints.length - 1; i++) {
            drawEdgeLabel(ctx, points[i], points[i + 1], screenPoints[i], screenPoints[i + 1]);
        }
        if (closed && screenPoints.length >= 3) {
            drawEdgeLabel(ctx, points[points.length - 1], points[0], screenPoints[screenPoints.length - 1], screenPoints[0]);
        }

        // Draw area label at centroid when closed
        if (closed && screenPoints.length >= 3) {
            const area = this.calculateArea(points);
            const areaText = this.formatArea(area);

            let cx = 0, cy = 0;
            for (const sp of screenPoints) {
                cx += sp.x;
                cy += sp.y;
            }
            cx /= screenPoints.length;
            cy /= screenPoints.length;

            ctx.font = 'bold 14px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const metrics = ctx.measureText(areaText);
            const pw = 8, ph = 4;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.beginPath();
            ctx.roundRect(cx - metrics.width / 2 - pw, cy - 8 - ph, metrics.width + pw * 2, 16 + ph * 2, 4);
            ctx.fill();
            ctx.fillStyle = '#FFFFFF';
            ctx.fillText(areaText, cx, cy);
        }
    }

    private formatArea(area: number): string {
        if (area >= 1) {
            return `${area.toFixed(2)} m\u00B2`;
        }
        return `${(area * 10000).toFixed(1)} cm\u00B2`;
    }

    private calculateArea(points: Vec3[]): number {
        if (points.length < 3) return 0;

        const normal = new Vec3(0, 0, 0);
        for (let i = 0; i < points.length; i++) {
            const curr = points[i];
            const next = points[(i + 1) % points.length];
            normal.x += (curr.y - next.y) * (curr.z + next.z);
            normal.y += (curr.z - next.z) * (curr.x + next.x);
            normal.z += (curr.x - next.x) * (curr.y + next.y);
        }
        const len = normal.length();
        if (len < 1e-10) return 0;
        normal.mulScalar(1 / len);

        const absX = Math.abs(normal.x);
        const absY = Math.abs(normal.y);
        const absZ = Math.abs(normal.z);

        let up: Vec3;
        if (absX <= absY && absX <= absZ) {
            up = new Vec3(1, 0, 0);
        } else if (absY <= absZ) {
            up = new Vec3(0, 1, 0);
        } else {
            up = new Vec3(0, 0, 1);
        }

        const uAxis = new Vec3().cross(up, normal).normalize();
        const vAxis = new Vec3().cross(normal, uAxis).normalize();

        const origin = points[0];
        const coords2d: { u: number; v: number }[] = [];
        for (const p of points) {
            const d = new Vec3().sub2(p, origin);
            coords2d.push({
                u: d.dot(uAxis),
                v: d.dot(vAxis)
            });
        }

        let area = 0;
        for (let i = 0; i < coords2d.length; i++) {
            const j = (i + 1) % coords2d.length;
            area += coords2d[i].u * coords2d[j].v;
            area -= coords2d[j].u * coords2d[i].v;
        }

        return Math.abs(area) / 2;
    }
}

export { AreaMeasureTool };
