import { createCollapseButton, createNote, readStoredText, storeText, translator } from './tool-panel';
import type { Global } from './types';

// ARTLIGHT (TKT-249) : dossier de coupes. L'outil Coupe y garde des coupes
// figées (résultat calculé, réglages, vignette de la vue 3D) pour en faire
// ensuite un rapport. Le dossier vit en mémoire tant que la page est
// ouverte ; s'il n'est pas vide, le navigateur demande confirmation avant
// de quitter la page.
//
// Ce module ne connaît pas le contenu d'une coupe (type T) : l'outil fournit
// son nom automatique, sa description et l'action « rouvrir ».

const tr = translator('artlight.section.folder');

const COLLAPSED_STORAGE_KEY = 'artlight.section.folder-collapsed';

// Vignette : largeur en pixels, hauteur selon l'écran.
const THUMB_WIDTH = 640;
const THUMB_QUALITY = 0.85;

interface FolderItem<T> {
    id: number;
    name: string | null;        // nom donné par l'utilisateur ; null : nom automatique
    data: T;
    thumbnail: Blob | null;     // vignette JPEG de la vue 3D
    thumbnailUrl: string | null;
    capture: Promise<void> | null;  // vignette en cours de capture
}

interface FolderOptions<T> {
    autoName: (item: FolderItem<T>) => string;
    describe: (item: FolderItem<T>) => string;
    onOpen: (item: FolderItem<T>) => void;
    // Rapport PDF du dossier (TKT-249, lot 2).
    onReport: () => void;
    // Liste changée (nom, ordre, suppression) : l'outil redessine la vue et
    // l'en-tête de la coupe ouverte.
    onChange: () => void;
}

const ICONS = {
    rename: '<path d="M10.5 3.5l2 2L6 12H4v-2z"/>',
    up: '<path d="M8 13V3M4 7l4-4 4 4"/>',
    down: '<path d="M8 3v10M4 9l4 4 4-4"/>',
    delete: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'
};

