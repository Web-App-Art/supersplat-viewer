// ARTLIGHT (TKT-268, lot 2)
//
// Mini-carte de la scène : vue de dessus du niveau où se trouve le visiteur,
// avec un point et un cône de vue qui suivent la caméra. Un clic l'agrandit :
// niveau entier, sélecteur de niveau et choix du fond (Photo / Mixte / Murs).
//
// Les cartes sont préparées une fois pour toutes par scripts/scene-map.mjs
// (lot 1) et décrites par le bloc « map » de la scène dans project.json :
//   "map": { "north": 0, "levels": [ { "id", "name", "floor",
//            "bounds": [E0, N0, E1, N1], "photo": "./map/<id>.webp",
//            "walls": "./map/<id>-murs.png" } ] }
// Chemins relatifs au project.json. bounds en (E, N) du repère source : un
// point moteur (x, y, z) se place en (−x, z) sur la carte, le nord en haut.
// Le zéro utilisateur (TKT-226) ne change rien. Une scène sans bloc « map »
// n'affiche rien.
//
// Lot 3 : un clic dans la vue agrandie y emmène le visiteur (événement
// « map:goto », transition de camera-manager.ts), à sol du niveau affiché
// + 1,60 m, direction conservée ; un clic dans un mur (carte des murs) est
// refusé. On y zoome et on s'y déplace à la molette, au glisser et au pincer.
//
// Lot 4 : repères. Annotations (settings.json, même numéro que dans la scène),
// vue de départ (cameras[0]), portails (project.json) et noms de pièces
// (« rooms » d'un niveau, saisis à la préparation). Un repère se place sur le
// niveau dont le sol est le plus haut sous lui. Dans la vue agrandie, un clic
// agit comme dans la scène : annotation ouverte, retour à la vue de départ,
// portail suivi ; un nom de pièce y emmène. Les repères trop proches à l'écran
// sont regroupés (un clic sur le groupe zoome dessus), les noms de pièces qui
// se chevauchent sont masqués. Sur la mini-carte compacte, simples points,
// masqués sur téléphone. Bouton « Repères » pour les masquer.

import { Vec3 } from 'playcanvas';

import { volumeSignedDistance } from './interior'; // ARTLIGHT (TKT-272)
import { localize } from './localization';
import type { Portals } from './portals';
import { resolveScene } from './project';
import type { Portal, ProjectContext, SceneMap, SceneMapLevel, VolumePrism } from './project';
import { isToolActive } from './tool-utils';
import type { Global } from './types';

type Background = 'photo' | 'mixed' | 'walls';

// Le niveau suivi est le plus haut sol sous l'œil du visiteur, à 0,8 m près ;
// l'hystérésis évite de basculer sans cesse sur un palier d'escalier.
const EYE_ABOVE_FLOOR = 0.8;
const LEVEL_HYSTERESIS = 0.3;

// Largeur de terrain montrée par la mini-carte, centrée sur le visiteur.
const COMPACT_SPAN_INDOOR = 16;
const COMPACT_SPAN_AERIAL = 40;

const BACKGROUND_KEY = 'artlight.map.background';
const MARKS_KEY = 'artlight.map.marks';

// Navigation par la carte (lot 3).
const EYE_HEIGHT = 1.6;
// Case de la carte des murs comptée comme mur : toutes les tranches de
// sol + 0,3 à sol + 2,0 occupées (alpha 255, cf. writeWalls de scene-map.mjs).
const WALL_ALPHA = 250;
// Un clic trop près d'un mur est reporté, sans traverser de mur, sur la case
// la plus proche dégagée de CLEARANCE, cherchée jusqu'à SNAP_RADIUS.
const CLEARANCE = 0.2;
const SNAP_RADIUS = 0.4;
// Un clic à moins de HIT_PX (px CSS) d'une case de mur est un clic dans le
// mur : les murs pleins n'ont souvent qu'une ou deux cases d'épaisseur.
const HIT_PX = 3;
// Au-delà de ce déplacement (px CSS), le geste est un glisser, pas un clic.
const CLICK_SLOP = 6;
// Zoom maximal de la vue agrandie (m par px CSS).
const MIN_MPP = 0.008;
const MARK_DURATION = 900;

// Repères (lot 4). Un repère posé jusqu'à PIN_BELOW_FLOOR sous un sol (hotspot
// posé sur la dalle) compte encore pour ce niveau.
const PIN_BELOW_FLOOR = 0.3;
// Rayon dessiné et rayon de la cible de clic (px CSS) ; au doigt, cible de
// 44 px au moins.
const PIN_RADIUS = 10;
const PIN_HIT_MOUSE = 14;
const PIN_HIT_TOUCH = 22;
// Deux repères à moins de cet écart (px CSS) sont regroupés, sauf au zoom maximal.
const CLUSTER_PX = 24;
// Zoom appliqué au clic sur un groupe.
const CLUSTER_ZOOM = 3;

type PinKind = 'portal' | 'annotation' | 'view';

type Pin = {
    kind: PinKind,
    e: number,
    n: number,
    level: number,
    // dessiné dans le disque (numéro, glyphe), puis texte au survol
    glyph: string,
    title: string,
    // vue de départ : cap de la caméra, dessiné en flèche
    heading?: number,
    act: () => void
};

// Cible de clic de la dernière image de la vue agrandie.
// close : sur téléphone, la vue agrandie se referme pour laisser voir la scène.
type Target = { x: number, y: number, r?: number, w?: number, h?: number, title: string, act: () => void, close?: boolean };

type WallData = { alpha: Uint8Array, width: number, height: number };
type Mark = { e: number, n: number, ok: boolean, level: number, time: number };

const COLORS = {
    dark: '#18181b',
    paper: '#ecebe8',
    accent: '#84cc16',
    visitor: '#facc15',
    refused: '#ef4444',
    text: '#fafafa'
};

// Couleur du disque par sorte de repère ; le visiteur reste en jaune.
const PIN_COLORS: Record<PinKind, string> = {
    portal: COLORS.accent,
    annotation: '#e5e5e5',
    view: '#0ea5e9'
};

const ROOM_FONT = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

const readBackground = (): Background => {
    try {
        const value = localStorage.getItem(BACKGROUND_KEY);
        return value === 'photo' || value === 'walls' ? value : 'mixed';
    } catch {
        return 'mixed';
    }
};

