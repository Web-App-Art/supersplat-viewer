// ARTLIGHT (TKT-272)
//
// Bascule intérieur / extérieur. Un relevé peut porter deux modèles du même
// bâtiment dans le même repère : l'un net dehors, l'autre net dedans. On ne
// sait pas les fusionner sans défaut (les deux se disputent la même surface),
// alors on les charge tous les deux et on n'en montre qu'un, choisi selon la
// position de la caméra par rapport au volume du bâtiment décrit dans le
// project.json (bloc `interior`, voir project.ts).
//
// Le modèle caché n'est pas désactivé : le moteur détruirait son instance et
// déchargerait ses fichiers, à recharger à chaque passage de porte. Il reste
// en place, réduit à son niveau de détail le plus grossier (environ 1,5 % du
// modèle) et rendu invisible par un modificateur de work buffer (opacité et
// échelle nulles). Près du seuil, il est libéré de cette contrainte pour que
// ses niveaux fins arrivent avant qu'on le montre.
//
// Budget de splats : le modèle caché le consomme aussi (le moteur répartit un
// budget unique entre les deux). On l'augmente d'autant pour que le modèle
// affiché garde la qualité choisie : du niveau grossier du modèle caché
// (≈ 0,7 M à Saint-Germain), ou d'un budget entier près du seuil.
//
// TKT-273 : en entrant, la collision et l'état « dans le bâtiment » changent
// aussitôt, mais l'image garde le modèle extérieur tant que l'intérieur n'a
// pas chargé ses niveaux fins autour de la caméra (8 s au plus). Sans cela,
// on voyait son niveau grossier pendant quelques secondes. L'extérieur
// contient l'intérieur du relevé complet : l'image reste correcte pendant
// l'attente. En sortant, pas d'attente : vu du dehors, le modèle intérieur
// montre aux fenêtres ce que les visites ont relevé à travers les vitres.

import type { Entity, GSplatComponent } from 'playcanvas';

import type { Collision, SwitchableCollision } from './collision';
import type { VolumePrism } from './project';
import { markPlacementsDirty } from './splat-highlight';
import type { Global } from './types';

/** Demi-largeur de l'hystérésis : 20 cm entre les deux seuils. */
const HYSTERESIS = 0.1;

/**
 * Distance au volume en deçà de laquelle le modèle caché charge ses niveaux
 * fins : plus tôt en approchant de la maison (TKT-273), où l'on entre souvent
 * en marchant, qu'en approchant d'une façade de l'intérieur.
 */
const PREWARM_OUTSIDE = 3;
const PREWARM_INSIDE = 1.5;

/**
 * Attente maximale du modèle à montrer après le passage du seuil. En local,
 * l'intérieur de Saint-Germain met quelques secondes à charger (≈ 70
 * fichiers, 660 Mo pour le salon à 20 M) ; au-delà, il est montré à mi-chemin
 * (niveaux intermédiaires, lodUnderfillLimit) et finit de s'affiner.
 */
const SWAP_TIMEOUT_MS = 8000;

/** Images consécutives où le modèle à montrer est prêt avant de le montrer. */
const SWAP_READY_FRAMES = 3;

const isPrewarm = (d: number) => (d < 0 ? -d < PREWARM_INSIDE : d < PREWARM_OUTSIDE);

const HIDE_GLSL = `
void modifySplatCenter(inout vec3 center) {
}
void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    scale = vec3(0.0);
}
void modifySplatColor(vec3 center, inout vec4 color) {
    color.a = 0.0;
}
`;

const HIDE_WGSL = `
fn modifySplatCenter(center: ptr<function, vec3f>) {
}
fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    *scale = vec3f(0.0);
}
fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    *color = vec4f((*color).rgb, 0.0);
}
`;

const HIDE_MODIFIER = { glsl: HIDE_GLSL, wgsl: HIDE_WGSL };

