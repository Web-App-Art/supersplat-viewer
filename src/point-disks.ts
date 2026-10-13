// ARTLIGHT (TKT-287)
//
// En mode nuage, chaque point est dessiné comme un disque plein à bord net,
// et non plus comme une gaussienne : celle-ci (écart-type = diamètre / 4,
// voir scripts/las-to-splats.mjs) donnait des bords flous, de grosses taches
// près de la caméra et une image baveuse à mi-distance. Le bord du disque est
// adouci sur un pixel, sans quoi il crénèle et scintille en mouvement.
//
// Le quad du moteur s'étend à 2√2 écarts-types : en coordonnées du quad
// (gaussianUV), un disque du diamètre du point a un rayon de √0,5. La taille
// du pixel en coordonnées du quad se lit sur la dérivée à l'écran de
// gaussianUV, constante sur le quad (ses quatre coins sont à la même
// profondeur).
//
// Seule la passe principale change : la passe de visée du picker garde la
// gaussienne, et Point XYZ vise exactement comme avant.
//
// Près de la caméra, un point du relevé brut ou de bruit faisait une tache de
// 20 à 40 px : le rayon est plafonné à l'écran. Le plafond est en pixels CSS,
// converti à chaque image en pixels du rendu (densité de l'écran, résolution
// réduite en mouvement). Plus bas que 8 px, un mur vu à un mètre se troue :
// le relevé n'est pas assez dense.
//
// Réglages d'essai : `?points=soft` (gaussiennes d'avant), ou
// `?points=scale:1,px:6` (rayon relatif au demi-diamètre du point, rayon
// maximal à l'écran en pixels CSS, 0 = sans limite).

import { type AppBase, ShaderChunks } from 'playcanvas';

type PointDiskOptions = {
    // Rayon du disque rapporté au demi-diamètre du point.
    scale: number;
    // Rayon maximal à l'écran, en pixels CSS ; 0 = sans limite.
    maxRadiusPx: number;
};

// Rayon par défaut : la demi-diagonale du voxel. Les points d'un niveau
// grossier ont un diamètre de deux fois le côté du voxel
// (scripts/las-to-splats.mjs), choisi pour que des gaussiennes molles couvrent
// un mur sans trame ; un disque plein y suffit avec √2 fois le côté. À ce
// diamètre plein, les disques se chevauchaient en taches.
const DEFAULT_OPTIONS: PointDiskOptions = {
    scale: Math.SQRT1_2,
    maxRadiusPx: 8
};

// Rayon du disque d'un point, en coordonnées du quad, quand scale = 1.
const POINT_RADIUS_UV = Math.SQRT1_2;

/**
 * Lit le paramètre d'essai `points`.
 *
 * @param {string | undefined} param - Valeur de `?points`.
 * @returns {PointDiskOptions | null} Les réglages, ou null pour garder les gaussiennes.
 */
const parsePointDiskOptions = (param: string | undefined): PointDiskOptions | null => {
    if (param === 'soft') {
        return null;
    }
    const options = { ...DEFAULT_OPTIONS };
    for (const entry of (param ?? '').split(',')) {
        const [key, value] = entry.split(':');
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0) {
            continue;
        }
        if (key === 'scale' && number > 0) {
            options.scale = number;
        } else if (key === 'px') {
            options.maxRadiusPx = number;
        }
    }
    return options;
};

// Littéral flottant valide en GLSL comme en WGSL.
const float = (value: number) => {
    const text = String(value);
    return /[.e]/.test(text) ? text : `${text}.0`;
};

// Motif insensible aux blancs : l'indentation des chunks du moteur peut changer.
const loosePattern = (text: string) => new RegExp(text.trim().split(/\s+/)
.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
.join('\\s+'));

const GLSL_SEARCH = loosePattern(`    mediump float A = dot(gaussianUV, gaussianUV);
    if (A > 1.0) {
        discard;
    }
    mediump float alpha = normExp(A) * gaussianColor.a;`);

