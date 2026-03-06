import { Vec3 } from 'playcanvas';

import { Picker } from './picker';
import type { Global } from './types';

type AreaMeasureState = 'idle' | 'placing' | 'closed';

class AreaMeasureTool {
    private global: Global;
    private picker: Picker;
    private state: AreaMeasureState = 'idle';
    private currentPoints: Vec3[] = [];

    private overlay: HTMLDivElement | null = null;
    private drawCanvas: HTMLCanvasElement | null = null;
    private updateHandler: ((dt: number) => void) | null = null;
    private mouseX = 0;
    private mouseY = 0;

    // Vertex selection & drag
    private selectedIndex = -1;
    private dragIndex = -1;
    private dragPlaneNormal = new Vec3();
    private dragPlanePoint = new Vec3();

    // Pointer tracking
    private downX = 0;
    private downY = 0;
    private isDown = false;
    private downOnCanvas = false;

    // Bound handlers for cleanup
    private _onDocumentPointerDown: ((e: PointerEvent) => void) | null = null;
    private _onDocumentPointerMove: ((e: PointerEvent) => void) | null = null;
    private _onDocumentPointerUp: ((e: PointerEvent) => void) | null = null;
    private _onCanvasContextMenu: ((e: Event) => void) | null = null;
    private _keyHandler: ((e: KeyboardEvent) => void) | null = null;
    private _savedCursor: string = '';

    constructor(global: Global) {
        this.global = global;
        this.picker = new Picker(global.app, global.camera);
    }

