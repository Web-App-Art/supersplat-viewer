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
// Le moteur applique aussi cette opacité réduite dans la passe de visée, où le
// picker accumule les profondeurs pondérées par l'opacité : la profondeur
// visée serait la moyenne de tous les points le long du rayon, à travers les
// murs. Le chunk gsplatVS est patché pour que seule la passe principale passe
// en vision X : Point XYZ, Coupe et les autres outils visent toujours la
// surface la plus proche, comme hors vision X.
//
// Les disques nets de point-disks.ts s'appliquent aussi : l'opacité d'un point
// est sa couverture du pixel fois l'opacité réduite.

import {
    type AppBase,
    FILTER_NEAREST,
    PIXELFORMAT_RGBA8,
    ShaderChunks,
    Texture
} from 'playcanvas';

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

// Seule la passe principale passe en vision X. Motifs insensibles aux blancs :
// l'indentation des chunks du moteur peut changer.
const PASS_GUARD = '#if defined(GSPLAT_OVERDRAW) && !defined(PICK_PASS) && !defined(PREPASS_PASS) && !defined(SHADOW_PASS)';
const GLSL_SEARCH = /#ifdef\s+GSPLAT_OVERDRAW(\s+float\s+t\s*=)/;
const WGSL_SEARCH = /#ifdef\s+GSPLAT_OVERDRAW(\s+let\s+t\s*:\s*f32\s*=)/;

const clampIntensity = (value: number) => {
    return Number.isFinite(value) ? Math.min(XRAY_INTENSITY_MAX, Math.max(XRAY_INTENSITY_MIN, value)) : XRAY_INTENSITY_DEFAULT;
};

class PointXray {
    private app: AppBase;

    private ramp: Texture;

    private _enabled = false;

    private _intensity = XRAY_INTENSITY_DEFAULT;

    constructor(app: AppBase) {
        this.app = app;

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

    private apply() {
        const { gsplat } = this.app.scene;
        gsplat.colorRamp = this._enabled ? this.ramp : null;
        gsplat.colorRampIntensity = this._intensity;
        this.app.renderNextFrame = true;
    }
}

/**
 * Prépare la vision X : patche gsplatVS (GLSL et WGSL) pour que la passe de
 * visée garde l'opacité des points. À appeler avant le premier rendu du nuage.
 *
 * @param {AppBase} app - L'application.
 * @returns {PointXray | null} La vision X, ou null si le chunk du moteur a changé.
 */
const createPointXray = (app: AppBase): PointXray | null => {
    const device = app.graphicsDevice;
    const glsl = ShaderChunks.get(device, 'glsl');
    const wgsl = ShaderChunks.get(device, 'wgsl');
    const glslChunk = glsl.get('gsplatVS');
    const wgslChunk = wgsl.get('gsplatVS');

    // Sans le patch, la visée traverserait les murs : pas de vision X plutôt
    // qu'une vision X qui fausse les mesures.
    if (!GLSL_SEARCH.test(glslChunk) || !WGSL_SEARCH.test(wgslChunk)) {
        console.warn('point-xray : chunk gsplatVS inattendu, vision X indisponible.');
        return null;
    }

    glsl.set('gsplatVS', glslChunk.replace(GLSL_SEARCH, `${PASS_GUARD}$1`));
    wgsl.set('gsplatVS', wgslChunk.replace(WGSL_SEARCH, `${PASS_GUARD}$1`));

    return new PointXray(app);
};

export { createPointXray, PointXray, XRAY_INTENSITY_DEFAULT, XRAY_INTENSITY_MAX, XRAY_INTENSITY_MIN };
