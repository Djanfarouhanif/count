// Fonction serverless Netlify — remplace server.js une fois en ligne.
// Stocke TOUTES les données dans Netlify Blobs (stockage cloud, gratuit).
// Mêmes routes que le serveur local :
//   GET  /api/data              -> renvoie les données
//   GET  /api/data?backups=1    -> liste des versions précédentes (une par heure)
//   GET  /api/data?backup=<clé> -> une version précédente
//   PUT  /api/data              -> enregistre les données, SEULEMENT si l'appareil
//                                  partait de la version actuelle (en-tête X-Base-Version) ;
//                                  sinon 409 + la version actuelle : un appareil resté sur
//                                  d'anciennes données ne peut plus écraser les nouvelles.
import { getStore } from "@netlify/blobs";

// Données initiales au tout premier accès (équivalent du SEED de server.js)
const SEED = {
  pin: "",
  salaireMensuel: 300000,
  salaireDepuis: "",
  rule: { besoins: 50, loisirs: 30, epargne: 20 },
  cats: [
    { id: "nourriture", name: "Nourriture",      icon: "🍚", color: "#0e9f6e", bucket: "besoins", limit: 60000 },
    { id: "transport",  name: "Transport",       icon: "🚕", color: "#2f6fed", bucket: "besoins", limit: 36000 },
    { id: "loyer",      name: "Loyer & Charges", icon: "🏠", color: "#7c3aed", bucket: "besoins", limit: 10000 },
    { id: "loisirs",    name: "Loisirs",         icon: "🎉", color: "#f59e0b", bucket: "loisirs", limit: 0 },
    { id: "telecom",    name: "Tél / Internet",  icon: "📱", color: "#06b6d4", bucket: "besoins", limit: 0 },
    { id: "imprevus",   name: "Imprévus",        icon: "⚡", color: "#ef4444", bucket: "loisirs", limit: 0 },
    { id: "autre",      name: "Autre",           icon: "🧾", color: "#7a8a99", bucket: "loisirs", limit: 0 }
  ],
  income: [],
  tx: [],
  savings: [],
  reserve: 0,
  debts: [],
  goals: [],
  events: [],
  plans: [],
  notes: []
};

// Versions précédentes : une par heure (« backups/2026-11-18T10 »), les 72 dernières.
// Une heure déjà sauvegardée n'est pas remplacée : elle garde l'état du début de l'heure.
const MAX_BACKUPS = 72;
const backupKey = updatedAt => "backups/" + updatedAt.slice(0, 13);

export default async (req) => {
  const store = getStore("budget"); // espace de stockage cloud du site
  const url = new URL(req.url);

  if (req.method === "GET") {
    if (url.searchParams.has("backups")) {
      const { blobs } = await store.list({ prefix: "backups/" });
      return Response.json(blobs.map(b => b.key).sort().reverse());
    }
    const bk = url.searchParams.get("backup");
    if (bk) {
      if (!bk.startsWith("backups/")) return Response.json({ error: "clé invalide" }, { status: 400 });
      const old = await store.get(bk, { type: "json" });
      return old ? Response.json(old) : Response.json({ error: "introuvable" }, { status: 404 });
    }
    let data = await store.get("data", { type: "json" });
    if (!data) { data = SEED; await store.setJSON("data", data); } // 1er accès : on sème
    return Response.json(data);
  }

  if (req.method === "PUT" || req.method === "POST") {
    // une ancienne version de l'app (sans en-tête) ne doit plus pouvoir écraser les données
    const base = req.headers.get("x-base-version");
    if (base === null) return Response.json({ error: "app à recharger" }, { status: 428 });
    let body;
    try { body = await req.json(); }
    catch { return Response.json({ error: "JSON invalide" }, { status: 400 }); }

    const current = await store.get("data", { type: "json" });
    if (current && (current.updatedAt || "") !== base) {
      return Response.json({ conflict: true, data: current }, { status: 409 });
    }
    if (current && current.updatedAt) {
      const key = backupKey(current.updatedAt);
      const { blobs } = await store.list({ prefix: "backups/" });
      const keys = blobs.map(b => b.key).sort();
      if (!keys.includes(key)) {
        await store.setJSON(key, current);
        keys.push(key); keys.sort();
        for (const old of keys.slice(0, Math.max(0, keys.length - MAX_BACKUPS))) await store.delete(old);
      }
    }
    await store.setJSON("data", body);
    return Response.json({ ok: true });
  }

  return Response.json({ error: "méthode non autorisée" }, { status: 405 });
};
// La route /api/data -> cette fonction est gérée par netlify.toml (redirect).
