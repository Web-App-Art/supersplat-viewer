// ARTLIGHT (TKT-288)
//
// « Vision X » en mode nuage : tous les points en vert, très transparents, en
// mélange additif et sans masquage par la profondeur. Là où les points
// s'empilent (murs vus de biais, planchers, angles), l'image s'éclaircit : on
// lit la structure du bâtiment à travers les murs. Fond noir, ciel masqué.
//
// Le moteur a déjà ce rendu : c'est son mode « overdraw » (scene.gsplat.
// colorRamp). Avec une rampe, chaque point prend la couleur de la rampe à sa
// hauteur, son opacité est multipliée par colorRampIntensity / 32, et le
// mélange devient additif (plus besoin de tri). La rampe est ici d'une seule
// teinte. Le passage d'un mode à l'autre ne recharge rien : le moteur change
// un define du matériau (shader compilé une fois, puis en cache).
//
// En WebGPU, le moteur dessine les points avec son rendu hybride (chunk
// gsplatHybridVS, projection en compute) ; en WebGL, avec le rendu par quads
// (chunk gsplatVS). Les deux sont patchés.
//
// Avec le rendu par quads, le moteur applique aussi l'opacité réduite dans la
// passe de visée, où le picker accumule les profondeurs pondérées par
// l'opacité : la profondeur visée serait la moyenne de tous les points le long
// du rayon, à travers les murs. gsplatVS est patché pour que seule la passe
// principale passe en vision X. Le rendu hybride vise avec un matériau à part,
// sans overdraw. Point XYZ, Coupe et les autres outils visent donc toujours la
// surface la plus proche, comme hors vision X.
//
// Les disques nets de point-disks.ts s'appliquent aussi : l'opacité d'un point
// est sa couverture du pixel fois l'opacité réduite.
//
// Opacité selon la distance : en additif, chaque point compte autant, qu'il
// soit à 2 m ou à 30 m. Or au loin, beaucoup de surfaces tiennent dans peu de
// pixels : une masse lointaine (le jardin vu du salon) faisait une grosse
// tache claire et les formes proches se lisaient moins bien. L'opacité d'un
// point est multipliée par (référence / distance)^puissance, plafonnée : plus
// opaque en deçà de la référence, plus discret au-delà. La référence est la
// distance de ce que l'on regarde : médiane de 9 rayons lancés sur la
// collision autour du centre de l'écran, lissée dans le temps (le bâtiment en
// vue d'avion, le mur d'en face dans une pièce), quel que soit le mode de
// caméra. Sans collision ou sans impact, la distance de la caméra à son
// centre (tenue à jour en orbite seulement).
//
// Réglages d'essai : `?xray=p:2,max:4,ref:5` (puissance, 0 = sans effet de la
// distance ; plafond du multiplicateur ; référence fixe en mètres, au lieu des
// rayons).

import {
    type AppBase,
    type CameraComponent,
    FILTER_NEAREST,
    PIXELFORMAT_RGBA8,
    ShaderChunks,
    Texture,
    Vec3
} from 'playcanvas';

import type { Collision } from './collision';

const tmpDir = new Vec3();

// Teinte des points : un vert franc. Le rouge et le bleu, faibles, montent
// quand les points s'empilent et les zones denses tirent vers le blanc.
const XRAY_COLOR = [64, 255, 96];

// Intensité (colorRampIntensity) : opacité d'un point = intensité / 32.
// Bornes du curseur, en puissances de deux. Sous 1/4, l'opacité d'un point
// (1/128) tombe vers le seuil alphaClip du moteur (1/255) et les points
// disparaissent ; à 32, un point est opaque. Par défaut 1/2 : sur
// Saint-Germain, 1/4 lit le mieux les étages en vue d'avion et 1 le salon
// (la végétation du jardin, très dense, sature dès 4).
const XRAY_INTENSITY_MIN = 0.25;
const XRAY_INTENSITY_MAX = 32;
const XRAY_INTENSITY_DEFAULT = 0.5;

