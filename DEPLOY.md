# Déployer « Mon Budget » sur Netlify

L'app utilise un **stockage cloud Netlify Blobs** via une fonction serverless
(`netlify/functions/data.mjs`). Le front appelle `/api/data` (GET/PUT) exactement
comme en local — c'est la fonction qui répond une fois en ligne.

> En local tu continues d'utiliser `node server.js` (données dans `data.json`).
> En ligne, c'est la fonction + Netlify Blobs (données dans le cloud du site).
> Les deux stockages sont indépendants : le contenu local ne part pas tout seul en ligne.

## Méthode 1 — Netlify CLI (rapide, sans GitHub)

```bash
# 1. Installer la CLI (une seule fois)
npm install -g netlify-cli

# 2. Se connecter (ouvre le navigateur)
netlify login

# 3. Depuis le dossier du projet, déployer en production
cd "chemin/vers/hanif"
netlify deploy --prod
```

À la première fois, la CLI demande de **créer un nouveau site** : accepte.
Elle lit `netlify.toml` (publie `core/`, charge les fonctions). À la fin elle
affiche l'URL publique (ex. `https://mon-budget-xxxx.netlify.app`).

Tester en local avec l'environnement Netlify (fonction + Blobs simulés) :
```bash
netlify dev
```

## Méthode 2 — GitHub + tableau de bord Netlify

```bash
git add .
git commit -m "App budget + fonction Netlify"
git push
```

1. Va sur https://app.netlify.com → **Add new site → Import an existing project**.
2. Choisis ton dépôt GitHub.
3. Netlify détecte `netlify.toml` automatiquement (publish = `core`, functions).
4. Clique **Deploy**.

## Bon à savoir
- **Netlify Blobs ne demande aucune clé ni configuration** : c'est activé tout seul
  sur un site déployé.
- Le site démarre avec les valeurs par défaut (salaire 300 000, etc.). Redéfinis
  ton salaire dans l'app une fois en ligne.
- Pour repartir de zéro côté cloud : Site → **Blobs** dans le dashboard Netlify.
