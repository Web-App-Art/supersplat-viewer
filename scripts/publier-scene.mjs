#!/usr/bin/env node
// ARTLIGHT (TKT-297)
//
// Fabrique d'un bloc une scène prête à servir depuis les sources d'un relevé :
// ce qu'on enchaînait à la main (README, « Générer une scène depuis un .lcc »),
// sans oubli possible et avec un avancement lisible par le CRM.
//
//   node scripts/publier-scene.mjs <dossier des sources> --sortie <dossier de la scène> [options]
//   node scripts/publier-scene.mjs carte <dossier de la scène> [--proposer [--type t]] [--garder-travail]
//
// Sources : un modèle .lcc ou .lcc2 (avec son dossier lcc-result) et, s'il y en
// a un, un nuage .las ou .laz, cherchés dans le dossier (sous-dossiers compris).
//
// Options de la première forme :
//   --sortie <dossier>       dossier de la scène (obligatoire) ; son nom fait le dossier servi
//                            (projects/<nom>/) : lettres, chiffres, « - », « _ », « . »
//   --titre "<titre>"        nom du projet et de la scène (défaut : le nom du dossier)
//   --id <id>                identifiant de la scène dans project.json (défaut « scene »)
//   --sh 1|3                 bandes d'harmoniques sphériques gardées (défaut 1 ; 3 = plus fidèle, 1,7 fois plus lourd sur le studio de Belgentier)
//   --nuage | --sans-nuage   nuage LiDAR exigé, ou ignoré (défaut : converti s'il y en a un)
//   --carte | --sans-carte   proposer la mini-carte (défaut : oui) ; la construire reste un second temps
//   --type auto|interieur|exterieur|mixte   type de scène pour la carte et la vue de départ (défaut auto)
//   --modele <fichier>       le modèle, s'il y en a plusieurs ; --nuage-fichier <fichier> de même
//   --niveaux 0,1,2,3,4      niveaux du modèle convertis (défaut : les 5 premiers, bornés au modèle)
//   --iterations <n>         itérations de la compression SH (défaut 16)
//   --las-options "<…>"      options passées telles quelles à las-to-splats.mjs (ex. "--epsg 2154")
//   --height-ref ellipsoid|ngf   nature des hauteurs pour le géoréférencement (défaut ellipsoid)
//   --gpu <n|cpu>            adaptateur GPU de splat-transform (-g) ; --gpu-backend vulkan|metal|d3d12
//   --travail <dossier>      intermédiaires (PLY, plusieurs Go) ; défaut <sortie>.travail
//   --garder-travail         ne supprime pas les intermédiaires
//   --force                  remplace une scène existante
//   --splat-transform-libre  accepte une autre version que 3.10.0 (déconseillé)
//
// Ce qui est produit dans <sortie>/ (rien n'y apparaît avant la fin : la scène
// est montée dans <sortie>.en-cours/ puis renommée, une scène incomplète
// n'existe donc jamais sous le nom final) :
//   lod-output/lod-meta.json (+ env/ si le modèle a un ciel), pointcloud/ (nuage en LOD),
//   project.json, settings.json (vue de départ calculée, géoréférencement recopié),
//   map/levels.json + map/controle.html et ses vignettes (carte PROPOSÉE, à valider),
//   publication/apercu.webp (image de la vue de départ), publication/journaux/*.log,
//   etat.json (bilan : étapes, durées, contrôles, avertissements).
//
// Avancement : une ligne JSON par événement sur la sortie standard (le reste
// va sur la sortie d'erreur) :
//   {"type":"etape","etape":"splats-lod","evenement":"debut","numero":4,"total":11,"horodatage":"…"}
//   {"type":"etape","etape":"splats-lod","evenement":"fin","duree_s":12.3,"details":{…}}
//   {"type":"etape","etape":"orientation","evenement":"erreur","duree_s":0.1,"code":6,"message":"…","journal":"…"}
//   {"type":"avertissement","etape":"nuage-conversion","message":"…"}
//   {"type":"termine","statut":"ok","duree_s":312.4,"sortie":"…","etat":"…/etat.json"}
//
// Codes de sortie : 0 scène prête, 2 arguments, 3 outils (Node, splat-transform,
// webp, PDAL), 4 sources (introuvables, ambiguës, illisibles), 5 calcul (une
// commande a échoué), 6 contrôle (orientation fausse, ciel perdu, scène vide),
// 7 carte, 1 erreur inattendue ou interruption.
//
// « carte » : une fois levels.json relu et corrigé par un humain, lance
// scene-map.mjs build (fonds de carte, murs, recalage) et écrit le bloc « map »
// dans project.json ; --proposer refait d'abord la proposition (par exemple
// avec un autre --type). Met etat.json à jour, mêmes lignes d'avancement.

import { spawnSync } from 'child_process';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';

import { decideLevels, detectLevels, readSplatsPly, percentiles, SCENE_TYPES } from './scene-map-niveaux.mjs';
import { SPLAT_TRANSFORM_VERSION, splatTransformCommand, splatTransformOptions, splatTransformVersion } from './splat-transform-cli.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const NOM_DOSSIER = /^[\w-][\w.-]*$/;

const CODES = { inattendu: 1, arguments: 2, outils: 3, sources: 4, calcul: 5, controle: 6, carte: 7 };

class Echec extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const maintenant = () => new Date().toISOString();
const dire = message => process.stderr.write(`${message}\n`);
const emettre = objet => process.stdout.write(`${JSON.stringify(objet)}\n`);

// --- arguments ---------------------------------------------------------------

