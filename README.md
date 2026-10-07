# SuperSplat Viewer

[![NPM Version](https://img.shields.io/npm/v/@playcanvas/supersplat-viewer)](https://www.npmjs.com/package/@playcanvas/supersplat-viewer)
[![NPM Downloads](https://img.shields.io/npm/dw/@playcanvas/supersplat-viewer)](https://npmtrends.com/@playcanvas/supersplat-viewer)
[![License](https://img.shields.io/npm/l/@playcanvas/supersplat-viewer)](https://github.com/playcanvas/supersplat-viewer/blob/main/LICENSE)
[![Discord](https://img.shields.io/badge/Discord-5865F2?style=flat&logo=discord&logoColor=white&color=black)](https://discord.gg/RSaMRzg)
[![Reddit](https://img.shields.io/badge/Reddit-FF4500?style=flat&logo=reddit&logoColor=white&color=black)](https://www.reddit.com/r/PlayCanvas)
[![X](https://img.shields.io/badge/X-000000?style=flat&logo=x&logoColor=white&color=black)](https://x.com/intent/follow?screen_name=playcanvas)

| [User Manual](https://developer.playcanvas.com/user-manual/gaussian-splatting/editing/supersplat/import-export/#html-viewer-htmlzip) | [Blog](https://blog.playcanvas.com) | [Forum](https://forum.playcanvas.com) |

This is the official viewer for [SuperSplat](https://superspl.at).

<img width="1114" height="739" alt="supersplat-viewer" src="https://github.com/user-attachments/assets/15d2c654-9484-4265-a279-99acb65e38c9" />

The web app compiles to a simple, self-contained static website.

## URL Parameters

The app supports a number of URL parameters (these are subject to change):

### Content

| Parameter | Description | Default |
| --------- | ----------- | ------- |
| `settings` | URL of the `settings.json` file | `./settings.json` |
| `content` | URL of the scene file (`.ply`, `.sog`, `.compressed.ply`, `.meta.json`, `.lod-meta.json`) | `./scene.compressed.ply` |
| `pointcloud` | URL of a LiDAR point cloud converted with `scripts/las-to-splats.mjs`, in the same frame as `content` | |
| `mode` | `pointcloud` shows the point cloud instead of the splats | |
| `view` | Initial camera pose `px,py,pz,tx,ty,tz,fov`, set when switching content | |
| `speed` | Default movement speed level, `1` (very slow) to `5` (very fast); overrides the project scene's `speed` | `3` |
| `skybox` | URL of an equirectangular skybox image | |
| `poster` | URL of an image to show while loading | |
| `collision` | URL of a collision asset (`.glb` mesh, or voxel data). `voxel` is accepted as an alias. | |

### UI

| Parameter | Description |
| --------- | ----------- |
| `noui` | Hide the UI overlay |
| `noanim` | Start with animation paused |
| `ministats` | Show runtime CPU/GPU performance graphs |
| `lang` | Override the UI language (`de`, `en`, `es`, `fr`, `ja`, `ko`, `pt-BR`, `ru`, `zh-CN`; default: detect from browser) |

### Renderer

By default the viewer uses WebGPU when available (falling back automatically when not). The flag below forces the WebGL renderer (also required for WebXR / AR / VR):

| Parameter | Description |
| --------- | ----------- |
| `webgl` | Force the WebGL renderer (required for AR/VR) |
| `aa` | Enable antialiasing (WebGL only) |
| `nofx` | Disable post effects |
| `hpr` | Override `highPrecisionRendering` from settings (`?hpr`, `?hpr=1`, `?hpr=true`, `?hpr=enable` to enable) |
| `budget` | Override the splat budget, in millions of splats |
| `colorize` | Render with LOD colorization |
| `fullload` | Load all streaming LOD data before the first frame |
| `heatmap` | Use heatmap mode for the voxel collision debug overlay. Requires WebGPU and voxel collision data; press `V` or use the collision toolbar button to show the overlay. |
| `debug` | Open the developer debug panel on load (`Ctrl+Shift+D` to toggle) |

## NPM Package

The web app source files are available as strings for templating when you import the package from npm:

```ts
import { html, css, js } from '@playcanvas/supersplat-viewer';

// logs the source of index.html
console.log(html);

// logs the source of index.css
console.log(css);

// logs the source of index.js
console.log(js);
```

The package also exports the settings schema types and helpers via the `/settings` subpath, which is useful for generating, validating or migrating a `settings.json` file:

```ts
import {
    importSettings,
    validateSettings,
    type ExperienceSettings
} from '@playcanvas/supersplat-viewer/settings';

// throws on invalid input
validateSettings(json);

// migrates a v1 settings object to the latest schema
const settings: ExperienceSettings = importSettings(json);
```

## Local Development

To initialize a local development environment for SuperSplat Viewer, ensure you have [Node.js](https://nodejs.org/) 18 or later installed. Follow these steps:

1. Clone the repository:

   ```sh
   git clone https://github.com/playcanvas/supersplat-viewer.git
   cd supersplat-viewer
   ```

2. Install dependencies:

   ```sh
   npm install
   ```

3. Start the development build and local web server:

   ```sh
   npm run develop
   ```

4. Open your browser at http://localhost:3000.

### Debug engine build

By default the viewer links against the release build of the PlayCanvas engine. Set `ENGINE=debug` to link against the engine's debug build instead, which includes runtime assertions and unminified, readable source for easier debugging:

```sh
ENGINE=debug npm run develop
```

This also works with `npm run build` and `npm run watch`.

## Settings Schema

The `settings.json` file uses the schema below (defined in TypeScript and exported from `@playcanvas/supersplat-viewer/settings`). Legacy v1 settings produced by older SuperSplat releases are automatically migrated to v2 on load.

```typescript
type AnimTrack = {
    name: string,
    duration: number,
    frameRate: number,
    loopMode: 'none' | 'repeat' | 'pingpong',
    interpolation: 'step' | 'spline',
    smoothness: number,
    keyframes: {
        times: number[],
        values: {
            position: number[],
            target: number[],
            fov: number[],
        }
    }
};

type CameraPose = {
    position: [number, number, number],
    target: [number, number, number],
    fov: number
};

type Camera = {
    initial: CameraPose
};

type Annotation = {
    position: [number, number, number],
    title: string,
    text: string,
    extras?: any,
    camera: Camera
};

type PostEffectSettings = {
    sharpness: { enabled: boolean, amount: number },
    bloom:     { enabled: boolean, intensity: number, blurLevel: number },
    grading:   { enabled: boolean, brightness: number, contrast: number, saturation: number, tint: [number, number, number] },
    vignette:  { enabled: boolean, intensity: number, inner: number, outer: number, curvature: number },
    fringing:  { enabled: boolean, intensity: number }
};

type ExperienceSettings = {
    version: 2,
    tonemapping: 'none' | 'linear' | 'filmic' | 'hejl' | 'aces' | 'aces2' | 'neutral',
    highPrecisionRendering: boolean,
    soundUrl?: string,
    background: {
        color: [number, number, number],
        skyboxUrl?: string
    },
    postEffectSettings: PostEffectSettings,
    animTracks: AnimTrack[],
    cameras: Camera[],
    annotations: Annotation[],
    startMode: 'default' | 'animTrack' | 'annotation'
};
```

### Example settings.json

```json
{
    "version": 2,
    "tonemapping": "none",
    "highPrecisionRendering": false,
    "background": {
        "color": [0, 0, 0]
    },
    "postEffectSettings": {
        "sharpness": { "enabled": false, "amount": 0 },
        "bloom":     { "enabled": false, "intensity": 1, "blurLevel": 2 },
        "grading":   { "enabled": false, "brightness": 0, "contrast": 1, "saturation": 1, "tint": [1, 1, 1] },
        "vignette":  { "enabled": false, "intensity": 0.5, "inner": 0.3, "outer": 0.75, "curvature": 1 },
        "fringing":  { "enabled": false, "intensity": 0.5 }
    },
    "animTracks": [],
    "cameras": [
        {
            "initial": {
                "position": [0, 1, -1],
                "target": [0, 0, 0],
                "fov": 60
            }
        }
    ],
    "annotations": [],
    "startMode": "default"
}
```
pm2 start npm --name "splatviewer" -- run serve


# Syntaxe splat-transform v3.x (npm install -g @playcanvas/splat-transform@latest)
# Renommages v3.0.0 : -O -> -L (--select-lod), -C <n> -> --lod-chunk-count <n>, -F <n%> -> -d <n%> (--decimate)
# Les actions (-r, -N, -H, -d…) s'appliquent au fichier qui les précède : placées avant l'entrée, elles sont
# ignorées sans message (-H 1 laissait 3 bandes SH). Une seule entrée : les mettre après l'entrée.
# Plusieurs entrées (-l 0, -l 1…) : mettre -H 1 après la sortie, il s'applique au résultat final
# (après une seule entrée, le build échoue : « inputs must share … SH band count »).
# Les options globales (-w, -L, -i, --lod-chunk-count) restent avant l'entrée.
# -N retire les splats à valeur NaN ou infinie ; sans lui, les .lcc récents (Callian, Immeuble Toulon)
# font échouer le build des LOD (« non-finite opacity »). En v3.3.3, -N ne nettoie qu'un niveau à la fois.

# ===== Générer une scène depuis un .lcc (splat-transform v3.3.3) =====
# Commandes lancées depuis le dossier du projet, ex. public/projects/immeuble-toulon
# (guillemets autour des chemins avec espaces : "lcc/lcc-result/Immeuble Full.lcc").

# ROTATION : PAS DE -r en v3.3.3. Le lecteur .lcc oriente déjà le modèle dans le repère attendu par le
# viewer, (E, N, H) → (E, −H, N). Ajouter -r 90,0,0 le remet couché (erreur faite sur Belgentier,
# Saint-Jean-Cap-Ferrat, Callian et Immeuble Toulon). L'effet de -r varie selon le chemin et les actions
# (-r 180,0,0 était juste sur Callian, faux sur Toulon) : ne jamais en ajouter, toujours contrôler.

## 1. Test rapide (≈ 1 min) : niveaux 3 et 4 seulement, compression SH rapide, dans lod-test/
mkdir -p ../../../tmp/modele
for k in 3 4; do splat-transform -w -L $k lcc-result/modele.lcc -N -H 1 ../../../tmp/modele/lod$k.ply; done
splat-transform -w -i 1 --lod-chunk-count 128 ../../../tmp/modele/lod3.ply -l 0 ../../../tmp/modele/lod4.ply -l 1 lod-test/lod-meta.json
splat-transform lod-test/lod-meta.json --stats null | grep -E "^\| (x|y|z) " | head -3
# Comparer au "boundingBox" du .lcc (E, N, H). Bon repère : x = E, y = −H (plage de H inversée,
# la plus petite), z = N. Si y reprend la plage de N, le modèle est couché.
# Vue : http://localhost:4001/?settings=projects/<projet>/settings.json&content=projects/<projet>/lod-test/lod-meta.json
# (é du chemin à écrire %C3%A9 dans l'URL). Supprimer lod-test/ ensuite.

## 2. Conversion complète : un PLY par niveau (-N n'est efficace que niveau par niveau), puis combinaison
for k in 0 1 2 3 4; do splat-transform -w -L $k lcc-result/modele.lcc -N -H 1 ../../../tmp/modele/lod$k.ply; done
splat-transform -w -i 16 --lod-chunk-count 128 ../../../tmp/modele/lod0.ply -l 0 ../../../tmp/modele/lod1.ply -l 1 ../../../tmp/modele/lod2.ply -l 2 ../../../tmp/modele/lod3.ply -l 3 ../../../tmp/modele/lod4.ply -l 4 lod-output/lod-meta.json
rm -r ../../../tmp/modele
splat-transform lod-output/lod-meta.json --stats null | grep -E "^\| (x|y|z) " | head -3
# (PLY à 1 bande SH ≈ 100 o par splat : ≈ 3 Go pour 28 M splats.)

## 3. settings.json (copie de celui d'un autre projet) et project.json (une scène : content, settings, speed)
# Caméra de départ : dans le viewer, ouvrir le panneau debug (Ctrl+Shift+D ou ?debug), se placer, puis dans
# la console du navigateur : copy(JSON.stringify(getCameraState())). La pose {"position","angles","distance"}
# se convertit en position/target pour settings.json (depuis la racine du dépôt) :
node --input-type=module -e "import {Quat,Vec3} from './node_modules/playcanvas/build/playcanvas.mjs'; const s=<pose collée>; const t=new Quat().setFromEulerAngles(...s.angles).transformVector(Vec3.FORWARD,new Vec3()).mulScalar(s.distance).add(new Vec3(...s.position)); console.log(JSON.stringify({position:s.position.map(v=>+v.toFixed(3)),target:[t.x,t.y,t.z].map(v=>+v.toFixed(3))}))"
# fov 85 en intérieur, 75 en extérieur. Test : http://localhost:4001/?project=projects/<projet>/project.json

# géoréférencement (TKT-227) : splat-transform perd "offset" et "epsg" du .lcc,
# les recopier dans le bloc "coordinates" du settings.json de la scène
# (offset recopié avec toutes ses décimales ; epsg 0 = repère local, rien n'est écrit).
# H est la hauteur du .lcc : ellipsoïdale par défaut, --height-ref ngf si elle est en NGF.
node scripts/lcc-coordinates.mjs lcc-result/Villa_Callian.lcc settings.json

# zones Lambert CC (TKT-232) : le panneau Point propose aussi la zone CC42 à CC50 du chantier,
# déduite de la latitude (partie entière : Callian 43,62° N → CC43). Pour imposer une autre zone,
# ajouter "displayEpsg": 3944 (3942 à 3950) au bloc "coordinates" du settings.json.

# vitesse de déplacement (TKT-241) : 5 niveaux, clavier 1, 2, 4, 8 et 16 m/s (joystick moitié moins).
# Niveau au chargement, par scène, dans project.json : "speed": 2 (1 très lente … 5 très rapide, 3 par défaut),
# par exemple 2 dans une pièce, 4 au-dessus d'un site. Hors projet : ?speed=2.
# L'utilisateur le change dans Paramètres ou avec + / - ; son choix vaut pour la scène jusqu'à la fin de la session.

# altitude NGF-IGN69 (TKT-231) : le viewer convertit H ellipsoïdale avec la grille RAF20 de l'IGN,
# static/geoid/fr_ign_RAF20.gtx (France continentale, 640 Ko), copiée dans public/geoid/ au build
# et chargée seulement si l'utilisateur choisit « Altitude NGF ». Déployer public/geoid/ avec le viewer.
# Régénérer la grille (PROJ l'installe, sinon https://cdn.proj.org/fr_ign_RAF20.tif) :
gdal_translate -of GTX "$(projinfo --searchpaths | tail -1)/fr_ign_RAF20.tif" static/geoid/fr_ign_RAF20.gtx && rm static/geoid/*.aux.xml

# nuage de points LiDAR → LOD (TKT-228)
# Outil : scripts/las-to-splats.mjs. Chaque point LiDAR devient un petit splat opaque de sa couleur,
# en 5 niveaux de LOD (chaque niveau garde la moitié des points, en points plus gros).
# Options utiles :
#   --size 0.02          diamètre d'un point au niveau 0, en m (0.015 par défaut ; plus gros = moins de trous de près)
#   --epsg 2154          système du nuage, obligatoire si le LAS ne le déclare pas
#   --height-ref ngf     H en altitude NGF (sinon ellipsoïdale)
#   --settings <json>    écrit epsg / offset / heightRef dans le settings.json de la scène
#   --lcc <modèle.lcc>   reprend l'offset et l'epsg du .lcc : nuage et splats dans le même repère
# Les .laz sont décompressés par PDAL (brew install pdal).
# Les PLY intermédiaires sont gros (~3 Go pour 25 M points) : les écrire dans tmp/, pas dans public/.

## Étape 1 : LAS → PLY par niveau (quelques secondes)
node scripts/las-to-splats.mjs public/projects/parking-muy/20260127_Parking_A8_Muy.las tmp/parking-muy-pc --epsg 2154 --height-ref ngf --settings public/projects/parking-muy/settings.json

## Étape 2 : PLY → lod-meta.json (≈ 11 min pour 25 M points). Pas de -r : la rotation est déjà faite.
splat-transform -w --lod-chunk-count 256 tmp/parking-muy-pc/lod0.ply -l 0 tmp/parking-muy-pc/lod1.ply -l 1 tmp/parking-muy-pc/lod2.ply -l 2 tmp/parking-muy-pc/lod3.ply -l 3 tmp/parking-muy-pc/lod4.ply -l 4 public/projects/parking-muy/pointcloud/lod-meta.json

## Étape 3 : supprimer les PLY de tmp/

## Nuage à superposer à un modèle splat existant : remplacer --epsg/--height-ref par --lcc
node scripts/las-to-splats.mjs nuage.laz tmp/nuage --lcc lcc-result/Villa_Callian.lcc
# puis dans project.json, à côté de "content" : "pointcloud": "./pointcloud/lod-meta.json"
# → bouton « Nuage de points LiDAR » dans la barre d'outils (bascule avec caméra conservée).
# Nuage seul (sans splats) : "pointcloud" sans "content", comme projects/parking-muy/project.json.
# Le viewer sait alors que c'est un nuage et affiche aussi les points de moins d'un pixel (vue de loin).
# Test : http://localhost:4001/?project=projects/parking-muy/project.json

# 1. Export LCC → PLY (LOD 0 = pleine résolution)
splat-transform -w -L 0 Maison_Nico.lcc -N full.ply

# 2. Pipeline PLY avec tes propres niveaux
splat-transform -w full.ply -d 70% lod1.ply
splat-transform -w full.ply -d 45% lod2.ply
splat-transform -w full.ply -d 25% lod3.ply
splat-transform -w full.ply -d 10% lod4.ply

# 3. Combinaison finale
splat-transform -w -i 16 --lod-chunk-count 128 full.ply -l 0 lod1.ply -l 1 lod2.ply -l 2 lod3.ply -l 3 lod4.ply -l 4 lod-output/lod-meta.json -H 1

# pour créer les lod depuis un ply source

## passer de 3sh à 1sh
splat-transform input.ply -H 1 output.ply

## Étape 1 : Créer les LODs décimés (PLY intermédiaires)
splat-transform -w ton-modele.ply -d 50% lod1.ply
splat-transform -w ton-modele.ply -d 25% lod2.ply

## Étape 2 : Combiner en LOD streaming avec filtrage SH
splat-transform -w -i 16 --lod-chunk-count 256 ton-modele.ply -l 0 lod1.ply -l 1 lod2.ply -l 2 output/lod-meta.json -H 1

# LODs intermédiaires plus granulaires
splat-transform -w ton-modele.ply -d 70% lod1.ply
splat-transform -w ton-modele.ply -d 45% lod2.ply
splat-transform -w ton-modele.ply -d 25% lod3.ply
splat-transform -w ton-modele.ply -d 10% lod4.ply

# Combinaison finale (SH filtrage uniquement ici, pas aux étapes intermédiaires)
splat-transform -w -i 16 --lod-chunk-count 256 ton-modele.ply -l 0 lod1.ply -l 1 lod2.ply -l 2 lod3.ply -l 3 lod4.ply -l 4 output/lod-meta.json -H 1
