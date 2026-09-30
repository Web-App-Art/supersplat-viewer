import { formatNumber } from './tool-panel';

// ARTLIGHT (TKT-238) : profil 2D d'une coupe. Les points de la tranche sont
// donnés dans le repère du profil : s (m) à l'horizontale, t (m) à la
// verticale. Le dessin (paintProfile) sert au panneau et à l'image PNG ;
// ProfileView y ajoute le zoom, le déplacement, le survol et la mesure.

export interface ProfilePoint {
    s: number;
    t: number;
}

export interface ProfileData {
    points: Float32Array;       // s, t entrelacés
    count: number;
    // Coupe entre deux points : A et B recalés sur le nuage, et la direction
    // de AB dans le profil (unitaire) ; les limites de la coupe passent par
    // A et B, perpendiculaires à AB.
    markers?: { a: ProfilePoint; b: ProfilePoint; dir: ProfilePoint };
    tOffset: number;            // ajouté à t pour les graduations (altitude de la référence)
    sTitle: string;             // titres des axes
    tTitle: string;
    fit: { s0: number; s1: number; t0: number; t1: number };
}

// Fenêtre affichée : centre (m) et échelle horizontale (px CSS par m). La
// verticale est à l'échelle k × exagération. width, height : taille du
// profil (px CSS) pour laquelle elle a été réglée ; fitted : « tout voir »,
// sans zoom ni déplacement depuis.
export interface ProfileWindow {
    cs: number;
    ct: number;
    k: number;
    width?: number;
    height?: number;
    fitted?: boolean;
}

export interface ProfileMeasure {
    p1: ProfilePoint;
    p2: ProfilePoint | null;
}

export interface ProfileTheme {
    background: string;
    grid: string;
    axis: string;
    text: string;
    points: [number, number, number];
    line: string;               // AB et limites de la coupe
    marker: string;             // A et B
    markerText: string;
    measure: string;
    tag: string;                // fond des étiquettes
    font: string;
    scale: number;              // taille des textes et des traits (1 = panneau)
}

export const DARK_THEME: ProfileTheme = {
    background: '#18181b',
    grid: 'rgba(255, 255, 255, 0.07)',
    axis: 'rgba(255, 255, 255, 0.22)',
    text: '#a1a1aa',
    points: [228, 228, 231],
    line: 'rgba(132, 204, 22, 0.75)',
    marker: '#84cc16',
    markerText: '#18181b',
    measure: '#fbbf24',
    tag: 'rgba(0, 0, 0, 0.75)',
    font: '-apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif',
    scale: 1
};

export const LIGHT_THEME: ProfileTheme = {
    background: '#ffffff',
    grid: '#ececef',
    axis: '#a1a1aa',
    text: '#52525b',
    points: [24, 24, 27],
    line: 'rgba(77, 124, 15, 0.8)',
    marker: '#4d7c0f',
    markerText: '#ffffff',
    measure: '#c2410c',
    tag: 'rgba(255, 255, 255, 0.9)',
    font: '-apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif',
    scale: 2
};

// Marges du tracé (px CSS, × theme.scale) : graduations à gauche et en bas.
const PAD_LEFT = 56;
const PAD_BOTTOM = 34;
const PAD_TOP = 10;
const PAD_RIGHT = 12;

// Pas de graduation : le plus petit qui laisse `minPx` entre deux traits.
const NICE_STEPS = [1, 2, 2.5, 5];
const niceStep = (pxPerMeter: number, minPx: number): number => {
    const raw = minPx / pxPerMeter;
    const exp = Math.floor(Math.log10(raw));
    for (let e = exp; e <= exp + 1; e++) {
        for (const m of NICE_STEPS) {
            const step = m * 10 ** e;
            if (step >= raw) return step;
        }
    }
    return 10 ** (exp + 1);
};

// Décimales qui écrivent exactement les multiples du pas : 0,25 → 2.
const stepDecimals = (step: number) => {
    for (let d = 0; d < 8; d++) {
        const v = step * 10 ** d;
        if (Math.abs(Math.round(v) - v) < 1e-6) return d;
    }
    return 8;
};

// Longueur de l'échelle graphique : la plus grande valeur ronde qui tient
// dans `maxPx`.
export const scaleBarLength = (pxPerMeter: number, maxPx: number): number => {
    const nice = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];
    return nice.filter(l => l * pxPerMeter <= maxPx).pop() ?? nice[0];
};

