import { cp1252Byte, dimensionGeometry, formatDimension } from './drawing';
import type { DrawingTarget, TextAlign, TextBaseline, TextOptions, Vec2 } from './drawing';

// ARTLIGHT (TKT-249) : écriture d'un PDF vectoriel, sans dépendance, comme
// dxf.ts pour le DXF. Sert au rapport de coupes (section-pdf.ts), puis au
// rapport de planéité.
//
// - PDF 1.7. Tracés et textes vectoriels ; seules les vignettes de la vue 3D
//   sont des images (JPEG insérés tels quels, DCTDecode).
// - Texte en Helvetica, l'une des 14 polices que tout lecteur PDF connaît :
//   rien à embarquer, texte sélectionnable et cherchable. Encodage
//   WinAnsiEncoding (Windows-1252) : accents pris en charge ; les rares
//   symboles hors de cette page (↔, ≈…) sont remplacés par du texte.
// - Calques PDF (groupes de contenu optionnel) : ceux du DXF. Acrobat les
//   affiche et les masque ; AutoCAD (PDFIMPORT) en fait des calques.
// - Échelle déclarée (viewport /VP et dictionnaire /Measure, ISO 32000) :
//   l'outil de mesure d'Acrobat lit directement des mètres, avec deux
//   échelles pour un profil exagéré.
// - Signets : une entrée par page.
// - Flux compressés par le navigateur (CompressionStream 'deflate').
//
// Unités : le point PDF (1/72 de pouce), origine en bas à gauche de la page.

export const MM = 72 / 25.4;

// Chasse des caractères 32 à 255 (WinAnsiEncoding) d'Helvetica et
// d'Helvetica-Bold, en 1/1000 du corps (métriques Adobe, fichiers AFM).
const WIDTHS = [
    '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,' +
    '1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,' +
    '333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584,0,' +
    '556,0,222,556,333,1000,556,556,333,1000,667,333,1000,0,611,0,0,222,222,333,333,350,556,1000,333,1000,500,333,944,0,500,667,' +
    '278,333,556,556,556,556,260,556,333,737,370,556,584,333,737,333,400,584,333,333,333,556,537,278,333,333,365,556,834,834,834,611,' +
    '667,667,667,667,667,667,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,' +
    '556,556,556,556,556,556,889,500,556,556,556,556,278,278,278,278,556,556,556,556,556,556,556,584,611,556,556,556,556,500,556,500',
    '278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,' +
    '975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,' +
    '333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584,0,' +
    '556,0,278,556,500,1000,556,556,333,1000,667,333,1000,0,611,0,0,278,278,500,500,350,556,1000,333,1000,556,333,944,0,500,667,' +
    '278,333,556,556,556,556,280,556,333,737,370,556,584,333,737,333,400,584,333,333,333,611,556,278,333,333,365,556,834,834,834,611,' +
    '722,722,722,722,722,722,1000,722,667,667,667,667,278,278,278,278,722,722,778,778,778,778,778,584,778,722,722,722,722,667,667,611,' +
    '556,556,556,556,556,556,889,556,556,556,556,556,278,278,278,278,611,611,611,611,611,611,611,584,611,611,611,611,611,556,611,556'
].map(list => list.split(',').map(Number));

// Hauteur des capitales et jambage d'Helvetica, en fraction du corps. Une
// hauteur de texte (comme dans le DXF) est celle des capitales.
export const CAP = 0.718;
const DESCENT = 0.207;

// Symboles hors de Windows-1252, remplacés par du texte.
const REPLACEMENTS: Record<string, string> = {
    '\u2212': '-',
    '\u2194': '<->',
    '\u2195': '^v',
    '\u2248': '~',
    '\u2192': '->',
    '\u2190': '<-',
    '\u2713': '',
    '\u2009': ' ',
    '\u202F': ' ',
    '\u2002': ' ',
    '\u2003': ' ',
    '\u00A0': ' '
};

// Octets WinAnsi d'un texte, sur une ligne. Un symbole « (↔) » d'un
// libellé disparaît avec ses parenthèses.
export const winAnsi = (text: string): number[] => {
    const out: number[] = [];
    for (const ch of text.replace(/\s*\([\u2194\u2195]\)/g, '').replace(/[\r\n\t]+/g, ' ')) {
        const replaced = REPLACEMENTS[ch];
        if (replaced !== undefined) {
            for (const c of replaced) out.push(c.charCodeAt(0));
            continue;
        }
        const byte = cp1252Byte(ch.codePointAt(0));
        out.push(byte !== null && byte >= 32 ? byte : 0x3F);
    }
    return out;
};

