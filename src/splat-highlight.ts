import type { GSplatComponent, Vec3 } from 'playcanvas';

import { findShownGsplat, releaseWorkBufferModifier } from './interior'; // ARTLIGHT (TKT-272)
import type { Global } from './types';

// ARTLIGHT: surbrillance des splats dont le centre est dans une boîte orientée
// (TKT-170, cubature). Passe par le point d'extension officiel des splats
// « unified » : un modificateur de work buffer (`modifySplatColor`) appliqué
// quand le moteur recopie les splats dans son buffer de rendu. La boîte est
// passée en uniforms, donc la déplacer ne recompile pas le shader : il suffit
// de redemander la recopie des splats.

const TINT = '0.518, 0.8, 0.086';   // $clr-accent (#84cc16)
const TINT_AMOUNT = '0.55';

const GLSL = `
uniform vec3 uVolBoxCenter;
uniform vec3 uVolBoxAxisX;
uniform vec3 uVolBoxAxisZ;
uniform vec3 uVolBoxHalf;
void modifySplatCenter(inout vec3 center) {
}
void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
}
void modifySplatColor(vec3 center, inout vec4 color) {
    vec3 d = center - uVolBoxCenter;
    vec3 local = vec3(dot(d, uVolBoxAxisX), d.y, dot(d, uVolBoxAxisZ));
    if (all(lessThanEqual(abs(local), uVolBoxHalf))) {
        color.rgb = mix(color.rgb, vec3(${TINT}), ${TINT_AMOUNT});
    }
}
`;

const WGSL = `
uniform uVolBoxCenter: vec3f;
uniform uVolBoxAxisX: vec3f;
uniform uVolBoxAxisZ: vec3f;
uniform uVolBoxHalf: vec3f;
fn modifySplatCenter(center: ptr<function, vec3f>) {
}
fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
}
fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let d = center - uniform.uVolBoxCenter;
    let local = vec3f(dot(d, uniform.uVolBoxAxisX), d.y, dot(d, uniform.uVolBoxAxisZ));
    if (all(abs(local) <= uniform.uVolBoxHalf)) {
        *color = vec4f(mix((*color).rgb, vec3f(${TINT}), ${TINT_AMOUNT}), (*color).a);
    }
}
`;

// `setParameter` et `setWorkBufferModifier` redemandent la recopie du
// placement principal ; depuis le moteur 2.23, les placements des fichiers
// LOD la suivent d'eux-mêmes (ARTLIGHT, TKT-280 : en 2.20, il fallait les
// marquer un par un). Reste à demander une image, le rendu étant à la demande.
const markPlacementsDirty = (global: Global) => {
    global.app.renderNextFrame = true;
};

class SplatBoxHighlight {
    private global: Global;

    // Composant sur lequel le modificateur est posé (la scène peut changer
    // via les portails).
    private component: GSplatComponent | null = null;

    constructor(global: Global) {
        this.global = global;
    }

    // Met en surbrillance les splats de la boîte : centre, axes horizontaux
    // (la verticale est l'axe Y monde) et demi-dimensions sur ces axes.
    set(center: Vec3, axisX: Vec3, axisZ: Vec3, halfExtents: Vec3) {
        const entity = findShownGsplat(this.global); // ARTLIGHT (TKT-272) : pas le modèle masqué
        const comp = (entity as any)?.gsplat as GSplatComponent | undefined;
        if (!comp) return;

        if (comp !== this.component) {
            this.clear();
            comp.setWorkBufferModifier({ glsl: GLSL, wgsl: WGSL });
            this.component = comp;
        }

        comp.setParameter('uVolBoxCenter', new Float32Array([center.x, center.y, center.z]));
        comp.setParameter('uVolBoxAxisX', new Float32Array([axisX.x, axisX.y, axisX.z]));
        comp.setParameter('uVolBoxAxisZ', new Float32Array([axisZ.x, axisZ.y, axisZ.z]));
        comp.setParameter('uVolBoxHalf', new Float32Array([halfExtents.x, halfExtents.y, halfExtents.z]));
        this.markDirty();
    }

    clear() {
        const comp = this.component;
        if (!comp) return;
        this.component = null;

        releaseWorkBufferModifier(comp); // ARTLIGHT (TKT-272) : un modèle masqué le reste
        for (const name of ['uVolBoxCenter', 'uVolBoxAxisX', 'uVolBoxAxisZ', 'uVolBoxHalf']) {
            comp.deleteParameter(name);
        }
        this.markDirty();
    }

