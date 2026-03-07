import { Vec3 } from 'playcanvas';
import type { Entity } from 'playcanvas';

import { Picker } from './picker';
import { findPointNear } from './tool-utils';
import { TranslateGizmo } from './translate-gizmo';
import type { GizmoAxis } from './translate-gizmo';
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

    private gizmo = new TranslateGizmo();
    private activeAxis: GizmoAxis = null;
    private hoverAxis: GizmoAxis = null;
    private dragOrigin = new Vec3();
    private dragAxisGrabOffset = new Vec3();

    private dragIndex = -1;
    private dragPlaneNormal = new Vec3();
    private dragPlanePoint = new Vec3();

    private downX = 0;
    private downY = 0;
    private isDown = false;
    private downOnCanvas = false;

    private rightDownX = 0;
    private rightDownY = 0;
    private rightIsDown = false;

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

    renderGizmo(ctx: CanvasRenderingContext2D, camera: Entity, worldPos: Vec3) {
        this.gizmo.render(ctx, camera, worldPos, this.activeAxis, this.hoverAxis);
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
            // Track right-click start position (for distinguishing click vs drag)
            if (event.button === 2 && event.target === appCanvas) {
                this.rightDownX = event.clientX;
                this.rightDownY = event.clientY;
                this.rightIsDown = true;
                return;
            }

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

            // Check gizmo axis hit first when a point is selected
            if (this.selectedIndex >= 0 && this.selectedIndex < points.length) {
                const hitAxis = this.gizmo.hitTest(this.global.camera, points[this.selectedIndex], event.clientX, event.clientY);
                if (hitAxis) {
                    this.startAxisDrag(points, this.selectedIndex, hitAxis, event.clientX, event.clientY);
                    event.stopPropagation();
                    return;
                }
            }

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
                if (this.activeAxis) {
                    this.updateAxisDrag(points, event.clientX, event.clientY);
                } else {
                    this.updateDrag(points, event.clientX, event.clientY);
                }
                appCanvas.style.cursor = 'grabbing';
            } else {
                const points = this.callbacks.getDraggablePoints();

                // Check gizmo hover first
                if (this.selectedIndex >= 0 && this.selectedIndex < points.length) {
                    const hitAxis = this.gizmo.hitTest(this.global.camera, points[this.selectedIndex], event.clientX, event.clientY);
                    if (hitAxis) {
                        this.hoverAxis = hitAxis;
                        appCanvas.style.cursor = 'grab';
                        return;
                    }
                }
                this.hoverAxis = null;

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
            // Right-click release: clear only if it was a short click (not a pan drag)
            if (event.button === 2 && this.rightIsDown) {
                this.rightIsDown = false;
                const dx = event.clientX - this.rightDownX;
                const dy = event.clientY - this.rightDownY;
                if (dx * dx + dy * dy < 25) {
                    this.callbacks.onClear();
                }
                return;
            }

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
        this.activeAxis = null;
        this.hoverAxis = null;
        this.isDown = false;
        this.downOnCanvas = false;
        this.rightIsDown = false;
    }

    destroy() {
        this.deactivate();
        this.picker.release();
    }

    reset() {
        this.selectedIndex = -1;
        this.dragIndex = -1;
        this.activeAxis = null;
        this.hoverAxis = null;
    }

    private startDrag(points: Vec3[], index: number) {
        this.dragIndex = index;
        this.selectedIndex = index;
        this.activeAxis = null;
        this.dragOrigin.copy(points[index]);

        const camera = this.global.camera;
        this.dragPlaneNormal.copy(camera.forward);
        this.dragPlanePoint.copy(points[index]);
    }

    private startAxisDrag(points: Vec3[], index: number, axis: GizmoAxis, clientX: number, clientY: number) {
        this.dragIndex = index;
        this.selectedIndex = index;
        this.activeAxis = axis;
        this.dragOrigin.copy(points[index]);

        // Use camera-facing plane (same as free drag) to compute where the click
        // lands, then store the offset for the active axis component only.
        const { camera } = this.global;
        this.dragPlaneNormal.copy(camera.forward);
        this.dragPlanePoint.copy(points[index]);

        this.dragAxisGrabOffset.set(0, 0, 0);
        const hitPos = this.rayPlaneHit(clientX, clientY);
        if (hitPos) {
            if (axis === 'x') this.dragAxisGrabOffset.x = hitPos.x - this.dragOrigin.x;
            else if (axis === 'y') this.dragAxisGrabOffset.y = hitPos.y - this.dragOrigin.y;
            else if (axis === 'z') this.dragAxisGrabOffset.z = hitPos.z - this.dragOrigin.z;
        }
    }

    private updateDrag(points: Vec3[], clientX: number, clientY: number) {
        if (this.dragIndex < 0 || this.dragIndex >= points.length) return;

        const hitPos = this.rayPlaneHit(clientX, clientY);
        if (!hitPos) return;

        points[this.dragIndex].copy(hitPos);
        this.global.app.renderNextFrame = true;
    }

    private updateAxisDrag(points: Vec3[], clientX: number, clientY: number) {
        if (this.dragIndex < 0 || this.dragIndex >= points.length) return;
        if (!this.activeAxis) return;

        const hitPos = this.rayPlaneHit(clientX, clientY);
        if (!hitPos) return;

        // Start from the original position, then update only the active axis component
        const p = points[this.dragIndex];
        p.copy(this.dragOrigin);
        if (this.activeAxis === 'x') p.x = hitPos.x - this.dragAxisGrabOffset.x;
        else if (this.activeAxis === 'y') p.y = hitPos.y - this.dragAxisGrabOffset.y;
        else if (this.activeAxis === 'z') p.z = hitPos.z - this.dragAxisGrabOffset.z;

        this.global.app.renderNextFrame = true;
    }

    private rayPlaneHit(clientX: number, clientY: number): Vec3 | null {
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
        if (Math.abs(denom) < 1e-6) return null;

        const t = new Vec3().sub2(this.dragPlanePoint, nearPoint).dot(this.dragPlaneNormal) / denom;
        if (t < 0) return null;

        return new Vec3().add2(nearPoint, new Vec3().copy(rayDir).mulScalar(t));
    }

    private stopDrag() {
        this.dragIndex = -1;
        this.activeAxis = null;
    }
}

export { ToolPointerHandler };
