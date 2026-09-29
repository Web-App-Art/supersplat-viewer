// ARTLIGHT (TKT-226)
//
// Zéro utilisateur, côté affichage : un badge « Zéro actif » toujours visible
// tant qu'un zéro est défini (avec un bouton pour l'effacer), et un repère
// 3 axes dessiné sur le point zéro. Le zéro lui-même vit dans
// CoordinateSystem (Global.coords) ; il se règle depuis l'outil Point XYZ.

import { Vec3 } from 'playcanvas';

import { localize } from './localization';
import { worldToScreen } from './tool-utils';
import type { Global } from './types';

// Couleurs habituelles des axes X, Y, Z.
const AXIS_COLORS = ['#ef4444', '#22c55e', '#3b82f6'];
const AXIS_NAMES = ['X', 'Y', 'Z'];

// Longueur des axes à l'écran, quelle que soit la distance.
const AXIS_LENGTH_PX = 56;

class ZeroUI {
    private global: Global;

    private badge: HTMLDivElement;

    private badgeDetail: HTMLSpanElement;

    private canvas: HTMLCanvasElement;

    private drawn = false;

    constructor(global: Global) {
        this.global = global;

        const ui = document.querySelector('#ui');

        this.canvas = document.createElement('canvas');
        this.canvas.id = 'zeroMarker';
        ui.insertBefore(this.canvas, ui.firstChild);

        this.badge = document.createElement('div');
        this.badge.id = 'zeroBadge';
        this.badge.setAttribute('role', 'status');

        const dot = document.createElement('span');
        dot.className = 'zero-badge-dot';
        const label = document.createElement('span');
        label.className = 'zero-badge-label';
        label.textContent = localize('artlight.zero.badge');
        this.badgeDetail = document.createElement('span');
        this.badgeDetail.className = 'zero-badge-detail';

        const clear = document.createElement('button');
        clear.className = 'zero-badge-clear';
        clear.textContent = localize('artlight.zero.clear');
        clear.addEventListener('click', () => global.coords.clearZero());

        this.badge.append(dot, label, this.badgeDetail, clear);
        ui.appendChild(this.badge);

        global.events.on('coords:changed', () => this.refresh());
        global.app.on('update', () => this.render());
        this.refresh();
    }

    private refresh() {
        const zero = this.global.coords.zero;
        this.badge.classList.toggle('hidden', !zero);
        if (zero) {
            const details: string[] = [];
            if (zero.angle !== 0) details.push(localize('artlight.zero.oriented'));
            if (zero.known.some(v => v !== 0)) details.push(localize('artlight.zero.known'));
            this.badgeDetail.textContent = details.join(' · ');
        }
        this.global.app.renderNextFrame = true;
    }

    private render() {
        const frame = this.global.coords.zeroInWorld();
        if (!frame) {
            if (this.drawn) {
                this.canvas.getContext('2d').clearRect(0, 0, this.canvas.width, this.canvas.height);
                this.drawn = false;
            }
            return;
        }

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
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.drawn = true;

        const camera = this.global.camera;
        const origin = new Vec3(frame.origin[0], frame.origin[1], frame.origin[2]);
        const so = worldToScreen(camera, origin);
        if (so.behind) return;

        // Longueur monde qui donne AXIS_LENGTH_PX à la distance du zéro.
        const distance = camera.getPosition().distance(origin);
        const fov = (camera.camera?.fov ?? 60) * Math.PI / 180;
        const length = AXIS_LENGTH_PX * 2 * distance * Math.tan(fov / 2) / Math.max(1, height);

        ctx.lineCap = 'round';
        ctx.font = 'bold 11px Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let i = 0; i < 3; i++) {
            const a = frame.axes[i];
            const tip = new Vec3(origin.x + a[0] * length, origin.y + a[1] * length, origin.z + a[2] * length);
            const st = worldToScreen(camera, tip);
            if (st.behind) continue;

            ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.lineWidth = 5;
            ctx.beginPath();
            ctx.moveTo(so.x, so.y);
            ctx.lineTo(st.x, st.y);
            ctx.stroke();

            ctx.strokeStyle = AXIS_COLORS[i];
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(so.x, so.y);
            ctx.lineTo(st.x, st.y);
            ctx.stroke();

            // Nom de l'axe un peu au-delà de la pointe.
            const dx = st.x - so.x;
            const dy = st.y - so.y;
            const len = Math.hypot(dx, dy) || 1;
            const lx = st.x + dx / len * 9;
            const ly = st.y + dy / len * 9;
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.strokeText(AXIS_NAMES[i], lx, ly);
            ctx.fillStyle = AXIS_COLORS[i];
            ctx.fillText(AXIS_NAMES[i], lx, ly);
        }

        ctx.beginPath();
        ctx.arc(so.x, so.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }
}

export { ZeroUI };
