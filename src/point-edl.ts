// ARTLIGHT (TKT-287)
//
// Contours façon EDL (eye-dome lighting, comme CloudCompare et Potree) en
// mode nuage : un pixel nettement plus loin que ses voisins est assombri,
// d'autant plus que l'écart de profondeur (en log) est grand. Les arêtes
// ressortent (angles, embrasures, corniches, silhouettes) : les pièces aux
// murs blancs se lisent mieux. Interrupteur « Contours des points » dans le
// panneau Paramètres.
//
// La profondeur vient du CameraFrame du moteur : les points l'écrivent dans
// une cible de plus pendant la passe principale (scene.gsplat.sceneDepthWrite,
// inverse de la profondeur, mélangée comme la couleur), sans seconde passe sur
// les splats. Le moteur ne la demande que pour certains effets (TAA, DoF,
// SSAO) : on la force sur la passe de la caméra. L'ombrage est ajouté à la
// fin de la passe de composition (chunks composeDeclarationsPS et
// composeMainEndPS).
//
// Avec les disques de point-disks.ts, un disque a une seule profondeur : il
// est opaque, et la profondeur écrite est celle du point le plus proche.

import {
    type AppBase,
    type CameraComponent,
    type CameraFrame,
    type GraphicsDevice,
    PIXELFORMAT_R16F,
    ShaderChunks
} from 'playcanvas';

type PointEdlOptions = {
    // Distance des voisins, en pixels CSS (convertie en pixels du rendu).
    radius: number;
    // Intensité (celle de Potree : 1).
    strength: number;
    // Écart de profondeur ignoré, en log2 (0,003 ≈ 0,2 % de la distance) :
    // le bruit d'un disque à l'autre sur une surface.
    threshold: number;
    // Écart maximal compté par voisin, en log2 : un grand saut (fenêtre,
    // silhouette) assombrit sans noircir.
    cap: number;
};

// Voisins à 45° d'intervalle, à la distance `radius`.
const EDL_WGSL = /* wgsl */ `
var uSceneDepthMap: texture_2d<uff>;
uniform pointEdlParams: vec4f;  // x : 1 / far, y : rayon (px), z : intensité, w : seuil
uniform pointEdlCap: f32;       // écart maximal compté par voisin

fn pointEdlLogDepth(texel: vec2i, size: vec2i) -> f32 {
    let recip = textureLoad(uSceneDepthMap, clamp(texel, vec2i(0), size - vec2i(1)), 0).r;
    // fond (effacé à 1 / far) : aussi loin que possible, il n'assombrit pas
    return -log2(max(recip, uniform.pointEdlParams.x));
}

fn applyPointEdl(color: vec3f, uv: vec2f) -> vec3f {
    let size = vec2i(textureDimensions(uSceneDepthMap, 0));
    let texel = vec2i(uv * vec2f(size));
    let recip = textureLoad(uSceneDepthMap, texel, 0).r;
    if (uniform.pointEdlParams.z <= 0.0 || recip <= uniform.pointEdlParams.x * 1.002) {
        return color;
    }
    let depth = -log2(recip);
    var sum = 0.0;
    for (var i = 0; i < 8; i++) {
        let angle = f32(i) * 0.7853982;
        let offset = vec2i(round(vec2f(cos(angle), sin(angle)) * uniform.pointEdlParams.y));
        sum += clamp(depth - pointEdlLogDepth(texel + offset, size) - uniform.pointEdlParams.w, 0.0, uniform.pointEdlCap);
    }
    return color * exp(-sum * (300.0 / 8.0) * uniform.pointEdlParams.z);
}
`;

const EDL_GLSL = /* glsl */ `
uniform highp sampler2D uSceneDepthMap;
uniform vec4 pointEdlParams;  // x : 1 / far, y : rayon (px), z : intensité, w : seuil
uniform float pointEdlCap;     // écart maximal compté par voisin

float pointEdlLogDepth(ivec2 texel, ivec2 size) {
    float recip = texelFetch(uSceneDepthMap, clamp(texel, ivec2(0), size - ivec2(1)), 0).r;
    // fond (effacé à 1 / far) : aussi loin que possible, il n'assombrit pas
    return -log2(max(recip, pointEdlParams.x));
}

vec3 applyPointEdl(vec3 color, vec2 uv) {
    ivec2 size = textureSize(uSceneDepthMap, 0);
    ivec2 texel = ivec2(uv * vec2(size));
    float recip = texelFetch(uSceneDepthMap, texel, 0).r;
    if (pointEdlParams.z <= 0.0 || recip <= pointEdlParams.x * 1.002) {
        return color;
    }
    float depth = -log2(recip);
    float sum = 0.0;
    for (int i = 0; i < 8; i++) {
        float angle = float(i) * 0.7853982;
        ivec2 offset = ivec2(round(vec2(cos(angle), sin(angle)) * pointEdlParams.y));
        sum += clamp(depth - pointEdlLogDepth(texel + offset, size) - pointEdlParams.w, 0.0, pointEdlCap);
    }
    return color * exp(-sum * (300.0 / 8.0) * pointEdlParams.z);
}
`;

const EDL_MAIN_END = 'result = applyPointEdl(result, uv);';

// Réglages retenus sur Saint-Germain (13/10/2026). Sans seuil, chaque disque
// (une seule profondeur) fait une marche avec ses voisins : les murs obliques
// se couvraient d'écailles. Le seuil (1,4 % de la distance, 7 cm à 5 m) ne
// garde que les vraies arêtes : silhouettes, embrasures, corniches, angles.
const DEFAULT_OPTIONS: PointEdlOptions = {
    radius: 1.4,
    strength: 0.3,
    threshold: 0.02,
    cap: 0.05
};

