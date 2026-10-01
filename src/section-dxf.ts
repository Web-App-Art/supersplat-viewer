import { DxfWriter } from './dxf';
import { subsample } from './tool-utils';

// ARTLIGHT (TKT-238) : mise en page du DXF d'une coupe. Le dessin est en
// mètres, dans le repère que choisit l'outil (voir SectionTool.exportDxf) :
// profil en hauteur (X = distance, Y = altitude), vue en plan (X, Y, Z du
// repère affiché) ou plan incliné (X, Y du profil).
//
// Calques (noms traduits, couleur AutoCAD entre parenthèses) :
// - points de la tranche (7 : noir sur fond blanc, blanc sur fond noir) ;
// - traits de coupe, les polylignes (3, vert, 0,35 mm) ;
// - cotes : A et B, cotes de A à B, cotes de niveau, pente (1, rouge) ;
// - mesure faite sur le profil (30, orange) ;
// - règle : la plus défavorable, ses appuis, sa flèche cotée (5, bleu) ;
// - cadre gradué (8, gris) ;
// - cartouche : titre, date, repère, réglages de la coupe (7).
// La hauteur des textes suit la taille du dessin (1/60 de sa plus grande
// dimension, arrondie).

type Vec2 = [number, number];

export type DrawingKind = 'profile' | 'plan' | 'plane';

export interface DrawingLayers {
    points: string;
    lines: string;
    dims: string;
    measure: string;
    rule: string;
    grid: string;
    title: string;
}

export interface DrawingDimension {
    p1: Vec2;
    p2: Vec2;
    kind: 'aligned' | 'horizontal' | 'vertical';
    layer?: 'measure' | 'rule'; // calque de la mesure ou de la règle plutôt que des cotes
    side?: 1 | -1;              // cote alignée : au-dessus (1) ou en dessous (-1) de p1 p2
}

// Règle (TKT-246) : la plus défavorable, ses appuis, et sa flèche, cotée
// perpendiculairement à la règle (texte en mm).
export interface DrawingRule {
    line: [Vec2, Vec2];
    supports: Vec2[];
    gap: [Vec2, Vec2];          // pied sur la règle, surface
    gapText: string;
}

export interface SectionDrawing {
    kind: DrawingKind;
    points: Float64Array;       // x, y, z alternés
    count: number;
    lines: { points: number[]; closed: boolean }[];
    z: number;                  // altitude des traits, cotes et textes
    ends?: { a: Vec2; b: Vec2; levels?: [string, string] };
    dims: DrawingDimension[];
    rule?: DrawingRule;
    // Texte le long d'un segment (pente de AB, de la mesure, règle), en
    // dessous (side -1, par défaut) ou au-dessus (1)
    notes: { text: string; p1: Vec2; p2: Vec2; layer?: 'measure' | 'rule'; side?: 1 | -1 }[];
    axes: { x: string; y: string };
    north?: string;
    title: string;
    subtitle: string;
    sections: { title: string; lines: string[] }[];   // lignes « libellé : valeur » déjà écrites
    layers: DrawingLayers;
    decimal: string;
}

// Valeur « ronde » (1, 2, 2,5 ou 5 × 10ⁿ) : la plus grande sous `v`, ou la
// plus petite au-dessus.
const nice = (v: number, up: boolean) => {
    const exp = Math.floor(Math.log10(v));
    const steps = [1, 2, 2.5, 5, 10].map(m => m * 10 ** exp);
    return up ? steps.find(s => s >= v * (1 - 1e-9)) : steps.reverse().find(s => s <= v * (1 + 1e-9));
};

// Décimales qui écrivent exactement les multiples du pas.
const stepDecimals = (step: number) => {
    for (let d = 0; d < 6; d++) {
        const v = step * 10 ** d;
        if (Math.abs(Math.round(v) - v) < 1e-6) return d;
    }
    return 6;
};

const quantile = (values: number[], q: number) => {
    const sorted = subsample(values, 20000).sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
};

// Largeur approchée d'un texte en Arial (m).
const textWidth = (text: string, height: number) => text.length * height * 0.55;