/**
 * Largeur d'un texte en Helvetica.
 *
 * @param {string} text - Texte.
 * @param {number} size - Corps (unité quelconque).
 * @param {boolean} [bold] - Helvetica-Bold.
 * @returns {number} Largeur, dans l'unité du corps.
 */
export const textWidth = (text: string, size: number, bold = false): number => {
    const widths = WIDTHS[bold ? 1 : 0];
    let w = 0;
    for (const b of winAnsi(text)) w += widths[b - 32] ?? 556;
    return w * size / 1000;
};

// Nombre d'un flux : deux décimales au plus (1/100 de point, 3,5 µm).
const n = (v: number) => String(Math.round(v * 100) / 100);

// Couleur « #rrggbb » en composantes 0 à 1.
const rgb = (hex: string) => [1, 3, 5].map(i => n(parseInt(hex.slice(i, i + 2), 16) / 255)).join(' ');

// Chaîne littérale du contenu : octets WinAnsi, ( ) \ échappés, octets
// hauts en octal.
const literal = (bytes: number[]) => {
    let s = '(';
    for (const b of bytes) {
        if (b === 0x28 || b === 0x29 || b === 0x5C) s += `\\${String.fromCharCode(b)}`;
        else if (b < 0x20 || b > 0x7E) s += `\\${b.toString(8).padStart(3, '0')}`;
        else s += String.fromCharCode(b);
    }
    return `${s})`;
};

// Chaîne de texte hors du contenu (titres, signets, calques) : littérale
// en ASCII, sinon UTF-16BE.
const textString = (text: string) => {
    if (/^[\x20-\x7E]*$/.test(text)) return literal(Array.from(text, c => c.charCodeAt(0)));
    let hex = 'FEFF';
    for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
    return `<${hex}>`;
};

const pdfDate = (d: Date) => {
    const pad = (v: number) => String(Math.abs(v)).padStart(2, '0');
    const offset = -d.getTimezoneOffset();
    const tz = `${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}'${pad(Math.abs(offset) % 60)}'`;
    return `D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${tz}`;
};

export interface PdfTextOptions {
    bold?: boolean;
    align?: TextAlign;
    baseline?: TextBaseline;
    rotation?: number;          // degrés
}

/**
 * Opérateurs d'un texte : corps `size`, ancré en (x, y) selon l'alignement,
 * tourné autour de ce point. La couleur est celle du remplissage en cours.
 *
 * @param {number} x - Abscisse du point d'ancrage.
 * @param {number} y - Ordonnée du point d'ancrage.
 * @param {number} size - Corps du texte.
 * @param {string} text - Texte.
 * @param {PdfTextOptions} [opts] - Graisse, alignement, rotation.
 * @returns {string} Opérateurs du flux de contenu.
 */
export const textOps = (x: number, y: number, size: number, text: string, opts: PdfTextOptions = {}): string => {
    const bytes = winAnsi(text);
    if (bytes.length === 0) return '';
    const width = textWidth(text, size, opts.bold);
    const dx = { left: 0, center: -width / 2, right: -width }[opts.align ?? 'left'];
    const dy = { baseline: 0, bottom: DESCENT * size, middle: -CAP * size / 2, top: -CAP * size }[opts.baseline ?? 'baseline'];
    const a = (opts.rotation ?? 0) * Math.PI / 180;
    const c = Math.cos(a), s = Math.sin(a);
    const ox = x + dx * c - dy * s, oy = y + dx * s + dy * c;
    const r = (v: number) => String(Math.round(v * 1e4) / 1e4);
    const matrix = a ? `${r(c)} ${r(s)} ${r(-s)} ${r(c)}` : '1 0 0 1';
    return `BT /${opts.bold ? 'F2' : 'F1'} ${n(size)} Tf ${matrix} ${n(ox)} ${n(oy)} Tm ${literal(bytes)} Tj ET\n`;
};