/**
 * Lit les réglages d'essai de l'EDL dans `?points` : `edl:<intensité>`
 * (0 = éteint), `edlr:<rayon en pixels>`, `edlt:<seuil>`, `edlc:<plafond>`.
 *
 * @param {string | undefined} param - Valeur de `?points`.
 * @returns {PointEdlOptions} Les réglages.
 */
const parsePointEdlOptions = (param: string | undefined): PointEdlOptions => {
    const options = { ...DEFAULT_OPTIONS };
    for (const entry of (param ?? '').split(',')) {
        const [key, value] = entry.split(':');
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0) {
            continue;
        }
        if (key === 'edl') {
            options.strength = number;
        } else if (key === 'edlr' && number > 0) {
            options.radius = number;
        } else if (key === 'edlt') {
            options.threshold = number;
        } else if (key === 'edlc' && number > 0) {
            options.cap = number;
        }
    }
    return options;
};

type FramePassLike = {
    sanitizeOptions: (options: Record<string, unknown>) => Record<string, unknown>;
    sceneTexturesUnsupportedReason: (options: Record<string, unknown>) => string | null;
    sceneDepthFormat: number;
};

class PointEdl {
    options: PointEdlOptions;

    // Contours affichés (interrupteur du panneau Paramètres). Éteints, le
    // CameraFrame n'écrit plus la profondeur ; s'il ne sert à rien d'autre,
    // viewer.ts le retire.
    active = true;

    private app: AppBase;

    private attached = new WeakSet<object>();

    /**
     * @param {AppBase} app - L'application.
     * @param {CameraComponent} camera - La caméra.
     * @param {PointEdlOptions} options - Réglages des contours.
     */
    constructor(app: AppBase, camera: CameraComponent, options: PointEdlOptions) {
        this.app = app;
        this.options = { ...options };

        const device = app.graphicsDevice;
        app.scene.gsplat.sceneDepthWrite = true;

        const glsl = ShaderChunks.get(device, 'glsl');
        const wgsl = ShaderChunks.get(device, 'wgsl');
        glsl.set('composeDeclarationsPS', EDL_GLSL);
        glsl.set('composeMainEndPS', EDL_MAIN_END);
        wgsl.set('composeDeclarationsPS', EDL_WGSL);
        wgsl.set('composeMainEndPS', EDL_MAIN_END);

        // Réglages passés par uniform à chaque image : far suit la caméra
        // (ajusté à la scène dans viewer.ts).
        const params = new Float32Array(4);
        const paramsId = device.scope.resolve('pointEdlParams');
        const capId = device.scope.resolve('pointEdlCap');
        app.on('prerender', () => {
            // le rendu suit la densité de l'écran et baisse en mouvement
            const { canvas } = device;
            const renderScale = canvas.clientWidth ? canvas.width / canvas.clientWidth : 1;
            params[0] = 1 / camera.farClip;
            params[1] = Math.max(1, this.options.radius * renderScale);
            params[2] = this.active ? this.options.strength : 0;
            params[3] = this.options.threshold;
            paramsId.setValue(params);
            capId.setValue(this.options.cap);
        });
    }

    /**
     * Fait écrire la profondeur dans la passe principale d'un CameraFrame
     * activé, à appeler avant son `update()`. Le moteur ne la demande que pour
     * les effets qui la lisent ; ses autres conditions (device, MSAA,
     * effacement) restent les siennes.
     *
     * @param {CameraFrame} cameraFrame - Le CameraFrame de la caméra.
     */
    attach(cameraFrame: CameraFrame) {
        const pass = (cameraFrame as unknown as { renderPassCamera: FramePassLike | null }).renderPassCamera;
        if (!pass || this.attached.has(pass)) {
            return;
        }
        this.attached.add(pass);

        // Profondeur en float 16 bits plutôt que 32 : chaque fragment de point
        // la mélange. Vue d'avion de Saint-Germain à 20 M (M1 Max) : +10 ms de
        // GPU par image en 32 bits, +7 ms en 16 bits. L'inverse de la
        // profondeur y garde 0,05 % de précision, bien en deçà du seuil des
        // contours.
        if (this.app.graphicsDevice.getRenderableHdrFormat([PIXELFORMAT_R16F], false, 1, true) === PIXELFORMAT_R16F) {
            Object.defineProperty(pass, 'sceneDepthFormat', { get: () => PIXELFORMAT_R16F });
        }

        const sanitize = pass.sanitizeOptions.bind(pass);
        pass.sanitizeOptions = (input) => {
            const out = sanitize(input);
            if (this.active && !out.sceneTextureDepth && !out.prepassEnabled && !pass.sceneTexturesUnsupportedReason(out)) {
                out.sceneTextureDepth = true;
            }
            return out;
        };
    }

    /**
     * Réglage à chaud (essais du banc) ; une intensité nulle éteint l'ombrage.
     *
     * @param {Partial<PointEdlOptions>} options - Réglages à changer.
     */
    set(options: Partial<PointEdlOptions>) {
        Object.assign(this.options, options);
        this.app.renderNextFrame = true;
    }
}

/**
 * Vrai si le device sait écrire la profondeur des splats pendant la passe
 * principale (cible float rendable, mélange indépendant par cible).
 *
 * @param {typeof CameraFrame} cameraFrameClass - La classe CameraFrame du moteur.
 * @param {GraphicsDevice} device - Le device graphique.
 * @returns {boolean} true si l'EDL est possible.
 */
const pointEdlSupported = (cameraFrameClass: typeof CameraFrame, device: GraphicsDevice) => {
    return cameraFrameClass.isSplatSceneDepthSupported(device);
};

export { PointEdl, parsePointEdlOptions, pointEdlSupported };
export type { PointEdlOptions };
