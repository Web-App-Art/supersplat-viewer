# TKT-297, lot « viewer » : publier une scène d'un bloc, et un `propose` mesuré

Branche `tkt-297-publier-scene` (depuis `dev`, `e70eb3b`). Rien n'est poussé ni fusionné.

## 1. `scripts/publier-scene.mjs`

Ce qu'on enchaînait à la main (README, « Générer une scène depuis un .lcc ») en une commande, avec un avancement lisible par le CRM :

```
node scripts/publier-scene.mjs <dossier des sources> --sortie <dossier de la scène> [--titre "…"] [--sh 1|3]
                               [--sans-nuage | --nuage] [--sans-carte] [--type auto|interieur|exterieur|mixte] …
node scripts/publier-scene.mjs carte <dossier de la scène> [--proposer [--type …]]
```

Étapes : `outils` (Node ≥ 22, splat-transform 3.10.0 exigé, webp, PDAL si .laz, adaptateurs GPU), `sources` (un seul .lcc/.lcc2, au plus un .las/.laz, sinon arrêt avec la liste), `splats-L<k>` (un PLY par niveau, `-N -H <sh>`), `splats-lod` (SOG, `-i 16 --lod-chunk-count 128`), `ciel` (repris dans `env/` ; **échec** si le modèle déclare un ciel et qu'il n'est pas produit, au lieu du fond noir silencieux), `orientation` (emprise de `lod-meta.json` comparée à celle du modèle : x = E, y = −H, z = N à 20 % près, un modèle couché ou retourné arrête tout), `nuage-conversion` et `nuage-lod` (la commande que `las-to-splats.mjs` affichait est lancée ; `--lcc` repris si le modèle est géoréférencé ; LAS sans projection : Lambert-93 supposé **avec un avertissement**, comme le banc), `carte-propose` (scene-map.mjs, sans `build`), `reglages` (settings.json par défaut, vue de départ calculée, géoréférencement recopié), `projet` (project.json, `speed` 2 intérieur, 3 mixte, 4 extérieur), `apercu` (image de la vue de départ), `bilan`.

Sortie : la scène est montée dans `<sortie>.en-cours/` puis **renommée** ; en cas d'échec, `<sortie>` n'existe pas et `<sortie>.en-cours/etat.json` dit l'étape et le message. Intermédiaires dans `<sortie>.travail/`, supprimés (sauf `--garder-travail`).

Lignes d'avancement (sortie standard, une ligne JSON par événement ; les messages humains vont sur la sortie d'erreur) :

```
{"type":"etape","etape":"splats-lod","evenement":"debut","numero":5,"total":14,"horodatage":"…"}
{"type":"etape","etape":"splats-lod","evenement":"fin","numero":5,"duree_s":15.1,"details":{"splats":1491888,"niveaux":2}}
{"type":"etape","etape":"orientation","evenement":"erreur","numero":7,"duree_s":0,"code":6,"message":"orientation fausse : …"}
{"type":"avertissement","etape":"nuage-conversion","message":"le LAS ne déclare pas de projection : …"}
{"type":"termine","statut":"ok","duree_s":33.7,"sortie":"…","etat":"…/etat.json"}
```

`total` est `null` pour les deux premières étapes (le nombre de niveaux n'est connu qu'après `sources`).

Codes de sortie : 0 prête, 2 arguments (dont nom de dossier hors `[A-Za-z0-9_.-]`, dossier déjà là sans `--force`), 3 outils, 4 sources, 5 calcul, 6 contrôle (orientation, ciel perdu, scène vide), 7 carte, 1 inattendu ou interruption.

`etat.json` (dans la scène) : statut (`pret-a-verifier`, `echec`), options, modèle lu, chaque étape (durée, détails ou erreur), contrôle d'orientation, carte (`proposee` puis `construite` avec les recalages douteux), tailles, avertissements.

### splat-transform épinglé

