# pi-prometheus 0.2.0

## Contexte

`pi-prometheus` est publié sur npm depuis le 2026-07-17, en 0.1.0, version unique. 45 installs par mois, 174 depuis la publication, dont un pic de 117 la première semaine. L'usage organique est plat.

Le paquet n'apparaît pas dans le catalogue de pi.dev. Vérifié : le catalogue liste 5 645 paquets sur les 8 394 qui portent le mot clé `pi-package` sur npm, et le dernier listé est à 73 installs par mois. La fiche existe pourtant à `https://pi.dev/packages/pi-prometheus`, mais elle affiche `Downloads: not available` alors que npm rend de vrais chiffres. Le chiffre de pi.dev tourne plus haut que celui de npm pour les petits paquets, donc l'écart réel est de l'ordre de 10 à 30 installs par mois. C'est un seuil de visibilité, pas une panne.

Le vrai problème est ailleurs. Il existe 35 extensions d'observabilité pour Pi. `pi-prometheus` est dernière. Les concurrents poussent en OTLP vers Datadog, Grafana, Braintrust, Raindrop. Un seul fait ce que nous faisons, `claude-code-opentelemetry`, et il porte le mot clé `prometheus` en visant notre place. Notre seule singularité vérifiée est d'être le seul point de collecte en mode pull avec découverte de cibles par fichier. Personne ne la lit nulle part, parce que la description du paquet vend un mécanisme, `file-based service discovery`, que personne ne cherche.

Et il reste un trou, lui vérifié comme vide. Aucune extension Pi n'attribue les tokens à leur source : quelle extension, quel skill, quel serveur MCP mange la fenêtre de contexte. Claude Code livre exactement ça en attributs de première classe (`skill.name`, `plugin.name`, `mcp_server.name`). Les utilisateurs de Pi le mesurent à la main en public : sur Hacker News, `20k tokens pour un hello world en C contre 5.3k sur une config minimale`, et `le MCP M365 occupe plusieurs milliers de tokens`.

Le but de la 0.2.0 est de remplir ce trou, avec une couche qui marche sans Prometheus, et de corriger un bug qui fait mentir le produit sur sa promesse centrale.

## Décisions déjà prises

| Sujet | Décision |
|---|---|
| Public | Les deux, en couches. Le socle sert quelqu'un qui n'installera jamais Prometheus, Prometheus se branche par dessus |
| Nom | On garde `pi-prometheus`. Renommage éventuel plus tard |
| Numéro | 0.2.0, parce qu'il y a des fonctions en plus, pas seulement des corrections |
| Nombre de sorties | Une seule. Pas de 0.1.1 intermédiaire |
| Visuel | Aucune capture à la main. Le PNG se fabrique par commande |
| Portée | Le plan couvre aussi la diffusion, pas seulement le code |

## Verdict de faisabilité

Vérifié dans les sources de Pi installées, et recoupé contre la documentation de la 0.84.3.

L'attribution par source est constructible. Le point d'accroche est `before_agent_start`, pas `before_provider_request` :

- `BeforeAgentStartEvent` (`dist/core/extensions/types.d.ts:513-524`) livre `systemPrompt` assemblé **et** `systemPromptOptions`
- `BuildSystemPromptOptions` (`dist/core/system-prompt.d.ts:5-25`) contient `contextFiles` avec leur contenu complet, `skills`, `selectedTools`, `toolSnippets`
- `pi.getAllTools()` rend chaque outil avec son schéma et son `sourceInfo` (`types.d.ts:1103-1105`)
- `SourceInfo.source` (`dist/core/source-info.d.ts:4-10`) vaut `builtin`, `npm:<paquet>`, `git:<dépôt>`, `local`. C'est l'identifiant qui rend l'attribution possible

Trois limites à écrire noir sur blanc dans le README, pas à cacher :

