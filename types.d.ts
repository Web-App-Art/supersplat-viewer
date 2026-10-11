/* eslint-disable no-unused-vars */
interface Window {
    sse: {
        poster?: HTMLImageElement,
        settings: Promise<object>,
        contentUrl: string,
        contents: ArrayBuffer,
        params: Record<string, string>
    }

    firstFrame?: () => void;

    scrubTo?: (time: number) => Promise<void>;

    captureFrame?: (options?: { time?: number; width?: number; height?: number; supersample?: number }) => Promise<{ width: number; height: number; data: string }>;

    animationDuration?: number;

    getCameraState?: () => {
        position: [number, number, number];
        angles: [number, number, number];
        distance: number;
        fov: number;
        mode: 'orbit' | 'anim' | 'fly' | 'walk';
    };

    setCameraState?: (snapshot: {
        position: [number, number, number];
        angles: [number, number, number];
        distance: number;
        fov: number;
        mode: 'orbit' | 'anim' | 'fly' | 'walk';
    }) => void;
}

declare module 'playcanvas/scripts/esm/xr/xr-controllers.mjs' {
    const XrControllers: any;
    export { XrControllers };
}

// ARTLIGHT (TKT-284) : réglages lus ou posés par src/xr.ts.
declare module 'playcanvas/scripts/esm/xr/xr-navigation.mjs' {
    class XrNavigation extends pc.Script {
        enableTeleport: boolean;
        enableMove: boolean;
        enableSnapVertical: boolean;
        groundHeight: number;
        maxTeleportDistance: number;
        castRay: ((start: pc.Vec3, end: pc.Vec3) => pc.Vec3 | null) | null;
        _currentGroundY: number;
    }
    export { XrNavigation };
}

declare module 'playcanvas/scripts/esm/xr/xr-manipulation.mjs' {
    class XrManipulation extends pc.Script {
        target: pc.Entity | null;
        scalePivot: 'feet' | 'hands';
        minScale: number;
        maxScale: number;
        reset(): void;
    }
    export { XrManipulation };
}

declare module '*.html' {
    const content: string;
    export default content;
}

declare module '*.css' {
    const content: string;
    export default content;
}

declare module '*.js' {
    const content: string;
    export default content;
}

// ARTLIGHT (TKT-227) : les types de proj4 référencent geotiff (grilles de
// correction), dépendance optionnelle non installée et inutilisée ici.
declare module 'geotiff' {
    type GeoTIFF = unknown;
}
