import {
    BoundingBox,
    CameraFrame,
    type CameraComponent,
    Color,
    type Entity,
    type Layer,
    RenderTarget,
    Mat4,
    MiniStats,
    ShaderChunks,
    PIXELFORMAT_RGBA16F,
    PIXELFORMAT_RGBA32F,
    TONEMAP_NONE,
    TONEMAP_LINEAR,
    TONEMAP_FILMIC,
    TONEMAP_HEJL,
    TONEMAP_ACES,
    TONEMAP_ACES2,
    TONEMAP_NEUTRAL,
    Vec3,
    GSPLAT_DEBUG_LOD,
    GSPLAT_DEBUG_NONE,
    GSPLAT_RENDERER_RASTER_CPU_SORT,
    GSPLAT_RENDERER_RASTER_GPU_SORT,
    GSplatComponent,
    LAYERID_SKYBOX,
    platform
} from 'playcanvas';

import { Annotations } from './annotations';
import { AreaMeasureTool } from './area-measure-tool'; // ARTLIGHT
import { CameraManager, isWalkAllowed } from './camera-manager';
import { Camera } from './cameras/camera';
import { Capture } from './capture';
import type { Collision } from './collision';
import { MeshCollision, SwitchableCollision, VoxelCollision } from './collision';
import { ORBIT_PARAM, contentModeUrl } from './content-mode'; // ARTLIGHT (TKT-228, TKT-233)
import { nearlyEquals } from './core/math';
import { DebugPanel } from './debug';
import { FlatnessTool } from './flatness-tool'; // ARTLIGHT
import { InputController } from './input-controller';
import { InteriorSwitch } from './interior'; // ARTLIGHT (TKT-272)
import { MeasureTool } from './measure-tool'; // ARTLIGHT
import { MeshDebugOverlay } from './mesh-debug-overlay';
import { MiniMap } from './minimap'; // ARTLIGHT (TKT-268)
import { NavCursor } from './nav-cursor';
import { Picker } from './picker';
import { applyPointDisks } from './point-disks'; // ARTLIGHT (TKT-287)
import { PointEdl, parsePointEdlOptions, pointEdlSupported } from './point-edl'; // ARTLIGHT (TKT-287)
import { PointTool } from './point-tool'; // ARTLIGHT
import { Portals } from './portals'; // ARTLIGHT
import type { VolumePrism } from './project'; // ARTLIGHT (TKT-272)
import { qualityBudget, XR_HEADSET_BUDGET } from './quality'; // ARTLIGHT (TKT-273, TKT-284)
import { StochasticSplatRenderer } from './render/stochastic-splat-renderer'; // ARTLIGHT (TKT-282)
import { SectionTool } from './section-tool'; // ARTLIGHT (TKT-238)
import type { ExperienceSettings, PostEffectSettings } from './settings';
import type { Config, ContentMode, Global } from './types';
import { VolumeTool } from './volume-tool'; // ARTLIGHT
import { VoxelDebugOverlay } from './voxel-debug-overlay';
import { standaloneHeadset } from './xr'; // ARTLIGHT (TKT-284)
import { ZeroUI } from './zero-ui'; // ARTLIGHT (TKT-226)

// String.replace wrapper that warns when the source substring is missing, so
// shader chunk patches against the engine fail loudly instead of silently
// producing the original chunk.
const patchChunk = (source: string, search: string, replacement: string, name: string): string => {
    if (!source.includes(search)) {
        console.warn(`patchChunk: substring not found in '${name}', shader chunk patch may be out of sync with the engine.`);
    }
    return source.replace(search, replacement);
};

const gammaChunkGlsl = `
vec3 prepareOutputFromGamma(vec3 gammaColor, float depth) {
    return gammaColor;
}
`;

const gammaChunkWgsl = `
fn prepareOutputFromGamma(gammaColor: vec3f, depth: f32) -> vec3f {
    return gammaColor;
}
`;

const rendererTable: Record<Config['renderer'], number> = {
    'webgl': GSPLAT_RENDERER_RASTER_CPU_SORT,
    'webgpu': GSPLAT_RENDERER_RASTER_GPU_SORT
};

// ARTLIGHT (TKT-284) : amont #324.
// how much further away parts of the scene behind the camera count when choosing their detail,
// which saves a lot of splats while orbiting, and the turn after which detail is chosen again.
// XR sessions choose detail by distance alone, with no penalty and no turn-triggered choices: a
// head turning less than 90 degrees brought the coarse detail chosen for behind it into view
const lodBehindPenalty = 5;
const lodUpdateAngle = 90;

type GSplatOctreeResourceLike = {
    octree?: {
        lodLevels: number;
    } | null;
};

const tonemapTable: Record<string, number> = {
    none: TONEMAP_NONE,
    linear: TONEMAP_LINEAR,
    filmic: TONEMAP_FILMIC,
    hejl: TONEMAP_HEJL,
    aces: TONEMAP_ACES,
    aces2: TONEMAP_ACES2,
    neutral: TONEMAP_NEUTRAL
};

