// ARTLIGHT (TKT-297)
//
// Quel splat-transform lancer, partagé par scene-map.mjs et publier-scene.mjs.
// Par ordre de priorité :
//   1. la variable SPLAT_TRANSFORM (chemin d'un exécutable), si elle est posée ;
//   2. celui du dépôt, node_modules/.bin/splat-transform, à la version épinglée
//      dans package.json (devDependency : `npm install` dans le fork suffit) ;
//   3. celui du PATH : installation globale (kit calcul-scenes du monorepo,
//      `npm install -g @playcanvas/splat-transform@3.10.0`), ou l'enveloppe que
//      banc.sh met en tête du PATH pour imposer ses options GPU.
// Le kit calcul-scenes clone le fork sans `npm install` : c'est donc le PATH
// qui sert là-bas, comme avant.
// SPLAT_TRANSFORM_OPTIONS ajoute des options globales à chaque appel, par
// exemple « --gpu-backend vulkan » ou « -g 0 » sur une machine Linux.

import { execFileSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export const SPLAT_TRANSFORM_VERSION = '3.10.0';

const here = dirname(fileURLToPath(import.meta.url));

export const splatTransformCommand = () => {
    if (process.env.SPLAT_TRANSFORM) return { cmd: process.env.SPLAT_TRANSFORM, source: 'SPLAT_TRANSFORM' };
    const local = join(here, '..', 'node_modules', '.bin', 'splat-transform');
    if (existsSync(local)) return { cmd: local, source: 'dépôt (node_modules)' };
    return { cmd: 'splat-transform', source: 'PATH' };
};

export const splatTransformOptions = () => (process.env.SPLAT_TRANSFORM_OPTIONS ?? '').split(/\s+/).filter(Boolean);

// Version annoncée par `splat-transform --version` (« splat-transform v3.10.0 (b57ea7b) »),
// null si l'exécutable est introuvable.
export const splatTransformVersion = () => {
    const { cmd } = splatTransformCommand();
    // la version part sur la sortie d'erreur quand la sortie standard n'est pas un terminal
    const r = spawnSync(cmd, ['--version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.error || r.status !== 0) return null;
    const out = `${r.stdout}${r.stderr}`;
    return /v?(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? (out.trim() || null);
};

// Lance splat-transform ; lève une erreur avec la fin de sa sortie d'erreur.
export const runSplatTransform = (list, { quiet = true, stdout = 'ignore' } = {}) => {
    const { cmd } = splatTransformCommand();
    return execFileSync(cmd, [...splatTransformOptions(), ...(quiet ? ['-q'] : []), ...list], {
        stdio: ['ignore', stdout, 'pipe'],
        encoding: stdout === 'pipe' ? 'utf-8' : undefined,
        maxBuffer: 256 * 1024 * 1024
    });
};
