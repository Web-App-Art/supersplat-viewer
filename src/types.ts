import type { Entity, EventHandler, AppBase } from 'playcanvas';

import type { CoordinateSystem } from './coordinates';
import type { VolumePrism } from './project';
import type { QualityChoice } from './quality';
import type { ExperienceSettings } from './settings';

type CameraMode = 'orbit' | 'anim' | 'fly' | 'walk';

type InputMode = 'desktop' | 'touch';

type ContentMode = 'splats' | 'pointcloud';

// configuration options are immutable at runtime
type Config = {
    poster?: HTMLImageElement;
    skyboxUrl?: string;
    contentUrl?: string;
    contents?: Promise<Response>;
    collisionUrl?: string;
    // ARTLIGHT (TKT-228): contenu affiché, splats ou nuage de points LiDAR.
    // Les deux URL sont connues pour proposer la bascule ; contentUrl est l'une d'elles.
    contentMode?: ContentMode;
    splatsUrl?: string;
    pointcloudUrl?: string;
    // ARTLIGHT (TKT-272): modèle intérieur affiché dans le volume du bâtiment
    // (bloc `interior` du project.json). Absent en mode nuage de points, où le
    // nuage est commun ; la collision et le volume restent.
    interiorUrl?: string;
    interiorCollisionUrl?: string;
    interiorVolume?: VolumePrism[];

    noui: boolean;
    noanim: boolean;
    nointro: boolean;                           // ARTLIGHT: supprime l'animation d'intro générée quand la scène n'a pas d'animTrack
    speed?: unknown;                            // ARTLIGHT (TKT-241): niveau de vitesse par défaut de la scène (1 à 5), voir move-speed.ts
    nofx: boolean;                              // disable post effects
    hpr?: boolean;                              // override highPrecisionRendering (undefined = use settings)
    ministats: boolean;
    colorize: boolean;                          // render with LOD colorization
    fullload: boolean;                          // load all streaming LOD data before first frame
    aa: boolean;                                // render with antialiasing
    budget?: number;                            // override splat budget in millions (overrides platform + quality table)
    renderer: 'webgl' | 'webgpu';               // requested renderer; the actual one (after engine fallback) is exposed as Global.renderer
    heatmap: boolean;                           // render heatmap debug overlay (WebGPU only)
    debug: boolean;                             // auto-open the developer debug panel; can also be toggled with Ctrl+Shift+D
    lang?: string;                              // override the UI language (default: detect from browser)
};

// observable state that can change at runtime
type State = {
    loaded: boolean;                            // true once first frame is rendered
    performanceMode: boolean;                   // qualité Standard effective (déduite de qualityChoice, TKT-270)
    qualityChoice: QualityChoice;               // ARTLIGHT (TKT-270): Auto, Standard, Moyenne ou Haute
    qualityStep: number;                        // ARTLIGHT (TKT-273): palier d'Auto, 0 = Haute ; descend sur saccades, jusqu'à Standard
    progress: number;                           // content loading progress 0-100
    inputMode: InputMode;
    cameraMode: CameraMode;
    hasAnimation: boolean;
    animationDuration: number;
    animationTime: number;
    animationPaused: boolean;
    hasAR: boolean;
    hasVR: boolean;
    hasCollision: boolean;
    hasCollisionOverlay: boolean;
    walkAllowed: boolean;
    collisionOverlayEnabled: boolean;
    // ARTLIGHT: modes des outils de mesure (hasVoxelOverlay/voxelOverlayEnabled
    // ont été renommés hasCollisionOverlay/collisionOverlayEnabled en amont).
    measureMode: boolean;
    areaMeasureMode: boolean;
    flatnessMeasureMode: boolean;
    volumeMeasureMode: boolean;
    pointMode: boolean;                         // ARTLIGHT (TKT-225): outil « Point XYZ »
    sectionMode: boolean;                       // ARTLIGHT (TKT-238): outil « Coupe »
    insideBuilding: boolean;                    // ARTLIGHT (TKT-272): caméra dans le volume, modèle intérieur affiché
    speedLevel: number;                         // ARTLIGHT (TKT-241): niveau de vitesse de déplacement, 1 à 5
    isFullscreen: boolean;
    controlsHidden: boolean;
    showAnnotations: boolean;
    gamingControls: boolean;
};

type Global = {
    app: AppBase;
    settings: ExperienceSettings;
    config: Config;
    state: State;
    events: EventHandler;
    camera: Entity;
    renderer: 'webgl' | 'webgpu';               // actual renderer in use (reflects engine fallback from WebGPU to WebGL2)
    coords: CoordinateSystem;                   // ARTLIGHT (TKT-226): repère affiché, zéro utilisateur partagé par les outils
};

export { CameraMode, ContentMode, InputMode, Config, State, Global };