1. **Pas de tokenizer.** Pi estime lui même en `chars/4` (`dist/core/compaction/compaction.js:165`, exporté depuis la racine du paquet). On utilise la même fonction, donc nos chiffres et la jauge de contexte de Pi sont d'accord par construction. Attendu sur les schémas JSON denses : surestimation.
2. **Le coût en dollars par source n'est pas attribuable.** Les tokens facturés couvrent toute la requête, historique compris. On annonce des tokens et une empreinte, jamais un prix par source.
3. **Les skills sont en divulgation progressive.** `formatSkillsForPrompt` (`dist/core/skills.js:257-278`) n'injecte que nom, description et emplacement. Le corps du SKILL.md est lu à la demande. Donc coût statique petit par skill mais réel à 100 skills, et coût dynamique séparé quand le fichier est lu.

Bonus non prévu : Pi n'embarque pas MCP (`docs/usage.md:308`). Un serveur MCP arrive donc comme une extension ordinaire et tous ses outils portent le même `source`. La question `combien me coûte ce MCP` se répond par un `sum by (source)`, sans plomberie MCP.

## Préalable bloquant

Le Pi installé est en **0.80.10**, la dernière est **0.84.3**. La surface d'API dont dépend le plan a été vérifiée contre les docs de la 0.84.3 et tient à l'identique. Deux apports utiles arrivent avec la mise à jour : `tool_result` gagne un champ `usage` (usage des sous agents) et l'événement `session_compact_failed` apparaît.

Mettre à jour Pi en 0.84.3 et refaire tourner la suite actuelle avant d'écrire une ligne. Tout le reste en dépend.

**La machine change.** Les faits d'environnement de ce plan, Docker qui tourne et Pi installé en 0.80.10, ont été vérifiés sur le MacBook Pro rendu le 2026-08-27. Ils ne valent pas pour la machine suivante. Sur l'Air : revérifier que le démon Docker tourne, installer Pi en 0.84.3, refaire tourner `npm test`. Ce qui survit sans effort est le dépôt `pi-prometheus`, propre et poussé sur GitHub, et le coffre Obsidian qui est sur l'iCloud personnel.

**Premier geste après approbation** : ce fichier de plan vit dans `~/.claude/plans/` sur la machine rendue, donc il disparaît avec elle. Le copier dans le dépôt `pi-prometheus` ou dans le coffre avant toute autre action.

## Ce qu'on livre

### 1. Le coeur, l'attribution par source

Nouvelles familles de métriques, aux conventions Prometheus, sans renommer ni retirer aucune famille existante pour ne pas casser les tableaux de bord en 0.1.0 :

```
pi_context_footprint_tokens{kind,name,source}   gauge
pi_context_static_tokens                        gauge
pi_source_tokens_total{kind,name,source}        counter
pi_tool_nested_tokens_total{tool,type}          counter
pi_tool_nested_cost_usd_total{tool}             counter
pi_compaction_failures_total{reason}            counter
pi_prometheus_build_info{version,pi_version}    gauge
```

`kind` est un ensemble fermé de quatre : `tool`, `skill`, `context_file`, `prompt_section`. `source` est borné par les paquets installés. `name` est le seul non borné, donc plafonné.

Garde fous de cardinalité, parce que 100 skills fois N sessions explose vite :

- `PI_PROMETHEUS_ATTRIBUTION` vaut `off`, `rollup` (par `source` seulement) ou `full` (défaut)
- `PI_PROMETHEUS_ATTRIBUTION_TOP_N`, défaut 100, la queue se replie par genre et par source dans `name="_other"`, jamais dans un seau global : mesuré en vrai, un seau global cachait 84 pour cent du total et rendait `sum by (source)` muet
- `pi_context_static_tokens` reste le total vrai, insensible au plafond

Deux pièges à ne pas ignorer :

- Un outil apparaît deux fois, en une ligne dans `toolSnippets` du prompt système et en schéma complet dans les définitions envoyées. Mesurer les sections de prompt sur la vraie chaîne `event.systemPrompt`, mesurer les schémas sur `getAllTools()`, et ne jamais additionner les deux sans dire lequel est lequel.
- `pi.getAllTools()` rend les outils **configurés**, pas les outils **actifs**. Intersecter avec `selectedTools` avant d'attribuer, sinon on facture des outils jamais envoyés.