export interface PaintOptions {
    width: number;              // px CSS
    height: number;
    dpr: number;
    window: ProfileWindow;
    exaggeration: number;
    theme: ProfileTheme;
    measure?: ProfileMeasure | null;
    hover?: ProfilePoint | null;
    measureLabel?: (m: ProfileMeasure) => string;
}

// Passage profil → écran (px CSS, origine en haut à gauche du canvas).
export const profileToScreen = (opts: Pick<PaintOptions, 'width' | 'height' | 'window' | 'exaggeration' | 'theme'>) => {
    const { width, height, window: w, exaggeration, theme } = opts;
    const x0 = PAD_LEFT * theme.scale, y1 = height - PAD_BOTTOM * theme.scale;
    const cx = (x0 + width - PAD_RIGHT * theme.scale) / 2, cy = (PAD_TOP * theme.scale + y1) / 2;
    const kt = w.k * exaggeration;
    return {
        x: (s: number) => cx + (s - w.cs) * w.k,
        y: (t: number) => cy - (t - w.ct) * kt,
        s: (x: number) => w.cs + (x - cx) / w.k,
        t: (y: number) => w.ct - (y - cy) / kt,
        plot: { x0, y0: PAD_TOP * theme.scale, x1: width - PAD_RIGHT * theme.scale, y1 }
    };
};

// Fenêtre qui montre la zone [s0, s1] × [t0, t1] en entier.
export const fitWindow = (fit: ProfileData['fit'], width: number, height: number, exaggeration: number, theme: ProfileTheme): ProfileWindow => {
    const plotW = Math.max(10, width - (PAD_LEFT + PAD_RIGHT) * theme.scale);
    const plotH = Math.max(10, height - (PAD_TOP + PAD_BOTTOM) * theme.scale);
    const ds = Math.max(fit.s1 - fit.s0, 0.01), dt = Math.max(fit.t1 - fit.t0, 0.01);
    const k = Math.min(plotW / ds, plotH / (dt * exaggeration));
    return { cs: (fit.s0 + fit.s1) / 2, ct: (fit.t0 + fit.t1) / 2, k };
};

// Point du profil le plus proche de (x, y) écran, à moins de `radius` px.
export const nearestPoint = (data: ProfileData, opts: Pick<PaintOptions, 'width' | 'height' | 'window' | 'exaggeration' | 'theme'>,
    x: number, y: number, radius: number): ProfilePoint | null => {
    const map = profileToScreen(opts);
    let best = radius * radius, found: ProfilePoint | null = null;
    const p = data.points;
    for (let i = 0; i < data.count; i++) {
        const dx = map.x(p[i * 2]) - x, dy = map.y(p[i * 2 + 1]) - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < best) {
            best = d2;
            found = { s: p[i * 2], t: p[i * 2 + 1] };
        }
    }
    return found;
};

// Étiquette sur fond sombre (ou clair), ancrée à (x, y).
const drawTag = (ctx: CanvasRenderingContext2D, text: string, x: number, y: number, theme: ProfileTheme, color: string, align: 'left' | 'right' | 'center' = 'left') => {
    const f = theme.scale;
    ctx.font = `600 ${12 * f}px ${theme.font}`;
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width;
    let left = x;
    if (align === 'right') left = x - w - 10 * f;
    else if (align === 'center') left = x - w / 2 - 5 * f;
    ctx.fillStyle = theme.tag;
    ctx.beginPath();
    ctx.roundRect(left, y - 9 * f, w + 10 * f, 18 * f, 4 * f);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'left';
    ctx.fillText(text, left + 5 * f, y);
};

/**
 * Dessine le profil : fond, graduations, points, limites de la coupe, A et B,
 * mesure et survol.
 *
 * @param {CanvasRenderingContext2D} ctx - Contexte du canvas, sans transformation.
 * @param {ProfileData} data - Points et repères du profil.
 * @param {PaintOptions} opts - Taille, fenêtre, exagération, thème, mesure, survol.
 */
