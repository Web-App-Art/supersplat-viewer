import { getLocale, localize } from './localization';

// ARTLIGHT (TKT-238) : textes, formats et composants des panneaux d'outils
// (planéité, coupe). Styles .tool-* dans index.scss.

// Texte d'un outil : clés `${prefix}.${key}` des fichiers de langue ; {nom}
// est remplacé par params.nom.
export const translator = (prefix: string) => (key: string, params: Record<string, string | number> = {}) => {
    let text = localize(`${prefix}.${key}`);
    for (const [name, value] of Object.entries(params)) text = text.split(`{${name}}`).join(String(value));
    return text;
};

const trTool = translator('artlight.tool');

// Nombre dans la langue de l'interface : « 1,5 » en français, « 1.5 » en anglais.
export const formatNumber = (value: number, digits: number) => value.toLocaleString(getLocale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
});

// Nombre entier (compte de points) : « 12 345 » en français, « 12,345 » en anglais.
export const formatCount = (value: number) => value.toLocaleString(getLocale());

// Longueur lisible : mm sous le centimètre, cm sous le mètre.
export const formatLength = (m: number, signed = false) => {
    const a = Math.abs(m);
    let text: string;
    if (a < 0.01) {
        text = `${formatNumber(a * 1000, 1)} mm`;
    } else if (a < 1) {
        text = `${formatNumber(a * 100, 1)} cm`;
    } else {
        text = `${formatNumber(a, 2)} m`;
    }
    let sign = '';
    if (m < 0) sign = '−';
    else if (signed && m > 0) sign = '+';
    return sign + text;
};

// ── Choix mémorisés dans le navigateur ──

export const readStoredNumber = (key: string, fallback: number, isValid: (v: number) => boolean) => {
    try {
        const value = parseFloat(localStorage.getItem(key) ?? '');
        return isValid(value) ? value : fallback;
    } catch {
        return fallback;
    }
};

export const storeNumber = (key: string, value: number) => {
    try {
        localStorage.setItem(key, String(value));
    } catch {
        // stockage indisponible (navigation privée) : le choix vaut pour la session
    }
};

export const readStoredText = (key: string, fallback: string, isValid: (v: string) => boolean) => {
    try {
        const value = localStorage.getItem(key);
        return value !== null && isValid(value) ? value : fallback;
    } catch {
        return fallback;
    }
};

export const storeText = (key: string, value: string) => {
    try {
        localStorage.setItem(key, value);
    } catch {
        // stockage indisponible : le choix vaut pour la session
    }
};

// ── Exports ──

// Nom de la scène pour les exports : nom du projet, sinon dossier de l'URL.
export const sceneName = (): string => {
    const projectName = (window as any).sse?.project?.project?.name;
    if (typeof projectName === 'string' && projectName) return projectName;
    const params = new URLSearchParams(location.search);
    for (const key of ['project', 'settings', 'content']) {
        const value = params.get(key);
        const parts = value?.split('/').filter(part => part && !part.includes('.')) ?? [];
        const folder = parts.filter(part => !/^lod-output/.test(part)).pop();
        if (folder) return folder;
    }
    return 'scene';
};

export const slugify = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
.toLowerCase()
.replace(/[^a-z0-9]+/g, '-')
.replace(/^-|-$/g, '');