### 2. La couche sans Prometheus

Deux commandes via `pi.registerCommand`. Le rendu passe par `pi.appendEntry` plus `pi.registerEntryRenderer`, pas par `ctx.ui.setFooter` qui remplacerait le pied de page de tout le monde. Une entrée personnalisée ne consomme aucun token de contexte (`types.d.ts:893`). Exemple canonique livré par Pi : `examples/extensions/entry-renderer.ts`.

- **`/context-budget`** : le tableau de l'empreinte par source, avec le total et son pourcentage de la fenêtre. C'est cette sortie qui devient l'image de la galerie.
- **`/metrics`** : les chiffres de la session en cours, plus l'URL du point de collecte.

Pied de page existant étendu, piloté par `PI_PROMETHEUS_STATUS` : `off`, `port` (défaut), `full`. Rafraîchi sur `message_end` et `session_compact`, jamais sur `message_update` qui part à chaque token.

Repli à prévoir : `before_agent_start` ne part qu'à la soumission d'un prompt. Une session sans prompt n'a pas d'empreinte. La commande `/context-budget` doit donc pouvoir la calculer à la demande via `ctx.getSystemPromptOptions()` (`types.d.ts:248`, contexte de commande).

### 3. Les corrections

| # | Défaut | Emplacement | Correction |
|---|---|---|---|
| 1 | Les compteurs gardent les totaux de la session précédente | `extensions/prometheus.ts:43` | Voir ci dessous |
| 2 | `pi_session_start_time_seconds` = heure de chargement du module | `prometheus.ts:58` | Fixée dans `session_start` |
| 3 | Les orphelins `.tmp` ne sont jamais ramassés | `prometheus.ts:164` | Même règle de vivacité, plus une garde d'âge de 60s |
| 4 | `EPERM` lu comme processus mort, une cible vivante peut être effacée | `prometheus.ts:166-173` | Table de décision explicite |
| 5 | Le tableau de bord fige `job="pi"` et les fenêtres `[5m]` | `examples/grafana-dashboard.json:36` | Variable `job`, `$__rate_interval` |
| 6 | Emballage npm implicite, test non portable | `package.json` | `files`, `engines`, script de test portable |

**Le défaut 1 en détail, parce que c'est celui qui fait mentir le produit.** Cause vérifiée :

- Le cache de modules est indexé par `{cwd, generation}` (`dist/core/extensions/loader.js:111-125`)
- `clearExtensionCache()` n'est appelé que depuis `reload()` (`dist/core/resource-loader.js:219`)
- Un succès de cache rend la fabrique déjà importée sans réévaluer le module (`loader.js:307-312`), donc le `const state` de la ligne 43 survit

Conséquence : sur `/new`, `resume` et `fork` dans le même dossier, les compteurs continuent. Le README ligne 87 affirme le contraire. La correction demande deux gestes, les deux nécessaires : déplacer `state` dans la fabrique, **et** le réinitialiser dans le gestionnaire `session_start`. Le premier seul n'est pas observable depuis un test.

Table de décision pour le défaut 4 :

| Résultat de `process.kill(pid, 0)` | Sens | Action |
|---|---|---|
| pas d'erreur | vivant | garder |
| `ESRCH` | mort | supprimer |
| `EPERM` | vivant, autre utilisateur | **garder** |
| autre | inconnu | garder |

### 4. Structure du code

Le fichier reste **un seul fichier**, `extensions/prometheus.ts`. Pas de découpage en sept modules.

Raison : les fonctions pures (rendu du format texte, attribution, construction du rapport) sont testables en les exportant, sans rien déplacer. Le découpage n'apporterait rien de plus et ouvrirait un piège réel, celui de la découverte d'extensions (`loader.js:472-476`) : `pi.extensions` pointe sur un dossier, chaque fichier direct y est chargé comme une extension autonome, et un module auxiliaire sans fabrique par défaut fait échouer le chargement. Si le fichier dépasse nettement 600 lignes une fois écrit, alors seulement passer à la forme `extensions/prometheus/index.ts` et corriger le manifeste en conséquence.

