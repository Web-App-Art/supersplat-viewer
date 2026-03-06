import { Vec3 } from 'playcanvas';

import { Picker } from './picker';
import type { Global } from './types';

type MeasureState = 'idle' | 'first_placed' | 'complete';

class MeasureTool {
    private global: Global;
    private picker: Picker;
    private pinA: Vec3 | null = null;
    private pinB: Vec3 | null = null;
    private measureState: MeasureState = 'idle';

    private overlay: HTMLDivElement | null = null;
    private pinAElement: HTMLDivElement | null = null;
    private pinBElement: HTMLDivElement | null = null;
    private lineCanvas: HTMLCanvasElement | null = null;
    private labelElement: HTMLDivElement | null = null;

    private updateHandler: ((dt: number) => void) | null = null;

    constructor(global: Global) {
        this.global = global;
        this.picker = new Picker(global.app, global.camera);
    }

    activate() {
        const { app, events } = this.global;

        // Create a full-viewport overlay that intercepts pointer events.
        // Inserted as the first child of #ui so it sits BELOW the toolbar
        // buttons (which come later in DOM order) but ABOVE the canvas.
        this.overlay = document.createElement('div');
        this.overlay.id = 'measureOverlay';

        const ui = document.querySelector('#ui');
        ui.insertBefore(this.overlay, ui.firstChild);

        // Create line canvas
        this.lineCanvas = document.createElement('canvas');
        this.lineCanvas.className = 'measure-line-canvas';
        this.overlay.appendChild(this.lineCanvas);

        // Create pin elements
        this.pinAElement = document.createElement('div');
        this.pinAElement.className = 'measure-pin';
        this.overlay.appendChild(this.pinAElement);

        this.pinBElement = document.createElement('div');
        this.pinBElement.className = 'measure-pin';
        this.overlay.appendChild(this.pinBElement);

        // Create label
        this.labelElement = document.createElement('div');
        this.labelElement.className = 'measure-label';
        this.overlay.appendChild(this.labelElement);

        // Hide pin/label initially
        this.pinAElement.style.display = 'none';
        this.pinBElement.style.display = 'none';
        this.labelElement.style.display = 'none';

        // Track pointer for click-vs-drag detection
        let downX = 0;
        let downY = 0;
        let isDown = false;

        this.overlay.addEventListener('pointerdown', (event: PointerEvent) => {
            if (event.button !== 0) return;
            downX = event.clientX;
            downY = event.clientY;
            isDown = true;
            // Keep toolbar visible
            events.fire('inputEvent', 'interact');
        });

        this.overlay.addEventListener('pointerup', async (event: PointerEvent) => {
            if (event.button !== 0 || !isDown) return;
            isDown = false;

            // Ignore drags (> 5px movement)
            const dx = event.clientX - downX;
            const dy = event.clientY - downY;
            if (dx * dx + dy * dy > 25) return;

            // Keep toolbar visible
            events.fire('inputEvent', 'interact');

            const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
            const rect = canvas.getBoundingClientRect();
            const x = (event.clientX - rect.left) / rect.width;
            const y = (event.clientY - rect.top) / rect.height;

            const pos = await this.picker.pick(x, y);
            if (!pos) return;

            if (this.measureState === 'idle') {
                this.pinA = pos;
                this.measureState = 'first_placed';
                this.pinAElement.style.display = 'block';
                this.pinBElement.style.display = 'none';
                this.labelElement.style.display = 'none';
                this.updateProjection();
            } else if (this.measureState === 'first_placed') {
                this.pinB = pos;
                this.measureState = 'complete';
                this.pinBElement.style.display = 'block';
                this.labelElement.style.display = 'block';
                this.updateProjection();
            } else {
                // Reset: start new measurement
                this.pinA = pos;
                this.pinB = null;
                this.measureState = 'first_placed';
                this.pinAElement.style.display = 'block';
                this.pinBElement.style.display = 'none';
                this.labelElement.style.display = 'none';
                this.clearLine();
                this.updateProjection();
            }
        });

        // Update projection each frame
        this.updateHandler = () => {
            this.updateProjection();
        };
        app.on('update', this.updateHandler);
    }