const readMarks = () => {
    try {
        return localStorage.getItem(MARKS_KEY) !== 'off';
    } catch {
        return true;
    }
};

const storeMarks = (value: boolean) => {
    try {
        localStorage.setItem(MARKS_KEY, value ? 'on' : 'off');
    } catch {
        // stockage indisponible : le choix vaut pour la session
    }
};

const storeBackground = (value: Background) => {
    try {
        localStorage.setItem(BACKGROUND_KEY, value);
    } catch {
        // stockage indisponible (navigation privée) : le choix vaut pour la session
    }
};

// Un niveau inutilisable est écarté sans bloquer les autres.
const isValidLevel = (level: SceneMapLevel) => {
    const b = level?.bounds;
    return typeof level?.id === 'string' &&
        typeof level.photo === 'string' &&
        Number.isFinite(level.floor) &&
        Array.isArray(b) && b.length === 4 && b.every(Number.isFinite) &&
        b[2] > b[0] && b[3] > b[1];
};

// Bloc « map » de la scène active, chemins résolus ; null sans carte.
const readSceneMap = (): { map: SceneMap, levels: SceneMapLevel[], volume: VolumePrism[] | null } | null => {
    const context = (window as any).sse?.project as ProjectContext | undefined;
    if (!context?.project?.scenes) {
        return null;
    }
    const scene = resolveScene(context.project, context.sceneId);
    const map = scene?.map;
    if (!map || !Array.isArray(map.levels)) {
        return null;
    }
    const base = new URL(context.projectParam, location.href);
    const levels = map.levels.filter((level) => {
        if (isValidLevel(level)) return true;
        console.warn('Carte : niveau ignoré, bloc incomplet', level);
        return false;
    }).map(level => ({
        ...level,
        photo: new URL(level.photo, base).href,
        walls: level.walls ? new URL(level.walls, base).href : undefined,
        rooms: (Array.isArray(level.rooms) ? level.rooms : []).filter((room) => {
            if (typeof room?.name === 'string' && room.name && Array.isArray(room.at) && room.at.length === 2 && room.at.every(Number.isFinite)) return true;
            console.warn('Carte : nom de pièce ignoré', room);
            return false;
        })
    })).sort((a, b) => a.floor - b.floor);

    // ARTLIGHT (TKT-272) : volume du bâtiment, s'il a un modèle intérieur
    // et des niveaux marqués comme tels.
    const volume = scene.interior?.volume && levels.some(level => level.interior) ? scene.interior.volume : null;

    return levels.length ? { map, levels, volume } : null;
};

// Vue d'une carte : centre (E, N) et mètres par pixel CSS.
type View = { e: number, n: number, mpp: number };

class MiniMap {
    private global: Global;

    private map: SceneMap;

    private levels: SceneMapLevel[];

    private images = new Map<string, HTMLImageElement | null>();

    private background: Background;

    private root: HTMLDivElement;

    private compact: HTMLButtonElement;

    private compactCanvas: HTMLCanvasElement;

    private panel: HTMLDivElement;

    private panelCanvas: HTMLCanvasElement;

    private levelList: HTMLDivElement;

    private backgroundRow: HTMLDivElement;

    private expanded = false;

    // Niveau choisi dans la vue agrandie ; null = celui du visiteur.
    private pinnedLevel: number | null = null;

    private visitorLevel = -1;

    // ARTLIGHT (TKT-272) : volume du bâtiment, null sans modèle intérieur.
    private volume: VolumePrism[] | null;

    // Côté du volume pour lequel visitorLevel a été choisi.
    private visitorInside = false;

    private dirty = true;

    private pose = { e: NaN, n: NaN, h: NaN, heading: NaN, fov: NaN };

    private narrow: MediaQueryList;

    // Vue agrandie : zoom et déplacement choisis à la main ; null = niveau
    // entier. Remise à zéro quand le niveau affiché change.
    private panelView: View | null = null;

    private panelViewLevel = -1;

    // Dernière vue dessinée dans la vue agrandie, pour ramener un clic en (E, N).
    private drawnView: View | null = null;

    private pointers = new Map<number, { x: number, y: number }>();

    private gesture: { view: View, x: number, y: number, dist: number, moved: boolean } | null = null;

    private wallData = new Map<string, WallData | null>();

    private marks: Mark[] = [];

    // Repères (lot 4)
    private pins: Pin[] = [];

    private showPins: boolean;

    private marksButton: HTMLButtonElement;

    private coarse: MediaQueryList;

    private targets: Target[] = [];

    private hover: Target | null = null;

    /**
     * Mini-carte de la scène active, ou null si elle n'a pas de bloc « map ».
     *
     * @param {Global} global - Le contexte applicatif.
     * @param {Portals | null} portals - Les portails de la scène, pour les suivre depuis la carte.
     * @returns {MiniMap | null} La mini-carte, ou null.
     */
    static create(global: Global, portals: Portals | null = null) {
        const found = readSceneMap();
        return found ? new MiniMap(global, found.map, found.levels, found.volume, portals) : null;
    }

    private constructor(global: Global, map: SceneMap, levels: SceneMapLevel[], volume: VolumePrism[] | null, portals: Portals | null) {
        this.global = global;
        this.map = map;
        this.levels = levels;
        this.volume = volume;
        this.background = readBackground();
        this.showPins = readMarks();
        this.narrow = window.matchMedia('(max-width: 720px)');
        this.coarse = window.matchMedia('(pointer: coarse)');
        this.pins = this.collectPins(portals);

        this.buildDom();

        this.narrow.addEventListener('change', () => {
            this.dirty = true;
        });
        new ResizeObserver(() => {
            this.dirty = true;
        }).observe(this.root);

        global.app.on('update', () => this.update());
        global.events.on('showAnnotations:changed', () => {
            this.dirty = true;
        });
    }

    // ── Repères (lot 4) ──

    // Niveau d'un repère : le plus haut sol sous lui, sans hystérésis, parmi
    // les niveaux de son côté du volume (TKT-272).
    private pinLevel(p: ArrayLike<number>) {
        const inside = this.volume ? volumeSignedDistance(this.volume, p[0], p[1], p[2]) < 0 : false;
        return this.pickLevel(p[1] + PIN_BELOW_FLOOR, inside);
    }

