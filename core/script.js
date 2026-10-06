
"use strict";
/* ============================================================
   DONNÉES CENTRALISÉES — serveur Node + data.json
   Rien n'est codé en dur : tout vit dans data.json, lu/écrit via
   l'API (/api/data) du mini-serveur server.js.
   DEFAULT_CATS / freshState ne servent QUE de secours si l'API
   est injoignable (ex. fichier ouvert en file:// sans serveur).
============================================================ */
const API = "/api/data";
const LS_KEY = "monbudget_cache_v1";   // cache local (fonctionnement hors-ligne)
let online = false;                     // serveur/cloud joignable ?
let dirty  = false;                     // changements locaux pas encore synchronisés ?
const DEFAULT_CATS = [
  {id:"nourriture", name:"Nourriture",        icon:"🍚", color:"#0e9f6e", bucket:"besoins", limit:60000},
  {id:"transport",  name:"Transport",         icon:"🚕", color:"#2f6fed", bucket:"besoins", limit:36000},
  {id:"loyer",      name:"Loyer & Charges",   icon:"🏠", color:"#7c3aed", bucket:"besoins", limit:10000},
  {id:"loisirs",    name:"Loisirs",           icon:"🎉", color:"#f59e0b", bucket:"loisirs", limit:0},
  {id:"telecom",    name:"Tél / Internet",    icon:"📱", color:"#06b6d4", bucket:"besoins", limit:0},
  {id:"imprevus",   name:"Imprévus",          icon:"⚡", color:"#ef4444", bucket:"loisirs", limit:0},
  {id:"autre",      name:"Autre",             icon:"🧾", color:"#7a8a99", bucket:"loisirs", limit:0},
];
// catégorie utilisée pour les dettes remboursées (créée à la demande, pas imposée)
const DEBT_CAT_ID = "remb_dette";
const DEBT_CAT = {id:DEBT_CAT_ID, name:"Remboursement dette", icon:"💳", color:"#e11d48", bucket:"besoins", limit:0};

function freshState(){
  return {
    pin: "",                 // code de verrouillage (vide = pas de code)
    salaireMensuel: 300000, // salaire crédité automatiquement chaque mois
    salaireDepuis: "",       // mois "YYYY-MM" à partir duquel le salaire est crédité
    rule: {besoins:50, loisirs:30, epargne:20},
    cats: DEFAULT_CATS,
    income: [],        // rentrées d'argent {id, amount, note, date(ISO), auto?, month?, debtId?}
    tx: [],            // dépenses {id, amount, catId, note, date(ISO), debtId?}
    savings: [],       // mouvements d'épargne {id, target:"reserve"|goalId, amount(+/-), date(ISO)}
    reserve: 0,        // épargne de sécurité = réserve libre (sans cible)
    soldeAdjust: 0,    // correction manuelle du SEUL argent global (n'entre dans aucun historique/stat)
    recurrents: [],    // dépenses automatiques {id, amount, catId, note, day(1-28), since:"YYYY-MM", active, skips:[]}
    debts: [],         // dettes/créances {id, type:"dette"|"creance", person, amount, note, date, settled, settledDate}
                       //   réglée -> un vrai mouvement (tx ou income) portant debtId est créé
    goals: [],         // objectifs d'achat {id, name, target, saved, due}
    events: [],        // événements planifiés {id, name, date:"YYYY-MM-DD", time, place, cost, note, status:"prevu"|"annule"}
                       //   payé -> une dépense portant eventId est créée
  };
}

let S = null;            // rempli au démarrage par load()
let dataLoaded = false;  // true si les données ont bien été chargées depuis le serveur
let needsSave = false;   // true si normalize a fait une migration à persister

function normalize(s){
  s = s || {};
  s.pin = typeof s.pin === "string" ? s.pin : "";
  s.updatedAt = typeof s.updatedAt === "string" ? s.updatedAt : ""; // horodatage pour la synchro
  // migration : ancien champ "revenu" -> "salaireMensuel"
  if(s.salaireMensuel === undefined && s.revenu !== undefined) s.salaireMensuel = s.revenu;
  s.salaireMensuel = Number(s.salaireMensuel) || 0;
  s.salaireDepuis  = s.salaireDepuis || "";
  s.rule   = s.rule || {besoins:50, loisirs:30, epargne:20};
  s.cats   = (s.cats && s.cats.length) ? s.cats : DEFAULT_CATS;
  s.cats.forEach(c=>{ c.limit = Number(c.limit) || 0; }); // plafond mensuel par catégorie
  s.income  = s.income || [];
  s.savings = s.savings || [];
  s.debts   = s.debts || [];
  s.goals   = s.goals || [];
  s.events  = s.events || [];
  s.events.forEach(e=>{ e.cost = Number(e.cost) || 0; e.status = e.status==="annule" ? "annule" : "prevu"; });
  s.tx      = s.tx || [];
  // migration : sépare l'épargne de sécurité (réserve) des objectifs d'achat.
  // L'ancien « Fonds d'urgence » devient la réserve de sécurité.
  if(s.reserve === undefined){
    s.reserve = 0;
    const i = s.goals.findIndex(g=>g.id==="urgence");
    if(i>=0){ s.reserve += Number(s.goals[i].saved)||0; s.goals.splice(i,1); }
    needsSave = true;
  }
  s.reserve = Number(s.reserve) || 0;
  s.soldeAdjust = Number(s.soldeAdjust) || 0;
  s.recurrents = s.recurrents || [];
  s.recurrents.forEach(r=>{
    r.amount = Number(r.amount) || 0;
    r.day    = Math.min(28, Math.max(1, Number(r.day) || 1));
    r.active = r.active !== false;
    r.skips  = r.skips || [];
  });
  // migration : un règlement de dette/créance devient un VRAI mouvement d'argent.
  // Avant, le solde global lisait directement les lignes réglées : supprimer une dette
  // déjà payée faisait bouger l'argent global. Maintenant le règlement crée une dépense
  // (dette payée) ou un revenu (créance reçue) relié par debtId ; la ligne de dette ne
  // sert plus qu'au suivi. Le solde reste identique avant/après migration.
  s.debts.forEach(d=>{
    if(!d.settled) return;
    const linked = d.type==="dette" ? s.tx.some(t=>t.debtId===d.id)
                                    : s.income.some(i=>i.debtId===d.id);
    if(linked) return;
    const when = d.settledDate || d.date || todayISO();
    const amt  = Number(d.amount) || 0;
    if(d.type==="dette"){
      if(!s.cats.some(c=>c.id===DEBT_CAT_ID)) s.cats.push({...DEBT_CAT});
      s.tx.push({id:uid(), amount:amt, catId:DEBT_CAT_ID, note:debtLabel(d), date:when, debtId:d.id});
    }else{
      s.income.push({id:uid(), amount:amt, note:debtLabel(d), date:when, debtId:d.id});
    }
    needsSave = true;
  });
  delete s.revenu;
  return s;
}
// libellé du mouvement généré par un règlement
function debtLabel(d){
  return (d.type==="dette" ? "Dette remboursée · " : "Créance reçue · ") + (d.person || "—");
}

/* ----- Cache local (hors-ligne) ----- */
function lsRead(){ try{ const r=localStorage.getItem(LS_KEY); return r?JSON.parse(r):null; }catch(e){ return null; } }
function lsWrite(d){ try{ localStorage.setItem(LS_KEY, JSON.stringify(d)); }catch(e){} }