// Cercle en quatre arcs de Bézier.
const circleOps = (cx: number, cy: number, r: number) => {
    const k = r * 0.5523;
    return `${n(cx + r)} ${n(cy)} m ${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c ` +
        `${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c ` +
        `${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c ` +
        `${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c h\n`;
};

// Arc (TKT-264) : centre, rayon, de a0 à a1 (radians, sens
// trigonométrique), en arcs de Bézier d'un quart de tour au plus (écart au
// cercle sous 0,03 % du rayon). Sans fermeture ni tracé.
const arcOps = (cx: number, cy: number, r: number, a0: number, a1: number) => {
    const count = Math.max(1, Math.ceil((a1 - a0) / (Math.PI / 2) - 1e-9));
    const step = (a1 - a0) / count, k = 4 / 3 * Math.tan(step / 4) * r;
    let ops = `${n(cx + r * Math.cos(a0))} ${n(cy + r * Math.sin(a0))} m`;
    for (let i = 0; i < count; i++) {
        const t0 = a0 + i * step, t1 = t0 + step;
        const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
        ops += ` ${n(cx + r * c0 - k * s0)} ${n(cy + r * s0 + k * c0)} ${n(cx + r * c1 + k * s1)} ${n(cy + r * s1 - k * c1)} ${n(cx + r * c1)} ${n(cy + r * s1)} c`;
    }
    return ops;
};

export interface PdfLayer {
    id: string;                 // nom de la ressource (/OC /L1)
    name: string;
    used: boolean;              // un calque vide n'est pas déclaré
}

export interface PdfImage {
    id: string;
    width: number;
    height: number;
    bytes: Uint8Array<ArrayBuffer>;
    components: number;
}

export interface PdfShading {
    id: string;
    body: string;
}

// Échelle déclarée d'une zone de la page (viewport) : mètres par point,
// selon x et selon y (profil exagéré).
export interface PdfMeasure {
    bbox: [number, number, number, number];
    name: string;
    ratio: string;              // « 1:100 », « L 1:100 / H 1:20 »
    mx: number;
    my: number;
    origin: Vec2;               // point de la page de coordonnées (0, 0)
    decimal: string;
}

/**
 * Page : flux de contenu écrit au fil de l'eau.
 */
export class PdfPage {
    readonly width: number;

    readonly height: number;

    readonly ops: string[] = [];

    readonly measures: PdfMeasure[] = [];

    constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
    }

    push(op: string) {
        this.ops.push(op);
    }

    // Contenu d'un calque PDF.
    layer(layer: PdfLayer | null, draw: () => void) {
        if (layer) {
            layer.used = true;
            this.push(`/OC /${layer.id} BDC\n`);
        }
        draw();
        if (layer) this.push('EMC\n');
    }

    save() {
        this.push('q\n');
    }

    restore() {
        this.push('Q\n');
    }

    stroke(color: string, width: number) {
        this.push(`${rgb(color)} RG ${n(width)} w\n`);
    }

    fill(color: string) {
        this.push(`${rgb(color)} rg\n`);
    }

    line(x0: number, y0: number, x1: number, y1: number) {
        this.push(`${n(x0)} ${n(y0)} m ${n(x1)} ${n(y1)} l S\n`);
    }

    rect(x: number, y: number, w: number, h: number, paint: 'S' | 'f' | 'B' | 'W n') {
        this.push(`${n(x)} ${n(y)} ${n(w)} ${n(h)} re ${paint}\n`);
    }

    text(x: number, y: number, size: number, text: string, opts: PdfTextOptions = {}) {
        this.push(textOps(x, y, size, text, opts));
    }

    image(image: PdfImage, x: number, y: number, w: number, h: number) {
        this.push(`q ${n(w)} 0 0 ${n(h)} ${n(x)} ${n(y)} cm /${image.id} Do Q\n`);
    }

    measure(m: PdfMeasure) {
        this.measures.push(m);
    }
}

export interface PdfInfo {
    title: string;
    author?: string;
    subject?: string;
    creator?: string;
    lang?: string;
    date?: Date;
}

// Largeur et hauteur d'un JPEG (segment SOF), nombre de composantes.
const jpegSize = (bytes: Uint8Array): { width: number; height: number; components: number } | null => {
    if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
    let i = 2;
    while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xFF) return null;
        const marker = bytes[i + 1];
        const length = (bytes[i + 2] << 8) | bytes[i + 3];
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
            return {
                height: (bytes[i + 5] << 8) | bytes[i + 6],
                width: (bytes[i + 7] << 8) | bytes[i + 8],
                components: bytes[i + 9]
            };
        }
        i += 2 + length;
    }
    return null;
};

