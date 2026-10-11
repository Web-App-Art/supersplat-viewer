import {
    DEVICETYPE_WEBGL2,
    math,
    Quat,
    Vec3,
    XrManager,
    type Entity
} from 'playcanvas';
import { XrControllers } from 'playcanvas/scripts/esm/xr/xr-controllers.mjs';
import { XrManipulation } from 'playcanvas/scripts/esm/xr/xr-manipulation.mjs';
import { XrNavigation } from 'playcanvas/scripts/esm/xr/xr-navigation.mjs';

import type { Collision } from './collision';
import type { Global } from './types';

// ARTLIGHT (TKT-284) : amont #322.
// Standalone headsets run XR on a mobile gpu, which draws every splat once per eye, but their
// browsers report a desktop platform. Their sessions render with fixed foveation and a 72 Hz
// target, at 0.8x resolution in performance mode, and the viewer lowers the splat budget.
const standaloneHeadset = /OculusBrowser|PicoBrowser/.test(globalThis.navigator?.userAgent ?? '');

// ARTLIGHT (TKT-284) : profondeur jusqu'où chercher le sol sous la caméra ou
// sous un mur touché par l'arc de téléportation.
const FLOOR_SEARCH = 100;

// Au démarrage, une caméra à hauteur d'œil (au plus 2,5 m au-dessus du sol)
// pose le visiteur sur ce sol. Plus haut (vue aérienne), la tête reste à la
// place de la caméra, en supposant 1,6 m d'œil : sous une vue aérienne, le
// premier sol trouvé est souvent un toit, une haie ou un arbre.
const MAX_EYE_HEIGHT = 2.5;
const EYE_HEIGHT = 1.6;

// Surface où l'arc de téléportation se pose : normale à moins de 53° de la
// verticale, marches et pentes comprises (une arête de voxels donne 0,71).
const FLOOR_NORMAL_Y = 0.6;

// Portée de la téléportation, à vol d'oiseau depuis les pieds (10 m dans le
// moteur) : depuis une vue aérienne, l'arc doit pouvoir descendre jusqu'au
// sol. Sur un sol plat, la vitesse de l'arc limite déjà le saut à 7 m environ.
const MAX_TELEPORT_DISTANCE = 30;

// Arc arrêté par un mur ou un plafond : il se pose au sol, à cette distance
// du mur, côté visiteur.
const WALL_STEP_BACK = 0.3;

// AR : maquette réduite jusqu'au 1/100 (un bâtiment de 30 m tient sur 30 cm),
// jamais agrandie au-delà de la taille réelle.
const AR_MIN_SCALE = 0.01;
const AR_MAX_SCALE = 1;