### 5. Emballage et présentation

`package.json` :

- `description` réécrite pour vendre le résultat, pas le mécanisme. Les dix premiers mots servent d'accroche dans la galerie et dans les résultats npm
- `keywords` : ajouter `pi-extension`, `pi-coding-agent`, `coding-agent`, qui sont les trois mots clés de découverte les plus fréquents après `pi-package`, plus `tokens`, `cost-tracking`, `context-window`
- `files: ["extensions", "examples", "README.md", "LICENSE", "CHANGELOG.md"]`, ce qui supprime l'avertissement npm et sort `test/` de l'archive
- `engines.node: ">=22.19.0"`, la version qui fait tourner `node test/check.ts` sans drapeau
- `peerDependencies` élargi à `>=0.80.0`
- `pi.image` pointant vers une URL absolue figée sur le tag `v0.2.0`, pas sur `main`

Vérifié : `pi.image` accepte PNG, JPEG, GIF, WebP, et doit être une URL absolue (`docs/packages.md:137-152`). Les rivaux pointent tous vers un fichier commité via `raw.githubusercontent.com`. `pi-otel`, le plus proche à 1 650 installs par mois, a une image et une vidéo.

**Fabrication du visuel, sans capture manuelle.** Docker tourne sur la machine, vérifié. Un script `npm run poster` produit `examples/media/context-budget.png` : il exécute le constructeur de rapport sur des données réelles de session, écrit un SVG en police à chasse fixe, puis le rasterise dans un conteneur jetable. Zéro clic, reproductible, et l'image se régénère à chaque sortie. Le tableau de bord Grafana se photographie par le même chemin si la pile `docker-compose` est déjà debout, sinon il reste optionnel.

**Ordre de publication, à ne pas inverser.** Les assets sont commités, puis le tag `v0.2.0` est poussé, puis `npm publish`. Un manifeste qui pointe vers un tag non poussé donne une vignette cassée dans la galerie.

README réordonné pour mener par le résultat : accroche et image, installation, ce que ça donne sans Prometheus, puis Prometheus par dessus, puis la référence des métriques, puis une section honnête sur ce qui est estimé et ce qui est exact. La fausse affirmation de la ligne 87 disparaît.

`CHANGELOG.md` créé au format Keep a Changelog, avec la 0.1.0 rétro remplie et un encadré de changement de comportement pour la remise à zéro des compteurs, parce que quelqu'un verra une discontinuité dans ses courbes et doit en trouver la raison en une recherche.

### 6. Exemples livrés

```
examples/
  grafana-dashboard.json               existant, corrigé
  grafana-dashboard-attribution.json   nouveau
  alerts.yml                           nouveau
  docker-compose.yml                   nouveau
  media/context-budget.png             nouveau, généré
  prometheus-scrape.yml                inchangé
  victoriametrics-scrape.yml           inchangé
```

`alerts.yml` remplit une case vérifiée vide dans l'écosystème, personne ne livre de règles d'alerte pour Pi : empreinte statique au dessus de 15 pour cent de la fenêtre, session proche de la compaction, taux d'erreur d'outil, dépense horaire.

`docker-compose.yml` compte face à la concurrence : `@mammothb/pi-otel`, à 649 installs par mois, en livre un, et c'est une bonne part de son avance. `docker compose up` puis `pi`, et le tableau de bord se remplit.

## Fichiers touchés

