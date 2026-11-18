"use strict";
/* ============================================================
   Mini-serveur Node — sans aucune dépendance (modules natifs)
   - Sert les fichiers statiques de  ./core  (index.html, css, js)
   - Expose une API JSON pour centraliser TOUTES les données :
       GET  /api/data              -> renvoie le contenu de data.json
       GET  /api/data?backups=1    -> liste des versions précédentes (une par heure)
       GET  /api/data?backup=<clé> -> une version précédente
       PUT  /api/data              -> enregistre, SEULEMENT si l'appareil partait de la
                                      version actuelle (en-tête X-Base-Version), sinon 409
   Lancement :  node server.js   (puis http://localhost:3000)
============================================================ */
const http = require("http");
const fs   = require("fs");
const path = require("path");

const ROOT       = __dirname;
const STATIC_DIR = path.join(ROOT, "core");
const DATA_FILE  = path.join(ROOT, "data.json");
const BACKUP_DIR = path.join(ROOT, "backups");   // versions précédentes (une par heure)
const MAX_BACKUPS = 72;
const PORT       = process.env.PORT || 3000;

/* Données initiales si data.json n'existe pas encore (1er lancement).
   C'est l'UNIQUE endroit où vivent les valeurs par défaut ; ensuite
   tout est lu/écrit dans data.json. */
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

function ensureData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(SEED, null, 2), "utf8");
    console.log("data.json créé avec les valeurs par défaut.");
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".ico":  "image/x-icon",
  ".webmanifest": "application/manifest+json"
};

function sendJson(res, code, obj) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const query = new URL(req.url, "http://localhost").searchParams;

  /* ---------- API : /api/data ---------- */
  if (url === "/api/data") {
    if (req.method === "GET" && query.has("backups")) {
      const keys = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".json")) : [];
      return sendJson(res, 200, keys.map(f => "backups/" + f.slice(0, -5)).sort().reverse());
    }
    if (req.method === "GET" && query.has("backup")) {
      const name = (query.get("backup") || "").replace(/^backups\//, "");
      if (!/^[\dT-]+$/.test(name)) return sendJson(res, 400, { error: "clé invalide" });
      const file = path.join(BACKUP_DIR, name + ".json");
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: "introuvable" });
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(fs.readFileSync(file, "utf8"));
    }
    if (req.method === "GET") {
      ensureData();
      fs.readFile(DATA_FILE, "utf8", (err, txt) => {
        if (err) return sendJson(res, 500, { error: "lecture impossible" });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(txt);
      });
      return;
    }
    if (req.method === "PUT" || req.method === "POST") {
      let body = "";
      req.on("data", chunk => {
        body += chunk;
        if (body.length > 5_000_000) req.destroy(); // garde-fou 5 Mo
      });
      req.on("end", () => {
        // une ancienne version de l'app (sans en-tête) ne doit plus pouvoir écraser les données
        const base = req.headers["x-base-version"];
        if (base === undefined) return sendJson(res, 428, { error: "app à recharger" });
        let data;
        try { data = JSON.parse(body); }
        catch (e) { return sendJson(res, 400, { error: "JSON invalide" }); }
        let current = null;
        try { current = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) {}
        if (current && (current.updatedAt || "") !== base) {
          return sendJson(res, 409, { conflict: true, data: current });
        }
        if (current && current.updatedAt) {
          fs.mkdirSync(BACKUP_DIR, { recursive: true });
          const file = path.join(BACKUP_DIR, current.updatedAt.slice(0, 13) + ".json");
          if (!fs.existsSync(file)) {
            fs.writeFileSync(file, JSON.stringify(current), "utf8");
            const all = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".json")).sort();
            all.slice(0, Math.max(0, all.length - MAX_BACKUPS)).forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
          }
        }
        fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf8", err => {
          if (err) return sendJson(res, 500, { error: "écriture impossible" });
          sendJson(res, 200, { ok: true });
        });
      });
      return;
    }
    return sendJson(res, 405, { error: "méthode non autorisée" });
  }

  /* ---------- Fichiers statiques (./core) ---------- */
  const rel = url === "/" ? "/index.html" : url;
  const filePath = path.normalize(path.join(STATIC_DIR, rel));

  // anti path-traversal : on reste dans STATIC_DIR
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403); return res.end("Accès refusé");
  }

  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end("Introuvable : " + rel); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(buf);
  });
});

ensureData();
server.listen(PORT, () => {
  console.log("Mon Budget en ligne  ->  http://localhost:" + PORT);
  console.log("Données centralisées dans : " + DATA_FILE);
});
