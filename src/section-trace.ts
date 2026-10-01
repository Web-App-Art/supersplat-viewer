import { median } from './tool-utils';

// ARTLIGHT (TKT-238) : traits de la coupe. Les points de la tranche dessinent
// des bandes fines (sol, murs, plafond, terrain) ; on en tire des polylignes
// pour le DXF, sur lesquelles on peut s'accrocher dans AutoCAD ou ArchiCAD.
//
// 1. Grille du profil : cases de 1 cm, agrandies (× 1,25, jusqu'à 10 cm) tant
//    que les cases occupées forment des pointillés plutôt que des traits
//    (nuage clairsemé : LiDAR, niveau de détail grossier). Au plus 4 millions
//    de cases.
// 2. Fermeture 3 × 3 (dilatation puis érosion) : bouche les trous de une ou
//    deux cases le long d'un trait.
// 3. Squelette d'une case d'épaisseur (amincissement de Zhang et Suen).
// 4. Graphe : nœuds aux croisements, traits entre eux. Les ergots courts
//    (bruit sur le bord d'une bande) sont retirés ; deux traits qui se
//    prolongent à un croisement sont recollés.
// 5. Bouts libres raccordés quand les traits se prolongent ; polyligne simplifiée
//    (Douglas-Peucker, une demi-case), puis chaque sommet recentré sur la
//    couche de points la plus dense, en travers du trait.

export interface TracedLine {
    points: number[];           // s, t alternés (m)
    closed: boolean;
}

export interface TraceResult {
    lines: TracedLine[];
    cell: number;               // taille des cases (m)
    tolerance: number;          // écart toléré à la simplification (m)
}

// Au-delà, le tracé prend des points à pas régulier.
const MAX_POINTS = 250000;
const CELL_MIN = 0.01;
const CELL_MAX = 0.1;
const MAX_CELLS = 4e6;
// Cases agrandies jusqu'à ce que 85 % d'entre elles forment des morceaux
// d'au moins 1 m : des traits continus, et non des pointillés. Réglé sur des
// coupes réelles (appartement, Callian, parking du Muy) : il faut de 1 à 5 cm
// selon le nuage.
const CONTINUOUS_LENGTH = 1;
const CONTINUOUS_SHARE = 0.85;
// Ergot : trait libre à un bout, de moins de 4 cases (3 cm au moins).
const SPUR_CELLS = 4;
const SPUR_MIN = 0.03;
// Trait isolé ou boucle plus courts : écartés (10 cm, 6 cases au moins).
const MIN_LENGTH = 0.1;
const MIN_LENGTH_CELLS = 6;
// Deux traits qui se prolongent à un croisement : directions opposées à
// 30° près.
const JOIN_COS = Math.cos(150 * Math.PI / 180);
// Raccord de deux bouts libres : à moins de 5 cases (25 cm au moins), les
// deux traits dans le prolongement l'un de l'autre à 35° près, décalés en
// travers de moins de 30 % de l'écart (ou de deux cases). Les splats d'un
// sol forment souvent des amas espacés de 5 à 20 cm.
const GAP_CELLS = 5;
const GAP_MIN = 0.25;
const GAP_COS = Math.cos(35 * Math.PI / 180);
const GAP_LATERAL = 0.3;
// Recentrage : pas au-delà d'un virage de plus de 40°.
const REFINE_TURN_COS = Math.cos(40 * Math.PI / 180);
const REFINE_SAMPLES = 64;

// Longueur d'une polyligne (s, t alternés).
const polylineLength = (p: number[], closed = false) => {
    let len = 0;
    for (let i = 2; i < p.length; i += 2) len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    if (closed && p.length >= 4) len += Math.hypot(p[0] - p[p.length - 2], p[1] - p[p.length - 1]);
    return len;
};