| Fichier | Nature du changement |
|---|---|
| `extensions/prometheus.ts` | Les 4 corrections de code, les 7 nouvelles familles de métriques, l'attribution, les 2 commandes, le rendu d'entrée, le pied de page |
| `test/check.ts` | Le test qui échoue sur le bug d'état, plus les scénarios listés ci dessous |
| `package.json` | Description, mots clés, `files`, `engines`, `pi.image`, script de test portable |
| `README.md` | Réordonné, fausse affirmation ligne 87 supprimée, section honnêteté des estimations |
| `examples/grafana-dashboard.json` | Variable `job`, `$__rate_interval` |
| `examples/grafana-dashboard-attribution.json` | Nouveau |
| `examples/alerts.yml` | Nouveau |
| `examples/docker-compose.yml` | Nouveau |
| `CHANGELOG.md` | Nouveau |
| `.github/workflows/ci.yml` | Nouveau |
| `.github/workflows/release.yml` | Nouveau, publication sur tag avec provenance |

## Vérification

### Le test qui prouve la correction

Écrire ce test **avant** la correction et le voir échouer. C'est la seule preuve qui compte.

```ts
await fire("session_start", { type: "session_start", reason: "startup" });
await simulateFullTurn();
assert.match(await metrics(), /pi_tokens_total\{type="input"\} 100/);

const t0 = startTimeFrom(await metrics());
await fire("session_start", { type: "session_start", reason: "new" });
const after = await metrics();
assert.match(after, /pi_tokens_total\{type="input"\} 0/);   // échoue aujourd'hui
assert.ok(startTimeFrom(after) >= t0);                       // échoue aujourd'hui
```

Puis la preuve que le test est réel :

```bash
git stash          # annuler la seule correction d'état
npm test           # DOIT échouer
git stash pop && npm test   # DOIT passer
```

Une seconde moitié reproduit le mécanisme du cache : module évalué une fois, fabrique appelée deux fois avec une carte de gestionnaires neuve. Elle attrape le cas où quelqu'un déplace `state` dans la fabrique sans ajouter la remise à zéro.

### Autres scénarios de test

| Scénario | Ce qui est affirmé |
|---|---|
| Ramassage des `.tmp` | Un `.tmp` ancien disparaît, un `.tmp` récent survit |
| Table `isAlive` | Test unitaire avec `kill` injecté, les 4 cas |
| Attribution | 2 skills de sources différentes, 1 fichier de contexte, 2 outils, lignes exactes attendues et somme égale à `pi_context_static_tokens` |
| Plafond top N | 50 outils, plafond 5, donc 5 séries nommées plus une `other`, et le total reste vrai |
| Lecture de skill | Un `tool_result` de `read` sur un chemin sous `baseDir` d'un skill donne les tokens à ce skill |
| Absence de `usage` | Un `tool_result` sans `usage` n'émet aucune série imbriquée, compatibilité 0.80 |
| Format | La sortie passe `promtool check metrics`, plus fiable que la regex actuelle |

Rendre `npm test` portable : le dossier temporaire est créé dans le script via `mkdtempSync` avant l'import de l'extension, et le script devient `node test/check.ts`. La branche Windows de la CI est ce qui le prouve.

### Vérification en conditions réelles

```bash
npm i -g @earendil-works/pi-coding-agent@0.84.3 && pi --version
pi install local:/Users/aramsis/IdeaProjects/pi-prometheus
```

Dans un projet où au moins un paquet supplémentaire est installé, sinon l'attribution n'a rien à montrer :

```
/context-budget    → le tableau s'affiche, les sources correspondent aux paquets installés
/metrics           → les chiffres de session, l'URL du point de collecte
```

Puis la remise à zéro, qui est le point dur :

```
> dis bonjour        (les compteurs montent)
/new
curl -s "http://$PORT/metrics" | grep pi_tokens_total   # DOIT être 0 partout
```

Répéter sur `resume` et sur un `fork`.

### Calibrage de l'estimation

C'est l'étape de crédibilité, et son résultat va dans le README en chiffre réel, pas en promesse. Aucun code à ajouter : comparer `pi_context_static_tokens` au `usage.input` rendu par le fournisseur sur le tout premier `message_end` d'une session neuve, dans un projet où rien n'a encore été échangé. L'écart attendu est de l'ordre de 20 pour cent. Écrire le nombre mesuré.