const applyPostEffectSettings = (cameraFrame: CameraFrame, settings: PostEffectSettings) => {
    if (settings.sharpness.enabled) {
        cameraFrame.rendering.sharpness = settings.sharpness.amount;
    } else {
        cameraFrame.rendering.sharpness = 0;
    }

    const { bloom } = cameraFrame;
    if (settings.bloom.enabled) {
        bloom.intensity = settings.bloom.intensity;
        bloom.blurLevel = settings.bloom.blurLevel;
    } else {
        bloom.intensity = 0;
    }

    const { grading } = cameraFrame;
    if (settings.grading.enabled) {
        grading.enabled = true;
        grading.brightness = settings.grading.brightness;
        grading.contrast = settings.grading.contrast;
        grading.saturation = settings.grading.saturation;
        grading.tint = new Color().fromArray(settings.grading.tint);
    } else {
        grading.enabled = false;
    }

    const { vignette } = cameraFrame;
    if (settings.vignette.enabled) {
        vignette.intensity = settings.vignette.intensity;
        vignette.inner = settings.vignette.inner;
        vignette.outer = settings.vignette.outer;
        vignette.curvature = settings.vignette.curvature;
    } else {
        vignette.intensity = 0;
    }

    const { fringing } = cameraFrame;
    if (settings.fringing.enabled) {
        fringing.intensity = settings.fringing.intensity;
    } else {
        fringing.intensity = 0;
    }
};

const anyPostEffectEnabled = (settings: PostEffectSettings): boolean => {
    return (settings.sharpness.enabled && settings.sharpness.amount > 0) ||
        (settings.bloom.enabled && settings.bloom.intensity > 0) ||
        (settings.grading.enabled) ||
        (settings.vignette.enabled && settings.vignette.intensity > 0) ||
        (settings.fringing.enabled && settings.fringing.intensity > 0);
};

const vec = new Vec3();

// ARTLIGHT (TKT-272) : modèle intérieur d'une scène, voir src/interior.ts.
type InteriorLoad = {
    volume: VolumePrism[];
    /** Chargement attendu avant le premier affichage (vue de départ dans le bâtiment)… */
    gsplat: Promise<Entity | null> | null;
    /** …ou lancé après lui. */
    loadGsplat: (() => Promise<Entity | null>) | null;
    collision?: Promise<Collision | null>;
};

// store the original isColorBufferSrgb so the override in updatePostEffects is idempotent
const origIsColorBufferSrgb = RenderTarget.prototype.isColorBufferSrgb;

class Viewer {
    global: Global;

    cameraFrame: CameraFrame;

    inputController: InputController;

    cameraManager: CameraManager;

    picker: Picker;

    annotations: Annotations;

    portals: Portals | null = null; // ARTLIGHT

    interiorSwitch: InteriorSwitch | null = null; // ARTLIGHT (TKT-272)

    miniMap: MiniMap | null = null; // ARTLIGHT (TKT-268)

    voxelOverlay: VoxelDebugOverlay | null = null;

    // ARTLIGHT (TKT-280) : toutes les surcouches voxel (une par collision).
    // Chacune garde son quad affiché tant que son update() ne l'a pas masqué.
    private voxelOverlays: VoxelDebugOverlay[] = [];

    meshOverlay: MeshDebugOverlay | null = null;

    navCursor: NavCursor | null = null;

    debugPanel: DebugPanel | null = null;

    /**
     * ARTLIGHT (TKT-282) : rendu stochastique de l'amont (?stochastic, WebGPU),
     * null quand le rendu trié du moteur dessine les splats.
     */
    splatRenderer: StochasticSplatRenderer | null = null;

    // ARTLIGHT
    measureTool: MeasureTool;

    areaMeasureTool: AreaMeasureTool;

    flatnessTool: FlatnessTool;

    volumeTool: VolumeTool;

    pointTool: PointTool;

    sectionTool: SectionTool;

    zeroUI: ZeroUI;

    // ARTLIGHT (TKT-287) : contours du nuage (EDL), null hors mode nuage.
    pointEdl: PointEdl | null = null;

    origChunks: {
        glsl: {
            gsplatOutputVS: string,
            skyboxPS: string
        },
        wgsl: {
            gsplatOutputVS: string,
            skyboxPS: string
        }
    };