// Rayons de la référence : grille 3 × 3 autour du centre de l'écran, portée
// maximale, et bornes de la référence (m).
const REFERENCE_RAYS = [0.3, 0.5, 0.7];
const REFERENCE_RANGE = 500;
const REFERENCE_MIN = 1;
const REFERENCE_MAX = 200;
// Lissage : part de l'écart rattrapée à chaque image (une image sur deux
// environ en 60 ms à 60 i/s).
const REFERENCE_SMOOTHING = 0.15;

type XrayDepthOptions = {
    // Puissance de la loi de distance ; 0 = opacité indépendante de la distance.
    power: number;
    // Multiplicateur maximal, pour les points très proches.
    max: number;
    // Référence fixe en mètres ; 0 = celle des rayons.
    reference: number;
};

// Puissance 2 : sur Saint-Germain, le jardin vu du salon ne sature plus (13 %
// des pixels saturés → 0,3 %) et la tache claire au cœur du bâtiment en vue
// d'avion disparaît ; à 1, l'effet est à mi-chemin. La luminosité moyenne
// baisse d'autant dans les deux vues : l'intensité par défaut reste 1/2.
const DEFAULT_DEPTH_OPTIONS: XrayDepthOptions = {
    power: 2,
    max: 4,
    reference: 0
};

/**
 * Lit le paramètre d'essai `xray`.
 *
 * @param {string | undefined} param - Valeur de `?xray`.
 * @returns {XrayDepthOptions} Les réglages.
 */
const parseXrayOptions = (param: string | undefined): XrayDepthOptions => {
    const options = { ...DEFAULT_DEPTH_OPTIONS };
    for (const entry of (param ?? '').split(',')) {
        const [key, value] = entry.split(':');
        const number = Number(value);
        if (!Number.isFinite(number) || number < 0) {
            continue;
        }
        if (key === 'p') {
            options.power = number;
        } else if (key === 'max' && number > 0) {
            options.max = number;
        } else if (key === 'ref') {
            options.reference = number;
        }
    }
    return options;
};

// Seule la passe principale passe en vision X. Motifs insensibles aux blancs :
// l'indentation des chunks du moteur peut changer.
const PASS_GUARD = '#if defined(GSPLAT_OVERDRAW) && !defined(PICK_PASS) && !defined(PREPASS_PASS) && !defined(SHADOW_PASS)';
const GLSL_SEARCH = /#ifdef\s+GSPLAT_OVERDRAW(\s+float\s+t\s*=)/;
const WGSL_SEARCH = /#ifdef\s+GSPLAT_OVERDRAW(\s+let\s+t\s*:\s*f32\s*=)/;

// Opacité multipliée par le poids de la distance.
const GLSL_ALPHA_SEARCH = /clr\.a\s*\*=\s*\(1\.0\s*\/\s*32\.0\)\s*\*\s*colorRampIntensity\s*;/;
const GLSL_ALPHA = 'clr.a *= (1.0 / 32.0) * colorRampIntensity * min(pow(xrayDepthRef / max(-center.view.z, 0.05), xrayDepthPower), xrayDepthMax);';
const WGSL_ALPHA_SEARCH = /clr\.a\s*=\s*clr\.a\s*\*\s*half\(1\.0\s*\/\s*32\.0\)\s*\*\s*half\(uniform\.colorRampIntensity\)\s*;/;
const WGSL_ALPHA = 'clr.a = clr.a * half(1.0 / 32.0) * half(uniform.colorRampIntensity * min(pow(uniform.xrayDepthRef / max(-center.view.z, 0.05), uniform.xrayDepthPower), uniform.xrayDepthMax));';

// Rendu hybride (WebGPU) : même loi, sur la profondeur déjà calculée.
const HYBRID_ALPHA_SEARCH = /let\s+outAlpha\s*=\s*alpha\s*\*\s*half\(1\.0\s*\/\s*32\.0\)\s*\*\s*half\(uniform\.colorRampIntensity\)\s*;/;
const HYBRID_ALPHA = 'let outAlpha = alpha * half(1.0 / 32.0) * half(uniform.colorRampIntensity * min(pow(uniform.xrayDepthRef / max(viewDepth, 0.05), uniform.xrayDepthPower), uniform.xrayDepthMax));';

