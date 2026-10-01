import { cp1252Byte, dimensionGeometry, formatDimension } from './drawing';
import type { DrawingTarget, TextOptions, Vec2 } from './drawing';

// ARTLIGHT (TKT-238) : écriture d'un fichier DXF, pour reprendre une coupe
// dans AutoCAD, ArchiCAD, Revit, BricsCAD, QGIS…
//
// Version : AutoCAD 2000 (AC1015). Toutes les versions d'AutoCAD depuis 2000
// la lisent, comme les logiciels bâtis sur la bibliothèque ODA (ArchiCAD,
// BricsCAD) et QGIS. Les versions plus récentes n'apportent rien pour une
// coupe ; la R12 ne connaît ni l'unité du dessin ($INSUNITS), ni les
// polylignes légères, ni l'épaisseur des traits.
//
// Unité : le mètre. Texte en Windows-1252 ($DWGCODEPAGE ANSI_1252) ; un
// caractère hors de cette page s'écrit \U+XXXX, comme le fait AutoCAD.
//
// Structure : celle d'un DXF 2000 réduit à l'essentiel (en-tête, classes,
// tables, blocs, entités, objets), sur le modèle de ce qu'écrit ezdxf.
// Chaque cote est une vraie cote (DIMENSION) accompagnée de son bloc dessiné
// (*D1, *D2…) : un logiciel qui ne recalcule pas les cotes les affiche quand
// même.

export interface DxfLayer {
    name: string;
    color: number;          // couleur AutoCAD (ACI) ; 7 : noir sur fond blanc, blanc sur fond noir
    lineweight?: number;    // épaisseur en 1/100 mm
}

export interface DxfDimStyle {
    textHeight: number;     // hauteur du texte des cotes (m)
    decimals: number;
    decimal: string;        // séparateur décimal
}

// Étendue du dessin (m) ; z : altitude du dessin.
export interface DxfExtents {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    z: number;
}

const DIMSTYLE_NAME = 'ARTLIGHT';
const TEXT_STYLE = 'Standard';
const FONT = 'arial.ttf';

const hex = (n: number) => n.toString(16).toUpperCase();

// Nombre sans exposant, `digits` décimales au plus, sans zéros inutiles.
const num = (v: number, digits = 6) => {
    if (!Number.isFinite(v)) return '0.0';
    let s = v.toFixed(digits);
    if (s.includes('.')) s = s.replace(/0+$/, '');
    if (s.endsWith('.')) s += '0';
    if (!s.includes('.')) s += '.0';
    return s === '-0.0' ? '0.0' : s;
};