export const paintProfile = (ctx: CanvasRenderingContext2D, data: ProfileData, opts: PaintOptions) => {
    const { width, height, dpr, theme } = opts;
    const f = theme.scale;
    const map = profileToScreen(opts);
    const { plot } = map;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, width, height);

    // Graduations
    const kt = opts.window.k * opts.exaggeration;
    const sStep = niceStep(opts.window.k, 64 * f);
    const tStep = niceStep(kt, 34 * f);
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.grid;
    ctx.font = `${11 * f}px ${theme.font}`;
    ctx.fillStyle = theme.text;
    ctx.beginPath();
    const sFirst = Math.ceil(map.s(plot.x0) / sStep) * sStep;
    for (let s = sFirst; map.x(s) <= plot.x1; s += sStep) {
        const x = Math.round(map.x(s)) + 0.5;
        ctx.moveTo(x, plot.y0);
        ctx.lineTo(x, plot.y1);
    }
    const tFirst = Math.ceil(map.t(plot.y1) / tStep) * tStep;
    for (let t = tFirst; map.y(t) >= plot.y0; t += tStep) {
        const y = Math.round(map.y(t)) + 0.5;
        ctx.moveTo(plot.x0, y);
        ctx.lineTo(plot.x1, y);
    }
    ctx.stroke();

    ctx.strokeStyle = theme.axis;
    ctx.strokeRect(plot.x0 + 0.5, plot.y0 + 0.5, plot.x1 - plot.x0 - 1, plot.y1 - plot.y0 - 1);

    const sDigits = stepDecimals(sStep);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let s = sFirst; map.x(s) <= plot.x1; s += sStep) {
        ctx.fillText(formatNumber(Math.abs(s) < sStep / 1000 ? 0 : s, sDigits), map.x(s), plot.y1 + 4 * f);
    }
    // L'altitude de la référence n'est pas un multiple du pas : on gradue
    // les valeurs affichées (t + tOffset), pas t.
    const tDigits = stepDecimals(tStep);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const labelFirst = Math.ceil((map.t(plot.y1) + data.tOffset) / tStep) * tStep;
    for (let v = labelFirst; map.y(v - data.tOffset) >= plot.y0; v += tStep) {
        const y = map.y(v - data.tOffset);
        if (y > plot.y1) continue;
        ctx.fillText(formatNumber(Math.abs(v) < tStep / 1000 ? 0 : v, tDigits), plot.x0 - 5 * f, y);
    }
    // Titres des axes
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(data.sTitle, plot.x1, height - 2 * f);
    ctx.save();
    ctx.translate(11 * f, plot.y0);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(data.tTitle, 0, 0);
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x0, plot.y0, plot.x1 - plot.x0, plot.y1 - plot.y0);
    ctx.clip();

    const markers = data.markers;
    if (markers) {
        // Limites de la coupe : droites par A et B, perpendiculaires à AB (en
        // mètres ; l'exagération les incline à l'écran).
        const nS = -markers.dir.t, nT = markers.dir.s;
        const reach = 1e4;
        ctx.strokeStyle = theme.line;
        ctx.lineWidth = 1 * f;
        ctx.setLineDash([4 * f, 4 * f]);
        ctx.beginPath();
        for (const p of [markers.a, markers.b]) {
            ctx.moveTo(map.x(p.s - nS * reach), map.y(p.t - nT * reach));
            ctx.lineTo(map.x(p.s + nS * reach), map.y(p.t + nT * reach));
        }
        ctx.stroke();

        // Droite AB, sous les points : elle ne doit pas cacher le sol.
        ctx.lineWidth = 1.5 * f;
        ctx.beginPath();
        ctx.moveTo(map.x(markers.a.s), map.y(markers.a.t));
        ctx.lineTo(map.x(markers.b.s), map.y(markers.b.t));
        ctx.stroke();
        ctx.setLineDash([]);
    }

    // Points : densité par pixel physique, dessinée dans une image. Des
    // centaines de milliers de points ne tiennent pas en fillRect.
    const pw = Math.max(1, Math.round((plot.x1 - plot.x0) * dpr));
    const ph = Math.max(1, Math.round((plot.y1 - plot.y0) * dpr));
    const density = new Uint16Array(pw * ph);
    const pts = data.points;
    // Points d'environ un pixel CSS, plus gros quand ils sont épars à l'écran
    // (zoom fort).
    const size = Math.max(1, Math.min(5, Math.round(dpr * theme.scale * 0.75 + opts.window.k * dpr / 800)));
    const ox = plot.x0 * dpr, oy = plot.y0 * dpr;
    for (let i = 0; i < data.count; i++) {
        const px = Math.floor(map.x(pts[i * 2]) * dpr - ox);
        const py = Math.floor(map.y(pts[i * 2 + 1]) * dpr - oy);
        if (px < 0 || py < 0 || px >= pw || py >= ph) continue;
        const k = py * pw + px;
        if (density[k] < 65535) density[k]++;
    }
    const image = new ImageData(pw, ph);
    const out = image.data;
    const [r, g, b] = theme.points;
    const half = (size - 1) >> 1;
    for (let py = 0; py < ph; py++) {
        for (let px = 0; px < pw; px++) {
            const n = density[py * pw + px];
            if (n === 0) continue;
            const alpha = Math.min(255, 110 + 55 * Math.log2(n));
            for (let dy = -half; dy < size - half; dy++) {
                const qy = py + dy;
                if (qy < 0 || qy >= ph) continue;
                for (let dx = -half; dx < size - half; dx++) {
                    const qx = px + dx;
                    if (qx < 0 || qx >= pw) continue;
                    const q = (qy * pw + qx) * 4;
                    if (out[q + 3] >= alpha) continue;
                    out[q] = r;
                    out[q + 1] = g;
                    out[q + 2] = b;
                    out[q + 3] = alpha;
                }
            }
        }
    }
    const layer = document.createElement('canvas');
    layer.width = pw;
    layer.height = ph;
    layer.getContext('2d').putImageData(image, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer, ox, oy);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // A et B
    for (const [p, label] of markers ? [[markers.a, 'A'], [markers.b, 'B']] as const : []) {
        const x = map.x(p.s), y = map.y(p.t);
        ctx.beginPath();
        ctx.arc(x, y, 8 * f, 0, Math.PI * 2);
        ctx.fillStyle = theme.marker;
        ctx.fill();
        ctx.fillStyle = theme.markerText;
        ctx.font = `700 ${10 * f}px ${theme.font}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x, y + 0.5 * f);
    }

    // Mesure : deux points et leur écart
    const m = opts.measure;
    if (m) {
        const x1 = map.x(m.p1.s), y1 = map.y(m.p1.t);
        ctx.strokeStyle = theme.measure;
        ctx.fillStyle = theme.measure;
        if (m.p2) {
            const x2 = map.x(m.p2.s), y2 = map.y(m.p2.t);
            // Composantes horizontale et verticale en pointillés
            ctx.lineWidth = 1 * f;
            ctx.setLineDash([3 * f, 3 * f]);
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.lineWidth = 2 * f;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x2, y2, 3.5 * f, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(x1, y1, 3.5 * f, 0, Math.PI * 2);
        ctx.fill();
        if (m.p2 && opts.measureLabel) {
            const x2 = map.x(m.p2.s), y2 = map.y(m.p2.t);
            const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
            drawTag(ctx, opts.measureLabel(m), mx, my - 16 * f, theme, theme.measure, 'center');
        }
    }

    // Survol : réticule
    const hover = opts.hover;
    if (hover) {
        const x = map.x(hover.s), y = map.y(hover.t);
        ctx.strokeStyle = theme.axis;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, plot.y0);
        ctx.lineTo(Math.round(x) + 0.5, plot.y1);
        ctx.moveTo(plot.x0, Math.round(y) + 0.5);
        ctx.lineTo(plot.x1, Math.round(y) + 0.5);
        ctx.stroke();
    }

    ctx.restore();
};

export interface ProfileViewCallbacks {
    onHover: (p: ProfilePoint | null) => void;
    onMeasure: (m: ProfileMeasure | null) => void;
    onWindow: (w: ProfileWindow) => void;
    measureLabel: (m: ProfileMeasure) => string;
}

// Au-delà de ce déplacement (px), un appui est un glissé et non un clic.
const CLICK_TOLERANCE = 4;
// Accrochage d'un point de mesure au point du profil le plus proche.
const SNAP_RADIUS = 10;

/**
 * Profil interactif dans un canvas du panneau : molette pour zoomer, glisser
 * pour déplacer, clic pour poser les deux points d'une mesure.
 */
export class ProfileView {
    readonly canvas: HTMLCanvasElement;

    private data: ProfileData;

    private window: ProfileWindow;

    private exaggeration: number;

    private measure: ProfileMeasure | null;

    private hover: ProfilePoint | null = null;

    private callbacks: ProfileViewCallbacks;

    private width = 0;

    private height = 0;

    private drag: { id: number; x: number; y: number; cs: number; ct: number; moved: boolean } | null = null;

    private frame = 0;

    constructor(data: ProfileData, window: ProfileWindow | null, exaggeration: number, measure: ProfileMeasure | null, callbacks: ProfileViewCallbacks) {
        this.data = data;
        this.window = window;
        this.exaggeration = exaggeration;
        this.measure = measure;
        this.callbacks = callbacks;

        this.canvas = document.createElement('canvas');
        this.canvas.className = 'section-profile';
        this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
        this.canvas.addEventListener('pointerdown', this.onPointerDown);
        this.canvas.addEventListener('pointermove', this.onPointerMove);
        this.canvas.addEventListener('pointerup', this.onPointerUp);
        this.canvas.addEventListener('pointercancel', this.onPointerCancel);
        this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    }

    // Taille d'affichage (px CSS). Sans fenêtre, ou en « tout voir », le
    // profil s'ajuste aux données ; sinon il garde son cadrage en
    // remplissant la nouvelle taille (profil agrandi, fenêtre du navigateur
    // redimensionnée).
    resize(width: number, height: number) {
        if (width === this.width && height === this.height) return;
        this.width = width;
        this.height = height;
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = Math.round(width * dpr);
        this.canvas.height = Math.round(height * dpr);
        this.canvas.style.width = `${width}px`;
        this.canvas.style.height = `${height}px`;
        if (!this.window || this.window.fitted) {
            this.fit();
            return;
        }
        // Même étendue en longueur, même centre : l'aller-retour entre le
        // profil normal et agrandi retrouve le cadrage.
        const w = this.window;
        if (w.width && w.width !== width) {
            const plot = (size: number) => Math.max(10, size - (PAD_LEFT + PAD_RIGHT) * DARK_THEME.scale);
            this.setWindow({ cs: w.cs, ct: w.ct, k: w.k * plot(width) / plot(w.width) });
        } else {
            this.window.height = height;
        }
        this.draw();
    }

    fit() {
        if (!this.width) return;
        this.setWindow({ ...fitWindow(this.data.fit, this.width, this.height, this.exaggeration, DARK_THEME), fitted: true });
        this.draw();
    }

    // Nouvelle fenêtre, notée avec la taille du profil et transmise à l'outil.
    private setWindow(w: ProfileWindow) {
        this.window = { cs: w.cs, ct: w.ct, k: w.k, width: this.width, height: this.height, fitted: !!w.fitted };
        this.callbacks.onWindow(this.window);
    }

    // Zoom autour du centre, ou du point (x, y) du canvas.
    zoom(factor: number, x = this.width / 2, y = this.height / 2) {
        if (!this.window) return;
        const map = this.mapping();
        const s = map.s(x), t = map.t(y);
        const k = Math.min(1e5, Math.max(1e-3, this.window.k * factor));
        const f = k / this.window.k;
        this.setWindow({
            k,
            cs: s - (s - this.window.cs) / f,
            ct: t - (t - this.window.ct) / f
        });
        this.draw();
    }

    // L'exagération garde le centre de la vue et l'échelle horizontale ; en
    // « tout voir », le profil se recadre.
    setExaggeration(value: number) {
        this.exaggeration = value;
        if (this.window?.fitted) this.fit();
        else this.draw();
    }

    setMeasure(measure: ProfileMeasure | null) {
        this.measure = measure;
        this.draw();
    }

    // Survol venu de l'extérieur (null l'efface).
    setHover(p: ProfilePoint | null) {
        this.hover = p;
        this.draw();
    }

    getWindow(): ProfileWindow | null {
        return this.window;
    }

    getSize(): { width: number; height: number } {
        return { width: this.width, height: this.height };
    }

    destroy() {
        cancelAnimationFrame(this.frame);
        this.canvas.removeEventListener('wheel', this.onWheel);
        this.canvas.removeEventListener('pointerdown', this.onPointerDown);
        this.canvas.removeEventListener('pointermove', this.onPointerMove);
        this.canvas.removeEventListener('pointerup', this.onPointerUp);
        this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
        this.canvas.removeEventListener('pointerleave', this.onPointerLeave);
        this.canvas.remove();
    }

    draw() {
        if (!this.width || !this.window) return;
        const ctx = this.canvas.getContext('2d');
        paintProfile(ctx, this.data, {
            width: this.width,
            height: this.height,
            dpr: window.devicePixelRatio || 1,
            window: this.window,
            exaggeration: this.exaggeration,
            theme: DARK_THEME,
            measure: this.measure,
            hover: this.hover,
            measureLabel: this.callbacks.measureLabel
        });
    }

    // Redessin groupé à l'image suivante (glissé, molette).
    private requestDraw() {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => this.draw());
    }

    private mapping() {
        return profileToScreen({ width: this.width, height: this.height, window: this.window, exaggeration: this.exaggeration, theme: DARK_THEME });
    }

    private local(event: PointerEvent | WheelEvent) {
        const rect = this.canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    private onWheel = (event: WheelEvent) => {
        // La molette zoome le profil, pas la caméra (ui.ts relaie la molette
        // des panneaux vers la vue 3D).
        event.preventDefault();
        event.stopPropagation();
        if (!this.window) return;
        const { x, y } = this.local(event);
        const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
        const map = this.mapping();
        const s = map.s(x), t = map.t(y);
        const k = Math.min(1e5, Math.max(1e-3, this.window.k * Math.exp(-delta * 0.0015)));
        const f = k / this.window.k;
        this.setWindow({ k, cs: s - (s - this.window.cs) / f, ct: t - (t - this.window.ct) / f });
        this.requestDraw();
    };

    private onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0 || !this.window) return;
        event.preventDefault();
        try {
            this.canvas.setPointerCapture(event.pointerId);
        } catch {
            // pointeur déjà relâché : le glissé s'arrêtera au bord du canvas
        }
        this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, cs: this.window.cs, ct: this.window.ct, moved: false };
    };

    private onPointerMove = (event: PointerEvent) => {
        if (!this.window) return;
        const drag = this.drag;
        if (drag && drag.id === event.pointerId) {
            const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
            if (!drag.moved && Math.abs(dx) + Math.abs(dy) < CLICK_TOLERANCE) return;
            drag.moved = true;
            this.canvas.style.cursor = 'grabbing';
            this.setWindow({
                k: this.window.k,
                cs: drag.cs - dx / this.window.k,
                ct: drag.ct + dy / (this.window.k * this.exaggeration)
            });
            this.setHoverFromEvent(null);
            this.requestDraw();
            return;
        }
        if (event.pointerType !== 'mouse') return;
        const { x, y } = this.local(event);
        const map = this.mapping();
        const inside = x >= map.plot.x0 && x <= map.plot.x1 && y >= map.plot.y0 && y <= map.plot.y1;
        this.setHoverFromEvent(inside ? { s: map.s(x), t: map.t(y) } : null);
        this.requestDraw();
    };

    private onPointerUp = (event: PointerEvent) => {
        const drag = this.drag;
        if (!drag || drag.id !== event.pointerId) return;
        this.drag = null;
        this.canvas.style.cursor = '';
        if (drag.moved) return;

        // Clic : point de mesure, accroché au point du profil le plus proche.
        const { x, y } = this.local(event);
        const map = this.mapping();
        if (x < map.plot.x0 || x > map.plot.x1 || y < map.plot.y0 || y > map.plot.y1) return;
        const snapped = nearestPoint(this.data, { width: this.width, height: this.height, window: this.window, exaggeration: this.exaggeration, theme: DARK_THEME }, x, y, SNAP_RADIUS);
        const p = snapped ?? { s: map.s(x), t: map.t(y) };
        this.measure = this.measure && !this.measure.p2 ? { p1: this.measure.p1, p2: p } : { p1: p, p2: null };
        this.callbacks.onMeasure(this.measure);
        this.draw();
    };

    private onPointerCancel = () => {
        this.drag = null;
        this.canvas.style.cursor = '';
    };

    private onPointerLeave = (event: PointerEvent) => {
        if (event.pointerType !== 'mouse' || this.drag) return;
        this.setHoverFromEvent(null);
        this.draw();
    };

    private setHoverFromEvent(p: ProfilePoint | null) {
        if (!p && !this.hover) return;
        this.hover = p;
        this.callbacks.onHover(p);
    }
}
