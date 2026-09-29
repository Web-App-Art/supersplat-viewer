// ARTLIGHT (TKT-225)
//
// Outil « Point XYZ » : chaque clic pose un point numéroté (P1, P2…) et affiche
// ses coordonnées. Les points se déplacent (glisser, gizmo) et se suppriment.
// Un panneau les liste ; un clic sur une ligne copie « X;Y;Z », un bouton
// copie tous les points, une ligne par point.
//
// Aucun mapping d'axes ici : tout passe par CoordinateSystem et les fonctions
// de formatage de coordinates.ts (voir la spec « Coordonnées et repères »).
//
// TKT-226 : le panneau règle aussi le zéro utilisateur. « Définir le zéro »
// et « Orienter X » font du clic suivant sur le modèle un point de référence
// au lieu d'un nouveau point ; les coordonnées réelles du zéro se saisissent
// sous ces boutons.

import type { Vec3 } from 'playcanvas';

import { coordsForClipboard, formatCoordsInline } from './coordinates';
import type { Triple } from './coordinates';
import { localize } from './localization';
import { ToolPointerHandler } from './tool-pointer-handler';
import { worldToScreen, copyTable, ACCENT_COLOR } from './tool-utils';
import type { Global } from './types';

type XyzPoint = {
    label: string;
    pos: Vec3;
};

// Effet du prochain clic sur le modèle.
type PickMode = 'point' | 'zero' | 'axis';

type PanelRow = {
    row: HTMLDivElement;
    coords: HTMLSpanElement;
};

// Durée du retour « Copié » dans le panneau.
const COPIED_FEEDBACK_MS = 1500;

const LABEL_FONT = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

class PointTool {
    private global: Global;

    private pointerHandler: ToolPointerHandler;

    private points: XyzPoint[] = [];

    // Les numéros ne sont jamais réattribués : supprimer P2 laisse P3 en P3,
    // pour ne pas fausser un relevé déjà noté.
    private nextNumber = 1;

    private overlay: HTMLDivElement | null = null;

    private drawCanvas: HTMLCanvasElement | null = null;

    private updateHandler: ((dt: number) => void) | null = null;

    private keyHandler: ((e: KeyboardEvent) => void) | null = null;

    private panel: HTMLDivElement | null = null;

    private listEl: HTMLDivElement | null = null;

    private emptyEl: HTMLDivElement | null = null;

    private copyAllButton: HTMLButtonElement | null = null;

    private statusEl: HTMLDivElement | null = null;

    private rows: PanelRow[] = [];

    private statusTimer: ReturnType<typeof setTimeout> | null = null;

    private pickMode: PickMode = 'point';

    private frameEl: HTMLSpanElement | null = null;

    private zeroButton: HTMLButtonElement | null = null;

    private axisButton: HTMLButtonElement | null = null;

    private clearZeroButton: HTMLButtonElement | null = null;

    private pickHintEl: HTMLDivElement | null = null;

    private knownEl: HTMLDivElement | null = null;

    private knownInputs: HTMLInputElement[] = [];

    private coordsHandler = () => this.refreshZero();

    constructor(global: Global) {
        this.global = global;
        this.pointerHandler = new ToolPointerHandler(global, {
            onCanvasClick: pos => this.handleClick(pos),
            // En sélection du zéro, un clic sur un point existant vise le
            // modèle dessous au lieu de saisir le point.
            getDraggablePoints: () => (this.pickMode === 'point' ? this.points.map(p => p.pos) : []),
            // Échap annule d'abord une sélection du zéro en cours.
            onClear: () => (this.pickMode === 'point' ? this.clearAll() : this.setPickMode('point'))
        });
    }

    activate() {
        const { app } = this.global;

        // Calque purement visuel (pointer-events: none), le panneau excepté
        this.overlay = document.createElement('div');
        this.overlay.id = 'pointOverlay';
        const ui = document.querySelector('#ui');
        ui.insertBefore(this.overlay, ui.firstChild);

        this.drawCanvas = document.createElement('canvas');
        this.drawCanvas.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;';
        this.overlay.appendChild(this.drawCanvas);

        this.showPanel();
        this.pointerHandler.activate();
        this.global.events.on('coords:changed', this.coordsHandler);

        this.keyHandler = (event: KeyboardEvent) => {
            if (event.key !== 'Delete' && event.key !== 'Backspace') return;
            const target = event.target as HTMLElement | null;
            if (target?.closest?.('input, textarea, [contenteditable]')) return;
            const selected = this.pointerHandler.selectedIndex;
            if (selected >= 0 && selected < this.points.length) {
                event.preventDefault();
                this.deletePoint(selected);
            }
        };
        document.addEventListener('keydown', this.keyHandler);

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

        if (this.keyHandler) {
            document.removeEventListener('keydown', this.keyHandler);
            this.keyHandler = null;
        }

        this.pointerHandler.deactivate();
        this.global.events.off('coords:changed', this.coordsHandler);
        this.pickMode = 'point';

        this.removePanel();

        if (this.overlay) {
            this.overlay.remove();
            this.overlay = null;
        }

        this.drawCanvas = null;
        this.points = [];
        this.nextNumber = 1;
    }

