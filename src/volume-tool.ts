import { Vec3 } from 'playcanvas';

import { ToolPointerHandler } from './tool-pointer-handler';
import { worldToScreen, drawEdgeLabel, formatDistance, getSplatCenters, ACCENT_COLOR, accentRgba } from './tool-utils';
import type { Global } from './types';

// ARTLIGHT: cubature (TKT-170). On pose une boîte dans la scène, on la déplace
// et on la redimensionne ; le volume mesuré est celui sous l'enveloppe visible
// des splats contenus dans la boîte, considéré comme plein. Les splats ne
// décrivent qu'une surface : on quadrille l'emprise au sol de la boîte, on
// prend pour chaque cellule la hauteur du dessus de la matière au-dessus du
// fond de la boîte, et on somme hauteur × aire de cellule.

type VolumeState = 'idle' | 'placed';

// Poignées : une par face (±X, ±Y, ±Z locaux), puis le centre en dernier pour
// que les faces restent attrapables quand la boîte est petite à l'écran.
const FACE_HANDLES: { axis: 0 | 1 | 2; sign: 1 | -1 }[] = [
    { axis: 0, sign: 1 }, { axis: 0, sign: -1 },
    { axis: 1, sign: 1 }, { axis: 1, sign: -1 },
    { axis: 2, sign: 1 }, { axis: 2, sign: -1 }
];
const CENTER_HANDLE = FACE_HANDLES.length;

const DEFAULT_SIZE = 1;             // m — arête de la boîte posée au clic
const MIN_HALF_EXTENT = 0.005;      // m — une boîte ne descend pas sous 1 cm
const MIN_SPLATS_PER_CELL = 2;      // en dessous, la cellule est un flotteur isolé
const TOP_PERCENTILE = 0.9;         // dessus de matière, robuste aux flotteurs
const TARGET_SPLATS_PER_CELL = 8;
const MIN_GRID_RES = 8;
const MAX_GRID_RES = 150;
const HOLE_FILL_PASSES = 3;
const HOLE_FILL_MIN_NEIGHBORS = 4;  // sur 8 — ne bouche que les trous entourés
const RECOMPUTE_DELAY = 150;        // ms — regroupe les recalculs pendant un glisser
// Sous ce nombre de splats dans la boîte, la mesure est trop grossière. En LOD,
// c'est le signe qu'un niveau de détail faible est chargé à cet endroit.
const LOW_DENSITY_SPLATS = 1000;

type VolumeResult = {
    volume: number;         // m³
    coverage: number;       // part des cellules de l'emprise portant de la matière
    splatCount: number;
    maxHeight: number;      // m — plus haut point de l'enveloppe au-dessus du fond
};

class VolumeTool {
    private global: Global;

    private pointerHandler: ToolPointerHandler;

    private state: VolumeState = 'idle';

    // Boîte orientée : centre, demi-dimensions sur ses axes locaux, lacet
    // autour de Y (le fond reste horizontal).
    private center = new Vec3();

    private halfExtents = new Vec3(DEFAULT_SIZE / 2, DEFAULT_SIZE / 2, DEFAULT_SIZE / 2);

    private yaw = 0;

    private axes = [new Vec3(1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, 0, 1)];

    // Poignées déplacées par ToolPointerHandler, et leur dernière position
    // connue pour retrouver celle qui a bougé.
    private handles: Vec3[] = [];

    private lastHandles: Vec3[] = [];

    private result: VolumeResult | null = null;

    private computing = false;

    private recomputeTimer: ReturnType<typeof setTimeout> | null = null;

    private overlay: HTMLDivElement | null = null;

    private drawCanvas: HTMLCanvasElement | null = null;

    private panel: HTMLDivElement | null = null;

    private panelValues: Record<string, HTMLElement> = {};

    private yawInput: HTMLInputElement | null = null;

    private lowDensityHint: HTMLDivElement | null = null;

    private updateHandler: ((dt: number) => void) | null = null;

    constructor(global: Global) {
        this.global = global;
        for (let i = 0; i <= CENTER_HANDLE; i++) {
            this.handles.push(new Vec3());
            this.lastHandles.push(new Vec3());
        }
        this.pointerHandler = new ToolPointerHandler(global, {
            onCanvasClick: pos => this.handleClick(pos),
            getDraggablePoints: () => (this.state === 'placed' ? this.handles : []),
            onClear: () => this.clearAll()
        });
    }

