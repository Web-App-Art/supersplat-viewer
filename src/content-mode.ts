// ARTLIGHT (TKT-228)
//
// Bascule entre les splats d'une scène et son nuage de points LiDAR. Le nuage
// est converti en « splats-points » (scripts/las-to-splats.mjs) dans le même
// repère : les deux contenus se superposent, et tous les outils fonctionnent
// sur l'un comme sur l'autre.
//
// La bascule recharge la page avec l'autre contenu plutôt que d'échanger
// l'entité gsplat en place : picker, outils et LOD restent initialisés comme
// au premier chargement, et un seul contenu occupe la mémoire (le mobile n'a
// pas la place pour deux). La pose de caméra passe dans l'URL (`view`) et
// remplace la caméra initiale, comme la pose d'arrivée d'un portail.

import { Vec3 } from 'playcanvas';

import type { Camera } from './cameras/camera';
import type { ExperienceSettings } from './settings';
import type { ContentMode } from './types';

const MODE_PARAM = 'mode';

const VIEW_PARAM = 'view';

// Décimales de la pose : le mm suffit, l'URL reste lisible.
const VIEW_DECIMALS = 3;

const tmpTarget = new Vec3();

/**
 * Applique la pose `view` de l'URL (px,py,pz,tx,ty,tz,fov) à la caméra
 * initiale. Une pose mal formée est ignorée.
 *
 * @param {ExperienceSettings} settings - Réglages de la scène, modifiés en place.
 * @param {string | null} param - Valeur du paramètre `view`.
 * @returns {boolean} true si la pose a été appliquée.
 */
const applyViewParam = (settings: ExperienceSettings, param: string | null): boolean => {
    const values = param?.split(',').map(Number);
    if (!values || values.length !== 7 || !values.every(Number.isFinite)) {
        return false;
    }

    settings.cameras ??= [];
    settings.cameras[0] = {
        ...settings.cameras[0],
        initial: {
            position: [values[0], values[1], values[2]],
            target: [values[3], values[4], values[5]],
            fov: values[6]
        }
    };
    return true;
};

/**
 * URL de la même scène avec l'autre contenu, la caméra à la même pose.
 *
 * @param {ContentMode} mode - Contenu à afficher.
 * @param {Camera} camera - Caméra courante.
 * @returns {string} L'URL à charger.
 */
const contentModeUrl = (mode: ContentMode, camera: Camera): string => {
    camera.calcFocusPoint(tmpTarget);
    const { position } = camera;
    const view = [position.x, position.y, position.z, tmpTarget.x, tmpTarget.y, tmpTarget.z]
    .map(v => v.toFixed(VIEW_DECIMALS))
    .concat(String(Math.round(camera.fov * 10) / 10));

    const url = new URL(location.href);
    if (mode === 'pointcloud') {
        url.searchParams.set(MODE_PARAM, mode);
    } else {
        url.searchParams.delete(MODE_PARAM);
    }
    url.searchParams.set(VIEW_PARAM, view.join(','));
    // La pose d'arrivée d'un portail ne doit pas écraser celle-ci.
    url.searchParams.delete('arrive');
    return url.href;
};

export { VIEW_PARAM, applyViewParam, contentModeUrl };
