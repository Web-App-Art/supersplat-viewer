// ARTLIGHT
//
// Calque « Équipements » : les points d'intérêt techniques d'un relevé
// (arrivées d'eau et d'électricité, regards, ventilations, appareils…), un
// repère par objet, posé sur l'objet, avec sa photo et sa fiche.
//
// La scène déclare un fichier dans son project.json :
//   "equipements": "./equipements/equipements.json",
//   "equipementsVisibles": true            // repères montrés dès l'ouverture
//
// Le fichier liste les niveaux, les familles (nom, couleur) et les points :
// sigle des plans, titre, lieu, description, marque, remarque, photos
// (relatives au fichier, une version « grand/ » sert au zoom), position et
// point de vue en repère moteur, coordonnées affichées (CC43 + NGF), précision.
//
// Affichage :
// - repères DOM (pastille au sigle, couleur de la famille, tige et point posé
//   sur l'objet), taille constante ; un repère caché par un mur ou un plancher
//   s'efface : quand la caméra s'arrête, une passe du picker relit la surface
//   vue à l'endroit de chaque repère (un seul rendu pour tous) ;
// - panneau à droite : liste par famille, filtrée par niveau et par famille,
//   puis la fiche (photo d'abord) ; un clic dans la liste amène la caméra sur
//   le point de vue préparé ;
// - les repères du calque sont aussi posés sur la carte (src/minimap.ts) ;
// - bouton de la barre, touche I : masquer ou montrer les repères.

import { Vec3 } from 'playcanvas';

import { localize } from './localization';
import type { EquipementPin, MiniMap } from './minimap';
import type { Picker } from './picker';
import { resolveScene } from './project';
import type { ProjectContext } from './project';
import type { Global } from './types';

type Famille = { id: string, nom: string, court?: string, couleur: string, pointille?: boolean };

type Niveau = { id: string, nom: string, court?: string };

type Equipement = {
    id: string,
    sigle: string,
    famille: string,
    niveau: string,
    titre: string,
    lieu?: string,
    description?: string,
    marque?: string,
    remarque?: string,
    photos?: string[],
    position: number[],
    vue?: { position: number[], cible: number[] },
    coordonnees?: number[],
    precision?: number,
    approchee?: boolean
};

type Fichier = { version: number, repere?: string, niveaux?: Niveau[], familles?: Famille[], points?: Equipement[] };

// Au-delà, les repères ne sont plus dessinés (m).
const MAX_DISTANCE = 20;
// Au-delà, repère réduit et un peu estompé (m).
const FAR_DISTANCE = 9;
// Marge du test d'occultation : surface vue plus proche que le repère d'au
// moins max(MIN, REL × distance) = repère caché. Couvre l'épaisseur de l'objet
// devant son point d'ancrage (poêle, casier) et le bruit des splats.
const OCCLUSION_MIN = 0.35;
const OCCLUSION_REL = 0.04;
// Test lancé quand la caméra est arrêtée depuis IDLE_MS, ou pendant un
// mouvement continu au plus toutes les MOVING_MS.
const IDLE_MS = 160;
const MOVING_MS = 700;
// Caméra immobile : nouveaux tests à ces délais après l'arrêt, le temps que
// le LOD arrive (une scène pas encore chargée laisse tout voir).
const SETTLE_MS = [1200, 3000, 6000, 10000, 15000, 22000, 30000];

const STORAGE_PREFIX = 'artlight.equipements.';

const valid3 = (p: unknown): p is number[] => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const decimal = (v: number, digits: number) => v.toFixed(digits).replace('.', ',');

const readStored = (key: string): boolean | null => {
    try {
        const value = localStorage.getItem(key);
        return value === null ? null : value === 'on';
    } catch {
        return null;
    }
};

const store = (key: string, value: boolean) => {
    try {
        localStorage.setItem(key, value ? 'on' : 'off');
    } catch {
        // stockage indisponible : le choix vaut pour la session
    }
};

const PIN_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 0 0-13 0c0 5.4 6.5 11 6.5 11z"/><circle cx="12" cy="10" r="2.4"/></g></svg>';

type Marker = {
    item: Equipement,
    el: HTMLButtonElement,
    position: Vec3,
    // dernier test d'occultation : null = pas encore testé
    seen: boolean | null,
    x: number,
    y: number,
    distance: number,
    onScreen: boolean
};