// Nom de fichier d'un export : « planeite-callian-2026-09-30_14h05 ».
export const exportBaseName = (label: string): string => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}h${pad(d.getMinutes())}`;
    return `${slugify(label)}-${slugify(sceneName()) || 'scene'}-${stamp}`;
};

export const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// ── Composants ──

export const createRow = (label: string, value: string, kind?: 'hollow' | 'bump'): HTMLDivElement => {
    const row = document.createElement('div');
    row.className = 'tool-row';
    const labelEl = document.createElement('span');
    labelEl.className = 'tool-row-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('span');
    valueEl.className = kind ? `tool-row-value ${kind}` : 'tool-row-value';
    valueEl.textContent = value;
    row.append(labelEl, valueEl);
    return row;
};

export const createNote = (text: string, warning = false): HTMLDivElement => {
    const note = document.createElement('div');
    note.className = warning ? 'tool-note warning' : 'tool-note';
    note.textContent = warning ? `⚠ ${text}` : text;
    return note;
};

// Libellé au-dessus, contrôle en dessous : le contrôle a toute la largeur.
export const createField = (label: string, control: HTMLElement): HTMLDivElement => {
    const field = document.createElement('div');
    field.className = 'tool-field';
    const labelEl = document.createElement('div');
    labelEl.className = 'tool-field-label';
    labelEl.textContent = label;
    field.append(labelEl, control);
    return field;
};

export interface SegmentOption<T> {
    value: T;
    label: string;
    title?: string;
}

// Boutons côte à côte, un seul actif : remplace les listes déroulantes.
export const createSegmented = <T>(options: SegmentOption<T>[], current: T | null, onSelect: (value: T) => void): HTMLDivElement => {
    const group = document.createElement('div');
    group.className = 'tool-seg';
    for (const option of options) {
        const button = document.createElement('button');
        button.className = 'tool-seg-btn';
        button.textContent = option.label;
        if (option.title) button.title = option.title;
        const active = option.value === current;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
        button.addEventListener('click', () => {
            if (option.value !== current) onSelect(option.value);
        });
        group.appendChild(button);
    }
    return group;
};

export interface StepperOptions {
    value: number;
    min: number;
    max: number;
    step: number;
    unit: string;
    label: string;      // nom lu par les lecteurs d'écran
    onChange: (value: number) => void;
}

// Compteur − / valeur / +. Maintenir un bouton répète le pas. La valeur se
// tape au clavier (virgule acceptée) : Entrée valide, Échap annule, ↑ et ↓
// ajoutent ou retirent un pas. Les touches ne remontent pas aux raccourcis
// du visualisateur (Échap effacerait la zone).
export const createStepper = (opts: StepperOptions): HTMLDivElement => {
    let value = opts.value;
    const format = (v: number) => formatNumber(v, Number.isInteger(v) ? 0 : 1);
    const clamp = (v: number) => Math.min(opts.max, Math.max(opts.min, Math.round(v / opts.step) * opts.step));

    const wrapper = document.createElement('div');
    wrapper.className = 'tool-stepper';

    const box = document.createElement('label');
    box.className = 'tool-stepper-value';
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.spellcheck = false;
    input.value = format(value);
    input.setAttribute('aria-label', opts.label);
    const unit = document.createElement('span');
    unit.textContent = opts.unit;
    box.append(input, unit);

    const set = (v: number) => {
        const next = clamp(v);
        input.value = format(next);
        if (next !== value) {
            value = next;
            opts.onChange(value);
        }
    };
    const commit = () => {
        const v = parseFloat(input.value.replace(',', '.'));
        if (Number.isFinite(v)) set(v);
        else input.value = format(value);
    };

    input.addEventListener('focus', () => input.select());
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
            commit();
            input.blur();
        } else if (event.key === 'Escape') {
            input.value = format(value);
            input.blur();
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            set(value + (event.key === 'ArrowUp' ? opts.step : -opts.step));
            input.select();
        }
    });

    const makeButton = (text: string, delta: number, label: string) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tool-stepper-btn';
        button.textContent = text;
        button.setAttribute('aria-label', label);
        let delay: ReturnType<typeof setTimeout> | null = null;
        let repeat: ReturnType<typeof setInterval> | null = null;
        const stop = () => {
            if (delay) clearTimeout(delay);
            if (repeat) clearInterval(repeat);
            delay = null;
            repeat = null;
        };
        button.addEventListener('pointerdown', (event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            set(value + delta);
            stop();
            delay = setTimeout(() => {
                repeat = setInterval(() => set(value + delta), 70);
            }, 400);
        });
        for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
            button.addEventListener(type, stop);
        }
        // Clavier (Entrée, Espace) : un pas par appui
        button.addEventListener('click', (event) => {
            if (event.detail === 0) set(value + delta);
        });
        return button;
    };

    wrapper.append(
        makeButton('−', -opts.step, trTool('stepper.decrease', { label: opts.label })),
        box,
        makeButton('+', opts.step, trTool('stepper.increase', { label: opts.label }))
    );
    return wrapper;
};

export interface RangeOptions {
    min: number;
    max: number;
    step: number;
    value: number;
    format: (value: number) => string;
    onCommit: (value: number) => void;
}

// Curseur stylé : partie gauche remplie, valeur affichée pendant le glissé,
// appliquée au relâchement.
export const createRange = (opts: RangeOptions): HTMLDivElement => {
    const row = document.createElement('div');
    row.className = 'tool-range-row';
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'tool-range';
    input.min = String(opts.min);
    input.max = String(opts.max);
    input.step = String(opts.step);
    input.value = String(opts.value);
    const label = document.createElement('span');
    label.className = 'tool-range-value';
    const update = () => {
        const v = parseFloat(input.value);
        label.textContent = opts.format(v);
        input.style.setProperty('--fill', `${(v - opts.min) / (opts.max - opts.min) * 100}%`);
    };
    update();
    input.addEventListener('input', update);
    input.addEventListener('change', () => opts.onCommit(parseFloat(input.value)));
    row.append(input, label);
    return row;
};

export const createSwitch = (label: string, value: boolean, onChange: (value: boolean) => void): HTMLDivElement => {
    const row = document.createElement('div');
    row.className = 'tool-switch-row';
    const text = document.createElement('span');
    text.textContent = label;
    const toggle = document.createElement('button');
    toggle.className = 'tool-switch';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(value));
    toggle.setAttribute('aria-label', label);
    toggle.addEventListener('click', () => {
        const next = toggle.getAttribute('aria-checked') !== 'true';
        toggle.setAttribute('aria-checked', String(next));
        onChange(next);
    });
    row.append(text, toggle);
    return row;
};

// Bouton réduire / agrandir d'un panneau : réduit, le panneau ne garde que
// son en-tête et son bandeau.
export const createCollapseButton = (collapsed: boolean, onToggle: (collapsed: boolean) => void): HTMLButtonElement => {
    const button = document.createElement('button');
    button.className = 'tool-icon-btn';
    let state = collapsed;
    const update = () => {
        button.title = trTool(state ? 'expand' : 'collapse');
        button.setAttribute('aria-label', button.title);
        button.setAttribute('aria-expanded', String(!state));
        button.innerHTML = state ?
            '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"/></svg>' :
            '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4"/></svg>';
    };
    update();
    button.addEventListener('click', () => {
        state = !state;
        update();
        onToggle(state);
    });
    return button;
};

// Onglets d'un panneau : barre et contenu, l'onglet actif est reconstruit à
// chaque changement.
export const createTabs = <T extends string>(tabs: { id: T; label: string }[], active: T,
    render: (id: T) => HTMLElement, onSelect: (id: T) => void): HTMLDivElement => {
    const wrapper = document.createElement('div');
    const bar = document.createElement('div');
    bar.className = 'tool-tabs';
    bar.setAttribute('role', 'tablist');
    const content = document.createElement('div');
    content.className = 'tool-tab-content';
    content.setAttribute('role', 'tabpanel');

    const buttons: HTMLButtonElement[] = [];
    const show = (id: T) => {
        tabs.forEach((tab, i) => {
            buttons[i].classList.toggle('active', tab.id === id);
            buttons[i].setAttribute('aria-selected', String(tab.id === id));
        });
        content.textContent = '';
        content.appendChild(render(id));
    };

    for (const tab of tabs) {
        const button = document.createElement('button');
        button.className = 'tool-tab';
        button.textContent = tab.label;
        button.setAttribute('role', 'tab');
        button.addEventListener('click', () => {
            onSelect(tab.id);
            show(tab.id);
        });
        bar.appendChild(button);
        buttons.push(button);
    }
    show(active);

    wrapper.append(bar, content);
    return wrapper;
};