// Douglas-Peucker itératif.
const simplify = (p: number[], tolerance: number): number[] => {
    const n = p.length / 2;
    if (n <= 2) return p.slice();
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    const stack: [number, number][] = [[0, n - 1]];
    const tol2 = tolerance * tolerance;
    while (stack.length) {
        const [a, b] = stack.pop();
        const ax = p[a * 2], ay = p[a * 2 + 1], dx = p[b * 2] - ax, dy = p[b * 2 + 1] - ay;
        const len2 = dx * dx + dy * dy;
        let worst = -1, index = -1;
        for (let i = a + 1; i < b; i++) {
            const px = p[i * 2] - ax, py = p[i * 2 + 1] - ay;
            let d2: number;
            if (len2 < 1e-18) {
                d2 = px * px + py * py;
            } else {
                const c = px * dy - py * dx;
                d2 = c * c / len2;
            }
            if (d2 > worst) {
                worst = d2;
                index = i;
            }
        }
        if (index >= 0 && worst > tol2) {
            keep[index] = 1;
            stack.push([a, index], [index, b]);
        }
    }
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
    return out;
};

interface Edge {
    points: number[];
    a: number;                  // nœud de départ, -1 : bout libre
    b: number;                  // nœud d'arrivée
    closed: boolean;
    alive: boolean;
}

/**
 * Polylignes de la coupe, dans le repère du profil.
 *
 * @param {Float32Array} points - Points de la tranche (s, t alternés).
 * @param {number} total - Nombre de points.
 * @returns {TraceResult} Polylignes, taille des cases et tolérance.
 */