    destroy() {
        this.deactivate();
        this.pointerHandler.destroy();
    }

    private handleClick(pos: Vec3) {
        const { coords } = this.global;

        if (this.pickMode === 'zero') {
            coords.setZero(pos);
            this.setPickMode('point');
            this.showStatus(localize('artlight.zero.set'));
            return;
        }

        if (this.pickMode === 'axis') {
            const ok = coords.orientX(pos);
            this.setPickMode('point');
            this.showStatus(localize(ok ? 'artlight.zero.axis-set' : 'artlight.zero.axis-vertical'));
            return;
        }

        // Comme l'outil Mesure : un clic sur un point le sélectionne (géré par
        // ToolPointerHandler) ; un clic ailleurs désélectionne d'abord.
        if (this.pointerHandler.selectedIndex >= 0) {
            this.pointerHandler.selectedIndex = -1;
            return;
        }

        this.points.push({ label: `P${this.nextNumber++}`, pos });
        this.rebuildList();
        this.global.app.renderNextFrame = true;
    }

    private deletePoint(index: number) {
        this.points.splice(index, 1);
        this.pointerHandler.reset();
        if (this.points.length === 0) {
            this.nextNumber = 1;
        }
        this.rebuildList();
        this.global.app.renderNextFrame = true;
    }

    private clearAll() {
        this.points = [];
        this.nextNumber = 1;
        this.pointerHandler.reset();
        this.rebuildList();
        this.global.app.renderNextFrame = true;
    }

    // Coordonnées affichées : repère source, ou relatives au zéro.
    private coordsOf(point: XyzPoint) {
        return this.global.coords.toDisplay(point.pos);
    }

    // ── Rendu canvas ──

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

        // Le panneau suit les déplacements. Mis à jour à chaque image, et pas
        // seulement pendant le glisser : le dernier mouvement avant le relâcher
        // peut ne pas avoir eu d'image à lui.
        this.updateRowValues();

        if (this.points.length === 0) return;

        const camera = this.global.camera;
        const selected = this.pointerHandler.selectedIndex;
        const frame = this.global.coords.frameName;

        for (let i = 0; i < this.points.length; i++) {
            const point = this.points[i];
            const sp = worldToScreen(camera, point.pos);
            if (sp.behind) continue;

            const isSelected = i === selected;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, isSelected ? 8 : 6, 0, Math.PI * 2);
            ctx.fillStyle = isSelected ? '#FFFFFF' : ACCENT_COLOR;
            ctx.fill();
            ctx.strokeStyle = isSelected ? ACCENT_COLOR : '#FFFFFF';
            ctx.lineWidth = 2;
            ctx.stroke();

