
"use strict";
/* ============================================================
   DONNÉES CENTRALISÉES — serveur Node + data.json
   Rien n'est codé en dur : tout vit dans data.json, lu/écrit via
   l'API (/api/data) du mini-serveur server.js.
   DEFAULT_CATS / freshState ne servent QUE de secours si l'API
   est injoignable (ex. fichier ouvert en file:// sans serveur).
============================================================ */
const API = "/api/data";
const DEFAULT_CATS = [
  {id:"nourriture", name:"Nourriture",        icon:"🍚", color:"#0e9f6e", bucket:"besoins", limit:60000},
  {id:"transport",  name:"Transport",         icon:"🚕", color:"#2f6fed", bucket:"besoins", limit:36000},
  {id:"loyer",      name:"Loyer & Charges",   icon:"🏠", color:"#7c3aed", bucket:"besoins", limit:10000},
  {id:"loisirs",    name:"Loisirs",           icon:"🎉", color:"#f59e0b", bucket:"loisirs", limit:0},
  {id:"telecom",    name:"Tél / Internet",    icon:"📱", color:"#06b6d4", bucket:"besoins", limit:0},
  {id:"imprevus",   name:"Imprévus",          icon:"⚡", color:"#ef4444", bucket:"loisirs", limit:0},
  {id:"autre",      name:"Autre",             icon:"🧾", color:"#7a8a99", bucket:"loisirs", limit:0},
];

function freshState(){
  return {
    salaireMensuel: 300000, // salaire crédité automatiquement chaque mois
    salaireDepuis: "",       // mois "YYYY-MM" à partir duquel le salaire est crédité
    rule: {besoins:50, loisirs:30, epargne:20},
    cats: DEFAULT_CATS,
    income: [],        // rentrées d'argent {id, amount, note, date(ISO), auto?, month?}
    tx: [],            // dépenses {id, amount, catId, note, date(ISO)}
    savings: [],       // versements d'épargne {id, goalId, amount, date(ISO)}
    goals: [
      {id:"urgence", name:"Fonds d'urgence", target:600000, saved:0, due:""},
    ],
  };
}

let S = null; // rempli au démarrage par load()

function normalize(s){
  s = s || {};
  // migration : ancien champ "revenu" -> "salaireMensuel"
  if(s.salaireMensuel === undefined && s.revenu !== undefined) s.salaireMensuel = s.revenu;
  s.salaireMensuel = Number(s.salaireMensuel) || 0;
  s.salaireDepuis  = s.salaireDepuis || "";
  s.rule   = s.rule || {besoins:50, loisirs:30, epargne:20};
  s.cats   = (s.cats && s.cats.length) ? s.cats : DEFAULT_CATS;
  s.cats.forEach(c=>{ c.limit = Number(c.limit) || 0; }); // plafond mensuel par catégorie
  s.income  = s.income || [];
  s.savings = s.savings || [];
  s.goals   = s.goals || [];
  s.tx      = s.tx || [];
  delete s.revenu;
  return s;
}

// Lecture : récupère TOUTES les données depuis le serveur (data.json)
async function load(){
  try{
    const res = await fetch(API, {cache:"no-store"});
    if(!res.ok) throw new Error("HTTP "+res.status);
    return normalize(await res.json());
  }catch(e){
    console.warn("API injoignable — mode secours hors-ligne :", e.message);
    return freshState();
  }
}