### Emballage

```bash
npm pack --dry-run    # entrée présente, test/ absent, aucun avertissement
npm publish --dry-run
```

## Diffusion

Le seuil du catalogue est une conséquence du trafic, pas une source. L'annonce vient donc en premier, ordonnée par retour attendu.

1. **Publier les deux tableaux de bord sur grafana.com/dashboards**, récupérer les identifiants et les afficher en badge dans le README. Notre seul rival sur le mot clé, `claude-code-opentelemetry`, en fait le centre de sa présentation avec l'identifiant 25255. Le `__inputs` du tableau de bord existant est déjà au bon format.
2. **Répondre dans le fil Hacker News 48847407** avec une mesure, pas une publicité. Ces gens comptent à la main exactement ce que l'on construit. Une sortie de `/context-budget` sur un gros paquet de skills et sur un MCP, avec la réserve `ce sont des estimations chars/4`, vaut plus que n'importe quel post de lancement. Ne pas ouvrir sur le nom du paquet.
3. **Ouvrir une issue sur `earendil-works/pi`** : les extensions ne peuvent pas obtenir de `TelemetryContext`. Vérifié, le contrat existe dans `packages/telemetry`, il invite explicitement des adaptateurs, il en existe zéro, et le CLI n'en construit jamais. L'issue est gratuite et elle parle aux gens qui tiennent pi.dev.
4. **Post communauté Pi** cadré sur le trou, pas sur l'outil : rien dans l'écosystème ne dit quelle extension mange le contexte, donc je l'ai mesuré.
5. **PR sur `BubblePtr/awesome-pi`**, liste curée qui accepte les contributions et qui n'a aucune section observabilité. Les entrées y sont en chinois avec noms et commandes en anglais.
6. Un courriel poli à pi.dev pour demander la règle exacte du seuil d'affichage.

## Risques et ce qui n'est pas vérifié

| Point | État |
|---|---|
| Comportement à l'exécution en 0.84.3 | Forme d'API vérifiée sur les docs du tag, **jamais exécutée**. La mise à jour est le préalable |
| `tool_result.usage` | Documenté en 0.84.3, code émetteur non lu. Métrique à protéger, à retirer si la forme diffère |
| Ampleur de l'erreur d'estimation | Jamais mesurée contre un vrai tokenizer. Les schémas JSON se tokenisent plus dense que 4 caractères, donc surestimation attendue sur les outils |
| Seuil de pi.dev | Déduit du fait que le dernier listé est à 73 par mois. Pas confirmé comme règle |
| `before_agent_start` en mode `--print`, `--json`, RPC | Non vérifié. Doit se dégrader sans lever d'erreur |
| Conditions de publication sur grafana.com | Non recherchées. Pas de badge dans le README avant que l'identifiant existe |
| Adaptateur `pi-telemetry` | Bloqué côté Pi, hors périmètre de cette sortie |

## Ordre d'exécution

Ordonné par dépendance, pas par durée.

1. Mettre Pi en 0.84.3, refaire tourner la suite actuelle, confirmer que rien ne casse déjà
2. Écrire le test de remise à zéro, le voir échouer
3. Corriger les 4 défauts de code, voir le test passer
4. Emballage : `files`, `engines`, script de test portable, mots clés, description
5. Construire l'attribution en fonctions pures exportées, avec leurs tests, sans câblage Pi
6. Câbler `before_agent_start` et `tool_result`, ajouter les familles de métriques et le plafond de cardinalité
7. Mesurer l'écart d'estimation en conditions réelles, écrire le chiffre
8. Les deux commandes, le rendu d'entrée, le pied de page
9. Générer le visuel par script, écrire le README et le CHANGELOG
10. Tableau de bord d'attribution, `alerts.yml`, `docker-compose.yml`
11. CI, y compris la branche Windows et `promtool`
12. Matrice de vérification complète, tag `v0.2.0`, poussée, publication avec provenance
13. Diffusion dans l'ordre de la section précédente