const glslReplacement = (radius: string) => `    mediump float A = dot(gaussianUV, gaussianUV);
    #if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
        if (A > 1.0) {
            discard;
        }
        mediump float alpha = normExp(A) * gaussianColor.a;
    #else
        float uvPerPx = max(length(vec2(dFdx(gaussianUV.x), dFdy(gaussianUV.x))), 1e-6);
        float discRadius = pointDiscMaxPx > 0.0 ? min(${radius}, pointDiscMaxPx * uvPerPx) : ${radius};
        float coverage = clamp((discRadius - sqrt(A)) / uvPerPx + 0.5, 0.0, 1.0);
        if (coverage <= 0.0) {
            discard;
        }
        mediump float alpha = coverage * gaussianColor.a;
    #endif`;

const WGSL_SEARCH = loosePattern(`    let A: half = dot(gaussianUV, gaussianUV);
    if (A > half(1.0)) {
        discard;
    }
    var alpha: half = normExp(A) * gaussianColor.a;`);

const wgslReplacement = (radius: string) => `    let A: half = dot(gaussianUV, gaussianUV);
    #if defined(SHADOW_PASS) || defined(PICK_PASS) || defined(PREPASS_PASS)
        if (A > half(1.0)) {
            discard;
        }
        var alpha: half = normExp(A) * gaussianColor.a;
    #else
        let discUv = vec2f(gaussianUV);
        let uvPerPx = max(length(vec2f(dpdx(discUv.x), dpdy(discUv.x))), 1e-6);
        let discRadius = select(${radius}, min(${radius}, uniform.pointDiscMaxPx * uvPerPx), uniform.pointDiscMaxPx > 0.0);
        let coverage = clamp((discRadius - length(discUv)) / uvPerPx + 0.5, 0.0, 1.0);
        if (coverage <= 0.0) {
            discard;
        }
        var alpha: half = half(coverage) * gaussianColor.a;
    #endif`;

// Plafond du rayon à l'écran, en pixels du rendu (0 = sans limite), posé à
// chaque image ; la passe de visée ne s'en sert pas.
const GLSL_DECLARATION = `
#if !defined(SHADOW_PASS) && !defined(PICK_PASS) && !defined(PREPASS_PASS)
    uniform float pointDiscMaxPx;
#endif
`;

const WGSL_DECLARATION = `
#if !defined(SHADOW_PASS) && !defined(PICK_PASS) && !defined(PREPASS_PASS)
    uniform pointDiscMaxPx: f32;
#endif
`;

/**
 * Remplace la gaussienne des points par un disque net dans le chunk gsplatPS
 * (GLSL et WGSL). À appeler avant le premier rendu du nuage, et avant que le
 * picker ne patche à son tour le chunk : il en garde la version courante et
 * la remet en place quand il est libéré.
 *
 * @param {AppBase} app - L'application.
 * @param {string | undefined} param - Valeur de `?points`.
 */
const applyPointDisks = (app: AppBase, param: string | undefined) => {
    const options = parsePointDiskOptions(param);
    if (!options) {
        return;
    }

    const device = app.graphicsDevice;
    const radius = float(POINT_RADIUS_UV * options.scale);

    const glsl = ShaderChunks.get(device, 'glsl');
    const wgsl = ShaderChunks.get(device, 'wgsl');
    const glslChunk = glsl.get('gsplatPS');
    const wgslChunk = wgsl.get('gsplatPS');

    // Un moteur dont le chunk a changé garde ses gaussiennes plutôt que de
    // recevoir un shader à moitié patché.
    if (!GLSL_SEARCH.test(glslChunk) || !WGSL_SEARCH.test(wgslChunk)) {
        console.warn('point-disks : chunk gsplatPS inattendu, points laissés en gaussiennes.');
        return;
    }

    glsl.set('gsplatPS', GLSL_DECLARATION + glslChunk.replace(GLSL_SEARCH, glslReplacement(radius)));
    wgsl.set('gsplatPS', WGSL_DECLARATION + wgslChunk.replace(WGSL_SEARCH, wgslReplacement(radius)));

    const maxPxId = device.scope.resolve('pointDiscMaxPx');
    app.on('prerender', () => {
        const { canvas } = device;
        const renderScale = canvas.clientWidth ? canvas.width / canvas.clientWidth : 1;
        maxPxId.setValue(options.maxRadiusPx * renderScale);
    });
};

export { applyPointDisks };
