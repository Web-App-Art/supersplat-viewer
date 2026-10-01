import { dimensionGeometry } from './drawing';
import type { DrawingTarget, TextOptions, Vec2 } from './drawing';
import { CAP, MM, PdfDocument, PdfDrawing, textWidth } from './pdf';
import type { PdfImage, PdfLayer, PdfLayerStyle, PdfPage, PdfShading } from './pdf';
import { contentBox, drawSection, nice } from './section-drawing';
import type { Box, DrawingLayers, SectionDrawing } from './section-drawing';
import {
    createField, createNote, createSegmented, createSwitch, decimalSeparator, readStoredNumber, readStoredText, sceneName, slugify, storeNumber,
    storeText, translator
} from './tool-panel';

// ARTLIGHT (TKT-249) : rapport PDF vectoriel des coupes. Une page par coupe,
// en A4 ou A3 paysage, précédée d'une page de garde pour un dossier :
// - le dessin de la coupe (section-drawing.ts, comme le DXF) à une échelle
//   normalisée, choisie pour tenir sur la page ou imposée ; profil exagéré :
//   deux échelles, longueurs et hauteurs ;
// - un cartouche en bas à droite, sur le modèle des plans livrés par
//   Artlight (client, projet, logo, titre, date, échelle, format) ;
// - l'échelle graphique au-dessus du cartouche, les résultats de la coupe
//   et une vignette de la vue 3D (seule image du PDF) ;
// - l'échelle déclarée dans le PDF : l'outil de mesure d'Acrobat lit des
//   mètres sur le dessin.
// Deux dispositions : résultats dans une colonne à droite (plan, coupe
// haute) ou dans une bande en bas (profil long). Celle qui permet la plus
// grande échelle l'emporte.
//
// Toutes les cotes de mise en page sont en mm, origine en bas à gauche.

const tr = translator('artlight.section.pdf');

export type PdfFormat = 'a4' | 'a3';

const PAGES: Record<PdfFormat, { w: number; h: number; name: string }> = {
    a4: { w: 297, h: 210, name: 'A4' },
    a3: { w: 420, h: 297, name: 'A3' }
};

const MARGIN = 10;
const GAP = 5;
const CART_W = 95;
const CART_ROW = 7;             // lignes client et projet
const CART_MAIN = 18;           // logo, titre, date, échelle, format
const BAR_H = 12;               // échelle graphique
const HEADING_H = 11;           // titre de la page
const TEXT_H = 2;               // hauteur des capitales du dessin

// Échelles normalisées, de la plus grande à la plus petite. En automatique,
// la plus grande qui tient sur la page.
const SCALES = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000];
// Échelles proposées dans la fenêtre ; 0 : automatique.
export const SCALE_CHOICES = [0, 20, 50, 100, 200, 500];

const INK = '#18181b';
const TEXT = '#3f3f46';
const MUTED = '#71717a';
const RULE = '#a1a1aa';
const FAINT = '#d4d4d8';

// Plume du logo Artlight (apps/crm/public/logo_artlight.svg du monorepo) :
// un départ et onze courbes de Bézier, en unités du SVG (y vers le bas), et
// son dégradé, sans l'ombre portée.
const LEAF = [
    288.72, 923.28, 288.72, 923.28, 229, 403.57, 801.1, 150, 801.1, 150, 743.89, 205.27, 741.37, 274.69, 739.08, 338.05,
    720.41, 377.38, 690.03, 411.95, 690.03, 411.95, 706.79, 419.28, 740.32, 397.28, 740.32, 397.28, 675.36, 513.59,
    568.48, 556.55, 568.48, 556.55, 590.48, 560.74, 678.5, 499.97, 678.5, 499.97, 638.68, 607.89, 477.32, 695.91,
    477.32, 695.91, 401.88, 726.3, 355.77, 793.36, 355.77, 793.36, 400.83, 593.23, 618.77, 361.66, 618.77, 361.66,
    343.2, 565.98, 298.14, 939, 298.14, 939, 296.04, 929.57, 288.71, 923.28
];
const LEAF_TOP = 150, LEAF_BOTTOM = 939;
const LEAF_GRADIENT: [number, string][] = [[0, '#fde047'], [0.05, '#f3de43'], [0.14, '#dada38'], [0.25, '#b1d328'], [0.35, '#84cc16'], [1, '#15803d']];

// Coordonnées d'Artlight sous le logo (Maxime, 01/10 : agence de Draguignan).
const ADDRESS = ['33 avenue Lazare Carnot', '83300 Draguignan'];

interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
}

// Une coupe du rapport.
export interface PdfSheet {
    title: string;              // « Coupe A-A »
    kind: string;               // « Coupe verticale »
    summary: string;            // une ligne pour le sommaire
    drawing: SectionDrawing;
    exaggeration: number;       // hauteurs / longueurs (profil exagéré)
    tables: { title: string; rows: [string, string][] }[];
    thumbnail: Blob | null;
}

export interface PdfReportOptions {
    format: PdfFormat;
    scale: number;              // dénominateur imposé ; 0 : automatique
    linesOnly: boolean;
    client: string;
    project: string;
    frameName: string;          // repère affiché
    cover: boolean;             // page de garde (dossier de coupes)
    date: Date;
    locale: string;
}