const lireArguments = (argv) => {
    const opts = {
        sh: 1,
        nuage: 'auto',
        carte: true,
        type: 'auto',
        iterations: 16,
        id: 'scene',
        garderTravail: false,
        force: false,
        versionLibre: false,
        proposer: false,
        heightRef: null,
        lasOptions: null,
        gpu: null,
        gpuBackend: null
    };
    const positional = [];
    const valeur = (i, nom) => {
        if (i >= argv.length) throw new Echec(CODES.arguments, `${nom} attend une valeur`);
        return argv[i];
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--sortie': opts.sortie = valeur(++i, a); break;
            case '--titre': opts.titre = valeur(++i, a); break;
            case '--id': opts.id = valeur(++i, a); break;
            case '--sh': opts.sh = Number(valeur(++i, a)); break;
            case '--nuage': opts.nuage = 'oui'; break;
            case '--sans-nuage': opts.nuage = 'non'; break;
            case '--carte': opts.carte = true; break;
            case '--sans-carte': opts.carte = false; break;
            case '--type': opts.type = valeur(++i, a); break;
            case '--modele': opts.modele = valeur(++i, a); break;
            case '--nuage-fichier': opts.nuageFichier = valeur(++i, a); break;
            case '--niveaux': opts.niveaux = valeur(++i, a).split(',').map(Number); break;
            case '--iterations': opts.iterations = Number(valeur(++i, a)); break;
            case '--las-options': opts.lasOptions = valeur(++i, a).split(/\s+/).filter(Boolean); break;
            case '--height-ref': opts.heightRef = valeur(++i, a); break;
            case '--gpu': opts.gpu = valeur(++i, a); break;
            case '--gpu-backend': opts.gpuBackend = valeur(++i, a); break;
            case '--travail': opts.travail = valeur(++i, a); break;
            case '--garder-travail': opts.garderTravail = true; break;
            case '--force': opts.force = true; break;
            case '--splat-transform-libre': opts.versionLibre = true; break;
            case '--proposer': opts.proposer = true; break;
            case '-h': case '--aide': case '--help': opts.aide = true; break;
            default:
                if (a.startsWith('--')) throw new Echec(CODES.arguments, `option inconnue ${a}`);
                positional.push(a);
        }
    }
    if (opts.aide) return { opts, positional };
    if (positional[0] === 'carte') {
        opts.commande = 'carte';
        if (!positional[1]) throw new Echec(CODES.arguments, 'usage : publier-scene.mjs carte <dossier de la scène>');
        opts.scene = resolve(positional[1]);
    } else {
        opts.commande = 'publier';
        if (positional.length !== 1) throw new Echec(CODES.arguments, 'usage : publier-scene.mjs <dossier des sources> --sortie <dossier de la scène> [options]');
        opts.sources = resolve(positional[0]);
        if (!opts.sortie) throw new Echec(CODES.arguments, '--sortie est obligatoire');
        opts.sortie = resolve(opts.sortie);
        if (!NOM_DOSSIER.test(basename(opts.sortie))) {
            throw new Echec(CODES.arguments, `nom de dossier « ${basename(opts.sortie)} » : lettres, chiffres, « - », « _ » et « . » seulement (il fait l'adresse projects/<nom>/)`);
        }
        opts.titre ??= basename(opts.sortie);
        opts.travail = resolve(opts.travail ?? `${opts.sortie}.travail`);
    }
    if (![1, 3].includes(opts.sh)) throw new Echec(CODES.arguments, '--sh attend 1 ou 3');
    if (!SCENE_TYPES.includes(opts.type)) throw new Echec(CODES.arguments, `--type attend ${SCENE_TYPES.join(', ')}`);
    if (!(Number.isInteger(opts.iterations) && opts.iterations > 0)) throw new Echec(CODES.arguments, '--iterations attend un entier positif');
    if (opts.niveaux && !opts.niveaux.every(k => Number.isInteger(k) && k >= 0)) throw new Echec(CODES.arguments, '--niveaux attend une liste d\'entiers, ex. 0,1,2,3,4');
    if (!/^[a-z0-9-]+$/i.test(opts.id)) throw new Echec(CODES.arguments, '--id : lettres, chiffres et tirets');
    if (opts.heightRef && !['ellipsoid', 'ngf'].includes(opts.heightRef)) throw new Echec(CODES.arguments, '--height-ref attend ellipsoid ou ngf');
    if (opts.gpu !== null && !/^(?:cpu|\d+)$/.test(opts.gpu)) throw new Echec(CODES.arguments, '--gpu attend un numéro d\'adaptateur ou cpu');
    if (opts.gpuBackend !== null && !['vulkan', 'metal', 'd3d12'].includes(opts.gpuBackend)) throw new Echec(CODES.arguments, '--gpu-backend attend vulkan, metal ou d3d12');
    return { opts, positional };
};

// --- exécution des étapes ----------------------------------------------------

const creerSuivi = ({ total, racine, journaux }) => {
    const etapes = [];
    const avertissements = [];
    let numero = 0;
    const t0 = Date.now();
    const suivi = {
        etapes,
        avertissements,
        debut: maintenant(),
        duree: () => round((Date.now() - t0) / 1000, 1),
        avertir: (etape, message) => {
            avertissements.push({ etape, message });
            emettre({ type: 'avertissement', etape, message });
            dire(`  ATTENTION ${message}`);
        },
        // Lance une étape ; une erreur la clôt en « erreur » et remonte.
        etape: (nom, fn) => {
            numero++;
            const debut = Date.now();
            const ligne = { etape: nom, numero, total: suivi.total ?? total, debut: maintenant() };
            emettre({ type: 'etape', etape: nom, evenement: 'debut', numero, total: ligne.total, horodatage: ligne.debut });
            dire(`▶ ${nom}`);
            try {
                const details = fn() ?? {};
                ligne.statut = 'ok';
                ligne.duree_s = round((Date.now() - debut) / 1000, 1);
                ligne.details = details;
                etapes.push(ligne);
                emettre({ type: 'etape', etape: nom, evenement: 'fin', numero, duree_s: ligne.duree_s, details });
                dire(`  ok en ${ligne.duree_s} s`);
                return details;
            } catch (e) {
                const code = e instanceof Echec ? e.code : CODES.inattendu;
                ligne.statut = 'erreur';
                ligne.duree_s = round((Date.now() - debut) / 1000, 1);
                ligne.code = code;
                ligne.message = e.message;
                const journal = join(journaux, `${nom}.log`);
                if (existsSync(journal)) ligne.journal = relative(racine(), journal);
                etapes.push(ligne);
                emettre({ type: 'etape', etape: nom, evenement: 'erreur', numero, duree_s: ligne.duree_s, code, message: e.message, ...(ligne.journal ? { journal: ligne.journal } : {}) });
                dire(`  ÉCHEC (${code}) : ${e.message}`);
                throw Object.assign(e instanceof Echec ? e : new Echec(code, e.message), { dejaSignale: true });
            }
        }
    };
    return suivi;
};

