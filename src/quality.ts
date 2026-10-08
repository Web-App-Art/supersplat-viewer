// ARTLIGHT (TKT-270)
//
// Qualité d'affichage en trois choix, dans le menu Qualité de la barre
// principale : Auto, Standard ou Haute. Standard est l'ancien « mode
// performance » : canevas à demi-résolution, budget de splats réduit.
//
// Auto démarre en Haute sur ordinateur et en Standard sur mobile. Sur
// ordinateur, il passe en Standard si l'affichage saccade pendant les
// déplacements, et y reste jusqu'à la fin de la visite : remonter seul ferait
// osciller la qualité. Le choix de l'utilisateur est mémorisé d'une visite à
// l'autre ; un choix explicite (Standard ou Haute) n'est jamais modifié.

type QualityChoice = 'auto' | 'standard' | 'high';

const QUALITY_CHOICES: QualityChoice[] = ['auto', 'standard', 'high'];

const STORAGE_KEY = 'artlight.quality';

// Ancien interrupteur « Mode performance » (et son prédécesseur inversé
// retinaDisplay). Coché une fois, il restait coché pour toutes les scènes :
// on l'oublie, la nouvelle visite repart en Auto.
const LEGACY_KEYS = ['performanceMode', 'retinaDisplay'];

// Saccade : moins de 20 images/s en moyenne sur 90 images consécutives
// (environ 4 s de mouvement à ce rythme).
const MIN_FPS = 20;
const WINDOW_FRAMES = 90;

// Au-delà de cet écart entre deux images, la scène était immobile (rendu à la
// demande) : la série recommence.
const MAX_FRAME_GAP_MS = 250;

// Délai après l'apparition de la scène avant de mesurer : le chargement des
// niveaux de détail ralentit les premières images.
const SETTLE_MS = 5000;

const parseQualityChoice = (value: unknown): QualityChoice | null => {
    return QUALITY_CHOICES.includes(value as QualityChoice) ? value as QualityChoice : null;
};

/**
 * Choix mémorisé, Auto par défaut. Oublie l'ancien mode performance.
 *
 * @returns {QualityChoice} Le choix de départ.
 */
const loadQualityChoice = (): QualityChoice => {
    try {
        LEGACY_KEYS.forEach(key => localStorage.removeItem(key));
        return parseQualityChoice(localStorage.getItem(STORAGE_KEY)) ?? 'auto';
    } catch {
        return 'auto';
    }
};

const saveQualityChoice = (choice: QualityChoice) => {
    try {
        if (choice === 'auto') {
            localStorage.removeItem(STORAGE_KEY);
        } else {
            localStorage.setItem(STORAGE_KEY, choice);
        }
    } catch {
        // stockage indisponible : choix valable pour cette visite seulement
    }
};

/**
 * Qualité réduite (Standard) effective.
 *
 * @param {QualityChoice} choice - Choix de l'utilisateur.
 * @param {boolean} autoReduced - Auto a détecté des saccades.
 * @param {boolean} mobile - Appareil mobile.
 * @returns {boolean} true pour la qualité Standard.
 */
const isReducedQuality = (choice: QualityChoice, autoReduced: boolean, mobile: boolean): boolean => {
    if (choice === 'auto') return mobile || autoReduced;
    return choice === 'standard';
};

/**
 * Détecte un affichage qui saccade pendant les déplacements.
 */
class FrameRateWatch {
    private durations: number[] = [];

    private sum = 0;

    private last = -1;

    private since = -1;

    /** Oublie la série en cours ; la mesure reprend après le délai d'attente. */
    reset() {
        this.durations.length = 0;
        this.sum = 0;
        this.last = -1;
        this.since = -1;
    }

    /**
     * Compte une image rendue.
     *
     * @param {number} now - Horodatage de l'image, en ms.
     * @returns {boolean} true si la moyenne des dernières images est trop basse.
     */
    feed(now: number): boolean {
        if (this.since < 0) this.since = now;
        if (now - this.since < SETTLE_MS) {
            this.last = now;
            return false;
        }

        const dt = this.last < 0 ? Infinity : now - this.last;
        this.last = now;
        if (dt > MAX_FRAME_GAP_MS) {
            this.durations.length = 0;
            this.sum = 0;
            return false;
        }

        this.durations.push(dt);
        this.sum += dt;
        if (this.durations.length > WINDOW_FRAMES) {
            this.sum -= this.durations.shift();
        }

        return this.durations.length === WINDOW_FRAMES && this.sum > WINDOW_FRAMES * 1000 / MIN_FPS;
    }
}

export {
    FrameRateWatch,
    isReducedQuality,
    loadQualityChoice,
    QUALITY_CHOICES,
    saveQualityChoice
};

export type { QualityChoice };
