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

The app supports a few useful URL parameters (though please note these are subject to change):

| Parameter | Description | Default |
| --------- | ----------- | ------- |
| `settings` | URL of the `settings.json` file | `./settings.json` |
| `content` | URL of the scene file (`.ply`, `.sog`, `.meta.json`, `.lod-meta.json`) | `./scene.compressed.ply` |
| `skybox` | URL of an equirectangular skybox image | |
| `poster` | URL of an image to show while loading | |
| `noui` | Hide UI | |
| `noanim` | Start with animation paused | |
| `ministats` | Show runtime CPU/GPU performance graphs | |
| `unified` | Force unified rendering mode | |
| `aa` | Enable antialiasing (not supported in unified mode) | |

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

## Settings Schema

The `settings.json` file has the following schema (defined in TypeScript and taken from the SuperSplat editor):


```typescript
type AnimTrack = {
    name: string,
    duration: number,
    frameRate: number,
    target: 'camera',
    loopMode: 'none' | 'repeat' | 'pingpong',
    interpolation: 'step' | 'spline',
    smoothness: number,
    keyframes: {
        times: number[],
        values: {
            position: number[],
            target: number[],
        }
    }
};

type ExperienceSettings = {
    camera: {
        fov?: number,
        position?: number[],
        target?: number[],
        startAnim: 'none' | 'orbit' | 'animTrack',
        animTrack: string
    },
    background: {
        color?: number[]
    },
    animTracks: AnimTrack[]
};
```

### Example settings.json

```json
{
  "background": {"color": [0,0,0,0]},
  "camera": {
    "fov": 1.0,
    "position": [0,1,-1],
    "target": [0,0,0],
    "startAnim": "orbit"
  },
  "animTracks": []
}
```
pm2 start npm --name "splatviewer" -- run serve


# pour créer les lod depuis un lcc source
splat-transform -w -O 0,1,2 -H 1 -i 16 -C 256 Maison_Nico.lcc -r 90,0,0 ../lod-output/lod-meta.json

ou

splat-transform -w -O 0,1,2,3,4 -H 1 -i 16 -C 128 lcc-result/VillaCavalaire.lcc -r 90,0,0 lod-output/lod-meta.json

# 1. Export LCC → PLY (LOD 0 = pleine résolution)
splat-transform -w -O 0 Maison_Nico.lcc -r 90,0,0 full.ply

# 2. Pipeline PLY avec tes propres niveaux
splat-transform -w -F 70% full.ply lod1.ply
splat-transform -w -F 45% full.ply lod2.ply
splat-transform -w -F 25% full.ply lod3.ply
splat-transform -w -F 10% full.ply lod4.ply

# 3. Combinaison finale
splat-transform -w -H 1 -i 16 -C 128 full.ply -l 0 lod1.ply -l 1 lod2.ply -l 2 lod3.ply -l 3 lod4.ply -l 4 lod-output/lod-meta.json

# pour créer les lod depuis un ply source

## passer de 3sh à 1sh
splat-transform -H 1 input.ply output.ply

## Étape 1 : Créer les LODs décimés (PLY intermédiaires)
splat-transform -w -F 50% ton-modele.ply lod1.ply
splat-transform -w -F 25% ton-modele.ply lod2.ply

## Étape 2 : Combiner en LOD streaming avec filtrage SH
splat-transform -w -H 1 -i 16 -C 256 ton-modele.ply -l 0 lod1.ply -l 1 lod2.ply -l 2 output/lod-meta.json

# LODs intermédiaires plus granulaires
splat-transform -w -F 70% ton-modele.ply lod1.ply
splat-transform -w -F 45% ton-modele.ply lod2.ply
splat-transform -w -F 25% ton-modele.ply lod3.ply
splat-transform -w -F 10% ton-modele.ply lod4.ply

# Combinaison finale (SH filtrage uniquement ici, pas aux étapes intermédiaires)
splat-transform -w -H 1 -i 16 -C 256 ton-modele.ply -l 0 lod1.ply -l 1 lod2.ply -l 2 lod3.ply -l 3 lod4.ply -l 4 output/lod-meta.json