    private collectPins(portals: Portals | null) {
        const { settings, events } = this.global;
        const pins: Pin[] = [];
        const at = (p: ArrayLike<number>) => ({ e: -p[0], n: p[2], level: this.pinLevel(p) });
        const valid = (p: unknown): p is number[] => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

        // Portails : suivis comme un clic sur le hotspot.
        for (const portal of portals?.portals ?? [] as Portal[]) {
            if (!valid(portal.position)) continue;
            pins.push({
                kind: 'portal',
                ...at(portal.position),
                glyph: portal.glyph ?? '→',
                title: portal.label ?? portal.to,
                act: () => portals.travel(portal)
            });
        }

        // Annotations : même numéro que le hotspot ; le clic l'ouvre et amène
        // la caméra sur son point de vue (annotation.navigate, comme « suivant »).
        (settings.annotations ?? []).forEach((annotation, i) => {
            if (!valid(annotation?.position)) return;
            pins.push({
                kind: 'annotation',
                ...at(annotation.position),
                glyph: String(i + 1),
                title: annotation.title || String(i + 1),
                act: () => events.fire('annotation.navigate', annotation)
            });
        });

        // Vue de départ (seul point de vue enregistré des settings.json) : le
        // clic fait comme le bouton « réinitialiser la vue ».
        const start = settings.cameras?.[0]?.initial;
        if (valid(start?.position) && valid(start?.target)) {
            const [x, , z] = start.position;
            const [tx, , tz] = start.target;
            pins.push({
                kind: 'view',
                ...at(start.position),
                glyph: '',
                title: localize('artlight.map.start-view'),
                heading: Math.atan2(-(tx - x), tz - z),
                act: () => events.fire('inputEvent', 'reset')
            });
        }
        return pins;
    }

    private hasPins() {
        return this.pins.length > 0 || this.levels.some(level => level.rooms?.length);
    }

    // Repères du niveau à dessiner (annotations masquées avec celles de la scène).
    private levelPins(index: number) {
        if (!this.showPins) return [];
        const annotations = this.global.state.showAnnotations;
        return this.pins.filter(pin => pin.level === index && (pin.kind !== 'annotation' || annotations));
    }

    private hasWalls(level: SceneMapLevel) {
        return !!level.walls;
    }

    private get displayedLevel() {
        return this.expanded && this.pinnedLevel !== null ? this.pinnedLevel : Math.max(0, this.visitorLevel);
    }

    // ── DOM ──

    private buildDom() {
        const tr = (key: string) => localize(`artlight.map.${key}`);

        this.root = document.createElement('div');
        this.root.id = 'minimap';

        this.compact = document.createElement('button');
        this.compact.className = 'minimap-compact';
        this.compact.title = tr('expand');
        this.compact.setAttribute('aria-label', tr('expand'));
        this.compactCanvas = document.createElement('canvas');
        this.compact.appendChild(this.compactCanvas);
        this.compact.addEventListener('click', () => this.setExpanded(true));

        this.panel = document.createElement('div');
        this.panel.className = 'minimap-panel hidden';

        const header = document.createElement('div');
        header.className = 'minimap-header';
        const title = document.createElement('span');
        title.className = 'minimap-title';
        title.textContent = tr('title');
        const close = document.createElement('button');
        close.className = 'minimap-close';
        close.title = tr('close');
        close.setAttribute('aria-label', tr('close'));
        close.textContent = '×';
        close.addEventListener('click', () => this.setExpanded(false));
        const actions = document.createElement('div');
        actions.className = 'minimap-actions';
        this.marksButton = document.createElement('button');
        this.marksButton.className = 'minimap-marks';
        this.marksButton.textContent = tr('marks');
        this.marksButton.title = tr('marks-hint');
        this.marksButton.setAttribute('aria-pressed', String(this.showPins));
        this.marksButton.classList.toggle('hidden', !this.hasPins());
        this.marksButton.addEventListener('click', () => {
            this.showPins = !this.showPins;
            storeMarks(this.showPins);
            this.marksButton.setAttribute('aria-pressed', String(this.showPins));
            this.dirty = true;
        });
        actions.append(this.marksButton, close);
        header.append(title, actions);

        this.levelList = document.createElement('div');
        this.levelList.className = 'minimap-levels';
        // Du plus haut au plus bas, comme les boutons d'un ascenseur.
        for (let i = this.levels.length - 1; i >= 0; i--) {
            const level = this.levels[i];
            const button = document.createElement('button');
            button.className = 'minimap-level';
            button.dataset.index = String(i);
            button.title = `${localize('artlight.map.floor')} ${level.floor >= 0 ? '+' : '−'}${Math.abs(level.floor).toFixed(2).replace('.', ',')} m`;
            const dot = document.createElement('span');
            dot.className = 'minimap-here';
            dot.title = tr('here');
            const name = document.createElement('span');
            name.textContent = level.name ?? level.id;
            button.append(dot, name);
            button.addEventListener('click', () => {
                this.pinnedLevel = i === this.visitorLevel ? null : i;
                this.dirty = true;
            });
            this.levelList.appendChild(button);
        }
        this.levelList.classList.toggle('hidden', this.levels.length < 2);

        this.backgroundRow = document.createElement('div');
        this.backgroundRow.className = 'minimap-backgrounds';
        for (const value of ['photo', 'mixed', 'walls'] as Background[]) {
            const button = document.createElement('button');
            button.className = 'minimap-bg';
            button.dataset.value = value;
            button.textContent = tr(`background-${value}`);
            button.addEventListener('click', () => {
                this.background = value;
                storeBackground(value);
                this.dirty = true;
            });
            this.backgroundRow.appendChild(button);
        }

        const canvasWrap = document.createElement('div');
        canvasWrap.className = 'minimap-canvas';
        this.panelCanvas = document.createElement('canvas');
        this.panelCanvas.title = tr('goto-hint');
        canvasWrap.appendChild(this.panelCanvas);
        this.bindGestures();

        this.panel.append(header, this.levelList, this.backgroundRow, canvasWrap);
        this.root.append(this.compact, this.panel);
        // Molette : jamais transmise à la caméra (cf. ui.ts) ni à la page.
        this.root.addEventListener('wheel', event => event.preventDefault(), { passive: false });

        document.querySelector('#ui').appendChild(this.root);
        document.body.classList.add('has-minimap');
    }

