# Péché Mignon — Bot Discord

Bot Discord en Node.js (même architecture que L’éphémère) pour :

- **Modération** : `/ban`, `/unban`, `/warn`, `/unwarn`, `/analyse`
- **Présentations** : `/presentation` (assistant par étapes)
- **Tickets** : fils **privés** dans un salon `#ticket` (pas de nouveau salon à chaque ticket)
- **Confessions**, **règlement**, **informations**, réactions selfies / auto-fils

Couleur des embeds : `#C8102E` (`EMBED_COLOR_SANCTION` / `EMBED_COLOR_OTHER`).

## Prérequis

- Node.js **20+**
- Un serveur Discord et un rôle dédié pour le staff du bot
- Une **nouvelle** application Discord (token distinct de L’éphémère)
- Intents dans le [Developer Portal](https://discord.com/developers/applications) :
  - **Server Members Intent** (recommandé : autocomplétion + `/analyse`)
  - **Message Content Intent** (texte des preuves dans les fils de signalement)

## Installation (local)

1. Installer les dépendances :
   ```bash
   npm install
   ```

2. Copier `.env.example` vers `.env` et remplir au minimum :
   - `DISCORD_TOKEN`
   - `ADMIN_ROLE_IDS` (IDs des rôles staff, séparés par des virgules)

3. Inviter le bot avec les permissions : *Bannir des membres*, *Envoyer des messages*, *Utiliser les commandes slash*, *Créer des fils privés*, *Gérer les fils*, *Envoyer des messages dans les fils*.

4. Lancer :
   ```bash
   npm start
   ```

En développement : `npm run dev`.

## Commandes

| Commande | Description |
|---|---|
| `/ban` | Bannit un utilisateur (`@membre` ou ID) + **raison** obligatoire. MP au banni. |
| `/unban` | Débannit par ID + **raison** obligatoire. |
| `/warn` | Enregistre un avertissement + **raison**. Les raccourcis (`Fake`, `Menace`…) sont développés. |
| `/unwarn` | Liste les warns, **raison** du retrait, puis menu pour choisir lequel retirer. |
| `/analyse` | Groupes de pseudos similaires (Jaro-Winkler, seuil 92 %). |
| `/presentation` | Assistant Identité / Apparence / À propos, publication en embed. |
| `/ticket-panel` | Poster le panneau d’ouverture de tickets dans le salon courant (staff). |
| `/confession` | Confession anonyme (numérotée). |
| `/confession-reponse` | Réponse staff à une confession. |
| `/confession-log` | Configurer le salon de logs staff. |
| `/règlement` | Poster l’embed règlement + bouton « Lu et approuvé ». |
| `/informations` | Poster l’embed niveaux / boost / giveaways. |

## Tickets (threads privés)

1. Un staff lance `/ticket-panel` dans `#ticket`.
2. Le membre clique **Signalement**, **Aide** ou **Certification**, puis indique un **sujet**.
3. Un fil `Signalement-pseudo` (ou `Aide-…` / `Certification-…`) est créé, le membre y est ajouté, le staff est pingé.
4. Boutons **Revendiquer** (staff) et **Fermer** (staff ou auteur) — le fil est ensuite verrouillé et archivé.

Le staff doit avoir **Gérer les fils** sur le salon `#ticket` pour voir tous les fils privés. Renseigne `TICKET_STAFF_ROLE_IDS` pour les pings à l’ouverture.

Un membre ne peut avoir **qu’un ticket ouvert** à la fois.

## Auto-fil et auto-react

- `SELFIE_CHANNEL_IDS` + `SELFIE_REACTION_IDS` : salons hors catégories (images → fil + 4 réactions).
- `AUTO_THREAD_CHANNEL_IDS` : salons avec fil sous image / lien.
- `AUTO_MEDIA_CATEGORY_IDS` : **tous** les salons de ces catégories ont fil + réactions `CATEGORY_REACTION_IDS`.

## Base de données

- Sans `MONGODB_URI` : SQLite dans `data/peche-mignon.db`
- Avec `MONGODB_URI` : **même Mongo que L’éphémère** (même VPS), base isolée **`peche_mignon`** (pas la base `ephemere`)

Le verrou d’instance utilise la clé `peche-mignon-main` (`PECHE_MIGNON_INSTANCE_LOCK_KEY`) pour ne jamais entrer en conflit avec L’éphémère.

Les deux bots tournent sur **le même VPS** (`178.105.55.152`) : deux utilisateurs Linux, deux dossiers, deux services systemd. Mongo en `localhost` fonctionne. **Ne jamais** `restart` / `stop` le service `ephemere` pour ce bot.

## Workflow après une modification

Code source : <https://github.com/Devco01/P-ch-mignon>  
Le `.env` du serveur **ne se pousse jamais** (secrets).

**Règle :** tu modifies en local → tu pousses sur GitHub → tu tires et redémarres **uniquement** `peche-mignon` sur le VPS.

### 1. Modifier en local (PC)

Dans le dossier du projet (`peche mignon`) :

```powershell
git status
git add src
git commit -m "Description courte de la modif"
git push
```

Ne commite pas `.env`. `.env.example` peut être mis à jour s’il y a une **nouvelle** variable (sans valeur secrète).

Les commandes slash sont ré-enregistrées **au démarrage** du bot : un `restart` de `peche-mignon` suffit après un changement de `/ban`, `/ticket-panel`, etc.

### 2. Déployer une mise à jour (VPS partagé)

```powershell
ssh -i $env:USERPROFILE\.ssh\id_ed25519_hetzner root@178.105.55.152
```

Puis :

```bash
su - pechemignon -c 'cd /home/pechemignon/bot && git pull && npm install'
systemctl restart peche-mignon
systemctl status peche-mignon --no-pager
```

Tu dois voir `active (running)`. Vérifie que L’éphémère n’a pas bougé :

```bash
systemctl status ephemere --no-pager
```

Logs Péché Mignon :

```bash
journalctl -u peche-mignon -f
```

(`Ctrl+C` pour quitter les logs, le bot continue de tourner.)

### 3. Premier provisionnement (à côté de L’éphémère)

Node et Git sont déjà là. En root, **sans toucher** à `/home/ephemere` :

```bash
id pechemignon || adduser --disabled-password --gecos "" pechemignon
su - pechemignon -c 'git clone https://github.com/Devco01/P-ch-mignon.git /home/pechemignon/bot && cd /home/pechemignon/bot && npm install'
cp /home/pechemignon/bot/deploy/peche-mignon.service /etc/systemd/system/peche-mignon.service
# Créer /home/pechemignon/bot/.env (token Péché Mignon + même MONGODB_URI que L’éphémère)
# Ne pas modifier /home/ephemere/bot/.env
chown pechemignon:pechemignon /home/pechemignon/bot/.env
chmod 600 /home/pechemignon/bot/.env
systemctl daemon-reload
systemctl enable --now peche-mignon
systemctl status peche-mignon --no-pager
systemctl status ephemere --no-pager
```

Le fichier d’unité est dans [`deploy/peche-mignon.service`](deploy/peche-mignon.service).

Pour lire l’URI Mongo de L’éphémère **sans l’éditer** :

```bash
grep '^MONGODB_URI=' /home/ephemere/bot/.env
```

Colle la même ligne dans `/home/pechemignon/bot/.env`. Le code écrit dans la base `peche_mignon`, pas `ephemere`.

### 4. Changer un secret / un ID (token, rôles, salon ticket)

Sur le VPS seulement, fichier **Péché Mignon** :

```bash
nano /home/pechemignon/bot/.env
systemctl restart peche-mignon
```

### 5. Commandes utiles

| Action | Commande |
|---|---|
| État Péché Mignon | `systemctl status peche-mignon` |
| État L’éphémère (ne pas stopper) | `systemctl status ephemere` |
| Logs Péché Mignon | `journalctl -u peche-mignon -n 100 --no-pager` |
| Redémarrer Péché Mignon | `systemctl restart peche-mignon` |
| Arrêter Péché Mignon | `systemctl stop peche-mignon` |
| Relancer Péché Mignon | `systemctl start peche-mignon` |
| SSH | `ssh -i $env:USERPROFILE\.ssh\id_ed25519_hetzner root@178.105.55.152` |

Chemins serveur :

- Péché Mignon : `/home/pechemignon/bot`
- L’éphémère (ne pas modifier pour ce bot) : `/home/ephemere/bot`
- Secrets Péché Mignon : `/home/pechemignon/bot/.env`
- Service Péché Mignon : `/etc/systemd/system/peche-mignon.service`
- Service L’éphémère : `/etc/systemd/system/ephemere.service`

### 6. Ne pas faire

- `systemctl restart ephemere` / `stop ephemere` / éditer `/home/ephemere/bot` pour installer Péché Mignon.
- Lancer `npm start` à la main **en plus** de systemd (deux instances = commandes en double).
- Copier le `.env` local par-dessus GitHub.
- Modifier les fichiers **uniquement** sur le VPS : au prochain `git pull`, tes changements serveur seront écrasés.

## Structure

```
src/
  index.js
  config.js
  database.js / databaseSqlite.js / databaseMongo.js
  embeds.js / permissions.js / validation.js / rateLimit.js
  commands/
    moderation.js
    presentation.js
    tickets.js
    confession.js
    reglement.js
    informations.js
deploy/
  peche-mignon.service
```