/**
 * Nombre de splats du niveau le plus grossier d'un modèle LOD (ce que le
 * modèle caché affiche hors du seuil).
 *
 * @param {any} octree - L'octree du modèle (champs internes du moteur).
 * @returns {number} Le nombre de splats, 0 si l'octree n'est pas lisible.
 */
const coarsestCount = (octree: any): number => {
    let total = 0;
    for (const node of octree?.nodes ?? []) {
        const lods = node.lods as { count: number }[] | undefined;
        for (let l = (lods?.length ?? 0) - 1; l >= 0; l--) {
            if (lods[l]?.count > 0) {
                total += lods[l].count;
                break;
            }
        }
    }
    return total;
};

/**
 * Le modèle affiche-t-il les niveaux de détail voulus autour de la caméra ?
 * Lit l'état interne du moteur (PlayCanvas 2.20, vérifié en 2.23) : plage de LOD prise en
 * compte, aucun fichier en attente (préchargement des niveaux plus fins
 * compris), aucun nœud en attente de son niveau.
 *
 * @param {Global} global - Contexte du visualisateur.
 * @param {GSplatComponent} comp - Le composant.
 * @returns {boolean | null} null si l'état n'est pas lisible.
 */
const lodReady = (global: Global, comp: GSplatComponent): boolean | null => {
    try {
        const director = (global.app.renderer as any)?.gsplatDirector;
        const placement = (comp as any)._placement;
        let result: boolean | null = null;
        director?.camerasMap?.forEach((cameraData: any) => {
            cameraData.layersMap?.forEach((layerData: any) => {
                const inst = layerData.gsplatManager?.world?._octreeInstances?.get(placement);
                if (!inst) return;
                const ready = inst.rangeMin === Math.min(comp.lodRangeMin, inst.octree.lodLevels - 1) &&
                    inst.pending.size === 0 &&
                    inst.prefetchPending.size === 0 &&
                    inst.pendingDecrements.size === 0 &&
                    inst.pendingVisibleAdds.size === 0;
                result = (result ?? true) && ready;
            });
        });
        return result;
    } catch {
        return null;
    }
};

/** Composants actuellement masqués par la bascule. */
const hiddenComponents = new WeakSet<GSplatComponent>();

/**
 * Entité gsplat affichée : la première qui n'est pas masquée par la bascule.
 * Les outils qui lisent ou teintent les splats passent par ici.
 *
 * @param {Global} global - Contexte du visualisateur.
 * @returns {Entity | null} L'entité, ou null si la scène n'en a pas.
 */
const findShownGsplat = (global: Global): Entity | null => {
    return global.app.root.findOne((node: any) => !!node.gsplat && !hiddenComponents.has(node.gsplat)) as Entity | null;
};

/**
 * Retire le modificateur d'un outil (surbrillance, coupe). Sur un modèle
 * masqué, remet celui qui le cache au lieu de le révéler.
 *
 * @param {GSplatComponent} comp - Le composant.
 */
const releaseWorkBufferModifier = (comp: GSplatComponent) => {
    comp.setWorkBufferModifier(hiddenComponents.has(comp) ? HIDE_MODIFIER : null);
};

/**
 * Distance signée d'un point au contour d'un polygone (négative dedans).
 *
 * @param {[number, number][]} outline - Sommets, fermeture implicite.
 * @param {number} e - Abscisse du point.
 * @param {number} n - Ordonnée du point.
 * @returns {number} La distance signée.
 */
const polygonSignedDistance = (outline: [number, number][], e: number, n: number): number => {
    let inside = false;
    let best = Infinity;
    for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
        const [ax, ay] = outline[j];
        const [bx, by] = outline[i];
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((e - ax) * dx + (n - ay) * dy) / len2)) : 0;
        const px = ax + t * dx - e, py = ay + t * dy - n;
        best = Math.min(best, px * px + py * py);
        if ((by > n) !== (ay > n) && e < ax + (n - ay) * dx / dy) {
            inside = !inside;
        }
    }
    const d = Math.sqrt(best);
    return inside ? -d : d;
};

