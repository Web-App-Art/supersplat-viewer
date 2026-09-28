import { Mat4, Vec3, Vec4 } from 'playcanvas';
import type { Entity, GSplatComponent } from 'playcanvas';

import type { Global, State } from './types';

// ARTLIGHT: vrai dès qu'un de nos outils (mesure, surface, planéité, plan de
// sol) est actif. Ces outils s'approprient le clic canvas pour poser et
// déplacer leurs points ; la navigation au clic ajoutée en amont (clic pour se
// déplacer / recentrer, double-clic pour changer de mode) doit donc se taire
// tant qu'un outil est ouvert.
export function isToolActive(state: State): boolean {
    return state.measureMode ||
        state.areaMeasureMode ||
        state.flatnessMeasureMode ||
        state.volumeMeasureMode ||
        state.floorplanMode;
}

// Accent color — must match $clr-accent in index.scss
export const ACCENT_COLOR = '#84cc16';
export const ACCENT_R = 132;
export const ACCENT_G = 204;
export const ACCENT_B = 22;

export function accentRgba(alpha: number): string {
    return `rgba(${ACCENT_R}, ${ACCENT_G}, ${ACCENT_B}, ${alpha})`;
}

// ARTLIGHT: le moteur ne rafraîchit la matrice de vue de la caméra qu'au
// `prerender` ; `camera.worldToScreen` appelé pendant `update` projette donc
// avec la pose de l'image précédente, et les tracés « flottent » derrière la
// scène dès que la caméra bouge. On recalcule la vue depuis la transformée
// monde courante de la caméra.
const tmpView = new Mat4();
const tmpViewProj = new Mat4();
const tmpClip = new Vec4();

export function worldToScreen(camera: Entity, pos: Vec3): { x: number; y: number; behind: boolean } {
    const cameraPos = camera.getPosition();
    const forward = camera.forward;
    const toPoint = new Vec3().sub2(pos, cameraPos);
    const dot = toPoint.dot(forward);

    if (dot < 0) {
        return { x: 0, y: 0, behind: true };
    }

    const cam = camera.camera;
    tmpView.copy(camera.getWorldTransform()).invert();
    tmpViewProj.mul2(cam.projectionMatrix, tmpView);
    tmpViewProj.transformVec4(tmpClip.set(pos.x, pos.y, pos.z, 1), tmpClip);

    // Même passage NDC → pixels CSS que CameraComponent.worldToScreen.
    const { width, height } = cam.system.app.graphicsDevice.clientRect;
    const { x: rx, y: ry, z: rw, w: rh } = cam.rect;
    const nx = (tmpClip.x / tmpClip.w + 1) * 0.5;
    const ny = (1 - tmpClip.y / tmpClip.w) * 0.5;
    return {
        x: nx * rw * width + rx * width,
        y: ny * rh * height + (1 - ry - rh) * height,
        behind: false
    };
}

export function findPointNear(
    camera: Entity,
    points: Vec3[],
    clientX: number,
    clientY: number,
    threshold = 400
): number {
    for (let i = 0; i < points.length; i++) {
        const sp = worldToScreen(camera, points[i]);
        if (sp.behind) continue;
        const dx = clientX - sp.x;
        const dy = clientY - sp.y;
        if (dx * dx + dy * dy < threshold) {
            return i;
        }
    }
    return -1;
}

export function formatDistance(dist: number): string {
    // 0.9995 et non 1 : une longueur de 0.99999 m s'affiche « 1.00 m » et non « 100.0 cm ».
    if (dist >= 0.9995) {
        return `${dist.toFixed(2)} m`;
    }
    return `${(dist * 100).toFixed(1)} cm`;
}

