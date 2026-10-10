// ARTLIGHT (TKT-270)
//
// Qualité d'affichage en quatre choix, dans le menu Qualité de la barre
// principale : Auto, Standard, Moyenne ou Haute. Standard est l'ancien « mode
// performance » : canevas à demi-résolution, budget de splats réduit. Moyenne
// (TKT-273, lot 1b) garde la pleine résolution avec un budget intermédiaire :
// pour une connexion lente ou un ordinateur qui saccade en Haute.
//
// Auto démarre en Haute sur ordinateur et en Standard sur mobile. Sur
// ordinateur, si l'affichage saccade pendant les déplacements, il allège le
// budget de splats par paliers, puis passe en Standard (TKT-273). Il ne
// remonte jamais pendant la visite : remonter seul ferait osciller la
// qualité. Le choix de l'utilisateur est mémorisé d'une visite à l'autre ; un
// choix explicite (Standard, Moyenne ou Haute) n'est jamais modifié.

type QualityChoice = 'auto' | 'standard' | 'medium' | 'high';

// Qualité effective, affichée par le badge SD, MD ou HD.
type Quality = 'standard' | 'medium' | 'high';

const QUALITY_CHOICES: QualityChoice[] = ['auto', 'standard', 'medium', 'high'];

const STORAGE_KEY = 'artlight.quality';

// Ancien interrupteur « Mode performance » (et son prédécesseur inversé
// retinaDisplay). Coché une fois, il restait coché pour toutes les scènes :
// on l'oublie, la nouvelle visite repart en Auto.
const LEGACY_KEYS = ['performanceMode', 'retinaDisplay'];

// Budgets de splats, en millions. TKT-273 : 4 M en Haute affichait les pièces
// aux niveaux de détail 2 à 4 ; à 20 M, le salon de Saint-Germain est au
// niveau 0, comme à 40 M (16 M laissait plus flou le jardin vu par les
// fenêtres, pour 2 ms de moins par image). À 8 M, Moyenne charge 370 Mo pour
// entrer dans le salon, contre 660 Mo en Haute : murs et parquet restent
// identiques, seul le jardin vu par les portes est plus flou. Sur mobile, où
// Haute ne vaut que 2 M, Moyenne n'est pas proposée : un choix mémorisé y
// vaut Haute.
const BUDGETS = {
    mobile: { standard: 1, medium: 2, high: 2 },
    desktop: { standard: 2, medium: 8, high: 20 }
};

// Paliers d'Auto sur ordinateur, du budget de Haute au plus léger. Après le
// dernier, Auto passe en Standard.
const AUTO_BUDGETS = [BUDGETS.desktop.high, 10, 6];

// Palier d'Auto qui correspond à la qualité Standard.
const AUTO_STANDARD_STEP = AUTO_BUDGETS.length;

// Saccade : moins de 20 images/s en moyenne sur les 4 dernières secondes.
// Une fenêtre en durée, et non en nombre d'images, laisse le même délai à un
// appareil très lent qu'à un appareil un peu juste.
const MIN_FPS = 20;
const WINDOW_MS = 4000;

// Un écart plus long entre deux images ne compte que si l'image précédente a
// été rendue (image lente). Sinon, la scène était immobile (rendu à la
// demande) et le fil principal occupé ailleurs : la série recommence.
const IDLE_GAP_MS = 250;

// Au-delà, la page était cachée ou l'ordinateur en veille : la série
// recommence dans tous les cas.
const MAX_FRAME_GAP_MS = 2000;

// Délai après l'apparition de la scène, ou après un changement de palier,
// avant de mesurer : le chargement des niveaux de détail ralentit les images.
// La mesure attend aussi la fin de ce chargement, au plus MAX_SETTLE_MS.
const SETTLE_MS = 5000;
const MAX_SETTLE_MS = 15000;

const parseQualityChoice = (value: unknown): QualityChoice | null => {
    return QUALITY_CHOICES.includes(value as QualityChoice) ? value as QualityChoice : null;
};

/**
 * Choix mémorisé, Auto par défaut. Oublie l'ancien mode performance.
 *
 * @param {boolean} mobile - Appareil mobile : Moyenne n'y est pas proposée et
 * se lit Haute.
 * @returns {QualityChoice} Le choix de départ.
 */
