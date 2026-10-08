import type { Collision, PushOut, RayHit } from './collision';

/**
 * ARTLIGHT (TKT-272) : collision qui délègue à l'une de deux collisions, celle
 * du modèle affiché (intérieur ou extérieur, voir src/interior.ts). Les
 * consommateurs (contrôleurs de caméra, curseur de navigation, apparition)
 * gardent une seule référence et suivent la bascule sans le savoir.
 */
class SwitchableCollision implements Collision {
    current: Collision;

    constructor(initial: Collision) {
        this.current = initial;
    }

    get voxelResolution(): number {
        return this.current.voxelResolution;
    }

    queryRay(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): RayHit | null {
        return this.current.queryRay(ox, oy, oz, dx, dy, dz, maxDist);
    }

    querySphere(cx: number, cy: number, cz: number, radius: number, out: PushOut): boolean {
        return this.current.querySphere(cx, cy, cz, radius, out);
    }

    queryCapsule(cx: number, cy: number, cz: number, halfHeight: number, radius: number, out: PushOut): boolean {
        return this.current.queryCapsule(cx, cy, cz, halfHeight, radius, out);
    }

    querySurfaceNormal(x: number, y: number, z: number, rdx: number, rdy: number, rdz: number) {
        return this.current.querySurfaceNormal(x, y, z, rdx, rdy, rdz);
    }

    isFreeAt(x: number, y: number, z: number): boolean {
        return this.current.isFreeAt(x, y, z);
    }
}

export { SwitchableCollision };
