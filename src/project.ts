// ARTLIGHT
//
// Un « projet » regroupe plusieurs scènes indépendantes (chacune son propre
// nuage de splats, ses réglages et sa collision) reliées par des portails.
//
// C'est la réponse au cas où plusieurs scans ne partagent aucun repère commun :
// un scan extérieur géoréférencé et des scans intérieurs en repère local ne
// peuvent pas être fusionnés sans recalage manuel. Un portail contourne le
// problème au lieu de le résoudre — il relie une position de départ, exprimée
// dans le repère de la scène source, à une pose d'arrivée exprimée dans le
// repère de la scène cible. Les deux repères ne se rencontrent jamais.

type Vec3Tuple = [number, number, number];

/** Pose de caméra appliquée à l'arrivée, dans le repère de la scène cible. */
type PortalArrival = {
    position: Vec3Tuple;
    target: Vec3Tuple;
    fov?: number;
};

type Portal = {
    /** Identifiant unique dans tout le projet ; sert de valeur au paramètre `arrive`. */
    id: string;
    /** Identifiant de la scène de destination. */
    to: string;
    /** Libellé affiché au survol du hotspot. */
    label?: string;
    /** Glyphe dessiné dans le hotspot (1 caractère conseillé). */
    glyph?: string;
    /** Position du hotspot, dans le repère de la scène qui le contient. */
    position: Vec3Tuple;
    /** Pose d'arrivée ; à défaut, la caméra initiale de la scène cible est conservée. */
    arrival?: PortalArrival;
};

/**
 * ARTLIGHT (TKT-268) : un niveau de la carte, préparé par scripts/scene-map.mjs.
 * bounds en (E, N) du repère source : un point moteur (x, y, z) est en (−x, z).
 */
type SceneMapLevel = {
    id: string;
    name?: string;
    /** Hauteur du sol, y moteur. */
    floor: number;
    bounds: [number, number, number, number];
    /** Vue de dessus (.webp transparent hors scan), relative au project.json. */
    photo: string;
    /** Carte des murs (PNG gris + alpha), mêmes bounds ; absente pour une vue d'avion. */
    walls?: string;
};

type SceneMap = {
    /** Angle du nord en degrés, 0 = en haut ; absent pour une scène non géoréférencée. */
    north?: number;
    levels: SceneMapLevel[];
};

type ProjectScene = {
    id: string;
    name?: string;
    /** URL des splats, relative au project.json. Facultative pour une scène nuage seul. */
    content?: string;
    /**
     * ARTLIGHT (TKT-228) : nuage de points LiDAR converti en splats-points
     * (scripts/las-to-splats.mjs), dans le même repère que `content`. Avec
     * `content`, la bascule Splats / Nuage de points apparaît ; seul, c'est le
     * contenu de la scène.
     */
    pointcloud?: string;
    /** URL des réglages, relative au project.json. */
    settings?: string;
    collision?: string;
    skybox?: string;
    /** `false` supprime l'animation d'intro générée automatiquement. */
    intro?: boolean;
    /**
     * ARTLIGHT (TKT-241) : niveau de vitesse de déplacement au chargement, de
     * 1 (très lente) à 5 (très rapide), 3 par défaut. Voir src/move-speed.ts.
     */
    speed?: number;
    portals?: Portal[];
    /** ARTLIGHT (TKT-268) : carte de la scène, voir src/minimap.ts. */
    map?: SceneMap;
};

type Project = {
    version: number;
    name?: string;
    defaultScene?: string;
    scenes: ProjectScene[];
};

/** Contexte résolu au démarrage, transmis au runtime via `window.sse.project`. */
type ProjectContext = {
    project: Project;
    /** Valeur brute du paramètre `project` de l'URL, réutilisée telle quelle pour naviguer. */
    projectParam: string;
    /** Identifiant de la scène active. */
    sceneId: string;
};