const GLSL_UNIFORM_SEARCH = /uniform\s+float\s+colorRampIntensity\s*;/;
const GLSL_UNIFORMS = 'uniform float colorRampIntensity;\n    uniform float xrayDepthRef;\n    uniform float xrayDepthPower;\n    uniform float xrayDepthMax;';
const WGSL_UNIFORM_SEARCH = /uniform\s+colorRampIntensity\s*:\s*f32\s*;/;
const WGSL_UNIFORMS = 'uniform colorRampIntensity: f32;\n    uniform xrayDepthRef: f32;\n    uniform xrayDepthPower: f32;\n    uniform xrayDepthMax: f32;';

const clampIntensity = (value: number) => {
    return Number.isFinite(value) ? Math.min(XRAY_INTENSITY_MAX, Math.max(XRAY_INTENSITY_MIN, value)) : XRAY_INTENSITY_DEFAULT;
};

class PointXray {
    private app: AppBase;

    private ramp: Texture;

    private _enabled = false;

    private _intensity = XRAY_INTENSITY_DEFAULT;

    private camera: CameraComponent;

    // Loi de distance (lue à chaque image).
    options: XrayDepthOptions;

    // Référence lissée, en mètres ; 0 = à reprendre sans lissage.
    private smoothedReference = 0;

    // Collision de la scène, pour la référence (null : pas encore arrivée ou
    // absente).
    collision: Collision | null = null;

    // Distance de repli : celle de la caméra à son centre.
    fallbackReference: () => number = () => 4;

    constructor(app: AppBase, camera: CameraComponent, options: XrayDepthOptions) {
        this.app = app;
        this.camera = camera;
        this.options = options;

        const { scope } = app.graphicsDevice;
        const refId = scope.resolve('xrayDepthRef');
        const powerId = scope.resolve('xrayDepthPower');
        const maxId = scope.resolve('xrayDepthMax');
        app.on('prerender', () => {
            if (!this._enabled) return;
            const { reference, power, max } = this.options;
            refId.setValue(reference > 0 ? reference : this.updateReference());
            powerId.setValue(power);
            maxId.setValue(max);
        });

        // Rampe d'une seule teinte (le moteur la lit selon la hauteur du point).
        this.ramp = new Texture(app.graphicsDevice, {
            name: 'point-xray-ramp',
            width: 2,
            height: 1,
            format: PIXELFORMAT_RGBA8,
            mipmaps: false,
            minFilter: FILTER_NEAREST,
            magFilter: FILTER_NEAREST,
            levels: [new Uint8Array([...XRAY_COLOR, 255, ...XRAY_COLOR, 255])]
        });
    }

    set enabled(value: boolean) {
        this._enabled = value;
        this.apply();
    }

    get enabled() {
        return this._enabled;
    }

    set intensity(value: number) {
        this._intensity = clampIntensity(value);
        this.apply();
    }

    get intensity() {
        return this._intensity;
    }

    /**
     * Distance de ce que l'on regarde, lissée.
     *
     * @returns {number} La référence, en mètres.
     */
    private updateReference() {
        const target = this.measureReference() ?? this.fallbackReference();
        const clamped = Math.min(REFERENCE_MAX, Math.max(REFERENCE_MIN, Number.isFinite(target) ? target : 4));
        if (this.smoothedReference > 0) {
            this.smoothedReference += (clamped - this.smoothedReference) * REFERENCE_SMOOTHING;
            // tant que la référence bouge, l'image doit suivre
            if (Math.abs(clamped - this.smoothedReference) > 0.01 * clamped) {
                this.app.renderNextFrame = true;
            }
        } else {
            this.smoothedReference = clamped;
        }
        return this.smoothedReference;
    }