    activate() {
        const { app } = this.global;

        this.overlay = document.createElement('div');
        this.overlay.id = 'volumeMeasureOverlay';
        const ui = document.querySelector('#ui');
        ui.insertBefore(this.overlay, ui.firstChild);

        this.drawCanvas = document.createElement('canvas');
        this.drawCanvas.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;';
        this.overlay.appendChild(this.drawCanvas);

        this.pointerHandler.activate();

        this.updateHandler = () => {
            this.syncFromHandles();
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
        this.cancelRecompute();
        this.removePanel();

        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }

        this.drawCanvas = null;
        this.state = 'idle';
        this.result = null;
    }

    destroy() {
        this.deactivate();
        this.pointerHandler.destroy();
    }

    private handleClick(pos: Vec3) {
        if (this.state === 'placed') {
            // Les poignées sont prises par le glisser du ToolPointerHandler ;
            // un clic dans le vide désélectionne.
            this.pointerHandler.selectedIndex = -1;
            return;
        }

        // La boîte se pose sur le point cliqué, face à la caméra.
        const forward = this.global.camera.forward;
        this.yaw = Math.hypot(forward.x, forward.z) > 1e-6 ? Math.atan2(-forward.x, -forward.z) : 0;
        this.halfExtents.set(DEFAULT_SIZE / 2, DEFAULT_SIZE / 2, DEFAULT_SIZE / 2);
        this.center.set(pos.x, pos.y + DEFAULT_SIZE / 2, pos.z);
        this.state = 'placed';

        this.updateAxes();
        this.writeHandles();
        this.showPanel();
        this.scheduleRecompute(0);
    }

    private clearAll() {
        this.state = 'idle';
        this.result = null;
        this.cancelRecompute();
        this.removePanel();
        this.pointerHandler.reset();
    }

    // ── Boîte et poignées ──

    private updateAxes() {
        const c = Math.cos(this.yaw);
        const s = Math.sin(this.yaw);
        this.axes[0].set(c, 0, -s);
        this.axes[1].set(0, 1, 0);
        this.axes[2].set(s, 0, c);
    }

    private halfExtent(axis: number): number {
        return axis === 0 ? this.halfExtents.x : axis === 1 ? this.halfExtents.y : this.halfExtents.z;
    }

    private setHalfExtent(axis: number, value: number) {
        if (axis === 0) this.halfExtents.x = value;
        else if (axis === 1) this.halfExtents.y = value;
        else this.halfExtents.z = value;
    }

    private writeHandles() {
        FACE_HANDLES.forEach(({ axis, sign }, i) => {
            this.handles[i].copy(this.axes[axis]).mulScalar(sign * this.halfExtent(axis)).add(this.center);
        });
        this.handles[CENTER_HANDLE].copy(this.center);
        for (let i = 0; i < this.handles.length; i++) {
            this.lastHandles[i].copy(this.handles[i]);
        }
    }

    // ToolPointerHandler déplace librement la poignée attrapée ; on traduit ce
    // déplacement en translation (centre) ou en redimensionnement (face, la
    // face opposée restant fixe), puis on replace toutes les poignées.
    private syncFromHandles() {
        if (this.state !== 'placed') return;

        const moved = this.handles.findIndex((h, i) => !h.equals(this.lastHandles[i]));
        if (moved < 0) return;

        const delta = new Vec3().sub2(this.handles[moved], this.lastHandles[moved]);

        if (moved === CENTER_HANDLE) {
            this.center.add(delta);
        } else {
            const { axis, sign } = FACE_HANDLES[moved];
            const dir = this.axes[axis];
            const half = this.halfExtent(axis);
            // Position des deux faces le long de l'axe, relative au centre.
            const opposite = -sign * half;
            let face = sign * half + delta.dot(dir);
            if (sign * (face - opposite) < 2 * MIN_HALF_EXTENT) {
                face = opposite + sign * 2 * MIN_HALF_EXTENT;
            }
            this.setHalfExtent(axis, Math.abs(face - opposite) / 2);
            this.center.add(new Vec3().copy(dir).mulScalar((face + opposite) / 2));
        }

        this.writeHandles();
        this.updatePanel();
        this.scheduleRecompute(RECOMPUTE_DELAY);
    }

    private corners(): Vec3[] {
        const [ax, ay, az] = this.axes;
        const { x: hx, y: hy, z: hz } = this.halfExtents;
        const out: Vec3[] = [];
        // Indice binaire : bit 0 → X, bit 1 → Y, bit 2 → Z.
        for (let i = 0; i < 8; i++) {
            const p = this.center.clone();
            p.add(new Vec3().copy(ax).mulScalar(i & 1 ? hx : -hx));
            p.add(new Vec3().copy(ay).mulScalar(i & 2 ? hy : -hy));
            p.add(new Vec3().copy(az).mulScalar(i & 4 ? hz : -hz));
            out.push(p);
        }
        return out;
    }