class Equipements {
    private global: Global;

    private picker: Picker;

    private miniMap: MiniMap | null;

    private base: URL;

    private data: Fichier;

    private items: Equipement[];

    private familles = new Map<string, Famille>();

    private niveaux: Niveau[];

    private markers: Marker[] = [];

    private storageKey: string;

    private shown: boolean;

    private level = 'all';

    private hiddenFamilies = new Set<string>();

    private current: Equipement | null = null;

    // DOM
    private layer: HTMLDivElement;

    private panel: HTMLDivElement;

    private listView: HTMLDivElement;

    private cardView: HTMLDivElement;

    private zoom: HTMLDivElement;

    private button: HTMLButtonElement | null;

    private toggle: HTMLButtonElement;

    // test d'occultation
    private lastMove = 0;

    private lastTest = 0;

    private dirty = true;

    private testing = false;

    private lastCamera = new Float32Array(16);

    private settle = 0;

    /**
     * Calque de la scène active, ou null si son project.json n'en déclare pas.
     *
     * @param {Global} global - Le contexte applicatif.
     * @param {Picker} picker - Le picker du visualisateur (test d'occultation).
     * @param {MiniMap | null} miniMap - La carte, pour y poser les repères.
     * @returns {Promise<Equipements | null>} Le calque une fois son fichier lu, ou null.
     */
    static async create(global: Global, picker: Picker, miniMap: MiniMap | null) {
        const context = (window as any).sse?.project as ProjectContext | undefined;
        if (!context?.project?.scenes) return null;
        const scene = resolveScene(context.project, context.sceneId);
        if (typeof scene?.equipements !== 'string') return null;
        const url = new URL(scene.equipements, new URL(context.projectParam, location.href));
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`${response.status}`);
            const data = await response.json() as Fichier;
            const key = `${STORAGE_PREFIX}${new URL(context.projectParam, location.href).pathname}#${scene.id}`;
            return new Equipements(global, picker, miniMap, url, data, key, scene.equipementsVisibles === true);
        } catch (err) {
            console.warn('Équipements : fichier illisible', url.href, err);
            return null;
        }
    }

    private constructor(global: Global, picker: Picker, miniMap: MiniMap | null, base: URL, data: Fichier, storageKey: string, visibleByDefault: boolean) {
        this.global = global;
        this.picker = picker;
        this.miniMap = miniMap;
        this.base = base;
        this.data = data;
        this.storageKey = storageKey;

        for (const f of data.familles ?? []) this.familles.set(f.id, f);
        this.items = (data.points ?? []).filter((p) => {
            if (typeof p?.id === 'string' && typeof p.titre === 'string' && valid3(p.position)) return true;
            console.warn('Équipements : point ignoré', p);
            return false;
        });
        const used = new Set(this.items.map(p => p.niveau));
        this.niveaux = (data.niveaux ?? []).filter(n => used.has(n.id));
        this.shown = readStored(storageKey) ?? visibleByDefault;

        this.buildDom();
        this.buildMarkers();
        this.renderList();
        this.refreshShown();

        const { app, events } = global;
        app.on('prerender', () => this.update());
        app.on('update', () => this.watchCamera());

        // L'outil de mesure ou de coupe ouvre son panneau au même endroit.
        for (const mode of ['measureMode', 'areaMeasureMode', 'flatnessMeasureMode', 'volumeMeasureMode', 'pointMode', 'sectionMode']) {
            events.on(`${mode}:changed`, (on: boolean) => {
                if (on) this.closePanel();
            });
        }
        events.on('xrMode:changed', () => this.refreshShown());

        window.addEventListener('keydown', (event) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
            if (event.key === 'Escape' && !this.zoom.classList.contains('hidden')) {
                this.zoom.classList.add('hidden');
                event.stopImmediatePropagation();
                return;
            }
            if (event.ctrlKey || event.altKey || event.metaKey) return;
            if (event.key === 'i' || event.key === 'I') this.setShown(!this.shown);
        }, true);
    }

    private familyOf(item: Equipement) {
        return this.familles.get(item.famille) ?? { id: item.famille, nom: item.famille, couleur: '#e5e5e5' };
    }

    private photoUrl(path: string, big = false) {
        const parts = path.split('/');
        if (big) parts.splice(parts.length - 1, 0, 'grand');
        return new URL(parts.join('/'), this.base).href;
    }

    private filtered() {
        return this.items.filter(p => (this.level === 'all' || p.niveau === this.level) && !this.hiddenFamilies.has(p.famille));
    }

    // ── DOM ──

    private buildDom() {
        const tr = (key: string) => localize(`artlight.equipements.${key}`);
        const ui = document.querySelector('#ui') ?? document.body;

        this.layer = document.createElement('div');
        this.layer.id = 'equipementsLayer';
        ui.prepend(this.layer);

        this.panel = document.createElement('div');
        this.panel.id = 'equipementsPanel';
        this.panel.className = 'eq-panel hidden';
        this.panel.setAttribute('role', 'dialog');
        this.panel.setAttribute('aria-label', tr('title'));
        this.panel.innerHTML = `
            <div class="eq-head">
                <span class="eq-head-icon">${PIN_ICON}</span>
                <b>${esc(tr('title'))}</b>
                <span class="eq-count"></span>
                <button type="button" class="eq-toggle" aria-pressed="true" title="${esc(tr('toggle-hint'))}">${esc(tr('toggle'))}</button>
                <button type="button" class="eq-close" aria-label="${esc(tr('close'))}">×</button>
            </div>
            <div class="eq-list"></div>
            <div class="eq-card hidden"></div>`;
        ui.appendChild(this.panel);
        this.listView = this.panel.querySelector('.eq-list');
        this.cardView = this.panel.querySelector('.eq-card');
        this.toggle = this.panel.querySelector('.eq-toggle');
        this.toggle.addEventListener('click', () => this.setShown(!this.shown));
        this.panel.querySelector('.eq-close').addEventListener('click', () => this.closePanel());
        // les clics du panneau ne doivent pas atteindre la scène
        this.panel.addEventListener('pointerdown', e => e.stopPropagation());
        this.panel.addEventListener('wheel', e => e.stopPropagation(), { passive: true });

        this.zoom = document.createElement('div');
        this.zoom.className = 'eq-zoom hidden';
        this.zoom.innerHTML = '<img alt="">';
        this.zoom.addEventListener('click', () => this.zoom.classList.add('hidden'));
        ui.appendChild(this.zoom);

        this.button = document.getElementById('equipements') as HTMLButtonElement | null;
        if (this.button) {
            this.button.classList.remove('hidden');
            this.button.addEventListener('click', () => {
                if (this.panel.classList.contains('hidden')) this.openPanel();
                else this.closePanel();
            });
        }
    }

    private buildMarkers() {
        for (const item of this.items) {
            const f = this.familyOf(item);
            const el = document.createElement('button');
            el.type = 'button';
            el.className = `eq-mark${f.pointille ? ' unknown' : ''}`;
            el.style.setProperty('--c', f.couleur);
            el.setAttribute('aria-label', item.titre);
            el.innerHTML = `<span class="eq-tip">${esc(item.titre)}</span><span class="eq-pin">${esc(item.sigle)}</span><span class="eq-stem"></span><span class="eq-dot"></span>`;
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                this.select(item, false);
            });
            el.addEventListener('pointerdown', e => e.stopPropagation());
            this.layer.appendChild(el);
            this.markers.push({ item, el, position: new Vec3(item.position[0], item.position[1], item.position[2]), seen: null, x: 0, y: 0, distance: 0, onScreen: false });
        }
    }

    private renderList() {
        const tr = (key: string) => localize(`artlight.equipements.${key}`);
        const items = this.filtered();
        (this.panel.querySelector('.eq-count') as HTMLElement).textContent = `${items.length}/${this.items.length}`;

        const levels = this.niveaux.length > 1 ? `<div class="tool-seg eq-levels">${
            [{ id: 'all', nom: tr('all'), court: tr('all') }, ...this.niveaux].map(n => `<button type="button" class="tool-seg-btn${this.level === n.id ? ' active' : ''}" data-level="${esc(n.id)}" title="${esc(n.nom)}">${esc(n.court ?? n.nom)}</button>`).join('')
        }</div>` : '';

        const usedFamilies = [...this.familles.values()].filter(f => this.items.some(p => p.famille === f.id));
        const chips = usedFamilies.length > 1 ? `<div class="eq-families">${
            usedFamilies.map(f => `<button type="button" class="eq-chip${f.pointille ? ' unknown' : ''}" data-family="${esc(f.id)}" aria-pressed="${!this.hiddenFamilies.has(f.id)}" style="--c:${esc(f.couleur)}" title="${esc(f.nom)}"><i></i>${esc(f.court ?? f.nom)}</button>`).join('')
        }</div>` : '';

        let rows = '';
        for (const f of usedFamilies) {
            const group = items.filter(p => p.famille === f.id);
            if (!group.length) continue;
            rows += `<div class="eq-group" style="--c:${esc(f.couleur)}">${esc(f.nom)}</div>`;
            rows += group.map((p) => {
                const level = this.data.niveaux?.find(n => n.id === p.niveau);
                return `<button type="button" class="eq-item${f.pointille ? ' unknown' : ''}${this.current === p ? ' current' : ''}" data-id="${esc(p.id)}" style="--c:${esc(f.couleur)}"><span class="eq-sigle">${esc(p.sigle)}</span><span class="eq-item-text">${esc(p.titre)}<small>${esc(level?.nom ?? '')}</small></span></button>`;
            }).join('');
        }
        this.listView.innerHTML = `${levels}${chips}<div class="eq-items">${rows || `<p class="eq-empty">${esc(tr('empty'))}</p>`}</div>`;

        this.listView.querySelectorAll<HTMLButtonElement>('[data-level]').forEach((b) => {
            b.addEventListener('click', () => {
                this.level = b.dataset.level;
                this.renderList();
                this.refreshMap();
                this.dirty = true;
            });
        });
        this.listView.querySelectorAll<HTMLButtonElement>('[data-family]').forEach((b) => {
            b.addEventListener('click', () => {
                const id = b.dataset.family;
                if (this.hiddenFamilies.has(id)) this.hiddenFamilies.delete(id);
                else this.hiddenFamilies.add(id);
                this.renderList();
                this.refreshMap();
                this.dirty = true;
            });
        });
        this.listView.querySelectorAll<HTMLButtonElement>('.eq-item').forEach((b) => {
            b.addEventListener('click', () => {
                const item = this.items.find(p => p.id === b.dataset.id);
                if (item) this.select(item, true);
            });
        });
    }

    private renderCard() {
        const tr = (key: string) => localize(`artlight.equipements.${key}`);
        const p = this.current;
        if (!p) return;
        const f = this.familyOf(p);
        const photos = p.photos ?? [];
        const row = (label: string, value?: string) => (value ? `<div class="eq-row"><b>${esc(label)}</b>${esc(value)}</div>` : '');
        const c = p.coordonnees;
        const coords = c && c.length === 3 && c.every(Number.isFinite) ? `
            <div class="eq-row"><b>${esc(tr('position'))}${Number.isFinite(p.precision) ? ` · ${esc(tr('within'))} ${decimal(p.precision, 1)} m` : ''}${p.approchee ? ` · ${esc(tr('approx'))}` : ''}</b>
                <div class="eq-coords"><span>X ${decimal(c[0], 2)}<br>Y ${decimal(c[1], 2)}<br>Z ${decimal(c[2], 2)}</span><button type="button" class="eq-copy">${esc(tr('copy'))}</button></div>
                ${this.data.repere ? `<small>${esc(this.data.repere)}</small>` : ''}
            </div>` : '';
        const same = this.filtered();
        const i = same.indexOf(p);
        this.cardView.innerHTML = `
            <button type="button" class="eq-back">‹ ${esc(tr('back'))}</button>
            ${photos.length ? `<button type="button" class="eq-photo" title="${esc(tr('enlarge'))}"><img src="${esc(this.photoUrl(photos[0]))}" alt="${esc(p.titre)}"></button>` : ''}
            ${photos.length > 1 ? `<div class="eq-thumbs">${photos.map((ph, k) => `<button type="button" data-photo="${k}" aria-pressed="${k === 0}"><img src="${esc(this.photoUrl(ph))}" alt=""></button>`).join('')}</div>` : ''}
            <div class="eq-title${f.pointille ? ' unknown' : ''}" style="--c:${esc(f.couleur)}"><span class="eq-sigle">${esc(p.sigle)}</span><h3>${esc(p.titre)}</h3></div>
            ${row(tr('place'), p.lieu)}
            ${row(tr('description'), p.description)}
            ${row(tr('brand'), p.marque)}
            ${row(tr('remark'), p.remarque)}
            ${coords}
            <div class="eq-actions">
                ${p.vue ? `<button type="button" class="eq-goto">${esc(tr('goto'))}</button>` : ''}
                <span class="spacer"></span>
                <button type="button" class="eq-prev" aria-label="${esc(tr('previous'))}" ${i < 0 || same.length < 2 ? 'disabled' : ''}>‹</button>
                <button type="button" class="eq-next" aria-label="${esc(tr('next'))}" ${i < 0 || same.length < 2 ? 'disabled' : ''}>›</button>
            </div>`;

        let photoIndex = 0;
        const img = this.cardView.querySelector<HTMLImageElement>('.eq-photo img');
        this.cardView.querySelector('.eq-back').addEventListener('click', () => this.showList());
        this.cardView.querySelector('.eq-photo')?.addEventListener('click', () => {
            const big = this.zoom.querySelector('img');
            big.src = this.photoUrl(photos[photoIndex], true);
            big.alt = p.titre;
            this.zoom.classList.remove('hidden');
        });
        this.cardView.querySelectorAll<HTMLButtonElement>('[data-photo]').forEach((b) => {
            b.addEventListener('click', () => {
                photoIndex = Number(b.dataset.photo);
                img.src = this.photoUrl(photos[photoIndex]);
                this.cardView.querySelectorAll('[data-photo]').forEach(t => t.setAttribute('aria-pressed', String(t === b)));
            });
        });
        this.cardView.querySelector('.eq-copy')?.addEventListener('click', async (e) => {
            const text = `${decimal(c[0], 2)};${decimal(c[1], 2)};${decimal(c[2], 2)}`;
            const b = e.currentTarget as HTMLButtonElement;
            try {
                await navigator.clipboard.writeText(text);
                b.textContent = tr('copied');
            } catch {
                b.textContent = text;
            }
        });
        this.cardView.querySelector('.eq-goto')?.addEventListener('click', () => this.goto(p));
        const step = (d: number) => {
            if (i < 0 || same.length < 2) return;
            this.select(same[(i + d + same.length) % same.length], true);
        };
        this.cardView.querySelector('.eq-prev').addEventListener('click', () => step(-1));
        this.cardView.querySelector('.eq-next').addEventListener('click', () => step(1));
    }

    // ── Actions ──

    private openPanel() {
        this.panel.classList.remove('hidden');
        this.button?.classList.add('active');
        this.button?.setAttribute('aria-expanded', 'true');
    }

    private closePanel() {
        this.panel.classList.add('hidden');
        this.button?.classList.remove('active');
        this.button?.setAttribute('aria-expanded', 'false');
        this.current = null;
        this.showList();
        this.dirty = true;
    }

    private showList() {
        this.current = null;
        this.cardView.classList.add('hidden');
        this.listView.classList.remove('hidden');
        this.renderList();
        this.dirty = true;
        this.global.app.renderNextFrame = true;
    }

    private select(item: Equipement, travel: boolean) {
        this.current = item;
        if (!this.shown) this.setShown(true);
        this.renderCard();
        this.listView.classList.add('hidden');
        this.cardView.classList.remove('hidden');
        this.cardView.scrollTop = 0;
        this.panel.scrollTop = 0;
        this.openPanel();
        if (travel) this.goto(item);
        this.dirty = true;
        this.global.app.renderNextFrame = true;
    }

    private goto(item: Equipement) {
        if (!item.vue || !valid3(item.vue.position) || !valid3(item.vue.cible)) return;
        this.global.events.fire('equipement:goto', new Vec3(item.vue.position), new Vec3(item.vue.cible));
    }

    private setShown(value: boolean) {
        this.shown = value;
        store(this.storageKey, value);
        this.refreshShown();
    }

    private refreshShown() {
        const visible = this.shown && !this.global.state.xrMode;
        this.layer.classList.toggle('hidden', !visible);
        this.toggle.setAttribute('aria-pressed', String(this.shown));
        this.button?.classList.toggle('layer-off', !this.shown);
        this.refreshMap();
        this.dirty = true;
        this.global.app.renderNextFrame = true;
    }

    private refreshMap() {
        if (!this.miniMap) return;
        const pins: EquipementPin[] = this.shown ? this.filtered().map((p) => {
            const f = this.familyOf(p);
            return {
                position: p.position,
                exterior: p.niveau === 'ext',
                glyph: p.sigle,
                title: p.titre,
                color: f.couleur,
                dashed: !!f.pointille,
                act: () => this.select(p, true)
            };
        }) : [];
        this.miniMap.setEquipementPins(pins);
    }

    // ── Image ──

    private watchCamera() {
        if (!this.shown || !this.markers.length) return;
        const m = this.global.camera.getWorldTransform().data;
        let moved = false;
        for (let i = 0; i < 16; i++) {
            if (m[i] !== this.lastCamera[i]) {
                moved = true;
                this.lastCamera[i] = m[i];
            }
        }
        const now = performance.now();
        if (moved) {
            this.lastMove = now;
            this.dirty = true;
            this.settle = 0;
        } else if (this.settle < SETTLE_MS.length && now - this.lastMove > SETTLE_MS[this.settle]) {
            this.settle++;
            this.dirty = true;
        }
        if (this.dirty && !this.testing && (now - this.lastMove > IDLE_MS || now - this.lastTest > MOVING_MS)) {
            this.testOcclusion();
        }
    }

    // Une passe du picker pour tous les repères visibles à l'écran : la
    // surface vue à l'endroit du repère est-elle nettement plus proche ?
    private async testOcclusion() {
        this.testing = true;
        this.dirty = false;
        this.lastTest = performance.now();
        try {
            this.project();
            const canvas = this.global.app.graphicsDevice.canvas as HTMLCanvasElement;
            const w = canvas.clientWidth || 1;
            const h = canvas.clientHeight || 1;
            const eye = this.global.camera.getPosition().clone();
            const candidates = this.markers.filter(m => m.onScreen && m.distance <= MAX_DISTANCE && this.passes(m.item));
            // les lectures se suivent dans la file du picker : une seule passe
            const hits = await Promise.all(candidates.map(m => this.picker.pickCoarse(m.x / w, m.y / h)));
            candidates.forEach((m, i) => {
                const margin = Math.max(OCCLUSION_MIN, OCCLUSION_REL * m.distance);
                m.seen = !hits[i] || eye.distance(hits[i]) > m.distance - margin;
            });
        } catch (err) {
            console.warn('Équipements : test d\'occultation impossible', err);
            for (const m of this.markers) m.seen = true;
        } finally {
            this.testing = false;
            this.global.app.renderNextFrame = true;
            this.update();
        }
    }

    private passes(item: Equipement) {
        return !this.hiddenFamilies.has(item.famille) && (this.level === 'all' || item.niveau === this.level || item === this.current);
    }

    // Position écran et distance de chaque repère.
    private project() {
        const camera = this.global.camera;
        const view = camera.camera.viewMatrix;
        const canvas = this.global.app.graphicsDevice.canvas as HTMLCanvasElement;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        const eye = camera.getPosition();
        const v = new Vec3();
        const s = new Vec3();
        for (const m of this.markers) {
            view.transformPoint(m.position, v);
            m.distance = eye.distance(m.position);
            if (v.z >= -0.05) {
                m.onScreen = false;
                continue;
            }
            camera.camera.worldToScreen(m.position, s);
            m.x = s.x;
            m.y = s.y;
            m.onScreen = s.x > -40 && s.x < w + 40 && s.y > -10 && s.y < h + 60;
        }
    }

    private update() {
        if (!this.shown || !this.markers.length) return;
        this.project();
        for (const m of this.markers) {
            const selected = m.item === this.current;
            const show = m.onScreen && this.passes(m.item) &&
                (selected || (m.distance <= MAX_DISTANCE && m.seen === true));
            m.el.classList.toggle('hidden', !show);
            if (!show) continue;
            const far = m.distance > FAR_DISTANCE && !selected;
            // le bas du repère (son point) reste sur l'objet, réduit ou non
            m.el.style.transform = `translate(${m.x.toFixed(1)}px, ${m.y.toFixed(1)}px) translate(-50%, -100%)${far ? ' scale(0.85)' : ''}`;
            m.el.classList.toggle('far', far);
            m.el.classList.toggle('current', selected);
            // l'équipement choisi reste montré à travers un mur, estompé
            m.el.classList.toggle('behind', selected && m.seen === false);
        }
    }
}

export { Equipements };