`@playcanvas/splat-transform` **3.10.0** en **devDependency** exacte : c'est un outil de préparation, pas une dépendance du paquet publié (`files` ne contient ni `scripts/` ni rien qui l'importe) ni de l'image servie (l'étage `runner` du Dockerfile ne copie que `public/`). Coût : `npm ci` de l'étage `builder` télécharge ≈ 180 Mo de plus (`webgpu` 131 Mo, dont les binaires Dawn de cinq plateformes). Le lockfile a aussi relevé `@webgpu/types` de 0.1.71 à 0.1.74 (dépendance partagée) : `tsc --noEmit` et `npm run build` passent, le lint de `src` a les mêmes 63 erreurs qu'avant.

Résolution (`scripts/splat-transform-cli.mjs`) : `SPLAT_TRANSFORM` s'il est posé, sinon `node_modules/.bin/splat-transform` du fork, sinon le PATH. Le kit `calcul-scenes` clone le fork **sans** `npm install` : il garde donc son installation globale et l'enveloppe de `banc.sh` (options GPU) ; `SPLAT_TRANSFORM_OPTIONS`, `--gpu` et `--gpu-backend` passent les mêmes options aux appels directs et à scene-map.mjs.

### `scene-map build` et le format « 1.380 »

`build` ne compare plus le fichier à `JSON.stringify(…, 2)` : il repère dans le **texte** la valeur de `scenes[i].map` (ou la fin de l'objet de la scène) et la remplace seule, puis relit le résultat (`scripts/project-json.mjs`). Essayé sur tous les project.json du dépôt local : identique là où le bloc l'était, Belgentier (« 1.380 ») réécrit sans toucher au reste, Saint-Germain (blocs tenus sur une ligne) aussi.

### Essai réel (Mac M1 Max, 30/10/2026)

Studio de Belgentier (copie de `Belgentier_studio/lcc-result`, 1,49 M splats, 2 niveaux, ciel) + un nuage de 1,48 M points (copie de `parking-sous.las`, sans projection : avertissement émis, Lambert-93 supposé). **34 s**, 14 étapes, code 0 ; vue de départ intérieure correcte (image `publication/apercu.webp`), carte proposée juste (n1 gardé, plafond écarté, pas de vue d'avion), puis `carte` après renommage du niveau : bloc `map` écrit. Servi par le visualisateur construit depuis la branche (`npm run build`, `serve`) dans un Chrome sans écran : project.json, settings.json, `lod-meta.json`, **le ciel `env/`**, les blocs, la photo et les murs de la carte demandés, aucune erreur ni 404 (hors favicon) ; le **rendu** lui-même n'a pas pu être vu (pas d'affichage en mode sans écran).

Autres essais : `--sh 3` (77 s, 43 Mo au lieu de 26), échec d'orientation provoqué (enveloppe `SPLAT_TRANSFORM` qui ajoute `-r 90,0,0` : arrêt en code 6 à l'étape `orientation`, scène finale absente), dossier vide (code 4), dossier existant et nom accentué (code 2). Vue de départ extérieure contrôlée sur Callian (vue plongeante sur le site). Le contrôle d'orientation donne « juste » sur six scènes en ligne (Montferrat en .lcc2, Callian, Toulon, Belgentier ×2, Saint-Germain) et « faux » sur chacune couchée artificiellement.

## 2. `propose` : règles et mesure

Chaque niveau détecté reçoit trois mesures, lues dans la grille d'occupation de la détection : **surface** (cases de sol visibles à ± 25 cm), **murs** (colonnes pleines entre sol + 0,3 et sol + 1,8 m, à moins de 50 cm de l'emprise, rapportées au périmètre d'un carré de même surface), **couvert** (part de l'emprise qui a quelque chose au-dessus de sol + 2 m). Puis, dans l'ordre :

1. **Petite surface** : moins de 15 m² mesurés (`--surface-min`), sauf **pièce fermée** (couvert ≥ 0,8 et murs ≥ 2). La surface mesurée est plus petite que la pièce (seul le sol visible compte) : le studio de Belgentier mesure 7 m², le rez-de-jardin de Saint-Germain 12,5 m², et ce sont de vrais niveaux. La cave de Montferrat (14,9 m², couvert 0,21) est écartée.
2. **Toit, faîtage ou plafond probable** : murs < 1,5. Mesuré : 0 à 1,18 sur les toits, faîtages et plafonds écartés à la main ; 2,41 au moins sur les vrais sols. 1,5 laisse de la marge des deux côtés.
3. **Scène extérieure** (vue d'avion seule) : aucun niveau ne reste, ou aucun n'est couvert à 80 % et le ciel ouvert (couvert < 0,5) fait plus de la moitié de la surface des sols notables, toits compris.
4. Sinon les niveaux restants sont gardés, à ciel ouvert compris, avec un champ `doute` (terrasse, ou dernier étage sous rampants peu relevé). Vue d'avion en plus (**scène mixte**) si le ciel ouvert pèse 25 % et que le site dépasse 30 m dans les deux sens.

`--type interieur|exterieur|mixte` impose le résultat de l'étape 3 (le CRM peut le demander à l'opérateur). Le sol de la vue d'avion est le plus étendu des niveaux qui ne sont pas des toits. Les noms partent du rez-de-chaussée (« 1er étage »…). Format de `levels.json` inchangé, avec en plus `surface`, `murs`, `couvert`, `raison` (écarté) et `doute` (gardé, à vérifier) ; `build` les ignore.

### Mesure (mêmes sources, LOD 1, `scripts/mesure-propose.mjs`)

Vérité : les `levels.json` corrigés à la main dans `public/projects` du fork (15 cartes). Échantillon : les **14** cartes faites jusqu'au relevé du 18/10 (le relevé en compte 13 ; ici l'ancien Saint-Germain compte deux cartes, intérieur et extérieur). **Prads** (22/10) sert de contrôle **hors échantillon** : il n'a servi à régler aucun seuil. Un niveau est « juste » si son sol est à 40 cm d'un niveau gardé de la vérité. Une carte **passe** quand niveaux gardés et vue d'avion sont ceux de la vérité (noms, coupes et sol de la vue d'avion à part). « Avant » : `scene-map.mjs` de `dev` relancé sur les mêmes sources (il retrouve bien « une seule carte passe », parking du Muy).

