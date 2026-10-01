// ARTLIGHT (TKT-249) : interface de dessin commune au DXF (dxf.ts) et au
// PDF (pdf.ts). La mise en page d'une coupe (section-drawing.ts) n'appelle
// que ces primitives ; chaque format les écrit à sa façon.
//
// Unités : celles du dessin. Le DXF dessine en mètres ; le PDF en mètres
// « à l'échelle », convertis en points de la page par PdfDrawing.

export type Vec2 = [number, number];

export type TextAlign = 'left' | 'center' | 'right';
export type TextBaseline = 'baseline' | 'bottom' | 'middle' | 'top';

export interface TextOptions {
    align?: TextAlign;
    baseline?: TextBaseline;
    rotation?: number;      // degrés
}

export interface DrawingTarget {
    point(layer: string, x: number, y: number, z?: number): void;
    line(layer: string, a: Vec2, b: Vec2, z?: number): void;
    // Sommets x, y alternés.
    polyline(layer: string, xy: ArrayLike<number>, closed?: boolean, z?: number): void;
    circle(layer: string, c: Vec2, r: number, z?: number): void;
    // Triangle ou quadrilatère plein (sommets dans l'ordre du DXF : 1, 2, 3, 4).
    solid(layer: string, pts: Vec2[], z?: number): void;
    text(layer: string, at: Vec2, height: number, text: string, opts?: TextOptions, z?: number): void;
    // Cote entre p1 et p2, sa ligne passant par `at`, selon `angle` (degrés ;
    // null : alignée sur p1 p2). `text` remplace la mesure.
    dimension(layer: string, p1: Vec2, p2: Vec2, at: Vec2, angle: number | null, z?: number, text?: string): void;
    // Largeur d'un texte, quand le format la connaît (le DXF ne la connaît
    // pas : c'est le logiciel de CAO qui choisit la police).
    textWidth?(text: string, height: number): number;
}

// Windows-1252, l'encodage des textes du DXF et du PDF (WinAnsiEncoding) :
// 0x80 à 0x9F ci-dessous (cinq codes non attribués gardent leur valeur) ;
// 0xA0 à 0xFF valent leur code Unicode.
const CP1252_HIGH = '\u20AC\u0081\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u008D\u017D\u008F' +
    '\u0090\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u009D\u017E\u0178';

export const cp1252Byte = (code: number): number | null => {
    if (code < 0x80 || (code >= 0xA0 && code <= 0xFF)) return code;
    const i = CP1252_HIGH.indexOf(String.fromCharCode(code));
    return i >= 0 ? 0x80 + i : null;
};

// Valeur d'une cote telle qu'AutoCAD l'écrit avec le style ARTLIGHT :
// `decimals` décimales, zéros de fin supprimés, séparateur de la langue.
export const formatDimension = (value: number, decimals: number, decimal: string): string => {
    let s = value.toFixed(decimals);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s.replace('.', decimal);
};

// Tracé d'une cote, tel qu'AutoCAD le dessine : lignes d'attache, ligne de
// cote, flèches pleines (triangles), texte au-dessus de la ligne.
export interface DimensionGeometry {
    deg: number;                // direction mesurée (degrés)
    measurement: number;
    q1: Vec2;                   // pieds des lignes d'attache sur la ligne de cote
    q2: Vec2;
    extensions: [Vec2, Vec2][];
    line: [Vec2, Vec2];
    arrows: [Vec2, Vec2, Vec2][];
    mid: Vec2;                  // centre du texte
    textAngle: number;          // degrés, lisible (dans ]−90°, 90°])
}

/**
 * Tracé d'une cote. Cote alignée traitée comme une cote tournée selon p1 p2
 * (comme ezdxf) : tous les lecteurs la mesurent de la même façon.
 *
 * @param {Vec2} p1 - Premier point mesuré.
 * @param {Vec2} p2 - Second point mesuré.
 * @param {Vec2} at - Point par lequel passe la ligne de cote.
 * @param {number | null} angle - Direction mesurée en degrés, ou null (alignée).
 * @param {number} txt - Hauteur du texte, qui règle flèches et écarts.
 * @returns {DimensionGeometry | null} null si p1 et p2 sont confondus selon la direction mesurée.
 */
export const dimensionGeometry = (p1: Vec2, p2: Vec2, at: Vec2, angle: number | null, txt: number): DimensionGeometry | null => {
    const deg = angle ?? Math.atan2(p2[1] - p1[1], p2[0] - p1[0]) * 180 / Math.PI;
    const rad = deg * Math.PI / 180;
    const r: Vec2 = [Math.cos(rad), Math.sin(rad)];
    const n: Vec2 = [-r[1], r[0]];
    const measurement = Math.abs((p2[0] - p1[0]) * r[0] + (p2[1] - p1[1]) * r[1]);
    if (!(measurement > 1e-9)) return null;

    const asz = txt, exo = txt / 4, exe = txt / 2, gap = txt / 4;
    const onLine = (p: Vec2): Vec2 => {
        const d = (at[0] - p[0]) * n[0] + (at[1] - p[1]) * n[1];
        return [p[0] + n[0] * d, p[1] + n[1] * d];
    };
    const q1 = onLine(p1), q2 = onLine(p2);

    // Texte lisible : angle ramené dans ]−90°, 90°], au-dessus de la ligne.
    let textAngle = Math.atan2(q2[1] - q1[1], q2[0] - q1[0]);
    if (textAngle > Math.PI / 2 + 1e-9) textAngle -= Math.PI;
    if (textAngle <= -Math.PI / 2 + 1e-9) textAngle += Math.PI;
    const up: Vec2 = [-Math.sin(textAngle), Math.cos(textAngle)];
    const mid: Vec2 = [(q1[0] + q2[0]) / 2 + up[0] * (gap + txt / 2), (q1[1] + q2[1]) / 2 + up[1] * (gap + txt / 2)];

    // Lignes d'attache : du point mesuré (moins l'écart) jusqu'au-delà de la ligne de cote.
    const extensions: [Vec2, Vec2][] = [];
    for (const [p, q] of [[p1, q1], [p2, q2]] as const) {
        const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy);
        if (len <= exo) continue;
        const e: Vec2 = [dx / len, dy / len];
        extensions.push([[p[0] + e[0] * exo, p[1] + e[1] * exo], [q[0] + e[0] * exe, q[1] + e[1] * exe]]);
    }
    // Ligne de cote et flèches, à l'intérieur si elles tiennent.
    const len = Math.hypot(q2[0] - q1[0], q2[1] - q1[1]);
    const d: Vec2 = [(q2[0] - q1[0]) / len, (q2[1] - q1[1]) / len];
    const inside = len >= 2.5 * asz;
    const s = inside ? 1 : -1;
    const a1: Vec2 = inside ? q1 : [q1[0] - d[0] * asz * 2, q1[1] - d[1] * asz * 2];
    const a2: Vec2 = inside ? q2 : [q2[0] + d[0] * asz * 2, q2[1] + d[1] * asz * 2];
    const arrow = (tip: Vec2, dir: number): [Vec2, Vec2, Vec2] => {
        const bx = tip[0] + d[0] * asz * dir, by = tip[1] + d[1] * asz * dir;
        const w = asz / 6;
        return [tip, [bx + n[0] * w, by + n[1] * w], [bx - n[0] * w, by - n[1] * w]];
    };
    return {
        deg,
        measurement,
        q1,
        q2,
        extensions,
        line: [a1, a2],
        arrows: [arrow(q1, s), arrow(q2, -s)],
        mid,
        textAngle: textAngle * 180 / Math.PI
    };
};
