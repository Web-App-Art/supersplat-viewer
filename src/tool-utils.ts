import { Vec3 } from 'playcanvas';
import type { Entity } from 'playcanvas';

// Accent color — must match $clr-accent in index.scss
export const ACCENT_COLOR = '#84cc16';
export const ACCENT_R = 132;
export const ACCENT_G = 204;
export const ACCENT_B = 22;

export function accentRgba(alpha: number): string {
    return `rgba(${ACCENT_R}, ${ACCENT_G}, ${ACCENT_B}, ${alpha})`;
}

export function worldToScreen(camera: Entity, pos: Vec3): { x: number; y: number; behind: boolean } {
    const cameraPos = camera.getPosition();
    const forward = camera.forward;
    const toPoint = new Vec3().sub2(pos, cameraPos);
    const dot = toPoint.dot(forward);

    if (dot < 0) {
        return { x: 0, y: 0, behind: true };
    }

    const screenPos = new Vec3();
    camera.camera.worldToScreen(pos, screenPos);
    return { x: screenPos.x, y: screenPos.y, behind: false };
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
    if (dist >= 1) {
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