    private setExpanded(value: boolean) {
        this.expanded = value;
        this.pinnedLevel = null;
        this.panelView = null;
        this.pointers.clear();
        this.gesture = null;
        this.hover = null;
        this.compact.classList.toggle('hidden', value);
        this.panel.classList.toggle('hidden', !value);
        this.dirty = true;
    }

    private refreshControls(level: SceneMapLevel) {
        for (const button of Array.from(this.levelList.children) as HTMLElement[]) {
            const index = Number(button.dataset.index);
            button.classList.toggle('active', index === this.displayedLevel);
            button.classList.toggle('visitor', index === this.visitorLevel);
        }
        const walls = this.hasWalls(level);
        this.backgroundRow.classList.toggle('hidden', !walls);
        for (const button of Array.from(this.backgroundRow.children) as HTMLElement[]) {
            button.classList.toggle('active', button.dataset.value === this.background);
        }
    }

    // ── Gestes de la vue agrandie (lot 3) ──

    private bindGestures() {
        const canvas = this.panelCanvas;
        const local = (event: PointerEvent | WheelEvent) => {
            const rect = canvas.getBoundingClientRect();
            return { x: event.clientX - rect.left, y: event.clientY - rect.top };
        };
        // Point de départ du geste : un doigt (glisser) ou le milieu de deux (pincer).
        const startGesture = (moved: boolean) => {
            const points = Array.from(this.pointers.values());
            const view = this.drawnView;
            if (!view || !points.length) {
                this.gesture = null;
                return;
            }
            const x = points.reduce((s, p) => s + p.x, 0) / points.length;
            const y = points.reduce((s, p) => s + p.y, 0) / points.length;
            const dist = points.length > 1 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0;
            this.gesture = { view: { ...view }, x, y, dist, moved };
        };

        canvas.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || this.pointers.size >= 2) return;
            canvas.setPointerCapture(event.pointerId);
            this.pointers.set(event.pointerId, local(event));
            // un second doigt transforme le geste en pincer, jamais en clic
            startGesture(this.pointers.size > 1);
        });

        canvas.addEventListener('pointermove', (event) => {
            // survol à la souris : nom du repère et curseur main
            if (!this.pointers.size && event.pointerType === 'mouse') {
                const { x, y } = local(event);
                this.setHover(this.hitTest(x, y));
                return;
            }
            if (!this.pointers.has(event.pointerId) || !this.gesture) return;
            this.pointers.set(event.pointerId, local(event));
            const g = this.gesture;
            const points = Array.from(this.pointers.values());
            const x = points.reduce((s, p) => s + p.x, 0) / points.length;
            const y = points.reduce((s, p) => s + p.y, 0) / points.length;
            if (!g.moved && Math.hypot(x - g.x, y - g.y) < CLICK_SLOP) return;
            g.moved = true;
            canvas.classList.add('dragging');

            let mpp = g.view.mpp;
            if (points.length > 1 && g.dist > 0) {
                const dist = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
                mpp = this.clampMpp(g.view.mpp * g.dist / Math.max(1, dist));
            }
            // le point de la carte sous le geste au départ reste sous le geste
            const w = canvas.clientWidth;
            const h = canvas.clientHeight;
            const e = g.view.e + (g.x - w / 2) * g.view.mpp;
            const n = g.view.n - (g.y - h / 2) * g.view.mpp;
            this.setPanelView({ e: e - (x - w / 2) * mpp, n: n + (y - h / 2) * mpp, mpp });
        });

        const end = (event: PointerEvent, cancelled: boolean) => {
            if (!this.pointers.has(event.pointerId)) return;
            const click = !cancelled && this.pointers.size === 1 && this.gesture && !this.gesture.moved;
            const at = local(event);
            this.pointers.delete(event.pointerId);
            canvas.classList.remove('dragging');
            if (click) {
                this.gesture = null;
                this.clickAt(at.x, at.y);
            } else {
                // reste un doigt après un pincer : il continue à glisser
                startGesture(true);
            }
        };
        canvas.addEventListener('pointerleave', () => this.setHover(null));
        canvas.addEventListener('pointerup', event => end(event, false));
        canvas.addEventListener('pointercancel', event => end(event, true));

        canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            const view = this.drawnView;
            if (!view) return;
            const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
            // pincer du pavé tactile (ctrlKey) : petits deltas, réponse plus vive
            const k = event.ctrlKey ? 0.01 : 0.0015;
            const mpp = this.clampMpp(view.mpp * Math.exp(event.deltaY * scale * k));
            const { x, y } = local(event);
            const w = canvas.clientWidth;
            const h = canvas.clientHeight;
            const e = view.e + (x - w / 2) * view.mpp;
            const n = view.n - (y - h / 2) * view.mpp;
            this.setPanelView({ e: e - (x - w / 2) * mpp, n: n + (y - h / 2) * mpp, mpp });
        }, { passive: false });
    }

    // Vue du niveau entier dans la vue agrandie : zoom arrière maximal.
    private wholeView(level: SceneMapLevel, w: number, h: number): View {
        const [e0, n0, e1, n1] = level.bounds;
        const mpp = Math.max((e1 - e0) / w, (n1 - n0) / h) * 1.04;
        return { e: (e0 + e1) / 2, n: (n0 + n1) / 2, mpp };
    }

    private clampMpp(mpp: number) {
        const level = this.levels[this.displayedLevel];
        const max = this.wholeView(level, this.panelCanvas.clientWidth || 1, this.panelCanvas.clientHeight || 1).mpp;
        return Math.min(max, Math.max(Math.min(MIN_MPP, max), mpp));
    }

    // Le centre reste dans l'emprise du niveau.
    private setPanelView(view: View) {
        const [e0, n0, e1, n1] = this.levels[this.displayedLevel].bounds;
        this.panelView = {
            e: Math.min(e1, Math.max(e0, view.e)),
            n: Math.min(n1, Math.max(n0, view.n)),
            mpp: view.mpp
        };
        this.hover = null;
        this.dirty = true;
    }

    // ── Clic dans la vue agrandie : s'y rendre (lot 3) ──

    private clickAt(x: number, y: number) {
        const view = this.drawnView;
        if (!view) return;
        // un repère sous le clic agit à la place du déplacement (lot 4)
        const target = this.hitTest(x, y);
        if (target) {
            this.setHover(null);
            target.act();
            if (target.close && this.narrow.matches) {
                this.setExpanded(false);
            }
            return;
        }
        const w = this.panelCanvas.clientWidth;
        const h = this.panelCanvas.clientHeight;
        const e = view.e + (x - w / 2) * view.mpp;
        const n = view.n - (y - h / 2) * view.mpp;
        this.gotoPoint(e, n, HIT_PX * view.mpp);
    }

    // Cible sous (x, y), la dernière dessinée (au-dessus) d'abord.
    private hitTest(x: number, y: number) {
        const reach = this.coarse.matches ? PIN_HIT_TOUCH : PIN_HIT_MOUSE;
        for (let i = this.targets.length - 1; i >= 0; i--) {
            const t = this.targets[i];
            const inside = t.r !== undefined ?
                Math.hypot(x - t.x, y - t.y) <= Math.max(t.r, reach) :
                Math.abs(x - t.x) <= t.w / 2 + 4 && Math.abs(y - t.y) <= Math.max(t.h, this.coarse.matches ? 44 : 0) / 2 + 2;
            if (inside) return t;
        }
        return null;
    }

    private setHover(target: Target | null) {
        if (target?.title === this.hover?.title && target?.x === this.hover?.x && target?.y === this.hover?.y) return;
        this.hover = target;
        this.panelCanvas.style.cursor = target ? 'pointer' : '';
        this.dirty = true;
    }

    // Déplacement vers (E, N) du niveau affiché, refusé dans un mur (lot 3).
    private gotoPoint(e: number, n: number, hit: number) {
        const index = this.displayedLevel;
        const level = this.levels[index];

        // Pas de carte des murs (vue d'avion), ou pas encore chargée : aucun refus.
        const walls = this.walls(level.walls);
        const spot = walls ? this.freeSpot(walls, level, e, n, hit) : { e, n };
        const time = performance.now();
        this.marks = this.marks.filter(m => time - m.time < MARK_DURATION);
        if (!spot) {
            this.marks.push({ e, n, ok: false, level: index, time });
            this.dirty = true;
            return;
        }
        this.marks.push({ e: spot.e, n: spot.n, ok: true, level: index, time });
        this.dirty = true;
        // (E, N) → moteur (−E, y, N)
        // Vue d'avion : hauteur prise sur le terrain sous le point (lot 4).
        this.global.events.fire('map:goto', new Vec3(-spot.e, level.floor + EYE_HEIGHT, spot.n), level.walls ? undefined : EYE_HEIGHT);
        // Sur téléphone, la vue agrandie couvre la scène : on la referme.
        if (this.narrow.matches) {
            this.setExpanded(false);
        }
    }

    // Alpha de la carte des murs, lu une fois l'image chargée.
    private walls(url: string | undefined): WallData | null {
        if (!url) return null;
        if (this.wallData.has(url)) return this.wallData.get(url);
        const img = this.image(url);
        if (!img) return null;
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const alpha = new Uint8Array(canvas.width * canvas.height);
        for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
        const data = { alpha, width: canvas.width, height: canvas.height };
        this.wallData.set(url, data);
        return data;
    }

    // Point libre où poser le visiteur, ou null si le clic tombe dans un mur.
    private freeSpot(walls: WallData, level: SceneMapLevel, e: number, n: number, hit: number) {
        const [e0, n0, e1, n1] = level.bounds;
        const { alpha, width, height } = walls;
        const cell = (e1 - e0) / width;
        const isWall = (cx: number, cy: number) => (
            cx >= 0 && cy >= 0 && cx < width && cy < height && alpha[cy * width + cx] >= WALL_ALPHA
        );
        const cx = Math.floor((e - e0) / cell);
        const cy = Math.floor((n1 - n) / ((n1 - n0) / height));
        const free = (x: number, y: number, r: number) => {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (dx * dx + dy * dy <= r * r && isWall(x + dx, y + dy)) return false;
                }
            }
            return true;
        };
        if (!free(cx, cy, Math.round(hit / cell))) return null;

        const r = Math.ceil(CLEARANCE / cell);
        const clear = (x: number, y: number) => free(x, y, r);
        if (clear(cx, cy)) return { e, n };

        // sans traverser de mur entre le clic et la case retenue
        const reachable = (x: number, y: number) => {
            const steps = Math.max(Math.abs(x - cx), Math.abs(y - cy));
            for (let s = 1; s <= steps; s++) {
                if (isWall(Math.round(cx + (x - cx) * s / steps), Math.round(cy + (y - cy) * s / steps))) return false;
            }
            return true;
        };
        const R = Math.ceil(SNAP_RADIUS / cell);
        let best: { x: number, y: number, d: number } | null = null;
        for (let dy = -R; dy <= R; dy++) {
            for (let dx = -R; dx <= R; dx++) {
                const d = dx * dx + dy * dy;
                if (d > R * R || (best && d >= best.d)) continue;
                if (clear(cx + dx, cy + dy) && reachable(cx + dx, cy + dy)) {
                    best = { x: cx + dx, y: cy + dy, d };
                }
            }
        }
        // Passage plus étroit que 2 × CLEARANCE : on garde le clic tel quel.
        if (!best) return { e, n };
        return { e: e0 + (best.x + 0.5) * cell, n: n1 - (best.y + 0.5) * cell };
    }

    // ── Suivi de la caméra ──

    // ARTLIGHT (TKT-272) : avec un modèle intérieur, seuls les niveaux du côté
    // `inside` du volume comptent (tous s'il n'y en a aucun de ce côté).
    private pickLevel(height: number, inside = false) {
        const side = (i: number) => !this.volume || !!this.levels[i].interior === inside;
        const pool = this.levels.some((_, i) => side(i)) ? side : () => true;
        let index = -1;
        for (let i = 0; i < this.levels.length; i++) {
            if (pool(i) && (index < 0 || this.levels[i].floor <= height)) index = i;
        }
        return Math.max(0, index);
    }

    private followLevel(y: number) {
        const h = y - EYE_ABOVE_FLOOR;
        const inside = this.global.state.insideBuilding;
        if (this.visitorLevel < 0 || inside !== this.visitorInside) {
            this.visitorInside = inside;
            this.visitorLevel = this.pickLevel(h, inside);
            return;
        }
        const up = this.pickLevel(h - LEVEL_HYSTERESIS, inside);
        const down = this.pickLevel(h + LEVEL_HYSTERESIS, inside);
        if (up > this.visitorLevel) {
            this.visitorLevel = up;
        } else if (down < this.visitorLevel) {
            this.visitorLevel = down;
        }
    }

    private update() {
        const { app, camera, state } = this.global;

        const hidden = app.xr?.active || (this.narrow.matches && isToolActive(state));
        this.root.classList.toggle('hidden', hidden);
        if (hidden) {
            return;
        }

        // Pose de la caméra rendue, ramenée sur la carte : (x, y, z) → (−x, z).
        const p = camera.getPosition();
        const forward = camera.forward;
        // Caméra tournée vers le sol : l'avant de la carte est le haut de l'image.
        const dir = Math.hypot(forward.x, forward.z) > 0.2 ? forward : camera.up;
        const heading = Math.atan2(-dir.x, dir.z);
        const cam = camera.camera;
        const device = app.graphicsDevice;
        const aspect = device.width / Math.max(1, device.height);
        const fov = cam.horizontalFov ? cam.fov : 2 * Math.atan(Math.tan(cam.fov * Math.PI / 360) * aspect) * 180 / Math.PI;

        const pose = this.pose;
        if (Math.abs(pose.e + p.x) > 0.01 || Math.abs(pose.n - p.z) > 0.01 || Math.abs(pose.h - p.y) > 0.01 ||
            Math.abs(pose.heading - heading) > 0.005 || Math.abs(pose.fov - fov) > 0.2 || Number.isNaN(pose.e)) {
            pose.e = -p.x;
            pose.n = p.z;
            pose.h = p.y;
            pose.heading = heading;
            pose.fov = fov;
            const before = this.visitorLevel;
            this.followLevel(p.y);
            if (before !== this.visitorLevel && this.pinnedLevel === this.visitorLevel) {
                this.pinnedLevel = null;
            }
            this.dirty = true;
        }

        // repères de clic en cours d'effacement
        if (this.marks.length) {
            const now = performance.now();
            this.marks = this.marks.filter(m => now - m.time < MARK_DURATION);
            this.dirty = true;
        }

        if (this.dirty) {
            this.dirty = false;
            this.render();
        }
    }

    // ── Images, chargées à la demande ──

    private image(url: string | undefined) {
        if (!url) return null;
        if (this.images.has(url)) return this.images.get(url);
        this.images.set(url, null);
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => {
            this.images.set(url, img);
            this.dirty = true;
        };
        img.onerror = () => console.warn('Carte : image introuvable', url);
        img.src = url;
        return null;
    }

    // ── Dessin ──

    private render() {
        const index = this.displayedLevel;
        const level = this.levels[index];
        this.refreshControls(level);

        if (this.expanded) {
            if (index !== this.panelViewLevel) {
                this.panelViewLevel = index;
                this.panelView = null;
                this.hover = null;
            }
            // carte des murs chargée d'avance pour contrôler les clics, quel que soit le fond
            this.walls(level.walls);
            this.draw(this.panelCanvas, level, index === this.visitorLevel, true);
        } else {
            this.draw(this.compactCanvas, level, true, false);
        }
    }

    private fitCanvas(canvas: HTMLCanvasElement) {
        const ratio = window.devicePixelRatio || 1;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
            canvas.width = Math.round(w * ratio);
            canvas.height = Math.round(h * ratio);
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        return { ctx, w, h };
    }

    // Mini-carte : centrée sur le visiteur, sans sortir du niveau quand il
    // est plus grand que la fenêtre. Vue agrandie : niveau entier.
    private viewFor(level: SceneMapLevel, w: number, h: number, whole: boolean): View {
        const [e0, n0, e1, n1] = level.bounds;
        if (whole) {
            const full = this.wholeView(level, w, h);
            // zoom gardé, borné si la fenêtre a changé de taille
            return this.panelView ? { ...this.panelView, mpp: Math.min(full.mpp, this.panelView.mpp) } : full;
        }
        const span = Math.min(this.hasWalls(level) ? COMPACT_SPAN_INDOOR : COMPACT_SPAN_AERIAL, Math.max(e1 - e0, n1 - n0));
        const mpp = span / Math.min(w, h);
        const clamp = (v: number, lo: number, hi: number, half: number) => (
            hi - lo <= 2 * half ? (lo + hi) / 2 : Math.min(hi - half, Math.max(lo + half, v))
        );
        return {
            e: clamp(this.pose.e, e0, e1, w * mpp / 2),
            n: clamp(this.pose.n, n0, n1, h * mpp / 2),
            mpp
        };
    }

    private draw(canvas: HTMLCanvasElement, level: SceneMapLevel, showVisitor: boolean, whole: boolean) {
        const { ctx, w, h } = this.fitCanvas(canvas);
        if (!w || !h) return;

        const view = this.viewFor(level, w, h, whole);
        if (whole) this.drawnView = view;
        const toX = (e: number) => w / 2 + (e - view.e) / view.mpp;
        const toY = (n: number) => h / 2 - (n - view.n) / view.mpp;

        const background: Background = this.hasWalls(level) ? this.background : 'photo';
        ctx.fillStyle = background === 'walls' ? COLORS.paper : COLORS.dark;
        ctx.fillRect(0, 0, w, h);

        const [e0, n0, e1, n1] = level.bounds;
        const x = toX(e0);
        const y = toY(n1);
        const dw = (e1 - e0) / view.mpp;
        const dh = (n1 - n0) / view.mpp;
        ctx.imageSmoothingEnabled = true;
        if (background !== 'walls') {
            const photo = this.image(level.photo);
            if (photo) ctx.drawImage(photo, x, y, dw, dh);
        }
        if (background !== 'photo') {
            const walls = this.image(level.walls);
            if (walls) {
                ctx.globalAlpha = background === 'mixed' ? 0.85 : 1;
                ctx.drawImage(walls, x, y, dw, dh);
                ctx.globalAlpha = 1;
            }
        }

        const index = this.levels.indexOf(level);
        if (whole) {
            this.targets = [];
            this.drawPins(ctx, level, index, view, toX, toY, w, h);
        } else if (!this.narrow.matches) {
            this.drawDots(ctx, index, toX, toY);
        }

        if (showVisitor) {
            this.drawVisitor(ctx, toX(this.pose.e), toY(this.pose.n), w, h, whole ? 44 : 30);
        }
        if (whole) {
            for (const mark of this.marks) {
                if (mark.level === index) this.drawMark(ctx, toX(mark.e), toY(mark.n), mark);
            }
            if (this.hover) this.drawTooltip(ctx, this.hover, w);
        }
        if (Number.isFinite(this.map.north)) {
            this.drawNorth(ctx, w - 16, 18, this.map.north);
        }
        if (whole) {
            this.drawScale(ctx, view.mpp, h, background === 'walls');
        } else if (this.levels.length > 1) {
            this.drawLabel(ctx, level.name ?? level.id, w, h);
        }
    }

    // ── Repères (lot 4) ──

    // Mini-carte compacte : simples points, sans nom ni regroupement.
    private drawDots(ctx: CanvasRenderingContext2D, index: number, toX: (e: number) => number, toY: (n: number) => number) {
        for (const pin of this.levelPins(index)) {
            ctx.beginPath();
            ctx.arc(toX(pin.e), toY(pin.n), 3, 0, Math.PI * 2);
            ctx.fillStyle = PIN_COLORS[pin.kind];
            ctx.fill();
            ctx.lineWidth = 1;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.stroke();
        }
    }

    // Vue agrandie : noms de pièces, puis repères regroupés quand ils se
    // chevauchent ; chaque élément dessiné devient une cible de clic.
    private drawPins(ctx: CanvasRenderingContext2D, level: SceneMapLevel, index: number, view: View,
        toX: (e: number) => number, toY: (n: number) => number, w: number, h: number) {
        const pins = this.levelPins(index)
        .map(pin => ({ pin, x: toX(pin.e), y: toY(pin.n) }))
        .filter(p => p.x > -PIN_RADIUS && p.y > -PIN_RADIUS && p.x < w + PIN_RADIUS && p.y < h + PIN_RADIUS);

        // Regroupement : on fusionne la paire la plus proche tant que deux
        // groupes sont à moins de CLUSTER_PX. Au zoom maximal, plus de groupe
        // (repères confondus dessinés l'un sur l'autre, le dernier cliquable).
        const groups = pins.map(p => ({ x: p.x, y: p.y, items: [p] }));
        if (view.mpp > MIN_MPP * 1.01) {
            for (;;) {
                let best: [number, number] | null = null;
                let bestDist = CLUSTER_PX;
                for (let i = 0; i < groups.length; i++) {
                    for (let j = i + 1; j < groups.length; j++) {
                        const d = Math.hypot(groups[i].x - groups[j].x, groups[i].y - groups[j].y);
                        if (d < bestDist) {
                            bestDist = d;
                            best = [i, j];
                        }
                    }
                }
                if (!best) break;
                const [a, b] = [groups[best[0]], groups[best[1]]];
                a.items.push(...b.items);
                a.x = a.items.reduce((sum, q) => sum + q.x, 0) / a.items.length;
                a.y = a.items.reduce((sum, q) => sum + q.y, 0) / a.items.length;
                groups.splice(best[1], 1);
            }
        }

        // Noms de pièces : masqués s'ils chevauchent un repère ou un autre nom.
        const boxes = groups.map(g => ({ x0: g.x - PIN_RADIUS - 2, y0: g.y - PIN_RADIUS - 2, x1: g.x + PIN_RADIUS + 2, y1: g.y + PIN_RADIUS + 2 }));
        if (this.showPins) {
            ctx.font = ROOM_FONT;
            for (const room of level.rooms ?? []) {
                const x = toX(room.at[0]);
                const y = toY(room.at[1]);
                const tw = ctx.measureText(room.name).width + 12;
                const box = { x0: x - tw / 2, y0: y - 10, x1: x + tw / 2, y1: y + 10 };
                if (box.x1 < 0 || box.y1 < 0 || box.x0 > w || box.y0 > h) continue;
                if (boxes.some(b => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
                boxes.push(box);
                this.drawRoom(ctx, room.name, x, y, tw);
                const [e, n] = room.at;
                this.targets.push({ x, y, w: tw, h: 20, title: room.name, act: () => this.gotoPoint(e, n, 0) });
            }
        }

        for (const group of groups) {
            if (group.items.length === 1) {
                const { pin, x, y } = group.items[0];
                this.drawPin(ctx, pin, x, y);
                this.targets.push({ x, y, r: PIN_RADIUS + 2, title: pin.title, act: pin.act, close: true });
            } else {
                this.drawCluster(ctx, group.x, group.y, group.items.length);
                const items = group.items.map(p => p.pin);
                const title = `${items.length} ${localize('artlight.map.marks-group')}`;
                this.targets.push({
                    x: group.x,
                    y: group.y,
                    r: PIN_RADIUS + 4,
                    title,
                    act: () => this.zoomOn(items, view)
                });
            }
        }
    }

    // Clic sur un groupe : zoom ×3 centré sur ses repères.
    private zoomOn(items: Pin[], view: View) {
        const e = items.reduce((s, p) => s + p.e, 0) / items.length;
        const n = items.reduce((s, p) => s + p.n, 0) / items.length;
        this.setPanelView({ e, n, mpp: this.clampMpp(view.mpp / CLUSTER_ZOOM) });
    }

    // Même dessin sur les trois fonds : disque plein, liseré blanc et ombre.
    private drawPin(ctx: CanvasRenderingContext2D, pin: Pin, x: number, y: number) {
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.arc(x, y, PIN_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = PIN_COLORS[pin.kind];
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.lineWidth = 2;
        ctx.strokeStyle = pin.kind === 'annotation' ? COLORS.dark : '#fff';
        ctx.stroke();
        if (pin.kind === 'view') {
            // flèche du cap de la vue de départ
            ctx.translate(x, y);
            ctx.rotate(pin.heading);
            ctx.fillStyle = '#fff';
            ctx.beginPath();
            ctx.moveTo(0, -6);
            ctx.lineTo(5, 4);
            ctx.lineTo(0, 1.5);
            ctx.lineTo(-5, 4);
            ctx.closePath();
            ctx.fill();
        } else {
            ctx.fillStyle = COLORS.dark;
            ctx.font = `bold ${pin.glyph.length > 1 ? 10 : 12}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(pin.glyph, x, y + 0.5);
        }
        ctx.restore();
    }

    private drawCluster(ctx: CanvasRenderingContext2D, x: number, y: number, count: number) {
        ctx.save();
        ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.arc(x, y, PIN_RADIUS + 3, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(24, 24, 27, 0.9)';
        ctx.fill();
        ctx.shadowColor = 'transparent';
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        ctx.fillStyle = COLORS.text;
        ctx.font = 'bold 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(count), x, y + 0.5);
        ctx.restore();
    }

    private drawRoom(ctx: CanvasRenderingContext2D, name: string, x: number, y: number, tw: number) {
        ctx.fillStyle = 'rgba(24, 24, 27, 0.72)';
        ctx.beginPath();
        ctx.roundRect(x - tw / 2, y - 10, tw, 20, 10);
        ctx.fill();
        ctx.fillStyle = COLORS.text;
        ctx.font = ROOM_FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(name, x, y + 0.5);
    }

    // Nom du repère survolé à la souris.
    private drawTooltip(ctx: CanvasRenderingContext2D, target: Target, w: number) {
        if (target.r === undefined) return;
        ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const tw = Math.min(ctx.measureText(target.title).width + 12, w - 8);
        const x = Math.min(w - tw - 4, Math.max(4, target.x - tw / 2));
        const above = target.y - target.r - 28 >= 0;
        const y = above ? target.y - target.r - 28 : target.y + target.r + 6;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.beginPath();
        ctx.roundRect(x, y, tw, 22, 6);
        ctx.fill();
        ctx.fillStyle = COLORS.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(target.title, x + 6, y + 11.5, tw - 12);
    }

    private drawVisitor(ctx: CanvasRenderingContext2D, px: number, py: number, w: number, h: number, radius: number) {
        // Hors du cadre (caméra en orbite loin du bâtiment) : le point reste
        // au bord, évidé, dans la bonne direction.
        const margin = 7;
        const inside = px >= margin && px <= w - margin && py >= margin && py <= h - margin;
        const x = Math.min(w - margin, Math.max(margin, px));
        const y = Math.min(h - margin, Math.max(margin, py));

        if (inside) {
            const half = Math.min(this.pose.fov, 170) * Math.PI / 360;
            // Cap mesuré depuis le nord, dans le sens horaire ; à l'écran le
            // nord est vers le haut (−y).
            const a = this.pose.heading - Math.PI / 2;
            const cone = ctx.createRadialGradient(x, y, 0, x, y, radius);
            cone.addColorStop(0, 'rgba(250, 204, 21, 0.85)');
            cone.addColorStop(1, 'rgba(250, 204, 21, 0.2)');
            ctx.fillStyle = cone;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.arc(x, y, radius, a - half, a + half);
            ctx.closePath();
            ctx.fill();
            // bords du champ, lisibles sur un parquet clair comme sur le noir
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = inside ? '#fff' : COLORS.visitor;
        ctx.fillStyle = inside ? COLORS.visitor : 'rgba(0, 0, 0, 0.4)';
        ctx.fill();
        ctx.stroke();
    }

    // Repère d'un clic : anneau vert qui s'élargit (accepté), croix rouge
    // et « Mur » (refusé). Il s'efface en MARK_DURATION.
    private drawMark(ctx: CanvasRenderingContext2D, x: number, y: number, mark: Mark) {
        const t = Math.min(1, (performance.now() - mark.time) / MARK_DURATION);
        ctx.save();
        ctx.globalAlpha = 1 - t * t;
        ctx.lineWidth = 2.5;
        if (mark.ok) {
            ctx.strokeStyle = COLORS.accent;
            ctx.beginPath();
            ctx.arc(x, y, 6 + 14 * t, 0, Math.PI * 2);
            ctx.stroke();
        } else {
            const s = 7;
            ctx.strokeStyle = COLORS.refused;
            ctx.beginPath();
            ctx.moveTo(x - s, y - s);
            ctx.lineTo(x + s, y + s);
            ctx.moveTo(x + s, y - s);
            ctx.lineTo(x - s, y + s);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x, y, 12, 0, Math.PI * 2);
            ctx.stroke();
            const text = localize('artlight.map.in-wall');
            ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
            const tw = ctx.measureText(text).width;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(x + 16, y - 10, tw + 10, 20);
            ctx.fillStyle = COLORS.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, x + 21, y);
        }
        ctx.restore();
    }

    private drawNorth(ctx: CanvasRenderingContext2D, x: number, y: number, north: number) {
        ctx.save();
        ctx.translate(x, y);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.beginPath();
        ctx.arc(0, 0, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.rotate(north * Math.PI / 180);
        ctx.fillStyle = COLORS.text;
        ctx.beginPath();
        ctx.moveTo(0, -9);
        ctx.lineTo(4, -2);
        ctx.lineTo(-4, -2);
        ctx.closePath();
        ctx.fill();
        ctx.font = 'bold 9px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('N', 0, 4);
        ctx.restore();
    }

    private drawLabel(ctx: CanvasRenderingContext2D, text: string, w: number, h: number) {
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        const tw = Math.min(ctx.measureText(text).width, w - 16);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(4, h - 20, tw + 10, 16);
        ctx.fillStyle = COLORS.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, 9, h - 12, w - 16);
    }

    // Échelle graphique de 1, 2 ou 5 × 10^k m, autour de 80 px.
    private drawScale(ctx: CanvasRenderingContext2D, mpp: number, h: number, light: boolean) {
        const target = 80 * mpp;
        const pow = 10 ** Math.floor(Math.log10(target));
        const length = [5, 2, 1].map(f => f * pow).find(v => v <= target) ?? pow;
        const px = length / mpp;
        const x = 12;
        const y = h - 14;
        ctx.strokeStyle = light ? '#27272a' : COLORS.text;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y - 5);
        ctx.lineTo(x, y);
        ctx.lineTo(x + px, y);
        ctx.lineTo(x + px, y - 5);
        ctx.stroke();
        ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${length} m`, x + px + 8, y + 4);
    }
}

export { MiniMap };