    // ── Calcul du volume ──

    private scheduleRecompute(delay: number) {
        this.cancelRecompute();
        this.computing = true;
        this.updatePanel();
        this.recomputeTimer = setTimeout(() => {
            this.recomputeTimer = null;
            this.result = this.computeVolume();
            this.computing = false;
            this.updatePanel();
            this.global.app.renderNextFrame = true;
        }, delay);
    }

    private cancelRecompute() {
        if (this.recomputeTimer) {
            clearTimeout(this.recomputeTimer);
            this.recomputeTimer = null;
        }
        this.computing = false;
    }

    private computeVolume(): VolumeResult | null {
        const info = getSplatCenters(this.global);
        if (!info) return null;

        const { centers, numSplats, worldMatrix: m } = info;
        const [ax, , az] = this.axes;
        const { x: hx, y: hy, z: hz } = this.halfExtents;
        const cx = this.center.x, cy = this.center.y, cz = this.center.z;
        const bottom = cy - hy;
        const height = 2 * hy;

        // Passe 1 : splats dans la boîte, en coordonnées locales (u, w) de
        // l'emprise et hauteur h au-dessus du fond.
        const us: number[] = [];
        const ws: number[] = [];
        const hs: number[] = [];
        for (let i = 0; i < numSplats; i++) {
            const idx = i * 3;
            const lx = centers[idx], ly = centers[idx + 1], lz = centers[idx + 2];
            const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
            const wy = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
            const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];

            const h = wy - bottom;
            if (h < 0 || h > height) continue;
            const dx = wx - cx, dz = wz - cz;
            const u = dx * ax.x + dz * ax.z;
            if (u < -hx || u > hx) continue;
            const w = dx * az.x + dz * az.z;
            if (w < -hz || w > hz) continue;

            us.push(u);
            ws.push(w);
            hs.push(h);
        }

        const splatCount = hs.length;
        if (splatCount === 0) {
            return { volume: 0, coverage: 0, splatCount: 0, maxHeight: 0 };
        }

        // Grille adaptée à la densité, proportionnée à l'emprise.
        const aspect = hx / hz;
        const cells = splatCount / TARGET_SPLATS_PER_CELL;
        const clampRes = (v: number) => Math.max(MIN_GRID_RES, Math.min(MAX_GRID_RES, Math.round(v)));
        const resZ = clampRes(Math.sqrt(cells / aspect));
        const resX = clampRes(resZ * aspect);
        const cellCount = resX * resZ;
        const cellArea = (2 * hx / resX) * (2 * hz / resZ);

        // Passe 2 : tri des hauteurs par cellule (tri par dénombrement).
        const cellOf = new Int32Array(splatCount);
        const counts = new Int32Array(cellCount + 1);
        for (let k = 0; k < splatCount; k++) {
            const gi = Math.min(Math.floor((us[k] + hx) / (2 * hx) * resX), resX - 1);
            const gj = Math.min(Math.floor((ws[k] + hz) / (2 * hz) * resZ), resZ - 1);
            const cell = gj * resX + gi;
            cellOf[k] = cell;
            counts[cell + 1]++;
        }
        for (let c = 0; c < cellCount; c++) counts[c + 1] += counts[c];
        const sorted = new Float32Array(splatCount);
        const cursor = counts.slice(0, cellCount);
        for (let k = 0; k < splatCount; k++) {
            sorted[cursor[cellOf[k]]++] = hs[k];
        }

        // Dessus de la matière par cellule (percentile haut) ; NaN = pas de donnée.
        let tops = new Float32Array(cellCount).fill(NaN);
        let filled = 0;
        for (let c = 0; c < cellCount; c++) {
            const start = counts[c], end = counts[c + 1];
            const n = end - start;
            if (n < MIN_SPLATS_PER_CELL) continue;
            const slice = sorted.subarray(start, end).sort();
            tops[c] = slice[Math.floor(TOP_PERCENTILE * (n - 1))];
            filled++;
        }
        const coverage = filled / cellCount;