const loadQualityChoice = (mobile: boolean): QualityChoice => {
    try {
        LEGACY_KEYS.forEach(key => localStorage.removeItem(key));
        const choice = parseQualityChoice(localStorage.getItem(STORAGE_KEY)) ?? 'auto';
        return choice === 'medium' && mobile ? 'high' : choice;
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
 * Qualité effective. En Auto, les paliers intermédiaires valent Moyenne.
 *
 * @param {QualityChoice} choice - Choix de l'utilisateur.
 * @param {number} step - Palier d'Auto (0 = Haute, AUTO_STANDARD_STEP = Standard).
 * @param {boolean} mobile - Appareil mobile.
 * @returns {Quality} Standard, Moyenne ou Haute.
 */
const effectiveQuality = (choice: QualityChoice, step: number, mobile: boolean): Quality => {
    if (choice === 'auto') {
        if (mobile || step >= AUTO_STANDARD_STEP) return 'standard';
        return step > 0 ? 'medium' : 'high';
    }
    return choice === 'medium' && mobile ? 'high' : choice;
};

/**
 * Qualité réduite (Standard) effective.
 *
 * @param {QualityChoice} choice - Choix de l'utilisateur.
 * @param {number} step - Palier d'Auto.
 * @param {boolean} mobile - Appareil mobile.
 * @returns {boolean} true pour la qualité Standard.
 */
const isReducedQuality = (choice: QualityChoice, step: number, mobile: boolean): boolean => {
    return effectiveQuality(choice, step, mobile) === 'standard';
};

/**
 * Budget de splats de la qualité effective.
 *
 * @param {QualityChoice} choice - Choix de l'utilisateur.
 * @param {number} step - Palier d'Auto.
 * @param {boolean} mobile - Appareil mobile.
 * @returns {number} Budget en millions de splats.
 */
const qualityBudget = (choice: QualityChoice, step: number, mobile: boolean): number => {
    const quality = effectiveQuality(choice, step, mobile);
    if (choice === 'auto' && quality !== 'standard') return AUTO_BUDGETS[step];
    return (mobile ? BUDGETS.mobile : BUDGETS.desktop)[quality];
};

/**
 * Détecte un affichage qui saccade pendant les déplacements.
 */
class FrameRateWatch {
    /** Chargement des niveaux de détail en cours (événement frame:ready du moteur). */
    loading = false;

    private durations: number[] = [];

    private sum = 0;

    private last = -1;

    private since = -1;

    private settled = false;

    private rendered = false;

    /** Oublie la série en cours ; la mesure reprend après le délai d'attente. */
    reset() {
        this.durations.length = 0;
        this.sum = 0;
        this.last = -1;
        this.since = -1;
        this.settled = false;
        this.rendered = false;
    }

    /** L'image en cours est rendue (événement prerender du moteur). */
    markRendered() {
        this.rendered = true;
    }

    /**
     * Compte une image, rendue ou non : avec le rendu à la demande, la scène
     * immobile garde le rythme de l'écran.
     *
     * @param {number} now - Horodatage de l'image, en ms.
     * @returns {boolean} true si la moyenne des dernières secondes est trop basse.
     */
    feed(now: number): boolean {
        const rendered = this.rendered;
        this.rendered = false;

        if (this.since < 0) this.since = now;
        if (!this.settled) {
            const elapsed = now - this.since;
            this.last = now;
            this.settled = elapsed >= MAX_SETTLE_MS || (elapsed >= SETTLE_MS && !this.loading);
            return false;
        }

        const dt = this.last < 0 ? Infinity : now - this.last;
        this.last = now;
        if (dt > MAX_FRAME_GAP_MS || (dt > IDLE_GAP_MS && !rendered)) {
            this.durations.length = 0;
            this.sum = 0;
            return false;
        }

        this.durations.push(dt);
        this.sum += dt;
        while (this.sum - this.durations[0] >= WINDOW_MS) {
            this.sum -= this.durations.shift();
        }

        return this.sum >= WINDOW_MS && this.sum * MIN_FPS > this.durations.length * 1000;
    }
}

export {
    AUTO_STANDARD_STEP,
    effectiveQuality,
    FrameRateWatch,
    isReducedQuality,
    loadQualityChoice,
    QUALITY_CHOICES,
    qualityBudget,
    saveQualityChoice
};

export type { Quality, QualityChoice };