// Texte d'une entité : sur une ligne, signe moins et espaces insécables
// ramenés à l'ASCII, caractères hors de Windows-1252 en \U+XXXX.
const dxfText = (text: string): string => {
    let out = '';
    for (const ch of text.replace(/[\r\n\t]+/g, ' ')) {
        const code = ch.codePointAt(0);
        if (code === 0x2212) out += '-';
        else if (code === 0x00A0 || code === 0x202F || code === 0x2009) out += ' ';
        else if (ch === '^') out += '^ ';
        else if (cp1252Byte(code) !== null) out += ch;
        else if (code <= 0xFFFF) out += `\\U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
        else out += '?';
    }
    return out;
};

// Paires code / valeur, code aligné à droite sur 3 caractères comme AutoCAD.
const tags = (...pairs: (string | number)[]): string => {
    let out = '';
    for (let i = 0; i < pairs.length; i += 2) {
        out += `${String(pairs[i]).padStart(3)}\r\n${pairs[i + 1]}\r\n`;
    }
    return out;
};

const xyz = (x: number, y: number, z: number, code = 10) => tags(code, num(x), code + 10, num(y), code + 20, num(z));

/**
 * Dessin DXF en mètres, espace objet seulement. Les entités s'ajoutent au fil
 * de l'eau ; toBlob() assemble le fichier.
 */
export class DxfWriter implements DrawingTarget {
    private nextHandle = 1;

    private layers: DxfLayer[];

    private dim: DxfDimStyle;

    // Handles fixes de la structure
    private h: Record<string, string> = {};

    private layerHandles: string[] = [];

    private entities: string[] = [];

    private blocks: { name: string; record: string; begin: string; end: string; body: string }[] = [];

    constructor(layers: DxfLayer[], dim: DxfDimStyle) {
        this.layers = layers;
        this.dim = dim;
        const names = [
            'vportTable', 'ltypeTable', 'layerTable', 'styleTable', 'viewTable', 'ucsTable', 'appidTable',
            'dimstyleTable', 'blockTable', 'vport', 'byBlock', 'byLayer', 'continuous', 'layer0', 'defpoints',
            'style', 'acad', 'dimStandard', 'dimArtlight', 'modelRecord', 'paperRecord', 'modelBegin', 'modelEnd',
            'paperBegin', 'paperEnd', 'root', 'groups', 'layouts', 'modelLayout', 'paperLayout', 'mlineStyles',
            'mlineStandard', 'plotSettings', 'plotStyles', 'plotStyleNormal'
        ];
        for (const name of names) this.h[name] = this.handle();
        this.layerHandles = layers.map(() => this.handle());
    }

    private handle(): string {
        return hex(this.nextHandle++);
    }

    // Début commun des entités : handle, propriétaire, calque (couleur
    // « DuBloc » dans un bloc de cote).
    private head(type: string, layer: string, owner: string, byBlock = false): string {
        return tags(0, type, 5, this.handle(), 330, owner, 100, 'AcDbEntity', 8, layer) + (byBlock ? tags(62, 0) : '');
    }

    private get model() {
        return this.h.modelRecord;
    }

    point(layer: string, x: number, y: number, z = 0) {
        this.entities.push(this.head('POINT', layer, this.model) +
            tags(100, 'AcDbPoint', 10, num(x, 4), 20, num(y, 4), 30, num(z, 4)));
    }

    line(layer: string, a: Vec2, b: Vec2, z = 0) {
        this.entities.push(this.lineEntity(layer, this.model, a, b, z, false));
    }

    private lineEntity(layer: string, owner: string, a: Vec2, b: Vec2, z: number, byBlock: boolean) {
        return this.head('LINE', layer, owner, byBlock) + tags(100, 'AcDbLine') + xyz(a[0], a[1], z) + xyz(b[0], b[1], z, 11);
    }

    // Polyligne légère : sommets x, y alternés, à l'altitude z.
    polyline(layer: string, xy: ArrayLike<number>, closed = false, z = 0) {
        const n = Math.floor(xy.length / 2);
        if (n < 2) return;
        let body = this.head('LWPOLYLINE', layer, this.model) + tags(100, 'AcDbPolyline', 90, n, 70, closed ? 1 : 0);
        if (z !== 0) body += tags(38, num(z));
        for (let i = 0; i < n; i++) body += tags(10, num(xy[i * 2]), 20, num(xy[i * 2 + 1]));
        this.entities.push(body);
    }

    circle(layer: string, c: Vec2, r: number, z = 0) {
        this.entities.push(this.head('CIRCLE', layer, this.model) + tags(100, 'AcDbCircle') + xyz(c[0], c[1], z) + tags(40, num(r)));
    }

    // Triangle ou quadrilatère plein (sommets dans l'ordre du DXF : 1, 2, 3, 4).
    solid(layer: string, pts: Vec2[], z = 0) {
        this.entities.push(this.solidEntity(layer, this.model, pts, z, false));
    }

    private solidEntity(layer: string, owner: string, pts: Vec2[], z: number, byBlock: boolean) {
        const p = [pts[0], pts[1], pts[2], pts[3] ?? pts[2]];
        return this.head('SOLID', layer, owner, byBlock) + tags(100, 'AcDbTrace') + p.map((q, i) => xyz(q[0], q[1], z, 10 + i)).join('');
    }

    text(layer: string, at: Vec2, height: number, text: string, opts: TextOptions = {}, z = 0) {
        this.entities.push(this.textEntity(layer, this.model, at, height, text, opts, z, false));
    }

    private textEntity(layer: string, owner: string, at: Vec2, height: number, text: string, opts: TextOptions, z: number, byBlock: boolean) {
        const h = { left: 0, center: 1, right: 2 }[opts.align ?? 'left'];
        const v = { baseline: 0, bottom: 1, middle: 2, top: 3 }[opts.baseline ?? 'baseline'];
        let body = this.head('TEXT', layer, owner, byBlock) + tags(100, 'AcDbText') + xyz(at[0], at[1], z) +
            tags(40, num(height), 1, dxfText(text));
        if (opts.rotation) body += tags(50, num(opts.rotation));
        body += tags(7, TEXT_STYLE);
        if (h || v) body += tags(72, h) + xyz(at[0], at[1], z, 11);
        body += tags(100, 'AcDbText');
        if (v) body += tags(73, v);
        return body;
    }

    dimensionText(value: number): string {
        return formatDimension(value, this.dim.decimals, this.dim.decimal);
    }

    /**
     * Cote entre p1 et p2, sa ligne passant par `at`. `angle` (degrés) : cote
     * mesurée selon cette direction (0 : horizontale, 90 : verticale) ; null :
     * cote alignée sur p1 p2. Le bloc de la cote est dessiné comme le ferait
     * AutoCAD : lignes d'attache, ligne de cote, flèches pleines, texte au-dessus.
     *
     * @param {string} layer - Calque de la cote.
     * @param {Vec2} p1 - Premier point mesuré.
     * @param {Vec2} p2 - Second point mesuré.
     * @param {Vec2} at - Point par lequel passe la ligne de cote.
     * @param {number | null} angle - Direction mesurée, ou null (alignée).
     * @param {number} [z] - Altitude du dessin.
     * @param {string} [text] - Texte imposé à la place de la mesure (flèche en mm).
     */
    dimension(layer: string, p1: Vec2, p2: Vec2, at: Vec2, angle: number | null, z = 0, text?: string) {
        const g = dimensionGeometry(p1, p2, at, angle, this.dim.textHeight);
        if (!g) return;

        const record = this.handle();
        const name = `*D${this.blocks.length + 1}`;
        let body = '';
        for (const [a, b] of g.extensions) body += this.lineEntity('0', record, a, b, z, true);
        body += this.lineEntity('0', record, g.line[0], g.line[1], z, true);
        for (const arrow of g.arrows) body += this.solidEntity('0', record, arrow, z, true);
        body += this.textEntity('0', record, g.mid, this.dim.textHeight, text ?? this.dimensionText(g.measurement), {
            align: 'center',
            baseline: 'middle',
            rotation: g.textAngle
        }, z, true);
        this.blocks.push({ name, record, begin: this.handle(), end: this.handle(), body });

        const entity = tags(100, 'AcDbDimension', 2, name) +
            xyz(g.q2[0], g.q2[1], z) + xyz(g.mid[0], g.mid[1], z, 11) +
            tags(70, 32, 71, 5, 42, num(g.measurement), 1, text === undefined ? '' : dxfText(text), 3, DIMSTYLE_NAME) +
            tags(100, 'AcDbAlignedDimension') + xyz(p1[0], p1[1], z, 13) + xyz(p2[0], p2[1], z, 14) +
            tags(50, num(g.deg), 100, 'AcDbRotatedDimension');
        this.entities.push(this.head('DIMENSION', layer, this.model) + entity);
    }

    /**
     * Fichier DXF complet. La vue d'ouverture cadre l'étendue donnée.
     *
     * @param {DxfExtents} extents - Étendue du dessin.
     * @returns {Blob} Fichier encodé en Windows-1252.
     */
    toBlob(extents: DxfExtents): Blob {
        const text = this.header(extents) + tags(0, 'SECTION', 2, 'CLASSES') + this.classes() + tags(0, 'ENDSEC') +
            this.tables(extents) + this.blocksSection() +
            tags(0, 'SECTION', 2, 'ENTITIES') + this.entities.join('') + tags(0, 'ENDSEC') +
            this.objects() + tags(0, 'EOF');
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) {
            bytes[i] = cp1252Byte(text.charCodeAt(i)) ?? 0x3F;
        }
        return new Blob([bytes], { type: 'application/dxf' });
    }

    private header(e: DxfExtents): string {
        const { textHeight: txt, decimals } = this.dim;
        const v = (name: string, ...pairs: (string | number)[]) => tags(9, name, ...pairs);
        return tags(0, 'SECTION', 2, 'HEADER') +
            v('$ACADVER', 1, 'AC1015') +
            v('$ACADMAINTVER', 70, 6) +
            v('$DWGCODEPAGE', 3, 'ANSI_1252') +
            v('$INSBASE', 10, '0.0', 20, '0.0', 30, '0.0') +
            tags(9, '$EXTMIN') + xyz(e.x0, e.y0, e.z) +
            tags(9, '$EXTMAX') + xyz(e.x1, e.y1, e.z) +
            v('$LIMMIN', 10, num(e.x0), 20, num(e.y0)) +
            v('$LIMMAX', 10, num(e.x1), 20, num(e.y1)) +
            v('$TEXTSIZE', 40, num(txt)) +
            v('$TEXTSTYLE', 7, TEXT_STYLE) +
            v('$CLAYER', 8, '0') +
            v('$DIMSCALE', 40, '1.0') +
            v('$DIMASZ', 40, num(txt)) +
            v('$DIMEXO', 40, num(txt / 4)) +
            v('$DIMEXE', 40, num(txt / 2)) +
            v('$DIMTXT', 40, num(txt)) +
            v('$DIMTAD', 70, 1) +
            v('$DIMZIN', 70, 8) +
            v('$DIMSTYLE', 2, DIMSTYLE_NAME) +
            v('$DIMGAP', 40, num(txt / 4)) +
            v('$DIMDEC', 70, decimals) +
            v('$DIMDSEP', 70, this.dim.decimal.charCodeAt(0)) +
            v('$DIMLUNIT', 70, 2) +
            v('$LUNITS', 70, 2) +
            v('$LUPREC', 70, decimals) +
            v('$AUNITS', 70, 0) +
            v('$AUPREC', 70, 2) +
            v('$PDMODE', 70, 0) +
            v('$PDSIZE', 40, '0.0') +
            v('$HANDSEED', 5, hex(this.nextHandle)) +
            v('$MEASUREMENT', 70, 1) +
            v('$INSUNITS', 70, 6) +
            tags(0, 'ENDSEC');
    }

    // Objets à classe du DXF 2000 utilisés dans OBJECTS.
    private classes(): string {
        return [
            ['ACDBDICTIONARYWDFLT', 'AcDbDictionaryWithDefault'],
            ['ACDBPLACEHOLDER', 'AcDbPlaceHolder'],
            ['LAYOUT', 'AcDbLayout']
        ].map(([name, cpp]) => tags(0, 'CLASS', 1, name, 2, cpp, 3, 'ObjectDBX Classes', 90, 0, 280, 0, 281, 0)).join('');
    }

    private tables(e: DxfExtents): string {
        const h = this.h;
        const table = (name: string, handle: string, count: number, records: string, extra = '') => tags(0, 'TABLE', 2, name, 5, handle, 330, 0, 100, 'AcDbSymbolTable', 70, count) + extra + records + tags(0, 'ENDTAB');
        const record = (type: string, handle: string, owner: string, sub: string, name: string, handleCode = 5) => tags(0, type, handleCode, handle, 330, owner, 100, 'AcDbSymbolTableRecord', 100, sub, 2, name, 70, 0);

        // Vue d'ouverture : tout le dessin, un peu de marge, pour un écran 16/10.
        const w = Math.max(e.x1 - e.x0, 1e-3), ht = Math.max(e.y1 - e.y0, 1e-3);
        const viewHeight = Math.max(ht, w / 1.6) * 1.08;
        const vport = record('VPORT', h.vport, h.vportTable, 'AcDbViewportTableRecord', '*Active') +
            tags(10, '0.0', 20, '0.0', 11, '1.0', 21, '1.0', 12, num((e.x0 + e.x1) / 2), 22, num((e.y0 + e.y1) / 2),
                13, '0.0', 23, '0.0', 14, '1.0', 24, '1.0', 15, '1.0', 25, '1.0', 16, '0.0', 26, '0.0', 36, '1.0',
                17, '0.0', 27, '0.0', 37, '0.0', 40, num(viewHeight), 41, '1.6', 42, '50.0', 43, '0.0', 44, '0.0',
                50, '0.0', 51, '0.0', 71, 0, 72, 1000, 73, 1, 74, 3, 75, 0, 76, 0, 77, 0, 78, 0, 281, 0, 65, 0, 146, '0.0');

        const ltype = (handle: string, name: string, description: string) => record('LTYPE', handle, h.ltypeTable, 'AcDbLinetypeTableRecord', name) +
            tags(3, description, 72, 65, 73, 0, 40, '0.0');

        const layer = (handle: string, name: string, color: number, lineweight: number, plot = true) => record('LAYER', handle, h.layerTable, 'AcDbLayerTableRecord', name) +
            tags(62, color, 6, 'Continuous') + (plot ? '' : tags(290, 0)) + tags(370, lineweight, 390, h.plotStyleNormal);

        const dimstyle = (handle: string, name: string, txt: number, decimals: number, separator: string) => record('DIMSTYLE', handle, h.dimstyleTable, 'AcDbDimStyleTableRecord', name, 105) +
            tags(3, '', 4, '', 40, '1.0', 41, num(txt), 42, num(txt / 4), 43, num(txt * 1.5), 44, num(txt / 2), 45, '0.0', 46, '0.0',
                47, '0.0', 48, '0.0', 140, num(txt), 141, num(txt), 142, '0.0', 143, '39.37007874', 144, '1.0', 145, '0.0', 146, '1.0',
                147, num(txt / 4), 148, '0.0', 71, 0, 72, 0, 73, 0, 74, 0, 75, 0, 76, 0, 77, 1, 78, 8, 79, 3, 170, 0, 171, 2, 172, 1,
                173, 0, 174, 0, 175, 0, 176, 0, 177, 0, 178, 0, 179, 2, 271, decimals, 272, decimals, 273, 2, 274, 2, 275, 0, 276, 0,
                277, 2, 278, separator.charCodeAt(0), 279, 0, 280, 0, 281, 0, 282, 0, 283, 0, 284, 8, 285, 0, 286, 0, 288, 0, 289, 3,
                340, h.style, 371, -2, 372, -2);

        const blockRecord = (handle: string, name: string, layout: string) => tags(0, 'BLOCK_RECORD', 5, handle, 330, h.blockTable, 100, 'AcDbSymbolTableRecord', 100, 'AcDbBlockTableRecord', 2, name, 340, layout);

        return tags(0, 'SECTION', 2, 'TABLES') +
            table('VPORT', h.vportTable, 1, vport) +
            table('LTYPE', h.ltypeTable, 3, ltype(h.byBlock, 'ByBlock', '') + ltype(h.byLayer, 'ByLayer', '') + ltype(h.continuous, 'Continuous', 'Solid line')) +
            table('LAYER', h.layerTable, 2 + this.layers.length,
                layer(h.layer0, '0', 7, -3) + layer(h.defpoints, 'Defpoints', 7, -3, false) +
                this.layers.map((l, i) => layer(this.layerHandles[i], l.name, l.color, l.lineweight ?? -3)).join('')) +
            table('STYLE', h.styleTable, 1, record('STYLE', h.style, h.styleTable, 'AcDbTextStyleTableRecord', TEXT_STYLE) +
                tags(40, '0.0', 41, '1.0', 50, '0.0', 71, 0, 42, num(this.dim.textHeight), 3, FONT, 4, '')) +
            table('VIEW', h.viewTable, 0, '') +
            table('UCS', h.ucsTable, 0, '') +
            table('APPID', h.appidTable, 1, record('APPID', h.acad, h.appidTable, 'AcDbRegAppTableRecord', 'ACAD')) +
            table('DIMSTYLE', h.dimstyleTable, 2,
                dimstyle(h.dimStandard, 'Standard', 2.5, 2, '.') +
                dimstyle(h.dimArtlight, DIMSTYLE_NAME, this.dim.textHeight, this.dim.decimals, this.dim.decimal),
                tags(100, 'AcDbDimStyleTable')) +
            table('BLOCK_RECORD', h.blockTable, 2 + this.blocks.length,
                blockRecord(h.modelRecord, '*Model_Space', h.modelLayout) +
                blockRecord(h.paperRecord, '*Paper_Space', h.paperLayout) +
                this.blocks.map(b => blockRecord(b.record, b.name, '0')).join('')) +
            tags(0, 'ENDSEC');
    }

    private blocksSection(): string {
        const h = this.h;
        const block = (name: string, record: string, begin: string, end: string, flags: number, body: string) => tags(0, 'BLOCK', 5, begin, 330, record, 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockBegin', 2, name, 70, flags) +
            xyz(0, 0, 0) + tags(3, name, 1, '') + body +
            tags(0, 'ENDBLK', 5, end, 330, record, 100, 'AcDbEntity', 8, '0', 100, 'AcDbBlockEnd');
        return tags(0, 'SECTION', 2, 'BLOCKS') +
            block('*Model_Space', h.modelRecord, h.modelBegin, h.modelEnd, 0, '') +
            block('*Paper_Space', h.paperRecord, h.paperBegin, h.paperEnd, 0, '') +
            this.blocks.map(b => block(b.name, b.record, b.begin, b.end, 1, b.body)).join('') +
            tags(0, 'ENDSEC');
    }

    private objects(): string {
        const h = this.h;
        const dict = (handle: string, owner: string, entries: [string, string][], type = 'DICTIONARY') => tags(0, type, 5, handle, 330, owner, 100, 'AcDbDictionary', 281, 1) +
            entries.map(([name, ref]) => tags(3, name, 350, ref)).join('');
        // Présentations « Model » et « Layout1 », réglages d'impression par défaut (A3).
        const layout = (handle: string, name: string, flags: number, order: number, record: string) => tags(0, 'LAYOUT', 5, handle, 330, h.layouts, 100, 'AcDbPlotSettings',
            1, '', 4, 'A3', 6, '', 40, '7.5', 41, '20.0', 42, '7.5', 43, '20.0', 44, '420.0', 45, '297.0', 46, '0.0', 47, '0.0',
            48, '0.0', 49, '0.0', 140, '0.0', 141, '0.0', 142, '1.0', 143, '1.0', 70, flags, 72, 1, 73, 0, 74, 5, 7, '', 75, 16,
            76, 0, 77, 2, 78, 300, 147, '1.0', 148, '0.0', 149, '0.0', 100, 'AcDbLayout', 1, name, 70, 1, 71, order,
            10, '0.0', 20, '0.0', 11, '420.0', 21, '297.0', 12, '0.0', 22, '0.0', 32, '0.0', 14, '1e+20', 24, '1e+20', 34, '1e+20',
            15, '-1e+20', 25, '-1e+20', 35, '-1e+20', 146, '0.0', 13, '0.0', 23, '0.0', 33, '0.0', 16, '1.0', 26, '0.0', 36, '0.0',
            17, '0.0', 27, '1.0', 37, '0.0', 76, 1, 330, record);
        return tags(0, 'SECTION', 2, 'OBJECTS') +
            dict(h.root, '0', [['ACAD_GROUP', h.groups], ['ACAD_LAYOUT', h.layouts], ['ACAD_MLINESTYLE', h.mlineStyles],
                ['ACAD_PLOTSETTINGS', h.plotSettings], ['ACAD_PLOTSTYLENAME', h.plotStyles]]) +
            dict(h.groups, h.root, []) +
            dict(h.layouts, h.root, [['Model', h.modelLayout], ['Layout1', h.paperLayout]]) +
            dict(h.mlineStyles, h.root, [['Standard', h.mlineStandard]]) +
            dict(h.plotSettings, h.root, []) +
            dict(h.plotStyles, h.root, [['Normal', h.plotStyleNormal]], 'ACDBDICTIONARYWDFLT') +
            tags(100, 'AcDbDictionaryWithDefault', 340, h.plotStyleNormal) +
            tags(0, 'ACDBPLACEHOLDER', 5, h.plotStyleNormal, 330, h.plotStyles) +
            layout(h.modelLayout, 'Model', 1024, 0, h.modelRecord) +
            layout(h.paperLayout, 'Layout1', 0, 1, h.paperRecord) +
            tags(0, 'MLINESTYLE', 5, h.mlineStandard, 330, h.mlineStyles, 100, 'AcDbMlineStyle', 2, 'Standard', 70, 0, 3, '',
                62, 256, 51, '90.0', 52, '90.0', 71, 2, 49, '0.5', 62, 256, 6, 'BYLAYER', 49, '-0.5', 62, 256, 6, 'BYLAYER') +
            tags(0, 'ENDSEC');
    }
}