const deflate = async (data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> => {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
};

/**
 * Document PDF : pages, calques, images, signets. toBlob() assemble le
 * fichier.
 */
export class PdfDocument {
    private info: PdfInfo;

    private pages: PdfPage[] = [];

    private layers: PdfLayer[] = [];

    private images: PdfImage[] = [];

    private shadings: PdfShading[] = [];

    private bookmarks: { title: string; page: PdfPage }[] = [];

    constructor(info: PdfInfo) {
        this.info = info;
    }

    addPage(width: number, height: number): PdfPage {
        const page = new PdfPage(width, height);
        this.pages.push(page);
        return page;
    }

    // Calque PDF, créé au premier usage de son nom.
    layer(name: string): PdfLayer {
        let layer = this.layers.find(l => l.name === name);
        if (!layer) {
            layer = { id: `L${this.layers.length + 1}`, name, used: false };
            this.layers.push(layer);
        }
        return layer;
    }

    // Image JPEG insérée telle quelle ; null si le fichier n'est pas lisible.
    jpeg(bytes: Uint8Array<ArrayBuffer>): PdfImage | null {
        const size = jpegSize(bytes);
        if (!size || (size.components !== 1 && size.components !== 3)) return null;
        const image = { id: `Im${this.images.length + 1}`, bytes, ...size };
        this.images.push(image);
        return image;
    }

    // Dégradé axial de (x0, y0) à (x1, y1) : couleurs aux positions 0 à 1.
    axialShading(coords: [number, number, number, number], stops: [number, string][]): PdfShading {
        const functions = stops.slice(1).map((stop, i) => `<< /FunctionType 2 /Domain [0 1] /C0 [${rgb(stops[i][1])}] /C1 [${rgb(stop[1])}] /N 1 >>`);
        const body = `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${coords.map(n).join(' ')}] /Extend [true true] /Function ` +
            `<< /FunctionType 3 /Domain [0 1] /Functions [${functions.join(' ')}] /Bounds [${stops.slice(1, -1).map(s => n(s[0])).join(' ')}] ` +
            `/Encode [${functions.map(() => '0 1').join(' ')}] >> >>`;
        const shading = { id: `Sh${this.shadings.length + 1}`, body };
        this.shadings.push(shading);
        return shading;
    }

    bookmark(title: string, page: PdfPage) {
        this.bookmarks.push({ title, page });
    }

    async toBlob(): Promise<Blob> {
        const encoder = new TextEncoder();
        const layers = this.layers.filter(l => l.used);
        const parts: Uint8Array<ArrayBuffer>[] = [];
        const offsets: number[] = [];
        let size = 0;
        const write = (data: string | Uint8Array<ArrayBuffer>) => {
            const bytes = typeof data === 'string' ? encoder.encode(data) : data;
            parts.push(bytes);
            size += bytes.length;
        };
        let count = 0;
        const reserve = () => ++count;
        const object = (id: number, body: string, stream?: Uint8Array<ArrayBuffer>) => {
            offsets[id] = size;
            write(`${id} 0 obj\n${body}\n`);
            if (stream) {
                write('stream\n');
                write(stream);
                write('\nendstream\n');
            }
            write('endobj\n');
        };

        // En-tête, avec des octets hauts : le fichier est binaire.
        write('%PDF-1.7\n');
        write(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

        const catalog = reserve(), pagesId = reserve(), resources = reserve(), infoId = reserve();
        const fonts = [reserve(), reserve()];
        const layerIds = layers.map(() => reserve());
        const imageIds = this.images.map(() => reserve());
        const shadingIds = this.shadings.map(() => reserve());
        const pageIds = this.pages.map(() => reserve());
        const contentIds = this.pages.map(() => reserve());
        const outlineRoot = this.bookmarks.length ? reserve() : 0;
        const outlineIds = this.bookmarks.map(() => reserve());

        const lang = this.info.lang ? ` /Lang ${textString(this.info.lang)}` : '';
        const order = layerIds.map(id => `${id} 0 R`).join(' ');
        const ocProperties = layers.length ?
            ` /OCProperties << /OCGs [${order}] /D << /Order [${order}] /ON [${order}] /OFF [] >> >>` : '';
        const outlines = outlineRoot ? ` /Outlines ${outlineRoot} 0 R /PageMode /UseOutlines` : '';
        object(catalog, `<< /Type /Catalog /Pages ${pagesId} 0 R${ocProperties}${outlines}${lang} /ViewerPreferences << /DisplayDocTitle true >> >>`);
        object(pagesId, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);

        const named = (prefix: string, items: { id: string }[], ids: number[]) => (items.length ?
            ` /${prefix} << ${items.map((item, i) => `/${item.id} ${ids[i]} 0 R`).join(' ')} >>` : '');
        object(resources, `<< /ProcSet [/PDF /Text /ImageB /ImageC] /Font << /F1 ${fonts[0]} 0 R /F2 ${fonts[1]} 0 R >>` +
            `${named('XObject', this.images, imageIds)}${named('Shading', this.shadings, shadingIds)}${named('Properties', layers, layerIds)} >>`);

        const date = pdfDate(this.info.date ?? new Date());
        const infoEntries = [['Title', this.info.title], ['Author', this.info.author], ['Subject', this.info.subject], ['Creator', this.info.creator]]
        .filter(([, v]) => v).map(([k, v]) => `/${k} ${textString(v)}`).join(' ');
        object(infoId, `<< ${infoEntries} /Producer (Artlight) /CreationDate (${date}) /ModDate (${date}) >>`);

        ['Helvetica', 'Helvetica-Bold'].forEach((name, i) => {
            object(fonts[i], `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`);
        });
        layers.forEach((layer, i) => {
            object(layerIds[i], `<< /Type /OCG /Name ${textString(layer.name)} >>`);
        });
        this.images.forEach((image, i) => {
            object(imageIds[i], `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ` +
                `/ColorSpace /${image.components === 1 ? 'DeviceGray' : 'DeviceRGB'} /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.bytes.length} >>`, image.bytes);
        });
        this.shadings.forEach((shading, i) => object(shadingIds[i], shading.body));

        const contents = await Promise.all(this.pages.map(page => deflate(encoder.encode(page.ops.join('')))));
        for (let p = 0; p < this.pages.length; p++) {
            const page = this.pages[p];
            const viewports = page.measures.map((m) => {
                const format = (unit: string, c: number, digits: number) => `<< /Type /NumberFormat /U ${textString(unit)} /C ${c} /D ${10 ** digits} /RD ${textString(m.decimal)} /RT () >>`;
                const y = Math.abs(m.my - m.mx) > 1e-12 * m.mx ? ` /Y [${format('m', m.my, 3)}] /CYX 1` : '';
                return `<< /Type /Viewport /BBox [${m.bbox.map(n).join(' ')}] /Name ${textString(m.name)} /Measure << /Type /Measure /Subtype /RL ` +
                    `/R ${textString(m.ratio)} /X [${format('m', m.mx, 3)}]${y} /D [${format('m', 1, 3)}] /A [${format('m\u00B2', 1, 2)}] ` +
                    `/O [${n(m.origin[0])} ${n(m.origin[1])}] >> >>`;
            });
            object(pageIds[p], `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${n(page.width)} ${n(page.height)}] ` +
                `/Resources ${resources} 0 R /Contents ${contentIds[p]} 0 R${viewports.length ? ` /VP [${viewports.join(' ')}]` : ''} >>`);
            object(contentIds[p], `<< /Length ${contents[p].length} /Filter /FlateDecode >>`, contents[p]);
        }

        if (outlineRoot) {
            object(outlineRoot, `<< /Type /Outlines /First ${outlineIds[0]} 0 R /Last ${outlineIds[outlineIds.length - 1]} 0 R /Count ${outlineIds.length} >>`);
            this.bookmarks.forEach((b, i) => {
                const links = `${i > 0 ? ` /Prev ${outlineIds[i - 1]} 0 R` : ''}${i < outlineIds.length - 1 ? ` /Next ${outlineIds[i + 1]} 0 R` : ''}`;
                object(outlineIds[i], `<< /Title ${textString(b.title)} /Parent ${outlineRoot} 0 R${links} /Dest [${pageIds[this.pages.indexOf(b.page)]} 0 R /Fit] >>`);
            });
        }

        // Table des renvois : 20 octets par entrée.
        const xref = size;
        let table = `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
        for (let id = 1; id <= count; id++) table += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
        write(table);
        const fileId = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
        write(`trailer\n<< /Size ${count + 1} /Root ${catalog} 0 R /Info ${infoId} 0 R /ID [<${fileId}> <${fileId}>] >>\nstartxref\n${xref}\n%%EOF\n`);
        return new Blob(parts, { type: 'application/pdf' });
    }
}

// Rectangle, dans les unités du dessin.
export interface PdfBox {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

// Style d'un calque du dessin dans le PDF.
export interface PdfLayerStyle {
    layer: PdfLayer;
    color: string;              // « #rrggbb »
    width: number;              // traits (mm)
    thin?: number;              // traits des cotes (mm) ; par défaut, `width`
    dot?: number;               // côté d'un point (mm)
    clip?: boolean;             // coupé au cadre du dessin
    bold?: boolean;             // textes en gras
}

/**
 * Dessin vers une page PDF (interface commune avec le DXF) : unités du
 * dessin converties en points par X = ox + x·s, Y = oy + y·s. Le contenu est
 * rangé par calque, puis écrit par finish() dans l'ordre voulu.
 */
export class PdfDrawing implements DrawingTarget {
    private page: PdfPage;

    private ox: number;

    private oy: number;

    private s: number;

    private styles: Record<string, PdfLayerStyle>;

    private dim: { textHeight: number; decimals: number; decimal: string };

    private buffers = new Map<string, string[]>();

    private lineWidths = new Map<string, number>();

    // Points en attente de remplissage, par calque.
    private dots = new Map<string, number>();

    constructor(page: PdfPage, transform: { ox: number; oy: number; s: number }, styles: Record<string, PdfLayerStyle>,
        dim: { textHeight: number; decimals: number; decimal: string }) {
        this.page = page;
        this.ox = transform.ox;
        this.oy = transform.oy;
        this.s = transform.s;
        this.styles = styles;
        this.dim = dim;
    }

    private X(x: number) {
        return n(this.ox + x * this.s);
    }

    private Y(y: number) {
        return n(this.oy + y * this.s);
    }

    private buffer(layer: string): string[] | null {
        if (!this.styles[layer]) return null;
        let buffer = this.buffers.get(layer);
        if (!buffer) {
            buffer = [];
            this.buffers.set(layer, buffer);
        }
        // Points en attente : remplis avant tout autre tracé du calque.
        if (this.dots.get(layer)) {
            buffer.push('f\n');
            this.dots.set(layer, 0);
        }
        return buffer;
    }

    // Épaisseur du trait (mm), écrite quand elle change.
    private width(layer: string, buffer: string[], mm: number) {
        if (this.lineWidths.get(layer) === mm) return;
        this.lineWidths.set(layer, mm);
        buffer.push(`${n(mm * MM)} w\n`);
    }

    point(layer: string, x: number, y: number) {
        const style = this.styles[layer];
        if (!style) return;
        let buffer = this.buffers.get(layer);
        if (!buffer) {
            buffer = [];
            this.buffers.set(layer, buffer);
        }
        const d = (style.dot ?? 0.2) * MM;
        buffer.push(`${n(this.ox + x * this.s - d / 2)} ${n(this.oy + y * this.s - d / 2)} ${n(d)} ${n(d)} re\n`);
        this.dots.set(layer, (this.dots.get(layer) ?? 0) + 1);
    }

    line(layer: string, a: Vec2, b: Vec2) {
        const buffer = this.buffer(layer);
        if (!buffer) return;
        this.width(layer, buffer, this.styles[layer].width);
        buffer.push(`${this.X(a[0])} ${this.Y(a[1])} m ${this.X(b[0])} ${this.Y(b[1])} l S\n`);
    }

    polyline(layer: string, xy: ArrayLike<number>, closed = false) {
        const count = Math.floor(xy.length / 2);
        const buffer = count >= 2 ? this.buffer(layer) : null;
        if (!buffer) return;
        this.width(layer, buffer, this.styles[layer].width);
        let path = `${this.X(xy[0])} ${this.Y(xy[1])} m`;
        for (let i = 1; i < count; i++) path += ` ${this.X(xy[i * 2])} ${this.Y(xy[i * 2 + 1])} l`;
        buffer.push(`${path}${closed ? ' h' : ''} S\n`);
    }

    circle(layer: string, c: Vec2, r: number) {
        const buffer = this.buffer(layer);
        if (!buffer) return;
        const style = this.styles[layer];
        this.width(layer, buffer, style.thin ?? style.width);
        buffer.push(`${circleOps(this.ox + c[0] * this.s, this.oy + c[1] * this.s, r * this.s)}S\n`);
    }

    arc(layer: string, c: Vec2, r: number, a0: number, a1: number) {
        const buffer = this.buffer(layer);
        if (!buffer) return;
        this.width(layer, buffer, this.styles[layer].width);
        const rad = Math.PI / 180;
        buffer.push(`${arcOps(this.ox + c[0] * this.s, this.oy + c[1] * this.s, r * this.s, a0 * rad, a1 * rad)} S\n`);
    }

    solid(layer: string, pts: Vec2[]) {
        const buffer = this.buffer(layer);
        if (!buffer) return;
        // Ordre du DXF : 1, 2, 3, 4 en « Z » ; le contour passe par 1, 2, 4, 3.
        const ring = pts.length === 4 ? [pts[0], pts[1], pts[3], pts[2]] : pts;
        buffer.push(`${ring.map((p, i) => `${this.X(p[0])} ${this.Y(p[1])} ${i ? 'l' : 'm'}`).join(' ')} h f\n`);
    }

    text(layer: string, at: Vec2, height: number, text: string, opts: TextOptions = {}) {
        const buffer = this.buffer(layer);
        if (!buffer) return;
        buffer.push(textOps(this.ox + at[0] * this.s, this.oy + at[1] * this.s, height * this.s / CAP, text, {
            ...opts,
            bold: this.styles[layer].bold
        }));
    }

    textWidth(text: string, height: number): number {
        return textWidth(text, height / CAP);
    }

    dimension(layer: string, p1: Vec2, p2: Vec2, at: Vec2, angle: number | null, z?: number, text?: string) {
        const g = dimensionGeometry(p1, p2, at, angle, this.dim.textHeight);
        const buffer = g ? this.buffer(layer) : null;
        if (!buffer) return;
        const style = this.styles[layer];
        this.width(layer, buffer, style.thin ?? style.width);
        for (const [a, b] of [...g.extensions, g.line]) buffer.push(`${this.X(a[0])} ${this.Y(a[1])} m ${this.X(b[0])} ${this.Y(b[1])} l S\n`);
        for (const arrow of g.arrows) buffer.push(`${arrow.map((p, i) => `${this.X(p[0])} ${this.Y(p[1])} ${i ? 'l' : 'm'}`).join(' ')} h f\n`);
        this.text(layer, g.mid, this.dim.textHeight, text ?? formatDimension(g.measurement, this.dim.decimals, this.dim.decimal), {
            align: 'center',
            baseline: 'middle',
            rotation: g.textAngle
        });
    }

    /**
     * Écrit le dessin dans la page, calque par calque dans l'ordre donné ;
     * les calques marqués `clip` sont coupés au rectangle `clip` (unités du
     * dessin).
     *
     * @param {string[]} order - Calques, du dessous au dessus.
     * @param {PdfBox} [clip] - Cadre du dessin.
     */
    finish(order: string[], clip?: PdfBox) {
        for (const name of order) {
            const buffer = this.buffers.get(name);
            const style = this.styles[name];
            if (!buffer || !style) continue;
            if (this.dots.get(name)) buffer.push('f\n');
            this.dots.set(name, 0);
            this.page.layer(style.layer, () => {
                this.page.save();
                if (clip && style.clip) {
                    const x = this.ox + clip.x0 * this.s, y = this.oy + clip.y0 * this.s;
                    this.page.rect(x, y, (clip.x1 - clip.x0) * this.s, (clip.y1 - clip.y0) * this.s, 'W n');
                }
                this.page.push(`${rgb(style.color)} RG ${rgb(style.color)} rg 1 J 1 j\n`);
                for (const op of buffer) this.page.push(op);
                this.page.restore();
            });
        }
        this.buffers.clear();
    }
}
