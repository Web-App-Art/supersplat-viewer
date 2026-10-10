// ARTLIGHT (TKT-271)
//
// Champ de vision réglable dans le panneau Paramètres. Le défaut est celui de
// la caméra initiale de la scène (`cameras[0].initial.fov` du settings.json),
// 75° à défaut. L'angle porte sur la plus grande dimension de l'écran :
// horizontal en paysage, vertical en portrait (voir viewer.ts).
//
// Le réglage vaut pour toutes les vues (départ, cadrage, annotations) : ce
// n'est pas une pose. Comme la vitesse (move-speed.ts), il est mémorisé par
// scène le temps de la session (bascule splats / nuage, allers-retours par
// les portails) mais pas au-delà : la visite suivante repart du défaut.

const FOV_MIN = 30;

const FOV_MAX = 120;

const DEFAULT_FOV = 75;

const STORAGE_PREFIX = 'artlight.fov:';

/**
 * Angle valide en degrés, depuis un nombre ou une chaîne.
 *
 * @param {unknown} value - Valeur lue (settings.json, stockage).
 * @returns {number | null} L'angle, ou null s'il est absent ou invalide.
 */
const parseFov = (value: unknown): number | null => {
    const fov = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof fov === 'number' && Number.isFinite(fov) && fov > 0 && fov < 180 ? fov : null;
};

/**
 * Angle de départ : celui choisi dans la session pour cette scène, sinon
 * celui de la caméra initiale.
 *
 * @param {string} [sceneKey] - Identifiant de la scène (URL des splats).
 * @param {number} initialFov - Angle de la caméra initiale (pose d'arrivée d'un portail comprise).
 * @returns {number} L'angle en degrés.
 */
const loadFov = (sceneKey: string | undefined, initialFov: number): number => {
    let stored: string | null = null;
    if (sceneKey) {
        try {
            stored = sessionStorage.getItem(STORAGE_PREFIX + sceneKey);
        } catch {
            // stockage indisponible : angle de la caméra initiale
        }
    }
    return parseFov(stored) ?? initialFov;
};

/**
 * Mémorise l'angle choisi pour la scène, le temps de la session. Revenir au
 * défaut efface le choix : un portail retrouve alors sa pose d'arrivée.
 *
 * @param {string} [sceneKey] - Identifiant de la scène (URL des splats).
 * @param {number} fov - Angle choisi.
 * @param {number} defaultFov - Angle par défaut de la scène.
 */
const saveFov = (sceneKey: string | undefined, fov: number, defaultFov: number) => {
    if (!sceneKey) return;
    try {
        if (fov === defaultFov) {
            sessionStorage.removeItem(STORAGE_PREFIX + sceneKey);
        } else {
            sessionStorage.setItem(STORAGE_PREFIX + sceneKey, String(fov));
        }
    } catch {
        // stockage indisponible : angle non mémorisé
    }
};

export { DEFAULT_FOV, FOV_MAX, FOV_MIN, loadFov, parseFov, saveFov };