    constructor(global: Global, gsplatLoad: Promise<Entity>, skyboxLoad: Promise<void> | undefined, collisionLoad: Promise<Collision> | undefined, interiorLoad?: InteriorLoad) {
        this.global = global;

        const { app, settings, config, events, state, camera, renderer } = global;
        const { graphicsDevice } = app;

        // render skybox as plain equirect
        const glsl = ShaderChunks.get(graphicsDevice, 'glsl');
        glsl.set('skyboxPS', patchChunk(glsl.get('skyboxPS'), 'mapRoughnessUv(uv, mipLevel)', 'uv', 'glsl skyboxPS'));

        const wgsl = ShaderChunks.get(graphicsDevice, 'wgsl');
        wgsl.set('skyboxPS', patchChunk(wgsl.get('skyboxPS'), 'mapRoughnessUv(uv, uniform.mipLevel)', 'uv', 'wgsl skyboxPS'));

        // ARTLIGHT (TKT-287) : points du nuage en disques nets. Le nuage n'est
        // pas encore créé (chargement asynchrone) : aucun shader gsplat n'est
        // compilé avec l'ancien chunk.
        if (config.contentMode === 'pointcloud') {
            applyPointDisks(app, config.points);

            // L'EDL passe par le CameraFrame (voir configureCamera).
            const edl = parsePointEdlOptions(config.points);
            if (edl.strength > 0 && pointEdlSupported(CameraFrame, graphicsDevice)) {
                this.pointEdl = new PointEdl(app, camera.camera, edl);
                state.hasPointEdges = true;
                // contours coupés : plus de CameraFrame, plus de surcoût
                events.on('pointEdges:changed', () => {
                    this.configureCamera(settings);
                    app.renderNextFrame = true;
                });
            }
        }

        this.origChunks = {
            glsl: {
                gsplatOutputVS: glsl.get('gsplatOutputVS'),
                skyboxPS: glsl.get('skyboxPS')
            },
            wgsl: {
                gsplatOutputVS: wgsl.get('gsplatOutputVS'),
                skyboxPS: wgsl.get('skyboxPS')
            }
        };

        // Render every frame while the scene loads, then switch to on-demand rendering once the
        // first complete frame is ready (autoRender is disabled in the frame:ready handler below).
        // Loading progress and the ready transition are both reported via frame:ready, which only
        // fires when a frame is rendered — so we must render continuously through loading. After
        // that, rendering is driven on demand by frame:request and camera-change detection. This
        // mirrors the engine's simple-on-demand gsplat example.
        app.autoRender = true;

        // configure the camera
        this.configureCamera(settings);

        // ARTLIGHT (TKT-282) : rendu stochastique de l'amont (src/render, copié
        // de la 1.37.0 sans modification), à l'essai avec ?stochastic, en
        // WebGPU seulement. Créé avant la première image pour couper le rendu
        // du moteur dès que celui-ci le crée ; le moteur garde les LOD, le
        // streaming et le work buffer (bascule et surbrillances comprises).
        // Notre picker rend toujours sa propre passe triée : les outils pointent
        // comme avant. Sans le paramètre, rien n'est créé.
        if (config.stochastic && renderer === 'webgpu') {
            const worldLayer = app.scene.layers.getLayerByName('World');
            // Le plus grand budget possible doit tenir dans une liaison de
            // stockage : celui de Haute (ou &budget), doublé près des murs
            // quand la scène a un modèle intérieur (voir interior.ts).
            const maxBudget = (config.budget !== undefined && Number.isFinite(config.budget) && config.budget > 0 ?
                config.budget :
                qualityBudget('high', 0, platform.mobile)) * (interiorLoad ? 2 : 1);
            const budget = maxBudget * 1000000;
            if (!StochasticSplatRenderer.cacheFits(graphicsDevice, budget)) {
                console.warn(`Rendu stochastique : ${maxBudget} M splats dépassent la limite de stockage de ce GPU ; rendu trié.`);
            } else if (worldLayer) {
                this.splatRenderer = new StochasticSplatRenderer(app, camera.camera, worldLayer, {
                    source: config.splatSource,
                    variant: config.variant
                });
                // Un modificateur de work buffer (surbrillance, tranche de la
                // Coupe, modèle masqué par la bascule) change les splats sans
                // changer la version du monde : l'image repart de zéro au lieu
                // de se fondre dans l'ancienne.
                events.on('splatData:changed', () => this.splatRenderer?.resetHistory());
            }
        }

        // reconfigure camera when entering/exiting XR
        // ARTLIGHT (TKT-282) : le rendu stochastique n'a pas de rendu stéréo,
        // le moteur dessine les splats pendant la session.
        // ARTLIGHT (TKT-284) : amont #320. Follows xrMode rather than app.xr.active, which still
        // reports the session while its 'end' handlers run.
        events.on('xrMode:changed', () => {
            this.configureCamera(settings);
            this.splatRenderer?.setEnabled(state.xrMode === null);
        });

        // construct debug ministats
        if (config.ministats) {
            const options = MiniStats.getDefaultOptions() as any;
            options.cpu.enabled = false;
            options.stats = options.stats.filter((s: any) => s.name !== 'DrawCalls');
            options.stats.push({
                name: 'VRAM',
                stats: ['vram.tex'],
                decimalPlaces: 1,
                multiplier: 1 / (1024 * 1024),
                unitsName: 'MB',
                watermark: 1024
            }, {
                name: 'Splats',
                stats: ['frame.gsplats'],
                decimalPlaces: 3,
                multiplier: 1 / 1000000,
                unitsName: 'M',
                watermark: 5
            });

            // eslint-disable-next-line no-new
            new MiniStats(app, options);
        }

        const prevProj = new Mat4();
        const prevWorld = new Mat4();
        const sceneBound = new BoundingBox();

        // track the camera state and trigger a render when it changes
        app.on('framerender', () => {
            const world = camera.getWorldTransform();
            const proj = camera.camera.projectionMatrix;

            if (!app.renderNextFrame) {
                if (config.ministats ||
                    !nearlyEquals(world.data, prevWorld.data) ||
                    !nearlyEquals(proj.data, prevProj.data)) {
                    app.renderNextFrame = true;
                }
            }

            if (app.renderNextFrame) {
                prevWorld.copy(world);
                prevProj.copy(proj);
            }
        });

        const applyCamera = (camera: Camera) => {
            const cameraEntity = global.camera;

            cameraEntity.setPosition(camera.position);
            cameraEntity.setEulerAngles(camera.angles);
            cameraEntity.camera.fov = camera.fov;

            cameraEntity.camera.horizontalFov = graphicsDevice.width > graphicsDevice.height;

            // fit clipping planes to bounding box
            const boundRadius = sceneBound.halfExtents.length();

            // calculate the forward distance between the camera to the bound center
            vec.sub2(sceneBound.center, camera.position);
            const dist = vec.dot(cameraEntity.forward);

            const far = Math.max(dist + boundRadius, 1e-2);
            const near = Math.max(dist - boundRadius, far / (1024 * 16));

            cameraEntity.camera.farClip = far;
            cameraEntity.camera.nearClip = Math.min(1.0, near);
        };

        // handle application update
        app.on('update', (deltaTime) => {
            // in xr mode we leave the camera alone
            if (app.xr.active) {
                return;
            }

            if (this.inputController && this.cameraManager) {
                // update inputs
                this.inputController.update(deltaTime, this.cameraManager.camera.distance);

                // update cameras
                this.cameraManager.update(deltaTime, this.inputController.frame);

                // apply to the camera entity
                applyCamera(this.cameraManager.camera);
            }

        });

        // Render voxel debug overlay
        app.on('prerender', () => {
            this.voxelOverlays.forEach(overlay => overlay.update());
        });

        // update state on first frame
        events.on('firstFrame', () => {
            state.loaded = true;
            state.animationPaused = !!config.noanim;

            window.scrubTo = (time: number) => {
                if (!state.hasAnimation) {
                    return Promise.reject(new Error('No animation track'));
                }

                state.animationPaused = true;
                return new Promise<void>((resolve) => {
                    events.fire('scrubAnim', time);
                    app.renderNextFrame = true;
                    app.once('frameend', () => resolve());
                });
            };

            window.animationDuration = state.animationDuration;

            // Capture hook for the thumbnail pipeline. Renders the scene (with post
            // effects) into an offscreen supersampled target, GPU box-downsamples it to
            // the requested size and returns just that small buffer. Lazily created on
            // first use — no ?capture flag and no preserveDrawingBuffer needed, and it
            // works on both WebGL and WebGPU.
            let capture: Capture | null = null;
            let captureQueue: Promise<unknown> = Promise.resolve();
            window.captureFrame = ({ time, width = 480, height = width, supersample } = {}) => {
                const run = () => {
                    if (!capture) {
                        capture = new Capture(app, camera.camera, () => this.cameraFrame ?? null);
                    }
                    return capture.grab({
                        time,
                        width,
                        height,
                        supersample,
                        scrub: (t) => {
                            if (state.hasAnimation) {
                                state.animationPaused = true;
                                events.fire('scrubAnim', t);
                            }
                        }
                    });
                };
                // serialize calls: they share the viewer camera, so concurrent captures
                // would interleave the redirect/restore and could leave it mis-targeted
                const result = captureQueue.then(run, run);
                captureQueue = result.then(() => {}, () => {});
                return result;
            };
        });

        const { gsplat } = app.scene;

        // ARTLIGHT (TKT-280) : réglages gsplat de la scène posés avant tout
        // chargement (amont #284 et #289). Le streaming commence à l'image qui
        // suit la création du composant : minContribution, alphaClip et
        // antiAlias sont recopiés avec chaque splat dans le work buffer (les
        // premiers splats ne les avaient pas), et lodUpdateAngle /
        // lodBehindPenalty décident des premiers fichiers demandés.

        // ARTLIGHT (TKT-228): le moteur écarte les splats de moins de
        // 2 px de diamètre (≈ 0,45 px d'écart-type). Un nuage vu de loin
        // n'est fait que de points plus petits : les blocs d'un niveau
        // fin disparaissaient d'un coup, laissant un trou noir.
        if (config.contentMode === 'pointcloud') {
            gsplat.minPixelSize = 0;
        }

        // these two allow LOD behind camera to drop, saves lots of splats
        gsplat.lodUpdateAngle = lodUpdateAngle;
        gsplat.lodBehindPenalty = lodBehindPenalty;
        gsplat.minContribution = 1;
        gsplat.alphaClip = 1 / 255;
        gsplat.antiAlias = config.aa;

        // ARTLIGHT (TKT-273) : en attendant le niveau voulu, le moteur montre
        // un niveau jusqu'à deux crans plus grossier déjà chargé, ou le
        // charge d'abord (plus léger), puis affine. Sans cela, une zone
        // reste au niveau le plus grossier jusqu'à l'arrivée du plus fin.
        gsplat.lodUnderfillLimit = 2;

        // same performance, but rotating on slow devices does not give us unsorted splats on sides
        gsplat.radialSorting = true;

        // debug colorize lods (baked into the work buffer: set before streaming starts)
        gsplat.debug = config.colorize ? GSPLAT_DEBUG_LOD : GSPLAT_DEBUG_NONE;

        // ARTLIGHT (TKT-280) : aperçu au niveau le plus grossier dès que le
        // modèle est créé (amont #288), sans attendre le ciel ni la collision :
        // le streaming a déjà commencé, et il demandait entre-temps les
        // niveaux fins. Le gestionnaire tourne en microtâche de l'événement de
        // chargement, aucune image n'est donc rendue sans ce bridage.
        // Le modèle intérieur chargé d'emblée (vue de départ dedans) aussi.
        if (!config.fullload) {
            const clampToCoarsest = (entity: Entity | null) => {
                const component = entity?.gsplat as GSplatComponent | undefined;
                const resource = component?.resource as GSplatOctreeResourceLike | null;
                const lodLevels = resource?.octree?.lodLevels;
                if (lodLevels) {
                    component.lodRangeMax = component.lodRangeMin = lodLevels - 1;
                }
            };
            gsplatLoad.then(clampToCoarsest, () => {});
            interiorLoad?.gsplat?.then(clampToCoarsest);
        }

        // ARTLIGHT (TKT-283) : amont #306. Loading progress has to start reporting as soon as
        // the splat data starts streaming, which is well before the reveal. The reveal below
        // also waits on the skybox, so chaining off `gsplatLoad` alone lets the bar track the
        // one load it can measure, from the moment that load begins. The reveal stops it and
        // puts the bar at 100.
        let stopProgress: (() => void) | undefined;
        gsplatLoad.then(() => {
            const eventHandler = app.systems.gsplat;

            // `loading` counts the node files the streamer has requested and not yet made
            // resident. Before the reveal the LOD range is clamped to the coarsest level, so this
            // is a single wave and completed / (completed + in-flight) tracks it directly. A drop
            // in the count is work that finished, or was cancelled, which this cannot tell apart
            // and counts as done. Clamped monotone and capped below 100 so only the reveal fills
            // the bar.
            let prevLoading = 0;
            let completed = 0;
            const progressHandler = (camera: CameraComponent, layer: Layer, ready: boolean, loading: number) => {
                completed += Math.max(0, prevLoading - loading);
                prevLoading = loading;

                const total = completed + loading;
                if (total > 0) {
                    state.progress = Math.max(state.progress, Math.min(99, Math.trunc(completed / total * 100)));
                }
            };

            eventHandler.on('frame:ready', progressHandler);
            stopProgress = () => eventHandler.off('frame:ready', progressHandler);
        }, () => {});

        // ARTLIGHT (TKT-283) : amont #306. Collision data is not needed to draw the scene, and
        // it can be larger than the splats themselves (Saint-Germain : 16 Mo pour la collision
        // extérieure, 3 Mo pour l'intérieure, contre 12 Mo pour les deux fichiers du niveau le
        // plus grossier). So it is kept out of the reveal path below, which would otherwise sit on
        // a blank poster with everything needed to render already in memory. `attachCollision`
        // wires it up whenever it lands; the two chains can resolve in either order, so
        // whichever is second performs the attach. Les deux collisions de la bascule arrivent
        // ensemble.
        //
        // Until it attaches, `hasCollision` stays false (pas d'interrupteur ni de touche C),
        // fly mode has no collision response, and nav targeting falls back to splat depth.
        let collisionReady: [Collision | null, Collision | null] | null = null;
        let attachCollision: ((exterior: Collision | null, interior: Collision | null) => void) | undefined;

        Promise.all([collisionLoad, interiorLoad?.collision]).then(([exterior, interior]) => {
            collisionReady = [exterior ?? null, interior ?? null];
            attachCollision?.(...collisionReady);
        });

        // wait for the model to load
        Promise.all([gsplatLoad, skyboxLoad, interiorLoad?.gsplat]).then((results) => {
            const gsplatComponent = results[0].gsplat as GSplatComponent;

            // get scene bounding box
            const gsplatBbox = gsplatComponent.customAabb;
            if (gsplatBbox) {
                sceneBound.setFromTransformedAabb(gsplatBbox, results[0].getWorldTransform());
            }

            // ARTLIGHT (TKT-272) : modèle intérieur. La scène englobe les deux
            // modèles ; la collision suit le modèle affiché.
            // Modèle différé : la bascule commence sans lui (seule la
            // collision suit) et le reçoit après le premier affichage.
            const interiorEntity = results[2] ?? null;
            let interiorComponent = interiorEntity?.gsplat as GSplatComponent | undefined;
            if (interiorLoad && (interiorEntity || interiorLoad.collision || interiorLoad.loadGsplat)) {
                const interiorBbox = interiorComponent?.customAabb;
                if (interiorBbox) {
                    const bound = new BoundingBox();
                    bound.setFromTransformedAabb(interiorBbox, interiorEntity.getWorldTransform());
                    sceneBound.add(bound);
                }
                // Nuage de points : un seul contenu, seule la collision bascule.
                // Les collisions arrivent plus tard (attachCollision).
                this.interiorSwitch = new InteriorSwitch(global, {
                    volume: interiorLoad.volume,
                    exterior: results[0],
                    interior: interiorEntity,
                    collision: null,
                    exteriorCollision: null,
                    interiorCollision: null
                });
                if (interiorLoad.loadGsplat) {
                    const load = interiorLoad.loadGsplat;
                    events.once('firstFrame', () => {
                        load().then((entity) => {
                            if (!entity) return;
                            interiorComponent = entity.gsplat as GSplatComponent;
                            this.interiorSwitch.baseBudget = app.scene.gsplat.splatBudget;
                            this.interiorSwitch.revealed = true;
                            this.interiorSwitch.attachInterior(entity);
                        });
                    });
                }
            }

            if (!config.noui) {
                this.annotations = new Annotations(global, this.cameraFrame != null);

                // ARTLIGHT: après Annotations, qui crée le parent DOM partagé
                // par tous les hotspots.
                this.portals = new Portals(global);

                // ARTLIGHT (TKT-268) : rien sans bloc « map » dans la scène.
                this.miniMap = MiniMap.create(global, this.portals);
            }

            this.picker = new Picker(app, camera);
            this.inputController = new InputController(global, this.picker);

            // ARTLIGHT: outils de mesure
            // Measure tool
            this.measureTool = new MeasureTool(global);
            events.on('measureMode:changed', (value: boolean) => {
                if (value) {
                    this.measureTool.activate();
                } else {
                    this.measureTool.deactivate();
                }
            });

            // Area measure tool
            this.areaMeasureTool = new AreaMeasureTool(global);
            events.on('areaMeasureMode:changed', (value: boolean) => {
                if (value) {
                    this.areaMeasureTool.activate();
                } else {
                    this.areaMeasureTool.deactivate();
                }
            });

            // Flatness measure tool
            this.flatnessTool = new FlatnessTool(global);
            events.on('flatnessMeasureMode:changed', (value: boolean) => {
                if (value) {
                    this.flatnessTool.activate();
                } else {
                    this.flatnessTool.deactivate();
                }
            });

            // Volume (cubature) tool
            this.volumeTool = new VolumeTool(global);
            events.on('volumeMeasureMode:changed', (value: boolean) => {
                if (value) {
                    this.volumeTool.activate();
                } else {
                    this.volumeTool.deactivate();
                }
            });

            // Point XYZ tool (TKT-225), zéro utilisateur (TKT-226)
            this.zeroUI = new ZeroUI(global);
            this.pointTool = new PointTool(global);
            events.on('pointMode:changed', (value: boolean) => {
                if (value) {
                    this.pointTool.activate();
                } else {
                    this.pointTool.deactivate();
                }
            });

            // Coupe (TKT-238)
            this.sectionTool = new SectionTool(global);
            events.on('sectionMode:changed', (value: boolean) => {
                if (value) {
                    this.sectionTool.activate();
                } else {
                    this.sectionTool.deactivate();
                }
            });

            this.cameraManager = new CameraManager(global, sceneBound);
            applyCamera(this.cameraManager.camera);

            // ARTLIGHT (TKT-228): bascule Splats / Nuage de points, caméra conservée.
            events.on('contentMode:switch', (mode: ContentMode) => {
                location.href = contentModeUrl(mode, this.cameraManager.camera, state.cameraMode);
            });
            // TKT-233 : la page d'avant la bascule était en orbite.
            if (new URL(location.href).searchParams.has(ORBIT_PARAM)) {
                state.cameraMode = 'orbit';
            }

            if (!config.noui) {
                this.navCursor = new NavCursor(app, camera, null, events, state);
            }

            // ARTLIGHT (TKT-283) : amont #306, collision branchée à son arrivée.
            attachCollision = (exteriorCollision: Collision | null, interiorCollision: Collision | null) => {
                // ARTLIGHT (TKT-272) : avec la bascule, la collision suit le
                // modèle affiché. La bascule la reçoit en premier pour que la
                // collision aiguillée soit la bonne quand le drone la teste.
                let collision = exteriorCollision;
                let switchable: SwitchableCollision | null = null;
                if (this.interiorSwitch) {
                    if (exteriorCollision && interiorCollision) {
                        switchable = new SwitchableCollision(exteriorCollision);
                        collision = switchable;
                    } else if (interiorCollision) {
                        console.warn('Collision intérieure ignorée : la scène n\'a pas de collision extérieure.');
                    }
                    this.interiorSwitch.setCollisions(switchable, exteriorCollision, interiorCollision);
                }
                if (!collision) {
                    return;
                }

                this.inputController.collision = collision;
                this.cameraManager.setCollision(collision);
                if (this.navCursor) {
                    this.navCursor.collision = collision;
                }
                // ARTLIGHT (TKT-284) : sol de la XR (départ et téléportation).
                events.fire('collision:attached', collision);

                // hasCollision = collision data exists (drives fly-mode collision
                // detection and the voxel/mesh debug overlay availability).
                // walkAllowed = walk mode is offered to the user; requires both
                // collision data and a scene large enough to walk around in.
                state.hasCollision = true;
                state.walkAllowed = isWalkAllowed(sceneBound, collision);

                // Create collision debug overlay (voxel uses a compute shader, mesh
                // uses standard line rendering). The voxel path requires WebGPU.
                // ARTLIGHT (TKT-272) : avec la bascule, un affichage par collision,
                // seul celui du modèle affiché est actif.
                const voxelCollisions = (switchable ? [exteriorCollision, interiorCollision] : [collision])
                .filter((c): c is VoxelCollision => c instanceof VoxelCollision);
                if (voxelCollisions.length > 0 && renderer !== 'webgl') {
                    // Upload the voxel data and allocate the screen-sized texture only
                    // when the debug overlay is first used (amont #306).
                    const overlays = new Map<Collision, VoxelDebugOverlay>();
                    const applyOverlay = () => {
                        const active = switchable ? switchable.current : collision;
                        if (state.collisionOverlayEnabled && active instanceof VoxelCollision && !overlays.has(active)) {
                            const overlay = new VoxelDebugOverlay(app, active, camera);
                            overlay.mode = config.heatmap ? 'heatmap' : 'overlay';
                            overlays.set(active, overlay);
                            this.voxelOverlays.push(overlay);
                        }
                        this.voxelOverlay = overlays.get(active) ?? null;
                        overlays.forEach((overlay) => {
                            overlay.enabled = state.collisionOverlayEnabled && overlay === this.voxelOverlay;
                        });
                        app.renderNextFrame = true;
                    };
                    events.on('collisionOverlayEnabled:changed', applyOverlay);
                    events.on('insideBuilding:changed', applyOverlay);
                    state.hasCollisionOverlay = true;
                    applyOverlay();
                } else if (collision instanceof MeshCollision) {
                    this.meshOverlay = new MeshDebugOverlay(app, collision, camera, !!this.cameraFrame);
                    state.hasCollisionOverlay = true;

                    events.on('collisionOverlayEnabled:changed', (value: boolean) => {
                        this.meshOverlay.enabled = value;
                        app.renderNextFrame = true;
                    });
                }

                app.renderNextFrame = true;
            };

            // collision may already have landed while the splats were still streaming
            if (collisionReady) {
                attachCollision(...collisionReady);
            }

            this.debugPanel = new DebugPanel(global, this.cameraManager, this.picker); // ARTLIGHT: picker pour le relevé alt+clic

            const applyPerfSettings = () => {
                // ARTLIGHT (TKT-273) : budget de la qualité effective, palier
                // d'Auto compris (voir quality.ts).
                // TKT-284 : amont #322, budget réduit en XR sur casque autonome.
                // Le doublement près des murs (bascule) part de ce budget.
                const budget = () => {
                    if (config.budget !== undefined && Number.isFinite(config.budget) && config.budget > 0) {
                        return config.budget;
                    }
                    if (standaloneHeadset && state.xrMode !== null) {
                        return XR_HEADSET_BUDGET;
                    }
                    return qualityBudget(state.qualityChoice, state.qualityStep, platform.mobile);
                };

                gsplat.splatBudget = budget() * 1000000;
                // ARTLIGHT (TKT-272) : avec deux modèles, la bascule répartit les plages.
                if (this.interiorSwitch && interiorComponent) {
                    this.interiorSwitch.baseBudget = gsplat.splatBudget;
                    this.interiorSwitch.revealed = true;
                    this.interiorSwitch.applyLodRanges();
                } else {
                    gsplatComponent.lodRangeMin = 0;
                    gsplatComponent.lodRangeMax = 1000;
                }
                gsplat.colorUpdateAngle = state.performanceMode ? 4 : 2;
                // ARTLIGHT (TKT-284) : amont #324.
                gsplat.lodBehindPenalty = state.xrMode === null ? lodBehindPenalty : 1;
                gsplat.lodUpdateAngle = state.xrMode === null ? lodUpdateAngle : 0;

                // request a frame so the param changes are processed even when on-demand
                // rendering is active and the camera is idle (amont #284)
                app.renderNextFrame = true;
            };

            if (config.fullload) {
                // reveal once full quality has finished loading (used for screenshots)
                applyPerfSettings();
            }

            const eventHandler = app.systems.gsplat;

            // Once on demand (autoRender is disabled at ready, below), render when gsplat streaming
            // produces new data a render would show (new LOD/world-state, pending sort). This also
            // keeps work-buffer texture lifetime coupled to the submit under app.autoRender = false.
            eventHandler.on('frame:request', () => {
                app.renderNextFrame = true;
            });

            // ARTLIGHT (TKT-283) : amont #306. `ready && loading === 0` describes the state
            // before streaming starts just as well as the state after it finishes: on the first
            // frame the octree instance has not run its LOD pass yet, so nothing is in flight and
            // the world trivially reports ready. Now that the reveal no longer waits for the
            // collision, this handler can be registered that early; taken at face value that
            // would reveal the scene before a single frame had rendered and undo the coarse LOD
            // clamp above by running applyPerfSettings immediately. So require evidence that the
            // streamer has left that initial state: work in flight, or splats on screen. Only
            // octree content has a streaming phase to wait for; single-file content is fully
            // loaded before this handler is registered, so it must not be gated.
            const octree = (gsplatComponent.resource as GSplatOctreeResourceLike | null)?.octree ?? null;
            let streamingStarted = !octree;

            const readyHandler = (camera: CameraComponent, layer: Layer, ready: boolean, loading: number) => {
                // `frame.gsplats` is the rendered splat count, the same stat the ministats panel
                // reads. It covers an octree that renders before it reports work in flight.
                if (loading > 0 || app.stats.frame.gsplats > 0) {
                    streamingStarted = true;
                }

                if (ready && loading === 0 && streamingStarted) {
                    // scene is done with initial/reveal loading
                    eventHandler.off('frame:ready', readyHandler);

                    stopProgress?.();
                    state.progress = 100;

                    // switch to on-demand rendering (frame:request + camera-change detection)
                    app.autoRender = false;

                    // handle quality mode changes
                    // ARTLIGHT (TKT-273) : un palier d'Auto change le budget sans changer de mode.
                    events.on('performanceMode:changed', applyPerfSettings);
                    events.on('qualityChoice:changed', applyPerfSettings);
                    events.on('qualityStep:changed', applyPerfSettings);
                    events.on('xrMode:changed', applyPerfSettings); // ARTLIGHT (TKT-284)
                    applyPerfSettings();

                    // ARTLIGHT (TKT-282) : le rendu stochastique lit le work buffer
                    // tel que le moteur l'a préparé ; changer de mode le
                    // reconstruirait pour rien (amont).
                    if (!this.splatRenderer) {
                        gsplat.renderer = rendererTable[renderer];
                    }

                    // wait for the first valid frame to complete rendering
                    app.once('frameend', () => {
                        events.fire('firstFrame');

                        // emit first frame event on window
                        window.firstFrame?.();
                    });
                }
            };

            eventHandler.on('frame:ready', readyHandler);
        });
    }