        // Bouche les trous entourés de matière (splats manquants sur la surface),
        // sans étendre le tas vers les bords vides de la boîte.
        for (let pass = 0; pass < HOLE_FILL_PASSES; pass++) {
            const next = tops.slice();
            let changed = false;
            for (let j = 0; j < resZ; j++) {
                for (let i = 0; i < resX; i++) {
                    if (!Number.isNaN(tops[j * resX + i])) continue;
                    let sum = 0, n = 0;
                    for (let dj = -1; dj <= 1; dj++) {
                        for (let di = -1; di <= 1; di++) {
                            const ni = i + di, nj = j + dj;
                            if ((di === 0 && dj === 0) || ni < 0 || nj < 0 || ni >= resX || nj >= resZ) continue;
                            const v = tops[nj * resX + ni];
                            if (!Number.isNaN(v)) {
                                sum += v;
                                n++;
                            }
                        }
                    }
                    if (n >= HOLE_FILL_MIN_NEIGHBORS) {
                        next[j * resX + i] = sum / n;
                        changed = true;
                    }
                }
            }
            tops = next;
            if (!changed) break;
        }

        let volume = 0;
        let maxHeight = 0;
        for (let c = 0; c < cellCount; c++) {
            const t = tops[c];
            if (Number.isNaN(t)) continue;
            volume += t * cellArea;
            if (t > maxHeight) maxHeight = t;
        }