export interface PdfReportResult {
    blob: Blob;
    pages: number;
    // Coupes trop grandes pour l'échelle imposée : échelle retenue.
    fallbacks: { title: string; scale: string }[];
}

const P = (mm: number) => mm * MM;

const ratio = (denom: number) => `1:${Number.isInteger(denom) ? denom : denom.toFixed(1).replace('.', decimalSeparator())}`;

// Corps réduit pour que le texte tienne dans `width` (mm), puis texte coupé.
const fitText = (text: string, size: number, width: number, bold = false, min = 4.5): { text: string; size: number } => {
    const w = textWidth(text, size, bold) / MM;
    if (w <= width) return { text, size };
    const fitted = size * width / w;
    if (fitted >= min) return { text, size: fitted };
    let cut = text;
    while (cut.length > 1 && textWidth(`${cut}…`, min, bold) / MM > width) cut = cut.slice(0, -1);
    return { text: `${cut.trimEnd()}…`, size: min };
};

const text = (page: PdfPage, x: number, y: number, size: number, value: string, opts: { bold?: boolean; align?: 'left' | 'center' | 'right'; color?: string; baseline?: 'baseline' | 'middle' | 'top' | 'bottom' } = {}) => {
    page.fill(opts.color ?? INK);
    page.text(P(x), P(y), size, value, opts);
};

// Étendue d'un dessin, textes compris, sans rien dessiner (choix de
// l'échelle). Les points sont dans le cadre : ils ne comptent pas.
class BoundsTarget implements DrawingTarget {
    box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

    private textHeight: number;

    constructor(textHeight: number) {
        this.textHeight = textHeight;
    }

    private add(x: number, y: number) {
        if (x < this.box.x0) this.box.x0 = x;
        if (x > this.box.x1) this.box.x1 = x;
        if (y < this.box.y0) this.box.y0 = y;
        if (y > this.box.y1) this.box.y1 = y;
    }

    point() {
        // dans le cadre
    }

    line(_layer: string, a: Vec2, b: Vec2) {
        this.add(a[0], a[1]);
        this.add(b[0], b[1]);
    }

    polyline(_layer: string, xy: ArrayLike<number>) {
        for (let i = 0; i + 1 < xy.length; i += 2) this.add(xy[i], xy[i + 1]);
    }

    circle(_layer: string, c: Vec2, r: number) {
        this.add(c[0] - r, c[1] - r);
        this.add(c[0] + r, c[1] + r);
    }

    solid(_layer: string, pts: Vec2[]) {
        for (const p of pts) this.add(p[0], p[1]);
    }