// Écriture : renvoie l'état complet au serveur, qui réécrit data.json
let saveSeq = 0;
async function save(){
  const mySeq = ++saveSeq;
  try{
    const res = await fetch(API, {
      method:"PUT",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify(S)
    });
    if(!res.ok) throw new Error("HTTP "+res.status);
  }catch(e){
    console.warn("Sauvegarde échouée :", e.message);
    if(mySeq === saveSeq) toast("⚠️ Sauvegarde impossible (serveur ?)");
  }
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
function sumSaved(){ return S.goals.reduce((a,g)=>a+(g.saved||0),0); }     // total mis de côté (épargne)
function soldeGlobal(){ return sumIncome() - sumExpenses() - sumSaved(); } // argent réellement disponible

function uid(){ return Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36); }
function todayISO(){ return new Date().toISOString(); }

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
  S.tx.push({id:uid(), amount, catId:selectedCat, note:$("#noteInput").value.trim(), date:todayISO()});
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
}
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
  const summary = `<div class="card">
    <div class="mrow"><span class="ml">Total épargné</span><span class="mv num">${fmtF(sumSaved())}</span></div>
    <div class="mrow total"><span class="ml">Argent encore disponible</span><span class="mv num" style="color:${soldeGlobal()<0?'var(--red)':'var(--green)'}">${fmtF(soldeGlobal())}</span></div>
  </div>`;
  $("#goalsList").innerHTML = summary + S.goals.map(g=>{
    const pct = g.target>0 ? Math.min(100,Math.round(g.saved/g.target*100)) : 0;
    return `<div class="card goal" data-id="${g.id}">
      <div class="gline"><span class="gname">${g.name}</span><span class="gpct">${pct}%</span></div>
      <div class="bar ${pct>=100?'':''}"><span style="width:${pct}%"></span></div>
      <div class="gsub"><span>${fmtF(g.saved)} épargnés</span><span>Objectif&nbsp;: ${fmtF(g.target)}</span></div>
      ${g.due?`<div class="small" style="margin-top:6px;">🎯 Échéance : ${g.due}</div>`:""}
      <div style="display:flex;gap:8px;margin-top:12px;">
        <button class="btn sm" data-act="add" style="flex:1;">+ Ajouter</button>
        <button class="btn sm ghost" data-act="edit" style="flex:1;">Modifier</button>
      </div>
    </div>`;
  }).join("") || `<div class="empty">Aucun objectif. Ajoute ton fonds d'urgence 🛡️</div>`;

  $$("#goalsList .goal").forEach(card=>{
    const id=card.dataset.id;
    card.querySelector('[data-act="add"]').addEventListener("click",()=>openAddToGoal(id));
    card.querySelector('[data-act="edit"]').addEventListener("click",()=>openEditGoal(id));
  });
}
$("#addGoal").addEventListener("click",()=>openEditGoal(null));

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
  openSheet(`
    <h3>${c.icon} ${c.name}</h3>
    <div class="small">${new Date(t.date).toLocaleString("fr-FR")}</div>
    <label class="fld">Montant (FCFA)</label>
    <input id="edAmt" inputmode="numeric" value="${fmt(t.amount)}" />
    <label class="fld">Catégorie</label>
    <select id="edCat">${S.cats.map(cc=>`<option value="${cc.id}" ${cc.id===t.catId?"selected":""}>${cc.icon} ${cc.name}</option>`).join("")}</select>
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
    save();closeSheet();toast("Modifié ✅");renderAll();
  });
  $("#edDel").addEventListener("click",()=>{
    S.tx=S.tx.filter(x=>x.id!==id);save();closeSheet();toast("Supprimé");renderAll();
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
  openSheet(`
    <h3>${i.auto?"💼 Salaire":"💵 Revenu"}</h3>
    <div class="small">${new Date(i.date).toLocaleDateString("fr-FR")}${i.auto?" · crédité automatiquement":""}</div>
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
    save();closeSheet();toast("Modifié ✅");renderAll();
  });
  $("#inEdDel").addEventListener("click",()=>{
    S.income=S.income.filter(x=>x.id!==id);save();closeSheet();toast("Supprimé");renderAll();
  });
}

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
    <h3>${isNew?"Nouvel objectif":"Modifier l'objectif"}</h3>
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
  renderHistory();
}
// Démarrage : on charge les données depuis le serveur AVANT d'afficher
(async function init(){
  S = await load();
  if(ensureSalary()) save();   // crédite le salaire des mois écoulés
  renderCatGrid();
  renderAll();
})();