    /**
     * Médiane des distances de 9 rayons lancés sur la collision.
     *
     * @returns {number | null} La distance en mètres, ou null sans impact.
     */
    private measureReference(): number | null {
        const { collision, camera } = this;
        if (!collision) return null;
        const { canvas } = this.app.graphicsDevice;
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (!width || !height) return null;

        const origin = camera.entity.getPosition();
        const distances: number[] = [];
        for (const fy of REFERENCE_RAYS) {
            for (const fx of REFERENCE_RAYS) {
                camera.screenToWorld(fx * width, fy * height, 1, tmpDir);
                tmpDir.sub(origin).normalize();
                const hit = collision.queryRay(origin.x, origin.y, origin.z, tmpDir.x, tmpDir.y, tmpDir.z, REFERENCE_RANGE);
                if (hit) {
                    distances.push(Math.hypot(hit.x - origin.x, hit.y - origin.y, hit.z - origin.z));
                }
            }
        }
        // moins de la moitié des rayons touchent : le ciel domine
        if (distances.length < 5) return null;
        distances.sort((a, b) => a - b);
        return distances[distances.length >> 1];
    }

    private apply() {
        this.smoothedReference = 0;
        const { gsplat } = this.app.scene;
        gsplat.colorRamp = this._enabled ? this.ramp : null;
        gsplat.colorRampIntensity = this._intensity;
        this.app.renderNextFrame = true;
    }
}

/**
 * Prépare la vision X : patche gsplatVS (GLSL et WGSL) et gsplatHybridVS
 * (loi de distance, passe de visée intacte). À appeler avant le premier rendu
 * du nuage.
 *
 * @param {AppBase} app - L'application.
 * @param {CameraComponent} camera - La caméra principale.
 * @param {string | undefined} param - Valeur de `?xray`.
 * @returns {PointXray | null} La vision X, ou null si le chunk du moteur a changé.
 */
const createPointXray = (app: AppBase, camera: CameraComponent, param: string | undefined): PointXray | null => {
    const device = app.graphicsDevice;
    const glsl = ShaderChunks.get(device, 'glsl');
    const wgsl = ShaderChunks.get(device, 'wgsl');
    const glslChunk = glsl.get('gsplatVS');
    const wgslChunk = wgsl.get('gsplatVS');
    const hybridChunk = wgsl.get('gsplatHybridVS');

    // Sans le patch, la visée traverserait les murs : pas de vision X plutôt
    // qu'une vision X qui fausse les mesures.
    if (![GLSL_SEARCH, GLSL_ALPHA_SEARCH, GLSL_UNIFORM_SEARCH].every(re => re.test(glslChunk)) ||
        ![WGSL_SEARCH, WGSL_ALPHA_SEARCH, WGSL_UNIFORM_SEARCH].every(re => re.test(wgslChunk)) ||
        ![HYBRID_ALPHA_SEARCH, WGSL_UNIFORM_SEARCH].every(re => re.test(hybridChunk ?? ''))) {
        console.warn('point-xray : chunk gsplatVS inattendu, vision X indisponible.');
        return null;
    }

    glsl.set('gsplatVS', glslChunk
    .replace(GLSL_SEARCH, `${PASS_GUARD}$1`)
    .replace(GLSL_ALPHA_SEARCH, GLSL_ALPHA)
    .replace(GLSL_UNIFORM_SEARCH, GLSL_UNIFORMS));
    wgsl.set('gsplatVS', wgslChunk
    .replace(WGSL_SEARCH, `${PASS_GUARD}$1`)
    .replace(WGSL_ALPHA_SEARCH, WGSL_ALPHA)
    .replace(WGSL_UNIFORM_SEARCH, WGSL_UNIFORMS));
    wgsl.set('gsplatHybridVS', hybridChunk
    .replace(HYBRID_ALPHA_SEARCH, HYBRID_ALPHA)
    .replace(WGSL_UNIFORM_SEARCH, WGSL_UNIFORMS));

    return new PointXray(app, camera, parseXrayOptions(param));
};

export { createPointXray, PointXray, XRAY_INTENSITY_DEFAULT, XRAY_INTENSITY_MAX, XRAY_INTENSITY_MIN };
