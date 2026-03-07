import { Vec3 } from 'playcanvas';
import type { Entity } from 'playcanvas';

import { worldToScreen } from './tool-utils';

export type GizmoAxis = 'x' | 'y' | 'z' | null;

// Axis definitions
const AXIS_DIRS: { axis: GizmoAxis; dir: Vec3; color: string; highlight: string }[] = [
    { axis: 'x', dir: new Vec3(1, 0, 0), color: '#e53935', highlight: '#ff6659' },
    { axis: 'y', dir: new Vec3(0, 1, 0), color: '#43a047', highlight: '#76d275' },
    { axis: 'z', dir: new Vec3(0, 0, 1), color: '#1e88e5', highlight: '#6ab7ff' }
];

// Rendering constants
const SHAFT_LENGTH = 70;   // px
const CONE_SIZE = 10;       // px half-width of arrowhead
const SHAFT_WIDTH = 2;
const HIT_THRESHOLD = 12;   // px
const CENTER_DEAD_ZONE = 12; // px — ignore hits near center so the ball handle stays clickable
const MIN_SCREEN_LEN = 5;   // px — skip axis if too short

// Pre-allocated temporaries
const tmpEnd = new Vec3();
const tmpVec = new Vec3();
const tmpVec2 = new Vec3();
const tmpVec3 = new Vec3();
const tmpNear = new Vec3();
const tmpFar = new Vec3();
const tmpRayDir = new Vec3();

class TranslateGizmo {
    /**
     * Render 3 axis arrows on the 2D canvas overlay.
     */
    render(
        ctx: CanvasRenderingContext2D,
        camera: Entity,
        worldPos: Vec3,
        activeAxis: GizmoAxis,
        hoverAxis: GizmoAxis
    ) {
        const center = worldToScreen(camera, worldPos);
        if (center.behind) return;

        for (const { axis, dir, color, highlight } of AXIS_DIRS) {
            // Compute screen-space endpoint of the axis
            tmpEnd.copy(dir).mulScalar(1.0).add(worldPos);
            const end = worldToScreen(camera, tmpEnd);
            if (end.behind) continue;

            let dx = end.x - center.x;
            let dy = end.y - center.y;
            const screenLen = Math.sqrt(dx * dx + dy * dy);
            if (screenLen < MIN_SCREEN_LEN) continue;

            // Normalize to fixed pixel length
            dx = (dx / screenLen) * SHAFT_LENGTH;
            dy = (dy / screenLen) * SHAFT_LENGTH;

            const tipX = center.x + dx;
            const tipY = center.y + dy;

            const isActive = axis === activeAxis || axis === hoverAxis;
            const drawColor = isActive ? highlight : color;

            // Shaft line
            ctx.strokeStyle = drawColor;
            ctx.lineWidth = isActive ? SHAFT_WIDTH + 1 : SHAFT_WIDTH;
            ctx.beginPath();
            ctx.moveTo(center.x, center.y);
            ctx.lineTo(tipX, tipY);
            ctx.stroke();

            // Cone (filled triangle) at tip
            const perpX = -dy / SHAFT_LENGTH;
            const perpY = dx / SHAFT_LENGTH;
            const coneBase = CONE_SIZE;

            ctx.fillStyle = drawColor;
            ctx.beginPath();
            ctx.moveTo(tipX + dx / SHAFT_LENGTH * CONE_SIZE, tipY + dy / SHAFT_LENGTH * CONE_SIZE);
            ctx.lineTo(tipX - perpX * coneBase, tipY - perpY * coneBase);
            ctx.lineTo(tipX + perpX * coneBase, tipY + perpY * coneBase);
            ctx.closePath();
            ctx.fill();
        }
    }