/**
 * Fichier DXF de la coupe.
 *
 * @param {SectionDrawing} d - Contenu du dessin, déjà dans son repère.
 * @returns {Blob} Fichier DXF (AutoCAD 2000).
 */
export const sectionDxf = (d: SectionDrawing): Blob => {
    const L = d.layers;

    // Étendue du contenu : points (sans les plus écartés), traits, cotes.
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < d.count; i++) {
        xs.push(d.points[i * 3]);
        ys.push(d.points[i * 3 + 1]);
    }
    let x0 = xs.length ? quantile(xs, 0.002) : Infinity, x1 = xs.length ? quantile(xs, 0.998) : -Infinity;
    let y0 = ys.length ? quantile(ys, 0.002) : Infinity, y1 = ys.length ? quantile(ys, 0.998) : -Infinity;
    const include = (p: Vec2) => {
        x0 = Math.min(x0, p[0]);
        x1 = Math.max(x1, p[0]);
        y0 = Math.min(y0, p[1]);
        y1 = Math.max(y1, p[1]);
    };
    for (const line of d.lines) {
        for (let i = 0; i < line.points.length; i += 2) include([line.points[i], line.points[i + 1]]);
    }
    if (d.ends) {
        include(d.ends.a);
        include(d.ends.b);
    }
    for (const dim of d.dims) {
        include(dim.p1);
        include(dim.p2);
    }
    if (d.rule) {
        include(d.rule.line[0]);
        include(d.rule.line[1]);
    }
    if (!Number.isFinite(x0)) {
        x0 = y0 = 0;
        x1 = y1 = 1;
    }
    const size = Math.max(x1 - x0, y1 - y0, 0.1);
    const h = Math.min(2, Math.max(0.01, nice(size / 60, false)));

    // Cotes : ligne de cote passant par `at`, selon `angle` (null : alignée).
    // Les composantes de la mesure sont plus loin que celles de AB, pour ne
    // pas se superposer. Le cadre englobe les lignes de cote.
    const placed: { layer: string; p1: Vec2; p2: Vec2; at: Vec2; angle: number | null }[] = [];
    for (const dim of d.dims) {
        const layer = dim.layer ? L[dim.layer] : L.dims;
        const offset = h * (dim.layer === 'measure' && dim.kind !== 'aligned' ? 5 : 2.5);
        const { p1, p2 } = dim;
        if (dim.kind === 'horizontal') {
            const y = Math.min(p1[1], p2[1]) - offset;
            placed.push({ layer, p1, p2, at: [p1[0], y], angle: 0 });
            include([p1[0], y - h * 0.5]);
            include([p2[0], y - h * 0.5]);
        } else if (dim.kind === 'vertical') {
            const x = Math.max(p1[0], p2[0]) + offset;
            placed.push({ layer, p1, p2, at: [x, p1[1]], angle: 90 });
            include([x + h * 0.5, p1[1]]);
            include([x + h * 0.5, p2[1]]);
        } else {
            const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
            if (len < 1e-9) continue;
            // Normale de p1 p2 tournée vers le haut (vers la gauche si p1 p2 est vertical).
            let nx = -(p2[1] - p1[1]) / len, ny = (p2[0] - p1[0]) / len;
            if (ny < -1e-9 || (Math.abs(ny) <= 1e-9 && nx > 0)) {
                nx = -nx;
                ny = -ny;
            }
            const k = (dim.side ?? 1) * offset;
            const kk = k + Math.sign(k) * h * 1.5;
            placed.push({ layer, p1, p2, at: [p1[0] + nx * k, p1[1] + ny * k], angle: null });
            include([p1[0] + nx * kk, p1[1] + ny * kk]);
            include([p2[0] + nx * kk, p2[1] + ny * kk]);
        }
    }

    // Le calque de la règle seulement s'il y en a une
    const w = new DxfWriter([
        { name: L.points, color: 7 },
        { name: L.lines, color: 3, lineweight: 35 },
        { name: L.dims, color: 1 },
        { name: L.measure, color: 30 },
        ...(d.rule ? [{ name: L.rule, color: 5, lineweight: 35 }] : []),
        { name: L.grid, color: 8 },
        { name: L.title, color: 7 }
    ], { textHeight: h, decimals: 3, decimal: d.decimal });
    const z = d.z;
    const number = (v: number, digits: number) => v.toFixed(digits).replace('.', d.decimal);

    // Points et traits
    for (let i = 0; i < d.count; i++) w.point(L.points, d.points[i * 3], d.points[i * 3 + 1], d.points[i * 3 + 2]);
    for (const line of d.lines) w.polyline(L.lines, line.points, line.closed, z);

    // Cadre gradué, aligné sur le pas des graduations. Chaque axe a son pas
    // (un profil de terrain est long et peu haut) ; les libellés ne se
    // chevauchent pas.
    const labelChars = Math.max(...[x0, x1].map(v => number(v, 1).length));
    const stepX = nice(Math.max((x1 - x0) / 10, textWidth('0'.repeat(labelChars), h * 0.8) + h), true);
    const stepY = nice(Math.max((y1 - y0) / 6, h * 2), true);
    const fx0 = Math.floor((x0 - h) / stepX) * stepX, fx1 = Math.ceil((x1 + h) / stepX) * stepX;
    const fy0 = Math.floor((y0 - h) / stepY) * stepY, fy1 = Math.ceil((y1 + h) / stepY) * stepY;
    w.polyline(L.grid, [fx0, fy0, fx1, fy0, fx1, fy1, fx0, fy1], true, z);
    let labelWidth = 0;
    for (let x = fx0; x <= fx1 + stepX * 1e-6; x += stepX) {
        w.line(L.grid, [x, fy0], [x, fy0 + h * 0.6], z);
        w.line(L.grid, [x, fy1], [x, fy1 - h * 0.6], z);
        w.text(L.grid, [x, fy0 - h * 0.5], h * 0.8, number(x, stepDecimals(stepX)), { align: 'center', baseline: 'top' }, z);
    }
    for (let y = fy0; y <= fy1 + stepY * 1e-6; y += stepY) {
        w.line(L.grid, [fx0, y], [fx0 + h * 0.6, y], z);
        w.line(L.grid, [fx1, y], [fx1 - h * 0.6, y], z);
        const label = number(y, stepDecimals(stepY));
        labelWidth = Math.max(labelWidth, textWidth(label, h * 0.8));
        w.text(L.grid, [fx0 - h * 0.5, y], h * 0.8, label, { align: 'right', baseline: 'middle' }, z);
    }
    w.text(L.grid, [fx1, fy0 - h * 1.8], h * 0.8, d.axes.x, { align: 'right', baseline: 'top' }, z);
    w.text(L.grid, [fx0 - h * 1.2 - labelWidth, fy1], h * 0.8, d.axes.y, { align: 'right', baseline: 'bottom', rotation: 90 }, z);

    // Flèche du nord (vue en plan), en haut à droite du cadre.
    if (d.north) {
        const nx = fx1 + h * 2.5, ny = fy1 - h * 5;
        w.line(L.title, [nx, ny], [nx, ny + h * 3], z);
        w.solid(L.title, [[nx, ny + h * 3.8], [nx - h * 0.45, ny + h * 2.6], [nx + h * 0.45, ny + h * 2.6]], z);
        w.text(L.title, [nx, ny + h * 4.2], h * 1.2, d.north, { align: 'center', baseline: 'bottom' }, z);
    }

    // A et B, cotes de niveau
    if (d.ends) {
        const { a, b, levels } = d.ends;
        [a, b].forEach((p, i) => {
            w.circle(L.dims, p, h * 0.3, z);
            w.text(L.dims, [p[0] - h * 0.4, p[1] + h * 0.4], h, i === 0 ? 'A' : 'B', { align: 'right', baseline: 'bottom' }, z);
            if (levels) {
                // Triangle pointé sur le point, trait, altitude au-dessus.
                const top = p[1] + h * 0.9, half = h * 0.45;
                w.polyline(L.dims, [p[0], p[1], p[0] - half, top, p[0] + half, top], true, z);
                const width = textWidth(levels[i], h * 0.8);
                w.line(L.dims, [p[0] - half, top], [p[0] + half + width + h * 0.4, top], z);
                w.text(L.dims, [p[0] + half + h * 0.2, top + h * 0.2], h * 0.8, levels[i], { baseline: 'bottom' }, z);
            }
        });
    }

    for (const p of placed) w.dimension(p.layer, p.p1, p.p2, p.at, p.angle, z);

    // Règle, appuis, flèche cotée : la ligne de cote est décalée le long de
    // la règle, vers son milieu.
    if (d.rule) {
        const { line, supports, gap, gapText } = d.rule;
        w.polyline(L.rule, [line[0][0], line[0][1], line[1][0], line[1][1]], false, z);
        for (const p of supports) w.circle(L.rule, p, h * 0.25, z);
        const lx = line[1][0] - line[0][0], ly = line[1][1] - line[0][1], len = Math.hypot(lx, ly) || 1;
        const mid = (line[0][0] + line[1][0]) / 2;
        const dir = (gap[0][0] <= mid ? 1 : -1) * Math.sign(lx || 1);
        const at: Vec2 = [gap[0][0] + lx / len * h * 2 * dir, gap[0][1] + ly / len * h * 2 * dir];
        w.dimension(L.rule, gap[0], gap[1], at, null, z, gapText);
    }

    // Notes le long de leur segment, dans son sens de lecture.
    for (const note of d.notes) {
        const { p1, p2 } = note;
        let angle = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
        if (angle > Math.PI / 2) angle -= Math.PI;
        if (angle <= -Math.PI / 2) angle += Math.PI;
        const k = (note.side ?? -1) * h * 0.8;
        const mid: Vec2 = [(p1[0] + p2[0]) / 2 - Math.sin(angle) * k, (p1[1] + p2[1]) / 2 + Math.cos(angle) * k];
        w.text(note.layer ? L[note.layer] : L.dims, mid, h * 0.8, note.text, {
            align: 'center',
            baseline: note.side === 1 ? 'bottom' : 'top',
            rotation: angle * 180 / Math.PI
        }, z);
    }

    // Cartouche sous le cadre : titre, sous-titre, puis les sections en
    // colonnes si la largeur le permet.
    let y = fy0 - h * 4;
    w.text(L.title, [fx0, y], h * 1.5, d.title, {}, z);
    y -= h * 1.6;
    w.text(L.title, [fx0, y], h * 0.8, d.subtitle, {}, z);
    y -= h * 1.8;
    const rowHeight = h * 0.8;
    const columnWidth = Math.max(...d.sections.flatMap(sec => sec.lines.map(line => textWidth(line, rowHeight))), textWidth('M'.repeat(20), rowHeight)) + h * 2;
    const columns = Math.max(1, Math.min(3, Math.floor((fx1 - fx0) / columnWidth)));
    const bottoms = new Array(columns).fill(y);
    d.sections.forEach((sec) => {
        const col = bottoms.indexOf(Math.max(...bottoms));
        const x = fx0 + col * columnWidth;
        let yy = bottoms[col] - (bottoms[col] < y ? h : 0);
        w.text(L.title, [x, yy], h * 0.9, sec.title.toUpperCase(), {}, z);
        yy -= h * 1.5;
        for (const line of sec.lines) {
            w.text(L.title, [x, yy], rowHeight, line, {}, z);
            yy -= rowHeight * 1.6;
        }
        bottoms[col] = yy;
    });
    const bottom = Math.min(...bottoms);
    const right = Math.max(fx1 + (d.north ? h * 4 : 0), fx0 + columns * columnWidth, fx0 + textWidth(d.title, h * 1.5));
    const left = fx0 - h * 2.5 - labelWidth;

    return w.toBlob({ x0: left, y0: bottom, x1: right, y1: fy1 + (d.north ? 0 : h), z });
};