    private markDirty() {
        markPlacementsDirty(this.global);
    }
}

// ARTLIGHT (TKT-238) : coupe. Les splats du côté avant du plan (au-delà de la
// demi-épaisseur, côté normale) sont masqués ; ceux de la tranche, limitée
// par les demi-dimensions sur les axes X et Y du plan, sont teintés.
const SECTION_GLSL = `
uniform vec3 uSecCenter;
uniform vec3 uSecAxisX;
uniform vec3 uSecAxisY;
uniform vec3 uSecNormal;
uniform vec3 uSecHalf;
uniform float uSecClip;
void modifySplatCenter(inout vec3 center) {
}
void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
}
void modifySplatColor(vec3 center, inout vec4 color) {
    vec3 d = center - uSecCenter;
    float n = dot(d, uSecNormal);
    if (uSecClip > 0.5 && n > uSecHalf.z) {
        color.a = 0.0;
    } else if (abs(n) <= uSecHalf.z && abs(dot(d, uSecAxisX)) <= uSecHalf.x && abs(dot(d, uSecAxisY)) <= uSecHalf.y) {
        color.rgb = mix(color.rgb, vec3(${TINT}), ${TINT_AMOUNT});
    }
}
`;

const SECTION_WGSL = `
uniform uSecCenter: vec3f;
uniform uSecAxisX: vec3f;
uniform uSecAxisY: vec3f;
uniform uSecNormal: vec3f;
uniform uSecHalf: vec3f;
uniform uSecClip: f32;
fn modifySplatCenter(center: ptr<function, vec3f>) {
}
fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
}
fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let d = center - uniform.uSecCenter;
    let n = dot(d, uniform.uSecNormal);
    if (uniform.uSecClip > 0.5 && n > uniform.uSecHalf.z) {
        *color = vec4f((*color).rgb, 0.0);
    } else if (abs(n) <= uniform.uSecHalf.z && abs(dot(d, uniform.uSecAxisX)) <= uniform.uSecHalf.x && abs(dot(d, uniform.uSecAxisY)) <= uniform.uSecHalf.y) {
        *color = vec4f(mix((*color).rgb, vec3f(${TINT}), ${TINT_AMOUNT}), (*color).a);
    }
}
`;

const SECTION_PARAMS = ['uSecCenter', 'uSecAxisX', 'uSecAxisY', 'uSecNormal', 'uSecHalf', 'uSecClip'];

class SplatSectionHighlight {
    private global: Global;

    private component: GSplatComponent | null = null;

    constructor(global: Global) {
        this.global = global;
    }

    // Tranche centrée sur `center`, de normale `normal` (côté masqué si
    // `clip`), bornée à ±halfX sur axisX et ±halfY sur axisY.
    set(center: Vec3, axisX: Vec3, axisY: Vec3, normal: Vec3, halfX: number, halfY: number, halfThickness: number, clip: boolean) {
        const entity = findShownGsplat(this.global); // ARTLIGHT (TKT-272) : pas le modèle masqué
        const comp = (entity as any)?.gsplat as GSplatComponent | undefined;
        if (!comp) return;

        if (comp !== this.component) {
            this.clear();
            comp.setWorkBufferModifier({ glsl: SECTION_GLSL, wgsl: SECTION_WGSL });
            this.component = comp;
        }

        comp.setParameter('uSecCenter', new Float32Array([center.x, center.y, center.z]));
        comp.setParameter('uSecAxisX', new Float32Array([axisX.x, axisX.y, axisX.z]));
        comp.setParameter('uSecAxisY', new Float32Array([axisY.x, axisY.y, axisY.z]));
        comp.setParameter('uSecNormal', new Float32Array([normal.x, normal.y, normal.z]));
        comp.setParameter('uSecHalf', new Float32Array([halfX, halfY, halfThickness]));
        comp.setParameter('uSecClip', clip ? 1 : 0);
        markPlacementsDirty(this.global);
    }

    clear() {
        const comp = this.component;
        if (!comp) return;
        this.component = null;

        releaseWorkBufferModifier(comp); // ARTLIGHT (TKT-272) : un modèle masqué le reste
        for (const name of SECTION_PARAMS) {
            comp.deleteParameter(name);
        }
        markPlacementsDirty(this.global);
    }
}

export { SplatBoxHighlight, SplatSectionHighlight, markPlacementsDirty };