// Commande externe, sortie dans le journal de l'étape ; lève Echec(code) avec
// la fin du journal si elle échoue.
const lancer = ({ journaux, etape, cmd, args, code = CODES.calcul, env = {}, cwd }) => {
    mkdirSync(journaux, { recursive: true });
    const journal = join(journaux, `${etape}.log`);
    const fd = openSync(journal, 'a');
    try {
        writeFileSync(fd, `$ ${[cmd, ...args].map(a => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
        const r = spawnSync(cmd, args, { stdio: ['ignore', fd, fd], env: { ...process.env, ...env }, cwd });
        if (r.error) throw new Echec(r.error.code === 'ENOENT' ? CODES.outils : code, `${cmd} : ${r.error.message}`);
        if (r.status !== 0) {
            const fin = readFileSync(journal, 'utf-8').trim().split('\n').slice(-4).join(' / ');
            throw new Echec(code, `${basename(cmd)} a échoué (code ${r.status ?? r.signal}) : ${fin}`);
        }
    } finally {
        closeSync(fd);
    }
    return journal;
};

const disponible = (cmd, args = ['--version']) => {
    const r = spawnSync(cmd, args, { stdio: 'ignore' });
    return !r.error;
};

// --- sources -----------------------------------------------------------------

const chercher = (racine, extensions) => {
    const trouves = [];
    const parcourir = (dossier) => {
        for (const entree of readdirSync(dossier, { withFileTypes: true })) {
            if (entree.name.startsWith('.') || entree.name === 'node_modules') continue;
            const chemin = join(dossier, entree.name);
            if (entree.isDirectory()) parcourir(chemin);
            else if (extensions.some(e => entree.name.toLowerCase().endsWith(e))) trouves.push(chemin);
        }
    };
    parcourir(racine);
    return trouves.sort();
};

// Entête d'un .lcc (v5) ou d'un .lcc2 : niveaux, géoréférencement, emprise (E, N, H), ciel.
const lireModele = (chemin) => {
    let texte, j;
    try {
        texte = readFileSync(chemin, 'utf-8');
        j = JSON.parse(texte);
    } catch (e) {
        throw new Echec(CODES.sources, `${basename(chemin)} illisible (${e.message})`);
    }
    const lcc2 = chemin.toLowerCase().endsWith('.lcc2');
    const comptes = j.lodSplats ?? j.splats ?? [];
    const niveaux = comptes.length || j.totalLevels || j.totalLevel || 0;
    const boite = lcc2 ? j.root?.boundingBox : j.boundingBox;
    const offsetBrut = /"offset"\s*:\s*\[([^\]]*)\]/.exec(texte)?.[1].split(',').map(v => v.trim()) ?? null;
    const ciel = lcc2 ? (j.env?.splatsCount ?? 0) > 0 : existsSync(join(dirname(chemin), 'environment.bin'));
    if (!niveaux) throw new Echec(CODES.sources, `${basename(chemin)} : nombre de niveaux introuvable`);
    if (!boite?.min || !boite?.max) throw new Echec(CODES.sources, `${basename(chemin)} : emprise (boundingBox) introuvable`);
    return { chemin, format: lcc2 ? 'lcc2' : 'lcc', niveaux, comptes, total: j.totalSplats ?? comptes.reduce((a, b) => a + b, 0), epsg: Number(j.epsg) || 0, offsetBrut, boite, ciel };
};

// --- contrôle d'orientation -------------------------------------------------

// Le lecteur .lcc de splat-transform place (E, N, H) en (x, y, z) = (E, −H, N),
// le repère attendu par le visualisateur (README : jamais de -r). On compare
// l'emprise produite (racine de l'arbre de lod-meta.json) à celle annoncée par
// le modèle, pour chaque correspondance d'axes possible : la bonne doit être la
// plus proche, et proche.
const controlerOrientation = (bound, boite) => {
    const [E0, N0, H0] = boite.min, [E1, N1, H1] = boite.max;
    const axes = { E: [E0, E1], N: [N0, N1], H: [H0, H1] };
    const produits = { x: [bound.min[0], bound.max[0]], '−y': [-bound.max[1], -bound.min[1]], z: [bound.min[2], bound.max[2]], y: [bound.min[1], bound.max[1]] };
    // écart des bornes rapporté à l'étendue de l'axe (5 m au moins : un studio de 4 m de haut a ses flotteurs)
    const ecart = ([a0, a1], [b0, b1]) => (Math.abs(a0 - b0) + Math.abs(a1 - b1)) / Math.max(5, b1 - b0);
    const attendu = { x: 'E', '−y': 'H', z: 'N' };
    const ecarts = Object.fromEntries(Object.entries(attendu).map(([p, a]) => [p, round(ecart(produits[p], axes[a]), 3)]));
    // les erreurs connues : modèle couché (y reprend N, z reprend H) ou retourné (y = +H)
    const couche = round((ecart(produits.y, axes.N) + ecart(produits.z, axes.H)) / 2, 3);
    const retourne = round(ecart(produits.y, axes.H), 3);
    const juste = round((ecarts['−y'] + ecarts.z) / 2, 3);
    const ok = Math.max(...Object.values(ecarts)) <= 0.2 && juste < couche && ecarts['−y'] < retourne;
    return {
        ok,
        ecarts,
        couche,
        retourne,
        emprise: { x: produits.x.map(v => round(v)), y: produits.y.map(v => round(v)), z: produits.z.map(v => round(v)) },
        modele: { E: axes.E.map(v => round(v)), N: axes.N.map(v => round(v)), H: axes.H.map(v => round(v)) }
    };
};

// --- vue de départ -----------------------------------------------------------

// Repère moteur : (x, y, z) = (−E, H, N). Intérieur : au milieu du plus grand
// niveau gardé, là où l'on est le plus loin d'un mur, l'œil à 1,60 m, regard
// vers la plus longue enfilade libre. Extérieur (ou sans niveau) : vue plongeante
// depuis le sud-ouest sur l'ensemble du site.
const vueDeDepart = (s, niveau, sol) => {
    if (niveau) {
        const PAS = 0.2;
        const [e0, n0, e1, n1] = niveau.bounds;
        const w = Math.ceil((e1 - e0) / PAS), h = Math.ceil((n1 - n0) / PAS);
        const solVu = new Uint8Array(w * h), obstacle = new Uint8Array(w * h);
        for (let i = 0; i < s.n; i++) {
            const x = Math.floor((s.E[i] - e0) / PAS), y = Math.floor((s.N[i] - n0) / PAS);
            if (x < 0 || x >= w || y < 0 || y >= h) continue;
            const dh = s.H[i] - niveau.floor;
            if (dh > -0.15 && dh < 0.15) solVu[y * w + x] = 1;
            else if (dh > 0.3 && dh < 1.9) obstacle[y * w + x] = 1;
        }
        // distance (en cases, 8-voisinage) au plus proche obstacle ou trou
        const dist = new Int32Array(w * h).fill(-1);
        const file = [];
        for (let k = 0; k < w * h; k++) {
            if (obstacle[k] || !solVu[k]) {
                dist[k] = 0;
                file.push(k);
            }
        }
        for (let q = 0; q < file.length; q++) {
            const k = file[q], x = k % w, y = (k - x) / w;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const xx = x + dx, yy = y + dy;
                    if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
                    const kk = yy * w + xx;
                    if (dist[kk] < 0) {
                        dist[kk] = dist[k] + 1;
                        file.push(kk);
                    }
                }
            }
        }
        let meilleur = -1, best = 0;
        for (let k = 0; k < w * h; k++) {
            if (dist[k] > best) {
                best = dist[k];
                meilleur = k;
            }
        }
        if (meilleur >= 0 && best >= 2) {
            const x = meilleur % w, y = (meilleur - x) / w;
            // plus longue enfilade libre parmi 16 directions
            let dir = [1, 0], longueur = 0;
            for (let a = 0; a < 16; a++) {
                const dx = Math.cos(a * Math.PI / 8), dy = Math.sin(a * Math.PI / 8);
                let l = 0;
                for (;;) {
                    const xx = Math.round(x + dx * (l + 1)), yy = Math.round(y + dy * (l + 1));
                    if (xx < 0 || xx >= w || yy < 0 || yy >= h || obstacle[yy * w + xx]) break;
                    l++;
                }
                if (l > longueur) {
                    longueur = l;
                    dir = [dx, dy];
                }
            }
            const E = e0 + (x + 0.5) * PAS, N = n0 + (y + 0.5) * PAS;
            const portee = Math.max(1.5, Math.min(6, longueur * PAS));
            return {
                genre: 'interieur',
                position: [-E, niveau.floor + 1.6, N].map(v => round(v, 3)),
                target: [-(E + dir[0] * portee), niveau.floor + 1.4, N + dir[1] * portee].map(v => round(v, 3)),
                fov: 85
            };
        }
    }
    const [pe0, pe1] = percentiles(s.E, [2, 98]);
    const [pn0, pn1] = percentiles(s.N, [2, 98]);
    const cE = (pe0 + pe1) / 2, cN = (pn0 + pn1) / 2, L = Math.max(pe1 - pe0, pn1 - pn0, 4);
    const base = sol ?? percentiles(s.H, [5])[0];
    return {
        genre: 'exterieur',
        position: [-(cE - 0.55 * (pe1 - pe0)), base + 0.45 * L, cN - 0.55 * (pn1 - pn0)].map(v => round(v, 3)),
        target: [-cE, base + 1, cN].map(v => round(v, 3)),
        fov: 75
    };
};

// Réglages par défaut d'une scène (ceux des scènes en ligne, Montferrat).
const reglagesParDefaut = camera => ({
    version: 2,
    tonemapping: 'none',
    highPrecisionRendering: false,
    background: { color: [0, 0, 0] },
    postEffectSettings: {
        sharpness: { enabled: false, amount: 0 },
        bloom: { enabled: false, intensity: 1, blurLevel: 2 },
        grading: { enabled: false, brightness: 0, contrast: 1, saturation: 1, tint: [1, 1, 1] },
        vignette: { enabled: false, intensity: 0.5, inner: 0.3, outer: 0.75, curvature: 1 },
        fringing: { enabled: false, intensity: 0.5 }
    },
    animTracks: [],
    cameras: [{ initial: { position: camera.position, target: camera.target, fov: camera.fov } }],
    annotations: [],
    startMode: 'default'
});

// --- publier -----------------------------------------------------------------

// Options GPU de splat-transform (-g, --gpu-backend), et l'environnement qui les
// transmet aux enfants (scene-map.mjs lit SPLAT_TRANSFORM_OPTIONS). Partagé par
// les deux formes : « carte » les ignorait (TKT-297, lot 4), donc la carte d'une
// scène se construisait sur l'adaptateur par défaut et non sur Vulkan.
const optionsSplat = (opts) => {
    const optionsGpu = [
        ...(opts.gpu !== null ? ['-g', opts.gpu] : []),
        ...(opts.gpuBackend ? ['--gpu-backend', opts.gpuBackend] : [])
    ];
    return { optionsGpu, envSplat: { SPLAT_TRANSFORM_OPTIONS: [...splatTransformOptions(), ...optionsGpu].join(' ') } };
};

const publier = (opts) => {
    const { sortie, travail } = opts;
    const staging = `${sortie}.en-cours`;
    const journaux = join(staging, 'publication', 'journaux');
    const { optionsGpu, envSplat } = optionsSplat(opts);
    const st = splatTransformCommand();
    const splat = (etape, args, code = CODES.calcul) => lancer({ journaux, etape, cmd: st.cmd, args: [...splatTransformOptions(), ...optionsGpu, ...args], code });

    const etat = { version: 1, outil: 'publier-scene.mjs', statut: 'en-cours', debut: maintenant(), sortie, sources: opts.sources, options: { titre: opts.titre, id: opts.id, sh: opts.sh, nuage: opts.nuage, carte: opts.carte, type: opts.type, iterations: opts.iterations } };
    const suivi = creerSuivi({ total: null, racine: () => staging, journaux });
    const ecrireEtat = (chemin) => {
        etat.duree_s = suivi.duree();
        etat.etapes = suivi.etapes;
        etat.avertissements = suivi.avertissements;
        mkdirSync(dirname(chemin), { recursive: true });
        writeFileSync(chemin, `${JSON.stringify(etat, null, 2)}\n`);
    };
    const nettoyerTravail = () => {
        if (!opts.garderTravail) rmSync(travail, { recursive: true, force: true });
    };
    let interrompu = false;
    process.on('SIGINT', () => {
        interrompu = true;
    });
    process.on('SIGTERM', () => {
        interrompu = true;
    });

    try {
        if (existsSync(sortie) && !opts.force) throw new Echec(CODES.arguments, `${sortie} existe déjà : --force pour la remplacer`);
        rmSync(staging, { recursive: true, force: true });
        rmSync(travail, { recursive: true, force: true });
        mkdirSync(journaux, { recursive: true });
        mkdirSync(travail, { recursive: true });

        // 1. outils
        let modele, nuage;
        suivi.etape('outils', () => {
            const node = Number(process.versions.node.split('.')[0]);
            if (node < 22) throw new Echec(CODES.outils, `Node ${process.versions.node} : 22 ou plus attendu`);
            const version = splatTransformVersion();
            if (!version) throw new Echec(CODES.outils, `splat-transform introuvable (${st.cmd}) : npm install dans le fork, ou npm install -g @playcanvas/splat-transform@${SPLAT_TRANSFORM_VERSION}`);
            if (version !== SPLAT_TRANSFORM_VERSION && !opts.versionLibre) {
                throw new Echec(CODES.outils, `splat-transform ${version} (${st.source}) : ${SPLAT_TRANSFORM_VERSION} attendu (lecteur .lcc et rendu .webp vérifiés sur cette version) ; --splat-transform-libre pour passer outre`);
            }
            if (opts.carte && !(disponible('cwebp', ['-version']) && disponible('dwebp', ['-version']))) {
                throw new Echec(CODES.outils, 'cwebp / dwebp introuvables (paquet webp) : nécessaires à la carte, ou --sans-carte');
            }
            const r = spawnSync(st.cmd, [...splatTransformOptions(), ...optionsGpu, '--list-gpus'], { encoding: 'utf-8' });
            const adaptateurs = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter(l => /^\s*\[\d+\]/.test(l)).map(l => l.trim());
            if (opts.gpu !== 'cpu' && !adaptateurs.length) suivi.avertir('outils', 'aucun adaptateur WebGPU vu par splat-transform : la compression va échouer ou passer par le processeur (30 fois plus lente)');
            if (adaptateurs.some(a => /llvmpipe|lavapipe|swiftshader/i.test(a)) && !adaptateurs.some(a => /nvidia|apple|amd|intel/i.test(a))) {
                suivi.avertir('outils', 'seul un Vulkan LOGICIEL est vu : calcul par le processeur, très lent');
            }
            return { node: process.versions.node, splatTransform: { version, source: st.source, options: envSplat.SPLAT_TRANSFORM_OPTIONS }, adaptateurs };
        });

        // 2. sources
        const details = suivi.etape('sources', () => {
            if (!existsSync(opts.sources) || !statSync(opts.sources).isDirectory()) throw new Echec(CODES.sources, `${opts.sources} n'est pas un dossier`);
            const modeles = opts.modele ? [resolve(opts.modele)] : chercher(opts.sources, ['.lcc', '.lcc2']);
            if (!modeles.length) throw new Echec(CODES.sources, `aucun modèle .lcc ou .lcc2 dans ${opts.sources}`);
            if (modeles.length > 1) throw new Echec(CODES.sources, `plusieurs modèles, préciser --modele : ${modeles.map(m => relative(opts.sources, m)).join(', ')}`);
            if (!existsSync(modeles[0])) throw new Echec(CODES.sources, `${modeles[0]} introuvable`);
            modele = lireModele(modeles[0]);
            if (opts.nuage !== 'non') {
                const nuages = opts.nuageFichier ? [resolve(opts.nuageFichier)] : chercher(opts.sources, ['.las', '.laz']);
                if (nuages.length > 1) throw new Echec(CODES.sources, `plusieurs nuages, préciser --nuage-fichier ou --sans-nuage : ${nuages.map(m => relative(opts.sources, m)).join(', ')}`);
                if (!nuages.length && opts.nuage === 'oui') throw new Echec(CODES.sources, `--nuage demandé, aucun .las ou .laz dans ${opts.sources}`);
                nuage = nuages[0] ?? null;
                if (nuage && !existsSync(nuage)) throw new Echec(CODES.sources, `${nuage} introuvable`);
                if (nuage?.toLowerCase().endsWith('.laz') && !disponible('pdal', ['--version'])) throw new Echec(CODES.outils, 'un .laz demande PDAL (brew install pdal / apt install pdal)');
                const i = opts.lasOptions?.indexOf('--epsg') ?? -1;
                const epsg = i >= 0 ? Number(opts.lasOptions[i + 1]) : null;
                const repere = opts.lasOptions?.includes('--lcc') || opts.lasOptions?.includes('--offset');
                if (nuage && modele.epsg > 0 && !repere && epsg !== null && epsg !== modele.epsg) {
                    throw new Echec(CODES.sources, `le nuage est déclaré en EPSG:${epsg}, le modèle est en EPSG:${modele.epsg} : choisir EPSG:${modele.epsg}, ou reprojeter le nuage`);
                }
            }
            const niveaux = (opts.niveaux ?? Array.from({ length: Math.min(5, modele.niveaux) }, (_, k) => k));
            const hors = niveaux.filter(k => k >= modele.niveaux);
            if (hors.length) throw new Echec(CODES.sources, `niveaux ${hors.join(', ')} absents : le modèle en a ${modele.niveaux}`);
            return { modele: relative(opts.sources, modele.chemin), format: modele.format, niveauxModele: modele.niveaux, niveaux, splats: modele.total, epsg: modele.epsg, ciel: modele.ciel, nuage: nuage ? relative(opts.sources, nuage) : null };
        });
        const niveaux = details.niveaux;
        // sources et outils, une extraction par niveau, lod + ciel + orientation, nuage, carte, réglages + projet + aperçu + bilan
        suivi.total = 2 + niveaux.length + 3 + (nuage ? 2 : 0) + (opts.carte ? 1 : 0) + 4;
        etat.modele = details;

        // 3. un PLY par niveau (-N : les .lcc récents portent des NaN), puis LOD SOG
        const ply = join(travail, 'ply');
        const cheminModele = modele.chemin;
        mkdirSync(ply, { recursive: true });
        for (const k of niveaux) {
            suivi.etape(`splats-L${k}`, () => {
                splat(`splats-L${k}`, ['-w', '-L', String(k), cheminModele, '-N', '-H', String(opts.sh), join(ply, `lod${k}.ply`)]);
                return { octets: statSync(join(ply, `lod${k}.ply`)).size };
            });
            if (interrompu) throw new Echec(CODES.inattendu, 'interrompu');
        }
        const lodMeta = join(staging, 'lod-output', 'lod-meta.json');
        suivi.etape('splats-lod', () => {
            const entrees = niveaux.flatMap((k, i) => [join(ply, `lod${k}.ply`), '-l', String(i)]);
            splat('splats-lod', ['-w', '-i', String(opts.iterations), '--lod-chunk-count', '128', ...entrees, lodMeta]);
            const meta = JSON.parse(readFileSync(lodMeta, 'utf-8'));
            if (!meta.count) throw new Echec(CODES.controle, 'lod-meta.json sans aucun splat');
            return { splats: meta.count, niveaux: meta.lodLevels };
        });

        // 4. ciel : conversion directe du niveau le plus grossier, qui l'écrit dans env/
        suivi.etape('ciel', () => {
            const dossier = join(travail, 'ciel');
            const dernier = niveaux[niveaux.length - 1];
            splat('ciel', ['-w', '-i', String(opts.iterations), '-L', String(dernier), modele.chemin, '-N', '-H', String(opts.sh), join(dossier, 'lod-meta.json')]);
            const env = join(dossier, 'env', 'meta.json');
            if (!existsSync(env)) {
                if (modele.ciel) throw new Echec(CODES.controle, 'le modèle déclare un ciel (env) mais la conversion ne l\'a pas produit : la scène s\'afficherait sur fond noir');
                return { ciel: false, raison: 'le modèle n\'a pas de ciel (intérieur)' };
            }
            cpSync(join(dossier, 'env'), join(staging, 'lod-output', 'env'), { recursive: true });
            const meta = JSON.parse(readFileSync(lodMeta, 'utf-8'));
            const ordonne = {};
            for (const [k, v] of Object.entries(meta)) {
                if (k === 'filenames') ordonne.environment = 'env/meta.json';
                if (k !== 'environment') ordonne[k] = v;
            }
            writeFileSync(lodMeta, JSON.stringify(ordonne));
            const n = JSON.parse(readFileSync(env, 'utf-8')).count;
            if (!modele.ciel) suivi.avertir('ciel', 'ciel produit alors que le modèle n\'en déclare pas : à vérifier');
            return { ciel: true, splats: n };
        });

        // 5. orientation
        suivi.etape('orientation', () => {
            const meta = JSON.parse(readFileSync(lodMeta, 'utf-8'));
            if (!meta.tree?.bound) throw new Echec(CODES.controle, 'lod-meta.json sans emprise (tree.bound)');
            const c = controlerOrientation(meta.tree.bound, modele.boite);
            etat.orientation = c;
            if (!c.ok) {
                throw new Echec(CODES.controle, `orientation fausse : emprise produite x ${c.emprise.x.join('…')}, y ${c.emprise.y.join('…')}, z ${c.emprise.z.join('…')} ; attendu x = E ${c.modele.E.join('…')}, y = −H ${c.modele.H.map(v => -v).reverse().join('…')}, z = N ${c.modele.N.join('…')} (écarts ${JSON.stringify(c.ecarts)}, couché ${c.couche}, retourné ${c.retourne})`);
            }
            return c;
        });

        // 6. nuage LiDAR
        if (nuage) {
            const dossier = join(travail, 'nuage');
            suivi.etape('nuage-conversion', () => {
                const essai = (options) => {
                    rmSync(dossier, { recursive: true, force: true });
                    lancer({ journaux, etape: 'nuage-conversion', cmd: process.execPath, args: [join(SCRIPTS, 'las-to-splats.mjs'), nuage, dossier, ...options] });
                    return options;
                };
                let options;
                if (opts.lasOptions) {
                    // Un modèle géoréférencé impose son repère : sans --lcc, le nuage garderait l'offset
                    // du LAS et tomberait à côté des splats (780 m sur le repère de Pont-Saint-Esprit).
                    // --epsg ne fait alors que nommer la projection d'un LAS qui n'en déclare pas.
                    // (une projection qui contredit le modèle est refusée dès l'étape des sources)
                    const repere = opts.lasOptions.includes('--lcc') || opts.lasOptions.includes('--offset');
                    options = essai(modele.epsg > 0 && !repere ? ['--lcc', modele.chemin, ...opts.lasOptions] : opts.lasOptions);
                } else {
                    const lcc = modele.epsg > 0 ? ['--lcc', modele.chemin] : [];
                    try {
                        options = essai([...lcc, ...(opts.heightRef ? ['--height-ref', opts.heightRef] : [])]);
                    } catch (e) {
                        const journal = readFileSync(join(journaux, 'nuage-conversion.log'), 'utf-8');
                        if (/aucune projection/.test(journal)) {
                            suivi.avertir('nuage-conversion', 'le LAS ne déclare pas de projection : Lambert-93 (EPSG:2154) supposé ; si le nuage ne tombe pas sur les splats, relancer avec --las-options "--epsg <code>"');
                            options = essai(['--epsg', '2154', ...(opts.heightRef ? ['--height-ref', opts.heightRef] : [])]);
                        } else throw e;
                    }
                }
                const plys = readdirSync(dossier).filter(f => /^lod\d+\.ply$/.test(f));
                if (!plys.length) throw new Echec(CODES.calcul, 'las-to-splats.mjs n\'a écrit aucun niveau');
                return { options, niveaux: plys.length };
            });
            suivi.etape('nuage-lod', () => {
                const plys = readdirSync(dossier).filter(f => /^lod\d+\.ply$/.test(f)).sort((a, b) => Number(a.slice(3, -4)) - Number(b.slice(3, -4)));
                const entrees = plys.flatMap(f => [join(dossier, f), '-l', f.slice(3, -4)]);
                const sortieNuage = join(staging, 'pointcloud', 'lod-meta.json');
                splat('nuage-lod', ['-w', '--lod-chunk-count', '256', ...entrees, sortieNuage]);
                rmSync(dossier, { recursive: true, force: true });
                return { points: JSON.parse(readFileSync(sortieNuage, 'utf-8')).count };
            });
        }

        // 7. projet minimal (la carte en a besoin), puis carte proposée
        const projet = {
            version: 1,
            name: opts.titre,
            defaultScene: opts.id,
            scenes: [{
                id: opts.id,
                name: opts.titre,
                content: './lod-output/lod-meta.json',
                ...(nuage ? { pointcloud: './pointcloud/lod-meta.json' } : {}),
                settings: './settings.json'
            }]
        };
        const projetPath = join(staging, 'project.json');
        writeFileSync(projetPath, `${JSON.stringify(projet, null, 2)}\n`);
        let carte = null;
        if (opts.carte) {
            suivi.etape('carte-propose', () => {
                lancer({ journaux, etape: 'carte-propose', cmd: process.execPath, args: [join(SCRIPTS, 'scene-map.mjs'), 'propose', projetPath, '--force', '--type', opts.type], code: CODES.carte, env: envSplat });
                const levels = JSON.parse(readFileSync(join(staging, 'map', 'levels.json'), 'utf-8')).levels;
                const propose = JSON.parse(readFileSync(join(staging, 'map', 'controle', 'propose.json'), 'utf-8'));
                carte = { type: propose.type, levels };
                return {
                    type: propose.type,
                    niveaux: levels.map(l => ({ id: l.id, name: l.name, floor: l.floor, keep: l.keep, ...(l.raison ? { raison: l.raison } : {}), ...(l.doute ? { doute: l.doute } : {}) })),
                    planche: 'map/controle.html'
                };
            });
            etat.carte = { statut: 'proposee', type: carte.type, a_faire: 'relire map/controle.html, corriger map/levels.json, puis publier-scene.mjs carte <dossier>' };
        }

        // 8. réglages : vue de départ et géoréférencement
        const reglagesPath = join(staging, 'settings.json');
        let camera;
        suivi.etape('reglages', () => {
            // niveau de LOD d'au plus 3 M splats, pour aller vite
            const k = niveaux.find(n => (modele.comptes[n] ?? Infinity) <= 3e6) ?? niveaux[niveaux.length - 1];
            const s = readSplatsPly(join(ply, `lod${k}.ply`));
            let type = carte?.type ?? (opts.type !== 'auto' ? opts.type : null);
            let niveauxCarte = carte?.levels ?? null;
            if (!niveauxCarte) {
                const det = detectLevels(s);
                const dec = decideLevels(det.levels, { type: opts.type, extent: det.extent });
                type = dec.type;
                niveauxCarte = det.levels.map((l, i) => ({ floor: l.h, surface: l.surface, keep: dec.levels[i].keep, bounds: null }));
                const garde = niveauxCarte.filter(l => l.keep);
                for (const l of garde) {
                    const mask = i => s.H[i] > l.floor + 0.3 && s.H[i] < l.floor + 2;
                    const [e0, e1] = percentiles(s.E, [0.5, 99.5], mask), [n0, n1] = percentiles(s.N, [0.5, 99.5], mask);
                    l.bounds = [e0 - 1, n0 - 1, e1 + 1, n1 + 1];
                }
            }
            const gardes = niveauxCarte.filter(l => l.keep && l.kind !== 'avion' && l.bounds);
            const principal = type === 'exterieur' ? null : gardes.reduce((a, b) => (a && (a.surface ?? 0) >= (b.surface ?? 0) ? a : b), null);
            const avion = niveauxCarte.find(l => l.kind === 'avion');
            camera = vueDeDepart(s, principal, avion?.floor ?? null);
            writeFileSync(reglagesPath, `${JSON.stringify(reglagesParDefaut(camera), null, 2)}\n`);
            let coordonnees = 'repère local (epsg 0)';
            if (modele.epsg > 0 && modele.format === 'lcc') {
                lancer({ journaux, etape: 'reglages', cmd: process.execPath, args: [join(SCRIPTS, 'lcc-coordinates.mjs'), modele.chemin, reglagesPath, ...(opts.heightRef ? ['--height-ref', opts.heightRef] : [])] });
                coordonnees = `EPSG:${modele.epsg}, offset ${modele.offsetBrut?.join(', ')}`;
            } else if (modele.epsg > 0) {
                // .lcc2 : même recopie, faite ici (lcc-coordinates.mjs lit le même champ)
                const reglages = JSON.parse(readFileSync(reglagesPath, 'utf-8'));
                reglages.coordinates = { epsg: modele.epsg, offset: '__OFFSET__', heightRef: opts.heightRef ?? 'ellipsoid' };
                writeFileSync(reglagesPath, `${JSON.stringify(reglages, null, 2).replace('"__OFFSET__"', `[${modele.offsetBrut.join(', ')}]`)}\n`);
                coordonnees = `EPSG:${modele.epsg}, offset ${modele.offsetBrut?.join(', ')}`;
            }
            return { vue: camera, type, coordonnees };
        });

        // 9. project.json complet (vitesse selon le type de scène)
        suivi.etape('projet', () => {
            // suivi.etapes et non etat.etapes : ce dernier n'est rempli qu'à l'écriture de etat.json (--sans-carte échouait ici)
            const type = carte?.type ?? suivi.etapes.find(e => e.etape === 'reglages')?.details?.type;
            projet.scenes[0].speed = { interieur: 2, mixte: 3, exterieur: 4 }[type] ?? 3;
            writeFileSync(projetPath, `${JSON.stringify(projet, null, 2)}\n`);
            return { speed: projet.scenes[0].speed, nuage: !!nuage };
        });

        // 10. aperçu : la vue de départ, rendue par splat-transform
        suivi.etape('apercu', () => {
            const meta = JSON.parse(readFileSync(lodMeta, 'utf-8'));
            const lod = Math.min(2, meta.lodLevels - 1);
            const image = join(staging, 'publication', 'apercu.webp');
            splat('apercu', ['-w', '-L', String(lod), lodMeta, image,
                '--camera-pos', camera.position.join(','), '--camera-target', camera.target.join(','),
                '--camera-fov', String(camera.fov), '--resolution', '1280x720'], CODES.controle);
            return { image: 'publication/apercu.webp', lod };
        });

        // 11. bilan, puis la scène prend son nom définitif
        suivi.etape('bilan', () => {
            const taille = (d) => {
                let t = 0;
                const p = (x) => {
                    for (const e of readdirSync(x, { withFileTypes: true })) {
                        const c = join(x, e.name);
                        if (e.isDirectory()) p(c); else t += statSync(c).size;
                    }
                };
                if (existsSync(d)) p(d);
                return t;
            };
            etat.tailles = { splats: taille(join(staging, 'lod-output')), nuage: taille(join(staging, 'pointcloud')), carte: taille(join(staging, 'map')) };
            return etat.tailles;
        });
        etat.statut = 'pret-a-verifier';
        etat.fin = maintenant();
        ecrireEtat(join(staging, 'etat.json'));
        if (existsSync(sortie)) rmSync(sortie, { recursive: true, force: true });
        renameSync(staging, sortie);
        nettoyerTravail();
        emettre({ type: 'termine', statut: 'ok', duree_s: suivi.duree(), sortie, etat: join(sortie, 'etat.json') });
        dire(`\nScène prête à vérifier : ${sortie}${opts.carte ? `\nCarte proposée : relire ${join(sortie, 'map', 'controle.html')}, corriger map/levels.json, puis : node scripts/publier-scene.mjs carte ${sortie}` : ''}`);
        return 0;
    } catch (e) {
        const code = e instanceof Echec ? e.code : CODES.inattendu;
        if (!e.dejaSignale) {
            emettre({ type: 'erreur', code, message: e.message });
            dire(`ÉCHEC (${code}) : ${e.message}`);
        }
        etat.statut = 'echec';
        etat.erreur = { code, message: e.message, etape: suivi.etapes.at(-1)?.statut === 'erreur' ? suivi.etapes.at(-1).etape : null };
        etat.fin = maintenant();
        if (existsSync(staging)) ecrireEtat(join(staging, 'etat.json'));
        nettoyerTravail();
        emettre({ type: 'termine', statut: 'echec', code, duree_s: suivi.duree(), ...(existsSync(staging) ? { etat: join(staging, 'etat.json') } : {}) });
        return code;
    }
};