export function drawEdgeLabel(
    ctx: CanvasRenderingContext2D,
    p1: Vec3, p2: Vec3,
    s1: { x: number; y: number },
    s2: { x: number; y: number }
) {
    const dist = new Vec3().sub2(p1, p2).length();
    const text = formatDistance(dist);
    const mx = (s1.x + s2.x) / 2;
    const my = (s1.y + s2.y) / 2;

    ctx.font = '13px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const metrics = ctx.measureText(text);
    const pw = 6, ph = 3;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.beginPath();
    ctx.roundRect(mx - metrics.width / 2 - pw, my - 7 - ph, metrics.width + pw * 2, 14 + ph * 2, 4);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(text, mx, my);
}

export type SplatCenters = {
    centers: Float32Array;              // positions locales, xyz entrelacés
    numSplats: number;
    worldMatrix: Float32Array;          // local → monde (colonnes, format PlayCanvas)
};

// Centres des splats de la scène, partagés par les outils qui analysent le
// nuage (planéité, cubature).
export function getSplatCenters(global: Global): SplatCenters | null {
    const entity = global.app.root.findOne((node: any) => !!node.gsplat) as Entity | null;
    if (!entity) return null;

    const comp = (entity as any).gsplat as GSplatComponent;
    const resource = comp.resource ?? (comp.instance as any)?.resource;
    if (!resource) return null;

    const worldMatrix = entity.getWorldTransform().data as Float32Array;

    // Standard (non-LOD) path: resource has centers directly
    const directCenters = (resource as any).centers as Float32Array;
    if (directCenters && directCenters.length > 0) {
        return {
            centers: directCenters,
            numSplats: directCenters.length / 3,
            worldMatrix
        };
    }

    // LOD streaming path: collect centers from active placements via gsplatDirector.
    // ARTLIGHT: depuis PlayCanvas 2.20, les instances d'octree vivent dans
    // `gsplatManager.world._octreeInstances` (et non plus `manager.octreeInstances`) ;
    // sans ce chemin, rien n'était trouvé et les outils restaient sans données.
    // Un fichier du LOD porte plusieurs niveaux de détail : on ne garde que les
    // intervalles actifs (ceux rendus), sinon les splats seraient comptés en
    // double. Les données viennent de la caméra principale, donc du niveau de
    // détail vu depuis le point de vue courant.
    const director = (global.app as any).renderer?.gsplatDirector;
    if (director) {
        const mainCameraData = director.camerasMap.get(global.camera.camera?.camera);
        const camerasData = mainCameraData ? [mainCameraData] : [...director.camerasMap.values()];
        const chunks: Float32Array[] = [];
        let totalSplats = 0;

        for (const cameraData of camerasData) {
            for (const layerData of cameraData.layersMap.values()) {
                const manager = layerData.gsplatManager;
                const octreeInstances = manager?.world?._octreeInstances ?? manager?.octreeInstances;
                if (!octreeInstances) continue;

                for (const octreeInstance of octreeInstances.values()) {
                    for (const placement of octreeInstance.activePlacements) {
                        const placementCenters = placement.resource?.centers as Float32Array;
                        if (!placementCenters || placementCenters.length === 0) continue;

                        const intervals = placement.intervals as Map<number, { x: number; y: number }> | undefined;
                        if (!intervals || intervals.size === 0) {
                            chunks.push(placementCenters);
                            totalSplats += placementCenters.length / 3;
                            continue;
                        }
                        for (const interval of intervals.values()) {
                            // Intervalle inclusif [x, y] d'indices de splats.
                            const first = Math.max(0, interval.x);
                            const last = Math.min(placementCenters.length / 3 - 1, interval.y);
                            if (last < first) continue;
                            chunks.push(placementCenters.subarray(first * 3, (last + 1) * 3));
                            totalSplats += last - first + 1;
                        }
                    }
                }
            }
            if (totalSplats > 0) break;
        }

        if (totalSplats > 0) {
            const merged = new Float32Array(totalSplats * 3);
            let offset = 0;
            for (const c of chunks) {
                merged.set(c, offset);
                offset += c.length;
            }
            return {
                centers: merged,
                numSplats: totalSplats,
                worldMatrix
            };
        }
    }

    return null;
}