        return { volume, coverage, splatCount, maxHeight };
    }

    // ── Rendu ──

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

        if (this.state === 'placed') {
            this.drawBox(ctx);
        }
    }

    private drawBox(ctx: CanvasRenderingContext2D) {
        const camera = this.global.camera;
        const corners = this.corners();
        const screen = corners.map(p => worldToScreen(camera, p));

        // Fond de la boîte (plan de référence du calcul) légèrement teinté.
        const base = [0, 1, 5, 4].map(i => screen[i]);
        if (base.every(s => !s.behind)) {
            ctx.beginPath();
            ctx.moveTo(base[0].x, base[0].y);
            for (let i = 1; i < base.length; i++) ctx.lineTo(base[i].x, base[i].y);
            ctx.closePath();
            ctx.fillStyle = accentRgba(0.15);
            ctx.fill();
        }

        // Arêtes : paires de coins qui ne diffèrent que d'un bit.
        ctx.strokeStyle = ACCENT_COLOR;
        ctx.lineWidth = 2;
        for (let a = 0; a < 8; a++) {
            for (const bit of [1, 2, 4]) {
                const b = a | bit;
                if (b === a || screen[a].behind || screen[b].behind) continue;
                ctx.beginPath();
                ctx.moveTo(screen[a].x, screen[a].y);
                ctx.lineTo(screen[b].x, screen[b].y);
                ctx.stroke();
            }
        }

        // Cotes : longueur (X), largeur (Z) sur le fond, hauteur (Y).
        for (const [a, b] of [[0, 1], [0, 4], [0, 2]]) {
            if (!screen[a].behind && !screen[b].behind) {
                drawEdgeLabel(ctx, corners[a], corners[b], screen[a], screen[b]);
            }
        }

        // Poignées : faces en carré, centre en rond.
        const selected = this.pointerHandler.selectedIndex;
        for (let i = 0; i < this.handles.length; i++) {
            const sp = worldToScreen(camera, this.handles[i]);
            if (sp.behind) continue;
            const isSelected = i === selected;
            const r = isSelected ? 8 : 6;
            ctx.beginPath();
            if (i === CENTER_HANDLE) {
                ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
            } else {
                ctx.rect(sp.x - r, sp.y - r, r * 2, r * 2);
            }
            ctx.fillStyle = isSelected ? '#FFFFFF' : ACCENT_COLOR;
            ctx.fill();
            ctx.strokeStyle = isSelected ? ACCENT_COLOR : '#FFFFFF';
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        if (selected >= 0 && selected < this.handles.length) {
            this.pointerHandler.renderGizmo(ctx, camera, this.handles[selected]);
        }

        // Volume au-dessus du centre de la boîte.
        const top = worldToScreen(camera, new Vec3().copy(this.axes[1]).mulScalar(this.halfExtents.y).add(this.center));
        if (!top.behind) {
            const text = this.computing ? '…' : this.result ? formatVolume(this.result.volume) : '?';
            ctx.font = 'bold 14px Arial';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const metrics = ctx.measureText(text);
            const pw = 8, ph = 4;
            const y = top.y - 24;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.beginPath();
            ctx.roundRect(top.x - metrics.width / 2 - pw, y - 8 - ph, metrics.width + pw * 2, 16 + ph * 2, 4);
            ctx.fill();
            ctx.fillStyle = '#FFFFFF';
            ctx.fillText(text, top.x, y);
        }
    }

    // ── Panneau ──

    private showPanel() {
        this.removePanel();

        this.panel = document.createElement('div');
        this.panel.id = 'volumePanel';

        const title = document.createElement('div');
        title.className = 'volume-title';
        title.textContent = 'Cubature';
        this.panel.appendChild(title);

        const rows: [string, string][] = [
            ['volume', 'Volume mesuré'],
            ['dimensions', 'Boîte (L × l × h)'],
            ['boxVolume', 'Volume de la boîte'],
            ['maxHeight', 'Hauteur max.'],
            ['coverage', 'Couverture'],
            ['splats', 'Splats analysés']
        ];
        this.panelValues = {};
        for (const [key, label] of rows) {
            const row = document.createElement('div');
            row.className = key === 'volume' ? 'volume-row volume-main' : 'volume-row';
            const l = document.createElement('span');
            l.textContent = label;
            const v = document.createElement('span');
            v.className = 'volume-value';
            row.append(l, v);
            this.panel.appendChild(row);
            this.panelValues[key] = v;
        }

        // Orientation de la boîte autour de la verticale.
        const yawRow = document.createElement('label');
        yawRow.className = 'volume-yaw';
        const yawLabel = document.createElement('span');
        yawLabel.textContent = 'Rotation';
        this.yawInput = document.createElement('input');
        this.yawInput.type = 'range';
        this.yawInput.min = '-180';
        this.yawInput.max = '180';
        this.yawInput.step = '1';
        this.yawInput.addEventListener('input', () => {
            this.yaw = Number(this.yawInput.value) * Math.PI / 180;
            this.updateAxes();
            this.writeHandles();
            this.updatePanel();
            this.scheduleRecompute(RECOMPUTE_DELAY);
            this.global.app.renderNextFrame = true;
        });
        yawRow.append(yawLabel, this.yawInput);
        this.panel.appendChild(yawRow);

        // En LOD, le détail chargé dépend de la position de la caméra : après
        // s'être rapproché, on relance le calcul sans toucher à la boîte.
        this.lowDensityHint = document.createElement('div');
        this.lowDensityHint.className = 'volume-warning hidden';
        this.lowDensityHint.textContent = 'Peu de splats chargés dans la boîte : rapprochez la caméra pour charger ' +
            'plus de détail, puis recalculez.';
        this.panel.appendChild(this.lowDensityHint);

        const recompute = document.createElement('button');
        recompute.className = 'volume-recompute';
        recompute.textContent = 'Recalculer';
        recompute.addEventListener('click', () => this.scheduleRecompute(0));
        this.panel.appendChild(recompute);

        const note = document.createElement('div');
        note.className = 'volume-note';
        note.textContent = 'Volume plein sous l’enveloppe visible, mesuré depuis le fond de la boîte. ' +
            'Glissez les poignées pour ajuster, clic droit ou Échap pour effacer.';
        this.panel.appendChild(note);

        this.overlay?.appendChild(this.panel);
        this.updatePanel();
    }

    private updatePanel() {
        if (!this.panel) return;

        const { x: hx, y: hy, z: hz } = this.halfExtents;
        const v = this.panelValues;
        const r = this.result;
        const pending = this.computing || !r;

        v.volume.textContent = this.computing ? 'calcul…' : r ? formatVolume(r.volume) : 'splats indisponibles';
        v.dimensions.textContent = `${formatDistance(2 * hx)} × ${formatDistance(2 * hz)} × ${formatDistance(2 * hy)}`;
        v.boxVolume.textContent = formatVolume(8 * hx * hy * hz);
        v.maxHeight.textContent = pending ? '–' : formatDistance(r.maxHeight);
        v.coverage.textContent = pending ? '–' : `${Math.round(r.coverage * 100)} %`;
        v.splats.textContent = pending ? '–' : r.splatCount.toLocaleString('fr-FR');
        this.lowDensityHint?.classList.toggle('hidden', pending || r.splatCount >= LOW_DENSITY_SPLATS);

        if (this.yawInput && document.activeElement !== this.yawInput) {
            let deg = Math.round(this.yaw * 180 / Math.PI);
            if (deg > 180) deg -= 360;
            if (deg < -180) deg += 360;
            this.yawInput.value = String(deg);
        }
    }

    private removePanel() {
        if (this.panel) {
            this.panel.remove();
            this.panel = null;
            this.panelValues = {};
            this.yawInput = null;
            this.lowDensityHint = null;
        }
    }
}

function formatVolume(volume: number): string {
    if (volume >= 0.1) {
        return `${volume.toFixed(3)} m³`;
    }
    return `${Math.round(volume * 1e6).toLocaleString('fr-FR')} cm³`;
}

export { VolumeTool };