| Scène | Avant | Après (auto) | Après (`--type` donné) |
|---|---|---|---|
| Montferrat | 2 justes, 2 faux, avion faux | 2 justes, 1 faux (terrasse +3,36, gardée avec `doute`) | idem |
| Appartement Yannick | 1 juste, 1 faux | **passe** | **passe** |
| Belgentier extérieur | 5 faux, avion faux | **passe** | **passe** |
| Belgentier intérieur | 2 justes, 1 faux | **passe** | **passe** |
| Belgentier studio | 1 juste, 1 faux | **passe** | **passe** |
| Callian | 4 faux, avion faux | **passe** | **passe** |
| Fayence | 4 faux, avion faux | **passe** | **passe** |
| Immeuble Toulon | 6 justes, 1 faux | **passe** | **passe** |
| Parking du Muy | **passe** | **passe** | **passe** |
| Saint-Germain extérieur | 2 faux, avion faux | 1 faux, avion faux | **passe** |
| Saint-Germain inférieur | 2 justes, 1 faux | **passe** | **passe** |
| Saint-Germain supérieur | 2 justes, 1 faux | **passe** | **passe** |
| Ancien Saint-Germain extérieur | 3 faux, avion faux | 2 faux, avion faux | **passe** |
| Ancien Saint-Germain intérieur | 3/4 justes, 1 manqué | 3/4 justes, 1 manqué | 3/4 justes, 1 manqué |
| *Prads (hors échantillon)* | 2 justes, 5 faux, avion faux | 2 vrais écartés (jugé extérieur) | **passe** |

