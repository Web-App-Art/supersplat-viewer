import type { Entity, GSplatComponent, Vec3 } from 'playcanvas';

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
        const entity = this.global.app.root.findOne((node: any) => !!node.gsplat) as Entity | null;
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

        comp.setWorkBufferModifier(null);
        for (const name of ['uVolBoxCenter', 'uVolBoxAxisX', 'uVolBoxAxisZ', 'uVolBoxHalf']) {
            comp.deleteParameter(name);
        }
        this.markDirty();
    }

    // `setParameter` ne redemande la recopie que du placement principal. En
    // LOD, chaque fichier chargé a son propre placement (qui hérite des
    // paramètres) : on les marque aussi, sinon la surbrillance ne suivrait pas
    // la boîte sur les scènes streamées.
    private markDirty() {
        const director = (this.global.app as any).renderer?.gsplatDirector;
        if (director) {
            for (const cameraData of director.camerasMap.values()) {
                for (const layerData of cameraData.layersMap.values()) {
                    const octreeInstances = layerData.gsplatManager?.world?._octreeInstances;
                    if (!octreeInstances) continue;
                    for (const octreeInstance of octreeInstances.values()) {
                        for (const placement of octreeInstance.activePlacements) {
                            placement.renderDirty = true;
                        }
                    }
                }
            }
        }
        this.global.app.renderNextFrame = true;
    }
}

export { SplatBoxHighlight };