/**
 * Distance signée d'un point moteur au volume (union de prismes), négative
 * dedans. Exacte hors du volume ; dedans, distance à la face la plus proche.
 *
 * @param {VolumePrism[]} volume - Les prismes.
 * @param {number} x - x moteur.
 * @param {number} y - y moteur (hauteur).
 * @param {number} z - z moteur.
 * @returns {number} La distance signée, en mètres.
 */
const volumeSignedDistance = (volume: VolumePrism[], x: number, y: number, z: number): number => {
    let best = Infinity;
    for (const prism of volume) {
        // Point moteur (x, y, z) → (E, N) = (−x, z), comme la carte.
        const dh = polygonSignedDistance(prism.outline, -x, z);
        const dv = Math.max(prism.floor - y, y - prism.top);
        const d = dh <= 0 && dv <= 0 ?
            Math.max(dh, dv) :
            Math.hypot(Math.max(dh, 0), Math.max(dv, 0));
        best = Math.min(best, d);
    }
    return best;
};

type InteriorContents = {
    volume: VolumePrism[];
    exterior: Entity;
    /** null en mode nuage de points : un seul contenu, seule la collision bascule. */
    interior: Entity | null;
    /** Collision aiguillée, null si l'un des deux modèles n'a pas la sienne. */
    collision: SwitchableCollision | null;
    exteriorCollision: Collision | null;
    interiorCollision: Collision | null;
};

class InteriorSwitch {
    private global: Global;

    private contents: InteriorContents;

    /** Caméra dans le bâtiment (collision et carte de l'intérieur). */
    inside: boolean;

    /** Modèle intérieur affiché ; rejoint `inside` quand le modèle est prêt. */
    private displayInside: boolean;

    /** Début de l'attente du modèle à montrer, en ms. */
    private swapStart = 0;

    private readyFrames = 0;

    /** Modèle caché libéré du niveau grossier (caméra près du seuil). */
    private prewarm = false;

    /**
     * Faux tant que le visualisateur montre le premier aperçu grossier : les
     * plages de LOD sont alors les siennes.
     */
    revealed = false;

    /** Budget de splats choisi par le visualisateur, avant la part du modèle caché. */
    baseBudget = 0;

    constructor(global: Global, contents: InteriorContents) {
        this.global = global;
        this.contents = contents;

        const p = global.camera.getPosition();
        const d = volumeSignedDistance(contents.volume, p.x, p.y, p.z);
        this.inside = d < 0;
        this.displayInside = this.inside;
        this.prewarm = isPrewarm(d);
        this.applyInside();
        this.applyVisibility();

        // Abonné après le visualisateur, qui place la caméra dans son propre
        // « update » : la position lue ici est celle de la frame.
        global.app.on('update', () => this.update());
    }

    /**
     * Reçoit le modèle intérieur chargé après le premier affichage : masqué
     * ou montré selon la position de la caméra, plages de LOD et budget
     * répartis comme pour un modèle chargé d'emblée.
     *
     * @param {Entity} interior - L'entité gsplat intérieure.
     */
    attachInterior(interior: Entity) {
        this.contents.interior = interior;
        // caméra déjà dedans : l'extérieur reste affiché le temps que
        // l'intérieur charge ses niveaux fins
        this.displayInside = false;
        this.swapStart = performance.now();
        this.readyFrames = 0;
        this.applyVisibility();
    }

    private get shown(): GSplatComponent {
        const { exterior, interior } = this.contents;
        return (this.displayInside ? interior : exterior)?.gsplat;
    }

    private get hidden(): GSplatComponent {
        const { exterior, interior } = this.contents;
        return (this.displayInside ? exterior : interior)?.gsplat;
    }