    activate() {
        const { app, events } = this.global;
        const appCanvas = app.graphicsDevice.canvas as HTMLCanvasElement;

        // Purely visual overlay — pointer-events: none
        this.overlay = document.createElement('div');
        this.overlay.id = 'areaMeasureOverlay';
        const ui = document.querySelector('#ui');
        ui.insertBefore(this.overlay, ui.firstChild);

        this.drawCanvas = document.createElement('canvas');
        this.drawCanvas.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;';
        this.overlay.appendChild(this.drawCanvas);

        // Set crosshair cursor on the WebGL canvas
        this._savedCursor = appCanvas.style.cursor;
        appCanvas.style.cursor = 'crosshair';

        // -- Document capture-phase pointerdown --
        // Fires before canvas bubble-phase listeners (PlayCanvas orbit controller).
        // Only intercepts when starting a vertex drag; otherwise passes through.
        this._onDocumentPointerDown = (event: PointerEvent) => {
            if (event.button !== 0) return;

            // Only handle events targeting the WebGL canvas
            if (event.target !== appCanvas) {
                this.downOnCanvas = false;
                return;
            }

            this.downX = event.clientX;
            this.downY = event.clientY;
            this.isDown = true;
            this.downOnCanvas = true;
            events.fire('inputEvent', 'interact');

            // In closed state, check if clicking on a vertex to start drag
            if (this.state === 'closed') {
                const hitIdx = this.findPointNear(event.clientX, event.clientY);
                if (hitIdx !== -1) {
                    this.startDrag(hitIdx);
                    // Stop propagation so the camera orbit controller never receives this event
                    event.stopPropagation();
                }
            }
        };
        document.addEventListener('pointerdown', this._onDocumentPointerDown, true);

        // -- Document pointermove --
        this._onDocumentPointerMove = (event: PointerEvent) => {
            this.mouseX = event.clientX;
            this.mouseY = event.clientY;

            if (this.dragIndex >= 0) {
                this.updateDrag(event.clientX, event.clientY);
                appCanvas.style.cursor = 'grabbing';
            } else if (this.state === 'closed') {
                const hitIdx = this.findPointNear(event.clientX, event.clientY);
                appCanvas.style.cursor = hitIdx !== -1 ? 'grab' : 'crosshair';
            }
        };
        document.addEventListener('pointermove', this._onDocumentPointerMove);

        // -- Document pointerup --
        this._onDocumentPointerUp = (event: PointerEvent) => {
            if (event.button !== 0 || !this.isDown) return;
            this.isDown = false;

            // If we were dragging, just stop the drag
            if (this.dragIndex >= 0) {
                this.stopDrag();
                const hitIdx = this.findPointNear(event.clientX, event.clientY);
                appCanvas.style.cursor = hitIdx !== -1 ? 'grab' : 'crosshair';
                return;
            }

            // Ignore if the pointerdown didn't originate on the canvas
            if (!this.downOnCanvas) return;

            // Ignore camera-orbit drags (> 5px movement)
            const dx = event.clientX - this.downX;
            const dy = event.clientY - this.downY;
            if (dx * dx + dy * dy > 25) return;

            // It's a click on the canvas — place a point or select a vertex
            events.fire('inputEvent', 'interact');

            const rect = appCanvas.getBoundingClientRect();
            const x = (event.clientX - rect.left) / rect.width;
            const y = (event.clientY - rect.top) / rect.height;

            this.picker.pick(x, y).then((pos) => {
                if (!pos) return;
                this.handleClick(pos, event.clientX, event.clientY);
            });
        };
        document.addEventListener('pointerup', this._onDocumentPointerUp);

        // -- Right-click clears everything --
        this._onCanvasContextMenu = (event: Event) => {
            event.preventDefault();
            this.clearAll();
        };
        appCanvas.addEventListener('contextmenu', this._onCanvasContextMenu);

        // -- Escape key --
        this._keyHandler = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                this.clearAll();
            }
        };
        document.addEventListener('keydown', this._keyHandler);

        // -- Per-frame render --
        this.updateHandler = () => {
            this.render();
        };
        app.on('update', this.updateHandler);
    }

    private handleClick(pos: Vec3, clientX: number, clientY: number) {
        if (this.state === 'idle') {
            this.currentPoints = [pos];
            this.state = 'placing';
        } else if (this.state === 'closed') {
            // Check if clicking on an existing vertex to select it
            const hitIdx = this.findPointNear(clientX, clientY);
            this.selectedIndex = hitIdx; // -1 if no hit = deselect
        } else if (this.state === 'placing') {
            // Snap to first point to close polygon
            if (this.currentPoints.length >= 3) {
                const firstScreen = this.worldToScreen(this.currentPoints[0]);
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

    private startDrag(index: number) {
        this.dragIndex = index;
        this.selectedIndex = index;

        // Drag plane: perpendicular to camera forward, passing through the vertex
        const camera = this.global.camera;
        this.dragPlaneNormal.copy(camera.forward);
        this.dragPlanePoint.copy(this.currentPoints[index]);
    }

    private updateDrag(clientX: number, clientY: number) {
        if (this.dragIndex < 0 || this.dragIndex >= this.currentPoints.length) return;

        const { app, camera } = this.global;
        const appCanvas = app.graphicsDevice.canvas as HTMLCanvasElement;
        const rect = appCanvas.getBoundingClientRect();

        // Convert client coords to canvas pixel coords
        const pixelX = (clientX - rect.left) * (appCanvas.width / rect.width);
        const pixelY = (clientY - rect.top) * (appCanvas.height / rect.height);

        // Get ray from camera through screen point
        const nearPoint = new Vec3();
        const farPoint = new Vec3();
        camera.camera.screenToWorld(pixelX, pixelY, camera.camera.nearClip, nearPoint);
        camera.camera.screenToWorld(pixelX, pixelY, camera.camera.farClip, farPoint);

        const rayDir = new Vec3().sub2(farPoint, nearPoint).normalize();

        // Ray-plane intersection
        const denom = rayDir.dot(this.dragPlaneNormal);
        if (Math.abs(denom) < 1e-6) return;

        const t = new Vec3().sub2(this.dragPlanePoint, nearPoint).dot(this.dragPlaneNormal) / denom;
        if (t < 0) return;

        const newPos = new Vec3().add2(nearPoint, new Vec3().copy(rayDir).mulScalar(t));
        this.currentPoints[this.dragIndex].copy(newPos);

        // Force re-render
        app.renderNextFrame = true;
    }

    private stopDrag() {
        this.dragIndex = -1;
    }

    deactivate() {
        const { app } = this.global;
        const appCanvas = app.graphicsDevice.canvas as HTMLCanvasElement;

        if (this.updateHandler) {
            app.off('update', this.updateHandler);
            this.updateHandler = null;
        }

        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
        }

        if (this._onDocumentPointerDown) {
            document.removeEventListener('pointerdown', this._onDocumentPointerDown, true);
            this._onDocumentPointerDown = null;
        }

        if (this._onDocumentPointerMove) {
            document.removeEventListener('pointermove', this._onDocumentPointerMove);
            this._onDocumentPointerMove = null;
        }

        if (this._onDocumentPointerUp) {
            document.removeEventListener('pointerup', this._onDocumentPointerUp);
            this._onDocumentPointerUp = null;
        }

        if (this._onCanvasContextMenu) {
            appCanvas.removeEventListener('contextmenu', this._onCanvasContextMenu);
            this._onCanvasContextMenu = null;
        }

        // Restore cursor
        appCanvas.style.cursor = this._savedCursor;

        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }

        this.drawCanvas = null;
        this.currentPoints = [];
        this.state = 'idle';
        this.selectedIndex = -1;
        this.dragIndex = -1;
        this.isDown = false;
        this.downOnCanvas = false;
    }

    destroy() {
        this.deactivate();
        this.picker.release();
    }

    private clearAll() {
        this.currentPoints = [];
        this.state = 'idle';
        this.selectedIndex = -1;
        this.dragIndex = -1;
    }

    private findPointNear(clientX: number, clientY: number): number {
        const threshold = 400; // 20px squared
        for (let i = 0; i < this.currentPoints.length; i++) {
            const sp = this.worldToScreen(this.currentPoints[i]);
            if (sp.behind) continue;
            const dx = clientX - sp.x;
            const dy = clientY - sp.y;
            if (dx * dx + dy * dy < threshold) {
                return i;
            }
        }
        return -1;
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
        for (let i = 0; i < screenPoints.length; i++) {
            const sp = screenPoints[i];
            const isSelected = closed && i === this.selectedIndex;
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
