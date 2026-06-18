// Fonction serverless Netlify — remplace server.js une fois en ligne.
// Stocke TOUTES les données dans Netlify Blobs (stockage cloud, gratuit).
// Mêmes routes que le serveur local :
//   GET  /api/data  -> renvoie les données
//   PUT  /api/data  -> écrase les données
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
  debts: [],
  goals: [
    { id: "urgence", name: "Fonds d'urgence", target: 600000, saved: 0, due: "" }
  ]
};

export default async (req) => {
  const store = getStore("budget"); // espace de stockage cloud du site

  if (req.method === "GET") {
    let data = await store.get("data", { type: "json" });
    if (!data) { data = SEED; await store.setJSON("data", data); } // 1er accès : on sème
    return Response.json(data);
  }

  if (req.method === "PUT" || req.method === "POST") {
    let body;
    try { body = await req.json(); }
    catch { return Response.json({ error: "JSON invalide" }, { status: 400 }); }
    await store.setJSON("data", body);
    return Response.json({ ok: true });
  }

  return Response.json({ error: "méthode non autorisée" }, { status: 405 });
};
// La route /api/data -> cette fonction est gérée par netlify.toml (redirect).