    /**
     * Un passage de seuil attend que le modèle à montrer soit prêt.
     *
     * @returns {boolean} true pendant l'attente.
     */
    private get swapping(): boolean {
        return this.displayInside !== this.inside;
    }

    /**
     * Collision du modèle affiché.
     *
     * @returns {Collision | null} La collision, null si la scène n'en a pas.
     */
    get activeCollision(): Collision | null {
        const { contents } = this;
        return this.inside ? contents.interiorCollision ?? contents.exteriorCollision : contents.exteriorCollision;
    }

    private update() {
        const p = this.global.camera.getPosition();
        const d = volumeSignedDistance(this.contents.volume, p.x, p.y, p.z);
        const inside = this.inside ? d < HYSTERESIS : d < -HYSTERESIS;
        const prewarm = isPrewarm(d);

        if (inside !== this.inside) {
            this.inside = inside;
            this.prewarm = prewarm;
            this.applyInside();
            if (inside) {
                this.swapStart = performance.now();
                this.readyFrames = 0;
                this.applyLodRanges();
            } else {
                this.displayInside = false;
                this.applyVisibility();
            }
        } else if (prewarm !== this.prewarm) {
            this.prewarm = prewarm;
            this.applyLodRanges();
        }

        if (this.swapping) {
            this.checkSwap();
        }
    }

    /**
     * Montre le modèle intérieur quand il a chargé ses niveaux fins, ou au
     * bout de SWAP_TIMEOUT_MS.
     */
    private checkSwap() {
        const target = this.hidden;
        const ready = target && this.revealed ? lodReady(this.global, target) : null;
        this.readyFrames = ready ? this.readyFrames + 1 : 0;
        if (ready === null || this.readyFrames >= SWAP_READY_FRAMES ||
            performance.now() - this.swapStart > SWAP_TIMEOUT_MS) {
            this.displayInside = this.inside;
            this.applyVisibility();
        }
    }

    /** Collision et état « dans le bâtiment » : aussitôt le seuil passé. */
    private applyInside() {
        const { global, contents } = this;
        if (contents.collision) {
            contents.collision.current = this.activeCollision;
        }
        global.state.insideBuilding = this.inside;
    }

    private applyVisibility() {
        const { global } = this;
        const { shown, hidden } = this;

        if (shown && hidden) {
            hiddenComponents.delete(shown);
            hiddenComponents.add(hidden);
            shown.setWorkBufferModifier(null);
            hidden.setWorkBufferModifier(HIDE_MODIFIER);
        }

        this.applyLodRanges();
        markPlacementsDirty(global);
        global.app.renderNextFrame = true;
    }

    /**
     * Plages de LOD et budget après l'aperçu : plage complète pour le
     * modèle affiché ; pour le modèle caché, le niveau le plus grossier, sauf
     * près du seuil ou en attente d'être montré. Le budget couvre en plus ce
     * que le modèle caché prend.
     */
    applyLodRanges() {
        const { shown, hidden } = this;
        if (!this.revealed || !shown || !hidden) {
            return;
        }
        shown.lodRangeMin = 0;
        shown.lodRangeMax = 1000;

        const octree = (hidden.resource as any)?.octree;
        const levels = octree?.lodLevels as number | undefined;
        let extra = this.baseBudget;
        if (this.prewarm || this.swapping || !levels) {
            hidden.lodRangeMin = 0;
            hidden.lodRangeMax = 1000;
        } else {
            hidden.lodRangeMin = hidden.lodRangeMax = levels - 1;
            extra = coarsestCount(octree);
        }
        if (this.baseBudget > 0) {
            this.global.app.scene.gsplat.splatBudget = this.baseBudget + extra;
        }
        this.global.app.renderNextFrame = true;
    }
}

export { InteriorSwitch, findShownGsplat, releaseWorkBufferModifier, volumeSignedDistance };
export type { InteriorContents };