// --- carte (second temps) -----------------------------------------------------

const construireCarte = (opts) => {
    const scene = opts.scene;
    const journaux = join(scene, 'publication', 'journaux');
    const etatPath = join(scene, 'etat.json');
    const projetPath = join(scene, 'project.json');
    const etat = existsSync(etatPath) ? JSON.parse(readFileSync(etatPath, 'utf-8')) : { version: 1 };
    const suivi = creerSuivi({ total: opts.proposer ? 2 : 1, racine: () => scene, journaux });
    const { envSplat } = optionsSplat(opts);
    try {
        if (!existsSync(projetPath)) throw new Echec(CODES.arguments, `${projetPath} introuvable`);
        if (opts.proposer) {
            suivi.etape('carte-propose', () => {
                lancer({ journaux, etape: 'carte-propose', cmd: process.execPath, args: [join(SCRIPTS, 'scene-map.mjs'), 'propose', projetPath, '--force', '--type', opts.type], code: CODES.carte, env: envSplat });
                const levels = JSON.parse(readFileSync(join(scene, 'map', 'levels.json'), 'utf-8')).levels;
                return { niveaux: levels.map(l => ({ id: l.id, name: l.name, floor: l.floor, keep: l.keep, ...(l.raison ? { raison: l.raison } : {}) })) };
            });
        }
        const details = suivi.etape('carte-build', () => {
            if (!existsSync(join(scene, 'map', 'levels.json'))) throw new Echec(CODES.carte, 'pas de map/levels.json : proposer d\'abord (carte --proposer)');
            lancer({ journaux, etape: 'carte-build', cmd: process.execPath, args: [join(SCRIPTS, 'scene-map.mjs'), 'build', projetPath], code: CODES.carte, env: envSplat });
            const build = JSON.parse(readFileSync(join(scene, 'map', 'controle', 'build.json'), 'utf-8'));
            const projet = JSON.parse(readFileSync(projetPath, 'utf-8'));
            const bloc = projet.scenes?.[0]?.map;
            if (!bloc || JSON.stringify(bloc) !== JSON.stringify(build.map)) throw new Echec(CODES.carte, 'le bloc « map » n\'a pas pu être écrit dans project.json');
            const douteux = build.levels.filter(l => l.check?.ok === false).map(l => l.id);
            if (douteux.length) suivi.avertir('carte-build', `recalage douteux sur ${douteux.join(', ')} : relire map/controle.html`);
            return { niveaux: build.map.levels.map(l => ({ id: l.id, name: l.name, floor: l.floor })), recalageDouteux: douteux };
        });
        etat.carte = { statut: 'construite', le: maintenant(), ...details };
        etat.etapes = [...(etat.etapes ?? []), ...suivi.etapes];
        etat.avertissements = [...(etat.avertissements ?? []), ...suivi.avertissements];
        writeFileSync(etatPath, `${JSON.stringify(etat, null, 2)}\n`);
        emettre({ type: 'termine', statut: 'ok', duree_s: suivi.duree(), sortie: scene, etat: etatPath });
        return 0;
    } catch (e) {
        const code = e instanceof Echec ? e.code : CODES.inattendu;
        if (!e.dejaSignale) emettre({ type: 'erreur', code, message: e.message });
        if (existsSync(scene)) {
            etat.carte = { statut: 'echec', le: maintenant(), code, message: e.message };
            etat.etapes = [...(etat.etapes ?? []), ...suivi.etapes];
            writeFileSync(etatPath, `${JSON.stringify(etat, null, 2)}\n`);
        }
        emettre({ type: 'termine', statut: 'echec', code, duree_s: suivi.duree() });
        return code;
    }
};

// --- point d'entrée -------------------------------------------------------------

let code;
try {
    const { opts } = lireArguments(process.argv.slice(2));
    if (opts.aide) {
        dire(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('\n').slice(1, 60).filter(l => l.startsWith('//')).map(l => l.slice(3)).join('\n'));
        code = 0;
    } else {
        code = opts.commande === 'carte' ? construireCarte(opts) : publier(opts);
    }
} catch (e) {
    code = e instanceof Echec ? e.code : CODES.inattendu;
    emettre({ type: 'erreur', code, message: e.message });
    emettre({ type: 'termine', statut: 'echec', code, duree_s: 0 });
    dire(`publier-scene : ${e.message}`);
}
process.exitCode = code;
