// ARTLIGHT (TKT-241)
//
// Vitesse de déplacement en cinq niveaux. Le niveau multiplie les vitesses
// d'origine du viewer en vue drone (clavier 4 m/s, joystick 2 m/s, manette,
// molette et pincement) ; le niveau 3 les laisse inchangées. L'orbite, le
// panoramique à la souris ou à deux doigts (1:1 avec l'écran) et la rotation
// du regard n'en dépendent pas.
//
// Chaque scène a son niveau par défaut (`speed` dans le project.json, ou
// `?speed=` hors projet) : lent dans une pièce, rapide au-dessus d'un site.
// Le niveau choisi par l'utilisateur est mémorisé par scène le temps de la
// session (bascule splats / nuage, allers-retours par les portails) mais pas
// au-delà : la visite suivante repart du défaut de la scène.

// Chaque niveau double le précédent : clavier 1, 2, 4, 8 et 16 m/s.
const SPEED_FACTORS = [0.25, 0.5, 1, 2, 4];

const SPEED_LEVELS = SPEED_FACTORS.length;

const DEFAULT_SPEED_LEVEL = 3;

const STORAGE_PREFIX = 'artlight.speed:';

/**
 * Niveau valide (entier de 1 à 5), depuis un nombre ou une chaîne.
 *
 * @param {unknown} value - Valeur lue (project.json, URL, stockage).
 * @returns {number | null} Le niveau, ou null s'il est absent ou invalide.
 */
const parseSpeedLevel = (value: unknown): number | null => {
    const level = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    return typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= SPEED_LEVELS ? level : null;
};

/**
 * Multiplicateur des vitesses de déplacement pour un niveau.
 *
 * @param {number} level - Niveau de 1 à 5.
 * @returns {number} Le multiplicateur (1 au niveau 3).
 */
const speedFactor = (level: number): number => SPEED_FACTORS[level - 1] ?? 1;

/**
 * Niveau de départ : celui choisi dans la session pour cette scène, sinon le
 * défaut de la scène, sinon le niveau 3.
 *
 * @param {string} [sceneKey] - Identifiant de la scène (URL des splats).
 * @param {unknown} [sceneDefault] - Niveau par défaut de la scène.
 * @returns {number} Le niveau de 1 à 5.
 */
const loadSpeedLevel = (sceneKey?: string, sceneDefault?: unknown): number => {
    let stored: string | null = null;
    if (sceneKey) {
        try {
            stored = sessionStorage.getItem(STORAGE_PREFIX + sceneKey);
        } catch {
            // stockage indisponible : défaut de la scène
        }
    }

    const fallback = parseSpeedLevel(sceneDefault);
    if (sceneDefault !== undefined && sceneDefault !== null && fallback === null) {
        console.warn(`Vitesse de déplacement ignorée : ${JSON.stringify(sceneDefault)} (niveau entier de 1 à ${SPEED_LEVELS} attendu)`);
    }

    return parseSpeedLevel(stored) ?? fallback ?? DEFAULT_SPEED_LEVEL;
};

/**
 * Mémorise le niveau choisi pour la scène, le temps de la session.
 *
 * @param {string} [sceneKey] - Identifiant de la scène (URL des splats).
 * @param {number} level - Niveau de 1 à 5.
 */
const saveSpeedLevel = (sceneKey: string | undefined, level: number) => {
    if (!sceneKey) return;
    try {
        sessionStorage.setItem(STORAGE_PREFIX + sceneKey, String(level));
    } catch {
        // stockage indisponible : niveau non mémorisé
    }
};

export { SPEED_LEVELS, loadSpeedLevel, saveSpeedLevel, speedFactor };
