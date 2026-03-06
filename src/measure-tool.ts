import { Vec3 } from 'playcanvas';

import { ToolPointerHandler } from './tool-pointer-handler';
import { worldToScreen, drawEdgeLabel } from './tool-utils';
import type { Global } from './types';

type MeasureState = 'idle' | 'first_placed' | 'complete';

class MeasureTool {
    private global: Global;
    private pointerHandler: ToolPointerHandler;
    private points: Vec3[] = [];
    private measureState: MeasureState = 'idle';

    private overlay: HTMLDivElement | null = null;
    private drawCanvas: HTMLCanvasElement | null = null;
    private updateHandler: ((dt: number) => void) | null = null;

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
            }
        }
    }

    private clearAll() {
        this.points = [];
        this.measureState = 'idle';
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

        if (this.points.length === 0) return;

        const camera = this.global.camera;
        const screenPoints = this.points.map(p => worldToScreen(camera, p));
        const allVisible = screenPoints.every(s => !s.behind);
        if (!allVisible) return;

        // Draw line between points
        if (this.points.length === 2) {
            ctx.strokeStyle = '#FF6600';
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
            ctx.fillStyle = isSelected ? '#FFFFFF' : '#FF6600';
            ctx.fill();
            ctx.strokeStyle = isSelected ? '#FF6600' : '#FFFFFF';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    }
}

export { MeasureTool };