    deactivate() {
        const { app } = this.global;

        if (this.updateHandler) {
            app.off('update', this.updateHandler);
            this.updateHandler = null;
        }

        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }

        this.pinA = null;
        this.pinB = null;
        this.measureState = 'idle';
        this.pinAElement = null;
        this.pinBElement = null;
        this.lineCanvas = null;
        this.labelElement = null;
    }

    private worldToScreen(pos: Vec3): { x: number; y: number; behind: boolean } {
        const camera = this.global.camera;

        // Check if point is behind camera
        const cameraPos = camera.getPosition();
        const forward = camera.forward;
        const toPoint = new Vec3().sub2(pos, cameraPos);
        const dot = toPoint.dot(forward);

        if (dot < 0) {
            return { x: 0, y: 0, behind: true };
        }

        const screenPos = new Vec3();
        camera.camera.worldToScreen(pos, screenPos);

        return {
            x: screenPos.x,
            y: screenPos.y,
            behind: false
        };
    }

    private updateProjection() {
        if (!this.pinA || !this.pinAElement) return;

        const screenA = this.worldToScreen(this.pinA);
        this.pinAElement.style.display = screenA.behind ? 'none' : 'block';
        this.pinAElement.style.left = `${screenA.x}px`;
        this.pinAElement.style.top = `${screenA.y}px`;

        if (this.pinB && this.pinBElement && this.measureState === 'complete') {
            const screenB = this.worldToScreen(this.pinB);
            this.pinBElement.style.display = screenB.behind ? 'none' : 'block';
            this.pinBElement.style.left = `${screenB.x}px`;
            this.pinBElement.style.top = `${screenB.y}px`;

            if (!screenA.behind && !screenB.behind) {
                this.drawLine(screenA.x, screenA.y, screenB.x, screenB.y);
            } else {
                this.clearLine();
            }

            if (this.labelElement && !screenA.behind && !screenB.behind) {
                const dist = new Vec3().sub2(this.pinA, this.pinB).length();
                this.labelElement.textContent = this.formatDistance(dist);
                this.labelElement.style.display = 'block';
                this.labelElement.style.left = `${(screenA.x + screenB.x) / 2}px`;
                this.labelElement.style.top = `${(screenA.y + screenB.y) / 2}px`;
            } else if (this.labelElement) {
                this.labelElement.style.display = 'none';
            }
        }
    }

    private formatDistance(dist: number): string {
        if (dist >= 1) {
            return `${dist.toFixed(2)} m`;
        }
        return `${(dist * 100).toFixed(1)} cm`;
    }

    private drawLine(x1: number, y1: number, x2: number, y2: number) {
        if (!this.lineCanvas) return;

        const dpr = window.devicePixelRatio || 1;
        const width = window.innerWidth;
        const height = window.innerHeight;

        if (this.lineCanvas.width !== width * dpr || this.lineCanvas.height !== height * dpr) {
            this.lineCanvas.width = width * dpr;
            this.lineCanvas.height = height * dpr;
            this.lineCanvas.style.width = `${width}px`;
            this.lineCanvas.style.height = `${height}px`;
        }

        const ctx = this.lineCanvas.getContext('2d');
        ctx.clearRect(0, 0, this.lineCanvas.width, this.lineCanvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = '#FF6600';
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    private clearLine() {
        if (!this.lineCanvas) return;
        const ctx = this.lineCanvas.getContext('2d');
        if (ctx) {
            ctx.clearRect(0, 0, this.lineCanvas.width, this.lineCanvas.height);
        }
    }

    destroy() {
        this.deactivate();
        this.picker.release();
    }
}

export { MeasureTool };