export const traceSection = (points: Float32Array, total: number): TraceResult => {
    const empty: TraceResult = { lines: [], cell: CELL_MIN, tolerance: CELL_MIN / 2 };
    if (total < 10) return empty;

    // Tranche très fournie (épaisse) : un point sur n suffit au tracé.
    let st = points, count = total;
    if (total > MAX_POINTS) {
        const stride = total / MAX_POINTS;
        count = MAX_POINTS;
        st = new Float32Array(count * 2);
        for (let k = 0; k < count; k++) {
            const i = Math.floor(k * stride);
            st[k * 2] = points[i * 2];
            st[k * 2 + 1] = points[i * 2 + 1];
        }
    }

    let sMin = Infinity, sMax = -Infinity, tMin = Infinity, tMax = -Infinity;
    for (let i = 0; i < count; i++) {
        const s = st[i * 2], t = st[i * 2 + 1];
        if (s < sMin) sMin = s;
        if (s > sMax) sMax = s;
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
    }

    // ── 1. Grille et 2. fermeture ──
    let cell = Math.max(CELL_MIN, Math.sqrt((sMax - sMin + 0.01) * (tMax - tMin + 0.01) / MAX_CELLS));
    let cols = 0, rows = 0, size = 0;
    let N8: number[] = [];
    let img: Uint8Array;
    const cellOf = new Int32Array(count);
    const rasterize = () => {
        cols = Math.floor((sMax - sMin) / cell) + 3;
        rows = Math.floor((tMax - tMin) / cell) + 3;
        size = cols * rows;
        N8 = [-cols - 1, -cols, -cols + 1, 1, cols + 1, cols, cols - 1, -1];
        const grid = new Uint8Array(size);
        for (let i = 0; i < count; i++) {
            const k = (Math.floor((st[i * 2 + 1] - tMin) / cell) + 1) * cols + Math.floor((st[i * 2] - sMin) / cell) + 1;
            cellOf[i] = k;
            grid[k] = 1;
        }
        // Fermeture : dilatation puis érosion. Garde toutes les cases
        // occupées et bouche les trous d'une ou deux cases.
        const dilated = new Uint8Array(size);
        for (let k = cols; k < size - cols; k++) {
            if (!grid[k]) continue;
            dilated[k] = 1;
            for (const d of N8) dilated[k + d] = 1;
        }
        // Bords de la grille laissés vides : leurs voisins passeraient d'un
        // bord à l'autre.
        img = new Uint8Array(size);
        for (let r = 1; r < rows - 1; r++) {
            for (let k = r * cols + 1; k < (r + 1) * cols - 1; k++) {
                if (!dilated[k]) continue;
                let all = 1;
                for (const d of N8) all &= dilated[k + d];
                img[k] = grid[k] | all;
            }
        }
    };
    // Part des cases dans des morceaux d'au moins 1 m : les traits sont-ils
    // continus ?
    const continuity = () => {
        const label = new Uint8Array(size);
        const stack: number[] = [];
        const minCells = Math.max(5, Math.round(CONTINUOUS_LENGTH / cell));
        let total = 0, long = 0;
        for (let k = 0; k < size; k++) {
            if (!img[k] || label[k]) continue;
            let n = 0;
            label[k] = 1;
            stack.push(k);
            while (stack.length) {
                const q = stack.pop();
                n++;
                for (const d of N8) {
                    const r = q + d;
                    if (img[r] && !label[r]) {
                        label[r] = 1;
                        stack.push(r);
                    }
                }
            }
            total += n;
            if (n >= minCells) long += n;
        }
        return total ? long / total : 1;
    };
    rasterize();
    while (cell < CELL_MAX && continuity() < CONTINUOUS_SHARE) {
        cell = Math.min(CELL_MAX, cell * 1.25);
        rasterize();
    }

    // ── 3. Squelette (Zhang et Suen) ──
    // Voisins P2 (dessus) à P9, dans le sens des aiguilles d'une montre.
    let pixels: number[] = [];
    for (let k = 0; k < size; k++) if (img[k]) pixels.push(k);
    const toRemove: number[] = [];
    for (let changed = true; changed;) {
        changed = false;
        for (let pass = 0; pass < 2; pass++) {
            toRemove.length = 0;
            for (const k of pixels) {
                if (!img[k]) continue;
                const P2 = img[k - cols], P3 = img[k - cols + 1], P4 = img[k + 1], P5 = img[k + cols + 1];
                const P6 = img[k + cols], P7 = img[k + cols - 1], P8 = img[k - 1], P9 = img[k - cols - 1];
                const B = P2 + P3 + P4 + P5 + P6 + P7 + P8 + P9;
                if (B < 2 || B > 6) continue;
                const A = (+(!P2 && P3)) + (+(!P3 && P4)) + (+(!P4 && P5)) + (+(!P5 && P6)) +
                    (+(!P6 && P7)) + (+(!P7 && P8)) + (+(!P8 && P9)) + (+(!P9 && P2));
                if (A !== 1) continue;
                if (pass === 0 ? (P2 && P4 && P6) || (P4 && P6 && P8) : (P2 && P4 && P8) || (P2 && P6 && P8)) continue;
                toRemove.push(k);
            }
            for (const k of toRemove) img[k] = 0;
            if (toRemove.length) changed = true;
        }
        const kept: number[] = [];
        for (const k of pixels) if (img[k]) kept.push(k);
        pixels = kept;
    }

    // ── 4. Graphe ──
    const degree = (k: number) => {
        let n = 0;
        for (const d of N8) n += img[k + d];
        return n;
    };
    const center = (k: number): [number, number] => [sMin + ((k % cols) - 0.5) * cell, tMin + (Math.floor(k / cols) - 0.5) * cell];
    const deg = new Map<number, number>();
    for (const k of pixels) deg.set(k, degree(k));

    // Nœuds : groupes de pixels de croisement (3 voisins ou plus) qui se touchent.
    const nodeOf = new Map<number, number>();
    const nodes: { s: number; t: number; edges: number[] }[] = [];
    for (const k of pixels) {
        if (deg.get(k) < 3 || nodeOf.has(k)) continue;
        const id = nodes.length;
        const stack = [k];
        nodeOf.set(k, id);
        let ss = 0, tt = 0, n = 0;
        while (stack.length) {
            const q = stack.pop();
            const [s, t] = center(q);
            ss += s;
            tt += t;
            n++;
            for (const d of N8) {
                const r = q + d;
                if (img[r] && deg.get(r) >= 3 && !nodeOf.has(r)) {
                    nodeOf.set(r, id);
                    stack.push(r);
                }
            }
        }
        nodes.push({ s: ss / n, t: tt / n, edges: [] });
    }

    const edges: Edge[] = [];
    const visited = new Set<number>();
    const addEdge = (points: number[], a: number, b: number, closed: boolean) => {
        const id = edges.length;
        edges.push({ points, a, b, closed, alive: true });
        if (a >= 0) nodes[a].edges.push(id);
        if (b >= 0) nodes[b].edges.push(id);
    };
    // Parcours depuis `first` (venu de `from0`) jusqu'à un nœud, un bout
    // libre ou le point de départ (boucle). Hors des nœuds, un pixel a au plus
    // deux voisins : celui d'où l'on vient et le suivant.
    const walk = (from0: number, first: number, startNode: number) => {
        const pts: number[] = [];
        if (startNode >= 0) pts.push(nodes[startNode].s, nodes[startNode].t);
        let cur = first, from = from0, end = -1, closed = false;
        for (;;) {
            visited.add(cur);
            const [s, t] = center(cur);
            pts.push(s, t);
            let next = -1;
            for (const d of N8) {
                const r = cur + d;
                if (!img[r] || r === from) continue;
                if (nodeOf.has(r) || !visited.has(r)) {
                    next = r;
                    break;
                }
                if (r === first && startNode < 0 && cur !== first) closed = true;
            }
            if (next < 0) break;
            if (nodeOf.has(next)) {
                end = nodeOf.get(next);
                pts.push(nodes[end].s, nodes[end].t);
                break;
            }
            from = cur;
            cur = next;
        }
        addEdge(pts, startNode, end, closed);
    };
    for (const k of pixels) {
        if (!nodeOf.has(k)) continue;
        for (const d of N8) {
            const q = k + d;
            if (img[q] && !nodeOf.has(q) && !visited.has(q)) walk(k, q, nodeOf.get(k));
        }
    }
    for (const k of pixels) {
        if (!visited.has(k) && !nodeOf.has(k) && deg.get(k) === 1) walk(-1, k, -1);
    }
    for (const k of pixels) {
        if (!visited.has(k) && !nodeOf.has(k) && deg.get(k) === 2) walk(-1, k, -1);
    }

    // Ergots, traits recollés
    const other = (e: Edge, node: number) => (e.a === node ? e.b : e.a);
    const reversed = (p: number[]) => {
        const out: number[] = [];
        for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i], p[i + 1]);
        return out;
    };
    // Trait `e` orienté pour partir du nœud `node`.
    const from = (e: Edge, node: number) => (e.a === node ? e.points : reversed(e.points));
    const detach = (e: Edge) => {
        for (const n of [e.a, e.b]) if (n >= 0) nodes[n].edges = nodes[n].edges.filter(id => edges[id] !== e);
    };
    const join = (node: number, i: number, j: number) => {
        const e1 = edges[i], e2 = edges[j];
        const p1 = reversed(from(e1, node)), p2 = from(e2, node);
        const a = other(e1, node), b = other(e2, node);
        detach(e1);
        detach(e2);
        e1.alive = e2.alive = false;
        addEdge(p1.concat(p2.slice(2)), a, b, false);
    };
    const mergeDegreeTwo = () => {
        nodes.forEach((node, id) => {
            const live = node.edges.filter(e => edges[e].alive);
            if (live.length !== 2) return;
            if (live[0] !== live[1]) {
                join(id, live[0], live[1]);
            } else {
                // Boucle seule sur son nœud : polyligne fermée.
                const e = edges[live[0]];
                e.closed = true;
                e.a = e.b = -1;
                e.points = e.points.slice(0, -2);
                node.edges = [];
            }
        });
    };
    const spur = Math.max(SPUR_MIN, SPUR_CELLS * cell);
    const minLength = Math.max(MIN_LENGTH, MIN_LENGTH_CELLS * cell);
    for (let pass = 0; pass < 2; pass++) {
        // Petites boucles sur un nœud : marches d'escalier du squelette.
        for (const e of edges) {
            if (e.alive && e.a >= 0 && e.a === e.b && polylineLength(e.points) < minLength) {
                e.alive = false;
                detach(e);
            }
        }
        for (const e of edges) {
            if (!e.alive || e.closed || (e.a < 0) === (e.b < 0)) continue;
            const node = e.a >= 0 ? e.a : e.b;
            if (nodes[node].edges.length >= 3 && polylineLength(e.points) < spur) {
                e.alive = false;
                detach(e);
            }
        }
        mergeDegreeTwo();
    }
    // Croisements : les deux traits qui se prolongent le mieux sont recollés.
    const direction = (p: number[], reach = Math.max(3 * cell, 0.05)): [number, number] => {
        let i = 2;
        while (i < p.length - 2 && Math.hypot(p[i] - p[0], p[i + 1] - p[1]) < reach) i += 2;
        const dx = p[i] - p[0], dy = p[i + 1] - p[1], len = Math.hypot(dx, dy) || 1;
        return [dx / len, dy / len];
    };
    nodes.forEach((node, id) => {
        for (;;) {
            const live = node.edges.filter(e => edges[e].alive && !(edges[e].a === id && edges[e].b === id));
            if (live.length < 3) return;
            let best = JOIN_COS, pair: [number, number] | null = null;
            const dirs = live.map(e => direction(from(edges[e], id)));
            for (let i = 0; i < live.length; i++) {
                for (let j = i + 1; j < live.length; j++) {
                    const c = dirs[i][0] * dirs[j][0] + dirs[i][1] * dirs[j][1];
                    if (c < best) {
                        best = c;
                        pair = [live[i], live[j]];
                    }
                }
            }
            if (!pair) return;
            join(id, pair[0], pair[1]);
        }
    });

    // ── 5. Simplification et recentrage ──
    // Points par case, pour le recentrage.
    const start = new Int32Array(size + 1);
    for (let i = 0; i < count; i++) start[cellOf[i] + 1]++;
    for (let k = 0; k < size; k++) start[k + 1] += start[k];
    const order = new Int32Array(count);
    const fill = start.slice(0, size);
    for (let i = 0; i < count; i++) order[fill[cellOf[i]]++] = i;

    const tolerance = cell / 2;
    // Couche la plus dense parmi les écarts en travers : pic de
    // l'histogramme (pas d'un dixième de case, lissé), puis médiane des
    // écarts à moins d'un quart de case de ce pic. Une médiane simple se
    // laissait tirer par une seconde surface proche (dessus et chant d'un
    // plan de travail).
    const bin = cell / 10, bins = Math.round(4 * cell / bin);
    const histogram = new Float64Array(bins);
    const offsets: number[] = [];
    const densest = (): number | null => {
        if (offsets.length < 3) return null;
        histogram.fill(0);
        for (const v of offsets) histogram[Math.min(bins - 1, Math.max(0, Math.floor((v + 2 * cell) / bin)))]++;
        let best = -1, peak = 0;
        for (let i = 0; i < bins; i++) {
            const smooth = (histogram[i - 1] ?? 0) + 2 * histogram[i] + (histogram[i + 1] ?? 0);
            if (smooth > best) {
                best = smooth;
                peak = -2 * cell + (i + 0.5) * bin;
            }
        }
        const layer = offsets.filter(v => Math.abs(v - peak) <= cell / 4);
        return layer.length >= 3 ? median(layer.length > REFINE_SAMPLES ? layer.filter((_, i) => i % Math.ceil(layer.length / REFINE_SAMPLES) === 0) : layer) : null;
    };
    const refine = (p: number[], closed: boolean) => {
        const n = p.length / 2;
        const out = p.slice();
        for (let v = 0; v < n; v++) {
            const pi = closed ? (v - 1 + n) % n : Math.max(0, v - 1);
            const ni = closed ? (v + 1) % n : Math.min(n - 1, v + 1);
            if (pi === ni) continue;
            const x = p[v * 2], y = p[v * 2 + 1];
            let ux = p[ni * 2] - p[pi * 2], uy = p[ni * 2 + 1] - p[pi * 2 + 1];
            const ul = Math.hypot(ux, uy);
            if (ul < 1e-9) continue;
            ux /= ul;
            uy /= ul;
            // Virage marqué : on laisse le sommet où il est (un bout de
            // polyligne, lui, est recentré selon son dernier segment).
            const ax = x - p[pi * 2], ay = y - p[pi * 2 + 1], bx = p[ni * 2] - x, by = p[ni * 2 + 1] - y;
            const al = Math.hypot(ax, ay), bl = Math.hypot(bx, by);
            if (pi !== v && ni !== v && al > 1e-9 && bl > 1e-9 && (ax * bx + ay * by) / (al * bl) < REFINE_TURN_COS) continue;
            const c0 = Math.floor((x - sMin) / cell) + 1, r0 = Math.floor((y - tMin) / cell) + 1;
            offsets.length = 0;
            for (let r = r0 - 2; r <= r0 + 2; r++) {
                if (r < 0 || r >= rows) continue;
                for (let c = c0 - 2; c <= c0 + 2; c++) {
                    if (c < 0 || c >= cols) continue;
                    const k = r * cols + c;
                    for (let j = start[k]; j < start[k + 1]; j++) {
                        const i = order[j];
                        const dx = st[i * 2] - x, dy = st[i * 2 + 1] - y;
                        const along = dx * ux + dy * uy, across = dx * -uy + dy * ux;
                        if (Math.abs(along) <= cell && Math.abs(across) < 2 * cell) offsets.push(across);
                    }
                }
            }
            const m = densest();
            if (m === null) continue;
            out[v * 2] = x - uy * m;
            out[v * 2 + 1] = y + ux * m;
        }
        return out;
    };

    // Raccords : deux bouts libres proches, dont les traits se prolongent,
    // sont reliés (amas de splats espacés, objet devant un mur).
    // Du plus court au plus long ; jamais deux bouts d'une même chaîne.
    const open = edges.filter(e => e.alive && !e.closed);
    const ends: { line: number; last: boolean; x: number; y: number; dx: number; dy: number }[] = [];
    open.forEach((e, line) => {
        for (const last of [false, true]) {
            if ((last ? e.b : e.a) >= 0) continue;
            const p = last ? reversed(e.points) : e.points;
            // Direction prise plus loin qu'aux croisements : les marches du
            // squelette faussent la direction d'un bout.
            const [dx, dy] = direction(p, Math.max(5 * cell, 0.1));
            ends.push({ line, last, x: p[0], y: p[1], dx: -dx, dy: -dy });
        }
    });
    const gap = Math.max(GAP_CELLS * cell, GAP_MIN);
    const pairs: [number, number, number][] = [];
    const buckets = new Map<string, number[]>();
    const key = (x: number, y: number) => `${Math.floor(x / gap)},${Math.floor(y / gap)}`;
    ends.forEach((e, i) => {
        const k = key(e.x, e.y);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(i);
    });
    ends.forEach((e, i) => {
        const bx = Math.floor(e.x / gap), by = Math.floor(e.y / gap);
        for (let gx = bx - 1; gx <= bx + 1; gx++) {
            for (let gy = by - 1; gy <= by + 1; gy++) {
                for (const j of buckets.get(`${gx},${gy}`) ?? []) {
                    const f = ends[j];
                    if (j <= i || f.line === e.line) continue;
                    const d = Math.hypot(f.x - e.x, f.y - e.y);
                    if (d > gap) continue;
                    // Deux traits qui se prolongent (directions opposées à
                    // 35° près), l'un en face de l'autre : pas trop décalés
                    // en travers. Sauf deux bouts qui se touchent presque.
                    if (d > 2 * cell) {
                        if (-(e.dx * f.dx + e.dy * f.dy) < GAP_COS) continue;
                        let mx = e.dx - f.dx, my = e.dy - f.dy;
                        const ml = Math.hypot(mx, my);
                        mx /= ml;
                        my /= ml;
                        const gx = f.x - e.x, gy = f.y - e.y;
                        if (mx * gx + my * gy <= 0 || Math.abs(mx * gy - my * gx) > Math.max(2 * cell, GAP_LATERAL * d)) continue;
                    }
                    pairs.push([d, i, j]);
                }
            }
        }
    });
    pairs.sort((a, b) => a[0] - b[0]);
    const chain = open.map((_, i) => i);
    const root = (i: number): number => (chain[i] === i ? i : (chain[i] = root(chain[i])));
    const partner = new Map<number, number>();
    for (const [, i, j] of pairs) {
        if (partner.has(i) || partner.has(j) || root(ends[i].line) === root(ends[j].line)) continue;
        partner.set(i, j);
        partner.set(j, i);
        chain[root(ends[i].line)] = root(ends[j].line);
    }
    // Chaînes : on part d'un bout sans raccord et l'on suit les raccords.
    const endOf = new Map<string, number>();
    ends.forEach((e, i) => endOf.set(`${e.line},${e.last}`, i));
    const used = new Uint8Array(open.length);
    const chains: (TracedLine & { attached: boolean })[] = [];
    const follow = (line: number, fromLast: boolean) => {
        let pts: number[] = [];
        let cur = line, entryLast = fromLast, attached = false;
        for (;;) {
            used[cur] = 1;
            attached ||= open[cur].a >= 0 || open[cur].b >= 0;
            const p = entryLast ? reversed(open[cur].points) : open[cur].points;
            pts = pts.length ? pts.concat(p) : p.slice();
            const exit = endOf.get(`${cur},${!entryLast}`);
            const next = exit === undefined ? undefined : partner.get(exit);
            if (next === undefined) break;
            cur = ends[next].line;
            entryLast = ends[next].last;
        }
        chains.push({ points: pts, closed: false, attached });
    };
    open.forEach((e, i) => {
        if (used[i]) return;
        const startA = endOf.get(`${i},false`), startB = endOf.get(`${i},true`);
        if (startA !== undefined && !partner.has(startA)) follow(i, false);
        else if (startB !== undefined && !partner.has(startB)) follow(i, true);
    });
    // Reste : traits pris entre deux nœuds, ou chaînes raccordées de partout.
    open.forEach((e, i) => {
        if (!used[i]) follow(i, false);
    });
    for (const e of edges) if (e.alive && e.closed) chains.push({ points: e.points, closed: true, attached: false });

    const lines: TracedLine[] = [];
    for (const c of chains) {
        // Trait isolé (sans nœud) ou boucle trop courts : écartés.
        if (!c.attached && polylineLength(c.points, c.closed) < minLength) continue;
        let p = c.points;
        if (c.closed) p = p.concat(p.slice(0, 2));
        p = simplify(p, tolerance);
        if (c.closed) p = p.slice(0, -2);
        if (p.length < 4 || (c.closed && p.length < 6)) continue;
        p = simplify(refine(p, c.closed), tolerance / 2);
        lines.push({ points: p, closed: c.closed });
    }
    return { lines, cell, tolerance };
};
