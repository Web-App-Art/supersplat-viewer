import { Vec3 } from 'playcanvas';

import { Picker } from './picker';
import { findPointNear } from './tool-utils';
import type { Global } from './types';

export interface ToolPointerCallbacks {
    onCanvasClick(pos: Vec3, clientX: number, clientY: number): void;
    getDraggablePoints(): Vec3[];
    onClear(): void;
}

class ToolPointerHandler {
    selectedIndex = -1;
    mouseX = 0;
    mouseY = 0;

    get isDragging(): boolean {
        return this.dragIndex >= 0;
    }

    private global: Global;
    private picker: Picker;
    private callbacks: ToolPointerCallbacks;

    private dragIndex = -1;
    private dragPlaneNormal = new Vec3();
    private dragPlanePoint = new Vec3();

    private downX = 0;
    private downY = 0;
    private isDown = false;
    private downOnCanvas = false;

    private _onDocumentPointerDown: ((e: PointerEvent) => void) | null = null;
    private _onDocumentPointerMove: ((e: PointerEvent) => void) | null = null;
    private _onDocumentPointerUp: ((e: PointerEvent) => void) | null = null;
    private _onCanvasContextMenu: ((e: Event) => void) | null = null;
    private _keyHandler: ((e: KeyboardEvent) => void) | null = null;
    private _savedCursor = '';

    constructor(global: Global, callbacks: ToolPointerCallbacks) {
        this.global = global;
        this.picker = new Picker(global.app, global.camera);
        this.callbacks = callbacks;
    }

    activate() {
        const { app, events } = this.global;
        const appCanvas = app.graphicsDevice.canvas as HTMLCanvasElement;

        this._savedCursor = appCanvas.style.cursor;
        appCanvas.style.cursor = 'crosshair';

        // Document capture-phase pointerdown.
        // Fires before canvas bubble-phase listeners (PlayCanvas orbit controller).
        // Only intercepts (stopPropagation) when starting a vertex drag.
        this._onDocumentPointerDown = (event: PointerEvent) => {
            if (event.button !== 0) return;

            if (event.target !== appCanvas) {
                this.downOnCanvas = false;
                return;
            }

            this.downX = event.clientX;
            this.downY = event.clientY;
            this.isDown = true;
            this.downOnCanvas = true;
            events.fire('inputEvent', 'interact');

            const points = this.callbacks.getDraggablePoints();
            if (points.length > 0) {
                const hitIdx = findPointNear(this.global.camera, points, event.clientX, event.clientY);
                if (hitIdx !== -1) {
                    this.startDrag(points, hitIdx);
                    event.stopPropagation();
                }
            }
        };
        document.addEventListener('pointerdown', this._onDocumentPointerDown, true);

        this._onDocumentPointerMove = (event: PointerEvent) => {
            this.mouseX = event.clientX;
            this.mouseY = event.clientY;

            if (this.dragIndex >= 0) {
                const points = this.callbacks.getDraggablePoints();
                this.updateDrag(points, event.clientX, event.clientY);
                appCanvas.style.cursor = 'grabbing';
            } else {
                const points = this.callbacks.getDraggablePoints();
                if (points.length > 0) {
                    const hitIdx = findPointNear(this.global.camera, points, event.clientX, event.clientY);
                    appCanvas.style.cursor = hitIdx !== -1 ? 'grab' : 'crosshair';
                } else {
                    appCanvas.style.cursor = 'crosshair';
                }
            }
        };
        document.addEventListener('pointermove', this._onDocumentPointerMove);

        this._onDocumentPointerUp = (event: PointerEvent) => {
            if (event.button !== 0 || !this.isDown) return;
            this.isDown = false;

            // If we were dragging, just stop the drag
            if (this.dragIndex >= 0) {
                this.stopDrag();
                const points = this.callbacks.getDraggablePoints();
                if (points.length > 0) {
                    const hitIdx = findPointNear(this.global.camera, points, event.clientX, event.clientY);
                    appCanvas.style.cursor = hitIdx !== -1 ? 'grab' : 'crosshair';
                } else {
                    appCanvas.style.cursor = 'crosshair';
                }
                return;
            }

            if (!this.downOnCanvas) return;

            // Ignore camera-orbit drags (> 5px movement)
            const dx = event.clientX - this.downX;
            const dy = event.clientY - this.downY;
            if (dx * dx + dy * dy > 25) return;

            events.fire('inputEvent', 'interact');

            const rect = appCanvas.getBoundingClientRect();
            const x = (event.clientX - rect.left) / rect.width;
            const y = (event.clientY - rect.top) / rect.height;

            this.picker.pick(x, y).then((pos) => {
                if (!pos) return;
                this.callbacks.onCanvasClick(pos, event.clientX, event.clientY);
            });
        };
        document.addEventListener('pointerup', this._onDocumentPointerUp);

        this._onCanvasContextMenu = (event: Event) => {
            event.preventDefault();
            this.callbacks.onClear();
        };
        appCanvas.addEventListener('contextmenu', this._onCanvasContextMenu);

        this._keyHandler = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                this.callbacks.onClear();
            }
        };
        document.addEventListener('keydown', this._keyHandler);
    }

    deactivate() {
        const { app } = this.global;
        const appCanvas = app.graphicsDevice.canvas as HTMLCanvasElement;

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
        if (this._keyHandler) {
            document.removeEventListener('keydown', this._keyHandler);
            this._keyHandler = null;
        }

        appCanvas.style.cursor = this._savedCursor;
        this.selectedIndex = -1;
        this.dragIndex = -1;
        this.isDown = false;
        this.downOnCanvas = false;
    }

    destroy() {
        this.deactivate();
        this.picker.release();
    }

    reset() {
        this.selectedIndex = -1;
        this.dragIndex = -1;
    }

    private startDrag(points: Vec3[], index: number) {
        this.dragIndex = index;
        this.selectedIndex = index;

        const camera = this.global.camera;
        this.dragPlaneNormal.copy(camera.forward);
        this.dragPlanePoint.copy(points[index]);
    }

    private updateDrag(points: Vec3[], clientX: number, clientY: number) {
        if (this.dragIndex < 0 || this.dragIndex >= points.length) return;

        const { app, camera } = this.global;
        const appCanvas = app.graphicsDevice.canvas as HTMLCanvasElement;
        const rect = appCanvas.getBoundingClientRect();

        const pixelX = (clientX - rect.left) * (appCanvas.width / rect.width);
        const pixelY = (clientY - rect.top) * (appCanvas.height / rect.height);

        const nearPoint = new Vec3();
        const farPoint = new Vec3();
        camera.camera.screenToWorld(pixelX, pixelY, camera.camera.nearClip, nearPoint);
        camera.camera.screenToWorld(pixelX, pixelY, camera.camera.farClip, farPoint);

        const rayDir = new Vec3().sub2(farPoint, nearPoint).normalize();

        const denom = rayDir.dot(this.dragPlaneNormal);
        if (Math.abs(denom) < 1e-6) return;

        const t = new Vec3().sub2(this.dragPlanePoint, nearPoint).dot(this.dragPlaneNormal) / denom;
        if (t < 0) return;

        const newPos = new Vec3().add2(nearPoint, new Vec3().copy(rayDir).mulScalar(t));
        points[this.dragIndex].copy(newPos);

        app.renderNextFrame = true;
    }

    private stopDrag() {
        this.dragIndex = -1;
    }
}

export { ToolPointerHandler };
