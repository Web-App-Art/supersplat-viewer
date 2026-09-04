// ARTLIGHT
//
// Portails : hotspots cliquables qui font passer d'une scène du projet à une
// autre. Voir project.ts pour le modèle de données et la raison d'être.
//
// Le hotspot réutilise le script Annotation, qui gère déjà le dur — taille
// écran constante, atténuation quand la géométrie l'occulte, cible de clic DOM
// superposée. Un portail n'en diffère que par deux crochets : le panneau
// s'ouvre au survol (`showOnHover`) au lieu du clic, et le clic navigue
// (`onActivate`) au lieu d'ouvrir le panneau.

import { Entity } from 'playcanvas';

import { Annotation } from './annotation';
import { findPortal, resolveScene, validateProject } from './project';
import type { Portal, ProjectContext } from './project';
import type { Global } from './types';

/** Durée du fondu, dans les deux sens. */
const FADE_MS = 320;

/**
 * Filet de sécurité : si la première frame n'arrive jamais (onglet en
 * arrière-plan, où Chrome suspend requestAnimationFrame, ou échec de
 * chargement), on lève le voile quand même plutôt que de laisser un écran noir.
 */
const FADE_IN_TIMEOUT_MS = 8000;

const createFader = (initiallyOpaque: boolean): HTMLDivElement => {
    const el = document.createElement('div');
    el.id = 'portal-fade';
    Object.assign(el.style, {
        position: 'fixed',
        inset: '0',
        background: '#000',
        opacity: initiallyOpaque ? '1' : '0',
        pointerEvents: 'none',
        zIndex: '10000',
        transition: `opacity ${FADE_MS}ms ease`
    });
    document.body.appendChild(el);
    return el;
};

class Portals {
    context: ProjectContext | null = null;

    portals: Portal[] = [];

    fader: HTMLDivElement | null = null;

    /** Empêche deux traversées concurrentes si l'on clique deux portails de suite. */
    travelling = false;

    constructor(global: Global) {
        const context = (window as any).sse?.project as ProjectContext | undefined;
        if (!context) {
            return;
        }

        // Un project.json mal formé désactive les portails mais laisse la scène
        // s'afficher : perdre la navigation est ennuyeux, perdre le rendu de la
        // scène le serait bien davantage.
        try {
            validateProject(context.project);
        } catch (err) {
            console.error('Portails désactivés —', (err as Error).message);
            return;
        }

        this.context = context;

        const scene = resolveScene(context.project, context.sceneId);
        this.portals = scene.portals ?? [];

        const arriveParam = new URL(location.href).searchParams.get('arrive');
        this.fader = createFader(!!arriveParam);

        if (arriveParam) {
            this._fadeIn(global);
        }

        this._createHotspots(global);
    }

    /**
     * Lève le voile noir hérité de la scène précédente, une fois la première
     * frame rendue pour que la transition ne découvre pas un écran vide.
     *
     * @param {Global} global - Le contexte applicatif.
     */
    _fadeIn(global: Global) {
        let done = false;
        const reveal = () => {
            if (done) {
                return;
            }
            done = true;
            this.fader.style.opacity = '0';
            setTimeout(() => this.fader?.remove(), FADE_MS);
        };

        global.events.once('firstFrame', reveal);
        setTimeout(reveal, FADE_IN_TIMEOUT_MS);
    }

    _createHotspots(global: Global) {
        if (this.portals.length === 0) {
            return;
        }

        // Annotations crée ce parent ; sans lui (option `noui`) il n'y a pas
        // d'overlay où accrocher les hotspots.
        if (!Annotation.parentDom) {
            return;
        }

        for (const portal of this.portals) {
            const entity = new Entity(`portal:${portal.id}`);
            entity.addComponent('script');
            entity.script.create(Annotation);

            const script = (entity.script as any).annotation as Annotation;
            script.label = portal.glyph ?? '→';
            script.title = portal.label ?? portal.to;
            script.text = '';
            script.showOnHover = true;
            script.onActivate = () => this.travel(portal);

            entity.setPosition(portal.position[0], portal.position[1], portal.position[2]);
            global.app.root.addChild(entity);
        }

        global.app.renderNextFrame = true;
    }

    /**
     * Traverse vers la scène cible. La pose d'arrivée n'est pas transmise dans
     * l'URL : seul l'identifiant du portail l'est, et la scène d'arrivée relit
     * `arrival` depuis le project.json. L'URL reste courte et partageable, et
     * la pose ne peut pas désynchroniser d'avec sa définition.
     *
     * @param {Portal} portal - Le portail emprunté.
     */
    travel(portal: Portal) {
        if (this.travelling || !this.context) {
            return;
        }
        this.travelling = true;

        const url = new URL(location.href);
        url.searchParams.set('project', this.context.projectParam);
        url.searchParams.set('scene', portal.to);
        url.searchParams.set('arrive', portal.id);

        this.fader.style.opacity = '1';
        setTimeout(() => {
            location.href = url.href;
        }, FADE_MS);
    }
}

/**
 * Applique la pose d'arrivée d'un portail aux réglages de la scène cible, avant
 * que le viewer ne les consomme. Passer par les réglages évite de toucher au
 * CameraManager, qui lit déjà `cameras[0].initial`.
 *
 * @param {any} settings - Les réglages de la scène d'arrivée, modifiés en place.
 * @param {ProjectContext} context - Le contexte projet résolu au démarrage.
 * @param {string} [arriveParam] - Identifiant du portail emprunté.
 * @returns {any} Les réglages, pour chaînage.
 */
const applyArrivalPose = (settings: any, context: ProjectContext, arriveParam?: string | null) => {
    const portal = findPortal(context.project, arriveParam);
    if (!portal?.arrival) {
        return settings;
    }

    const camera = settings?.cameras?.[0];
    if (!camera?.initial) {
        return settings;
    }

    camera.initial = {
        ...camera.initial,
        position: portal.arrival.position,
        target: portal.arrival.target,
        ...(portal.arrival.fov !== undefined ? { fov: portal.arrival.fov } : {})
    };

    return settings;
};

export { Portals, applyArrivalPose };