const iconButton = (icon: keyof typeof ICONS, label: string, onClick: () => void, disabled = false): HTMLButtonElement => {
    const button = document.createElement('button');
    button.className = 'tool-icon-btn';
    button.title = label;
    button.disabled = disabled;
    button.setAttribute('aria-label', label);
    button.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon]}</svg>`;
    button.addEventListener('click', onClick);
    return button;
};

// Vignette JPEG de la vue 3D telle qu'on la voit (masquage et tranche
// compris, sans les tracés de l'outil, dessinés par-dessus le canvas).
const captureView = async (global: Global): Promise<Blob | null> => {
    if (!window.captureFrame) return null;
    const { width, height } = global.app.graphicsDevice.clientRect;
    if (width <= 0 || height <= 0) return null;
    const frame = await window.captureFrame({ width: THUMB_WIDTH, height: Math.round(THUMB_WIDTH * height / width), supersample: 2 });
    const binary = atob(frame.data);
    const pixels = new Uint8ClampedArray(binary.length);
    for (let i = 0; i < binary.length; i++) pixels[i] = binary.charCodeAt(i);
    // Opaque : un fond transparent sortirait noir ou blanc selon le lecteur.
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    const canvas = document.createElement('canvas');
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext('2d').putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
    return new Promise((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', THUMB_QUALITY);
    });
};

class SectionFolder<T> {
    items: FolderItem<T>[] = [];

    private options: FolderOptions<T>;

    private nextId = 1;

    // Coupe ouverte dans le panneau, surlignée dans la liste.
    private openId: number | null = null;

    // Dernière coupe supprimée, que l'on peut remettre.
    private removed: { item: FolderItem<T>; index: number } | null = null;

    private renaming: number | null = null;

    private renameDraft: string | null = null;

    // Replié par défaut sur un téléphone, où il cacherait la vue.
    private collapsed = readStoredText(COLLAPSED_STORAGE_KEY, window.innerWidth <= 720 ? '1' : '0', v => v === '0' || v === '1') === '1';

    private parent: HTMLElement | null = null;

    private panel: HTMLDivElement | null = null;

    constructor(options: FolderOptions<T>) {
        this.options = options;
        window.addEventListener('beforeunload', this.beforeUnload);
    }

    // Dossier non vide : le navigateur demande confirmation avant de quitter
    // la page (rechargement, fermeture, bascule Splats / Nuage de points).
    private beforeUnload = (event: BeforeUnloadEvent) => {
        if (this.items.length === 0) return;
        event.preventDefault();
        event.returnValue = '';
    };

    get(id: number | null): FolderItem<T> | null {
        return this.items.find(item => item.id === id) ?? null;
    }

    // Noms affichés : le nom donné, sinon le nom automatique ; un nom déjà
    // pris plus haut dans la liste reçoit « (2) », « (3) »…
    names(): Map<number, string> {
        const names = new Map<number, string>();
        const seen = new Map<string, number>();
        for (const item of this.items) {
            const base = item.name ?? this.options.autoName(item);
            const n = (seen.get(base) ?? 0) + 1;
            seen.set(base, n);
            names.set(item.id, n > 1 ? `${base} (${n})` : base);
        }
        return names;
    }

    nameOf(item: FolderItem<T>): string {
        return this.names().get(item.id) ?? item.name ?? this.options.autoName(item);
    }

    add(data: T): FolderItem<T> {
        const item: FolderItem<T> = { id: this.nextId++, name: null, data, thumbnail: null, thumbnailUrl: null, capture: null };
        this.items.push(item);
        this.dropRemoved();
        this.render();
        return item;
    }

    update(item: FolderItem<T>, data: T) {
        item.data = data;
        this.render();
    }

    setThumbnail(item: FolderItem<T>, blob: Blob) {
        if (item.thumbnailUrl) URL.revokeObjectURL(item.thumbnailUrl);
        item.thumbnail = blob;
        item.thumbnailUrl = URL.createObjectURL(blob);
        this.render();
    }

    // Vignette prise maintenant, rangée quand elle est prête.
    captureThumbnail(global: Global, item: FolderItem<T>) {
        const capture = captureView(global).then((blob) => {
            if (blob) this.setThumbnail(item, blob);
        }).catch(() => {
            // pas de vignette : la liste garde sa case vide
        }).finally(() => {
            if (item.capture === capture) item.capture = null;
        });
        item.capture = capture;
    }

    // Vignettes en cours de capture (rapport PDF juste après « Garder ») :
    // attendues `timeout` ms au plus.
    thumbnailsReady(timeout: number): Promise<unknown> {
        const pending = this.items.map(item => item.capture).filter(Boolean);
        if (pending.length === 0) return Promise.resolve();
        return Promise.race([Promise.all(pending), new Promise((resolve) => {
            setTimeout(resolve, timeout);
        })]);
    }

    setOpen(id: number | null) {
        if (id === this.openId) return;
        this.openId = id;
        this.render();
    }

    mount(parent: HTMLElement) {
        this.parent = parent;
        this.render();
    }

    unmount() {
        this.renaming = null;
        this.panel?.remove();
        this.panel = null;
        this.parent = null;
    }

    private changed() {
        this.render();
        this.options.onChange();
    }

    private remove(item: FolderItem<T>) {
        const index = this.items.indexOf(item);
        if (index < 0) return;
        this.dropRemoved();
        this.items.splice(index, 1);
        this.removed = { item, index };
        if (this.renaming === item.id) this.renaming = null;
        this.changed();
    }

    private undoRemove() {
        const removed = this.removed;
        if (!removed) return;
        this.removed = null;
        this.items.splice(Math.min(removed.index, this.items.length), 0, removed.item);
        this.changed();
    }

    // La suppression n'est plus annulable : la vignette est libérée.
    private dropRemoved() {
        const url = this.removed?.item.thumbnailUrl;
        if (url) URL.revokeObjectURL(url);
        this.removed = null;
    }

    private move(item: FolderItem<T>, delta: number) {
        const index = this.items.indexOf(item);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= this.items.length) return;
        this.items.splice(index, 1);
        this.items.splice(target, 0, item);
        this.dropRemoved();
        this.changed();
    }

    // Nom vide : retour au nom automatique.
    private rename(item: FolderItem<T>, text: string) {
        this.renaming = null;
        const name = text.trim();
        item.name = name && name !== this.options.autoName(item) ? name : null;
        this.changed();
    }

    render() {
        const list = this.panel?.querySelector('.section-folder-list');
        const scroll = list?.scrollTop ?? 0;
        this.panel?.remove();
        this.panel = null;
        if (!this.parent || (this.items.length === 0 && !this.removed)) return;

        const panel = document.createElement('div');
        panel.id = 'sectionFolder';
        panel.className = 'tool-panel section-folder';
        panel.classList.toggle('collapsed', this.collapsed);

        const header = document.createElement('div');
        header.className = 'tool-header';
        const title = document.createElement('div');
        title.className = 'tool-title';
        title.textContent = tr('title');
        const count = document.createElement('span');
        count.className = 'section-folder-count';
        count.textContent = String(this.items.length);
        title.appendChild(count);
        const actions = document.createElement('div');
        actions.className = 'tool-header-actions';
        actions.appendChild(createCollapseButton(this.collapsed, (collapsed) => {
            this.collapsed = collapsed;
            storeText(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
            panel.classList.toggle('collapsed', collapsed);
        }));
        header.append(title, actions);
        panel.appendChild(header);

        const body = document.createElement('div');
        body.className = 'tool-body';
        const ol = document.createElement('ol');
        ol.className = 'section-folder-list';
        const names = this.names();
        this.items.forEach((item, index) => ol.appendChild(this.createItem(item, names.get(item.id), index)));
        body.appendChild(ol);

        if (this.removed) {
            const undo = document.createElement('div');
            undo.className = 'section-folder-undo';
            const text = document.createElement('span');
            text.textContent = tr('deleted', { name: this.removed.item.name ?? this.options.autoName(this.removed.item) });
            const button = document.createElement('button');
            button.className = 'tool-btn';
            button.textContent = tr('undo');
            button.addEventListener('click', () => this.undoRemove());
            undo.append(text, button);
            body.appendChild(undo);
        }
        if (this.items.length > 0) {
            const report = document.createElement('button');
            report.className = 'tool-btn primary section-folder-report';
            report.textContent = tr('report');
            report.title = tr('report-title');
            report.addEventListener('click', () => this.options.onReport());
            body.appendChild(report);
        }
        body.appendChild(createNote(tr('note')));
        panel.appendChild(body);

        this.parent.appendChild(panel);
        this.panel = panel;
        ol.scrollTop = scroll;

        const input = panel.querySelector<HTMLInputElement>('.section-folder-input');
        if (input) {
            input.focus();
            input.select();
        }
    }

    private createItem(item: FolderItem<T>, name: string, index: number): HTMLLIElement {
        const li = document.createElement('li');
        li.className = 'section-folder-item';
        li.classList.toggle('open', item.id === this.openId);

        const thumb = document.createElement(item.thumbnailUrl ? 'img' : 'span') as HTMLImageElement;
        thumb.className = 'section-folder-thumb';
        if (item.thumbnailUrl) {
            thumb.src = item.thumbnailUrl;
            thumb.alt = '';
        }
        const text = document.createElement('span');
        text.className = 'section-folder-text';
        const sub = document.createElement('span');
        sub.className = 'section-folder-sub';
        sub.textContent = this.options.describe(item);

        if (this.renaming === item.id) {
            // Entrée ou sortie du champ : valider ; Échap : annuler. Les
            // touches ne remontent pas aux raccourcis du visualisateur. La
            // saisie survit à un rafraîchissement de la liste (vignette
            // arrivée entre-temps).
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'section-folder-input';
            input.value = this.renameDraft ?? name;
            input.spellcheck = false;
            input.setAttribute('aria-label', tr('rename-label'));
            let done = false;
            const finish = (commit: boolean) => {
                if (done) return;
                done = true;
                this.renameDraft = null;
                if (commit) {
                    this.rename(item, input.value);
                } else {
                    this.renaming = null;
                    this.render();
                }
            };
            input.addEventListener('input', () => {
                this.renameDraft = input.value;
            });
            input.addEventListener('keydown', (event) => {
                event.stopPropagation();
                if (event.key === 'Enter') finish(true);
                else if (event.key === 'Escape') finish(false);
            });
            // Champ retiré par un rafraîchissement : ce n'est pas une sortie.
            input.addEventListener('blur', () => {
                if (input.isConnected) finish(true);
            });
            text.append(input, sub);
            const row = document.createElement('div');
            row.className = 'section-folder-open';
            row.append(thumb, text);
            li.appendChild(row);
        } else {
            const label = document.createElement('span');
            label.className = 'section-folder-name';
            label.textContent = name;
            text.append(label, sub);
            const open = document.createElement('button');
            open.className = 'section-folder-open';
            open.title = tr('open-title', { name });
            open.append(thumb, text);
            open.addEventListener('click', () => this.options.onOpen(item));
            li.appendChild(open);
        }

        const actions = document.createElement('div');
        actions.className = 'section-folder-actions';
        actions.append(
            iconButton('rename', tr('rename'), () => {
                this.renaming = item.id;
                this.renameDraft = null;
                this.render();
            }),
            iconButton('up', tr('up'), () => this.move(item, -1), index === 0),
            iconButton('down', tr('down'), () => this.move(item, 1), index === this.items.length - 1),
            iconButton('delete', tr('delete'), () => this.remove(item))
        );
        li.appendChild(actions);
        return li;
    }
}

export { SectionFolder, captureView };
export type { FolderItem };