    /**
     * Screen-space proximity hit-test. Returns the closest axis within threshold, or null.
     */
    hitTest(camera: Entity, worldPos: Vec3, clientX: number, clientY: number): GizmoAxis {
        const center = worldToScreen(camera, worldPos);
        if (center.behind) return null;

        let bestAxis: GizmoAxis = null;
        let bestDist = HIT_THRESHOLD;

        for (const { axis, dir } of AXIS_DIRS) {
            tmpEnd.copy(dir).mulScalar(1.0).add(worldPos);
            const end = worldToScreen(camera, tmpEnd);
            if (end.behind) continue;

            let dx = end.x - center.x;
            let dy = end.y - center.y;
            const screenLen = Math.sqrt(dx * dx + dy * dy);
            if (screenLen < MIN_SCREEN_LEN) continue;

            // Normalize direction to fixed pixel length
            dx = (dx / screenLen) * SHAFT_LENGTH;
            dy = (dy / screenLen) * SHAFT_LENGTH;

            // Start the hit segment past the center dead zone so the ball handle stays clickable
            const startX = center.x + (dx / SHAFT_LENGTH) * CENTER_DEAD_ZONE;
            const startY = center.y + (dy / SHAFT_LENGTH) * CENTER_DEAD_ZONE;
            const tipX = center.x + dx;
            const tipY = center.y + dy;

            const dist = pointToSegmentDist(clientX, clientY, startX, startY, tipX, tipY);

            if (dist < bestDist) {
                bestDist = dist;
                bestAxis = axis;
            }
        }

        return bestAxis;
    }

    /**
     * Project a mouse position onto a world-space axis line through dragOrigin.
     * Returns the constrained world position, or null if projection fails.
     */
    projectOntoAxis(
        camera: Entity,
        dragOrigin: Vec3,
        axis: GizmoAxis,
        clientX: number,
        clientY: number,
        appCanvas: HTMLCanvasElement
    ): Vec3 | null {
        if (!axis) return null;

        const axisDef = AXIS_DIRS.find(a => a.axis === axis);
        if (!axisDef) return null;

        const axisDir = axisDef.dir;

        // Build mouse ray
        const rect = appCanvas.getBoundingClientRect();
        const pixelX = (clientX - rect.left) * (appCanvas.width / rect.width);
        const pixelY = (clientY - rect.top) * (appCanvas.height / rect.height);

        camera.camera.screenToWorld(pixelX, pixelY, camera.camera.nearClip, tmpNear);
        camera.camera.screenToWorld(pixelX, pixelY, camera.camera.farClip, tmpFar);
        tmpRayDir.sub2(tmpFar, tmpNear).normalize();

        // Build plane containing the axis, oriented toward camera
        const toCamera = tmpVec.sub2(camera.getPosition(), dragOrigin).normalize();

        // planeNormal = cross(axisDir, cross(toCamera, axisDir))
        tmpVec2.cross(toCamera, axisDir);
        tmpVec3.cross(axisDir, tmpVec2);
        const planeNormal = tmpVec3;
        if (planeNormal.lengthSq() < 1e-10) return null;
        planeNormal.normalize();

        // Ray-plane intersection
        const denom = tmpRayDir.dot(planeNormal);
        if (Math.abs(denom) < 1e-6) return null;

        const t = tmpVec.sub2(dragOrigin, tmpNear).dot(planeNormal) / denom;
        if (t < 0) return null;

        // hitPoint = nearPoint + rayDir * t
        const hitPoint = tmpVec.copy(tmpRayDir).mulScalar(t).add(tmpNear);

        // Project onto axis line: result = dragOrigin + axisDir * dot(hitPoint - dragOrigin, axisDir)
        const offset = tmpVec2.sub2(hitPoint, dragOrigin);
        const along = offset.dot(axisDir);

        const result = new Vec3().copy(axisDir).mulScalar(along).add(dragOrigin);
        return result;
    }
}

/**
 * Minimum distance from point (px, py) to line segment (ax, ay)→(bx, by).
 */
function pointToSegmentDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const abx = bx - ax;
    const aby = by - ay;
    const apx = px - ax;
    const apy = py - ay;
    const ab2 = abx * abx + aby * aby;
    if (ab2 < 1e-8) return Math.sqrt(apx * apx + apy * apy);

    let t = (apx * abx + apy * aby) / ab2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;

    const cx = ax + t * abx - px;
    const cy = ay + t * aby - py;
    return Math.sqrt(cx * cx + cy * cy);
}

export { TranslateGizmo };