Cartes qui passent telles quelles : **1 / 14 avant, 10 / 14 après, 12 / 14 avec le type de scène donné**. Niveaux : avant 21 justes, 31 faux gardés, 1 manqué, vue d'avion fausse 7 fois ; après (auto) 19 justes, 4 faux, 3 manqués, vue d'avion fausse 2 fois ; avec le type 21 justes, 1 faux, 1 manqué, 0.

Ce qui ne passe pas, et pourquoi :

- **Saint-Germain extérieur (×2)** : le sol du rez-de-chaussée est couvert à 54 % (arbres, avancées, et le modèle « extérieur » entre en partie dans la maison) ; l'ancien modèle « intérieur » du même bâtiment mesure exactement pareil (55 %) et doit, lui, garder ce niveau. Aucune mesure géométrique ne sépare les deux : c'est le type de scène, que l'opérateur connaît, qui tranche.
- **Montferrat** : la terrasse à +3,36 m ressemble trait pour trait au dernier étage sous rampants de Belgentier (murs 4,7 et 3,7, couvert 0,23 et 0,30). Gardée avec un `doute` plutôt que de perdre l'étage de Belgentier.
- **Ancien Saint-Germain intérieur** : le rez-de-jardin (−3,5 m, ajouté à la main) n'est pas **détecté** (sous le seuil de pic, 2 % du plus grand sol, écrasé par les 1 361 m² du rez-de-chaussée) : hors du champ de ce lot.
- **Prads** : grand bâtiment au milieu d'un vaste terrain, ses étages sont « à ciel ouvert » à 75 % (le terrain autour est au même niveau) ; juste avec `--type mixte`.

Sensibilité (14 cartes, un seuil à la fois) : murs 1 à 2,3 → 10 ; surface 5 à 30 m² → 10 ; preuve d'intérieur 0,65 à 0,9 → 10 ; part extérieure 0,3 à 0,5 → 10 (9 à 0,6) ; vue d'avion 0,1 à 0,4 et 20 à 40 m → 10. Le seuil sensible est le **couvert** : 0,4 → 9, 0,5 → 10, 0,6 → 12. 0,6 n'est pas retenu : il tombe entre 0,55 et 0,65, trois mesures de la même villa, c'est-à-dire qu'il apprend Saint-Germain au lieu d'une règle.

Le sol de la vue d'avion reste à corriger à la main sur Montferrat (vérité +3,36, proposé −0,04), Belgentier extérieur et Prads.

## 3. Non vérifié, points ouverts

- **Rien n'a tourné sous Linux ni sur la L4** : ni `publier-scene.mjs`, ni le nouveau `propose`. Le kit `calcul-scenes` épingle le fork au commit `e70eb3b` : il faudra le passer au commit de cette branche une fois fusionnée, et ajouter `publier-scene.mjs` à la liste des scripts qu'`installer.sh` vérifie.
- Le **rendu** de la scène publiée dans un vrai navigateur (seuls les chargements ont été vus) ; la vue de départ est contrôlée par l'image de splat-transform, rendue dans le même repère que le visualisateur (vérifié en rendant la vue de départ de Montferrat).
- Une seule petite scène réelle publiée de bout en bout ; aucune grande (Saint-Germain : 89 M splats, nuage de 170 M points), aucune en .lcc2 ni géoréférencée par `publier-scene.mjs` (le contrôle d'orientation, lui, a été vérifié sur un .lcc2 et des .lcc géoréférencés).
- `interior` (bascule intérieur / extérieur, TKT-272) n'est **pas** produit : il demande un second modèle et `interior-volume.mjs`, gestes humains.
- La collision (`.voxel.json`) n'est pas produite (le README ne la décrit pas non plus pour une scène neuve).
- `etat.json` et `publication/` sont dans le dossier de la scène, donc servis s'il est copié tel quel ; à écarter à l'envoi au bucket si on ne veut pas les exposer.
- Lot `--niveaux` : par défaut les 5 premiers niveaux du modèle, comme la « conversion complète » du README (Montferrat en ligne en a 7).