async function fetchServer(){
  try{ const res=await fetch(API,{cache:"no-store"}); if(!res.ok) throw 0; return await res.json(); }
  catch(e){ return undefined; } // undefined = serveur injoignable (hors-ligne)
}
async function pushToServer(data){
  try{
    const res=await fetch(API,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
    if(!res.ok) throw 0;
    online=true; dirty=false;
  }catch(e){ online=false; dirty=true; }
  updateSyncBadge();
}

// Lecture : combine cache local + serveur ; le plus récent gagne. Marche hors-ligne.
async function load(){
  const local  = lsRead();
  const server = await fetchServer();
  let chosen;
  if(server !== undefined){
    online = true;
    if(local && (local.updatedAt||"") > (server.updatedAt||"")){
      chosen = local; pushToServer(local);   // le local est plus récent -> on le pousse
    } else {
      chosen = server; dirty = false;
    }
  } else {
    online = false;
    chosen = local || freshState();
    if(local) dirty = true;                   // données locales potentiellement non synchronisées
  }
  dataLoaded = true;
  const norm = normalize(chosen);
  lsWrite(norm);
  updateSyncBadge();
  return norm;
}

// Écriture : TOUJOURS en local (hors-ligne OK), puis tentative vers le serveur.
async function save(){
  S.updatedAt = new Date().toISOString();
  lsWrite(S);
  await pushToServer(S);
}

// Synchronisation (au retour de connexion) : le plus récent gagne.
async function syncNow(){
  const server = await fetchServer();
  if(server === undefined){ online=false; updateSyncBadge(); return; }
  online = true;
  if((server.updatedAt||"") > (S.updatedAt||"")){
    S = normalize(server); lsWrite(S); dirty=false; renderAll();  // le serveur est plus récent
  } else if(dirty || (S.updatedAt||"") > (server.updatedAt||"")){
    await pushToServer(S);                                        // le local est plus récent
  } else {
    dirty=false;
  }
  updateSyncBadge();
}
window.addEventListener("online", ()=>{ toast("Connexion retrouvée — synchronisation…"); syncNow(); });
window.addEventListener("offline", ()=>{ online=false; updateSyncBadge(); });

// Petit indicateur d'état (en ligne / hors-ligne / à synchroniser)
function updateSyncBadge(){
  const el=$("#syncDot"); if(!el) return;
  if(online && !dirty){ el.textContent="● en ligne";   el.style.color="#0e9f6e"; }
  else if(online && dirty){ el.textContent="● synchro…"; el.style.color="#f59e0b"; }
  else { el.textContent="● hors ligne"; el.style.color="#ef4444"; }
}

/* ============================================================
   UTILITAIRES
============================================================ */
const MONTHS = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
const $ = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>[...r.querySelectorAll(s)];

function fmt(n){
  n = Math.round(Number(n)||0);
  return n.toLocaleString("fr-FR").replace(/ |,/g," ");
}
function fmtF(n){ return fmt(n)+" FCFA"; }

// On travaille avec un mois "courant" = mois calendaire réel.
function ym(d){ return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0"); }
function nowYM(){ return ym(new Date()); }
function prevYM(){ const d=new Date(); d.setDate(1); d.setMonth(d.getMonth()-1); return ym(d); }
function monthName(yms){
  const [y,m] = yms.split("-").map(Number);
  return MONTHS[m-1]+" "+y;
}
function txYM(t){ return t.date.slice(0,7); }
function catById(id){ return S.cats.find(c=>c.id===id) || {name:"Autre",icon:"🧾",color:"#7a8a99",bucket:"loisirs"}; }

function txOfMonth(yms){ return S.tx.filter(t=>txYM(t)===yms); }
function totalOfMonth(yms){ return txOfMonth(yms).reduce((a,t)=>a+t.amount,0); }
function incomeOfMonth(yms){ return S.income.filter(i=>i.date.slice(0,7)===yms).reduce((a,i)=>a+i.amount,0); }
function savedOfMonth(yms){ return S.savings.filter(s=>s.date.slice(0,7)===yms).reduce((a,s)=>a+s.amount,0); }

/* ----- ARGENT GLOBAL : tout en découle ----- */
function sumIncome(){ return S.income.reduce((a,i)=>a+i.amount,0); }      // total encaissé (salaires + ponctuels)
function sumExpenses(){ return S.tx.reduce((a,t)=>a+t.amount,0); }         // total dépensé
function sumSaved(){ return (S.reserve||0) + S.goals.reduce((a,g)=>a+(g.saved||0),0); } // réserve sécurité + objectifs
// Les dettes/créances réglées ne sont PAS comptées ici : leur règlement a créé un vrai
// mouvement (dépense ou revenu), déjà pris dans sumExpenses()/sumIncome(). Supprimer une
// ligne de dette ne touche donc plus à l'argent global.
// soldeAdjust = correction manuelle (« mon argent réel est X »). Elle ne touche QUE cette
// ligne : ni l'historique, ni les dépenses du mois, ni les stats par catégorie.
function soldeGlobal(){ return sumIncome() - sumExpenses() - sumSaved() + (S.soldeAdjust||0); }

function uid(){ return Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36); }
function todayISO(){ return new Date().toISOString(); }
function todayDate(){ const d=new Date(); return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"); }
// transforme une date "YYYY-MM-DD" choisie en ISO ; garde l'heure réelle si c'est aujourd'hui
function dateFromInput(dval){ return (!dval || dval===todayDate()) ? todayISO() : dval+"T12:00:00.000Z"; }

/* Crédite automatiquement le salaire pour chaque mois écoulé depuis
   "salaireDepuis" jusqu'au mois courant (une seule entrée auto par mois). */
function ensureSalary(){
  if(!S.salaireMensuel || S.salaireMensuel<=0) return false;
  if(!S.salaireDepuis) S.salaireDepuis = nowYM();
  const cur = nowYM();
  let [y,m] = S.salaireDepuis.split("-").map(Number);
  let changed = false, guard = 0;
  while(guard++ < 1200){
    const yms = y+"-"+String(m).padStart(2,"0");
    if(!S.income.some(i=>i.auto && i.month===yms)){
      S.income.push({id:uid(), amount:S.salaireMensuel, note:"Salaire", date:yms+"-01T08:00:00.000Z", auto:true, month:yms});
      changed = true;
    }
    if(yms===cur) break;
    m++; if(m>12){m=1;y++;}
  }
  return changed;
}

function daysInMonth(y,m){ return new Date(y, m, 0).getDate(); }   // m = 1-12
/* Enregistre les DÉPENSES RÉCURRENTES (loyer, internet, abonnements…) pour chaque
   mois écoulé depuis leur création, exactement comme le salaire pour les revenus.
   - une seule dépense par récurrente et par mois (clé recId + recMonth)
   - le mois en cours n'est enregistré qu'à partir du jour d'échéance : on n'anticipe pas
   - une dépense générée puis supprimée à la main n'est pas recréée (liste "skips") */
function ensureRecurrents(){
  if(!S.recurrents || !S.recurrents.length) return false;
  const cur = nowYM(), todayD = new Date().getDate();
  let changed = false;
  S.recurrents.forEach(r=>{
    if(!r.active || !r.amount) return;
    let [y,m] = (r.since || cur).split("-").map(Number);
    let guard = 0;
    while(guard++ < 600){
      const yms = y+"-"+String(m).padStart(2,"0");
      const dueDay = Math.min(r.day || 1, daysInMonth(y,m));
      const tropTot = (yms===cur && todayD < dueDay);      // échéance pas encore arrivée
      const efface  = (r.skips||[]).includes(yms);          // supprimée à la main ce mois-là
      if(!tropTot && !efface && !S.tx.some(t=>t.recId===r.id && t.recMonth===yms)){
        S.tx.push({
          id:uid(), amount:r.amount, catId:r.catId, note:r.note||"",
          date:`${yms}-${String(dueDay).padStart(2,"0")}T09:00:00.000Z`,
          recId:r.id, recMonth:yms
        });
        changed = true;
      }
      if(yms===cur) break;
      m++; if(m>12){m=1;y++;}
    }
  });
  return changed;
}

/* ============================================================
   NAVIGATION
============================================================ */
function show(tab){
  $$(".screen").forEach(s=>s.classList.remove("active"));
  $("#screen-"+tab).classList.add("active");
  $$(".tabbar button").forEach(b=>b.classList.toggle("on", b.dataset.tab===tab));
  const c=$("#content"); if(c) c.scrollTop=0;
  renderAll();
}
$$(".tabbar button").forEach(b=>{
  b.addEventListener("click",()=>{
    const tab=b.dataset.tab;
    if(tab==="add") resetAddForm();
    show(tab);
    if(tab==="add") setTimeout(()=>$("#amountBig").focus(),120);
  });
});
$("#goHistory").addEventListener("click",()=>show("history"));
$("#addIncome").addEventListener("click",()=>openAddIncome());
$("#quickExpense").addEventListener("click",()=>{ resetAddForm(); show("add"); setTimeout(()=>$("#amountBig").focus(),120); });

/* ============================================================
   ACCUEIL
============================================================ */
function renderHome(){
  const cur = nowYM();
  const solde   = soldeGlobal();
  const revMois = incomeOfMonth(cur);
  const depMois = totalOfMonth(cur);
  const epaMois = savedOfMonth(cur);
  // les règlements de dettes/créances du mois sont déjà dans revMois / depMois
  const resteMois = revMois - depMois - epaMois;

  $("#monthLabel").textContent = "Argent suivi globalement";
  $("#moisCourant").textContent = monthName(cur);

  // hero : solde global réellement disponible
  const heroEl = $("#soldeGlobal");
  heroEl.textContent = fmtF(solde);
  heroEl.style.color = solde < 0 ? "#ffe1de" : "#fff";
  $("#heroIncome").textContent = fmt(revMois);
  $("#heroDepense").textContent = fmt(depMois);

  // carte du mois
  $("#mRevenu").textContent  = fmt(revMois);
  $("#mDepense").textContent = fmt(depMois);
  $("#mEpargne").textContent = fmt(epaMois);
  const resteEl = $("#mReste");
  resteEl.textContent = fmtF(resteMois);
  resteEl.style.color = resteMois < 0 ? "var(--red)" : "var(--green)";

  // alerte : tout est rapporté à l'argent global
  const box = $("#untrackedAlert");
  if(solde < 0){
    box.innerHTML = `<div class="alert bad"><span class="ico">🚨</span><div>Solde négatif&nbsp;: tu as engagé <span class="amt">${fmtF(-solde)}</span> de plus que ce que tu possèdes.</div></div>`;
  } else if(revMois>0 && resteMois < 0){
    box.innerHTML = `<div class="alert warn"><span class="ico">⚠️</span><div>Ce mois tu as dépensé/épargné <span class="amt">${fmtF(-resteMois)}</span> de plus que ton revenu du mois — tu puises dans tes réserves.</div></div>`;
  } else if(depMois===0 && epaMois===0){
    box.innerHTML = `<div class="alert warn"><span class="ico">👀</span><div>Rien de saisi ce mois. Note chaque dépense pour voir où part ton argent.</div></div>`;
  } else {
    box.innerHTML = `<div class="alert ok"><span class="ico">✅</span><div>Il te reste <span class="amt">${fmtF(resteMois)}</span> à vivre ce mois, et <span class="amt">${fmtF(solde)}</span> au total.</div></div>`;
  }

  // derniers mouvements (revenus + dépenses mêlés)
  const mv = movements().slice(0,8);
  $("#recentList").innerHTML = mv.length ? mv.map(m=>m.kind==="in"?incomeRow(m):txRow(m)).join("")
    : `<div class="empty">Aucun mouvement pour l'instant.<br>Ajoute un revenu ou une dépense.</div>`;
  bindTxRows("#recentList");
  bindIncomeRows("#recentList");
}

// liste unifiée revenus + dépenses, triée du plus récent au plus ancien
function movements(){
  const inc = S.income.map(i=>({...i, kind:"in"}));
  const out = S.tx.map(t=>({...t, kind:"out"}));
  return [...inc,...out].sort((a,b)=>b.date.localeCompare(a.date));
}
function incomeRow(i){
  const d = new Date(i.date);
  const when = `${String(d.getDate()).padStart(2,"0")} ${MONTHS[d.getMonth()].slice(0,4)}.${i.auto?" · auto":""}`;
  return `<div class="tx in" data-inid="${i.id}">
    <div class="av" style="background:#0e9f6e22;">${i.auto?"💼":"💵"}</div>
    <div class="meta"><div class="t">${escapeHtml(i.note||"Revenu")}</div><div class="s">${when}</div></div>
    <div class="val num">+${fmt(i.amount)}</div>
  </div>`;
}
function bindIncomeRows(sel){
  $$(sel+" .tx.in").forEach(row=>row.addEventListener("click",()=>openIncomeSheet(row.dataset.inid)));
}

function txRow(t){
  const c = catById(t.catId);
  const d = new Date(t.date);
  const when = `${String(d.getDate()).padStart(2,"0")} ${MONTHS[d.getMonth()].slice(0,4)}. · ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  return `<div class="tx" data-id="${t.id}">
    <div class="av" style="background:${c.color}22;">${c.icon}</div>
    <div class="meta"><div class="t">${c.name}${t.note?` · <span class="small">${escapeHtml(t.note)}</span>`:""}</div><div class="s">${when}</div></div>
    <div class="val num">-${fmt(t.amount)}</div>
  </div>`;
}
function escapeHtml(s){return (s||"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}

function bindTxRows(sel){
  $$(sel+" .tx:not(.in)").forEach(row=>{
    row.addEventListener("click",()=>openTxSheet(row.dataset.id));
  });
}

/* ============================================================
   AJOUTER UNE DÉPENSE (cœur de l'app)
============================================================ */
let selectedCat = null;
function renderCatGrid(){
  $("#catGrid").innerHTML = S.cats.map(c=>`
    <div class="cat${selectedCat===c.id?' sel':''}" data-cat="${c.id}">
      <div class="ci">${c.icon}</div><div class="cn">${c.name}</div>
    </div>`).join("")
    + `<div class="cat catadd" id="catAddTile"><div class="ci">＋</div><div class="cn">Nouvelle</div></div>`;
  $$("#catGrid .cat[data-cat]").forEach(el=>{
    el.addEventListener("click",()=>{
      selectedCat = el.dataset.cat;
      $$("#catGrid .cat").forEach(x=>x.classList.toggle("sel", x.dataset.cat===selectedCat));
    });
  });
  $("#catAddTile").addEventListener("click", ()=>openCategorySheet());
}
function resetAddForm(){
  selectedCat = null;
  $("#amountBig").value = "";
  $("#noteInput").value = "";
  $("#dateInput").value = todayDate(); // date du jour par défaut
  renderCatGrid();
}
// format amount input live
$("#amountBig").addEventListener("input",e=>{
  const digits = e.target.value.replace(/\D/g,"");
  e.target.value = digits ? fmt(digits) : "";
});
$("#saveTx").addEventListener("click",()=>{
  const amount = Number(($("#amountBig").value||"").replace(/\D/g,""));
  if(!amount){ shake($("#amountBig")); return; }
  if(!selectedCat){ flashCatGrid(); return; }
  S.tx.push({id:uid(), amount, catId:selectedCat, note:$("#noteInput").value.trim(), date:dateFromInput($("#dateInput").value)});
  save();
  resetAddForm();
  toast("Dépense enregistrée ✅");
  show("home");
});
function shake(el){ el.style.transition="transform .07s"; let i=0; const seq=[-8,8,-6,6,-3,0];
  const t=setInterval(()=>{ el.style.transform=`translateX(${seq[i]}px)`; if(++i>=seq.length){clearInterval(t);el.style.transform="";} },60); }
function flashCatGrid(){ const g=$("#catGrid"); g.style.transition="box-shadow .2s"; g.style.boxShadow="0 0 0 2px #ef4444"; setTimeout(()=>g.style.boxShadow="",500); toast("Choisis une catégorie"); }

// Éditeur de catégorie : création (id absent) OU modification/suppression (id présent)
function openCategorySheet(id){
  const isNew = !id;
  const c = id ? S.cats.find(x=>x.id===id) : null;
  if(id && !c) return;
  const ICONS = ["🛒","🍔","☕","👕","💊","🏥","🎓","⛽","🎮","🎁","💡","🚗","📚","✈️","🐟","🍺","💇","🐾","🔌","🧹","💰","🎵"];
  const COLORS = ["#0e9f6e","#2f6fed","#7c3aed","#f59e0b","#06b6d4","#ef4444","#e11d8f","#16a34a","#0891b2","#7a8a99"];
  let icon = c ? c.icon : "";
  let color = c ? c.color : COLORS[0];
  let bucket = c ? c.bucket : "besoins";
  openSheet(`
    <h3>${isNew?"Nouvelle catégorie":"Modifier la catégorie"}</h3>
    <label class="fld">Nom</label>
    <input id="ncName" placeholder="ex : Santé, Vêtements, Café…" value="${c?escapeHtml(c.name):""}" />
    <label class="fld">Icône</label>
    <input id="ncIcon" maxlength="2" placeholder="Tape un emoji ou choisis ci-dessous" style="text-align:center;font-size:24px;" value="${c?c.icon:""}" />
    <div class="iconpick" id="ncIcons">${ICONS.map(e=>`<button type="button" class="picki" data-e="${e}">${e}</button>`).join("")}</div>
    <label class="fld">Couleur</label>
    <div class="colorpick" id="ncColors">${COLORS.map(cc=>`<button type="button" class="pickc" data-c="${cc}" style="background:${cc}"></button>`).join("")}</div>
    <label class="fld">Type (pour la règle 50/30/20)</label>
    <div class="seg" id="ncBucket">
      <button type="button" data-b="besoins" class="${bucket==='besoins'?'on':''}">Besoin</button>
      <button type="button" data-b="loisirs" class="${bucket==='loisirs'?'on':''}">Loisir</button>
    </div>
    <label class="fld">Limite mensuelle (FCFA, optionnel)</label>
    <input id="ncLimit" inputmode="numeric" placeholder="0 = sans limite" value="${c&&c.limit?fmt(c.limit):""}" />
    <div style="height:14px;"></div>
    <button class="btn" id="ncSave">${isNew?"Créer la catégorie":"Enregistrer"}</button>
    ${isNew?"":`<div style="text-align:center;margin-top:12px;"><button class="danger-link" id="ncDel">🗑 Supprimer cette catégorie</button></div>`}
  `);
  // icône : clic sur un emoji proposé OU saisie manuelle
  $$("#ncIcons .picki").forEach(b=>b.addEventListener("click",()=>{ icon=b.dataset.e; $("#ncIcon").value=icon; }));
  $("#ncIcon").addEventListener("input",e=>{ icon=e.target.value.trim(); });
  // couleur (présélectionne la couleur actuelle si elle est dans la palette)
  const pickColor=(b)=>{ color=b.dataset.c; $$("#ncColors .pickc").forEach(x=>x.classList.toggle("sel",x===b)); };
  $$("#ncColors .pickc").forEach(b=>b.addEventListener("click",()=>pickColor(b)));
  const curSwatch = $$("#ncColors .pickc").find(b=>b.dataset.c===color);
  if(curSwatch) curSwatch.classList.add("sel"); else pickColor($("#ncColors .pickc"));
  // type
  $$("#ncBucket button").forEach(b=>b.addEventListener("click",()=>{ bucket=b.dataset.b; $$("#ncBucket button").forEach(x=>x.classList.toggle("on",x===b)); }));
  // limite formatée
  $("#ncLimit").addEventListener("input",e=>{const d=e.target.value.replace(/\D/g,"");e.target.value=d?fmt(d):"";});
  if(isNew) setTimeout(()=>$("#ncName").focus(),120);

  $("#ncSave").addEventListener("click",()=>{
    const name=$("#ncName").value.trim();
    if(!name){ shake($("#ncName")); return; }
    const ic = ($("#ncIcon").value.trim() || icon || "🧾");
    const lim = Number($("#ncLimit").value.replace(/\D/g,""))||0;
    if(isNew){
      const nid="c"+uid();
      S.cats.push({id:nid, name, icon:ic, color, bucket, limit:lim});
      selectedCat = nid;       // sélectionne direct la nouvelle catégorie
    } else {
      c.name=name; c.icon=ic; c.color=color; c.bucket=bucket; c.limit=lim;
    }
    save();closeSheet();renderCatGrid();
    toast(isNew?"Catégorie créée ✅":"Catégorie modifiée ✅");
    renderAll();
  });

  if(!isNew){
    $("#ncDel").addEventListener("click",()=>{
      const n = S.tx.filter(t=>t.catId===id).length;
      // déplace les dépenses de cette catégorie vers "Autre" (si elle existe)
      const target = (id!=="autre" && S.cats.some(x=>x.id==="autre")) ? "autre" : null;
      if(target) S.tx.forEach(t=>{ if(t.catId===id) t.catId=target; });
      S.cats = S.cats.filter(x=>x.id!==id);
      if(selectedCat===id) selectedCat=null;
      save();closeSheet();renderCatGrid();
      toast(n ? `Catégorie supprimée (${n} dépense${n>1?"s":""} → Autre)` : "Catégorie supprimée");
      renderAll();
    });
  }
}

/* ============================================================
   BUDGET & ÉPARGNE : un seul onglet, deux vues (Budget | Épargne)
============================================================ */
let budgetView = "budget";
function setBudgetView(v){
  budgetView = v;
  $$("#budgetSeg button").forEach(b=>b.classList.toggle("on", b.dataset.v===v));
  $("#panel-budget").style.display = v==="budget" ? "" : "none";
  $("#panel-saving").style.display = v==="saving" ? "" : "none";
  $("#budgetSub").textContent = v==="budget" ? "Répartition de ton revenu" : "Sécurise ton argent 🛡️";
  const c=$("#content"); if(c) c.scrollTop=0;
}
$$("#budgetSeg button").forEach(b=>b.addEventListener("click",()=>setBudgetView(b.dataset.v)));

/* ============================================================
   BUDGET 50/30/20
============================================================ */
function renderBudget(){
  const cur = nowYM();
  const txs = txOfMonth(cur);

  // buckets selon catégorie
  const revMois = incomeOfMonth(cur); // revenu réel du mois = salaire + revenus ponctuels
  const spent = {besoins:0, loisirs:0, epargne:0};
  txs.forEach(t=>{ const b=catById(t.catId).bucket||"loisirs"; spent[b]+=t.amount; });
  spent.epargne = savedOfMonth(cur); // épargne réellement mise de côté ce mois
  const budgets = {
    besoins: revMois*S.rule.besoins/100,
    loisirs: revMois*S.rule.loisirs/100,
    epargne: revMois*S.rule.epargne/100,
  };
  const labels = {besoins:"Besoins", loisirs:"Loisirs", epargne:"Épargne"};
  $("#ruleBars").innerHTML = ["besoins","loisirs","epargne"].map(k=>{
    return progBar(`${labels[k]} (${S.rule[k]||0}%)`, spent[k], budgets[k], k==="epargne");
  }).join("");

  // carte salaire mensuel (espace dédié)
  $("#salaireBig").textContent = fmtF(S.salaireMensuel);
  const credites = S.income.filter(i=>i.auto).length;
  $("#salaireInfo").textContent = S.salaireMensuel>0
    ? `Crédité automatiquement chaque mois (${credites} mois crédité${credites>1?"s":""} jusqu'ici).`
    : "Aucun salaire défini — touche le bouton pour l'indiquer.";

  // par catégorie : dépensé ce mois vs limite définie par l'utilisateur
  const byCat = {};
  txs.forEach(t=>{ byCat[t.catId]=(byCat[t.catId]||0)+t.amount; });
  const hint = `<div class="small" style="margin:-2px 0 12px;">Touche une catégorie pour la modifier ou la supprimer.</div>`;
  $("#catBudgetBars").innerHTML = hint + S.cats.map(c=>{
    const used = byCat[c.id] || 0;
    const lim  = c.limit || 0;
    if(lim > 0){
      const pct = Math.round(used/lim*100);
      const cls = pct>=100 ? "bad" : (pct>=80 ? "warn" : "");
      const left = lim - used;
      const span = cls ? `style="width:${Math.min(100,Math.max(2,pct))}%"`
                       : `style="width:${Math.min(100,Math.max(2,pct))}%;background:${c.color}"`;
      const note = left < 0
        ? `<span style="color:var(--red)">Dépassé de ${fmt(-left)} FCFA</span>`
        : `Reste ${fmt(left)} FCFA`;
      return `<div class="prog" data-catedit="${c.id}" style="cursor:pointer">
        <div class="head"><span class="name">${c.icon} ${c.name}</span><span class="vals">${fmt(used)} / ${fmt(lim)}</span></div>
        <div class="bar ${cls}"><span ${span}></span></div>
        <div class="small" style="margin-top:4px;">${note}</div>
      </div>`;
    }
    return `<div class="prog" data-catedit="${c.id}" style="cursor:pointer">
      <div class="head"><span class="name">${c.icon} ${c.name}</span><span class="vals">${fmt(used)} · sans limite</span></div>
      <div class="bar"><span style="width:${used>0?100:0}%;background:#dfe5ea"></span></div>
    </div>`;
  }).join("");
  $$("#catBudgetBars .prog[data-catedit]").forEach(el=>el.addEventListener("click",()=>openCategorySheet(el.dataset.catedit)));

  renderRecurrents();
}

/* ----- Dépenses récurrentes : liste + édition ----- */
function renderRecurrents(){
  const list = S.recurrents || [];
  const total = list.filter(r=>r.active).reduce((a,r)=>a+r.amount,0);
  $("#recurrentsList").innerHTML = list.length
    ? list.slice().sort((a,b)=>a.day-b.day).map(recRow).join("")
      + `<div class="statline" style="border-top:1px solid var(--line);border-bottom:0;margin-top:6px;">
           <span class="sl">Total engagé chaque mois</span><span class="sv">${fmtF(total)}</span>
         </div>`
    : `<div class="empty" style="padding:14px 10px;">Aucune dépense récurrente.</div>`;
  $$("#recurrentsList .recrow").forEach(el=>el.addEventListener("click",()=>openRecurrentSheet(el.dataset.rid)));
}
function recRow(r){
  const c = catById(r.catId);
  return `<div class="recrow${r.active?"":" off"}" data-rid="${r.id}">
    <div class="rav" style="background:${c.color}22;">${c.icon}</div>
    <div class="rmeta">
      <div class="rt">${escapeHtml(r.note || c.name)}</div>
      <div class="rs">Le ${r.day} de chaque mois${r.active?"":" · en pause"}</div>
    </div>
    <div class="rv">${fmt(r.amount)}</div>
  </div>`;
}
function openRecurrentSheet(id){
  const r = id ? (S.recurrents||[]).find(x=>x.id===id) : null;
  const isNew = !r;
  const jours = Array.from({length:28},(_,i)=>i+1);
  openSheet(`
    <h3>${isNew?"🔁 Nouvelle dépense récurrente":"🔁 Modifier la récurrente"}</h3>
    <div class="small">Elle sera enregistrée automatiquement chaque mois, à la date choisie. Le mois en cours n'est saisi qu'une fois le jour arrivé.</div>
    <label class="fld">Montant (FCFA)</label>
    <input id="rcAmt" inputmode="numeric" value="${r?fmt(r.amount):""}" placeholder="0" />
    <label class="fld">Catégorie</label>
    <select id="rcCat">${S.cats.map(c=>`<option value="${c.id}" ${r&&c.id===r.catId?"selected":""}>${c.icon} ${c.name}</option>`).join("")}</select>
    <label class="fld">Jour du mois</label>
    <select id="rcDay">${jours.map(j=>`<option value="${j}" ${((r?r.day:1)===j)?"selected":""}>Le ${j}</option>`).join("")}</select>
    <label class="fld">Nom (optionnel)</label>
    <input id="rcNote" value="${r?escapeHtml(r.note||""):""}" placeholder="ex : Loyer, Forfait Orange…" />
    <div style="height:16px;"></div>
    <button class="btn" id="rcSave">${isNew?"Créer la récurrente":"Enregistrer"}</button>
    ${isNew?"":`
      <div style="height:10px;"></div>
      <button class="btn ghost" id="rcToggle">${r.active?"⏸ Mettre en pause":"▶️ Réactiver"}</button>
      <div style="text-align:center;margin-top:12px;">
        <button class="danger-link" id="rcDel">🗑 Supprimer cette récurrente</button>
        <div class="small" style="margin-top:4px;">Les dépenses déjà enregistrées restent dans ton historique.</div>
      </div>`}
  `);
  $("#rcAmt").addEventListener("input",e=>{const d=e.target.value.replace(/\D/g,"");e.target.value=d?fmt(d):"";});
  if(isNew) setTimeout(()=>$("#rcAmt").focus(),120);

  $("#rcSave").addEventListener("click",()=>{
    const amt = Number($("#rcAmt").value.replace(/\D/g,""));
    if(!amt){ shake($("#rcAmt")); return; }
    const day = Number($("#rcDay").value);
    if(isNew){
      S.recurrents.push({id:uid(), amount:amt, catId:$("#rcCat").value, note:$("#rcNote").value.trim(),
                         day, since:nowYM(), active:true, skips:[]});
    }else{
      // le changement de montant/jour ne vaut que pour les mois à venir
      r.amount=amt; r.catId=$("#rcCat").value; r.note=$("#rcNote").value.trim(); r.day=day;
    }
    ensureRecurrents();
    save();closeSheet();toast(isNew?"Récurrente créée 🔁":"Récurrente modifiée ✅");renderAll();
  });

  if(!isNew){
    $("#rcToggle").addEventListener("click",()=>{
      r.active = !r.active;
      if(r.active) ensureRecurrents();
      save();closeSheet();toast(r.active?"Récurrente réactivée":"Récurrente en pause");renderAll();
    });
    $("#rcDel").addEventListener("click",()=>{
      S.recurrents = S.recurrents.filter(x=>x.id!==id);
      S.tx.forEach(t=>{ if(t.recId===id) delete t.recId; });  // les dépenses passées deviennent ordinaires
      save();closeSheet();toast("Récurrente supprimée");renderAll();
    });
  }
}
$("#addRecurrent").addEventListener("click",()=>openRecurrentSheet());

function progBar(name, used, budget, isSaving){
  const pct = budget>0 ? Math.round(used/budget*100) : 0;
  let cls = "";
  if(isSaving){ cls = pct>=100?"":(pct>=60?"":"warn"); /* épargne: plus c'est haut mieux c'est */ }
  else { cls = pct>=100?"bad":(pct>=80?"warn":""); }
  if(isSaving) cls = pct>=80?"":(pct>=40?"warn":"bad");
  return `<div class="prog">
    <div class="head"><span class="name">${name}</span><span class="vals">${fmt(used)} / ${fmt(budget)}</span></div>
    <div class="bar ${cls}"><span style="width:${Math.min(100,Math.max(2,pct))}%"></span></div>
  </div>`;
}

/* ============================================================
   ÉPARGNE / OBJECTIFS
============================================================ */
function renderSaving(){
  // épargne de sécurité (réserve libre)
  $("#reserveBig").textContent = fmtF(S.reserve||0);
  $("#reserveInfo").textContent = `Disponible à mettre de côté : ${fmtF(Math.max(0,soldeGlobal()))}`;

  // objectifs d'achat
  $("#goalsList").innerHTML = S.goals.length ? S.goals.map(g=>{
    const pct = g.target>0 ? Math.min(100,Math.round(g.saved/g.target*100)) : 0;
    return `<div class="card goal" data-id="${g.id}">
      <div class="gline"><span class="gname">${g.name}</span><span class="gpct">${pct}%</span></div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      <div class="gsub"><span>${fmtF(g.saved)} épargnés</span><span>Objectif&nbsp;: ${fmtF(g.target)}</span></div>
      ${g.due?`<div class="small" style="margin-top:6px;">🎯 Échéance : ${g.due}</div>`:""}
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="btn sm" data-act="add" style="flex:1;">+ Ajouter</button>
        <button class="btn sm ghost" data-act="edit" style="flex:1;">Modifier</button>
      </div>
    </div>`;
  }).join("") : `<div class="empty">Aucun objectif d'achat. Ajoute-en un 🎯</div>`;

  $$("#goalsList .goal").forEach(card=>{
    const id=card.dataset.id;
    card.querySelector('[data-act="add"]').addEventListener("click",()=>openAddToGoal(id));
    card.querySelector('[data-act="edit"]').addEventListener("click",()=>openEditGoal(id));
  });
}
$("#addGoal").addEventListener("click",()=>openEditGoal(null));

/* ----- Épargne de sécurité : réserve libre (ajouter / retirer) ----- */
function openReserve(sense){
  const isAdd = sense==="add";
  const dispo = soldeGlobal();
  openSheet(`
    <h3>${isAdd?"＋ Ajouter à la réserve":"－ Retirer de la réserve"}</h3>
    <div class="small">${isAdd
      ? `Argent disponible : <b>${fmtF(dispo)}</b>. Le montant sera mis à l'abri (retiré du disponible).`
      : `Réserve actuelle : <b>${fmtF(S.reserve||0)}</b>. Le montant retiré revient dans ton disponible.`}</div>
    <label class="fld">Montant (FCFA)</label>
    <input id="rsAmt" inputmode="numeric" placeholder="0" />
    <div style="height:14px;"></div>
    <button class="btn" id="rsSave">${isAdd?"Mettre de côté":"Retirer"}</button>
  `);
  $("#rsAmt").addEventListener("input",e=>{const d=e.target.value.replace(/\D/g,"");e.target.value=d?fmt(d):"";});
  setTimeout(()=>$("#rsAmt").focus(),120);
  $("#rsSave").addEventListener("click",()=>{
    let v=Number($("#rsAmt").value.replace(/\D/g,""));
    if(!v){shake($("#rsAmt"));return;}
    if(isAdd){
      S.reserve=(S.reserve||0)+v;
      S.savings.push({id:uid(), target:"reserve", amount:v, date:todayISO()});
      toast(v>dispo?"Mis de côté — solde global négatif ⚠️":"Mis en sécurité 🛡️");
    } else {
      v=Math.min(v, S.reserve||0);
      S.reserve=(S.reserve||0)-v;
      S.savings.push({id:uid(), target:"reserve", amount:-v, date:todayISO()});
      toast("Retiré de la réserve");
    }
    save();closeSheet();renderAll();
  });
}
$("#reserveAdd").addEventListener("click",()=>openReserve("add"));
$("#reserveSub").addEventListener("click",()=>openReserve("sub"));

/* ============================================================
   ÉVÉNEMENTS
   Planifier les événements auxquels on veut participer (date, lieu, coût prévu).
   « Payer » crée une vraie dépense portant eventId : l'événement est alors payé.
   Supprimer cette dépense le remet « à payer » ; supprimer l'événement garde la dépense.
============================================================ */
const WEEKDAYS = ["dim.","lun.","mar.","mer.","jeu.","ven.","sam."];
function eventPaidTx(e){ return S.tx.find(t=>t.eventId===e.id); }
function daysUntil(dstr){
  const [y,m,d] = dstr.split("-").map(Number);
  const t = new Date(); t.setHours(0,0,0,0);
  return Math.round((new Date(y,m-1,d) - t) / 86400000);
}
function renderEvents(){
  const evs = S.events || [];
  const upcoming = evs.filter(e=>daysUntil(e.date)>=0).sort((a,b)=>(a.date+(a.time||"")).localeCompare(b.date+(b.time||"")));
  const past     = evs.filter(e=>daysUntil(e.date)<0).sort((a,b)=>b.date.localeCompare(a.date));
  const planned  = upcoming.filter(e=>e.status!=="annule");
  $("#evCount").textContent  = planned.length;
  $("#evBudget").textContent = fmt(planned.filter(e=>!eventPaidTx(e)).reduce((a,e)=>a+e.cost,0));
  $("#evSpent").textContent  = fmt(txOfMonth(nowYM()).filter(t=>t.eventId).reduce((a,t)=>a+t.amount,0));
  const next = planned[0];
  $("#eventsSub").textContent = next
    ? `Prochain : ${next.name} · ${countdownLabel(daysUntil(next.date))}`
    : "Planifie ceux auxquels tu veux participer";
  $("#eventsUpcoming").innerHTML = upcoming.length ? upcoming.map(eventCard).join("")
    : `<div class="empty">Aucun événement prévu. Planifie-en un 🎟️</div>`;
  $("#eventsPast").innerHTML = past.length ? past.map(eventCard).join("")
    : `<div class="empty">Aucun événement passé.</div>`;
  $$("#screen-events .event").forEach(card=>{
    const id = card.dataset.id;
    const btn = act=>card.querySelector(`[data-act="${act}"]`);
    if(btn("edit")) btn("edit").addEventListener("click",()=>openEventSheet(id));
    if(btn("pay"))  btn("pay").addEventListener("click",()=>openPayEvent(id));
    if(btn("unpay")) btn("unpay").addEventListener("click",()=>{
      S.tx = S.tx.filter(t=>t.eventId!==id);
      save();toast("Paiement annulé — dépense retirée");renderAll();
    });
  });
}
function countdownLabel(n){
  if(n===0) return "aujourd'hui";
  if(n===1) return "demain";
  if(n>1)   return `dans ${n} jours`;
  return n===-1 ? "hier" : `il y a ${-n} jours`;
}
function eventCard(e){
  const n = daysUntil(e.date);
  const [y,m,d] = e.date.split("-").map(Number);
  const dt = new Date(y,m-1,d);
  const paid = eventPaidTx(e);
  const cancelled = e.status==="annule";
  let badge;
  if(cancelled)   badge = `<span class="badge off">Annulé</span>`;
  else if(n<0)    badge = `<span class="badge">Terminé</span>`;
  else if(n<=7)   badge = `<span class="badge soon">${countdownLabel(n)}</span>`;
  else            badge = `<span class="badge">${countdownLabel(n)}</span>`;
  const costLine = paid
    ? `<span class="badge ok">Payé ${fmt(paid.amount)} FCFA ✓</span>`
    : (e.cost ? `<span class="evcost">Coût prévu : <b>${fmt(e.cost)} FCFA</b></span>` : `<span class="evcost">Gratuit / coût non défini</span>`);
  return `<div class="card event${cancelled?" cancelled":""}" data-id="${e.id}">
    <div class="evtop">
      <div class="evdate"><div class="evd">${d}</div><div class="evm">${MONTHS[m-1].slice(0,4)}.</div></div>
      <div class="evmeta">
        <div class="evname">${escapeHtml(e.name)}</div>
        <div class="small">${WEEKDAYS[dt.getDay()]} ${d} ${MONTHS[m-1]} ${y}${e.time?` · ${e.time}`:""}</div>
        ${e.place?`<div class="small">📍 ${escapeHtml(e.place)}</div>`:""}
      </div>
      ${badge}
    </div>
    ${e.note?`<div class="small" style="margin-top:8px;">${escapeHtml(e.note)}</div>`:""}
    <div class="debt-actions">
      ${costLine}
      <span style="flex:1"></span>
      ${cancelled ? "" : (paid ? `<button class="linkbtn" data-act="unpay">Annuler le paiement</button>`
                               : `<button class="btn sm" data-act="pay">Payer</button>`)}
      <button class="linkbtn" data-act="edit">Modifier</button>
    </div>
  </div>`;
}
function openEventSheet(id){
  const e = id ? S.events.find(x=>x.id===id) : null;
  const isNew = !e;
  openSheet(`
    <h3>${isNew?"🎟️ Planifier un événement":"🎟️ Modifier l'événement"}</h3>
    <label class="fld">Nom de l'événement</label>
    <input id="evName" value="${e?escapeHtml(e.name):""}" placeholder="ex : Concert, mariage d'Awa, conférence…" />
    <div style="display:flex;gap:10px;">
      <div style="flex:1;"><label class="fld">Date</label><input id="evDate" type="date" value="${e?e.date:todayDate()}" /></div>
      <div style="flex:1;"><label class="fld">Heure (optionnel)</label><input id="evTime" type="time" value="${e?e.time||"":""}" /></div>
    </div>
    <label class="fld">Lieu (optionnel)</label>
    <input id="evPlace" value="${e?escapeHtml(e.place||""):""}" placeholder="ex : Palais des congrès" />
    <label class="fld">Coût prévu (FCFA, optionnel)</label>
    <input id="evCost" inputmode="numeric" value="${e&&e.cost?fmt(e.cost):""}" placeholder="billet, tenue, transport…" />
    <label class="fld">Note (optionnel)</label>
    <input id="evNote" value="${e?escapeHtml(e.note||""):""}" placeholder="ex : y aller avec Koffi" />
    ${isNew?"":`
      <label class="fld">Statut</label>
      <div class="seg" id="evStatus">
        <button type="button" data-s="prevu" class="${e.status!=="annule"?"on":""}">Je participe</button>
        <button type="button" data-s="annule" class="${e.status==="annule"?"on":""}">Annulé</button>
      </div>`}
    <div style="height:14px;"></div>
    <button class="btn" id="evSave">${isNew?"Planifier":"Enregistrer"}</button>
    ${isNew?"":`<div style="text-align:center;margin-top:12px;">
      <button class="danger-link" id="evDel">🗑 Supprimer l'événement</button>
      ${eventPaidTx(e)?`<div class="small" style="margin-top:4px;">La dépense déjà payée reste dans ton historique.</div>`:""}
    </div>`}
  `);
  let status = e ? e.status : "prevu";
  $$("#evStatus button").forEach(b=>b.addEventListener("click",()=>{ status=b.dataset.s; $$("#evStatus button").forEach(x=>x.classList.toggle("on",x===b)); }));
  $("#evCost").addEventListener("input",ev=>{const d=ev.target.value.replace(/\D/g,"");ev.target.value=d?fmt(d):"";});
  if(isNew) setTimeout(()=>$("#evName").focus(),120);
  $("#evSave").addEventListener("click",()=>{
    const name = $("#evName").value.trim();
    if(!name){ shake($("#evName")); return; }
    const date = $("#evDate").value;
    if(!date){ shake($("#evDate")); return; }
    const data = {name, date, time:$("#evTime").value||"", place:$("#evPlace").value.trim(),
                  cost:Number($("#evCost").value.replace(/\D/g,""))||0, note:$("#evNote").value.trim(), status};
    if(isNew) S.events.push({id:uid(), ...data});
    else Object.assign(e, data);
    save();closeSheet();toast(isNew?"Événement planifié 🎟️":"Événement modifié ✅");renderAll();
  });
  if(!isNew) $("#evDel").addEventListener("click",()=>{
    S.tx.forEach(t=>{ if(t.eventId===id) delete t.eventId; });  // la dépense payée devient ordinaire
    S.events = S.events.filter(x=>x.id!==id);
    save();closeSheet();toast("Événement supprimé");renderAll();
  });
}
// Payer l'événement : crée une dépense réelle reliée par eventId
function openPayEvent(id){
  const e = S.events.find(x=>x.id===id); if(!e) return;
  const defCat = S.cats.some(c=>c.id==="loisirs") ? "loisirs" : S.cats[0].id;
  openSheet(`
    <h3>💳 Payer « ${escapeHtml(e.name)} »</h3>
    <div class="small">Une dépense sera enregistrée dans ton historique et déduite de ton argent disponible (${fmtF(soldeGlobal())}).</div>
    <label class="fld">Montant payé (FCFA)</label>
    <input id="epAmt" inputmode="numeric" value="${e.cost?fmt(e.cost):""}" placeholder="0" />
    <label class="fld">Catégorie</label>
    <select id="epCat">${S.cats.map(c=>`<option value="${c.id}" ${c.id===defCat?"selected":""}>${c.icon} ${c.name}</option>`).join("")}</select>
    <label class="fld">Date du paiement</label>
    <input id="epDate" type="date" value="${todayDate()}" />
    <div style="height:14px;"></div>
    <button class="btn" id="epSave">Enregistrer la dépense</button>
  `);
  $("#epAmt").addEventListener("input",ev=>{const d=ev.target.value.replace(/\D/g,"");ev.target.value=d?fmt(d):"";});
  setTimeout(()=>$("#epAmt").focus(),120);
  $("#epSave").addEventListener("click",()=>{
    const amt = Number($("#epAmt").value.replace(/\D/g,""));
    if(!amt){ shake($("#epAmt")); return; }
    S.tx.push({id:uid(), amount:amt, catId:$("#epCat").value, note:"🎟️ "+e.name, date:dateFromInput($("#epDate").value), eventId:e.id});
    save();closeSheet();toast("Événement payé — dépense enregistrée");renderAll();
  });
}
$("#addEvent").addEventListener("click",()=>openEventSheet());

/* ============================================================
   DETTES & CRÉANCES
   - dette réglée  -> crée une DÉPENSE réelle (argent sorti)
   - créance reçue -> crée un REVENU réel (argent entré)
   La ligne de dette n'est qu'un suivi : la supprimer ne touche pas au solde.
   Pour annuler le mouvement d'argent, utiliser « Annuler » (le règlement est défait).
============================================================ */
// crée le mouvement d'argent correspondant au règlement
function settleDebt(d){
  d.settled = true;
  d.settledDate = todayISO();
  if(d.type==="dette"){
    if(!S.cats.some(c=>c.id===DEBT_CAT_ID)) S.cats.push({...DEBT_CAT});
    S.tx.push({id:uid(), amount:d.amount, catId:DEBT_CAT_ID, note:debtLabel(d), date:d.settledDate, debtId:d.id});
  }else{
    S.income.push({id:uid(), amount:d.amount, note:debtLabel(d), date:d.settledDate, debtId:d.id});
  }
}
// défait le règlement : le mouvement d'argent est retiré
function unsettleDebt(d){
  S.tx     = S.tx.filter(t=>t.debtId!==d.id);
  S.income = S.income.filter(i=>i.debtId!==d.id);
  d.settled = false; d.settledDate = "";
}
function renderDebts(){
  const dettesDue   = S.debts.filter(d=>d.type==="dette"   && !d.settled).reduce((a,d)=>a+d.amount,0);
  const creancesDue = S.debts.filter(d=>d.type==="creance" && !d.settled).reduce((a,d)=>a+d.amount,0);
  // carte d'accueil
  $("#dettesDue").textContent   = fmt(dettesDue);
  $("#creancesDue").textContent = fmt(creancesDue);
  // écran dédié
  $("#dettesTotal").textContent   = fmt(dettesDue);
  $("#creancesTotal").textContent = fmt(creancesDue);

  const order = (a,b)=> (a.settled?1:0)-(b.settled?1:0) || b.date.localeCompare(a.date);
  const dettes   = S.debts.filter(d=>d.type==="dette").sort(order);
  const creances = S.debts.filter(d=>d.type==="creance").sort(order);
  $("#dettesList").innerHTML   = dettes.length   ? dettes.map(debtRow).join("")   : `<div class="empty">Aucune dette. 🎉</div>`;
  $("#creancesList").innerHTML = creances.length ? creances.map(debtRow).join("") : `<div class="empty">Personne ne te doit d'argent.</div>`;
  bindDebtRows();
}
function debtRow(d){
  const isDette = d.type==="dette";
  const action = isDette ? "Marquer payé" : "Marquer reçu";
  const doneLbl = isDette ? "Payé ✓" : "Reçu ✓";
  return `<div class="debt${d.settled?' done':''}" data-id="${d.id}">
    <div class="debt-top">
      <span class="debt-who">${escapeHtml(d.person||"—")}</span>
      <span class="debt-amt">${fmt(d.amount)} FCFA</span>
    </div>
    ${d.note?`<div class="small">${escapeHtml(d.note)}</div>`:""}
    <div class="debt-actions">
      ${d.settled
        ? `<span class="badge ok">${doneLbl}</span><button class="linkbtn" data-act="undo">Annuler</button>`
        : `<button class="btn sm" data-act="settle">${action}</button>`}
      <button class="linkbtn danger" data-act="del">Supprimer</button>
    </div>
  </div>`;
}
function bindDebtRows(){
  $$("#screen-debts .debt").forEach(row=>{
    const id=row.dataset.id;
    const d=S.debts.find(x=>x.id===id); if(!d) return;
    const btn=(act)=>row.querySelector(`[data-act="${act}"]`);
    if(btn("settle")) btn("settle").addEventListener("click",()=>{
      settleDebt(d); save();
      toast(d.type==="dette"?"Dette payée — dépense enregistrée":"Créance reçue — revenu enregistré");
      renderAll();
    });
    if(btn("undo")) btn("undo").addEventListener("click",()=>{
      unsettleDebt(d); save();
      toast(d.type==="dette"?"Règlement annulé — dépense retirée":"Règlement annulé — revenu retiré");
      renderAll();
    });
    if(btn("del")) btn("del").addEventListener("click",()=>{
      if(d.settled) confirmDeleteSettled(d); else { S.debts=S.debts.filter(x=>x.id!==id); save(); toast("Supprimé"); renderAll(); }
    });
  });
}
// Supprimer une ligne DÉJÀ RÉGLÉE : on demande quoi faire du mouvement d'argent,
// pour qu'aucune suppression ne modifie le solde par surprise.
function confirmDeleteSettled(d){
  const isDette = d.type==="dette";
  const mvt = isDette ? "la dépense" : "le revenu";
  openSheet(`
    <h3>🗑 Supprimer cette ligne</h3>
    <div class="small">${escapeHtml(d.person||"—")} · <b>${fmt(d.amount)} FCFA</b> — déjà ${isDette?"payée":"reçue"}.<br>
      Le règlement a créé ${mvt} correspondant${isDette?"e":""} dans ton historique.</div>
    <div style="height:14px;"></div>
    <button class="btn" id="delKeep">Supprimer le suivi, garder ${mvt}</button>
    <div class="small" style="margin-top:6px;">Ton argent global ne bouge pas.</div>
    <div style="height:16px;"></div>
    <button class="btn ghost" id="delBoth">Supprimer aussi ${mvt}</button>
    <div class="small" style="margin-top:6px;">Comme si le règlement n'avait jamais eu lieu : ton solde ${isDette?"remontera":"baissera"} de ${fmt(d.amount)} FCFA.</div>
    <div style="height:14px;"></div>
    <div style="text-align:center;"><button class="linkbtn" id="delCancel">Annuler</button></div>
  `);
  $("#delKeep").addEventListener("click",()=>{
    // le mouvement reste, mais devient une ligne ordinaire (plus de lien)
    S.tx.forEach(t=>{ if(t.debtId===d.id) delete t.debtId; });
    S.income.forEach(i=>{ if(i.debtId===d.id) delete i.debtId; });
    S.debts=S.debts.filter(x=>x.id!==d.id);
    save();closeSheet();toast("Suivi supprimé — solde inchangé");renderAll();
  });
  $("#delBoth").addEventListener("click",()=>{
    unsettleDebt(d);
    S.debts=S.debts.filter(x=>x.id!==d.id);
    save();closeSheet();toast("Ligne et mouvement supprimés");renderAll();
  });
  $("#delCancel").addEventListener("click",closeSheet);
}
function openAddDebt(type){
  const isDette = type==="dette";
  openSheet(`
    <h3>${isDette?"＋ Nouvelle dette (je dois)":"＋ Nouvelle créance (on me doit)"}</h3>
    <div class="small">${isDette
      ? "Quand tu la marqueras payée, une dépense du même montant sera enregistrée dans ton historique (l'argent sort du solde)."
      : "Quand tu la marqueras reçue, un revenu du même montant sera enregistré dans ton historique (l'argent entre dans le solde)."}</div>
    <label class="fld">${isDette?"À qui dois-tu ?":"Qui te doit ?"}</label>
    <input id="dPerson" placeholder="ex : Awa, boutique, banque…" />
    <label class="fld">Montant (FCFA)</label>
    <input id="dAmt" inputmode="numeric" placeholder="0" />
    <label class="fld">Note (optionnel)</label>
    <input id="dNote" placeholder="ex : prêt, achat à crédit…" />
    <div style="height:14px;"></div>
    <button class="btn" id="dSave">Ajouter</button>
  `);
  $("#dAmt").addEventListener("input",e=>{const x=e.target.value.replace(/\D/g,"");e.target.value=x?fmt(x):"";});
  setTimeout(()=>$("#dPerson").focus(),120);
  $("#dSave").addEventListener("click",()=>{
    const amt=Number($("#dAmt").value.replace(/\D/g,""));
    if(!amt){shake($("#dAmt"));return;}
    S.debts.push({id:uid(), type, person:$("#dPerson").value.trim()||"—", amount:amt, note:$("#dNote").value.trim(), date:todayISO(), settled:false, settledDate:""});
    save();closeSheet();toast(isDette?"Dette ajoutée":"Créance ajoutée");renderAll();
  });
}
$("#debtsCard").addEventListener("click",()=>show("debts"));
$("#debtsBack").addEventListener("click",()=>show("home"));
$("#addDette").addEventListener("click",()=>openAddDebt("dette"));
$("#addCreance").addEventListener("click",()=>openAddDebt("creance"));

/* ============================================================
   HISTORIQUE & ANALYSE
============================================================ */
let histM = 0; // 0 = ce mois, 1 = mois dernier
$$("#monthSeg button").forEach(b=>{
  b.addEventListener("click",()=>{
    histM = Number(b.dataset.m);
    $$("#monthSeg button").forEach(x=>x.classList.toggle("on", x===b));
    renderHistory();
  });
});
function renderHistory(){
  const cur = nowYM(), prev = prevYM();
  const yms = histM===0?cur:prev;
  $("#histMonthLabel").textContent = monthName(yms);
  const txs = txOfMonth(yms);

  // historique des revenus du mois (salaire + ponctuels)
  const incs = S.income.filter(i=>i.date.slice(0,7)===yms).sort((a,b)=>b.date.localeCompare(a.date));
  $("#histIncomeTotal").textContent = fmt(incs.reduce((a,i)=>a+i.amount,0)) + " FCFA";
  $("#incomeList").innerHTML = incs.length ? incs.map(incomeRow).join("") : `<div class="empty">Aucun revenu ce mois.</div>`;
  bindIncomeRows("#incomeList");

  // répartition
  const byCat = {};
  txs.forEach(t=>{ byCat[t.catId]=(byCat[t.catId]||0)+t.amount; });
  const entries = Object.entries(byCat).sort((a,b)=>b[1]-a[1]);
  const total = txs.reduce((a,t)=>a+t.amount,0);
  drawDonut(entries);
  $("#donutLegend").innerHTML = entries.length ? entries.map(([id,v])=>{
    const c=catById(id); const pct=total?Math.round(v/total*100):0;
    return `<div class="li"><span class="dot" style="background:${c.color}"></span><span class="ln">${c.name}</span><span class="lv">${fmt(v)} · ${pct}%</span></div>`;
  }).join("") : `<div class="small">Aucune dépense ce mois.</div>`;

  // dépenses par jour & catégorie
  const byDay = {};
  txs.forEach(t=>{ const day=t.date.slice(0,10); (byDay[day]=byDay[day]||[]).push(t); });
  const days = Object.keys(byDay).sort().reverse();
  $("#dailyBreakdown").innerHTML = days.length ? days.map(day=>{
    const dayTxs = byDay[day];
    const dayTotal = dayTxs.reduce((a,t)=>a+t.amount,0);
    const byC = {};
    dayTxs.forEach(t=>{ byC[t.catId]=(byC[t.catId]||0)+t.amount; });
    const d = new Date(day+"T00:00:00");
    const label = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    const rows = Object.entries(byC).sort((a,b)=>b[1]-a[1]).map(([cid,v])=>{
      const c=catById(cid);
      return `<div class="dcat"><span class="dcat-n">${c.icon} ${c.name}</span><span class="dcat-v">${fmt(v)} FCFA</span></div>`;
    }).join("");
    return `<div class="dayblock">
      <div class="dayhead"><span class="dayname">${label}</span><span class="daytot">${fmt(dayTotal)} FCFA</span></div>
      ${rows}
    </div>`;
  }).join("") : `<div class="empty">Aucune dépense ce mois.</div>`;

  // comparaison
  const curT = totalOfMonth(cur), prevT = totalOfMonth(prev);
  $("#cmpPrev").textContent = fmt(prevT);
  $("#cmpCur").textContent = fmt(curT);
  const d = curT - prevT;
  const de = $("#cmpDelta");
  if(prevT===0 && curT===0){ de.textContent=""; }
  else if(d>0){ de.className="delta righted up"; de.textContent=`▲ +${fmt(d)} FCFA vs mois dernier`; }
  else if(d<0){ de.className="delta righted down"; de.textContent=`▼ ${fmt(d)} FCFA vs mois dernier`; }
  else { de.className="delta righted"; de.textContent="= identique au mois dernier"; }

  // liste complète
  const list=[...txs].sort((a,b)=>b.date.localeCompare(a.date));
  $("#fullList").innerHTML = list.length ? list.map(txRow).join("") : `<div class="empty">Aucune dépense ce mois.</div>`;
  bindTxRows("#fullList");
}
function drawDonut(entries){
  const cv=$("#donut"), ctx=cv.getContext("2d");
  const W=cv.width, cx=W/2, cy=W/2, r=W/2-6, ir=r*0.6;
  ctx.clearRect(0,0,W,W);
  const total=entries.reduce((a,e)=>a+e[1],0);
  if(!total){
    ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fillStyle="#eef1f4";ctx.fill();
    ctx.beginPath();ctx.arc(cx,cy,ir,0,Math.PI*2);ctx.fillStyle="#fff";ctx.fill();
    return;
  }
  let a=-Math.PI/2;
  entries.forEach(([id,v])=>{
    const slice=v/total*Math.PI*2;
    ctx.beginPath();ctx.moveTo(cx,cy);ctx.arc(cx,cy,r,a,a+slice);ctx.closePath();
    ctx.fillStyle=catById(id).color;ctx.fill();
    a+=slice;
  });
  ctx.beginPath();ctx.arc(cx,cy,ir,0,Math.PI*2);ctx.fillStyle="#fff";ctx.fill();
  ctx.fillStyle="#16202a";ctx.font="bold 15px sans-serif";ctx.textAlign="center";ctx.textBaseline="middle";
  ctx.fillText(fmt(total),cx,cy-7);
  ctx.fillStyle="#7a8a99";ctx.font="10px sans-serif";ctx.fillText("FCFA",cx,cy+9);
}

/* ============================================================
   STATISTIQUES (icône 📈 en haut à droite)
   Courbe d'évolution des dépenses + chiffres utiles en dessous.
============================================================ */
let statsPeriod = "6";   // "6" | "12" mois, ou "30j" = 30 derniers jours
$$("#statsSeg button").forEach(b=>{
  b.addEventListener("click",()=>{
    statsPeriod = b.dataset.p;
    $$("#statsSeg button").forEach(x=>x.classList.toggle("on", x===b));
    renderStats();
  });
});
$("#statsBtn").addEventListener("click",()=>show("stats"));
$("#statsBack").addEventListener("click",()=>show("home"));

// n derniers mois, du plus ancien au plus récent : ["2026-03", …, "2026-08"]
function lastMonths(n){
  const out=[], d=new Date(); d.setDate(1);
  for(let i=n-1;i>=0;i--){ const x=new Date(d); x.setMonth(d.getMonth()-i); out.push(ym(x)); }
  return out;
}
// n derniers jours, du plus ancien au plus récent : ["2026-07-06", …]
function lastDays(n){
  const out=[], d=new Date();
  for(let i=n-1;i>=0;i--){
    const x=new Date(d); x.setDate(d.getDate()-i);
    out.push(x.getFullYear()+"-"+String(x.getMonth()+1).padStart(2,"0")+"-"+String(x.getDate()).padStart(2,"0"));
  }
  return out;
}
// série affichée par la courbe, selon la période choisie
function statsSeries(){
  if(statsPeriod==="30j"){
    const days = lastDays(30);
    const exp = days.map(day=>S.tx.filter(t=>t.date.slice(0,10)===day).reduce((a,t)=>a+t.amount,0));
    const inc = days.map(day=>S.income.filter(i=>i.date.slice(0,10)===day).reduce((a,i)=>a+i.amount,0));
    // 1 étiquette sur 5 pour ne pas surcharger l'axe
    const labels = days.map((d,i)=> (i%5===0||i===days.length-1) ? d.slice(8) : "");
    return {keys:days, labels, exp, inc, unit:"jour"};
  }
  const months = lastMonths(Number(statsPeriod));
  const exp = months.map(totalOfMonth);
  const inc = months.map(incomeOfMonth);
  const step = months.length>6 ? 2 : 1;   // sur 12 mois : 1 étiquette sur 2
  const labels = months.map((m,i)=> (i%step===0||i===months.length-1) ? MONTHS[Number(m.slice(5))-1].slice(0,3) : "");
  return {keys:months, labels, exp, inc, unit:"mois"};
}

function renderStats(){
  const s = statsSeries();
  const nExp = s.exp.reduce((a,v)=>a+v,0);
  $("#statsPeriodLbl").textContent = statsPeriod==="30j" ? "30 derniers jours" : statsPeriod+" derniers mois";
  $("#statsTopLbl").textContent    = $("#statsPeriodLbl").textContent;
  $("#statsSub").textContent = nExp ? `${fmtF(nExp)} dépensés sur la période` : "Évolution de tes dépenses";
  drawLineChart(s);
  $("#chartEmpty").innerHTML = nExp ? "" : `<div class="empty">Aucune dépense sur cette période.</div>`;

  /* ---- chiffres clés ---- */
  const cur = nowYM();
  const active = s.exp.filter(v=>v>0).length;              // périodes réellement utilisées
  const moy    = active ? Math.round(nExp/active) : 0;
  const today  = new Date();
  const jours  = today.getDate();
  const dsMois = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();
  const depMois= totalOfMonth(cur);
  const parJour= Math.round(depMois/jours);
  const projec = Math.round(parJour*dsMois);
  const revPer = s.inc.reduce((a,v)=>a+v,0);
  const tauxEp = revPer ? Math.round((revPer-nExp)/revPer*100) : 0;
  const kpi=(k,v,h)=>`<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div>${h?`<div class="h">${h}</div>`:""}</div>`;
  $("#statsKpis").innerHTML =
    kpi(`Moyenne par ${s.unit}`, fmt(moy), active?`sur ${active} ${s.unit}${active>1?"s":""} avec dépenses`:"—") +
    kpi("Dépense moyenne / jour", fmt(parJour), "ce mois-ci") +
    kpi("Projection fin de mois", fmt(projec), `au rythme actuel (${dsMois} j)`) +
    kpi("Part non dépensée", (revPer?tauxEp+" %":"—"), "des revenus de la période");

  /* ---- top catégories sur la période ---- */
  const inRange = t => statsPeriod==="30j" ? s.keys.includes(t.date.slice(0,10)) : s.keys.includes(txYM(t));
  const txs = S.tx.filter(inRange);
  const byCat = {};
  txs.forEach(t=>{ byCat[t.catId]=(byCat[t.catId]||0)+t.amount; });
  const tops = Object.entries(byCat).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const maxCat = tops.length ? tops[0][1] : 1;
  $("#statsTopCats").innerHTML = tops.length ? tops.map(([id,v])=>{
    const c = catById(id), pct = nExp?Math.round(v/nExp*100):0;
    return `<div class="catstat">
      <div class="ch"><span class="cn">${c.icon} ${c.name}</span><span class="cv">${fmt(v)} · ${pct}%</span></div>
      <div class="bar"><span style="width:${Math.round(v/maxCat*100)}%;background:${c.color}"></span></div>
    </div>`;
  }).join("") : `<div class="empty">Rien à afficher.</div>`;

  /* ---- habitudes ---- */
  const JOURS = ["Dimanche","Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi"];
  const byDow = [0,0,0,0,0,0,0];
  txs.forEach(t=>{ byDow[new Date(t.date).getDay()] += t.amount; });
  const bestDow = byDow.indexOf(Math.max(...byDow));
  const biggest = txs.slice().sort((a,b)=>b.amount-a.amount)[0];
  const iMax = s.exp.indexOf(Math.max(...s.exp));
  const posOnly = s.exp.map((v,i)=>[v,i]).filter(([v])=>v>0);
  const iMin = posOnly.length ? posOnly.sort((a,b)=>a[0]-b[0])[0][1] : -1;
  const nom = i => i<0 ? "—" : (s.unit==="mois" ? monthName(s.keys[i]) : new Date(s.keys[i]+"T00:00:00").toLocaleDateString("fr-FR"));
  const line=(k,v)=>`<div class="statline"><span class="sl">${k}</span><span class="sv">${v}</span></div>`;
  $("#statsHabits").innerHTML = txs.length ? (
    line("Jour où tu dépenses le plus", byDow[bestDow] ? `${JOURS[bestDow]} · ${fmt(byDow[bestDow])}` : "—") +
    line("Plus grosse dépense", `${catById(biggest.catId).icon} ${fmt(biggest.amount)}`) +
    line(`${s.unit==="mois"?"Mois":"Jour"} le plus cher`, `${nom(iMax)} · ${fmt(s.exp[iMax])}`) +
    line(`${s.unit==="mois"?"Mois":"Jour"} le moins cher`, iMin<0?"—":`${nom(iMin)} · ${fmt(s.exp[iMin])}`) +
    line("Nombre de dépenses", txs.length) +
    line("Ticket moyen", fmt(Math.round(nExp/txs.length)))
  ) : `<div class="empty">Pas encore assez de dépenses pour dégager des habitudes.</div>`;

  /* ---- détail période par période (du plus récent au plus ancien) ---- */
  const rows = s.keys.map((k,i)=>({k, i})).reverse().filter(r=>s.exp[r.i]||s.inc[r.i]);
  $("#statsMonths").innerHTML = rows.length ? rows.map(({k,i})=>{
    const solde = s.inc[i]-s.exp[i];
    const label = s.unit==="mois" ? monthName(k) : new Date(k+"T00:00:00").toLocaleDateString("fr-FR");
    return `<div class="statline">
      <span class="sl" style="text-transform:capitalize;color:var(--ink);font-weight:700;">${label}</span>
      <span class="sv">
        <span style="color:var(--red)">−${fmt(s.exp[i])}</span>
        <span style="color:var(--muted);font-weight:600"> · </span>
        <span style="color:var(--green)">+${fmt(s.inc[i])}</span>
        <div class="h" style="font-size:11px;color:${solde<0?"var(--red)":"var(--muted)"};font-weight:700;">solde ${solde<0?"":"+"}${fmt(solde)}</div>
      </span>
    </div>`;
  }).join("") : `<div class="empty">Aucun mouvement sur cette période.</div>`;
}

/* Courbe : dépenses (rouge, remplie) + revenus (vert) — canvas natif, zéro librairie */
function drawLineChart(s){
  const cv = $("#lineChart"); if(!cv) return;
  const box = cv.parentElement.getBoundingClientRect();
  const W = Math.max(240, Math.round(box.width)), H = Math.round(box.height) || 190;
  const dpr = window.devicePixelRatio || 1;
  cv.width = W*dpr; cv.height = H*dpr;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);

  const padL=44, padR=10, padT=12, padB=22;
  const w = W-padL-padR, h = H-padT-padB;
  const n = s.exp.length;
  const max = Math.max(1, ...s.exp, ...s.inc);
  const x = i => padL + (n<=1 ? w/2 : i*w/(n-1));
  const y = v => padT + h - (v/max)*h;

  // grille + graduations
  ctx.strokeStyle="#eef1f4"; ctx.lineWidth=1;
  ctx.fillStyle="#7a8a99"; ctx.font="10px sans-serif"; ctx.textAlign="right"; ctx.textBaseline="middle";
  for(let g=0; g<=3; g++){
    const gy = padT + h - (g/3)*h;
    ctx.beginPath(); ctx.moveTo(padL,gy); ctx.lineTo(W-padR,gy); ctx.stroke();
    ctx.fillText(fmt(Math.round(max*g/3)), padL-6, gy);
  }
  // étiquettes de l'axe des abscisses
  ctx.textAlign="center"; ctx.textBaseline="top";
  s.labels.forEach((l,i)=>{ if(l) ctx.fillText(l, x(i), padT+h+6); });

  const trace = (vals, color, fill)=>{
    if(fill){
      const grad = ctx.createLinearGradient(0,padT,0,padT+h);
      grad.addColorStop(0, color+"33"); grad.addColorStop(1, color+"00");
      ctx.beginPath(); ctx.moveTo(x(0), padT+h);
      vals.forEach((v,i)=>ctx.lineTo(x(i), y(v)));
      ctx.lineTo(x(n-1), padT+h); ctx.closePath();
      ctx.fillStyle=grad; ctx.fill();
    }
    ctx.beginPath();
    vals.forEach((v,i)=>{ i?ctx.lineTo(x(i),y(v)):ctx.moveTo(x(i),y(v)); });
    ctx.strokeStyle=color; ctx.lineWidth=2.4; ctx.lineJoin="round"; ctx.lineCap="round"; ctx.stroke();
    // points (masqués quand la série est trop dense, ex. 30 jours)
    if(n<=13){
      vals.forEach((v,i)=>{
        ctx.beginPath(); ctx.arc(x(i),y(v),3.2,0,Math.PI*2);
        ctx.fillStyle="#fff"; ctx.fill();
        ctx.strokeStyle=color; ctx.lineWidth=2; ctx.stroke();
      });
    }
  };
  trace(s.inc, "#0e9f6e", false);
  trace(s.exp, "#ef4444", true);
}
// la courbe est dessinée en pixels : on la redessine si la largeur change
window.addEventListener("resize",()=>{
  if(S && $("#screen-stats").classList.contains("active")) drawLineChart(statsSeries());
});

/* ============================================================
   SHEETS (modales) : éditer tx, revenu, budget, objectifs
============================================================ */
function openSheet(html){
  $("#sheetBody").innerHTML = html;
  $("#sheet").style.display="block";
  $("#sheetBg").classList.add("show");
}
function closeSheet(){ $("#sheet").style.display="none"; $("#sheetBg").classList.remove("show"); }
$("#sheetBg").addEventListener("click",closeSheet);

function openTxSheet(id){
  const t=S.tx.find(x=>x.id===id); if(!t)return;
  const c=catById(t.catId);
  const linked = t.debtId ? S.debts.find(x=>x.id===t.debtId) : null;
  const rec    = t.recId  ? (S.recurrents||[]).find(x=>x.id===t.recId) : null;
  openSheet(`
    <h3>${c.icon} ${c.name}</h3>
    <div class="small">${new Date(t.date).toLocaleString("fr-FR")}</div>
    ${linked?`<div class="small">💳 Remboursement de la dette envers <b>${escapeHtml(linked.person||"—")}</b>. La supprimer remettra cette dette « à payer ».</div>`:""}
    ${t.eventId?`<div class="small">🎟️ Dépense liée à un événement. La supprimer remettra l'événement « à payer ».</div>`:""}
    ${rec?`<div class="small">🔁 Enregistrée automatiquement (<b>${escapeHtml(rec.note||c.name)}</b>). La modifier ne change que ce mois-ci ; la supprimer ne la fera pas revenir.</div>`:""}
    <label class="fld">Montant (FCFA)</label>
    <input id="edAmt" inputmode="numeric" value="${fmt(t.amount)}" />
    <label class="fld">Catégorie</label>
    <select id="edCat">${S.cats.map(cc=>`<option value="${cc.id}" ${cc.id===t.catId?"selected":""}>${cc.icon} ${cc.name}</option>`).join("")}</select>
    <label class="fld">Date</label>
    <input id="edDate" type="date" value="${t.date.slice(0,10)}" />
    <label class="fld">Note</label>
    <input id="edNote" value="${escapeHtml(t.note)}" />
    <div style="height:16px;"></div>
    <button class="btn" id="edSave">Enregistrer</button>
    <div style="text-align:center;margin-top:12px;"><button class="danger-link" id="edDel">🗑 Supprimer cette dépense</button></div>
  `);
  $("#edAmt").addEventListener("input",e=>{const d=e.target.value.replace(/\D/g,"");e.target.value=d?fmt(d):"";});
  $("#edSave").addEventListener("click",()=>{
    const amt=Number($("#edAmt").value.replace(/\D/g,""));
    if(!amt){shake($("#edAmt"));return;}
    t.amount=amt; t.catId=$("#edCat").value; t.note=$("#edNote").value.trim();
    const dv=$("#edDate").value;
    if(dv && dv!==t.date.slice(0,10)) t.date = dv+"T12:00:00.000Z"; // jour changé
    if(linked){ linked.amount=amt; linked.settledDate=t.date; } // garde la dette alignée
    save();closeSheet();toast("Modifié ✅");renderAll();
  });
  $("#edDel").addEventListener("click",()=>{
    if(linked){ linked.settled=false; linked.settledDate=""; } // la dette redevient à payer
    // dépense générée par une récurrente : on mémorise le mois pour ne pas la recréer
    if(rec && t.recMonth && !rec.skips.includes(t.recMonth)) rec.skips.push(t.recMonth);
    S.tx=S.tx.filter(x=>x.id!==id);save();closeSheet();
    toast(linked?"Remboursement annulé — dette à payer":"Supprimé");renderAll();
  });
}

/* ----- Revenus : ajout ponctuel + édition ----- */
function openAddIncome(){
  openSheet(`
    <h3>＋ Entrée d'argent</h3>
    <div class="small">Prime, vente, cadeau, salaire exceptionnel… Ça augmente ton argent disponible.</div>
    <label class="fld">Montant (FCFA)</label>
    <input id="inAmt" inputmode="numeric" placeholder="0" />
    <label class="fld">Note (optionnel)</label>
    <input id="inNote" placeholder="ex : prime, vente téléphone" />
    <div style="height:14px;"></div>
    <button class="btn" id="inSave">Ajouter le revenu</button>
  `);
  $("#inAmt").addEventListener("input",e=>{const d=e.target.value.replace(/\D/g,"");e.target.value=d?fmt(d):"";});
  setTimeout(()=>$("#inAmt").focus(),120);
  $("#inSave").addEventListener("click",()=>{
    const amt=Number($("#inAmt").value.replace(/\D/g,""));
    if(!amt){shake($("#inAmt"));return;}
    S.income.push({id:uid(), amount:amt, note:$("#inNote").value.trim()||"Revenu", date:todayISO()});
    save();closeSheet();toast("Revenu ajouté 💵");renderAll();
  });
}
function openIncomeSheet(id){
  const i=S.income.find(x=>x.id===id); if(!i)return;
  const linked = i.debtId ? S.debts.find(x=>x.id===i.debtId) : null;
  openSheet(`
    <h3>${linked?"🤝 Créance reçue":(i.auto?"💼 Salaire":"💵 Revenu")}</h3>
    <div class="small">${new Date(i.date).toLocaleDateString("fr-FR")}${i.auto?" · crédité automatiquement":""}</div>
    ${linked?`<div class="small">Remboursement reçu de <b>${escapeHtml(linked.person||"—")}</b>. Le supprimer remettra cette créance « en attente ».</div>`:""}
    <label class="fld">Montant (FCFA)</label>
    <input id="inEdAmt" inputmode="numeric" value="${fmt(i.amount)}" />
    <label class="fld">Note</label>
    <input id="inEdNote" value="${escapeHtml(i.note||"")}" />
    <div style="height:16px;"></div>
    <button class="btn" id="inEdSave">Enregistrer</button>
    <div style="text-align:center;margin-top:12px;"><button class="danger-link" id="inEdDel">🗑 Supprimer ce revenu</button></div>
  `);
  $("#inEdAmt").addEventListener("input",e=>{const d=e.target.value.replace(/\D/g,"");e.target.value=d?fmt(d):"";});
  $("#inEdSave").addEventListener("click",()=>{
    const amt=Number($("#inEdAmt").value.replace(/\D/g,""));
    if(!amt){shake($("#inEdAmt"));return;}
    i.amount=amt; i.note=$("#inEdNote").value.trim()||"Revenu";
    if(linked) linked.amount=amt; // garde la créance alignée
    save();closeSheet();toast("Modifié ✅");renderAll();
  });
  $("#inEdDel").addEventListener("click",()=>{
    if(linked){ linked.settled=false; linked.settledDate=""; } // la créance redevient en attente
    S.income=S.income.filter(x=>x.id!==id);save();closeSheet();
    toast(linked?"Encaissement annulé — créance en attente":"Supprimé");renderAll();
  });
}

/* ----- Ajuster l'argent global (bouton ✏️ en haut à droite) -----
   Quand une transaction a été mal saisie ou oubliée, on cale simplement l'argent
   global sur l'argent RÉEL. L'écart est mémorisé dans S.soldeAdjust : SEULE la ligne
   « Argent disponible (global) » change. Aucun revenu, aucune dépense, aucune ligne
   d'historique n'est créée ; les stats, catégories et totaux du mois sont intacts. */
function openAdjustSolde(){
  const cur = soldeGlobal();
  const adj = S.soldeAdjust || 0;
  openSheet(`
    <h3>✏️ Modifier l'argent global</h3>
    <div class="small">Indique l'argent que tu as <b>vraiment</b> (poche + mobile money + banque). Seule cette ligne change : ton historique, tes dépenses du mois et tes statistiques ne bougent pas.</div>
    <label class="fld">Argent réel disponible (FCFA)</label>
    <input id="adjAmt" inputmode="numeric" value="${cur>0?fmt(cur):""}" placeholder="0" />
    <div class="small" id="adjDiff" style="margin-top:8px;">&nbsp;</div>
    <div style="height:14px;"></div>
    <button class="btn" id="adjSave">Enregistrer</button>
    ${adj ? `<div style="text-align:center;margin-top:12px;">
      <div class="small">Correction actuellement appliquée : <b>${adj>0?"+":"−"}${fmtF(Math.abs(adj))}</b></div>
      <button class="linkbtn" id="adjReset">Revenir au montant calculé par l'app</button>
    </div>` : ""}
  `);
  const typed  = ()=> Number(($("#adjAmt").value||"").replace(/\D/g,""));
  const diffNow= ()=> typed() - cur;
  const refresh = ()=>{
    const d = diffNow(), el = $("#adjDiff");
    if(!d){ el.innerHTML = "Identique au montant actuel — rien ne changera."; el.style.color=""; return; }
    el.innerHTML = `Ton argent global passera de <b>${fmtF(cur)}</b> à <b>${fmtF(typed())}</b> (${d>0?"+":"−"}${fmt(Math.abs(d))}).`;
    el.style.color = d>0 ? "var(--green)" : "var(--red)";
  };
  $("#adjAmt").addEventListener("input",e=>{
    const x=e.target.value.replace(/\D/g,""); e.target.value=x?fmt(x):"";
    refresh();
  });
  refresh();
  setTimeout(()=>{ $("#adjAmt").focus(); $("#adjAmt").select(); },120);
  $("#adjSave").addEventListener("click",()=>{
    const d = diffNow();
    if(!d){ closeSheet(); toast("Aucun changement"); return; }
    S.soldeAdjust = adj + d;         // on décale le solde, sans toucher aux mouvements
    save();closeSheet();
    toast("Argent global mis à jour ✅");
    renderAll();
  });
  const rst = $("#adjReset");
  if(rst) rst.addEventListener("click",()=>{
    S.soldeAdjust = 0;
    save();closeSheet();toast("Correction annulée");renderAll();
  });
}
$("#editSolde").addEventListener("click", openAdjustSolde);

/* ----- Salaire mensuel : espace dédié ----- */
function applySalaire(newSal){
  S.salaireMensuel = newSal;
  // met à jour le salaire déjà crédité pour le mois courant, puis crédite les mois manquants
  const cur = nowYM();
  const curAuto = S.income.find(i=>i.auto && i.month===cur);
  if(curAuto) curAuto.amount = newSal;
  if(newSal>0 && !S.salaireDepuis) S.salaireDepuis = cur;
  ensureSalary();
}
$("#editSalaire").addEventListener("click",()=>{
  openSheet(`
    <h3>💼 Définir le salaire mensuel</h3>
    <div class="small">Ce montant est crédité automatiquement chaque mois sur ton argent disponible. Modifie-le dès que ton salaire change.</div>
    <label class="fld">Montant (FCFA)</label>
    <input id="salAmt" inputmode="numeric" value="${S.salaireMensuel?fmt(S.salaireMensuel):''}" placeholder="0" />
    <div style="height:14px;"></div>
    <button class="btn" id="salSave">Enregistrer</button>
  `);
  $("#salAmt").addEventListener("input",e=>{const d=e.target.value.replace(/\D/g,"");e.target.value=d?fmt(d):"";});
  setTimeout(()=>$("#salAmt").focus(),120);
  $("#salSave").addEventListener("click",()=>{
    applySalaire(Number($("#salAmt").value.replace(/\D/g,""))||0);
    save();closeSheet();toast("Salaire enregistré 💼");renderAll();
  });
});

/* ----- Limites par catégorie : l'utilisateur définit chaque plafond ----- */
$("#editLimits").addEventListener("click",()=>{
  openSheet(`
    <h3>Limites par dépense</h3>
    <div class="small">Fixe un plafond mensuel par catégorie. Laisse vide / 0 pour « sans limite ». La barre passe à l'orange à 80% puis au rouge au dépassement.</div>
    ${S.cats.map(c=>`
      <label class="fld">${c.icon} ${c.name} (FCFA)</label>
      <input class="limInput" data-cat="${c.id}" inputmode="numeric" value="${c.limit?fmt(c.limit):''}" placeholder="0 = sans limite" />
    `).join("")}
    <div style="height:14px;"></div>
    <button class="btn" id="limSave">Enregistrer les limites</button>
  `);
  $$(".limInput").forEach(inp=>inp.addEventListener("input",e=>{const d=e.target.value.replace(/\D/g,"");e.target.value=d?fmt(d):"";}));
  $("#limSave").addEventListener("click",()=>{
    $$(".limInput").forEach(inp=>{
      const c=S.cats.find(x=>x.id===inp.dataset.cat);
      if(c) c.limit = Number(inp.value.replace(/\D/g,"")) || 0;
    });
    save();closeSheet();toast("Limites enregistrées ✅");renderAll();
  });
});

/* ----- Règle 50/30/20 (pourcentages seuls) ----- */
$("#editBudget").addEventListener("click",()=>{
  openSheet(`
    <h3>Règle 50/30/20</h3>
    <div class="small">Comment répartir ton revenu mensuel entre besoins, loisirs et épargne.</div>
    <label class="fld">Besoins (%)</label>
    <input id="bBes" inputmode="numeric" value="${S.rule.besoins}" />
    <label class="fld">Loisirs (%)</label>
    <input id="bLoi" inputmode="numeric" value="${S.rule.loisirs}" />
    <label class="fld">Épargne (%)</label>
    <input id="bEpa" inputmode="numeric" value="${S.rule.epargne}" />
    <div class="small" id="bSum" style="margin-top:8px;"></div>
    <div style="height:14px;"></div>
    <button class="btn" id="bSave">Enregistrer</button>
  `);
  const sum=()=>{const t=(+$("#bBes").value||0)+(+$("#bLoi").value||0)+(+$("#bEpa").value||0);
    $("#bSum").textContent=`Total : ${t}%`+(t!==100?" — devrait faire 100%":" ✅"); $("#bSum").style.color=t!==100?"#ef4444":"#0e9f6e";};
  ["bBes","bLoi","bEpa"].forEach(id=>$("#"+id).addEventListener("input",sum)); sum();
  $("#bSave").addEventListener("click",()=>{
    S.rule={besoins:+$("#bBes").value||0,loisirs:+$("#bLoi").value||0,epargne:+$("#bEpa").value||0};
    save();closeSheet();toast("Règle mise à jour");renderAll();
  });
});

function openAddToGoal(id){
  const g=S.goals.find(x=>x.id===id);if(!g)return;
  const dispo = soldeGlobal();
  openSheet(`
    <h3>Mettre de côté pour « ${g.name} »</h3>
    <div class="small">Déjà épargné : ${fmtF(g.saved)} / ${fmtF(g.target)}</div>
    <div class="small">Argent disponible : <b>${fmtF(dispo)}</b> — l'épargne sera déduite de ton solde global.</div>
    <label class="fld">Montant à mettre de côté (FCFA)</label>
    <input id="gAdd" inputmode="numeric" placeholder="0" />
    <div style="height:14px;"></div>
    <button class="btn" id="gAddSave">Mettre de côté</button>
  `);
  $("#gAdd").addEventListener("input",e=>{const d=e.target.value.replace(/\D/g,"");e.target.value=d?fmt(d):"";});
  setTimeout(()=>$("#gAdd").focus(),120);
  $("#gAddSave").addEventListener("click",()=>{
    const v=Number($("#gAdd").value.replace(/\D/g,""));
    if(!v){shake($("#gAdd"));return;}
    g.saved += v;
    S.savings.push({id:uid(), goalId:g.id, amount:v, date:todayISO()});
    save();closeSheet();
    toast(v>dispo ? "Épargné — solde global négatif ⚠️" : "Épargne ajoutée 🎉");
    renderAll();
  });
}
function openEditGoal(id){
  const g = id ? S.goals.find(x=>x.id===id) : {name:"",target:0,saved:0,due:""};
  const isNew = !id;
  openSheet(`
    <h3>${isNew?"Nouvel objectif d'achat":"Modifier l'objectif"}</h3>
    <label class="fld">Nom</label>
    <input id="gName" value="${escapeHtml(g.name)}" placeholder="ex : Achat moto" />
    <label class="fld">Montant cible (FCFA)</label>
    <input id="gTarget" inputmode="numeric" value="${g.target?fmt(g.target):""}" placeholder="0" />
    <label class="fld">Déjà épargné (FCFA)</label>
    <input id="gSaved" inputmode="numeric" value="${g.saved?fmt(g.saved):""}" placeholder="0" />
    <label class="fld">Date cible (optionnel)</label>
    <input id="gDue" type="month" value="${g.due||""}" />
    <div style="height:14px;"></div>
    <button class="btn" id="gSave">Enregistrer</button>
    ${!isNew?`<div style="text-align:center;margin-top:12px;"><button class="danger-link" id="gDel">🗑 Supprimer l'objectif</button></div>`:""}
  `);
  ["gTarget","gSaved"].forEach(i=>$("#"+i).addEventListener("input",e=>{const d=e.target.value.replace(/\D/g,"");e.target.value=d?fmt(d):"";}));
  $("#gSave").addEventListener("click",()=>{
    const name=$("#gName").value.trim()||"Objectif";
    const target=Number($("#gTarget").value.replace(/\D/g,""))||0;
    const saved=Number($("#gSaved").value.replace(/\D/g,""))||0;
    const due=$("#gDue").value||"";
    if(isNew){ S.goals.push({id:uid(),name,target,saved,due}); }
    else { g.name=name;g.target=target;g.saved=saved;g.due=due; }
    save();closeSheet();toast("Objectif enregistré");renderAll();
  });
  if(!isNew){ $("#gDel").addEventListener("click",()=>{ S.goals=S.goals.filter(x=>x.id!==id);save();closeSheet();toast("Objectif supprimé");renderAll(); }); }
}

/* ============================================================
   TOAST
============================================================ */
let toastT;
function toast(msg){
  let el=$("#toast");
  if(!el){ el=document.createElement("div"); el.id="toast";
    el.style.cssText="position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#16202a;color:#fff;padding:11px 18px;border-radius:999px;font-size:14px;font-weight:700;z-index:80;box-shadow:0 8px 20px rgba(0,0,0,.25);opacity:0;transition:opacity .2s, bottom .2s;";
    document.body.appendChild(el); }
  el.textContent=msg; el.style.opacity="1"; el.style.bottom="100px";
  clearTimeout(toastT); toastT=setTimeout(()=>{el.style.opacity="0";el.style.bottom="90px";},1700);
}

/* ============================================================
   RENDER GLOBAL
============================================================ */
function renderAll(){
  renderHome();
  renderBudget();
  renderSaving();
  renderEvents();
  renderHistory();
  renderDebts();
  renderStats();
}
/* ============================================================
   VERROUILLAGE PAR CODE (pavé 0-9)
============================================================ */
const PIN_LEN = 4;
let lockMode = "enter";   // "enter" | "create" | "confirm"
let pinBuffer = "";
let firstPin = "";

function buildLockPad(){
  const keys = ["1","2","3","4","5","6","7","8","9","","0","del"];
  $("#lockPad").innerHTML = keys.map(k=>{
    if(k==="")    return `<span></span>`;
    if(k==="del") return `<button class="lk fn" data-k="del">⌫</button>`;
    return `<button class="lk" data-k="${k}">${k}</button>`;
  }).join("");
  $$("#lockPad .lk").forEach(b=>b.addEventListener("click",()=>onLockKey(b.dataset.k)));
}
function renderDots(err){
  let h="";
  for(let i=0;i<PIN_LEN;i++) h+=`<div class="dot-pin${i<pinBuffer.length?' on':''}${err?' err':''}"></div>`;
  $("#lockDots").innerHTML = h;
}
function updateLockUI(){
  const t = {enter:"Entrez votre code", create:"Créez un code", confirm:"Confirmez le code"};
  const s = {enter:"Code à 4 chiffres", create:"Choisissez 4 chiffres", confirm:"Retapez le même code"};
  $("#lockTitle").textContent = t[lockMode];
  $("#lockSub").textContent   = s[lockMode] || "";
  $("#lockSkip").style.display = (lockMode==="create") ? "block" : "none";
  renderDots();
}
function showLock(mode){
  lockMode = mode; pinBuffer = ""; firstPin = "";
  buildLockPad(); updateLockUI();
  $("#lock").style.display = "flex";
}
function onLockKey(k){
  if(k==="del"){ pinBuffer = pinBuffer.slice(0,-1); renderDots(); return; }
  if(pinBuffer.length >= PIN_LEN) return;
  pinBuffer += k; renderDots();
  if(pinBuffer.length === PIN_LEN) setTimeout(submitPin, 140);
}
function wrongPin(msg){
  renderDots(true);
  $("#lockSub").textContent = msg;
  if(navigator.vibrate) navigator.vibrate(180);
  pinBuffer = "";
  setTimeout(()=>{ renderDots(); }, 550);
}
function submitPin(){
  if(lockMode==="enter"){
    if(pinBuffer === S.pin) unlockApp();
    else wrongPin("Code incorrect");
  } else if(lockMode==="create"){
    firstPin = pinBuffer; pinBuffer = ""; lockMode = "confirm"; updateLockUI();
  } else { // confirm
    if(pinBuffer === firstPin){
      S.pin = firstPin; save();
      unlockApp(); toast("Code enregistré 🔒");
    } else {
      firstPin = ""; lockMode = "create";
      wrongPin("Les codes ne correspondent pas");
      setTimeout(updateLockUI, 560);
    }
  }
}
function unlockApp(){
  $("#lock").style.display = "none";
  renderAll();
}
$("#lockSkip").addEventListener("click",()=>{ $("#lock").style.display="none"; renderAll(); });

// Bouton 🔒 de l'accueil : activer / modifier / désactiver le code
$("#lockBtn").addEventListener("click",()=>{
  const has = !!(S.pin && S.pin.length);
  openSheet(`
    <h3>🔒 Code de sécurité</h3>
    <div class="small">${has?"Un code est demandé à chaque ouverture de l'app.":"Aucun code actif. Active un code à 4 chiffres pour protéger l'accès à tes chiffres."}</div>
    <div style="height:14px;"></div>
    <button class="btn" id="secChange">${has?"Modifier le code":"Activer un code"}</button>
    ${has?`<div style="text-align:center;margin-top:12px;"><button class="danger-link" id="secOff">Désactiver le code</button></div>`:""}
  `);
  $("#secChange").addEventListener("click",()=>{ closeSheet(); showLock("create"); });
  if(has) $("#secOff").addEventListener("click",()=>{ S.pin=""; save(); closeSheet(); toast("Code désactivé"); });
});

// Démarrage : on charge les données depuis le serveur AVANT d'afficher
(async function init(){
  S = await load();   // marche même hors-ligne (cache local)
  // attention : pas de court-circuit, les deux doivent tourner
  const salOk = ensureSalary(), recOk = ensureRecurrents();
  if(salOk || recOk || needsSave) save();   // salaire + dépenses récurrentes + migrations
  renderCatGrid();
  if(S.pin && S.pin.length){
    showLock("enter");         // un code existe -> on le demande
  } else {
    showLock("create");        // pas encore de code -> on propose d'en créer un (avec « Ignorer »)
  }
})();

// Service Worker : permet d'OUVRIR l'app sans connexion (cache de la page)
if("serviceWorker" in navigator && location.protocol.startsWith("http")){
  navigator.serviceWorker.register("/sw.js").catch(()=>{});
}