/**
 * Valide la forme d'un project.json. Volontairement permissif sur les champs
 * optionnels, strict sur ce dont la navigation dépend : sans `id` unique ni
 * `to` résoluble, un portail mène dans le vide.
 *
 * @param {unknown} data - Le JSON désérialisé à valider.
 * @returns {Project} Le projet validé.
 */
const validateProject = (data: unknown): Project => {
    const obj = data as Project;
    if (!obj || typeof obj !== 'object') {
        throw new Error('project: racine attendue de type objet');
    }
    if (!Array.isArray(obj.scenes) || obj.scenes.length === 0) {
        throw new Error('project.scenes doit être un tableau non vide');
    }

    const sceneIds = new Set<string>();
    const portalIds = new Set<string>();

    obj.scenes.forEach((scene, i) => {
        if (!scene || typeof scene.id !== 'string' || scene.id === '') {
            throw new Error(`project.scenes[${i}].id manquant`);
        }
        if (sceneIds.has(scene.id)) {
            throw new Error(`project.scenes[${i}].id dupliqué: '${scene.id}'`);
        }
        sceneIds.add(scene.id);

        const isUrl = (v: unknown) => typeof v === 'string' && v !== '';
        if (scene.content !== undefined && !isUrl(scene.content)) {
            throw new Error(`project.scenes[${i}].content doit être une URL`);
        }
        if (scene.pointcloud !== undefined && !isUrl(scene.pointcloud)) {
            throw new Error(`project.scenes[${i}].pointcloud doit être une URL`);
        }
        if (scene.content === undefined && scene.pointcloud === undefined) {
            throw new Error(`project.scenes[${i}].content manquant`);
        }

        (scene.portals ?? []).forEach((portal, j) => {
            const at = `project.scenes[${i}].portals[${j}]`;
            if (!portal || typeof portal.id !== 'string' || portal.id === '') {
                throw new Error(`${at}.id manquant`);
            }
            if (portalIds.has(portal.id)) {
                throw new Error(`${at}.id dupliqué: '${portal.id}'`);
            }
            portalIds.add(portal.id);

            if (typeof portal.to !== 'string') {
                throw new Error(`${at}.to manquant`);
            }
            if (!Array.isArray(portal.position) || portal.position.length !== 3) {
                throw new Error(`${at}.position doit être [x, y, z]`);
            }
        });
    });

    // Les destinations ne sont vérifiées qu'une fois toutes les scènes connues,
    // pour autoriser un portail qui pointe vers une scène déclarée plus loin.
    obj.scenes.forEach((scene, i) => {
        (scene.portals ?? []).forEach((portal, j) => {
            if (!sceneIds.has(portal.to)) {
                throw new Error(
                    `project.scenes[${i}].portals[${j}].to='${portal.to}' ne correspond à aucune scène`
                );
            }
        });
    });

    return obj;
};

/**
 * Sélectionne la scène demandée, avec repli sur `defaultScene` puis la première.
 *
 * @param {Project} project - Le projet.
 * @param {string} [sceneId] - Identifiant de la scène recherchée.
 * @returns {ProjectScene} La scène résolue.
 */
const resolveScene = (project: Project, sceneId?: string | null): ProjectScene => {
    return (
        project.scenes.find(s => s.id === sceneId) ??
        project.scenes.find(s => s.id === project.defaultScene) ??
        project.scenes[0]
    );
};

/**
 * Retrouve un portail par identifiant, toutes scènes confondues.
 *
 * @param {Project} project - Le projet.
 * @param {string} [portalId] - Identifiant du portail recherché.
 * @returns {Portal | null} Le portail, ou null s'il n'existe pas.
 */
const findPortal = (project: Project, portalId?: string | null): Portal | null => {
    if (!portalId) {
        return null;
    }
    for (const scene of project.scenes) {
        const found = (scene.portals ?? []).find(p => p.id === portalId);
        if (found) {
            return found;
        }
    }
    return null;
};

export type { Portal, PortalArrival, Project, ProjectContext, ProjectScene, SceneMap, SceneMapLevel };
export { findPortal, resolveScene, validateProject };