    text(_layer: string, at: Vec2, height: number, value: string, opts: TextOptions = {}) {
        const size = height / CAP;
        const w = textWidth(value, size);
        const dx = { left: 0, center: -w / 2, right: -w }[opts.align ?? 'left'];
        const dy = { baseline: 0, bottom: 0.207 * size, middle: -height / 2, top: -height }[opts.baseline ?? 'baseline'];
        const a = (opts.rotation ?? 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
        for (const [u, v] of [[dx, dy - 0.21 * size], [dx + w, dy - 0.21 * size], [dx, dy + 0.93 * size], [dx + w, dy + 0.93 * size]]) {
            this.add(at[0] + u * c - v * s, at[1] + u * s + v * c);
        }
    }

    textWidth(value: string, height: number) {
        return textWidth(value, height / CAP);
    }

    dimension(_layer: string, p1: Vec2, p2: Vec2, at: Vec2, angle: number | null, _z?: number, value?: string) {
        const g = dimensionGeometry(p1, p2, at, angle, this.textHeight);
        if (!g) return;
        for (const [a, b] of [...g.extensions, g.line]) this.line('', a, b);
        for (const arrow of g.arrows) this.solid('', arrow);
        this.text('', g.mid, this.textHeight, value ?? g.measurement.toFixed(3), { align: 'center', baseline: 'middle', rotation: g.textAngle });
    }
}

interface Fit {
    denom: number;
    s: number;                  // mm de papier par mètre (longueurs)
    bounds: Box;                // unités du dessin
    w: number;                  // mm
    h: number;
}

// Taille du dessin sur le papier à l'échelle 1:denom.
const measureDrawing = (d: SectionDrawing, box: Box, ky: number, denom: number): Fit => {
    const s = 1000 / denom;
    const target = new BoundsTarget(TEXT_H / s);
    drawSection(d, target, { h: TEXT_H / s, ky, points: false, box, tight: true });
    const b = target.box;
    return { denom, s, bounds: b, w: (b.x1 - b.x0) * s, h: (b.y1 - b.y0) * s };
};

type Layout = 'side' | 'bottom';

interface Regions {
    heading: Rect;
    drawing: Rect;
    panel: Rect;                // vignette et résultats
    bar: Rect;                  // échelle graphique
    cartouche: Rect;
}

const cartoucheHeight = (client: boolean) => (client ? CART_ROW : 0) + CART_ROW + CART_MAIN;

const regions = (format: PdfFormat, layout: Layout, client: boolean): Regions => {
    const { w: W, h: H } = PAGES[format];
    const ch = cartoucheHeight(client);
    const cartouche = { x: W - MARGIN - CART_W, y: MARGIN, w: CART_W, h: ch };
    const bar = { x: cartouche.x, y: MARGIN + ch + 1, w: CART_W, h: BAR_H };
    const heading = { x: MARGIN, y: H - MARGIN - HEADING_H, w: W - 2 * MARGIN, h: HEADING_H };
    if (layout === 'side') {
        const panelY = bar.y + BAR_H + GAP;
        return {
            heading,
            cartouche,
            bar,
            panel: { x: cartouche.x, y: panelY, w: CART_W, h: heading.y - GAP - panelY },
            drawing: { x: MARGIN, y: MARGIN, w: cartouche.x - GAP - MARGIN, h: heading.y - MARGIN }
        };
    }
    const band = ch + 1 + BAR_H;
    return {
        heading,
        cartouche,
        bar,
        panel: { x: MARGIN, y: MARGIN, w: cartouche.x - GAP - MARGIN, h: band },
        drawing: { x: MARGIN, y: MARGIN + band + GAP, w: W - 2 * MARGIN, h: heading.y - MARGIN - band - GAP }
    };
};

interface SheetPlan {
    sheet: PdfSheet;
    box: Box;
    ky: number;
    fit: Fit;
    layout: Layout;
    fallback: boolean;
}

// Échelle et disposition d'une coupe : la plus grande échelle qui tient,
// dans l'une ou l'autre disposition (à égalité : bande en bas pour un
// profil, colonne pour un plan) ; l'échelle imposée si elle tient.
const planSheet = (sheet: PdfSheet, o: PdfReportOptions): SheetPlan => {
    const d = sheet.drawing;
    const box = contentBox(d);
    const ky = sheet.exaggeration;
    const client = !!o.client;
    const areas = { side: regions(o.format, 'side', client).drawing, bottom: regions(o.format, 'bottom', client).drawing };
    const fits = (fit: Fit, layout: Layout) => fit.w <= areas[layout].w && fit.h <= areas[layout].h;
    const preferred: Layout[] = d.kind === 'plan' ? ['side', 'bottom'] : ['bottom', 'side'];

    if (o.scale) {
        const fit = measureDrawing(d, box, ky, o.scale);
        const layout = (['side', 'bottom'] as Layout[]).find(l => fits(fit, l));
        if (layout) return { sheet, box, ky, fit, layout, fallback: false };
    }
    let last: Fit | null = null;
    for (const denom of SCALES) {
        const fit = measureDrawing(d, box, ky, denom);
        const layout = preferred.find(l => fits(fit, l));
        if (layout) return { sheet, box, ky, fit, layout, fallback: !!o.scale };
        last = fit;
    }
    return { sheet, box, ky, fit: last, layout: 'side', fallback: !!o.scale };
};

// Logo : « Artlight » et la plume, posés sur la ligne de base (x, y), corps
// `size` (pt). Renvoie la largeur (mm).
const drawLogo = (page: PdfPage, shading: PdfShading, x: number, y: number, size: number): number => {
    const word = textWidth('Artlight', size) / MM;
    text(page, x, y, size, 'Artlight', { color: '#27272a' });
    const a = size * 1.2 / (LEAF_BOTTOM - LEAF_TOP);       // pt par unité du SVG
    const tipX = P(x + word) - size * 0.08, tipY = P(y) - size * 0.05;
    const tx = tipX - a * LEAF[0], ty = tipY + a * LEAF[1];
    let path = `${LEAF[0]} ${LEAF[1]} m`;
    for (let i = 2; i < LEAF.length; i += 6) path += ` ${LEAF.slice(i, i + 6).join(' ')} c`;
    const cm = `${a.toFixed(5)} 0 0 ${(-a).toFixed(5)} ${tx.toFixed(2)} ${ty.toFixed(2)} cm`;
    page.push(`q ${cm} ${path} h W n /${shading.id} sh Q\n`);
    page.push(`q ${cm} ${path} h ${(0.25 / a).toFixed(3)} w 0.145 0.184 0.251 RG S Q\n`);
    return word + (801.1 - LEAF[0]) * a / MM;
};

interface CartoucheContent {
    client: string;
    project: string;
    title: string;
    subtitle: string;
    date: string;
    scale: string;
    format: string;
    page: string;
}

// Cartouche : client, projet, puis logo | titre | date, échelle, format.
const drawCartouche = (page: PdfPage, r: Rect, c: CartoucheContent, shading: PdfShading) => {
    page.stroke(INK, 0.35 * MM);
    page.rect(P(r.x), P(r.y), P(r.w), P(r.h), 'S');
    page.stroke(INK, 0.18 * MM);
    let top = r.y + r.h;
    const row = (value: string, size: number, bold: boolean) => {
        const fitted = fitText(value, size, r.w - 4, bold);
        text(page, r.x + r.w / 2, top - CART_ROW / 2, fitted.size, fitted.text, { bold, align: 'center', baseline: 'middle' });
        top -= CART_ROW;
        page.line(P(r.x), P(top), P(r.x + r.w), P(top));
    };
    if (c.client) row(tr('cartouche.client', { client: c.client }), 9, true);
    row(tr('cartouche.project', { project: c.project }), 8, false);

    const logoW = 30, infoW = 24;
    const xInfo = r.x + r.w - infoW;
    page.line(P(r.x + logoW), P(r.y), P(r.x + logoW), P(top));
    page.line(P(xInfo), P(r.y), P(xInfo), P(top));
    const cell = (top - r.y) / 3;
    page.line(P(xInfo), P(r.y + cell), P(r.x + r.w), P(r.y + cell));
    page.line(P(xInfo), P(r.y + cell * 2), P(r.x + r.w), P(r.y + cell * 2));

    // Logo centré dans sa case, l'adresse en dessous
    const logoSize = 11;
    const logoWidth = textWidth('Artlight', logoSize) / MM + 5;
    drawLogo(page, shading, r.x + (logoW - logoWidth) / 2, r.y + (top - r.y) / 2 + 1, logoSize);
    ADDRESS.forEach((line, i) => {
        const fitted = fitText(line, 5, logoW - 2);
        text(page, r.x + logoW / 2, r.y + 4.6 - i * 2.4, fitted.size, fitted.text, { align: 'center', color: TEXT });
    });

    // Titre, sous-titre
    const titleW = xInfo - (r.x + logoW) - 3;
    const cx = r.x + logoW + (xInfo - r.x - logoW) / 2;
    const title = fitText(c.title, 9, titleW, true);
    const lines = c.subtitle.split('\n').filter(Boolean);
    const mid = r.y + (top - r.y) / 2 + lines.length * 1.6;
    text(page, cx, mid, title.size, title.text, { bold: true, align: 'center', baseline: 'middle' });
    lines.forEach((line, i) => {
        const fitted = fitText(line, 6, titleW);
        text(page, cx, mid - 4 - i * 3, fitted.size, fitted.text, { align: 'center', baseline: 'middle', color: TEXT });
    });

    // Date, échelle, format et page
    [c.date, c.scale, `${c.format} · ${c.page}`].forEach((value, i) => {
        const fitted = fitText(value, 7, infoW - 2);
        text(page, xInfo + infoW / 2, r.y + cell * (2.5 - i), fitted.size, fitted.text, { align: 'center', baseline: 'middle' });
    });
};

// Échelle graphique : barre en cases alternées, longueur ronde d'environ
// `target` mm, alignée à droite de `x1`, ligne de base des chiffres en y.
const drawScaleBar = (page: PdfPage, x1: number, y: number, s: number, caption: string, target = 50) => {
    const length = nice(target / s, false);
    const mantissa = Math.round(length / 10 ** Math.floor(Math.log10(length)));
    const parts = mantissa === 2 ? 4 : 5;
    const step = length / parts;
    const unitW = textWidth(' m', 6) / MM;
    const w = length * s;
    const x0 = x1 - w - unitW - 2;
    const barY = y + 2.2;
    page.stroke(INK, 0.18 * MM);
    for (let i = 0; i < parts; i++) {
        page.fill(i % 2 ? '#ffffff' : INK);
        page.rect(P(x0 + i * step * s), P(barY), P(step * s), P(1.4), 'B');
    }
    const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    for (let i = 0; i <= parts; i++) {
        const label = String(Number((i * step).toFixed(decimals))).replace('.', decimalSeparator());
        text(page, x0 + i * step * s, y, 6, i === parts ? `${label} m` : label, { align: i === parts ? 'left' : 'center', color: INK });
    }
    text(page, x0 - 2, barY + 0.2, 6, caption, { align: 'right', color: MUTED });
};

// Résultats : sections en colonnes, libellé à gauche, valeur à droite (à la
// ligne si elle ne tient pas). Renvoie false si tout n'a pas tenu.
const drawTable = (page: PdfPage | null, r: Rect, tables: PdfSheet['tables'], k: number): boolean => {
    const rowSize = 6.2 * k, headSize = 5.5 * k;
    const rowStep = 2.9 * k, headStep = 3.8 * k, sectionGap = 1.6 * k;
    const minCol = 44, colGap = 4;
    const columns = Math.max(1, Math.floor((r.w + colGap) / (minCol + colGap)));
    const colW = (r.w - colGap * (columns - 1)) / columns;

    // Lignes à poser : en-têtes et rangées, avec leur hauteur
    type Line = { kind: 'head'; text: string } | { kind: 'row'; label: string; value: string; wrap: boolean };
    const items: { line: Line; height: number; first: boolean }[] = [];
    for (const table of tables) {
        items.push({ line: { kind: 'head', text: table.title.toUpperCase() }, height: headStep, first: true });
        for (const [label, value] of table.rows) {
            const wrap = textWidth(label, rowSize) / MM + textWidth(value, rowSize, true) / MM + 2 > colW;
            items.push({ line: { kind: 'row', label, value, wrap }, height: rowStep * (wrap ? 2 : 1), first: false });
        }
    }

    let col = 0, y = r.y + r.h, fits = true;
    for (let i = 0; i < items.length; i++) {
        const { line, height } = items[i];
        // Un en-tête ne reste pas seul en bas de colonne.
        const need = height + (line.kind === 'head' ? sectionGap + (items[i + 1]?.height ?? 0) : 0);
        if (y - need < r.y) {
            col++;
            y = r.y + r.h;
            if (col >= columns) {
                fits = false;
                break;
            }
        }
        const x = r.x + col * (colW + colGap);
        if (line.kind === 'head') {
            if (y < r.y + r.h) y -= sectionGap;
            if (page) {
                text(page, x, y - 2.5 * k, headSize, line.text, { bold: true, color: MUTED });
                page.stroke(FAINT, 0.15 * MM);
                page.line(P(x), P(y - headStep + 0.6), P(x + colW), P(y - headStep + 0.6));
            }
            y -= headStep;
        } else {
            if (page) {
                const base = y - rowStep + 0.8 * k;
                const label = fitText(line.label, rowSize, line.wrap ? colW : colW * 0.62);
                text(page, x, base, label.size, label.text, { color: TEXT });
                const value = fitText(line.value, rowSize, line.wrap ? colW : colW - textWidth(label.text, label.size) / MM - 2, true);
                text(page, x + colW, line.wrap ? base - rowStep : base, value.size, value.text, { bold: true, align: 'right' });
            }
            y -= height;
        }
    }
    return fits;
};

// Vignette et résultats dans le panneau : vignette en haut (colonne) ou à
// gauche (bande), résultats dans le reste, en réduisant le texte au besoin.
const drawPanel = (page: PdfPage, r: Rect, image: PdfImage | null, tables: PdfSheet['tables']) => {
    let table = r;
    if (image) {
        const aspect = image.width / image.height;
        let w: number, h: number;
        if (r.w >= r.h * 1.5) {
            h = r.h;
            w = Math.min(h * aspect, r.w * 0.38);
            h = w / aspect;
            table = { x: r.x + w + GAP, y: r.y, w: r.w - w - GAP, h: r.h };
        } else {
            w = r.w;
            h = Math.min(w / aspect, r.h * 0.42);
            w = h * aspect;
            table = { x: r.x, y: r.y, w: r.w, h: r.h - h - 3 };
        }
        const top = r.y + r.h;
        page.image(image, P(r.x), P(top - h), P(w), P(h));
        page.stroke(FAINT, 0.2 * MM);
        page.rect(P(r.x), P(top - h), P(w), P(h), 'S');
    }
    const k = [1, 0.92, 0.84, 0.76].find(f => drawTable(null, table, tables, f)) ?? 0.76;
    drawTable(page, table, tables, k);
};

// Style des calques du dessin (couleurs de l'export PNG, fond blanc).
const layerStyles = (doc: PdfDocument, L: DrawingLayers): Record<string, PdfLayerStyle> => ({
    [L.points]: { layer: doc.layer(L.points), color: '#8a8a94', width: 0.18, dot: 0.2, clip: true },
    [L.lines]: { layer: doc.layer(L.lines), color: INK, width: 0.35, clip: true },
    [L.grid]: { layer: doc.layer(L.grid), color: MUTED, width: 0.18 },
    [L.dims]: { layer: doc.layer(L.dims), color: '#4d7c0f', width: 0.25, thin: 0.18 },
    [L.measure]: { layer: doc.layer(L.measure), color: '#c2410c', width: 0.25, thin: 0.18 },
    [L.rule]: { layer: doc.layer(L.rule), color: '#0369a1', width: 0.35, thin: 0.18 },
    [L.title]: { layer: doc.layer(L.title), color: INK, width: 0.25 }
});

const layerOrder = (L: DrawingLayers) => [L.points, L.grid, L.lines, L.dims, L.measure, L.rule, L.title];

interface Context {
    doc: PdfDocument;
    o: PdfReportOptions;
    paper: PdfLayer;
    shading: PdfShading;
    date: string;
    format: string;
    total: number;
}

// Page d'une coupe.
const drawSheet = (ctx: Context, plan: SheetPlan, thumbnail: Uint8Array<ArrayBuffer> | null, number: number) => {
    const { doc, o } = ctx;
    const { sheet, fit, ky, layout } = plan;
    const { w: W, h: H } = PAGES[o.format];
    const page = doc.addPage(P(W), P(H));
    doc.bookmark(sheet.title, page);
    const R = regions(o.format, layout, !!o.client);
    const d = sheet.drawing;
    const L = d.layers;

    // Dessin centré dans sa zone
    const area = R.drawing;
    const oxMm = area.x + (area.w - fit.w) / 2 - fit.bounds.x0 * fit.s;
    const oyMm = area.y + (area.h - fit.h) / 2 - fit.bounds.y0 * fit.s;
    const h = TEXT_H / fit.s;
    const drawing = new PdfDrawing(page, { ox: P(oxMm), oy: P(oyMm), s: P(fit.s) }, layerStyles(doc, L), { textHeight: h, decimals: 3, decimal: d.decimal });
    const { frame } = drawSection(d, drawing, { h, ky, points: !o.linesOnly, box: plan.box, tight: true });
    drawing.finish(layerOrder(L), frame);

    const scale = ky !== 1 ? tr('scale-two', { l: ratio(fit.denom), h: ratio(fit.denom / ky) }) : ratio(fit.denom);
    page.measure({
        bbox: [P(oxMm + frame.x0 * fit.s), P(oyMm + frame.y0 * fit.s), P(oxMm + frame.x1 * fit.s), P(oyMm + frame.y1 * fit.s)],
        name: sheet.title,
        ratio: scale,
        mx: fit.denom / MM / 1000,
        my: fit.denom / MM / 1000 / ky,
        origin: [P(oxMm), P(oyMm)],
        decimal: d.decimal
    });

    const image = thumbnail ? doc.jpeg(thumbnail) : null;
    page.layer(ctx.paper, () => {
        // Titre de la page
        const head = R.heading;
        const base = head.y + head.h - 6;
        text(page, head.x, base, 12, sheet.title, { bold: true });
        const notes = [sheet.kind, scale];
        if (ky !== 1) notes.push(tr('exaggeration', { n: ky }));
        notes.push(o.frameName);
        if (o.linesOnly) notes.push(tr('lines-only-note'));
        const titleW = textWidth(sheet.title, 12, true) / MM;
        const fitted = fitText(notes.join(' · '), 7.5, head.w - titleW - 4);
        text(page, head.x + titleW + 4, base, fitted.size, fitted.text, { color: MUTED });
        page.stroke(FAINT, 0.2 * MM);
        page.line(P(head.x), P(head.y + 1.5), P(head.x + head.w), P(head.y + 1.5));

        // Échelle graphique : longueurs, et hauteurs pour un profil exagéré
        const bar = R.bar;
        if (ky !== 1) {
            drawScaleBar(page, bar.x + bar.w, bar.y + 6.5, fit.s, tr('bar-lengths'), 40);
            drawScaleBar(page, bar.x + bar.w, bar.y + 0.5, fit.s * ky, tr('bar-heights'), 40);
        } else {
            drawScaleBar(page, bar.x + bar.w, bar.y + 3, fit.s, '');
        }

        drawPanel(page, R.panel, image, sheet.tables);
        drawCartouche(page, R.cartouche, {
            client: o.client,
            project: o.project,
            title: sheet.title,
            subtitle: `${sheet.kind}\n${o.frameName}`,
            date: ctx.date,
            scale,
            format: ctx.format,
            page: `${number}/${ctx.total}`
        }, ctx.shading);
    });
};

const COVER_ROW = 6.5;

// Sommaire : rangées par page de garde.
const coverRows = (format: PdfFormat, client: boolean) => {
    const { h: H } = PAGES[format];
    const top = H - MARGIN - 62, bottom = MARGIN + cartoucheHeight(client) + 14;
    return Math.max(1, Math.floor((top - bottom) / COVER_ROW) - 1);
};

// Page de garde : logo, titre, projet, client, informations, sommaire.
const drawCover = (ctx: Context, plans: SheetPlan[], first: number, rows: number, number: number, pageOf: (i: number) => number) => {
    const { doc, o } = ctx;
    const { w: W, h: H } = PAGES[o.format];
    const page = doc.addPage(P(W), P(H));
    if (number === 1) doc.bookmark(tr('contents'), page);
    page.layer(ctx.paper, () => {
        const left = MARGIN, right = W - MARGIN;
        drawLogo(page, ctx.shading, left, H - MARGIN - 9, 20);
        text(page, left, H - MARGIN - 14.5, 8, ADDRESS.join(' · '), { color: MUTED });

        let y = H - MARGIN - 24;
        text(page, left, y, 20, tr('cover-title'), { bold: true });
        y -= 9;
        text(page, left, y, 13, o.project);
        if (o.client) {
            y -= 6.5;
            text(page, left, y, 10, tr('cartouche.client', { client: o.client }), { color: TEXT });
        }

        // Informations, à droite
        const info: [string, string][] = [
            [tr('info.date'), o.date.toLocaleDateString(o.locale, { dateStyle: 'long' })],
            [tr('info.frame'), o.frameName],
            [tr('info.unit'), tr('info.meter')],
            [tr('info.count'), String(plans.length)],
            [tr('info.format'), tr(`format.${o.format}`)]
        ];
        info.forEach(([label, value], i) => {
            const yy = H - MARGIN - 6 - i * 5;
            text(page, right - 62, yy, 7.5, label, { color: MUTED });
            const fitted = fitText(value, 7.5, 60, true);
            text(page, right, yy, fitted.size, fitted.text, { bold: true, align: 'right' });
        });

        // Sommaire : page, coupe, type, description, échelle
        const descW = right - left - (14 + 52 + 38 + 30);
        let ty = H - MARGIN - 62;
        text(page, left, ty, 9, number === 1 ? tr('contents') : tr('contents-more'), { bold: true });
        ty -= 4;
        const header = [tr('col.page'), tr('col.section'), tr('col.kind'), tr('col.description'), tr('col.scale')];
        const xs = [left, left + 14, left + 66, left + 104, left + 104 + descW];
        page.stroke(RULE, 0.25 * MM);
        page.line(P(left), P(ty), P(right), P(ty));
        header.forEach((label, i) => text(page, xs[i], ty - 4.2, 7, label, { bold: true, color: MUTED }));
        ty -= COVER_ROW;
        page.line(P(left), P(ty), P(right), P(ty));
        page.stroke(FAINT, 0.15 * MM);
        for (let i = first; i < Math.min(plans.length, first + rows); i++) {
            const { sheet, fit, ky } = plans[i];
            const cells = [
                String(pageOf(i)), sheet.title, sheet.kind, sheet.summary,
                ky !== 1 ? tr('scale-two', { l: ratio(fit.denom), h: ratio(fit.denom / ky) }) : ratio(fit.denom)
            ];
            const widths = [14, 52, 38, descW, 30];
            for (let c = 0; c < cells.length; c++) {
                const fitted = fitText(cells[c], 8, widths[c] - 3, c === 1);
                text(page, xs[c], ty - 4.3, fitted.size, fitted.text, { bold: c === 1, color: c === 1 ? INK : TEXT });
            }
            ty -= COVER_ROW;
            page.line(P(left), P(ty), P(right), P(ty));
        }

        const note = fitText(tr('cover-note'), 6.5, W - 2 * MARGIN - CART_W - GAP);
        text(page, left, MARGIN + 1, note.size, note.text, { color: MUTED });

        drawCartouche(page, { x: W - MARGIN - CART_W, y: MARGIN, w: CART_W, h: cartoucheHeight(!!o.client) }, {
            client: o.client,
            project: o.project,
            title: tr('contents'),
            subtitle: `${tr('cover-title')}\n${o.frameName}`,
            date: ctx.date,
            scale: '—',
            format: ctx.format,
            page: `${number}/${ctx.total}`
        }, ctx.shading);
    });
};

/**
 * Rapport PDF : page de garde (dossier) puis une page par coupe.
 *
 * @param {PdfSheet[]} sheets - Coupes, dans l'ordre du dossier.
 * @param {PdfReportOptions} o - Format, échelle, client, projet…
 * @returns {Promise<PdfReportResult>} Fichier, nombre de pages, coupes à une autre échelle que celle imposée.
 */
export const sectionReportPdf = async (sheets: PdfSheet[], o: PdfReportOptions): Promise<PdfReportResult> => {
    const doc = new PdfDocument({
        title: o.cover ? `${tr('cover-title')} — ${o.project}` : `${sheets[0].title} — ${o.project}`,
        author: 'Artlight',
        subject: o.frameName,
        creator: tr('creator'),
        lang: o.locale,
        date: o.date
    });
    const L = sheets[0].drawing.layers;
    layerStyles(doc, L);
    const ctx: Context = {
        doc,
        o,
        paper: doc.layer(L.title),
        shading: doc.axialShading([286.94, 544.5, 801.1, 544.5], LEAF_GRADIENT),
        date: o.date.toLocaleDateString(o.locale, { day: '2-digit', month: '2-digit', year: 'numeric' }),
        format: PAGES[o.format].name,
        total: 0
    };

    const plans = sheets.map(sheet => planSheet(sheet, o));
    const rows = coverRows(o.format, !!o.client);
    const coverPages = o.cover ? Math.ceil(plans.length / rows) : 0;
    ctx.total = coverPages + plans.length;
    const pageOf = (i: number) => coverPages + i + 1;
    for (let c = 0; c < coverPages; c++) drawCover(ctx, plans, c * rows, rows, c + 1, pageOf);
    const thumbnails = await Promise.all(sheets.map(async sheet => (sheet.thumbnail ? new Uint8Array(await sheet.thumbnail.arrayBuffer()) : null)));
    for (let i = 0; i < plans.length; i++) drawSheet(ctx, plans[i], thumbnails[i], pageOf(i));

    return {
        blob: await doc.toBlob(),
        pages: ctx.total,
        fallbacks: plans.filter(p => p.fallback).map(p => ({ title: p.sheet.title, scale: ratio(p.fit.denom) }))
    };
};

// ── Fenêtre des réglages du PDF ──

export interface PdfSettings {
    format: PdfFormat;
    scale: number;
    linesOnly: boolean;
    client: string;
    project: string;
}

const FORMAT_STORAGE_KEY = 'artlight.section.pdf.format';
const SCALE_STORAGE_KEY = 'artlight.section.pdf.scale';
const LINES_STORAGE_KEY = 'artlight.section.pdf.lines-only';
// Client et projet : par scène.
const sceneKey = (what: string) => `artlight.section.pdf.${what}.${slugify(sceneName()) || 'scene'}`;

export const readPdfSettings = (): PdfSettings => ({
    format: readStoredText(FORMAT_STORAGE_KEY, 'a4', v => v === 'a4' || v === 'a3') as PdfFormat,
    scale: readStoredNumber(SCALE_STORAGE_KEY, 0, v => SCALE_CHOICES.includes(v)),
    linesOnly: readStoredText(LINES_STORAGE_KEY, '0', v => v === '0' || v === '1') === '1',
    client: readStoredText(sceneKey('client'), '', () => true),
    project: readStoredText(sceneKey('project'), '', () => true)
});

const storePdfSettings = (s: PdfSettings) => {
    storeText(FORMAT_STORAGE_KEY, s.format);
    storeNumber(SCALE_STORAGE_KEY, s.scale);
    storeText(LINES_STORAGE_KEY, s.linesOnly ? '1' : '0');
    storeText(sceneKey('client'), s.client);
    storeText(sceneKey('project'), s.project);
};

export interface PdfDialogOptions {
    title: string;
    intro: string;
    // Crée le PDF ; renvoie les avertissements à afficher (sinon la fenêtre se ferme).
    onCreate: (settings: PdfSettings) => Promise<string[]>;
    onClose: () => void;
}

/**
 * Fenêtre des réglages du PDF : format, échelle, traits seuls, client et
 * projet (mémorisés, client et projet par scène). Échap ou un clic à côté
 * la ferme ; les touches tapées ne vont pas aux raccourcis du visualisateur.
 */
export class PdfDialog {
    private root: HTMLDivElement;

