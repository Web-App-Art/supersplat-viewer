import { Vec3 } from 'playcanvas';

import { Picker } from './picker';
import type { Global } from './types';

type AreaMeasureState = 'idle' | 'placing' | 'closed';

interface Polygon {
    points: Vec3[];
    closed: boolean;
}

class AreaMeasureTool {
    private global: Global;
    private picker: Picker;
    private state: AreaMeasureState = 'idle';
    private currentPoints: Vec3[] = [];
    private completedPolygons: Polygon[] = [];

    private overlay: HTMLDivElement | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private updateHandler: ((dt: number) => void) | null = null;
    private mouseX = 0;
    private mouseY = 0;

    constructor(global: Global) {
        this.global = global;
        this.picker = new Picker(global.app, global.camera);
    }

    activate() {
        const { app, events } = this.global;

        this.overlay = document.createElement('div');
        this.overlay.id = 'areaMeasureOverlay';

        const ui = document.querySelector('#ui');
        ui.insertBefore(this.overlay, ui.firstChild);

        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;';
        this.overlay.appendChild(this.canvas);

        let downX = 0;
        let downY = 0;
        let isDown = false;

        this.overlay.addEventListener('pointerdown', (event: PointerEvent) => {
            if (event.button !== 0) return;
            downX = event.clientX;
            downY = event.clientY;
            isDown = true;
            events.fire('inputEvent', 'interact');
        });

        this.overlay.addEventListener('pointermove', (event: PointerEvent) => {
            this.mouseX = event.clientX;
            this.mouseY = event.clientY;
        });

        this.overlay.addEventListener('pointerup', async (event: PointerEvent) => {
            if (event.button !== 0 || !isDown) return;
            isDown = false;

            const dx = event.clientX - downX;
            const dy = event.clientY - downY;
            if (dx * dx + dy * dy > 25) return;

            events.fire('inputEvent', 'interact');

            const canvasEl = app.graphicsDevice.canvas as HTMLCanvasElement;
            const rect = canvasEl.getBoundingClientRect();
            const x = (event.clientX - rect.left) / rect.width;
            const y = (event.clientY - rect.top) / rect.height;

            const pos = await this.picker.pick(x, y);
            if (!pos) return;

            if (this.state === 'idle' || this.state === 'closed') {
                if (this.state === 'closed') {
                    this.completedPolygons.push({
                        points: [...this.currentPoints],
                        closed: true
                    });
                }
                this.currentPoints = [pos];
                this.state = 'placing';
            } else if (this.state === 'placing') {
                // Check snap to first point
                if (this.currentPoints.length >= 3) {
                    const firstScreen = this.worldToScreen(this.currentPoints[0]);
                    if (!firstScreen.behind) {
                        const sdx = event.clientX - firstScreen.x;
                        const sdy = event.clientY - firstScreen.y;
                        if (sdx * sdx + sdy * sdy < 400) {
                            this.state = 'closed';
                            return;
                        }
                    }
                }
                this.currentPoints.push(pos);
            }
        });

        this.overlay.addEventListener('contextmenu', (event: Event) => {
            event.preventDefault();
            this.cancelCurrent();
        });

        const keyHandler = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                this.cancelCurrent();
            }
        };
        document.addEventListener('keydown', keyHandler);
        (this as any)._keyHandler = keyHandler;

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

        if ((this as any)._keyHandler) {
            document.removeEventListener('keydown', (this as any)._keyHandler);
            (this as any)._keyHandler = null;
        }

        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }

        this.canvas = null;
        this.currentPoints = [];
        this.completedPolygons = [];
        this.state = 'idle';
    }

    destroy() {
        this.deactivate();
        this.picker.release();
    }

    private cancelCurrent() {
        if (this.state === 'placing') {
            this.currentPoints = [];
            this.state = 'idle';
        }
    }

    private worldToScreen(pos: Vec3): { x: number; y: number; behind: boolean } {
        const camera = this.global.camera;
        const cameraPos = camera.getPosition();
        const forward = camera.forward;
        const toPoint = new Vec3().sub2(pos, cameraPos);
        const dot = toPoint.dot(forward);

        if (dot < 0) {
            return { x: 0, y: 0, behind: true };
        }

        const screenPos = new Vec3();
        camera.camera.worldToScreen(pos, screenPos);
        return { x: screenPos.x, y: screenPos.y, behind: false };
    }

    private render() {
        if (!this.canvas) return;

        const dpr = window.devicePixelRatio || 1;
        const width = window.innerWidth;
        const height = window.innerHeight;

        if (this.canvas.width !== width * dpr || this.canvas.height !== height * dpr) {
            this.canvas.width = width * dpr;
            this.canvas.height = height * dpr;
            this.canvas.style.width = `${width}px`;
            this.canvas.style.height = `${height}px`;
        }

        const ctx = this.canvas.getContext('2d');
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Draw completed polygons
        for (const poly of this.completedPolygons) {
            this.drawPolygon(ctx, poly.points, true);
        }

        // Draw current polygon
        if (this.currentPoints.length > 0) {
            this.drawPolygon(ctx, this.currentPoints, this.state === 'closed');
        }
    }

    private drawPolygon(ctx: CanvasRenderingContext2D, points: Vec3[], closed: boolean) {
        const screenPoints = points.map(p => this.worldToScreen(p));
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
            ctx.lineTo(this.mouseX, this.mouseY);
            ctx.setLineDash([6, 4]);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Draw pins
        for (const sp of screenPoints) {
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2);
            ctx.fillStyle = '#FF6600';
            ctx.fill();
            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        // Draw distance labels on edges
        for (let i = 0; i < screenPoints.length - 1; i++) {
            this.drawEdgeLabel(ctx, points[i], points[i + 1], screenPoints[i], screenPoints[i + 1]);
        }
        if (closed && screenPoints.length >= 3) {
            this.drawEdgeLabel(ctx, points[points.length - 1], points[0], screenPoints[screenPoints.length - 1], screenPoints[0]);
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

    private drawEdgeLabel(
        ctx: CanvasRenderingContext2D,
        p1: Vec3, p2: Vec3,
        s1: { x: number; y: number },
        s2: { x: number; y: number }
    ) {
        const dist = new Vec3().sub2(p1, p2).length();
        const text = this.formatDistance(dist);
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

    private formatDistance(dist: number): string {
        if (dist >= 1) {
            return `${dist.toFixed(2)} m`;
        }
        return `${(dist * 100).toFixed(1)} cm`;
    }

    private formatArea(area: number): string {
        if (area >= 1) {
            return `${area.toFixed(2)} m\u00B2`;
        }
        return `${(area * 10000).toFixed(1)} cm\u00B2`;
    }

    private calculateArea(points: Vec3[]): number {
        if (points.length < 3) return 0;

        // Compute polygon normal using Newell's method
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

        // Build local 2D coordinate system on the polygon's plane
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

        // Project points to 2D
        const origin = points[0];
        const coords2d: { u: number; v: number }[] = [];
        for (const p of points) {
            const d = new Vec3().sub2(p, origin);
            coords2d.push({
                u: d.dot(uAxis),
                v: d.dot(vAxis)
            });
        }

        // Shoelace formula
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