            this.drawLabel(ctx, sp, point.label, formatCoordsInline(this.coordsOf(point), frame));
        }

        if (selected >= 0 && selected < this.points.length) {
            this.pointerHandler.renderGizmo(ctx, camera, this.points[selected].pos);
        }
    }

    // Étiquette d'une ligne à droite du point : « P1 » en accent, puis les
    // coordonnées. Bascule à gauche si elle déborde de la fenêtre.
    private drawLabel(ctx: CanvasRenderingContext2D, screen: { x: number; y: number }, name: string, text: string) {
        ctx.font = LABEL_FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        const padX = 8;
        const gap = 6;
        const boxH = 22;
        const nameW = ctx.measureText(name).width;
        const textW = ctx.measureText(text).width;
        const boxW = padX * 2 + nameW + gap + textW;

        const offset = 14;
        let x = screen.x + offset;
        if (x + boxW > window.innerWidth - 8) {
            x = screen.x - offset - boxW;
        }
        x = Math.max(8, x);
        const y = Math.min(Math.max(8, screen.y - boxH / 2), window.innerHeight - 8 - boxH);

        ctx.fillStyle = 'rgba(24, 24, 27, 0.92)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x, y, boxW, boxH, 6);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = ACCENT_COLOR;
        ctx.fillText(name, x + padX, y + boxH / 2);
        ctx.fillStyle = '#e4e4e7';
        ctx.fillText(text, x + padX + nameW + gap, y + boxH / 2);
    }

    // ── Panneau ──

    private showPanel() {
        this.removePanel();

        this.panel = document.createElement('div');
        this.panel.id = 'pointPanel';

        const header = document.createElement('div');
        header.className = 'point-header';
        const title = document.createElement('span');
        title.className = 'point-title';
        title.textContent = localize('artlight.point.title');
        this.frameEl = document.createElement('span');
        this.frameEl.className = 'point-frame';
        header.append(title, this.frameEl);
        this.panel.appendChild(header);

        this.panel.appendChild(this.buildZeroSection());

        this.emptyEl = document.createElement('div');
        this.emptyEl.className = 'point-empty';
        this.emptyEl.textContent = localize('artlight.point.empty');
        this.panel.appendChild(this.emptyEl);

        this.listEl = document.createElement('div');
        this.listEl.className = 'point-list';
        this.panel.appendChild(this.listEl);

        this.copyAllButton = document.createElement('button');
        this.copyAllButton.className = 'point-copy-all';
        this.copyAllButton.textContent = localize('artlight.point.copy-all');
        this.copyAllButton.addEventListener('click', () => {
            this.copy(this.points.map(p => coordsForClipboard(this.coordsOf(p))));
        });
        this.panel.appendChild(this.copyAllButton);

        this.statusEl = document.createElement('div');
        this.statusEl.className = 'point-status';
        this.statusEl.setAttribute('aria-live', 'polite');
        this.panel.appendChild(this.statusEl);

        const note = document.createElement('div');
        note.className = 'point-note';
        note.textContent = localize('artlight.point.help');
        this.panel.appendChild(note);

        this.overlay?.appendChild(this.panel);
        this.refreshZero();
        this.rebuildList();
    }

    // ── Zéro (TKT-226) ──

    private buildZeroSection() {
        const section = document.createElement('div');
        section.className = 'point-zero';

        const actions = document.createElement('div');
        actions.className = 'point-zero-actions';

        const makeButton = (key: string, onClick: () => void) => {
            const button = document.createElement('button');
            button.className = 'point-zero-button';
            button.textContent = localize(key);
            button.addEventListener('click', onClick);
            actions.appendChild(button);
            return button;
        };

        this.zeroButton = makeButton('artlight.zero.define', () => {
            this.setPickMode(this.pickMode === 'zero' ? 'point' : 'zero');
        });
        this.axisButton = makeButton('artlight.zero.orient', () => {
            this.setPickMode(this.pickMode === 'axis' ? 'point' : 'axis');
        });
        this.clearZeroButton = makeButton('artlight.zero.clear', () => {
            this.setPickMode('point');
            this.global.coords.clearZero();
        });
        section.appendChild(actions);

        this.pickHintEl = document.createElement('div');
        this.pickHintEl.className = 'point-zero-hint';
        section.appendChild(this.pickHintEl);

        // Coordonnées réelles du point zéro, 0 par défaut.
        this.knownEl = document.createElement('div');
        this.knownEl.className = 'point-zero-known';
        const knownLabel = document.createElement('span');
        knownLabel.className = 'point-zero-known-label';
        knownLabel.textContent = localize('artlight.zero.known-label');
        this.knownEl.appendChild(knownLabel);
        this.knownInputs = ['X', 'Y', 'Z'].map((axis) => {
            const field = document.createElement('label');
            field.className = 'point-zero-field';
            const name = document.createElement('span');
            name.textContent = axis;
            const input = document.createElement('input');
            input.type = 'text';
            input.inputMode = 'decimal';
            input.spellcheck = false;
            input.setAttribute('aria-label', `${localize('artlight.zero.known-label')} ${axis}`);
            input.addEventListener('change', () => this.applyKnown());
            input.addEventListener('keydown', (event) => {
                event.stopPropagation();
                if (event.key === 'Enter') input.blur();
            });
            field.append(name, input);
            this.knownEl.appendChild(field);
            return input;
        });
        section.appendChild(this.knownEl);

        return section;
    }

    private setPickMode(mode: PickMode) {
        this.pickMode = mode;
        if (mode !== 'point') this.pointerHandler.selectedIndex = -1;
        this.refreshZero();
        this.global.app.renderNextFrame = true;
    }

    // Accepte la virgule comme séparateur décimal. Une valeur illisible est
    // ignorée et le champ reprend la valeur mémorisée.
    private applyKnown() {
        const values = this.knownInputs.map((input) => {
            const text = input.value.trim().replace(/\s/g, '').replace(',', '.');
            return text === '' ? 0 : Number(text);
        });
        if (values.every(Number.isFinite)) {
            this.global.coords.setKnown(values as Triple);
        }
        this.refreshZero();
    }

    private refreshZero() {
        const { coords } = this.global;
        const zero = coords.zero;

        if (this.frameEl) this.frameEl.textContent = coords.frameName;

        this.zeroButton?.classList.toggle('active', this.pickMode === 'zero');
        this.axisButton?.classList.toggle('active', this.pickMode === 'axis');
        if (this.axisButton) this.axisButton.disabled = !zero;
        if (this.clearZeroButton) this.clearZeroButton.disabled = !zero;

        if (this.pickHintEl) {
            const hint = this.pickMode === 'zero' ? 'artlight.zero.pick-zero' :
                this.pickMode === 'axis' ? 'artlight.zero.pick-axis' : '';
            this.pickHintEl.textContent = hint ? localize(hint) : '';
            this.pickHintEl.classList.toggle('hidden', !hint);
        }

        this.knownEl?.classList.toggle('hidden', !zero);
        if (zero) {
            const values = coordsForClipboard(zero.known);
            this.knownInputs.forEach((input, i) => {
                if (document.activeElement !== input) input.value = values[i];
            });
        }

        this.updateRowValues();
    }

    private rebuildList() {
        if (!this.listEl) return;

        this.listEl.replaceChildren();
        this.rows = this.points.map((point, index) => {
            const row = document.createElement('div');
            row.className = 'point-row';
            row.setAttribute('role', 'button');
            row.tabIndex = 0;
            row.title = localize('artlight.point.copy-hint');

            const name = document.createElement('span');
            name.className = 'point-name';
            name.textContent = point.label;

            const coords = document.createElement('span');
            coords.className = 'point-coords';

            const del = document.createElement('button');
            del.className = 'point-delete';
            del.textContent = '×';
            del.title = localize('artlight.point.delete');
            del.setAttribute('aria-label', `${localize('artlight.point.delete')} ${point.label}`);
            del.addEventListener('click', (event) => {
                event.stopPropagation();
                this.deletePoint(index);
            });

            const copyRow = () => {
                this.copy([coordsForClipboard(this.coordsOf(point))], point.label);
            };
            row.addEventListener('click', copyRow);
            row.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    copyRow();
                }
            });

            row.append(name, coords, del);
            this.listEl.appendChild(row);
            return { row, coords };
        });

        this.emptyEl?.classList.toggle('hidden', this.points.length > 0);
        if (this.copyAllButton) this.copyAllButton.disabled = this.points.length === 0;
        this.updateRowValues();
    }

    private updateRowValues() {
        for (let i = 0; i < this.rows.length && i < this.points.length; i++) {
            const text = formatCoordsInline(this.coordsOf(this.points[i]));
            const el = this.rows[i].coords;
            if (el.textContent !== text) el.textContent = text;
        }
    }

    private copy(values: string[][], label?: string) {
        if (values.length === 0) return;
        copyTable(values).then((ok) => {
            let message = localize('artlight.point.copy-failed');
            if (ok) {
                message = label ?
                    localize('artlight.point.copied-one').replace('{label}', label) :
                    localize('artlight.point.copied-all');
            }
            this.showStatus(message);
        });
    }

    private showStatus(message: string) {
        if (!this.statusEl) return;
        this.statusEl.textContent = message;
        if (this.statusTimer) clearTimeout(this.statusTimer);
        this.statusTimer = setTimeout(() => {
            this.statusTimer = null;
            if (this.statusEl) this.statusEl.textContent = '';
        }, COPIED_FEEDBACK_MS);
    }

    private removePanel() {
        if (this.statusTimer) {
            clearTimeout(this.statusTimer);
            this.statusTimer = null;
        }
        if (this.panel) {
            this.panel.remove();
            this.panel = null;
        }
        this.listEl = null;
        this.emptyEl = null;
        this.copyAllButton = null;
        this.statusEl = null;
        this.rows = [];
        this.frameEl = null;
        this.zeroButton = null;
        this.axisButton = null;
        this.clearZeroButton = null;
        this.pickHintEl = null;
        this.knownEl = null;
        this.knownInputs = [];
    }
}

export { PointTool };