// The viewer reconfigures the camera (clear color, post effects) and the splat budget when
// state.xrMode changes
const initXr = (global: Global, sceneRoot: Entity) => {
    const { app, events, state, camera, renderer } = global;
    const { xr } = app;

    // Engine availability is backend-aware (2.20+): under WebGPU a session is only
    // reported available when it can start on the current device (browser exposes
    // XRGPUBinding, e.g. Safari on Apple Vision Pro). A session the WebGPU device
    // can't host may still run after reloading into WebGL, so keep the buttons
    // visible then — the UI offers that reload when the session can't start directly.
    let webglAR = false;
    let webglVR = false;

    const updateAvailable = () => {
        state.hasAR = xr.isAvailable('immersive-ar') || webglAR;
        state.hasVR = xr.isAvailable('immersive-vr') || webglVR;
    };

    updateAvailable();
    xr.on('available', updateAvailable);

    if (renderer === 'webgpu') {
        Promise.all([
            XrManager.isDeviceSupported(DEVICETYPE_WEBGL2, 'immersive-ar'),
            XrManager.isDeviceSupported(DEVICETYPE_WEBGL2, 'immersive-vr')
        ]).then(([ar, vr]) => {
            webglAR = ar;
            webglVR = vr;
            updateAvailable();
        });
    }

    const parent = camera.parent as Entity;

    const parentPosition = new Vec3();
    const parentRotation = new Quat();
    const cameraPosition = new Vec3();
    const cameraRotation = new Quat();

    parent.addComponent('script');
    parent.script.create(XrControllers);
    const navigation = parent.script.create(XrNavigation, {
        properties: {
            maxTeleportDistance: MAX_TELEPORT_DISTANCE
        }
    }) as unknown as XrNavigation;

    // ARTLIGHT (TKT-284) : amont #323, en AR seulement (décision du 10/10) :
    // on pose le bâtiment en maquette sur une table, réduit, déplacé et tourné
    // autour des mains. La saisie déplace la racine commune des modèles
    // (extérieur et intérieur de la bascule), remise en place à la fin de la
    // session : collision, carte, portails et outils supposent la position
    // d'origine. En VR, la scène reste à l'échelle 1 et ancrée ; seule la
    // navigation déplace le visiteur.
    const manipulation = parent.script.create(XrManipulation, {
        enabled: false,
        properties: {
            target: sceneRoot,
            scalePivot: 'hands',
            minScale: AR_MIN_SCALE,
            maxScale: AR_MAX_SCALE
        }
    }) as unknown as XrManipulation;

    // ARTLIGHT (TKT-284) : la collision de la scène sert de sol. Le visiteur
    // démarre sur le plancher sous la caméra, et l'arc de téléportation se
    // pose sur les sols, paliers et terrains : le plan du moteur, à hauteur
    // fixe, ne connaît qu'un niveau. Les collisions arrivent après le premier
    // affichage (TKT-283).
    let collision: Collision | null = null;
    events.on('collision:attached', (attached: Collision) => {
        collision = attached;
    });

    const rayDir = new Vec3();
    const rayHit = new Vec3();

    const castRay = (start: Vec3, end: Vec3): Vec3 | null => {
        rayDir.sub2(end, start);
        const length = rayDir.length();
        if (!collision || length < 1e-6) return null;
        rayDir.mulScalar(1 / length);

        const hit = collision.queryRay(start.x, start.y, start.z, rayDir.x, rayDir.y, rayDir.z, length);
        if (!hit) return null;
        if (collision.querySurfaceNormal(hit.x, hit.y, hit.z, rayDir.x, rayDir.y, rayDir.z).ny >= FLOOR_NORMAL_Y) {
            return rayHit.set(hit.x, hit.y, hit.z);
        }

        // Mur ou plafond : l'arc ne le traverse pas, il se pose à son pied.
        const horizontal = Math.hypot(rayDir.x, rayDir.z);
        if (horizontal < 1e-3) return null;
        const x = hit.x - rayDir.x / horizontal * WALL_STEP_BACK;
        const z = hit.z - rayDir.z / horizontal * WALL_STEP_BACK;
        const floor = collision.queryRay(x, hit.y - 0.05, z, 0, -1, 0, FLOOR_SEARCH);
        return floor ? rayHit.set(floor.x, floor.y, floor.z) : null;
    };

    xr.on('start', () => {
        app.autoRender = true;

        // cache original camera rig positions and rotations
        parentPosition.copy(parent.getPosition());
        parentRotation.copy(parent.getRotation());
        cameraPosition.copy(camera.getPosition());
        cameraRotation.copy(camera.getRotation());

        // ARTLIGHT (TKT-284) : amont #319.
        // Start the session where the camera is, facing its heading with pitch and roll reset:
        // where it looks across the ground, or where the top of its view points when it looks
        // straight up or down. The yaw of getEulerAngles() only covers -90 to 90 degrees, so a
        // camera facing further round would start the session facing the wrong way.
        const { forward } = camera;
        let x = forward.x;
        let z = forward.z;
        if (x * x + z * z < 1e-6) {
            const { up } = camera;
            const sign = forward.y < 0 ? 1 : -1;
            x = up.x * sign;
            z = up.z * sign;
        }

        // ARTLIGHT (TKT-284) : les pieds sur le sol sous la caméra, ou la tête à
        // sa place (MAX_EYE_HEIGHT). L'amont les pose à y = 0, le sol de ses
        // scènes ; nos relevés ont des niveaux et des terrains en pente.
        const floor = collision?.queryRay(cameraPosition.x, cameraPosition.y, cameraPosition.z, 0, -1, 0, FLOOR_SEARCH);
        const feetY = floor && cameraPosition.y - floor.y <= MAX_EYE_HEIGHT ? floor.y : cameraPosition.y - EYE_HEIGHT;
        parent.setPosition(cameraPosition.x, feetY, cameraPosition.z);
        parent.setEulerAngles(0, Math.atan2(-x, -z) * math.RAD_TO_DEG, 0);

        navigation.castRay = collision ? castRay : null;
        navigation.groundHeight = feetY;
        // Sol sous les pieds, dont la téléportation garde la hauteur relative :
        // le premier saut pose les pieds sur la surface visée, même depuis une
        // vue aérienne. Champ privé du script, que le moteur ne pose qu'à son
        // initialisation.
        navigation._currentGroundY = feetY;

        // AR : la maquette se déplace à deux mains. Téléportation et manettes
        // décaleraient le visiteur, donc la maquette par rapport à la table.
        const ar = xr.type === 'immersive-ar';
        navigation.enableTeleport = !ar;
        navigation.enableMove = !ar;
        navigation.enableSnapVertical = !ar;
        manipulation.enabled = ar;

        // ARTLIGHT (TKT-284) : amont #322.
        if (standaloneHeadset) {
            xr.fixedFoveation = 1;
            if (xr.supportedFrameRates?.includes(72)) xr.updateTargetFrameRate(72);
        }

        state.xrMode = ar ? 'ar' : 'vr';
    });

    xr.on('end', () => {
        app.autoRender = false;

        // restore camera to pre-XR state
        parent.setPosition(parentPosition);
        parent.setRotation(parentRotation);
        camera.setPosition(cameraPosition);
        camera.setRotation(cameraRotation);

        // ARTLIGHT (TKT-284) : amont #323, la scène reprend sa place.
        manipulation.reset();
        manipulation.enabled = false;

        // ARTLIGHT (TKT-284) : amont #320. app.xr.active is still true while the 'end' handlers
        // run, so the viewer follows xrMode instead.
        state.xrMode = null;

        // Restore the canvas to the correct position in the DOM after exiting XR. In
        // some browsers (e.g. Chrome on Android) the canvas is moved to a new root
        // during XR, and needs to be moved back on exit.
        requestAnimationFrame(() => {
            document.body.prepend(app.graphicsDevice.canvas);
            app.renderNextFrame = true;
        });
    });

    // ARTLIGHT (TKT-284) : démarrage fiabilisé (amont #301) : une seule demande
    // à la fois, plans de coupe rétablis si la session ne démarre pas (refus de
    // l'utilisateur ou du navigateur).
    let starting = false;

    const start = (type: 'immersive-ar' | 'immersive-vr') => {
        if (starting || xr.active) return;
        starting = true;

        const { nearClip, farClip } = camera.camera;
        camera.camera.nearClip = 0.01;
        camera.camera.farClip = 1000;

        xr.start(camera.camera, type, 'local-floor', {
            framebufferScaleFactor: standaloneHeadset && state.performanceMode ? 0.8 : 1,
            callback: (error: Error | null) => {
                starting = false;
                if (error) {
                    camera.camera.nearClip = nearClip;
                    camera.camera.farClip = farClip;
                    console.warn(`Session XR impossible : ${error.message}`);
                }
            }
        });
    };

    events.on('startAR', () => start('immersive-ar'));
    events.on('startVR', () => start('immersive-vr'));

    events.on('inputEvent', (event) => {
        if (event === 'cancel' && xr.active) {
            xr.end();
        }
    });
};

export { initXr, standaloneHeadset };