    // configure camera based on application mode and post process settings
    configureCamera(settings: ExperienceSettings) {
        const { global } = this;
        const { app, config, camera, state } = global;
        const { postEffectSettings } = settings;
        const { background } = settings;

        // hpr override takes precedence over settings.highPrecisionRendering
        const highPrecisionRendering = config.hpr ?? settings.highPrecisionRendering;

        const postFxRequested = !config.nofx &&
            (anyPostEffectEnabled(postEffectSettings) || highPrecisionRendering);

        // ARTLIGHT (TKT-284) : amont #320. CameraFrame has no XR path, so post effects are off
        // for the session
        // ARTLIGHT (TKT-287) : les contours du nuage (EDL) ont besoin du CameraFrame.
        const pointEdges = !!this.pointEdl && state.pointEdges;
        const enableCameraFrame = state.xrMode === null && (postFxRequested || pointEdges);

        if (enableCameraFrame) {
            // create instance
            if (!this.cameraFrame) {
                this.cameraFrame = new CameraFrame(app, camera.camera);
            }

            const { cameraFrame } = this;
            cameraFrame.enabled = true;
            cameraFrame.rendering.toneMapping = tonemapTable[settings.tonemapping];
            cameraFrame.rendering.renderFormats = highPrecisionRendering ? [PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA32F] : [];
            applyPostEffectSettings(cameraFrame, postEffectSettings);
            if (this.pointEdl) {
                this.pointEdl.active = pointEdges;
                this.pointEdl.attach(cameraFrame);
            }
            cameraFrame.update();

            // force gsplat shader to write gamma-space colors
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('gsplatOutputVS', gammaChunkGlsl);
            ShaderChunks.get(app.graphicsDevice, 'wgsl').set('gsplatOutputVS', gammaChunkWgsl);

            // force skybox shader to write gamma-space colors (inline pow replaces the
            // gammaCorrectOutput call which is a no-op under CameraFrame's GAMMA_NONE)
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('skyboxPS',
                patchChunk(
                    this.origChunks.glsl.skyboxPS,
                    'gammaCorrectOutput(toneMap(processEnvironment(linear)))',
                    'pow(toneMap(processEnvironment(linear)) + 0.0000001, vec3(1.0 / 2.2))',
                    'glsl skyboxPS gamma override'
                )
            );
            ShaderChunks.get(app.graphicsDevice, 'wgsl').set('skyboxPS',
                patchChunk(
                    this.origChunks.wgsl.skyboxPS,
                    'gammaCorrectOutput(toneMap(processEnvironment(linear)))',
                    'pow(toneMap(processEnvironment(linear)) + 0.0000001, vec3f(1.0 / 2.2))',
                    'wgsl skyboxPS gamma override'
                )
            );

            // ensure the final compose blit doesn't perform linear->gamma conversion.
            RenderTarget.prototype.isColorBufferSrgb = function (index) {
                return this === app.graphicsDevice.backBuffer ? true : origIsColorBufferSrgb.call(this, index);
            };

            camera.camera.clearColor = new Color(background.color);
        } else {
            // no post effects needed, destroy camera frame if it exists
            if (this.cameraFrame) {
                this.cameraFrame.destroy();
                this.cameraFrame = null;
            }

            // restore shader chunks to engine defaults
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('gsplatOutputVS', this.origChunks.glsl.gsplatOutputVS);
            ShaderChunks.get(app.graphicsDevice, 'wgsl').set('gsplatOutputVS', this.origChunks.wgsl.gsplatOutputVS);
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('skyboxPS', this.origChunks.glsl.skyboxPS);
            ShaderChunks.get(app.graphicsDevice, 'wgsl').set('skyboxPS', this.origChunks.wgsl.skyboxPS);

            // restore original isColorBufferSrgb behavior
            RenderTarget.prototype.isColorBufferSrgb = origIsColorBufferSrgb;

            // ARTLIGHT (TKT-284) : amont #320, tone mapping de la scène en XR
            // aussi.
            camera.camera.toneMapping = tonemapTable[settings.tonemapping];

            // AR composites the scene over the passthrough view
            camera.camera.clearColor = state.xrMode === 'ar' ? new Color(0, 0, 0, 0) : new Color(background.color);
        }

        // ARTLIGHT (TKT-284) : amont #321. The sky would cover AR's passthrough view entirely, so
        // it is hidden for the session
        const skyLayer = app.scene.layers.getLayerById(LAYERID_SKYBOX);
        if (skyLayer) skyLayer.enabled = state.xrMode !== 'ar';

        // Mesh overlay bakes its vertex colors based on the current gamma
        // path; reapply when CameraFrame is created/destroyed (e.g. on XR
        // start/end) so the overlay tracks the new path.
        this.meshOverlay?.setCameraFrameEnabled(!!this.cameraFrame);
    }
}

export { Viewer };
export type { InteriorLoad };