    private opts: PdfDialogOptions;

    private settings = readPdfSettings();

    private busy = false;

    private warnings: string[] = [];

    private onKey = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        if (!this.busy) this.close();
    };

    constructor(parent: HTMLElement, opts: PdfDialogOptions) {
        this.opts = opts;
        this.root = document.createElement('div');
        this.root.id = 'sectionPdfDialog';
        this.root.className = 'section-pdf-backdrop';
        this.root.addEventListener('pointerdown', (event) => {
            if (event.target === this.root && !this.busy) this.close();
        });
        this.root.addEventListener('keydown', event => event.stopPropagation());
        document.addEventListener('keydown', this.onKey, true);
        parent.appendChild(this.root);
        this.render();
        this.root.querySelector<HTMLButtonElement>('.section-pdf-create')?.focus();
    }

    close() {
        document.removeEventListener('keydown', this.onKey, true);
        this.root.remove();
        this.opts.onClose();
    }

    private render() {
        const s = this.settings;
        this.root.textContent = '';
        const box = document.createElement('div');
        box.className = 'tool-panel section-pdf-dialog';
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-modal', 'true');
        box.setAttribute('aria-label', this.opts.title);

        const header = document.createElement('div');
        header.className = 'tool-header';
        const title = document.createElement('div');
        title.className = 'tool-title';
        title.textContent = this.opts.title;
        header.appendChild(title);
        box.appendChild(header);

        const body = document.createElement('div');
        body.className = 'tool-body';
        const intro = document.createElement('div');
        intro.className = 'section-pdf-intro';
        intro.textContent = this.opts.intro;
        body.appendChild(intro);

        const set = (patch: Partial<PdfSettings>) => {
            this.settings = { ...this.settings, ...patch };
            this.warnings = [];
            this.render();
        };
        body.appendChild(createField(tr('dialog.format'), createSegmented<PdfFormat>([
            { value: 'a4', label: tr('format.a4') },
            { value: 'a3', label: tr('format.a3') }
        ], s.format, format => set({ format }))));
        body.appendChild(createField(tr('dialog.scale'), createSegmented(SCALE_CHOICES.map(v => ({
            value: v,
            label: v ? ratio(v) : tr('dialog.scale-auto'),
            title: v ? tr('dialog.scale-forced-title', { scale: ratio(v) }) : tr('dialog.scale-auto-title')
        })), s.scale, scale => set({ scale }))));
        const lines = createSwitch(tr('dialog.lines-only'), s.linesOnly, linesOnly => set({ linesOnly }));
        lines.title = tr('dialog.lines-only-title');
        body.appendChild(lines);

        const input = (key: 'client' | 'project', placeholder: string) => {
            const el = document.createElement('input');
            el.type = 'text';
            el.className = 'section-pdf-input';
            el.value = s[key];
            el.placeholder = placeholder;
            el.spellcheck = false;
            el.setAttribute('aria-label', tr(`dialog.${key}`));
            el.addEventListener('input', () => {
                this.settings[key] = el.value;
            });
            el.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') this.create();
            });
            return el;
        };
        body.appendChild(createField(tr('dialog.client'), input('client', tr('dialog.client-placeholder'))));
        body.appendChild(createField(tr('dialog.project'), input('project', sceneName())));

        for (const warning of this.warnings) body.appendChild(createNote(warning, true));

        const actions = document.createElement('div');
        actions.className = 'section-pdf-actions';
        const cancel = document.createElement('button');
        cancel.className = 'tool-btn';
        cancel.textContent = this.warnings.length ? tr('dialog.close') : tr('dialog.cancel');
        cancel.disabled = this.busy;
        cancel.addEventListener('click', () => this.close());
        const create = document.createElement('button');
        create.className = 'tool-btn primary section-pdf-create';
        create.textContent = this.busy ? tr('dialog.busy') : tr('dialog.create');
        create.disabled = this.busy;
        create.addEventListener('click', () => this.create());
        actions.append(cancel, create);
        body.appendChild(actions);
        box.appendChild(body);
        this.root.appendChild(box);
    }

    private async create() {
        if (this.busy) return;
        const settings = { ...this.settings, client: this.settings.client.trim(), project: this.settings.project.trim() };
        storePdfSettings(settings);
        this.busy = true;
        this.render();
        let warnings: string[];
        try {
            // Laisse le bouton « Création… » s'afficher avant le calcul.
            await new Promise((resolve) => {
                setTimeout(resolve, 30);
            });
            warnings = await this.opts.onCreate({ ...settings, project: settings.project || sceneName() });
        } catch (err) {
            warnings = [tr('dialog.failed', { error: String((err as Error)?.message ?? err) })];
        }
        this.busy = false;
        if (warnings.length === 0) {
            this.close();
            return;
        }
        this.warnings = warnings;
        this.render();
    }
}
