// dashboard.js — logique du dashboard PRONOTE avancé (vanilla JS, pas de build).

let offsetEdt = 0;
let offsetDevoirs = 0;
let periodeChoisie = "";
let periodeAbsencesChoisie = "";
let periodesNotesDisponibles = [];
let periodesAbsencesDisponibles = [];
let dejaChargeUneFois = false;
let discussionActiveId = null;
let graphEvolution = null;
let matieresEvolutionData = {};
let matieresActives = new Set();
let destinatairesDisponibles = [];
let destinatairesSelectionnes = new Map(); // id -> {id, name, type, functions}
let profilCharge = false;

// ══════════════════════ Palette de couleurs par matière (façon Papillon) ══
const PALETTE_MATIERES = [
  "#C50017", "#DA2400", "#DD6B00", "#E8901C", "#E8B048",
  "#6BAE00", "#37BB12", "#12BB67", "#26B290", "#26ABB2",
  "#2DB9D8", "#009EC5", "#007FDA", "#3A56D0", "#7600CA",
  "#962DD8", "#B300CA", "#C50066", "#DD004A", "#DD0030",
];

// Couleurs fixes reprenant celles affichées par PRONOTE pour chaque matière
// (cf. capture d'emploi du temps). Clés en MAJUSCULES, comparaison insensible
// à la casse et aux accents ci-dessous.
const COULEURS_MATIERES_FIXES = {
  "ANGLAIS LV1": "#F3E9D2",
  "PHYSIQUE-CHIMIE": "#C9BEEA",
  "SCIENCES VIE & TERRE": "#E88A8A",
  "SVT": "#E88A8A",
  "ALLEMAND LV2": "#F4D9C6",
  "SC.NUMERIQ.TECHNOL.": "#9FB8E0",
  "SCIENCES NUMERIQUES ET TECHNOLOGIE": "#9FB8E0",
  "ACCOMPAGNEMT. PERSO.": "#F2C9D6",
  "ACCOMPAGNEMENT PERSONNALISE": "#F2C9D6",
  "HISTOIRE-GEOGRAPHIE": "#A9C6E8",
  "SC. ECONO.& SOCIALES": "#EAD9F3",
  "SCIENCES ECONOMIQUES ET SOCIALES": "#EAD9F3",
  "ED.PHYSIQUE & SPORT.": "#9AD4B5",
  "EDUCATION PHYSIQUE ET SPORTIVE": "#9AD4B5",
  "EPS": "#9AD4B5",
  "ENS. MORAL & CIVIQUE": "#8FD4C8",
  "MATHEMATIQUES": "#E6D48A",
  "ACCOMP.CHOIX ORIENT.": "#D8C9A3",
  "FRANCAIS": "#C9DCEF",
};

function _normaliserNomMatiere(nom) {
  return (nom || "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function couleurMatiere(nom) {
  if (!nom) return PALETTE_MATIERES[0];
  const cle = _normaliserNomMatiere(nom);
  if (COULEURS_MATIERES_FIXES[cle]) return COULEURS_MATIERES_FIXES[cle];
  let hash = 0;
  for (let i = 0; i < nom.length; i++) {
    hash = (hash * 31 + nom.charCodeAt(i)) >>> 0;
  }
  return PALETTE_MATIERES[hash % PALETTE_MATIERES.length];
}

// ══════════════════════ THÈME (clair / sombre / hacker) — transition animée ═══════
const COULEURS_VEIL = { clair: "#F3F6F7", sombre: "#101215", hacker: "#0a0505" };

function appliquerEtatPicker() {
  const theme = document.documentElement.getAttribute("data-theme") || "clair";
  document.querySelectorAll(".theme-picker__opt").forEach((btn) => {
    btn.classList.toggle("actif", btn.dataset.themeOpt === theme);
  });
}
appliquerEtatPicker();

document.querySelectorAll(".theme-picker__opt").forEach((btn) => {
  btn.addEventListener("click", (ev) => {
    const nouveau = btn.dataset.themeOpt;
    const actuel = document.documentElement.getAttribute("data-theme") || "clair";
    if (nouveau === actuel) return;

    const veil = document.getElementById("theme-veil");
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    veil.style.setProperty("--veil-x", `${x}px`);
    veil.style.setProperty("--veil-y", `${y}px`);
    veil.style.setProperty("--veil-bg", COULEURS_VEIL[nouveau] || "#101215");

    veil.classList.remove("animer");
    void veil.offsetWidth; // force reflow pour relancer l'animation
    veil.classList.add("animer");

    setTimeout(() => {
      document.documentElement.setAttribute("data-theme", nouveau);
      localStorage.setItem("theme", nouveau);
      appliquerEtatPicker();
      if (graphEvolution) tracerGraphEvolution();
    }, 220);

    veil.addEventListener("animationend", () => {
      veil.classList.remove("animer");
    }, { once: true });
  });
});

// ══════════════════════ Navigation sidebar ══════════════════════════
const vuesAvecChargementUnique = {
  notes: chargerNotes,
  evolution: chargerEvolution,
  edt: chargerEdt,
  devoirs: chargerDevoirs,
  absences: chargerAbsences,
  actualites: chargerActualites,
  messagerie: chargerDiscussions,
  profil: chargerProfil,
  bulletin: chargerBulletin,
  professeurs: chargerProfesseurs,
  simulateur: chargerSimulateur,
};
const vuesDejaChargees = new Set();

function activerVue(vue) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("actif"));
  document.querySelectorAll(".vue").forEach((v) => v.classList.remove("actif"));
  const btnNav = document.querySelector(`.nav-item[data-vue="${vue}"]`);
  if (btnNav) btnNav.classList.add("actif");
  const cible = document.getElementById("vue-" + vue);
  if (cible) cible.classList.add("actif");

  if (vue === "gestion") {
    // Toujours réactualisé : c'est ici que vit le statut de connexion.
    chargerGestion();
    return;
  }

  if (!vuesDejaChargees.has(vue) && vuesAvecChargementUnique[vue]) {
    vuesDejaChargees.add(vue);
    vuesAvecChargementUnique[vue]();
  }

  // Les boutons/zones de saisie qui viennent d'apparaître (page qui était
  // en display:none jusqu'ici) avaient une taille de 0×0 au moment où le
  // module liquid-glass a tourné au chargement de la page — leur carte de
  // distorsion était donc inutilisable. On la régénère maintenant qu'ils
  // ont une taille réelle.
  if (window.__lgRafraichirVisibles) {
    requestAnimationFrame(() => window.__lgRafraichirVisibles());
  }
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => activerVue(btn.dataset.vue));
});

// Tout élément marqué data-vue-cible (profil sidebar, cartes de l'accueil…)
// ouvre l'onglet correspondant au clic, sauf si on clique sur un contrôle
// interactif imbriqué (bouton, lien, case à cocher…) qui a son propre rôle.
document.querySelectorAll("[data-vue-cible]").forEach((el) => {
  el.addEventListener("click", (ev) => {
    if (ev.target.closest("a, button, input, textarea, select, .devoir-check")) return;
    activerVue(el.dataset.vueCible);
  });
});

// ══════════════════════ Statut de connexion (polling léger) ═════════
async function pollStatut() {
  try {
    const r = await fetch("/api/statut");
    const data = await r.json();

    if (data.connecte && !dejaChargeUneFois) {
      dejaChargeUneFois = true;
      chargerAujourdhui();
      chargerProfilMini();
      rafraichirBadges(); // fixe l'état de référence pour les notifications
    }

    // Si l'onglet Gestion est ouvert, on le tient à jour aussi.
    if (document.getElementById("vue-gestion").classList.contains("actif")) {
      appliquerStatutGestion(data);
    }
  } catch (e) {
    console.error("Erreur polling statut", e);
  }
  setTimeout(pollStatut, 2500);
}
pollStatut();

// ══════════════════════ Gestion (statut + détails techniques) ═══════
function appliquerStatutGestion(data) {
  const pastille = document.getElementById("gestion-pastille");
  const texte = document.getElementById("gestion-texte-statut");
  if (!pastille || !texte) return;
  texte.textContent = data.statut;
  pastille.className = "pastille " + (
    data.connecte ? "ok" : (data.en_cours ? "attente" : "ko")
  );
}

async function chargerGestion() {
  try {
    const r = await fetch("/api/gestion");
    const data = await r.json();
    appliquerStatutGestion(data);

    const grille = document.getElementById("gestion-details-grille");
    const champs = [
      ["Connecté en tant que", data.nom_utilisateur || "—"],
      ["Identifiant d'appareil", data.device_uuid || "—"],
      ["URL PRONOTE", data.pronote_url || "—"],
    ];
    grille.innerHTML = champs.map(([label, valeur]) => `
      <div class="profil-champ">
        <span class="profil-champ__label">${escHtml(label)}</span>
        <span class="profil-champ__valeur" style="word-break:break-all;">${escHtml(valeur)}</span>
      </div>
    `).join("");
  } catch (e) {
    console.error("Erreur chargement gestion", e);
  }
}

// ── Rafraîchissement global (bouton 🔄 en haut à droite) ───────────────────
// Un seul bouton recharge tout sans relancer l'appli : le serveur vide ses
// caches (et rouvre la session PRONOTE si elle est morte), puis chaque vue
// déjà ouverte est rechargée.
let rafraichissementEnCours = false;

async function attendreConnexion(delaiMaxMs) {
  const fin = Date.now() + delaiMaxMs;
  while (Date.now() < fin) {
    await new Promise((res) => setTimeout(res, 1000));
    try {
      const d = await (await fetch("/api/statut")).json();
      if (d.connecte) return true;
      if (d.erreur && !d.en_cours) return false;
    } catch (e) { /* on retente */ }
  }
  return false;
}

async function rafraichirTout() {
  if (rafraichissementEnCours) return;
  rafraichissementEnCours = true;
  const btn = document.getElementById("btn-rafraichir-global");
  btn.classList.add("tourne");
  try {
    const d = await (await fetch("/api/rafraichir", { method: "POST" })).json();
    if (d.reconnexion) {
      toast("Reconnexion à PRONOTE…", "La session avait expiré.");
      if (!(await attendreConnexion(25000))) {
        toast("Reconnexion impossible", "Regarde l'onglet Gestion pour le détail.", "gestion");
        return;
      }
    }
    chargerAujourdhui();
    chargerProfilMini();
    rafraichirBadges();
    if (document.getElementById("vue-gestion").classList.contains("actif")) chargerGestion();
    vuesDejaChargees.forEach((vue) => vuesAvecChargementUnique[vue] && vuesAvecChargementUnique[vue]());
    toast("Données rafraîchies ✓");
  } catch (e) {
    console.error("Erreur rafraîchissement global", e);
    toast("Échec du rafraîchissement", e.message);
  } finally {
    btn.classList.remove("tourne");
    rafraichissementEnCours = false;
  }
}
document.getElementById("btn-rafraichir-global").addEventListener("click", rafraichirTout);

document.getElementById("btn-reconnexion").addEventListener("click", async () => {
  if (!confirm("Ça va oublier la session locale du dashboard et relancer un flow QR PRONOTE. Continuer ?")) return;
  dejaChargeUneFois = false;
  vuesDejaChargees.clear();
  await fetch("/api/reconnexion", { method: "POST" });
  chargerGestion();
});

// ══════════════════════ Profil (mini, dans la sidebar) ════════════════
async function chargerProfilMini() {
  try {
    const r = await fetch("/api/profil");
    const data = await r.json();
    if (!data.pret) return;

    const avatar = document.getElementById("profil-avatar-mini");
    if (data.photo_url) {
      avatar.innerHTML = `<img src="${escHtml(data.photo_url)}" alt="">`;
    } else {
      avatar.textContent = initiales(data.nom);
    }
    document.getElementById("profil-nom-mini").textContent = data.nom || "Élève";
    document.getElementById("profil-classe-mini").textContent = data.classe || data.etablissement || "";
  } catch (e) {
    console.error("Erreur chargement profil mini", e);
  }
}

function initiales(nom) {
  if (!nom) return "?";
  return nom.split(/\s+/).filter(Boolean).slice(0, 2).map((m) => m[0].toUpperCase()).join("");
}

async function chargerProfil() {
  const conteneur = document.getElementById("carte-profil");
  try {
    const r = await fetch("/api/profil");
    const data = await r.json();
    if (!data.pret) {
      conteneur.innerHTML = '<div class="centre-info">Pas encore connecté.</div>';
      return;
    }

    const avatarHtml = data.photo_url
      ? `<img src="${escHtml(data.photo_url)}" alt="">`
      : initiales(data.nom);

    const champs = [
      ["Classe", data.classe],
      ["Établissement", data.etablissement],
      ["Email", data.email],
      ["Téléphone", data.telephone],
      ["Numéro INE", data.ine],
      ["Adresse", data.adresse],
      ["Délégué de classe", data.delegue && data.delegue.length ? data.delegue.join(", ") : "Non"],
    ].filter(([, v]) => v && v !== "—");

    conteneur.innerHTML = `
      <div class="profil-entete">
        <div class="profil-avatar">${avatarHtml}</div>
        <div>
          <h2 class="profil-nom">${escHtml(data.nom || "Élève")}</h2>
          <p class="profil-etablissement">${escHtml(data.etablissement || "")}</p>
        </div>
      </div>
      <div class="profil-grille">
        ${champs.map(([label, valeur]) => `
          <div class="profil-champ">
            <span class="profil-champ__label">${escHtml(label)}</span>
            <span class="profil-champ__valeur">${escHtml(valeur)}</span>
          </div>
        `).join("")}
      </div>
    `;
  } catch (e) {
    conteneur.innerHTML = '<div class="centre-info">Impossible de charger le profil.</div>';
    console.error("Erreur chargement profil", e);
  }
}

// ══════════════════════ Aujourd'hui ══════════════════════════════════
async function chargerAujourdhui() {
  const r = await fetch("/api/aujourdhui");
  const data = await r.json();
  if (!data.pret) return;

  document.getElementById("titre-jour").textContent = "Bonjour 👋";
  document.getElementById("soustitre-jour").textContent = data.date;

  // Prochain cours
  const carteProchain = document.getElementById("carte-prochain-cours");
  if (data.prochain_cours) {
    carteProchain.innerHTML = `
      <div class="prochain-cours__contenu">
        <div>
          <div class="prochain-cours__label">Prochain cours</div>
          <div class="prochain-cours__matiere">${escHtml(data.prochain_cours.matiere)}</div>
          <div class="prochain-cours__meta">${escHtml(data.prochain_cours.salle || "")}</div>
        </div>
        <div class="prochain-cours__heure">${escHtml(data.prochain_cours.debut)}</div>
      </div>`;
  } else {
    carteProchain.innerHTML = `
      <div class="prochain-cours__contenu">
        <div>
          <div class="prochain-cours__label">Aujourd'hui</div>
          <div class="prochain-cours__matiere">Pas d'autre cours prévu 🎉</div>
        </div>
      </div>`;
  }

  // Cours du jour
  const conteneurCours = document.getElementById("auj-cours-jour");
  if (data.cours.length === 0) {
    conteneurCours.innerHTML = '<div class="vide">Aucun cours aujourd\'hui.</div>';
  } else {
    conteneurCours.innerHTML = data.cours.map((c) => `
      <div class="mini-item">
        <span class="mini-item__pastille ${c.annule ? "rouge" : ""}"></span>
        <span class="mini-item__texte">
          <b>${escHtml(c.matiere)}</b>${c.annule ? " (annulé)" : ""}
          ${c.salle ? ` · ${escHtml(c.salle)}` : ""}
        </span>
        <span class="mini-item__meta">${escHtml(c.debut)}–${escHtml(c.fin)}</span>
      </div>
    `).join("");
  }

  // Devoirs à venir
  const conteneurDevoirs = document.getElementById("auj-devoirs");
  if (data.devoirs_urgents.length === 0) {
    conteneurDevoirs.innerHTML = '<div class="vide">Rien à faire pour les prochains jours 🎉</div>';
  } else {
    conteneurDevoirs.innerHTML = data.devoirs_urgents.map((d) => `
      <div class="mini-item">
        <span class="mini-item__pastille"></span>
        <span class="mini-item__texte">
          <b>${escHtml(d.matiere)}</b> — ${escHtml(tronquer(d.description, 60))}
        </span>
        <span class="mini-item__meta">${escHtml(d.date)}</span>
      </div>
    `).join("");
  }

  // Dernières notes
  const conteneurNotes = document.getElementById("auj-notes");
  if (data.dernieres_notes.length === 0) {
    conteneurNotes.innerHTML = '<div class="vide">Pas de notes pour le moment.</div>';
  } else {
    conteneurNotes.innerHTML = data.dernieres_notes.map((n) => `
      <div class="mini-item">
        <span class="mini-item__note">${escHtml(n.note)}/${escHtml(n.bareme)}</span>
        <span class="mini-item__texte"><b>${escHtml(n.matiere)}</b></span>
        <span class="mini-item__meta">${escHtml(n.date)}</span>
      </div>
    `).join("");
  }

  // Badges sidebar
  majBadge("badge-actus", data.nb_actus_non_lues);
  majBadge("badge-messages", data.nb_messages_non_lus);

  chargerResume();
}

// ── Résumé du matin (cours, devoirs urgents, nouveautés non lues) ──────────
async function chargerResume() {
  const zone = document.getElementById("resume-texte");
  const titre = document.getElementById("resume-titre");
  const btnIa = document.getElementById("btn-resume-ia");
  if (!zone) return;
  titre.textContent = new Date().getHours() < 12 ? "☀️ Résumé du matin" : "📋 Résumé du jour";
  try {
    const d = await (await fetch("/api/resume_matin")).json();
    if (!d.pret) return;
    if (!d.ok) { zone.textContent = "Résumé indisponible : " + (d.erreur || "erreur"); return; }
    zone.textContent = d.texte;
    btnIa.hidden = !d.ia_disponible;
  } catch (e) {
    console.error("Erreur résumé du matin", e);
    zone.textContent = "Résumé indisponible.";
  }
}

document.getElementById("btn-resume-ia").addEventListener("click", async () => {
  const btn = document.getElementById("btn-resume-ia");
  const carte = document.getElementById("carte-resume-matin");
  btn.disabled = true;
  btn.textContent = "✨ …";
  try {
    const d = await (await fetch("/api/resume_matin?ia=1")).json();
    let bloc = carte.querySelector(".resume-matin__ia");
    if (!bloc) {
      bloc = document.createElement("div");
      bloc.className = "resume-matin__texte resume-matin__ia";
      carte.appendChild(bloc);
    }
    bloc.textContent = d.texte_ia || ("L'assistant n'a pas pu répondre : " + (d.erreur_ia || "erreur inconnue"));
  } catch (e) {
    toast("Résumé de l'assistant impossible", e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Version assistant";
  }
});

function majBadge(id, valeur) {
  const el = document.getElementById(id);
  if (!el) return; // la barre de navigation n'est pas encore construite
  if (valeur > 0) {
    el.textContent = valeur > 9 ? "9+" : valeur;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// ── Compteurs de la barre de navigation (actus / messages non lus) ─────────
// Mis à jour automatiquement : toutes les 20 s tant que l'onglet du navigateur
// est visible, immédiatement au retour sur l'onglet, et après chaque action
// qui change un compteur (appel direct à rafraichirBadges()).
const INTERVALLE_BADGES_MS = 20000;
let badgesEnCours = false;

// État de référence des non lus déjà vus : sert à ne notifier que ce qui est
// vraiment NOUVEAU (nouvelle actualité, ou nouveau message dans une discussion).
let nonLusConnus = null; // { actus: Set<string>, messages: Map<string, number> }

function detecterNouveautes(d) {
  if (!Array.isArray(d.actus_non_lues) || !Array.isArray(d.messages_non_lus)) return;
  const actusActuelles = new Set(d.actus_non_lues.map((a) => a.id));
  const messagesActuels = new Map(d.messages_non_lus.map((m) => [m.id, m.non_lus]));

  if (nonLusConnus) {
    const nouvellesActus = d.actus_non_lues.filter((a) => !nonLusConnus.actus.has(a.id));
    const nouveauxMessages = d.messages_non_lus.filter(
      (m) => !nonLusConnus.messages.has(m.id) || m.non_lus > nonLusConnus.messages.get(m.id)
    );
    if (nouvellesActus.length === 1) {
      notifier("📰 Nouvelle actualité", `${nouvellesActus[0].titre} — ${nouvellesActus[0].auteur}`, "actualites");
    } else if (nouvellesActus.length > 1) {
      notifier(`📰 ${nouvellesActus.length} nouvelles actualités`, nouvellesActus.map((a) => a.titre).slice(0, 3).join(" · "), "actualites");
    }
    if (nouveauxMessages.length === 1) {
      notifier("💬 Nouveau message", `${nouveauxMessages[0].sujet} — ${nouveauxMessages[0].auteur}`, "messagerie");
    } else if (nouveauxMessages.length > 1) {
      notifier(`💬 ${nouveauxMessages.length} nouveaux messages`, nouveauxMessages.map((m) => m.sujet).slice(0, 3).join(" · "), "messagerie");
    }
  }
  nonLusConnus = { actus: actusActuelles, messages: messagesActuels };
}

async function rafraichirBadges() {
  if (badgesEnCours) return; // évite deux requêtes qui se chevauchent
  badgesEnCours = true;
  try {
    const r = await fetch("/api/badges");
    const d = await r.json();
    if (!d.pret) return;
    // null = lecture échouée côté serveur : on garde l'ancienne valeur
    if (typeof d.nb_actus_non_lues === "number") majBadge("badge-actus", d.nb_actus_non_lues);
    if (typeof d.nb_messages_non_lus === "number") majBadge("badge-messages", d.nb_messages_non_lus);
    detecterNouveautes(d);
  } catch (e) {
    console.error("Erreur rafraîchissement badges", e);
  } finally {
    badgesEnCours = false;
  }
}

function planifierBadges() {
  setTimeout(async () => {
    if (!document.hidden) await rafraichirBadges();
    planifierBadges();
  }, INTERVALLE_BADGES_MS);
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) rafraichirBadges();
});
planifierBadges();

// ══════════════════════ Notes (façon PronoteApp / Papillon) ══════════
// Grande carte "moyenne" avec courbe degradee + selecteur d'algorithme
// de calcul, carrousel des dernieres notes, puis liste groupee par
// matiere avec fiche detail au clic sur une note.

document.getElementById("btn-select-periode").addEventListener("click", () => {
  ouvrirFeuillePeriode("notes");
});

let notesData = null;       // dernier payload /api/notes reçu
let notesAlgo = "subject";  // "subject" | "weighted" | "median"

const ALGOS_MOYENNE = [
  { cle: "subject", label: "Moyenne des matières", desc: "Additionne les moyennes de chacune des matières.", recommande: true },
  { cle: "weighted", label: "Moyenne pondérée", desc: "Moyenne des notes individuelles sans tenir compte des matières." },
  { cle: "median", label: "Médiane", desc: "Médiane des notes (autant de notes au-dessus qu'en dessous)." },
];

function noteNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = parseFloat(String(v).replace(",", "."));
  return isNaN(n) ? null : n;
}

function grouperNotesParMatiere(notes, moyennesParMatiere) {
  const parMat = moyennesParMatiere || {};
  const ordre = [];
  const map = {};
  for (const n of notes) {
    const cle = n.matiere || "?";
    if (!map[cle]) { map[cle] = { matiere: cle, notes: [] }; ordre.push(cle); }
    map[cle].notes.push(n);
  }
  return ordre.map((cle) => {
    const entree = map[cle];
    // Priorité à MA moyenne perso dans la matière (fournie par le serveur),
    // jamais la moyenne de la classe.
    const infoMat = parMat[cle];
    let officielle = infoMat ? noteNum(infoMat.moyenne) : null;
    let officielleBareme = infoMat ? (noteNum(infoMat.bareme) || 20) : 20;
    if (officielle === null) {
      // Repli : moyenne simple de mes notes de la matière, jamais la moyenne classe.
      const valeurs = entree.notes
        .map((n) => {
          const v = noteNum(n.note);
          const b = noteNum(n.bareme) || 20;
          return v !== null ? (v / b) * 20 : null;
        })
        .filter((v) => v !== null);
      if (valeurs.length > 0) {
        officielle = valeurs.reduce((s, x) => s + x, 0) / valeurs.length;
        officielleBareme = 20;
      }
    }
    entree.moyenneOfficielle = officielle;
    entree.moyenneOfficielleBareme = officielleBareme;
    entree.moyenneClasse = infoMat ? infoMat.moyenne_classe : null;
    return entree;
  });
}

function construireHistoriqueMoyenne(notes, algo) {
  const triees = notes.slice().sort((a, b) => new Date(a.date_iso || 0) - new Date(b.date_iso || 0));
  const points = [];
  const vues = []; // { matiere, valeur (/20) }

  for (const n of triees) {
    const val = noteNum(n.note);
    if (val === null) continue;
    const bareme = noteNum(n.bareme) || 20;
    vues.push({ matiere: n.matiere || "?", valeur: (val / bareme) * 20 });
    const moy = calculerMoyenneDepuisVues(vues, algo);
    if (moy !== null) points.push({ date: n.date_iso ? new Date(n.date_iso) : new Date(), valeur: moy });
  }
  // Déduplique par date (jour calendaire) : quand plusieurs notes tombent le
  // même jour, on ne garde que le dernier point de ce jour (la moyenne
  // cumulée finale après toutes les notes du jour). Sans ça, deux notes du
  // même jour créaient un faux zigzag sur la courbe, comme si du temps
  // s'était écoulé entre elles.
  const parJour = new Map();
  for (const p of points) {
    const cle = p.date.toISOString().slice(0, 10); // YYYY-MM-DD
    parJour.set(cle, p); // écrase l'entrée précédente du même jour -> garde la dernière
  }
  return Array.from(parJour.values());
}

function calculerMoyenneDepuisVues(vues, algo) {
  if (vues.length === 0) return null;
  if (algo === "median") {
    const vals = vues.map((v) => v.valeur).sort((a, b) => a - b);
    const mid = Math.floor(vals.length / 2);
    return vals.length % 2 !== 0 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  }
  if (algo === "weighted") {
    return vues.reduce((s, v) => s + v.valeur, 0) / vues.length;
  }
  // "subject" (par defaut) : moyenne des moyennes de matieres
  const parMatiere = {};
  for (const v of vues) {
    (parMatiere[v.matiere] = parMatiere[v.matiere] || []).push(v.valeur);
  }
  const moyennes = Object.values(parMatiere).map((arr) => arr.reduce((s, x) => s + x, 0) / arr.length);
  return moyennes.length > 0 ? moyennes.reduce((s, x) => s + x, 0) / moyennes.length : null;
}

function construireCourbeSvg(points, couleur, W, H) {
  W = W || 440; H = H || 120;
  const padTop = 16, padBottom = 8, padSide = 4;
  if (points.length === 0) return { path: "", fillPath: "", coords: [], forecastCoord: null };
  let pts = points.length === 1 ? [points[0], points[0]] : points;

  // ── Pronostic par régression linéaire (moindres carrés) ──
  // Prédit la prochaine valeur probable et un intervalle de confiance ±RMSE.
  function calculerPronostic(ptsData) {
    const n = ptsData.length;
    if (n < 2) return null;
    const yi = ptsData.map((p) => p.valeur);
    const meanX = (n - 1) / 2;
    const meanY = yi.reduce((s, y) => s + y, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - meanX) * (yi[i] - meanY); den += (i - meanX) ** 2; }
    if (den === 0) return null;
    const slope = num / den;
    const intercept = meanY - slope * meanX;
    const valPred = Math.max(0, Math.min(20, slope * n + intercept));
    const rmse = Math.sqrt(ptsData.reduce((s, p, i) => s + (p.valeur - (slope * i + intercept)) ** 2, 0) / n);
    return { valeur: valPred, min: Math.max(0, valPred - rmse), max: Math.min(20, valPred + rmse), slope };
  }

  const forecast = calculerPronostic(pts);

  const valeurs = pts.map((p) => p.valeur);
  let minV = Math.min(...valeurs), maxV = Math.max(...valeurs);
  // NE PAS inclure le pronostic dans l'échelle — cela compressait/déformait
  // visuellement la courbe réelle. Le pronostic utilise sa propre fonction toY
  // définie plus bas avec cette même échelle, ce qui est cohérent.
  if (minV === maxV) { minV -= 1; maxV += 1; }
  const span = maxV - minV;
  minV -= span * 0.15;
  maxV += span * 0.15;

  const n = pts.length;
  // La courbe réelle occupe 78 % de la largeur — les 22 % restants accueillent le pronostic
  const xMin = padSide;
  const xMax = padSide + (W - padSide * 2) * 0.78; // x du dernier point réel
  const coords = pts.map((p, i) => {
    // Correction : étaler les points sur [xMin, xMax] sans doublon de padSide
    const x = xMin + (i / (n - 1)) * (xMax - xMin);
    const yRatio = (p.valeur - minV) / (maxV - minV);
    const y = padTop + (1 - yRatio) * (H - padTop - padBottom);
    return { x, y, valeur: p.valeur, date: p.date };
  });

  // ── Spline cubique monotone (Hermite / Fritsch-Carlson) ──
  // Remplace l'ancienne Catmull-Rom qui provoquait des "overshoots" :
  // de fausses bosses/creux apparaissant entre les points quand la pente
  // changeait brusquement ou lors d'un palier. Cette version garantit que
  // la courbe ne dépasse jamais les valeurs réelles des points de données.
  let d = `M ${coords[0].x.toFixed(2)} ${coords[0].y.toFixed(2)}`;
  const nc = coords.length;
  if (nc < 2) {
    // rien à tracer
  } else if (nc === 2) {
    d += ` L ${coords[1].x.toFixed(2)} ${coords[1].y.toFixed(2)}`;
  } else {
    const dx = new Array(nc - 1), dk = new Array(nc - 1); // pentes sécantes
    for (let i = 0; i < nc - 1; i++) {
      dx[i] = coords[i + 1].x - coords[i].x;
      dk[i] = dx[i] === 0 ? 0 : (coords[i + 1].y - coords[i].y) / dx[i];
    }
    const m = new Array(nc); // tangentes aux points
    m[0] = dk[0];
    m[nc - 1] = dk[nc - 2];
    for (let i = 1; i < nc - 1; i++) {
      // Moyenne pondérée des pentes voisines : arrondit naturellement les
      // sommets/creux au lieu de les aplatir (pas de mise à zéro forcée).
      if (dx[i - 1] + dx[i] === 0) m[i] = 0;
      else m[i] = (dk[i - 1] * dx[i] + dk[i] * dx[i - 1]) / (dx[i - 1] + dx[i]);
    }
    // Limiteur (Fritsch-Carlson assoupli) : borne les tangentes pour éviter
    // les GROS dépassements, sans forcer un aplatissement aux extrema —
    // un léger arrondi au-delà du point reste possible, c'est voulu.
    for (let i = 0; i < nc - 1; i++) {
      if (dk[i] === 0) { continue; }
      const a = m[i] / dk[i], b = m[i + 1] / dk[i];
      const h = Math.sqrt(a * a + b * b);
      if (h > 3) { const t = 3 / h; m[i] = t * a * dk[i]; m[i + 1] = t * b * dk[i]; }
    }
    for (let j = 0; j < nc - 1; j++) {
      const p1 = coords[j], p2 = coords[j + 1];
      const h = dx[j] / 3;
      const cp1x = p1.x + h, cp1y = p1.y + m[j] * h;
      const cp2x = p2.x - h, cp2y = p2.y - m[j + 1] * h;
      d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
  }
  // fillPath ferme sur les vraies coordonnées X des premier/dernier point (pas W)
  const lastX = coords[coords.length - 1].x.toFixed(2);
  const firstX = coords[0].x.toFixed(2);
  const fillPath = `${d} L ${lastX} ${H - padBottom} L ${firstX} ${H - padBottom} Z`;

  // Coordonnées SVG du point de pronostic (à droite de la courbe réelle)
  let forecastCoord = null;
  if (forecast && coords.length > 0) {
    const last = coords[coords.length - 1];
    const xF = last.x + (W - padSide * 6 - last.x) * 0.55;
    const toY = (v) => padTop + (1 - (v - minV) / (maxV - minV)) * (H - padTop - padBottom);
    forecastCoord = {
      x: xF, y: toY(forecast.valeur),
      yMax: toY(forecast.max), yMin: toY(forecast.min),
      valeur: forecast.valeur, min: forecast.min, max: forecast.max,
      slope: forecast.slope,
    };
  }

  return { path: d, fillPath, coords, W, H, forecastCoord };
}

function fmtDateCourte(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const jours = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"];
  const p2 = (x) => String(x).padStart(2, "0");
  return `${jours[d.getDay()]} ${p2(d.getDate())}/${p2(d.getMonth() + 1)}`;
}
function fmtDateLongue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const jours = ["Dimanche", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi"];
  const p2 = (x) => String(x).padStart(2, "0");
  return `${jours[d.getDay()]} ${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

async function chargerNotes() {
  const conteneurListe = document.getElementById("liste-notes");
  const r = await fetch("/api/notes?periode=" + encodeURIComponent(periodeChoisie));
  const data = await r.json();
  if (!data.pret) return;
  notesData = data;

  periodesNotesDisponibles = data.periodes || [];
  if (!periodeChoisie) periodeChoisie = data.periode || "";
  document.getElementById("lbl-select-periode").textContent = data.periode || "Période";

  afficherNotes(data);

  if (data.notes.length === 0) {
    conteneurListe.innerHTML = '<div class="centre-info"><div class="emoji">📭</div>Pas de notes pour cette période.</div>';
  }
}

function afficherNotes(data) {
  const notes = data.notes || [];
  const couleurAccent = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || "#29947A";

  // ── Carte moyenne + courbe ──
  // On mesure la taille RÉELLE du conteneur et on l'utilise comme viewBox,
  // au lieu d'unités abstraites étirées non-uniformément par le CSS
  // (ce qui déformait le cercle du pronostic en ellipse et écrasait le texte).
  const wrapMesure = document.getElementById("gAvgGraphWrap");
  const rectMesure = wrapMesure ? wrapMesure.getBoundingClientRect() : null;
  const Wreel = rectMesure && rectMesure.width > 0 ? rectMesure.width : 440;
  const Hreel = rectMesure && rectMesure.height > 0 ? rectMesure.height : 120;
  const historique = construireHistoriqueMoyenne(notes, notesAlgo);
  const courbe = construireCourbeSvg(historique, couleurAccent, Wreel, Hreel);
  const dernierPoint = historique.length > 0 ? historique[historique.length - 1] : null;
  const moyenneReelle = noteNum(data.moyenne_generale);
  const valeurAffichee = moyenneReelle !== null ? moyenneReelle : (dernierPoint ? dernierPoint.valeur : 0);
  const sousTitreBase = moyenneReelle !== null
    ? "par l'établissement"
    : (dernierPoint ? "estimée au " + fmtDateCourte(dernierPoint.date.toISOString()) : "");

  const svg = document.getElementById("gAvgSvg");
  if (courbe.coords.length > 0) {
    const gradId = "gAvgGrad" + Math.floor(Math.random() * 1000000);
    svg.setAttribute("viewBox", `0 0 ${courbe.W} ${courbe.H}`);

    // ── Rendu du pronostic ──
    // Carte "tooltip" façon dashboards finance (fond plein + triangle
    // pointeur vers le point), au lieu de texte minuscule à moitié
    // transparent qui flottait dans le vide.
    let forecastSvg = "";
    const fc = courbe.forecastCoord;
    if (fc) {
      const last = courbe.coords[courbe.coords.length - 1];
      const couleurF = fc.slope >= 0 ? "#22c55e" : "#ef4444";
      const fleche = fc.slope >= 0 ? "↗" : "↘";
      const dotR = 6;

      // Zone de confiance ±RMSE (discrète, reste en arrière-plan)
      forecastSvg += `<rect x="${(fc.x - 7).toFixed(2)}" y="${fc.yMax.toFixed(2)}" width="14" height="${(fc.yMin - fc.yMax).toFixed(2)}" fill="${couleurF}" opacity="0.13" rx="4"/>`;
      // Ligne pointillée de connexion
      forecastSvg += `<line x1="${last.x.toFixed(2)}" y1="${last.y.toFixed(2)}" x2="${fc.x.toFixed(2)}" y2="${fc.y.toFixed(2)}" stroke="${couleurF}" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.65"/>`;

      // Carte tooltip : dimensions en pixels réels (le viewBox correspond
      // maintenant aux pixels écran, voir fix précédent) — donc ces tailles
      // de police sont directement lisibles, pas écrasées par un scale.
      const cardW = 68, cardH = 42, radius = 11, pointerH = 7, pointerW = 12;
      const gap = 5; // espace entre la pointe du triangle et le point
      const placerAuDessus = fc.y - dotR - gap - pointerH - cardH > 2;
      const cardX = Math.min(Math.max(fc.x - cardW / 2, 3), courbe.W - cardW - 3);
      const cardY = placerAuDessus
        ? fc.y - dotR - gap - pointerH - cardH
        : fc.y + dotR + gap + pointerH;
      const pointerTipX = Math.min(Math.max(fc.x, cardX + radius + pointerW / 2), cardX + cardW - radius - pointerW / 2);
      const pointerBaseY = placerAuDessus ? cardY + cardH : cardY;
      const pointerTipY = placerAuDessus ? cardY + cardH + pointerH : cardY - pointerH;

      // Triangle pointeur (même couleur que la carte, fusionné visuellement)
      forecastSvg += `<polygon points="${(pointerTipX - pointerW / 2).toFixed(2)},${pointerBaseY.toFixed(2)} ${(pointerTipX + pointerW / 2).toFixed(2)},${pointerBaseY.toFixed(2)} ${pointerTipX.toFixed(2)},${pointerTipY.toFixed(2)}" fill="${couleurF}"/>`;
      // Carte (fond plein, bien contrastée)
      forecastSvg += `<rect x="${cardX.toFixed(2)}" y="${cardY.toFixed(2)}" width="${cardW}" height="${cardH}" rx="${radius}" fill="${couleurF}"/>`;
      // Valeur + flèche — grand et gras
      forecastSvg += `<text x="${(cardX + cardW / 2).toFixed(2)}" y="${(cardY + 19).toFixed(2)}" text-anchor="middle" font-size="16" font-weight="800" fill="#ffffff">${fleche} ${fc.valeur.toFixed(1)}</text>`;
      // Label "Pronostic" — plus petit, légèrement estompé pour hiérarchiser
      forecastSvg += `<text x="${(cardX + cardW / 2).toFixed(2)}" y="${(cardY + 34).toFixed(2)}" text-anchor="middle" font-size="10" font-weight="600" fill="#ffffff" opacity="0.85" letter-spacing="0.3">Pronostic</text>`;

      // Point central (par-dessus la ligne pointillée, sous la carte)
      forecastSvg += `<circle cx="${fc.x.toFixed(2)}" cy="${fc.y.toFixed(2)}" r="${dotR}" fill="${couleurF}" stroke="white" stroke-width="2"/>`;
    }

    svg.innerHTML = `
      <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${couleurAccent}" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="${couleurAccent}" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${courbe.fillPath}" fill="url(#${gradId})" stroke="none"></path>
      <path d="${courbe.path}" fill="none" stroke="${couleurAccent}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>
      ${forecastSvg}
    `;
  } else {
    svg.innerHTML = "";
  }

  document.getElementById("gAvgNumVal").textContent = valeurAffichee.toFixed(2);
  const algoInfo = ALGOS_MOYENNE.find((a) => a.cle === notesAlgo);
  document.getElementById("gAvgAlgoLbl").textContent = algoInfo ? algoInfo.label : "";
  document.getElementById("gAvgSubLbl").textContent = [
    sousTitreBase,
    data.moyenne_classe && data.moyenne_classe !== "—" ? "classe : " + data.moyenne_classe : "",
    data.periode || "",
  ].filter(Boolean).join(" · ");

  initInteractionCourbe(courbe.coords, courbe.W, courbe.H, valeurAffichee.toFixed(2), document.getElementById("gAvgSubLbl").textContent);

  if (notes.length === 0) {
    document.getElementById("recentWrap").innerHTML = "";
    return;
  }

  // ── Carrousel des dernieres notes ──
  const recentes = notes.slice().sort((a, b) => new Date(b.date_iso || 0) - new Date(a.date_iso || 0)).slice(0, 10);
  document.getElementById("recentWrap").innerHTML = recentes.map((n) => {
    const c = couleurMatiere(n.matiere);
    return `
      <div class="recentCard" data-note-id="${escHtml(n.id != null ? n.id : "")}">
        <div class="rcBar" style="background:${c};"></div>
        <div class="rcTop" style="color:${c};">${escHtml(n.note)}<span class="rcOn"> /${escHtml(n.bareme)}</span></div>
        <div class="rcSubj">${escHtml(n.matiere || "?")}</div>
        <div class="rcDate">${fmtDateCourte(n.date_iso)}</div>
      </div>`;
  }).join("");

  // ── Liste groupee par matiere ──
  const parMatiere = grouperNotesParMatiere(notes, data.moyennes_par_matiere);
  const conteneur = document.getElementById("liste-notes");
  let html = "";
  parMatiere.forEach((groupe, gi) => {
    const c = couleurMatiere(groupe.matiere);
    const moyHtml = groupe.moyenneOfficielle !== null
      ? groupe.moyenneOfficielle.toFixed(2).replace(".", ",") + `<span class="out"> /${escHtml(groupe.moyenneOfficielleBareme)}</span>`
      : "N/A";

    html += `
      <div class="subjHead">
        <div class="shTitle"><span class="shIcon" style="background:${c}22;color:${c};">📘</span>${escHtml(groupe.matiere)}</div>
        <div class="shAvg" style="background:${c}18;color:${c};">${moyHtml}</div>
      </div>`;

    groupe.notes.forEach((n, ni) => {
      const valNum = noteNum(n.note);
      const maxNum = noteNum(n.note_max);
      const estMeilleure = valNum !== null && maxNum !== null && valNum >= maxNum;
      html += `
        <div class="gradeCard" data-groupe="${gi}" data-index="${ni}">
          <div class="gcAccent" style="background:${c};"></div>
          <div class="gcCircle" style="background:${c}1c;">
            <div class="gcVal" style="color:${c};">${escHtml(n.note)}</div>
            <div class="gcOutOf" style="color:${c};">/${escHtml(n.bareme)}</div>
          </div>
          <div class="gcInfoCell">
            <div class="gcDesc">${escHtml(n.commentaire || n.matiere || "?")}</div>
            <div class="gcMeta">${fmtDateCourte(n.date_iso)}${n.coefficient && n.coefficient !== "—" ? ` &middot; <span class="gcCoef">coef ${escHtml(n.coefficient)}</span>` : ""}</div>
            ${estMeilleure ? '<div class="gcBadge">🏆 Meilleure note</div>' : ""}
          </div>
          ${n.moyenne_classe && n.moyenne_classe !== "—" ? `<div class="gcClassAvgCell"><div class="gcClassAvg">${escHtml(n.moyenne_classe)}<span class="gcClassAvgLbl">Moy. classe</span></div></div>` : ""}
        </div>`;
    });
  });
  conteneur.innerHTML = html;

  conteneur.querySelectorAll(".gradeCard").forEach((carte) => {
    carte.addEventListener("click", () => {
      const gi = parseInt(carte.dataset.groupe, 10);
      const ni = parseInt(carte.dataset.index, 10);
      const note = parMatiere[gi].notes[ni];
      ouvrirDetailNote(note);
    });
  });

  document.getElementById("recentWrap").querySelectorAll(".recentCard").forEach((carte, i) => {
    carte.addEventListener("click", () => ouvrirDetailNote(recentes[i]));
  });
}

// -- interaction "scrub" au doigt/souris sur la courbe --
function initInteractionCourbe(coords, viewW, viewH, valeurBase, sousTitreBase) {
  const wrap = document.getElementById("gAvgGraphWrap");
  const dot = document.getElementById("gAvgDot");
  const numEl = document.getElementById("gAvgNumVal");
  const subEl = document.getElementById("gAvgSubLbl");
  if (!wrap || coords.length === 0) return;

  function plusProche(clientX) {
    const rect = wrap.getBoundingClientRect();
    const cible = ((clientX - rect.left) / rect.width) * viewW;
    let meilleur = coords[0], meilleureDist = Math.abs(coords[0].x - cible);
    for (const c of coords) {
      const dist = Math.abs(c.x - cible);
      if (dist < meilleureDist) { meilleur = c; meilleureDist = dist; }
    }
    return meilleur;
  }
  function afficherPoint(p) {
    const rect = wrap.getBoundingClientRect();
    dot.style.display = "block";
    dot.style.left = (p.x / viewW) * rect.width + "px";
    dot.style.top = (p.y / viewH) * rect.height + "px";
    numEl.textContent = Number(p.valeur).toFixed(2);
    if (p.date) subEl.textContent = "estimée au " + fmtDateCourte(p.date.toISOString());
  }
  function reinitialiser() {
    dot.style.display = "none";
    numEl.textContent = valeurBase;
    subEl.textContent = sousTitreBase;
  }

  wrap.onmousemove = (e) => afficherPoint(plusProche(e.clientX));
  wrap.onmouseleave = reinitialiser;
  wrap.ontouchmove = (e) => { afficherPoint(plusProche(e.touches[0].clientX)); };
  wrap.ontouchend = reinitialiser;
}

// -- feuille de choix de l'algorithme --
document.getElementById("gAvgAlgoBtn").addEventListener("click", ouvrirFeuilleAlgo);
document.getElementById("algoSheetBg").addEventListener("click", fermerFeuilleAlgo);

function ouvrirFeuilleAlgo() {
  const wrap = document.getElementById("algoOptsWrap");
  wrap.innerHTML = ALGOS_MOYENNE.map((a) => `
    <div class="algoOpt${a.recommande ? " recommended" : ""}" data-cle="${a.cle}">
      <div><div class="aoLbl">${escHtml(a.label)}</div><div class="aoDesc">${escHtml(a.desc)}</div></div>
      <div class="aoCheck">${a.cle === notesAlgo ? "✓" : ""}</div>
    </div>`).join("");
  wrap.querySelectorAll(".algoOpt").forEach((opt) => {
    opt.addEventListener("click", () => {
      notesAlgo = opt.dataset.cle;
      fermerFeuilleAlgo();
      if (notesData) afficherNotes(notesData);
    });
  });
  document.getElementById("algoSheetBg").classList.add("ouverte");
  document.getElementById("algoSheet").classList.add("ouverte");
}
function fermerFeuilleAlgo() {
  document.getElementById("algoSheetBg").classList.remove("ouverte");
  document.getElementById("algoSheet").classList.remove("ouverte");
}

// -- feuille de choix de la période (notes / absences), centrée, remplace les <select> natifs --
document.getElementById("periodeSheetBg").addEventListener("click", fermerFeuillePeriode);

function ouvrirFeuillePeriode(contexte) {
  const periodes = contexte === "absences" ? periodesAbsencesDisponibles
    : contexte === "bulletin" ? periodesBulletinDisponibles
    : contexte === "simulateur" ? ((simuData && simuData.periodes) || periodesNotesDisponibles)
    : periodesNotesDisponibles;
  const choisie = contexte === "absences" ? periodeAbsencesChoisie
    : contexte === "bulletin" ? periodeBulletinChoisie
    : contexte === "simulateur" ? simuPeriodeChoisie
    : periodeChoisie;
  const wrap = document.getElementById("periodeOptsWrap");
  wrap.innerHTML = periodes.map((p) => `
    <div class="algoOpt" data-periode="${escHtml(p)}">
      <div><div class="aoLbl">${escHtml(p)}</div></div>
      <div class="aoCheck">${p === choisie ? "✓" : ""}</div>
    </div>`).join("");
  wrap.querySelectorAll(".algoOpt").forEach((opt) => {
    opt.addEventListener("click", () => {
      const p = opt.dataset.periode;
      if (contexte === "absences") {
        periodeAbsencesChoisie = p;
        fermerFeuillePeriode();
        chargerAbsences();
      } else if (contexte === "bulletin") {
        periodeBulletinChoisie = p;
        fermerFeuillePeriode();
        chargerBulletin();
      } else if (contexte === "simulateur") {
        simuPeriodeChoisie = p;
        fermerFeuillePeriode();
        chargerSimulateur();
      } else {
        periodeChoisie = p;
        fermerFeuillePeriode();
        chargerNotes();
      }
    });
  });
  document.getElementById("periodeSheetBg").classList.add("ouverte");
  document.getElementById("periodeSheet").classList.add("ouverte");
}
function fermerFeuillePeriode() {
  document.getElementById("periodeSheetBg").classList.remove("ouverte");
  document.getElementById("periodeSheet").classList.remove("ouverte");
}

// -- fiche detail d'une note --
function ouvrirDetailNote(n) {
  const c = couleurMatiere(n.matiere);
  const val = noteNum(n.note);
  const max = noteNum(n.note_max);
  const estMeilleure = val !== null && max !== null && val >= max;

  let badges = "";
  if (estMeilleure) badges += `<div class="gDetailBadge solid" style="background:${c};">🏆 Meilleure note</div>`;
  if (n.optionnelle) badges += `<div class="gDetailBadge outline" style="color:${c};">ℹ️ Note facultative</div>`;
  if (n.bonus) badges += `<div class="gDetailBadge outline" style="color:${c};">ℹ️ Note bonus</div>`;

  let splitHtml = "";
  if ((n.coefficient && n.coefficient !== "—") || (n.moyenne_classe && n.moyenne_classe !== "—")) {
    splitHtml = '<div class="gDetailSplit">';
    if (n.coefficient && n.coefficient !== "—") {
      splitHtml += `<div class="gdCell"><div class="gdLbl">Coefficient</div><div class="gdVal" style="color:${c};">x${escHtml(n.coefficient)}</div></div>`;
    }
    if (n.coefficient && n.coefficient !== "—" && n.moyenne_classe && n.moyenne_classe !== "—") {
      splitHtml += '<div class="gdDivider"></div>';
    }
    if (n.moyenne_classe && n.moyenne_classe !== "—") {
      splitHtml += `<div class="gdCell"><div class="gdLbl">Moyenne classe</div><div class="gdVal" style="color:${c};">${escHtml(n.moyenne_classe)}<span class="gdDenom">/${escHtml(n.bareme)}</span></div></div>`;
    }
    splitHtml += "</div>";
  }

  function ligne(label, valeur, outOf, highlight) {
    return `
      <div class="gDetailStatRow${highlight ? " highlight" : ""}"${highlight ? ` style="border-color:${c}55;"` : ""}>
        <div class="gDetailStatLbl">${escHtml(label)}</div>
        <div class="gDetailStatVal"${highlight ? ` style="color:${c};"` : ""}>${escHtml(valeur)}${outOf ? `<span class="gDetailStatOutOf"> /${escHtml(outOf)}</span>` : ""}</div>
      </div>`;
  }

  let statsHtml = ligne("Note élève", n.note, n.bareme, true);
  if (n.moyenne_classe && n.moyenne_classe !== "—") statsHtml += ligne("Moyenne classe", n.moyenne_classe, n.bareme, false);
  if (n.note_max) statsHtml += ligne("Note la plus haute", n.note_max, n.bareme, false);
  if (n.note_min) statsHtml += ligne("Note la plus basse", n.note_min, n.bareme, false);
  if (n.date_iso) statsHtml += ligne("Date", fmtDateCourte(n.date_iso), null, false);

  document.getElementById("note-detail-contenu").innerHTML = `
    <div class="gDetailHero" style="background:linear-gradient(180deg, ${c}26 0%, transparent 100%);">
      <div class="gDetailEmoji" style="background:${c}22;">📘</div>
      <div class="gDetailSubject" style="color:${c};">${escHtml(n.matiere || "Note")}</div>
      ${n.commentaire ? `<div class="gDetailDesc">${escHtml(n.commentaire)}</div>` : ""}
      <div class="gDetailDate">${fmtDateLongue(n.date_iso)}</div>
      <div class="gDetailScoreRow">
        <span class="gDetailScoreVal" style="color:${c};">${escHtml(n.note)}</span>
        <span class="gDetailScoreOn" style="color:${c};">/${escHtml(n.bareme)}</span>
      </div>
      ${badges ? `<div class="gDetailBadges">${badges}</div>` : ""}
    </div>
    ${splitHtml}
    <div class="gDetailBody">
      <div class="gDetailSectionTitle">Détails</div>
      ${statsHtml}
    </div>
  `;
  document.getElementById("modale-note-detail").classList.add("ouverte");
  document.querySelector("#modale-note-detail .modale-note-detail__scroll").scrollTop = 0;
}
document.getElementById("btn-fermer-note-detail").addEventListener("click", (e) => {
  e.stopPropagation();
  document.getElementById("modale-note-detail").classList.remove("ouverte");
});
document.getElementById("modale-note-detail").addEventListener("click", (e) => {
  if (e.target.id === "modale-note-detail") e.target.classList.remove("ouverte");
});

// ══════════════════════ Évolution (Chart.js) ═════════════════════════
async function chargerEvolution() {
  const r = await fetch("/api/notes/evolution");
  const data = await r.json();
  if (!data.pret) return;

  matieresEvolutionData = data.par_matiere || {};

  const cible = document.getElementById("evolution-vide-ou-matieres");
  if (data.points.length === 0) {
    cible.innerHTML = '<div class="centre-info"><div class="emoji">📭</div>Pas encore de notes pour tracer une évolution.</div>';
    document.querySelector(".graphique-conteneur").style.display = "none";
    return;
  }
  document.querySelector(".graphique-conteneur").style.display = "block";

  cible.innerHTML = `
    <div class="carte__titre">Filtrer par matière</div>
    <div id="chips-matieres"></div>
  `;
  const chipsConteneur = document.getElementById("chips-matieres");
  chipsConteneur.innerHTML = Object.keys(matieresEvolutionData).sort().map((m) => `
    <span class="chip-matiere" data-matiere="${escHtml(m)}">${escHtml(m)}</span>
  `).join("");
  chipsConteneur.querySelectorAll(".chip-matiere").forEach((chip) => {
    chip.addEventListener("click", () => {
      const m = chip.dataset.matiere;
      if (matieresActives.has(m)) {
        matieresActives.delete(m);
        chip.classList.remove("actif");
      } else {
        matieresActives.add(m);
        chip.classList.add("actif");
      }
      tracerGraphEvolution();
    });
  });

  window._dernieresDonneesEvolution = data;
  tracerGraphEvolution();
  chargerStatistiquesNotes();
}

function tracerGraphEvolution() {
  const data = window._dernieresDonneesEvolution;
  if (!data) return;

  if (typeof Chart === "undefined") {
    console.warn("[évolution] Chart.js n'a pas pu se charger (CDN bloqué/hors-ligne) — graphique indisponible.");
    const conteneur = document.getElementById("graph-evolution")?.parentElement;
    if (conteneur && !conteneur.querySelector(".evolution-indispo")) {
      const msg = document.createElement("div");
      msg.className = "centre-info evolution-indispo";
      msg.innerHTML = "<div class=\"emoji\">📡</div>Graphique indisponible (bibliothèque non chargée).";
      conteneur.appendChild(msg);
    }
    return;
  }

  const styleCss = getComputedStyle(document.documentElement);
  const couleurPrimaire = styleCss.getPropertyValue("--primary").trim();
  const couleurTexte = styleCss.getPropertyValue("--text-muted").trim();
  const couleurGrille = styleCss.getPropertyValue("--border").trim();

  const datasets = [{
    label: "Moyenne générale (cumulative)",
    data: data.moyenne_cumulative.map((p) => ({ x: p.date, y: p.moyenne })),
    borderColor: couleurPrimaire,
    backgroundColor: couleurPrimaire + "22",
    fill: true,
    tension: 0.3,
    pointRadius: 2,
    borderWidth: 2.5,
  }];

  if (matieresActives.size > 0) {
    [...matieresActives].forEach((m) => {
      const pts = (matieresEvolutionData[m] || []).slice().sort((a, b) => a.date.localeCompare(b.date));
      const c = couleurMatiere(m);
      datasets.push({
        label: m,
        data: pts.map((p) => ({ x: p.date, y: p.valeur })),
        borderColor: c,
        backgroundColor: "transparent",
        tension: 0.3,
        pointRadius: 2,
        borderWidth: 2,
        borderDash: [4, 3],
      });
    });
  }

  // Choix de l'unité d'affichage de l'axe temps en fonction de l'étendue
  // réelle des dates : sans ça, Luxon peut choisir "heures" quand les
  // points sont peu nombreux/proches, même sur toute une année scolaire.
  const toutesLesDates = datasets.flatMap((ds) => ds.data.map((p) => new Date(p.x).getTime()));
  let uniteAxeTemps = "month";
  if (toutesLesDates.length >= 2) {
    const ecartJours = (Math.max(...toutesLesDates) - Math.min(...toutesLesDates)) / 86400000;
    if (ecartJours <= 1) uniteAxeTemps = "day";
    else if (ecartJours <= 60) uniteAxeTemps = "week";
    else uniteAxeTemps = "month";
  }

  if (graphEvolution) graphEvolution.destroy();
  const ctx = document.getElementById("graph-evolution").getContext("2d");
  graphEvolution = new Chart(ctx, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          type: "time",
          time: {
            tooltipFormat: "dd/MM/yyyy",
            unit: uniteAxeTemps,
            displayFormats: { day: "dd/MM", week: "dd/MM", month: "MMM yyyy" },
          },
          ticks: { color: couleurTexte },
          grid: { color: couleurGrille },
        },
        y: {
          min: 0, max: 20,
          ticks: { color: couleurTexte },
          grid: { color: couleurGrille },
        },
      },
      plugins: {
        legend: { labels: { color: couleurTexte, boxWidth: 14, usePointStyle: true } },
      },
    },
  });
}

// ══════════════════ Statistiques avancées + 3 graphiques ══════════════
let graphComparaisonMatieres = null;
let graphRadarMatieres = null;
let graphCoefficientsMatieres = null;

async function chargerStatistiquesNotes() {
  const r = await fetch("/api/notes/statistiques" + (periodeChoisie ? "?periode=" + encodeURIComponent(periodeChoisie) : ""));
  const data = await r.json();
  if (!data.pret) return;

  const cartes = document.getElementById("stats-cartes");
  if (data.aucune_note) {
    cartes.innerHTML = '<div class="carte centre-info"><div class="emoji">📭</div>Pas encore de notes pour calculer de statistiques.</div>';
    ["graph-comparaison-matieres", "graph-radar-matieres", "graph-coefficients-matieres"].forEach((id) => {
      document.getElementById(id)?.parentElement?.parentElement && (document.getElementById(id).parentElement.parentElement.style.display = "none");
    });
    return;
  }

  const s = data.statistiques;
  const labelMoyenne = s.moyenne_est_officielle ? "Moyenne générale" : "Moyenne pondérée*";
  const titleMoyenne = s.moyenne_est_officielle
    ? "Moyenne générale officielle extraite directement de PRONOTE"
    : "⚠️ Repli : moyenne recalculée localement (PRONOTE n'a pas renvoyé la valeur officielle)";
  cartes.innerHTML = `
    <div class="carte stat-mini" title="${escHtml(titleMoyenne)}"><div class="stat-mini__label">${escHtml(labelMoyenne)}</div><div class="stat-mini__valeur">${s.moyenne_ponderee !== null ? s.moyenne_ponderee.toFixed(2).replace(".", ",") : "—"}/20</div></div>
    <div class="carte stat-mini"><div class="stat-mini__label">Médiane</div><div class="stat-mini__valeur">${s.mediane.toFixed(2).replace(".", ",")}/20</div></div>
    <div class="carte stat-mini"><div class="stat-mini__label">Écart-type</div><div class="stat-mini__valeur">${s.ecart_type.toFixed(2).replace(".", ",")}</div></div>
    <div class="carte stat-mini"><div class="stat-mini__label">Meilleure matière</div><div class="stat-mini__valeur stat-mini__valeur--texte">${escHtml(s.meilleure_matiere || "—")}</div></div>
    <div class="carte stat-mini"><div class="stat-mini__label">À travailler</div><div class="stat-mini__valeur stat-mini__valeur--texte">${escHtml(s.pire_matiere || "—")}</div></div>
    <div class="carte stat-mini"><div class="stat-mini__label">Notes prises en compte</div><div class="stat-mini__valeur">${s.nombre_notes}</div></div>
  `;

  const styleCss = getComputedStyle(document.documentElement);
  const couleurTexte = styleCss.getPropertyValue("--text-muted").trim();
  const couleurGrille = styleCss.getPropertyValue("--border").trim();
  const couleurPrimaire = styleCss.getPropertyValue("--primary").trim();

  if (typeof Chart === "undefined") return; // déjà signalé par tracerGraphEvolution

  // ── Comparaison par matière (barres) ──
  const comp = data.comparaison_matieres;
  if (graphComparaisonMatieres) graphComparaisonMatieres.destroy();
  graphComparaisonMatieres = new Chart(document.getElementById("graph-comparaison-matieres").getContext("2d"), {
    type: "bar",
    data: {
      labels: comp.map((d) => d.matiere),
      datasets: [
        {
          label: "Votre moyenne (PRONOTE)",
          data: comp.map((d) => d.votre_moyenne),
          backgroundColor: couleurPrimaire,
          borderRadius: 4,
        },
        {
          label: "Moyenne de classe",
          data: comp.map((d) => d.moyenne_classe),
          backgroundColor: couleurTexte + "55",
          borderRadius: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: couleurTexte }, grid: { display: false } },
        y: { min: 0, max: 20, ticks: { color: couleurTexte }, grid: { color: couleurGrille } },
      },
      plugins: { legend: { labels: { color: couleurTexte, boxWidth: 14, usePointStyle: true } } },
    },
  });

  // ── Profil radar ──
  const radar = data.radar;
  if (graphRadarMatieres) graphRadarMatieres.destroy();
  graphRadarMatieres = new Chart(document.getElementById("graph-radar-matieres").getContext("2d"), {
    type: "radar",
    data: {
      labels: radar.map((d) => d.matiere),
      datasets: [{
        label: "Moyenne par matière",
        data: radar.map((d) => d.valeur),
        borderColor: couleurPrimaire,
        backgroundColor: couleurPrimaire + "33",
        pointBackgroundColor: couleurPrimaire,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        r: {
          min: 0, max: 20,
          ticks: { color: couleurTexte, backdropColor: "transparent", stepSize: 5 },
          grid: { color: couleurGrille },
          angleLines: { color: couleurGrille },
          pointLabels: { color: couleurTexte, font: { size: 11 } },
        },
      },
      plugins: { legend: { display: false } },
    },
  });

  // ── Répartition des coefficients (camembert) ──
  const coefs = data.coefficients_matiere;
  if (graphCoefficientsMatieres) graphCoefficientsMatieres.destroy();
  graphCoefficientsMatieres = new Chart(document.getElementById("graph-coefficients-matieres").getContext("2d"), {
    type: "pie",
    data: {
      labels: coefs.map((d) => d.matiere),
      datasets: [{
        data: coefs.map((d) => d.coefficient),
        backgroundColor: coefs.map((d) => couleurMatiere(d.matiere)),
        borderColor: styleCss.getPropertyValue("--card").trim(),
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { color: couleurTexte, boxWidth: 14, usePointStyle: true } } },
    },
  });
}

// ══════════════════════ Emploi du temps — cartes façon Papillon ═══════
document.getElementById("edt-prec").addEventListener("click", () => { offsetEdt--; chargerEdt(); });
document.getElementById("edt-suiv").addEventListener("click", () => { offsetEdt++; chargerEdt(); });

function formatDureeMinutes(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h > 0 && m > 0) return `${h}h${String(m).padStart(2, "0")}`;
  if (h > 0) return `${h}h`;
  return `${m}min`;
}

function minutesDepuisHHMM(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function carteCoursHtml(c) {
  const couleur = couleurMatiere(c.matiere);
  const enCours = c.en_cours ? " maintenant" : "";
  const idAttr = c.id ? ` data-lesson-id="${escHtml(c.id)}"` : "";
  return `
    <div class="cours-row">
      <div class="cours-heures">
        <span class="cours-heures__debut">${escHtml(c.debut)}</span>
        <span class="cours-heures__fin">${escHtml(c.fin)}</span>
      </div>
      <div class="cours-carte ${c.annule ? "annule" : ""}${enCours}" style="--c:${couleur}"${idAttr}>
        <div class="cours-carte__barre"></div>
        <div class="cours-carte__corps">
          <div class="cours-carte__matiere">${escHtml(c.matiere)}</div>
          <div class="cours-carte__meta">
            ${c.salle ? `📍 ${escHtml(c.salle)}` : "📍 Salle inconnue"}
            ${c.prof ? `<span class="sep">·</span> 👤 ${escHtml(c.prof)}` : ""}
          </div>
          ${c.annule ? `<span class="cours-carte__statut">Cours annulé</span>` : ""}
        </div>
      </div>
    </div>
  `;
}

function listeCoursAvecPausesHtml(cours) {
  if (!cours || cours.length === 0) {
    return '<div class="vide">Pas de cours</div>';
  }
  const blocs = [];
  const SEUIL_PAUSE_MIN = 10; // au-delà de 10 min de trou, on affiche un séparateur
                              // (couvre aussi les intercours de 15 min type PC→SVT)

  for (let i = 0; i < cours.length; i++) {
    blocs.push(carteCoursHtml(cours[i]));
    if (i < cours.length - 1) {
      const finActuel = minutesDepuisHHMM(cours[i].fin);
      const debutSuivant = minutesDepuisHHMM(cours[i + 1].debut);
      const diff = debutSuivant - finActuel;
      if (diff > SEUIL_PAUSE_MIN) {
        const heureDebut = parseInt(cours[i].fin.split(":")[0], 10);
        let emoji = "☀️";
        let libelle = "Pause";
        if (diff <= 20) {
          emoji = "🔁";
          libelle = "Intercours";
        } else if (heureDebut < 11) {
          emoji = "🌅";
        } else if (heureDebut < 14) {
          emoji = "🍽️";
        } else if (heureDebut >= 18) {
          emoji = "🌙";
        }
        blocs.push(`
          <div class="separateur-pause">
            <span>${emoji}</span>
            <span>${libelle}</span>
            <span class="duree">${formatDureeMinutes(diff)}</span>
          </div>
        `);
      }
    }
  }
  return blocs.join("");
}

async function chargerEdt() {
  const r = await fetch("/api/edt?offset=" + offsetEdt);
  const data = await r.json();
  if (!data.pret) return;

  document.getElementById("edt-libelle-semaine").textContent =
    offsetEdt === 0 ? "Cette semaine" : `Semaine du ${data.semaine_du}`;

  const conteneur = document.getElementById("liste-edt");
  conteneur.innerHTML = data.jours.map((j) => `
    <div class="jour-carte">
      <div class="jour-carte__titre">
        ${j.nom} ${j.date}
        ${j.nb_devoirs > 0 ? `<span class="badge-devoirs-jour" title="${j.nb_devoirs} devoir(s) ce jour">📚 ${j.nb_devoirs}</span>` : ""}
      </div>
      <div class="jour-cours-liste">
        ${listeCoursAvecPausesHtml(j.cours)}
      </div>
    </div>
  `).join("");

  conteneur.querySelectorAll(".cours-carte[data-lesson-id]").forEach((carte) => {
    carte.addEventListener("click", () => ouvrirModaleCoursContenu(carte.dataset.lessonId));
  });
}

// ══════════════ Popup contenu d'un cours (cahier de texte) ═════════════
async function ouvrirModaleCoursContenu(lessonId) {
  const modale = document.getElementById("modale-cours-contenu");
  const corps = document.getElementById("cours-contenu-corps");
  modale.classList.add("ouverte");
  corps.innerHTML = '<div class="centre-info"><div class="spinner"></div>Chargement…</div>';

  try {
    const r = await fetch(`/api/edt/${encodeURIComponent(lessonId)}/contenu`);
    const d = await r.json();
    if (!d.ok) {
      corps.innerHTML = `<div class="centre-info">Impossible de charger ce cours : ${escHtml(d.erreur || "erreur inconnue")}</div>`;
      return;
    }

    let html = `
      <div class="cours-contenu-entete">
        <div class="cours-contenu-matiere">${escHtml(d.matiere)}</div>
        <div class="cours-contenu-meta">
          🕐 ${escHtml(d.debut)}–${escHtml(d.fin)}
          ${d.salle ? ` · 📍 ${escHtml(d.salle)}` : ""}
          ${d.prof ? ` · 👤 ${escHtml(d.prof)}` : ""}
        </div>
        ${d.annule ? '<span class="cours-carte__statut">Cours annulé</span>' : ""}
      </div>
    `;

    if (d.titre || d.description) {
      html += `
        <div class="cours-contenu-section">
          ${d.categorie ? `<div class="cours-contenu-categorie">${escHtml(d.categorie)}</div>` : ""}
          ${d.titre ? `<div class="cours-contenu-titre">${escHtml(d.titre)}</div>` : ""}
          ${d.description ? `<div class="cours-contenu-desc">${d.description}</div>` : ""}
        </div>
      `;
    } else {
      html += `<div class="cours-contenu-section vide">Aucun contenu renseigné par le professeur pour ce cours.</div>`;
    }

    if (d.pieces_jointes && d.pieces_jointes.length > 0) {
      html += `
        <div class="actu-pieces-jointes">
          <div class="actu-pieces-jointes__titre">📎 Pièces jointes (${d.pieces_jointes.length})</div>
          ${d.pieces_jointes.map((p) => `
            <a class="piece-jointe" href="${escHtml(p.url)}" target="_blank" rel="noopener noreferrer">
              <span class="piece-jointe__icone">${p.type === 0 ? "🔗" : icônePourNomFichier(p.nom)}</span>
              <span class="piece-jointe__nom">${escHtml(p.nom)}</span>
              <span class="piece-jointe__type">${p.type === 0 ? "Lien" : "Fichier"}</span>
            </a>
          `).join("")}
        </div>
      `;
    }

    if (d.devoirs && d.devoirs.length > 0) {
      html += `
        <div class="cours-contenu-section">
          <div class="actu-pieces-jointes__titre">📚 Devoirs pour ce jour</div>
          ${d.devoirs.map((h) => `
            <div class="carte devoir-carte-mini ${h.fait ? "fait" : ""}">
              <div class="devoir-entete">
                <span class="devoir-matiere">${escHtml(h.matiere)}</span>
                ${h.custom ? '<span class="badge-custom">ajouté par toi</span>' : ""}
              </div>
              <div class="devoir-desc">${escHtml(h.description)}</div>
            </div>
          `).join("")}
        </div>
      `;
    }

    corps.innerHTML = html;
  } catch (e) {
    corps.innerHTML = `<div class="centre-info">Erreur de chargement.</div>`;
  }
}

document.getElementById("btn-fermer-cours-contenu").addEventListener("click", () => {
  document.getElementById("modale-cours-contenu").classList.remove("ouverte");
});
document.getElementById("modale-cours-contenu").addEventListener("click", (e) => {
  if (e.target.id === "modale-cours-contenu") e.target.classList.remove("ouverte");
});

// ══════════════════════ Devoirs ═══════════════════════════════════════
document.getElementById("dev-prec").addEventListener("click", () => { offsetDevoirs--; chargerDevoirs(); });
document.getElementById("dev-suiv").addEventListener("click", () => { offsetDevoirs++; chargerDevoirs(); });

function _parseDateDevoir(dateStr) {
  // Format reçu de l'API : "dd/mm/YYYY"
  const [j, m, a] = dateStr.split("/").map(Number);
  return new Date(a, m - 1, j);
}

const _JOURS_SEMAINE = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

function _libelleJourDevoir(date, aujourdhui) {
  const diffJours = Math.round((date - aujourdhui) / 86400000);
  if (diffJours === 0) return "Aujourd'hui";
  if (diffJours === 1) return "Demain";
  if (diffJours === -1) return "Hier";
  return _JOURS_SEMAINE[date.getDay()];
}

let devoirsDataBrute = null;     // dernière réponse de /api/devoirs, non filtrée
let devoirsFiltreActif = "tous"; // tous | a-faire | faits | haute | moyenne | basse

async function chargerDevoirs() {
  const r = await fetch("/api/devoirs?offset=" + offsetDevoirs);
  const data = await r.json();
  if (!data.pret) return;

  document.getElementById("dev-libelle-semaine").textContent =
    offsetDevoirs === 0 ? "Cette semaine" : `Semaine du ${data.semaine_du}`;

  devoirsDataBrute = data;
  afficherDevoirs();
}

function afficherDevoirs() {
  const data = devoirsDataBrute;
  if (!data) return;

  const conteneur = document.getElementById("liste-devoirs");
  const resume = document.getElementById("devoirs-resume");

  if (data.devoirs.length === 0) {
    resume.innerHTML = "";
    conteneur.innerHTML = '<div class="carte centre-info"><div class="emoji">🎉</div>Aucun devoir sur cette période.</div>';
    return;
  }

  const aujourdhui = new Date();
  aujourdhui.setHours(0, 0, 0, 0);

  // ── Résumé (total, faits, en retard) — toujours sur l'ensemble, pas le filtre ──
  const total = data.devoirs.length;
  const nbFaits = data.devoirs.filter((d) => d.fait).length;
  const nbRetard = data.devoirs.filter((d) => !d.fait && _parseDateDevoir(d.date) < aujourdhui).length;
  const pctFaits = total > 0 ? Math.round((nbFaits / total) * 100) : 0;

  resume.innerHTML = `
    <div class="carte devoirs-resume">
      <span class="devoirs-resume__total">${total} devoir${total > 1 ? "s" : ""}</span>
      <div class="devoirs-resume__barre"><div class="devoirs-resume__barre-remplie" style="width:${pctFaits}%"></div></div>
      <span class="devoirs-resume__stat devoirs-resume__stat--faits">${nbFaits} fait${nbFaits > 1 ? "s" : ""}</span>
      ${nbRetard > 0 ? `<span class="devoirs-resume__stat devoirs-resume__stat--retard">⚠️ ${nbRetard} en retard</span>` : ""}
    </div>
  `;

  // ── Filtre actif ──
  const devoirsFiltres = data.devoirs.filter((d) => {
    if (devoirsFiltreActif === "tous") return true;
    if (devoirsFiltreActif === "a-faire") return !d.fait;
    if (devoirsFiltreActif === "faits") return d.fait;
    return (d.priorite || "moyenne") === devoirsFiltreActif;
  });

  if (devoirsFiltres.length === 0) {
    conteneur.innerHTML = '<div class="carte centre-info"><div class="emoji">🔍</div>Aucun devoir ne correspond à ce filtre.</div>';
    return;
  }

  // ── Groupement par jour (chronologique) ──
  const groupes = new Map(); // clé "YYYY-MM-DD" -> { date, devoirs: [] }
  devoirsFiltres.forEach((d) => {
    const date = _parseDateDevoir(d.date);
    const cle = date.toISOString().slice(0, 10);
    if (!groupes.has(cle)) groupes.set(cle, { date, devoirs: [] });
    groupes.get(cle).devoirs.push(d);
  });
  const cles = [...groupes.keys()].sort();

  conteneur.innerHTML = cles.map((cle) => {
    const { date, devoirs } = groupes.get(cle);
    const estAujourdhui = date.getTime() === aujourdhui.getTime();
    const estRetard = date < aujourdhui;
    const classeJour = estAujourdhui ? "aujourdhui" : estRetard ? "retard" : "";

    return `
      <div class="devoirs-groupe">
        <div class="devoirs-groupe__entete">
          <span class="devoirs-groupe__jour ${classeJour}">${_libelleJourDevoir(date, aujourdhui)}</span>
          <span class="devoirs-groupe__date">${date.toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}</span>
        </div>
        <div class="devoirs-groupe__liste">
          ${devoirs.map((d) => {
            const enRetard = !d.fait && date < aujourdhui;
            const couleur = couleurMatiere(d.matiere);
            const priorite = d.priorite || "moyenne";
            const PRIORITE_INFO = {
              haute:   { emoji: "🔴", label: "Haute",   couleur: "#ef4444" },
              moyenne: { emoji: "🟠", label: "Moyenne", couleur: "#f59e0b" },
              basse:   { emoji: "🟢", label: "Basse",   couleur: "#10b981" },
            };
            const pInfo = PRIORITE_INFO[priorite];
            return `
              <div class="carte devoir-carte ${d.fait ? "fait" : ""} ${enRetard ? "en-retard" : ""}" data-id="${escHtml(d.id)}" data-custom="${d.custom ? "1" : "0"}" style="--c:${couleur}">
                <div class="devoir-check ${d.fait ? "fait" : ""}">${d.fait ? "✓" : ""}</div>
                <div class="devoir-corps">
                  <div class="devoir-entete">
                    <span class="devoir-matiere">${escHtml(d.matiere)}</span>
                    <span class="badge-priorite" data-id="${escHtml(d.id)}" data-custom="${d.custom ? "1" : "0"}" data-priorite="${priorite}" title="Changer la priorité" style="background:${pInfo.couleur}22;color:${pInfo.couleur};">${pInfo.emoji} ${pInfo.label}</span>
                    ${enRetard ? '<span class="badge-retard">En retard</span>' : ""}
                    ${d.custom ? '<span class="badge-custom">ajouté par toi</span>' : ""}
                  </div>
                  <div class="devoir-desc">${escHtml(d.description)}</div>
                </div>
                ${d.custom ? '<button class="icon-btn devoir-supprimer" title="Supprimer ce devoir">✕</button>' : ""}
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }).join("");

  conteneur.querySelectorAll(".devoir-check").forEach((el) => {
    el.addEventListener("click", async () => {
      const carte = el.closest(".devoir-carte");
      const id = carte.dataset.id;
      const estCustom = carte.dataset.custom === "1";
      const nouvelEtat = !carte.classList.contains("fait");

      carte.classList.toggle("fait", nouvelEtat);
      el.classList.toggle("fait", nouvelEtat);
      el.textContent = nouvelEtat ? "✓" : "";

      const url = estCustom
        ? `/api/devoirs/custom/${encodeURIComponent(id)}/fait`
        : `/api/devoirs/${encodeURIComponent(id)}/fait`;

      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fait: nouvelEtat }),
        });
        const res = await resp.json();
        if (!res.ok) throw new Error(res.erreur || "échec");
        chargerDevoirs(); // resynchronise résumé + badge "en retard"
      } catch (e) {
        alert("Impossible de mettre à jour ce devoir : " + e.message);
        carte.classList.toggle("fait", !nouvelEtat);
        el.classList.toggle("fait", !nouvelEtat);
        el.textContent = !nouvelEtat ? "✓" : "";
      }
    });
  });

  conteneur.querySelectorAll(".devoir-supprimer").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const carte = btn.closest(".devoir-carte");
      const id = carte.dataset.id;
      if (!confirm("Supprimer ce devoir ajouté manuellement ?")) return;
      try {
        const resp = await fetch(`/api/devoirs/custom/${encodeURIComponent(id)}`, { method: "DELETE" });
        const res = await resp.json();
        if (!res.ok) throw new Error(res.erreur || "échec");
        chargerDevoirs();
      } catch (e) {
        alert("Impossible de supprimer ce devoir : " + e.message);
      }
    });
  });

  conteneur.querySelectorAll(".badge-priorite").forEach((badge) => {
    badge.addEventListener("click", async (e) => {
      e.stopPropagation();
      const id = badge.dataset.id;
      const estCustom = badge.dataset.custom === "1";
      const cycle = { haute: "moyenne", moyenne: "basse", basse: "haute" };
      const nouvellePriorite = cycle[badge.dataset.priorite] || "moyenne";

      const url = estCustom
        ? `/api/devoirs/custom/${encodeURIComponent(id)}/priorite`
        : `/api/devoirs/${encodeURIComponent(id)}/priorite`;
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ priorite: nouvellePriorite }),
        });
        const res = await resp.json();
        if (!res.ok) throw new Error(res.erreur || "échec");
        // Met à jour la donnée en mémoire et ré-affiche (pas besoin de refetch réseau)
        const d = devoirsDataBrute.devoirs.find((d) => String(d.id) === String(id));
        if (d) d.priorite = nouvellePriorite;
        afficherDevoirs();
      } catch (e) {
        alert("Impossible de changer la priorité : " + e.message);
      }
    });
  });
}

// ══════════════ Filtres (Tous / À faire / Faits / Priorité) ════════════
document.getElementById("devoirs-filtres")?.addEventListener("click", (e) => {
  const btn = e.target.closest(".devoirs-filtre");
  if (!btn) return;
  document.querySelectorAll(".devoirs-filtre").forEach((b) => b.classList.remove("actif"));
  btn.classList.add("actif");
  devoirsFiltreActif = btn.dataset.filtre;
  afficherDevoirs();
});

// ══════════════ Ajout d'un devoir custom ═══════════════════════════════
document.getElementById("btn-ajouter-devoir").addEventListener("click", () => {
  document.getElementById("nouveau-devoir-matiere").value = "";
  document.getElementById("nouveau-devoir-description").value = "";
  const today = new Date();
  document.getElementById("nouveau-devoir-date").value = today.toISOString().slice(0, 10);
  document.getElementById("modale-nouveau-devoir").classList.add("ouverte");
});
document.getElementById("btn-annuler-nouveau-devoir").addEventListener("click", () => {
  document.getElementById("modale-nouveau-devoir").classList.remove("ouverte");
});
document.getElementById("btn-enregistrer-nouveau-devoir").addEventListener("click", async () => {
  const matiere = document.getElementById("nouveau-devoir-matiere").value.trim();
  const description = document.getElementById("nouveau-devoir-description").value.trim();
  const date_iso = document.getElementById("nouveau-devoir-date").value;
  const priorite = document.getElementById("nouveau-devoir-priorite").value;

  if (!matiere || !description || !date_iso) {
    alert("Merci de remplir la matière, la description et la date.");
    return;
  }

  try {
    const resp = await fetch("/api/devoirs/custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matiere, description, date_iso, priorite }),
    });
    const res = await resp.json();
    if (!res.ok) throw new Error(res.erreur || "échec");
    document.getElementById("modale-nouveau-devoir").classList.remove("ouverte");
    chargerDevoirs();
  } catch (e) {
    alert("Impossible d'ajouter ce devoir : " + e.message);
  }
});

// ══════════════════════ Absences / retards ═══════════════════════════
document.getElementById("btn-select-periode-absences").addEventListener("click", () => {
  ouvrirFeuillePeriode("absences");
});

async function chargerAbsences() {
  const r = await fetch("/api/absences?periode=" + encodeURIComponent(periodeAbsencesChoisie));
  const data = await r.json();
  if (!data.pret) return;

  document.getElementById("total-heures-absence").textContent =
    data.total_heures_absence ? `${data.total_heures_absence}h` : "0h";

  periodesAbsencesDisponibles = data.periodes || [];
  if (!periodeAbsencesChoisie) periodeAbsencesChoisie = data.periode || "";
  document.getElementById("lbl-select-periode-absences").textContent = data.periode || "Période";

  const conteneurAbs = document.getElementById("liste-absences");
  if (data.absences.length === 0) {
    conteneurAbs.innerHTML = '<div class="vide">Aucune absence sur cette période 🎉</div>';
  } else {
    conteneurAbs.innerHTML = data.absences.map((a) => `
      <div class="ligne-absence">
        <div class="absence-icone ${a.justifiee ? "ok" : ""}">🚪</div>
        <div class="absence-corps">
          <div class="absence-periode">${escHtml(a.debut)} → ${escHtml(a.fin)}</div>
          <div class="absence-motifs">${escHtml(a.motifs.join(", ") || "Aucun motif renseigné")} · ${escHtml(a.heures)}h</div>
        </div>
        <span class="badge-justif ${a.justifiee ? "oui" : "non"}">${a.justifiee ? "Justifiée" : "Non justifiée"}</span>
      </div>
    `).join("");
  }

  const conteneurRet = document.getElementById("liste-retards");
  if (data.retards.length === 0) {
    conteneurRet.innerHTML = '<div class="vide">Aucun retard sur cette période 🎉</div>';
  } else {
    conteneurRet.innerHTML = data.retards.map((rt) => `
      <div class="ligne-absence">
        <div class="absence-icone ${rt.justifie ? "ok" : ""}">⏰</div>
        <div class="absence-corps">
          <div class="absence-periode">${escHtml(rt.date)}</div>
          <div class="absence-motifs">${rt.minutes} min · ${escHtml(rt.motifs.join(", ") || rt.justification || "Aucun motif renseigné")}</div>
        </div>
        <span class="badge-justif ${rt.justifie ? "oui" : "non"}">${rt.justifie ? "Justifié" : "Non justifié"}</span>
      </div>
    `).join("");
  }

  const conteneurPun = document.getElementById("liste-punitions");
  if (!data.punitions || data.punitions.length === 0) {
    conteneurPun.innerHTML = '<div class="vide">Aucune punition sur cette période 🎉</div>';
  } else {
    conteneurPun.innerHTML = data.punitions.map((p) => `
      <div class="ligne-absence">
        <div class="absence-icone ${p.exclusion ? "" : "ok"}">📌</div>
        <div class="absence-corps">
          <div class="absence-periode">${escHtml(p.date)} — ${escHtml(p.nature || "Punition")}${p.exclusion ? " (exclusion)" : ""}</div>
          <div class="absence-motifs">${escHtml((p.motifs || []).join(", ") || "Aucun motif renseigné")}${p.donneur ? " · par " + escHtml(p.donneur) : ""}</div>
          ${p.circonstances ? `<div class="absence-motifs">${escHtml(p.circonstances)}</div>` : ""}
          ${p.devoir ? `<div class="absence-motifs">Travail à faire : ${escHtml(p.devoir)}</div>` : ""}
        </div>
      </div>
    `).join("");
  }
}

// ══════════════════════ Actualités (avec pièces jointes) ══════════════
function icônePourNomFichier(nom) {
  const ext = (nom.split(".").pop() || "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) return "🖼️";
  if (ext === "pdf") return "📕";
  if (["doc", "docx"].includes(ext)) return "📄";
  if (["xls", "xlsx"].includes(ext)) return "📊";
  if (["ppt", "pptx"].includes(ext)) return "📽️";
  if (ext === "zip" || ext === "rar") return "🗜️";
  return "📎";
}

// État de la liste + recherche
let actusToutes = [];
let actusResultatsContenu = null; // Map<id, {ou, extrait}> après une recherche dans le contenu

async function chargerActualites() {
  const r = await fetch("/api/actualites");
  const data = await r.json();
  if (!data.pret) return;
  actusToutes = data.actualites || [];
  rendreActualites();
}

function actusFiltrees() {
  const texte = document.getElementById("recherche-actus").value.trim();
  if (!texte) return { liste: actusToutes, texte: "" };
  if (actusResultatsContenu) {
    return { liste: actusToutes.filter((a) => actusResultatsContenu.has(String(a.id))), texte };
  }
  const q = normaliser(texte);
  return {
    liste: actusToutes.filter((a) => normaliser(`${a.titre} ${a.auteur} ${a.categorie}`).includes(q)),
    texte,
  };
}

function rendreActualites() {
  const conteneur = document.getElementById("liste-actualites");
  const { liste, texte } = actusFiltrees();
  const statut = document.getElementById("recherche-actus-statut");
  statut.hidden = !texte;
  if (texte) statut.textContent = `${liste.length} résultat(s) pour « ${texte} »`
    + (actusResultatsContenu ? " (titre et contenu)" : " (titre, auteur, catégorie)");

  if (actusToutes.length === 0) {
    conteneur.innerHTML = '<div class="carte centre-info"><div class="emoji">📭</div>Aucune actualité pour le moment.</div>';
    return;
  }
  if (liste.length === 0) {
    conteneur.innerHTML = '<div class="carte centre-info"><div class="emoji">🔍</div>Aucune actualité ne correspond.</div>';
    return;
  }

  conteneur.innerHTML = liste.map((a) => {
    const trouve = actusResultatsContenu ? actusResultatsContenu.get(String(a.id)) : null;
    return `
    <div class="carte actu-carte ${!a.lu ? "actu-non-lue" : ""}" data-id="${escHtml(a.id)}">
      <div class="actu-entete">
        <span class="actu-titre">${texte ? surligner(a.titre, texte) : escHtml(a.titre)}</span>
        <span class="actu-meta">${escHtml(a.date)}</span>
      </div>
      <div class="actu-meta">
        <span class="actu-categorie">${escHtml(a.categorie)}</span>
        ${escHtml(a.auteur)}${a.sondage ? " · 📊 Sondage" : ""}
      </div>
      ${trouve && trouve.extrait ? `<div class="recherche-extrait">${surligner(trouve.extrait, texte)}</div>` : ""}
      <div class="actu-contenu" id="contenu-actu-${escHtml(a.id)}"></div>
    </div>`;
  }).join("");

  conteneur.querySelectorAll(".actu-carte").forEach((carte) => {
    carte.addEventListener("click", async () => {
      const id = carte.dataset.id;
      const zone = document.getElementById("contenu-actu-" + id);
      const dejaOuvert = zone.classList.contains("ouvert");

      conteneur.querySelectorAll(".actu-contenu.ouvert").forEach((z) => {
        if (z !== zone) z.classList.remove("ouvert");
      });

      if (dejaOuvert) {
        zone.classList.remove("ouvert");
        return;
      }

      if (!zone.dataset.charge) {
        zone.innerHTML = '<div class="spinner" style="margin:10px auto;"></div>';
        zone.classList.add("ouvert");
        try {
          const resp = await fetch(`/api/actualites/${encodeURIComponent(id)}/contenu`);
          const res = await resp.json();
          if (!res.ok) {
            zone.innerHTML = "Impossible de charger le contenu.";
          } else {
            let html = res.contenu || "<em>(contenu vide)</em>";
            if (res.pieces_jointes && res.pieces_jointes.length > 0) {
              html += `
                <div class="actu-pieces-jointes">
                  <div class="actu-pieces-jointes__titre">📎 Pièces jointes (${res.pieces_jointes.length})</div>
                  ${res.pieces_jointes.map((p) => `
                    <a class="piece-jointe" href="${escHtml(p.url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation();">
                      <span class="piece-jointe__icone">${p.type === 0 ? "🔗" : icônePourNomFichier(p.nom)}</span>
                      <span class="piece-jointe__nom">${escHtml(p.nom)}</span>
                      <span class="piece-jointe__type">${p.type === 0 ? "Lien" : "Fichier"}</span>
                    </a>
                  `).join("")}
                </div>
              `;
            }
            zone.innerHTML = html;
          }
          zone.dataset.charge = "1";
        } catch (e) {
          zone.innerHTML = "Erreur de chargement.";
        }
      } else {
        zone.classList.add("ouvert");
      }

      // Bouton "J'ai pris connaissance" : ajouté après chargement, retiré si déjà lu
      if (!carte.classList.contains("actu-non-lue")) return;
      if (!zone.querySelector(".btn-actu-lue")) {
        const btn = document.createElement("button");
        btn.className = "btn petit btn-actu-lue";
        btn.textContent = "✓ J'ai pris connaissance";
        btn.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          btn.disabled = true;
          try {
            const resp = await fetch(`/api/actualites/${encodeURIComponent(id)}/lue`, { method: "POST" });
            const res = await resp.json();
            if (!res.ok) throw new Error(res.erreur || "échec");
            carte.classList.remove("actu-non-lue");
            btn.remove();
            rafraichirBadges();
          } catch (e) {
            btn.disabled = false;
            alert("Impossible de marquer cette actualité comme lue : " + e.message);
          }
        });
        zone.appendChild(btn);
      }
    });
  });
}

// Recherche : filtrage instantané (titre/auteur/catégorie) à la frappe,
// recherche dans le contenu sur Entrée ou via le bouton.
document.getElementById("recherche-actus").addEventListener("input", () => {
  actusResultatsContenu = null;
  rendreActualites();
});
async function rechercherActusContenu() {
  const texte = document.getElementById("recherche-actus").value.trim();
  if (texte.length < 2) return;
  const statut = document.getElementById("recherche-actus-statut");
  statut.hidden = false;
  statut.textContent = "Lecture du contenu des actualités…";
  try {
    const d = await (await fetch(`/api/recherche?portee=actus&q=${encodeURIComponent(texte)}`)).json();
    if (d.erreur) throw new Error(d.erreur);
    actusResultatsContenu = new Map((d.resultats || []).map((x) => [String(x.id), x]));
    rendreActualites();
    if (d.partiel) statut.textContent += " — seules les 60 plus récentes ont été lues en entier";
  } catch (e) {
    statut.textContent = "Recherche impossible : " + e.message;
  }
}
document.getElementById("recherche-actus").addEventListener("keydown", (e) => {
  if (e.key === "Enter") rechercherActusContenu();
});
document.getElementById("btn-recherche-actus-contenu").addEventListener("click", rechercherActusContenu);

document.getElementById("btn-actus-tout-lu").addEventListener("click", async () => {
  const btn = document.getElementById("btn-actus-tout-lu");
  if (!confirm("Marquer toutes les actualités non lues comme lues ?")) return;
  btn.disabled = true;
  const libelle = btn.textContent;
  btn.textContent = "…";
  try {
    const d = await (await fetch("/api/actualites/tout_lu", { method: "POST" })).json();
    if (d.total === 0) toast("Rien à marquer", "Toutes les actualités sont déjà lues.");
    else if (d.ok) toast(`${d.reussies} actualité(s) marquée(s) comme lue(s) ✓`);
    else toast(`${d.reussies}/${d.total} marquée(s)`, `${d.echecs.length} échec(s) — voir les logs [actus].`);
  } catch (e) {
    toast("Échec", e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = libelle;
    chargerActualites();
    rafraichirBadges();
  }
});

// ══════════════════════ Messagerie ════════════════════════════════════
let discussionsToutes = [];
let discussionsResultatsContenu = null; // Map<String(id), {ou, extrait}> après recherche dans le contenu

async function chargerDiscussions() {
  const conteneur = document.getElementById("liste-discussions");
  let data;
  try {
    const r = await fetch("/api/discussions");
    data = await r.json();
  } catch (e) {
    console.error("Erreur réseau discussions", e);
    conteneur.innerHTML = '<div class="centre-info">Erreur réseau. <button class="btn petit" id="btn-retry-disc">Réessayer</button></div>';
    document.getElementById("btn-retry-disc")?.addEventListener("click", () => { vuesDejaChargees.delete("messagerie"); chargerDiscussions(); });
    return;
  }

  if (!data.pret) {
    // Client Pronote pas encore prêt : on retente tant que la vue est active.
    conteneur.innerHTML = '<div class="centre-info"><div class="spinner"></div>Connexion à PRONOTE en cours…</div>';
    vuesDejaChargees.delete("messagerie");
    if (document.getElementById("vue-messagerie")?.classList.contains("actif")) {
      setTimeout(() => { vuesDejaChargees.add("messagerie"); chargerDiscussions(); }, 2000);
    }
    return;
  }

  if (data.erreur) {
    conteneur.innerHTML = `<div class="centre-info">Erreur : ${escHtml(data.erreur)} <button class="btn petit" id="btn-retry-disc">Réessayer</button></div>`;
    document.getElementById("btn-retry-disc")?.addEventListener("click", () => { vuesDejaChargees.delete("messagerie"); chargerDiscussions(); });
    return;
  }
  discussionsToutes = data.discussions || [];
  rendreDiscussions();
}

function discussionsFiltrees() {
  const texte = document.getElementById("recherche-messages").value.trim();
  if (!texte) return { liste: discussionsToutes, texte: "" };
  if (discussionsResultatsContenu) {
    return { liste: discussionsToutes.filter((d) => discussionsResultatsContenu.has(String(d.id))), texte };
  }
  const q = normaliser(texte);
  return { liste: discussionsToutes.filter((d) => normaliser(`${d.sujet} ${d.createur}`).includes(q)), texte };
}

function rendreDiscussions() {
  const conteneur = document.getElementById("liste-discussions");
  const { liste, texte } = discussionsFiltrees();
  const statut = document.getElementById("recherche-messages-statut");
  statut.hidden = !texte;
  if (texte) statut.textContent = `${liste.length} résultat(s)` + (discussionsResultatsContenu ? " (objet et contenu)" : " (objet, auteur)");

  const entete = `
    <div class="messagerie-liste__entete">
      <h3>Discussions</h3>
      <button class="btn petit" id="btn-nouveau-message">+ Nouveau</button>
    </div>`;

  if (discussionsToutes.length === 0 || liste.length === 0) {
    conteneur.innerHTML = entete + `<div class="centre-info"><div class="emoji">${texte ? "🔍" : "💬"}</div>${texte ? "Aucune discussion ne correspond." : "Aucune discussion."}</div>`;
    document.getElementById("btn-nouveau-message").addEventListener("click", () => ouvrirModaleNouveauMessage());
    return;
  }

  conteneur.innerHTML = entete + liste.map((d) => {
    const trouve = discussionsResultatsContenu ? discussionsResultatsContenu.get(String(d.id)) : null;
    return `
      <div class="disc-item ${String(d.id) === String(discussionActiveId) ? "actif" : ""}" data-id="${escHtml(d.id)}">
        <div class="disc-sujet">
          <span>${texte ? surligner(d.sujet, texte) : escHtml(d.sujet)}</span>
          ${d.non_lus > 0 ? `<span class="pastille-badge">${d.non_lus}</span>` : ""}
        </div>
        <div class="disc-meta">
          <span>${escHtml(d.createur)}</span>
          <span>${escHtml(d.date)}</span>
        </div>
        ${trouve && trouve.extrait ? `<div class="disc-extrait">${surligner(trouve.extrait, texte)}</div>` : ""}
        <div class="disc-actions">
          ${d.non_lus > 0
            ? `<button type="button" data-action="lue" title="Marquer comme lue">✓ Marquer lue</button>`
            : `<button type="button" data-action="non_lue" title="Marquer comme non lue">● Marquer non lue</button>`}
        </div>
      </div>`;
  }).join("");

  document.getElementById("btn-nouveau-message").addEventListener("click", () => ouvrirModaleNouveauMessage());

  conteneur.querySelectorAll(".disc-item").forEach((el) => {
    el.addEventListener("click", () => {
      conteneur.querySelectorAll(".disc-item").forEach((e2) => e2.classList.remove("actif"));
      el.classList.add("actif");
      discussionActiveId = el.dataset.id;
      chargerFilDiscussion(discussionActiveId);
    });
    el.querySelector(".disc-actions button")?.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const action = ev.currentTarget.dataset.action;
      ev.currentTarget.disabled = true;
      try {
        const res = await (await fetch(`/api/discussions/${encodeURIComponent(el.dataset.id)}/${action === "lue" ? "lue" : "non_lue"}`, { method: "POST" })).json();
        if (!res.ok) throw new Error(res.erreur || "échec");
      } catch (e) {
        toast("Action impossible", e.message);
      }
      chargerDiscussions();
      rafraichirBadges();
    });
  });
}

document.getElementById("recherche-messages").addEventListener("input", () => {
  discussionsResultatsContenu = null;
  rendreDiscussions();
});
async function rechercherMessagesContenu() {
  const texte = document.getElementById("recherche-messages").value.trim();
  if (texte.length < 2) return;
  const statut = document.getElementById("recherche-messages-statut");
  statut.hidden = false;
  statut.textContent = "Lecture des discussions…";
  try {
    const d = await (await fetch(`/api/recherche?portee=messages&q=${encodeURIComponent(texte)}`)).json();
    if (d.erreur) throw new Error(d.erreur);
    discussionsResultatsContenu = new Map((d.resultats || []).map((x) => [String(x.id), x]));
    rendreDiscussions();
    if (d.partiel) statut.textContent += " — seules les 60 premières discussions ont été lues en entier";
  } catch (e) {
    statut.textContent = "Recherche impossible : " + e.message;
  }
}
document.getElementById("recherche-messages").addEventListener("keydown", (e) => {
  if (e.key === "Enter") rechercherMessagesContenu();
});
document.getElementById("btn-recherche-messages-contenu").addEventListener("click", rechercherMessagesContenu);

document.getElementById("btn-messages-tout-lu").addEventListener("click", async () => {
  const btn = document.getElementById("btn-messages-tout-lu");
  if (!confirm("Marquer toutes les discussions comme lues ?")) return;
  btn.disabled = true;
  try {
    const d = await (await fetch("/api/discussions/tout_lu", { method: "POST" })).json();
    if (d.reussies === 0 && d.ok) toast("Rien à marquer", "Toutes les discussions sont déjà lues.");
    else if (d.ok) toast(`${d.reussies} discussion(s) marquée(s) comme lue(s) ✓`);
    else toast("Marquage partiel", `${d.echecs.length} échec(s).`);
  } catch (e) {
    toast("Échec", e.message);
  } finally {
    btn.disabled = false;
    chargerDiscussions();
    rafraichirBadges();
  }
});

async function chargerFilDiscussion(id) {
  const fil = document.getElementById("fil-discussion");
  fil.innerHTML = '<div class="centre-info"><div class="spinner"></div></div>';

  const r = await fetch(`/api/discussions/${encodeURIComponent(id)}/messages`);
  const data = await r.json();
  if (!data.ok) {
    fil.innerHTML = `<div class="centre-info">Impossible de charger cette discussion.</div>`;
    return;
  }

  // Marque la discussion comme lue sur PRONOTE si elle a des messages non lus
  const itemListe = document.querySelector(`.disc-item[data-id="${CSS.escape(String(id))}"]`);
  const pastille = itemListe ? itemListe.querySelector(".pastille-badge") : null;
  if (pastille) {
    try {
      const resp = await fetch(`/api/discussions/${encodeURIComponent(id)}/lue`, { method: "POST" });
      const res = await resp.json();
      if (res.ok) {
        pastille.remove();
        rafraichirBadges();
      }
    } catch (e) {
      console.error("Erreur marquage discussion lue", e);
    }
  }

  fil.innerHTML = `
    <div class="fil-entete">${escHtml(data.sujet)}</div>
    <div class="fil-messages" id="fil-messages"></div>
    ${data.ferme
      ? '<div class="vide" style="text-align:center;padding-top:12px;">Cette discussion est fermée.</div>'
      : `<div class="fil-reponse">
          <textarea id="champ-reponse" placeholder="Écrire une réponse…"></textarea>
          <button class="btn" id="btn-envoyer-reponse">Envoyer</button>
        </div>`
    }
  `;

  const zoneMsgs = document.getElementById("fil-messages");
  zoneMsgs.innerHTML = data.messages.map((m) => `
    <div class="bulle ${m.moi ? "moi" : "eux"}">
      ${!m.moi ? `<div class="bulle-auteur">${escHtml(m.auteur)}</div>` : ""}
      <div class="bulle-contenu">${m.contenu}</div>
      <div class="bulle-date">${escHtml(m.date)}</div>
    </div>
  `).join("");
  zoneMsgs.scrollTop = zoneMsgs.scrollHeight;

  const btnEnvoyer = document.getElementById("btn-envoyer-reponse");
  if (btnEnvoyer) {
    btnEnvoyer.addEventListener("click", async () => {
      const champ = document.getElementById("champ-reponse");
      const texte = champ.value.trim();
      if (!texte) return;
      btnEnvoyer.disabled = true;
      btnEnvoyer.textContent = "…";
      try {
        const resp = await fetch(`/api/discussions/${encodeURIComponent(id)}/repondre`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: texte }),
        });
        const res = await resp.json();
        if (!res.ok) throw new Error(res.erreur || "échec");
        champ.value = "";
        chargerFilDiscussion(id);
        chargerDiscussions();
      } catch (e) {
        alert("Impossible d'envoyer le message : " + e.message);
      } finally {
        btnEnvoyer.disabled = false;
        btnEnvoyer.textContent = "Envoyer";
      }
    });
  }
}

// ── Nouveau message (façon "bot pronote", choix du/des destinataire·s) ──
async function ouvrirModaleNouveauMessage(preselection = []) {
  // Appelée aussi comme gestionnaire de clic : on ignore alors l'événement.
  if (!Array.isArray(preselection)) preselection = [];
  const modale = document.getElementById("modale-nouveau-message");
  modale.classList.add("ouverte");

  destinatairesSelectionnes.clear();
  document.getElementById("destinataires-choisis").innerHTML = "";
  document.getElementById("nouveau-message-objet").value = "";
  document.getElementById("nouveau-message-contenu").value = "";
  document.getElementById("recherche-destinataire").value = "";

  const listeEl = document.getElementById("liste-destinataires-dispo");
  listeEl.innerHTML = '<div class="centre-info"><div class="spinner"></div>Chargement des destinataires…</div>';

  try {
    const r = await fetch("/api/destinataires");
    const data = await r.json();
    if (!data.ok) throw new Error(data.erreur || "échec");
    destinatairesDisponibles = data.destinataires;
    preselection.forEach((id) => {
      const dest = destinatairesDisponibles.find((d) => d.id === id);
      if (dest) destinatairesSelectionnes.set(dest.id, dest);
    });
    afficherDestinatairesChoisis();
    afficherListeDestinataires("");
  } catch (e) {
    listeEl.innerHTML = `<div class="centre-info">Impossible de charger les destinataires : ${escHtml(e.message)}</div>`;
  }
}

function afficherListeDestinataires(filtre) {
  const listeEl = document.getElementById("liste-destinataires-dispo");
  const f = filtre.trim().toLowerCase();
  const filtres = destinatairesDisponibles.filter((d) =>
    !f || d.nom.toLowerCase().includes(f) || (d.fonctions || []).join(" ").toLowerCase().includes(f)
  );

  if (filtres.length === 0) {
    listeEl.innerHTML = '<div class="centre-info" style="padding:24px;">Aucun destinataire trouvé.</div>';
    return;
  }

  listeEl.innerHTML = filtres.map((d) => `
    <div class="destinataire-option ${destinatairesSelectionnes.has(d.id) ? "selectionne" : ""}" data-id="${escHtml(d.id)}">
      <div>
        <div class="destinataire-option__nom">${escHtml(d.nom)}</div>
        <div class="destinataire-option__fonction">${escHtml((d.fonctions || []).join(", ") || (d.type === "teacher" ? "Professeur" : "Personnel"))}</div>
      </div>
      <span>${destinatairesSelectionnes.has(d.id) ? "✓" : "+"}</span>
    </div>
  `).join("");

  listeEl.querySelectorAll(".destinataire-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      const id = opt.dataset.id;
      const dest = destinatairesDisponibles.find((d) => d.id === id);
      if (!dest) return;
      if (destinatairesSelectionnes.has(id)) {
        destinatairesSelectionnes.delete(id);
      } else {
        destinatairesSelectionnes.set(id, dest);
      }
      afficherDestinatairesChoisis();
      afficherListeDestinataires(document.getElementById("recherche-destinataire").value);
    });
  });
}

function afficherDestinatairesChoisis() {
  const zone = document.getElementById("destinataires-choisis");
  if (destinatairesSelectionnes.size === 0) {
    zone.innerHTML = '<span style="font-size:12.5px;color:var(--text-muted);">Aucun destinataire sélectionné.</span>';
    return;
  }
  zone.innerHTML = [...destinatairesSelectionnes.values()].map((d) => `
    <span class="destinataire-chip" data-id="${escHtml(d.id)}">
      ${escHtml(d.nom)}
      <button type="button" data-retirer="${escHtml(d.id)}">✕</button>
    </span>
  `).join("");
  zone.querySelectorAll("button[data-retirer]").forEach((btn) => {
    btn.addEventListener("click", () => {
      destinatairesSelectionnes.delete(btn.dataset.retirer);
      afficherDestinatairesChoisis();
      afficherListeDestinataires(document.getElementById("recherche-destinataire").value);
    });
  });
}

document.getElementById("recherche-destinataire").addEventListener("input", (e) => {
  afficherListeDestinataires(e.target.value);
});

document.getElementById("btn-annuler-nouveau-message").addEventListener("click", () => {
  document.getElementById("modale-nouveau-message").classList.remove("ouverte");
});

document.getElementById("modale-nouveau-message").addEventListener("click", (e) => {
  if (e.target.id === "modale-nouveau-message") {
    e.currentTarget.classList.remove("ouverte");
  }
});

document.getElementById("btn-envoyer-nouveau-message").addEventListener("click", async () => {
  const btn = document.getElementById("btn-envoyer-nouveau-message");
  const objet = document.getElementById("nouveau-message-objet").value.trim();
  const contenu = document.getElementById("nouveau-message-contenu").value.trim();
  const destinataires = [...destinatairesSelectionnes.keys()];

  if (destinataires.length === 0) {
    alert("Choisis au moins un destinataire.");
    return;
  }
  if (!contenu) {
    alert("Le message ne peut pas être vide.");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Envoi…";
  try {
    const resp = await fetch("/api/discussions/nouveau", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ objet, message: contenu, destinataires }),
    });
    const res = await resp.json();
    if (!res.ok) throw new Error(res.erreur || "échec");

    document.getElementById("modale-nouveau-message").classList.remove("ouverte");
    vuesDejaChargees.delete("messagerie");
    chargerDiscussions();
  } catch (e) {
    alert("Impossible d'envoyer le message : " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Envoyer";
  }
});

// ══════════════════════ Assistant IA (onglet + bulle flottante) ═══════
// Les deux interfaces (onglet dédié et bulle flottante) partagent le même
// historique de conversation côté serveur (/api/assistant). Côté front, on
// duplique juste l'affichage dans les deux fils pour rester synchro visuel.

function bulleAssistantHtml(role, texte, classesExtra = "") {
  const estUser = role === "user";
  return `
    <div class="assistant-msg ${estUser ? "assistant-msg--user" : "assistant-msg--bot"}">
      <div class="assistant-msg__bulle ${classesExtra}">${estUser ? escHtml(texte) : formaterReponseAssistant(texte)}</div>
    </div>
  `;
}

function formaterReponseAssistant(texte) {
  // Rendu Markdown léger et sûr : on échappe TOUT le HTML d'abord (donc
  // aucune balise fournie par l'IA ou l'utilisateur ne peut s'exécuter),
  // puis on ne réintroduit que des balises qu'on construit nous-mêmes à
  // partir d'une syntaxe Markdown reconnue (gras, italique, code, liens,
  // titres, listes, citations, séparateurs, sauts de ligne).
  if (!texte) return "";

  // 1) Isoler les blocs de code ```...``` en premier, pour que leur contenu
  //    ne soit pas ensuite interprété comme du Markdown (gras, listes, etc.)
  const blocsCode = [];
  let travail = escHtml(texte).replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = blocsCode.length;
    blocsCode.push(`<pre class="assistant-code-bloc"><code>${code.replace(/\n$/, "")}</code></pre>`);
    return `\u0000BLOC${i}\u0000`;
  });

  // 2) Code inline `...`
  travail = travail.replace(/`([^`\n]+?)`/g, '<code class="assistant-code-inline">$1</code>');

  // 3) Gras + italique (le gras d'abord pour ne pas manger les ** d'un ***)
  travail = travail
    .replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, "<i>$1</i>");

  // 4) Liens [texte](url) — uniquement http(s), rien d'autre n'est autorisé
  travail = travail.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  // 5) Travail ligne par ligne pour titres, listes, citations, séparateurs
  const lignes = travail.split("\n");
  const sortie = [];
  let enListe = null; // "ul" | "ol" | null

  function fermerListe() {
    if (enListe) {
      sortie.push(enListe === "ul" ? "</ul>" : "</ol>");
      enListe = null;
    }
  }

  for (const ligne of lignes) {
    const titre = ligne.match(/^(#{1,4})\s+(.*)$/);
    const puce = ligne.match(/^\s*[-*]\s+(.*)$/);
    const numero = ligne.match(/^\s*\d+\.\s+(.*)$/);
    const citation = ligne.match(/^\s*&gt;\s?(.*)$/);
    const separateur = ligne.match(/^\s*(---|\*\*\*)\s*$/);

    if (titre) {
      fermerListe();
      const niveau = Math.min(titre[1].length + 3, 6); // # -> h4 minimum, pas de h1/h2 dans une bulle de chat
      sortie.push(`<h${niveau} class="assistant-titre">${titre[2]}</h${niveau}>`);
    } else if (puce) {
      if (enListe !== "ul") { fermerListe(); sortie.push("<ul>"); enListe = "ul"; }
      sortie.push(`<li>${puce[1]}</li>`);
    } else if (numero) {
      if (enListe !== "ol") { fermerListe(); sortie.push("<ol>"); enListe = "ol"; }
      sortie.push(`<li>${numero[1]}</li>`);
    } else if (citation) {
      fermerListe();
      sortie.push(`<blockquote class="assistant-citation">${citation[1]}</blockquote>`);
    } else if (separateur) {
      fermerListe();
      sortie.push("<hr>");
    } else if (ligne.trim() === "") {
      fermerListe();
      sortie.push("");
    } else {
      fermerListe();
      sortie.push(ligne);
    }
  }
  fermerListe();

  let html = sortie.join("\n").replaceAll("\n", "<br>");

  // Éviter des <br> superflus juste avant/après des blocs (titres, listes,
  // citations, séparateurs, blocs de code) pour un rendu plus propre.
  html = html
    .replace(/<br>\s*(<(?:h[4-6]|ul|ol|li|blockquote|hr|\u0000))/g, "$1")
    .replace(/(<\/(?:h[4-6]|ul|ol|blockquote)>)\s*<br>/g, "$1")
    .replace(/(<\/li>)<br>/g, "$1")
    .replace(/(<hr>)<br>/g, "$1")
    .replace(/(\u0000BLOC\d+\u0000)<br>/g, "$1");

  // 6) Réinjecter les blocs de code isolés à l'étape 1
  html = html.replace(/\u0000BLOC(\d+)\u0000/g, (_, i) => blocsCode[Number(i)]);

  return html;
}

// Provider actif pour l'onglet Assistant : "gemini" (cloud) ou "ollama" (local).
// La bulle flottante reste sur Gemini pour rester simple et rapide partout.
let assistantProviderActif = "gemini";

// Mode rapide actif (resume/explication/quiz/conseils/devoirs/objectifs),
// ou null en conversation libre. Contrairement à ProNote+ où ces boutons ne
// changent qu'un texte pré-rempli avant de renvoyer une réponse statique en
// dur (voir AIAssistant.tsx), ici le mode est transmis au backend et modifie
// réellement la consigne envoyée à l'IA active (Gemini ou Ollama).
let assistantModeActif = null;
const LABELS_MODES_ASSISTANT = {
  resume: "📝 Résumé de cours",
  explication: "🧠 Explications",
  quiz: "❓ Quiz de révision",
  conseils: "💡 Conseils d'étude",
  devoirs: "📚 Aide aux devoirs",
  objectifs: "🎯 Objectifs",
};

async function envoyerMessageAssistant(texte, filId, boutonEnvoyer) {
  if (!texte.trim()) return;

  const fils = [document.getElementById("assistant-fil-onglet"), document.getElementById("assistant-fil-flottant")]
    .filter(Boolean);

  fils.forEach((fil) => { fil.insertAdjacentHTML("beforeend", bulleAssistantHtml("user", texte)); });

  const idChargement = "chargement-" + Date.now();
  fils.forEach((fil) => {
    fil.insertAdjacentHTML("beforeend", `
      <div class="assistant-msg assistant-msg--bot" id="${idChargement}-${fil.id}">
        <div class="assistant-msg__bulle chargement"><div class="spinner" style="width:14px;height:14px;border-width:2px;margin:0;"></div> Réflexion…</div>
      </div>
    `);
    fil.scrollTop = fil.scrollHeight;
  });

  if (boutonEnvoyer) boutonEnvoyer.disabled = true;

  // Les deux fils (onglet + bulle flottante) suivent le même provider actif,
  // choisi via le sélecteur ☁️ Gemini / 💻 Ollama dans l'onglet Assistant.
  const urlAppel = assistantProviderActif === "ollama" ? "/api/ollama/chat" : "/api/assistant";

  try {
    const resp = await fetch(urlAppel, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: texte, mode: assistantModeActif || undefined }),
    });
    const data = await resp.json();

    fils.forEach((fil) => {
      const el = document.getElementById(`${idChargement}-${fil.id}`);
      if (el) el.remove();
      if (data.ok) {
        fil.insertAdjacentHTML("beforeend", bulleAssistantHtml("model", data.reponse));
      } else {
        fil.insertAdjacentHTML("beforeend", bulleAssistantHtml("model", data.erreur || "Erreur inconnue.", "erreur"));
      }
      fil.scrollTop = fil.scrollHeight;
    });

    // Le mode ne sert qu'à CE message (comme sur ProNote+) : on repasse en
    // conversation libre une fois la réponse reçue.
    if (assistantModeActif) {
      assistantModeActif = null;
      document.querySelectorAll(".assistant-mode-btn").forEach((b) => b.classList.remove("actif"));
      document.getElementById("assistant-mode-actif-bandeau").style.display = "none";
    }
  } catch (e) {
    fils.forEach((fil) => {
      const el = document.getElementById(`${idChargement}-${fil.id}`);
      if (el) el.remove();
      fil.insertAdjacentHTML("beforeend", bulleAssistantHtml("model", "Erreur réseau : " + e.message, "erreur"));
      fil.scrollTop = fil.scrollHeight;
    });
  } finally {
    if (boutonEnvoyer) boutonEnvoyer.disabled = false;
  }
}

// ══════════════════════ Rappels programmés par l'assistant ═══════════
// Poll léger : vérifie régulièrement si un rappel programmé par Gemini
// (via "programmer_rappel") vient d'atteindre son échéance. Si oui, on
// l'affiche en notification ET on l'injecte dans les deux fils de chat,
// exactement comme si l'assistant venait d'envoyer spontanément ce message.
async function pollRappelsDus() {
  try {
    const r = await fetch("/api/rappels/dus");
    const data = await r.json();
    if (data.ok && data.rappels && data.rappels.length > 0) {
      data.rappels.forEach((rappel) => afficherRappelDeclenche(rappel));
    }
  } catch (e) {
    console.error("Erreur polling rappels", e);
  }
  setTimeout(pollRappelsDus, 15000);
}
setTimeout(pollRappelsDus, 3000); // léger délai au démarrage

function afficherRappelDeclenche(rappel) {
  const texte = `⏰ Rappel : ${rappel.message}`;

  // Notification navigateur si autorisée
  if (window.Notification && Notification.permission === "granted") {
    try {
      new Notification("Rappel de ton assistant", { body: rappel.message, icon: "🔔" });
    } catch (e) { /* silencieux */ }
  }

  // Injection dans les deux fils de chat, comme un message spontané de l'IA
  const fils = [document.getElementById("assistant-fil-onglet"), document.getElementById("assistant-fil-flottant")]
    .filter(Boolean);
  fils.forEach((fil) => {
    fil.insertAdjacentHTML("beforeend", bulleAssistantHtml("model", texte));
    fil.scrollTop = fil.scrollHeight;
  });

  // Ouvre automatiquement la bulle flottante pour attirer l'attention si
  // aucune vue liée à l'assistant n'est déjà visible.
  const ongletAssistantActif = document.getElementById("vue-assistant").classList.contains("actif");
  const bulleDejaOuverte = panneauFlottant.classList.contains("ouvert");
  if (!ongletAssistantActif && !bulleDejaOuverte) {
    panneauFlottant.classList.add("ouvert");
    bulleToggle.classList.add("masquee");
  }
}

// Demande la permission de notification une fois, discrètement, au premier
// chargement (n'insiste pas si refusée).
if (window.Notification && Notification.permission === "default") {
  setTimeout(() => { Notification.requestPermission().catch(() => {}); }, 4000);
}

function initialiserZoneAssistant(idChamp, idBouton) {
  const champ = document.getElementById(idChamp);
  const bouton = document.getElementById(idBouton);
  if (!champ || !bouton) return;

  const envoyer = () => {
    const texte = champ.value;
    champ.value = "";
    champ.style.height = "auto";
    envoyerMessageAssistant(texte, null, bouton);
  };

  bouton.addEventListener("click", envoyer);
  champ.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      envoyer();
    }
  });
  champ.addEventListener("input", () => {
    champ.style.height = "auto";
    champ.style.height = Math.min(champ.scrollHeight, 120) + "px";
  });
}

initialiserZoneAssistant("assistant-champ-onglet", "assistant-envoyer-onglet");
initialiserZoneAssistant("assistant-champ-flottant", "assistant-envoyer-flottant");

// ══════════════════ Modes rapides (Résumé/Explications/Quiz/…) ══════════
document.querySelectorAll(".assistant-mode-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const deraSelectionne = btn.classList.contains("actif");
    document.querySelectorAll(".assistant-mode-btn").forEach((b) => b.classList.remove("actif"));

    const bandeau = document.getElementById("assistant-mode-actif-bandeau");
    const champ = document.getElementById("assistant-champ-onglet");

    if (deraSelectionne) {
      // Reclic sur le mode déjà actif : on désélectionne (retour en conversation libre)
      assistantModeActif = null;
      bandeau.style.display = "none";
      return;
    }

    assistantModeActif = btn.dataset.mode;
    btn.classList.add("actif");
    bandeau.style.display = "flex";
    bandeau.innerHTML = `
      <span>Mode actif : <strong>${LABELS_MODES_ASSISTANT[assistantModeActif] || assistantModeActif}</strong></span>
      <button type="button" id="assistant-mode-annuler">✕ Annuler</button>
    `;
    document.getElementById("assistant-mode-annuler").addEventListener("click", () => {
      assistantModeActif = null;
      btn.classList.remove("actif");
      bandeau.style.display = "none";
    });

    // Pré-remplit le champ comme sur ProNote+, mais reste modifiable avant envoi
    if (champ && !champ.value.trim()) {
      const amorces = {
        resume: "Résume ce cours : ",
        explication: "Explique-moi : ",
        quiz: "Crée-moi un quiz de révision sur : ",
        conseils: "Donne-moi des conseils d'étude pour : ",
        devoirs: "Aide-moi avec ce devoir : ",
        objectifs: "Aide-moi à définir un objectif pour : ",
      };
      champ.value = amorces[assistantModeActif] || "";
      champ.focus();
      champ.selectionStart = champ.selectionEnd = champ.value.length;
    }
  });
});

// ══════════════════ Sélecteur de provider IA (Gemini / Ollama local) ════
document.querySelectorAll(".assistant-provider-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".assistant-provider-btn").forEach((b) => b.classList.remove("actif"));
    btn.classList.add("actif");
    assistantProviderActif = btn.dataset.provider;

    const barreOllama = document.getElementById("ollama-barre-config");
    barreOllama.style.display = assistantProviderActif === "ollama" ? "block" : "none";

    if (assistantProviderActif === "ollama") {
      chargerStatutOllama();
    }
  });
});

async function chargerStatutOllama() {
  const zoneTexte = document.getElementById("ollama-statut-texte");
  const zoneSelect = document.getElementById("ollama-select-modele-conteneur");
  const select = document.getElementById("ollama-select-modele");

  zoneTexte.textContent = "Vérification du serveur Ollama local…";
  zoneSelect.style.display = "none";

  try {
    const r = await fetch("/api/ollama/statut");
    const data = await r.json();

    if (!data.disponible) {
      zoneTexte.innerHTML = `⚠️ Impossible de joindre Ollama sur <code>${escHtml(data.url)}</code>. Vérifie qu'il tourne (<code>ollama serve</code>).`;
      return;
    }
    if (data.modeles.length === 0) {
      zoneTexte.innerHTML = `⚠️ Ollama tourne mais aucun modèle n'est installé. Essaie <code>ollama pull llama3.2</code> dans un terminal, puis réessaie.`;
      return;
    }

    zoneTexte.textContent = `✅ Ollama connecté (${data.url}) — ${data.modeles.length} modèle${data.modeles.length > 1 ? "s" : ""} trouvé${data.modeles.length > 1 ? "s" : ""}.`;
    select.innerHTML = data.modeles.map((m) =>
      `<option value="${escHtml(m)}" ${m === data.modele_choisi ? "selected" : ""}>${escHtml(m)}</option>`
    ).join("");
    zoneSelect.style.display = "block";
  } catch (e) {
    zoneTexte.textContent = "Erreur réseau lors de la vérification d'Ollama : " + e.message;
  }
}

document.getElementById("ollama-select-modele")?.addEventListener("change", async (e) => {
  const modele = e.target.value;
  try {
    await fetch("/api/ollama/modele", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modele }),
    });
  } catch (err) {
    console.error("Erreur sélection modèle Ollama", err);
  }
});

// Au chargement de la page : si l'historique Ollama contient déjà des
// messages (mémoire persistée d'une session précédente), on les réaffiche
// — c'est tout l'intérêt d'une mémoire "toujours gardée".
async function restaurerHistoriqueOllamaSiPresent() {
  try {
    const r = await fetch("/api/ollama/historique");
    const data = await r.json();
    if (!data.ok || !data.historique || data.historique.length === 0) return;

    const fil = document.getElementById("assistant-fil-onglet");
    // Ne restaure que si le fil est encore vierge (message d'accueil seul),
    // pour ne jamais dupliquer l'historique si la fonction est appelée deux fois.
    if (fil.querySelectorAll(".assistant-msg").length > 1) return;

    data.historique.forEach((msg) => {
      fil.insertAdjacentHTML("beforeend", bulleAssistantHtml(msg.role === "assistant" ? "model" : "user", msg.content));
    });
    fil.scrollTop = fil.scrollHeight;
  } catch (e) {
    console.error("Erreur restauration historique Ollama", e);
  }
}
restaurerHistoriqueOllamaSiPresent();

async function reinitialiserAssistant() {
  try {
    const url = assistantProviderActif === "ollama" ? "/api/ollama/reset" : "/api/assistant/reset";
    await fetch(url, { method: "POST" });
  } catch (e) {
    console.error("Erreur reset assistant", e);
  }
  const messageAccueil = bulleAssistantHtml(
    "model",
    "👋 Conversation réinitialisée. Que veux-tu savoir ?"
  );
  const filOnglet = document.getElementById("assistant-fil-onglet");
  const filFlottant = document.getElementById("assistant-fil-flottant");
  if (filOnglet) filOnglet.innerHTML = messageAccueil;
  if (filFlottant) filFlottant.innerHTML = messageAccueil;
}

document.getElementById("btn-reset-assistant-onglet").addEventListener("click", reinitialiserAssistant);
document.getElementById("btn-reset-assistant-flottant").addEventListener("click", reinitialiserAssistant);

// ── Bulle flottante : ouverture / fermeture ──
const bulleToggle = document.getElementById("assistant-bulle-toggle");
const panneauFlottant = document.getElementById("assistant-flottant");

bulleToggle.addEventListener("click", () => {
  const ouvert = panneauFlottant.classList.toggle("ouvert");
  bulleToggle.classList.toggle("masquee", ouvert);
  if (ouvert) {
    // Premier message d'accueil si le fil flottant est vide
    const fil = document.getElementById("assistant-fil-flottant");
    if (fil.children.length === 0) {
      fil.innerHTML = bulleAssistantHtml("model", "👋 Salut ! Je peux tout faire — discuter librement, t'aider sur tes devoirs, te renseigner sur PRONOTE en direct, ou te programmer un rappel. Pose ta question !");
    }
    setTimeout(() => document.getElementById("assistant-champ-flottant").focus(), 100);
    // Sa barre de saisie était en display:none jusqu'ici (taille 0×0) : le
    // verre appliqué au chargement de la page était donc inutilisable.
    if (window.__lgRafraichirVisibles) {
      requestAnimationFrame(() => window.__lgRafraichirVisibles());
    }
  }
});

document.getElementById("btn-fermer-assistant-flottant").addEventListener("click", () => {
  panneauFlottant.classList.remove("ouvert");
  bulleToggle.classList.remove("masquee");
});

// Cache la bulle flottante quand on est déjà sur l'onglet Assistant (redondant)
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.vue === "assistant") {
      panneauFlottant.classList.remove("ouvert");
      bulleToggle.classList.add("masquee");
    } else {
      bulleToggle.classList.remove("masquee");
    }
  });
});

// ══════════════════════ Bulletin (Period.report) ═════════════════════
let periodeBulletinChoisie = "";
let periodesBulletinDisponibles = [];

document.getElementById("btn-select-periode-bulletin").addEventListener("click", () => {
  ouvrirFeuillePeriode("bulletin");
});

async function chargerBulletin() {
  const zone = document.getElementById("contenu-bulletin");
  let data;
  try {
    data = await (await fetch("/api/bulletin?periode=" + encodeURIComponent(periodeBulletinChoisie))).json();
  } catch (e) {
    zone.innerHTML = '<div class="carte centre-info">Erreur réseau.</div>';
    return;
  }
  if (!data.pret) {
    zone.innerHTML = '<div class="carte centre-info"><div class="spinner"></div>Connexion à PRONOTE en cours…</div>';
    vuesDejaChargees.delete("bulletin");
    return;
  }
  periodesBulletinDisponibles = data.periodes || [];
  if (!periodeBulletinChoisie) periodeBulletinChoisie = data.periode || "";
  document.getElementById("lbl-select-periode-bulletin").textContent = data.periode || "Période";

  if (data.erreur) {
    zone.innerHTML = `<div class="carte centre-info">Impossible de lire le bulletin : ${escHtml(data.erreur)}</div>`;
    return;
  }
  if (!data.disponible) {
    zone.innerHTML = '<div class="carte centre-info"><div class="emoji">🧾</div>Le bulletin de cette période n\'est pas encore publié.</div>';
    return;
  }

  const fmt = (v) => (v === null || v === undefined || v === "" ? "—" : escHtml(v));
  const global = (data.appreciations || []).length
    ? `<div class="carte bulletin-global"><div class="carte__titre">Appréciation générale</div>
         ${data.appreciations.map((a) => `<div class="bulletin-appreciation">${escHtml(a)}</div>`).join("")}</div>`
    : "";

  zone.innerHTML = global + data.matieres.map((m) => `
    <div class="carte bulletin-matiere" style="border-left:4px solid ${couleurMatiere(m.nom)};">
      <div class="bulletin-matiere__tete">
        <span class="bulletin-matiere__nom">${escHtml(m.nom)}</span>
        <span class="bulletin-matiere__moy">${fmt(m.moyenne)}<small>/20</small></span>
      </div>
      ${m.professeurs.length ? `<div class="bulletin-matiere__profs">${escHtml(m.professeurs.join(", "))}</div>` : ""}
      <div class="bulletin-matiere__stats">
        <span>Classe : <b>${fmt(m.moyenne_classe)}</b></span>
        <span>Min : <b>${fmt(m.min)}</b></span>
        <span>Max : <b>${fmt(m.max)}</b></span>
        <span>Coef. : <b>${fmt(m.coefficient)}</b></span>
      </div>
      ${m.appreciations.map((a) => `<div class="bulletin-appreciation">${escHtml(a)}</div>`).join("")}
    </div>
  `).join("");
}

// ══════════════════════ Professeurs et contacts ═══════════════════════
let professeursTous = [];

async function chargerProfesseurs() {
  const zone = document.getElementById("liste-professeurs");
  let data;
  try {
    data = await (await fetch("/api/professeurs")).json();
  } catch (e) {
    zone.innerHTML = '<div class="carte centre-info">Erreur réseau.</div>';
    return;
  }
  if (!data.pret) {
    zone.innerHTML = '<div class="carte centre-info"><div class="spinner"></div>Connexion à PRONOTE en cours…</div>';
    vuesDejaChargees.delete("professeurs");
    return;
  }
  if (data.erreur) {
    zone.innerHTML = `<div class="carte centre-info">Impossible de charger l'équipe : ${escHtml(data.erreur)}</div>`;
    return;
  }
  professeursTous = data.professeurs || [];
  rendreProfesseurs();
}

function carteProf(p) {
  return `
    <div class="carte prof-carte">
      <div class="prof-carte__infos">
        <div class="prof-carte__nom">${escHtml(p.nom)}</div>
        ${p.matieres.length ? `<div class="prof-carte__matieres">${escHtml(p.matieres.join(", "))}</div>` : ""}
        ${p.email ? `<div class="prof-carte__email"><a href="mailto:${escHtml(p.email)}">${escHtml(p.email)}</a></div>` : ""}
      </div>
      ${p.destinataire_id
        ? `<button class="btn petit" data-ecrire="${escHtml(p.destinataire_id)}">✉️ Écrire</button>`
        : `<span class="prof-carte__etiquette">Pas joignable par la messagerie</span>`}
    </div>`;
}

// Un membre du personnel (non professeur) relève de l'« Administration » si sa
// fonction contient l'un de ces mots. Tout le reste va dans « Autres personnels ».
// Pour déplacer une fonction d'un groupe à l'autre, modifie simplement cette liste.
const MOTS_ADMINISTRATION = [
  "proviseur", "principal", "adjoint", "direction", "secretaire", "secretariat",
  "gestionnaire", "intendan", "cpe", "conseiller principal", "vie scolaire",
  "assistant d'education", "assistante d'education", "surveillant",
];
function estAdministration(p) {
  const texte = normaliser((p.matieres || []).join(" "));
  return MOTS_ADMINISTRATION.some((m) => texte.includes(m));
}

let profOngletActif = "professeurs";

function rendreProfesseurs() {
  const zone = document.getElementById("liste-professeurs");
  const barre = document.getElementById("prof-onglets");
  const q = normaliser(document.getElementById("recherche-profs").value.trim());
  const liste = professeursTous.filter((p) => !q || normaliser(`${p.nom} ${p.matieres.join(" ")}`).includes(q));

  // « Professeurs » = enseignants dont la matière est connue (ce sont les tiens).
  const aMatiere = (p) => p.type === "teacher" && p.matieres.length > 0;
  const profs = liste.filter(aMatiere);
  const nonProfs = liste.filter((p) => !aMatiere(p));
  const admin = nonProfs.filter((p) => p.type !== "teacher" && estAdministration(p));
  const autresPersonnels = nonProfs.filter((p) => p.type !== "teacher" && !estAdministration(p));
  const autresEnseignants = nonProfs.filter((p) => p.type === "teacher");

  const onglets = [
    { id: "professeurs", titre: "Professeurs", n: profs.length },
    { id: "administration", titre: "Administration", n: admin.length },
    { id: "autres", titre: "Autres", n: autresPersonnels.length + autresEnseignants.length },
  ];
  // Si l'onglet courant est vide (recherche), bascule sur le premier qui a des résultats.
  if (!onglets.find((o) => o.id === profOngletActif && o.n > 0)) {
    const premier = onglets.find((o) => o.n > 0);
    if (premier) profOngletActif = premier.id;
  }
  barre.innerHTML = onglets.map((o) =>
    `<button class="prof-onglet${o.id === profOngletActif ? " actif" : ""}" data-onglet="${o.id}">${o.titre}<small>${o.n} personne${o.n > 1 ? "s" : ""}</small></button>`
  ).join("");
  barre.querySelectorAll("[data-onglet]").forEach((btn) => {
    btn.addEventListener("click", () => { profOngletActif = btn.dataset.onglet; rendreProfesseurs(); });
  });

  if (liste.length === 0) {
    zone.innerHTML = '<div class="carte centre-info"><div class="emoji">🧑‍🏫</div>Personne ne correspond.</div>';
    return;
  }
  const section = (titre, l) => l.length ? `<div class="prof-section-titre">${titre} (${l.length})</div>${l.map(carteProf).join("")}` : "";
  if (profOngletActif === "professeurs") zone.innerHTML = section("Mes professeurs", profs);
  else if (profOngletActif === "administration") zone.innerHTML = section("Direction, secrétariat et vie scolaire", admin);
  else zone.innerHTML = section("Santé, social et services", autresPersonnels) + section("Enseignants (matière non précisée)", autresEnseignants);

  zone.querySelectorAll("[data-ecrire]").forEach((btn) => {
    btn.addEventListener("click", () => ecrireAProf(btn.dataset.ecrire));
  });
}
document.getElementById("recherche-profs").addEventListener("input", rendreProfesseurs);

// Ouvre la messagerie avec la fenêtre « Nouveau message » et le prof déjà choisi
function ecrireAProf(destinataireId) {
  activerVue("messagerie");
  ouvrirModaleNouveauMessage([destinataireId]);
}

// ══════════════════════ Export iCal de l'emploi du temps ══════════════
document.getElementById("btn-edt-ical-fichier").addEventListener("click", async (ev) => {
  ev.preventDefault();
  try {
    const resp = await fetch("/api/edt/ical/fichier");
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.erreur || "échec du téléchargement");
    }
    const blob = await resp.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "emploi_du_temps.ics";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("Emploi du temps exporté ✓", "Ouvre le fichier .ics pour l'ajouter à ton agenda.");
  } catch (e) {
    toast("Export impossible", e.message);
  }
});

document.getElementById("btn-edt-ical-lien").addEventListener("click", async () => {
  try {
    const d = await (await fetch("/api/edt/ical")).json();
    if (!d.ok) throw new Error(d.erreur || "échec");
    try {
      await navigator.clipboard.writeText(d.url);
      toast("Lien copié ✓", "À coller dans « S'abonner à un agenda ». Ne le partage pas : il donne accès à ton emploi du temps.");
    } catch (e) {
      prompt("Copie ce lien d'abonnement (ne le partage pas) :", d.url);
    }
  } catch (e) {
    toast("Lien indisponible", e.message);
  }
});

// ══════════════════════ Utilitaires ═══════════════════════════════════
function escHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function tronquer(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Minuscules + sans accents (recherche tolérante, comme côté serveur)
function normaliser(s) {
  return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

// Échappe puis surligne la requête (si les longueurs concordent après
// normalisation ; sinon on renvoie simplement le texte échappé)
function surligner(texte, requete) {
  const q = normaliser(requete).trim();
  const norm = normaliser(texte);
  const i = q && norm.length === texte.length ? norm.indexOf(q) : -1;
  if (i < 0) return escHtml(texte);
  return escHtml(texte.slice(0, i)) + "<mark>" + escHtml(texte.slice(i, i + q.length)) + "</mark>" + escHtml(texte.slice(i + q.length));
}

// ══════════════════════ Notifications (page + bureau) ═════════════════
// toast = bulle dans la page ; notification système = bureau / navigateur
// (si autorisée). Les notifications système n'arrivent que tant que l'onglet
// du dashboard reste ouvert : il n'y a pas de serveur push.
function toast(titre, detail = "", vueCible = null) {
  const zone = document.getElementById("toasts");
  if (!zone) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<b>${escHtml(titre)}</b>${detail ? `<span class="toast__detail">${escHtml(detail)}</span>` : ""}`;
  const retirer = () => el.remove();
  el.addEventListener("click", () => { if (vueCible) activerVue(vueCible); retirer(); });
  zone.appendChild(el);
  setTimeout(retirer, 8000);
}

function notifier(titre, detail, vueCible) {
  toast(titre, detail, vueCible);
  if (window.Notification && Notification.permission === "granted" && !document.hasFocus()) {
    try {
      const n = new Notification(titre, { body: detail, icon: "/static/logo.png", tag: "pronote-" + vueCible });
      n.onclick = () => { window.focus(); activerVue(vueCible); n.close(); };
    } catch (e) { /* silencieux */ }
  }
}

function majBoutonNotifications() {
  const btn = document.getElementById("btn-notifications");
  if (!btn) return;
  if (!window.Notification) { btn.textContent = "🔔 Non supportées"; btn.disabled = true; return; }
  const etat = { granted: "activées", denied: "bloquées", default: "désactivées" }[Notification.permission];
  btn.textContent = "🔔 Notifications : " + etat;
}
document.getElementById("btn-notifications").addEventListener("click", async () => {
  if (!window.Notification) return;
  if (Notification.permission === "default") {
    await Notification.requestPermission().catch(() => {});
  } else if (Notification.permission === "denied") {
    toast("Notifications bloquées", "Autorise-les dans les réglages du site de ton navigateur (icône à gauche de l'adresse).");
  } else {
    new Notification("Notifications activées ✓", { body: "Tu seras prévenu des nouvelles actus et messages.", icon: "/static/logo.png" });
  }
  majBoutonNotifications();
});
majBoutonNotifications();

// ══════════════════════ Pastille liquid-glass du sélecteur de thème ═══════
// Portage réduit du moteur SVG displacement/specular de la démo "liquid
// glass" (Kube.io / WWDC 2025 Apple), appliqué à la pastille qui glisse sur
// le bouton de thème actif (☀️ / 🌙 / 💀) dans la sidebar. Même principe que
// le "Switch" de la démo, généralisé à 3 arrêts au lieu de 2.
(function initThemePickerGlass() {
  console.log("[liquid-glass] initialisation du sélecteur de thème…");
  const picker = document.getElementById("theme-picker");
  const glass = document.getElementById("theme-picker-glass");
  if (!picker || !glass) {
    console.warn("[liquid-glass] éléments introuvables, abandon.", { picker, glass });
    return;
  }

  // -- Équation de surface du bezel (convex squircle, comme le Switch demo)
  const surfaceFn = (x) => Math.pow(1 - Math.pow(1 - x, 4), 1 / 4);

  // -- Petite classe de ressort (identique à la démo, réduite au nécessaire)
  class Spring {
    constructor(value, stiffness = 400, damping = 30) {
      this.value = value; this.target = value; this.velocity = 0;
      this.stiffness = stiffness; this.damping = damping;
    }
    setTarget(t) { this.target = t; }
    update(dt) {
      const force = (this.target - this.value) * this.stiffness;
      const dampingForce = this.velocity * this.damping;
      this.velocity += (force - dampingForce) * dt;
      this.value += this.velocity * dt;
      return this.value;
    }
    isSettled() {
      return Math.abs(this.target - this.value) < 0.001 && Math.abs(this.velocity) < 0.001;
    }
  }

  function calculateDisplacementMap1D(glassThickness, bezelWidth, fn, refractiveIndex, samples = 64) {
    const eta = 1 / refractiveIndex;
    function refract(nx, ny) {
      const dot = ny;
      const k = 1 - eta * eta * (1 - dot * dot);
      if (k < 0) return null;
      const kSqrt = Math.sqrt(k);
      return [-(eta * dot + kSqrt) * nx, eta - (eta * dot + kSqrt) * ny];
    }
    const result = [];
    for (let i = 0; i < samples; i++) {
      const x = i / samples;
      const y = fn(x);
      const dx = x < 1 ? 0.0001 : -0.0001;
      const y2 = fn(Math.max(0, Math.min(1, x + dx)));
      const derivative = (y2 - y) / dx;
      const magnitude = Math.sqrt(derivative * derivative + 1);
      const normal = [-derivative / magnitude, -1 / magnitude];
      const refracted = refract(normal[0], normal[1]);
      if (!refracted) { result.push(0); continue; }
      const remainingHeightOnBezel = y * bezelWidth;
      const remainingHeight = remainingHeightOnBezel + glassThickness;
      result.push(refracted[0] * (remainingHeight / refracted[1]));
    }
    return result;
  }

  function calculateDisplacementMap2D(size, radius, bezelWidth, maxDisp, precomputed) {
    const imageData = new ImageData(size, size);
    for (let i = 0; i < imageData.data.length; i += 4) {
      imageData.data[i] = 128; imageData.data[i + 1] = 128;
      imageData.data[i + 2] = 0; imageData.data[i + 3] = 255;
    }
    const cx = size / 2, cy = size / 2;
    const radiusSquared = radius * radius;
    const radiusPlusOneSquared = (radius + 1) * (radius + 1);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > radiusPlusOneSquared) continue;
        const idx = (y * size + x) * 4;
        const opacity = d2 < radiusSquared ? 1 :
          1 - (Math.sqrt(d2) - Math.sqrt(radiusSquared)) / (Math.sqrt(radiusPlusOneSquared) - Math.sqrt(radiusSquared));
        const distFromCenter = Math.sqrt(d2);
        const distFromSide = radius - distFromCenter;
        const cos = distFromCenter > 0 ? dx / distFromCenter : 0;
        const sin = distFromCenter > 0 ? dy / distFromCenter : 0;
        const bezelRatio = Math.max(0, Math.min(1, distFromSide / bezelWidth));
        const bezelIndex = Math.floor(bezelRatio * precomputed.length);
        const dist = precomputed[Math.max(0, Math.min(bezelIndex, precomputed.length - 1))] || 0;
        const dX = maxDisp > 0 ? (-cos * dist) / maxDisp : 0;
        const dY = maxDisp > 0 ? (-sin * dist) / maxDisp : 0;
        imageData.data[idx] = Math.max(0, Math.min(255, 128 + dX * 127 * opacity));
        imageData.data[idx + 1] = Math.max(0, Math.min(255, 128 + dY * 127 * opacity));
        imageData.data[idx + 2] = 0;
        imageData.data[idx + 3] = 255;
      }
    }
    return imageData;
  }

  function calculateSpecular(size, radius, thickness = 1.2, angle = Math.PI / 3) {
    const imageData = new ImageData(size, size);
    const vec = [Math.cos(angle), Math.sin(angle)];
    const cx = size / 2, cy = size / 2;
    const radiusSquared = radius * radius;
    const radiusPlusOneSquared = (radius + 1) * (radius + 1);
    const radiusMinusThickSquared = Math.max(0, (radius - thickness) * (radius - thickness));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > radiusPlusOneSquared || d2 < radiusMinusThickSquared) continue;
        const idx = (y * size + x) * 4;
        const distFromCenter = Math.sqrt(d2);
        const distFromSide = radius - distFromCenter;
        const opacity = d2 < radiusSquared ? 1 :
          1 - (distFromCenter - Math.sqrt(radiusSquared)) / (Math.sqrt(radiusPlusOneSquared) - Math.sqrt(radiusSquared));
        const cos = distFromCenter > 0 ? dx / distFromCenter : 0;
        const sin = distFromCenter > 0 ? -dy / distFromCenter : 0;
        const dot = Math.abs(cos * vec[0] + sin * vec[1]);
        const edgeRatio = Math.max(0, Math.min(1, distFromSide / thickness));
        const falloff = Math.sqrt(1 - (1 - edgeRatio) * (1 - edgeRatio));
        const coeff = dot * falloff;
        const color = Math.min(255, 255 * coeff);
        imageData.data[idx] = color; imageData.data[idx + 1] = color; imageData.data[idx + 2] = color;
        imageData.data[idx + 3] = Math.min(255, color * coeff * opacity);
      }
    }
    return imageData;
  }

  function toDataURL(imageData) {
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width; canvas.height = imageData.height;
    canvas.getContext("2d").putImageData(imageData, 0, 0);
    return canvas.toDataURL();
  }

  // -- Détection backdrop-filter + SVG url() (Chromium uniquement)
  try {
  const testEl = document.createElement("div");
  testEl.style.backdropFilter = "url(#test)";
  const supported = !!window.chrome && testEl.style.backdropFilter.includes("url");
  if (supported) glass.classList.add("use-backdrop-filter");

  // -- Génération unique des maps (la pastille ne change pas de taille/forme)
  const SIZE = 26, RADIUS = 13, BEZEL = 6, THICKNESS = 1.45;
  const precomputed = calculateDisplacementMap1D(6, BEZEL, surfaceFn, THICKNESS);
  const maxDisp = Math.max(...precomputed.map(Math.abs));
  const dispData = calculateDisplacementMap2D(SIZE, RADIUS, BEZEL, maxDisp || 1, precomputed);
  const specData = calculateSpecular(SIZE, RADIUS);
  document.getElementById("themePickerDisplacementImage").setAttribute("href", toDataURL(dispData));
  document.getElementById("themePickerSpecularImage").setAttribute("href", toDataURL(specData));
  document.getElementById("themePickerDisplacementMap").setAttribute("scale", maxDisp * 1.4);

  // -- Position cible = position du bouton actif dans le picker
  const spring = new Spring(0, 500, 32);
  let animId = null;

  function indexBoutonActif() {
    const boutons = Array.from(picker.querySelectorAll(".theme-picker__opt"));
    const actif = boutons.findIndex((b) => b.classList.contains("actif"));
    return actif === -1 ? 0 : actif;
  }

  function cibleX() {
    const bouton = picker.querySelectorAll(".theme-picker__opt")[indexBoutonActif()];
    if (!bouton) return 3;
    // Position du bouton relative au conteneur .theme-picker
    return bouton.offsetLeft;
  }

  function boucle() {
    const dt = Math.min(0.032, 1 / 60);
    // IMPORTANT : ne JAMAIS recalculer la cible ici via cibleX(). La cible
    // est fixée explicitement par le clic (btn.offsetLeft, lu au bon
    // moment) ou par le resize. La recalculer à chaque frame revenait à
    // relire .actif — qui ne se met à jour que 220ms après le clic (délai
    // de l'animation du voile) — donc la cible était systématiquement
    // écrasée par l'ANCIENNE position dès la frame suivant le clic, et le
    // ressort se stabilisait immédiatement sans bouger. D'où le besoin
    // d'un second clic pour "rattraper" la bonne position.
    const x = spring.update(dt);
    glass.style.transform = `translateX(${x - 3}px)`;
    if (!spring.isSettled()) {
      animId = requestAnimationFrame(boucle);
    } else {
      animId = null;
    }
  }

  function relancer() {
    if (!animId) animId = requestAnimationFrame(boucle);
  }

  // Position initiale sans animation (au chargement de la page)
  spring.value = cibleX();
  spring.target = spring.value;
  glass.style.transform = `translateX(${spring.value - 3}px)`;

  // La pastille suit chaque changement de thème (les boutons togglent déjà
  // .actif ailleurs dans ce fichier, via appliquerEtatPicker/click listener)
  // La pastille suit chaque clic directement (calcul à partir du bouton
  // cliqué, PAS de la classe .actif) : le listener existant qui gère le
  // changement de thème n'applique .actif qu'après un setTimeout(220ms)
  // (le temps de l'animation du "voile" de transition). Si on lisait
  // .actif ici, on lirait l'ANCIEN bouton actif, 220ms trop tôt — la
  // pastille ne bougerait jamais au moment du clic.
  picker.querySelectorAll(".theme-picker__opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      spring.setTarget(btn.offsetLeft);
      relancer();
    });
  });
  window.addEventListener("resize", () => { spring.target = cibleX(); relancer(); });

  // ── Drag : traîner la pastille au lieu de simplement cliquer ──────────
  // La pastille (z-index 2, pointer-events:auto) intercepte le pointeur
  // sur sa propre zone ; les AUTRES boutons (non recouverts au repos)
  // restent cliquables normalement via leurs propres listeners.
  let enTrainDeGlisser = false;
  let xInitialPointeur = 0;
  let valeurInitialeSpring = 0;

  function bornes() {
    const boutons = Array.from(picker.querySelectorAll(".theme-picker__opt"));
    return { min: boutons[0].offsetLeft, max: boutons[boutons.length - 1].offsetLeft };
  }

  function boutonLePlusProche(x) {
    const boutons = Array.from(picker.querySelectorAll(".theme-picker__opt"));
    let meilleur = boutons[0];
    let meilleureDistance = Infinity;
    for (const b of boutons) {
      const d = Math.abs(b.offsetLeft - x);
      if (d < meilleureDistance) { meilleureDistance = d; meilleur = b; }
    }
    return meilleur;
  }

  function xPointeur(e) {
    return e.touches ? e.touches[0].clientX : e.clientX;
  }

  function debuterGlisser(e) {
    e.preventDefault();
    enTrainDeGlisser = true;
    xInitialPointeur = xPointeur(e);
    valeurInitialeSpring = spring.value;
    relancer();
  }

  function pendantGlisser(e) {
    if (!enTrainDeGlisser) return;
    e.preventDefault();
    const delta = xPointeur(e) - xInitialPointeur;
    const { min, max } = bornes();
    let nouvelleValeur = valeurInitialeSpring + delta;
    // Léger amorti hors-limites plutôt qu'un blocage sec, comme le drag
    // du Switch de la démo d'origine (petite résistance élastique).
    if (nouvelleValeur < min) nouvelleValeur = min + (nouvelleValeur - min) * 0.3;
    if (nouvelleValeur > max) nouvelleValeur = max + (nouvelleValeur - max) * 0.3;
    // Pendant le drag, la pastille suit le doigt 1:1 (pas de lag du
    // ressort) : on fixe value ET target au même endroit.
    spring.value = nouvelleValeur;
    spring.target = nouvelleValeur;
    spring.velocity = 0;
    glass.style.transform = `translateX(${nouvelleValeur - 3}px)`;
  }

  function terminerGlisser(e) {
    if (!enTrainDeGlisser) return;
    enTrainDeGlisser = false;
    const x = spring.value;
    const cible = boutonLePlusProche(x);
    // On déclenche un vrai clic sur le bouton le plus proche : ça réutilise
    // TOUTE la logique existante (voile de transition, data-theme,
    // localStorage, ET le recalage de la pastille via le listener de clic
    // ci-dessus) au lieu de dupliquer cette logique ici.
    cible.click();
  }

  glass.addEventListener("mousedown", debuterGlisser);
  glass.addEventListener("touchstart", debuterGlisser, { passive: false });
  window.addEventListener("mousemove", pendantGlisser);
  window.addEventListener("touchmove", pendantGlisser, { passive: false });
  window.addEventListener("mouseup", terminerGlisser);
  window.addEventListener("touchend", terminerGlisser);
  console.log("[liquid-glass] initialisation terminée avec succès.", { supported, x: spring.value });
  } catch (erreur) {
    console.error("[liquid-glass] erreur pendant l'initialisation :", erreur);
  }
})();

// ══════════════════════ Liquid glass générique (v2) ════════════════════════
// Port fidèle de shuding/liquid-glass (github.com/shuding/liquid-glass,
// 1.1k★, MIT, aucune dépendance externe) — remplace l'ancien moteur de
// réfraction "physique" fait maison par la même méthode signed-distance-
// field (SDF) + smoothstep que cette démo largement validée par la
// communauté. Appliqué en statique (pas de suivi de souris, contrairement
// à la démo d'origine qui est un objet flottant draggable) sur : boutons
// principaux, bulle flottante de l'assistant, barres de saisie, et
// modales à l'ouverture.
(function initLiquidGlassGeneral() {
  try {
    // -- Fonctions SDF (reprises telles quelles, formule éprouvée) --------
    function smoothStep(a, b, t) {
      t = Math.max(0, Math.min(1, (t - a) / (b - a)));
      return t * t * (3 - 2 * t);
    }
    function longueur(x, y) { return Math.sqrt(x * x + y * y); }
    function roundedRectSDF(x, y, w, h, r) {
      const qx = Math.abs(x) - w + r;
      const qy = Math.abs(y) - h + r;
      return Math.min(Math.max(qx, qy), 0) + longueur(Math.max(qx, 0), Math.max(qy, 0)) - r;
    }
    // Forme par défaut (identique à la démo d'origine) : exprimée en
    // coordonnées UV [0,1], donc automatiquement indépendante de la taille
    // réelle en pixels de chaque élément — pas besoin de la reparamétrer
    // par bouton/modale/bulle.
    function fragmentParDefaut(uv) {
      const ix = uv.x - 0.5;
      const iy = uv.y - 0.5;
      const distanceToEdge = roundedRectSDF(ix, iy, 0.3, 0.2, 0.6);
      const displacement = smoothStep(0.8, 0, distanceToEdge - 0.15);
      const scaled = smoothStep(0, 1, displacement);
      return { x: ix * scaled + 0.5, y: iy * scaled + 0.5 };
    }

    const testEl = document.createElement("div");
    testEl.style.backdropFilter = "url(#test)";
    const supported = !!window.chrome && testEl.style.backdropFilter.includes("url");

    let compteur = 0;
    let svgConteneur = document.getElementById("lg-svg-global");
    if (!svgConteneur) {
      svgConteneur = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svgConteneur.setAttribute("id", "lg-svg-global");
      svgConteneur.style.cssText = "position:fixed;top:0;left:0;width:0;height:0;pointer-events:none;";
      document.body.appendChild(svgConteneur);
    }

    function appliquer(el) {
      const rect = el.getBoundingClientRect();
      const w = Math.max(8, Math.round(rect.width));
      const h = Math.max(8, Math.round(rect.height));
      const id = `lg-${compteur++}`;

      // -- Génération de la carte de déplacement (reprise de updateShader
      //    de la démo, réduite au cas statique : une seule génération par
      //    élément, pas de suivi de souris frame par frame).
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      const data = new Uint8ClampedArray(w * h * 4);
      let maxScale = 0;
      const rawValues = [];
      for (let i = 0; i < data.length; i += 4) {
        const x = (i / 4) % w;
        const y = Math.floor(i / 4 / w);
        const pos = fragmentParDefaut({ x: x / w, y: y / h });
        const dx = pos.x * w - x;
        const dy = pos.y * h - y;
        maxScale = Math.max(maxScale, Math.abs(dx), Math.abs(dy));
        rawValues.push(dx, dy);
      }
      maxScale = (maxScale || 1) * 0.5;
      let idx = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = rawValues[idx++] / maxScale + 0.5;
        const g = rawValues[idx++] / maxScale + 0.5;
        data[i] = r * 255; data[i + 1] = g * 255; data[i + 2] = 0; data[i + 3] = 255;
      }
      ctx.putImageData(new ImageData(data, w, h), 0, 0);
      const href = canvas.toDataURL();

      // -- Filtre SVG (feImage + feDisplacementMap, identique à la démo) --
      const ns = "http://www.w3.org/2000/svg";
      if (el.dataset.lgDefsId) document.getElementById(el.dataset.lgDefsId)?.remove();
      const defs = document.createElementNS(ns, "defs");
      defs.id = `lg-defs-${id}`;
      el.dataset.lgDefsId = defs.id;

      const filtre = document.createElementNS(ns, "filter");
      filtre.setAttribute("id", `${id}_filter`);
      filtre.setAttribute("filterUnits", "userSpaceOnUse");
      filtre.setAttribute("colorInterpolationFilters", "sRGB");
      filtre.setAttribute("x", "0"); filtre.setAttribute("y", "0");
      filtre.setAttribute("width", String(w)); filtre.setAttribute("height", String(h));

      const feImage = document.createElementNS(ns, "feImage");
      feImage.setAttribute("width", String(w));
      feImage.setAttribute("height", String(h));
      feImage.setAttributeNS("http://www.w3.org/1999/xlink", "href", href);
      feImage.setAttribute("result", `${id}_map`);

      const feDisplacementMap = document.createElementNS(ns, "feDisplacementMap");
      feDisplacementMap.setAttribute("in", "SourceGraphic");
      feDisplacementMap.setAttribute("in2", `${id}_map`);
      feDisplacementMap.setAttribute("xChannelSelector", "R");
      feDisplacementMap.setAttribute("yChannelSelector", "G");
      feDisplacementMap.setAttribute("scale", String(maxScale));

      filtre.appendChild(feImage);
      filtre.appendChild(feDisplacementMap);
      defs.appendChild(filtre);
      svgConteneur.appendChild(defs);

      el.classList.add("liquid-glass");
      if (supported) {
        el.classList.add("lg-supported");
        // Le combo distorsion SVG + léger flou + boost contraste/luminosité/
        // saturation est ce qui donne l'aspect "verre" convaincant dans la
        // démo d'origine — la seule distorsion géométrique ne suffit pas.
        const chaineFiltre = `url(#${id}_filter) blur(0.5px) contrast(1.15) brightness(1.06) saturate(1.15)`;
        el.style.backdropFilter = chaineFiltre;
        el.style.webkitBackdropFilter = chaineFiltre;
      }
    }

    function appliquerAvecDebounce(el) {
      let idT = null;
      const relancer = () => { clearTimeout(idT); idT = setTimeout(() => appliquer(el), 150); };
      relancer();
      // On n'attache le listener resize qu'une seule fois par élément,
      // même si appliquerAvecDebounce est rappelée plus tard (ex: quand la
      // page qui le contient redevient visible) — sinon on empilerait un
      // nouveau listener à chaque fois, recalculant N fois en double.
      if (!el.dataset.lgResizeBound) {
        el.dataset.lgResizeBound = "1";
        window.addEventListener("resize", relancer);
      }
    }

    function elementsGlassCibles() {
      return [
        ...document.querySelectorAll(".btn:not(.icon-btn)"),
        ...document.querySelectorAll(".assistant-saisie"),
        ...(document.getElementById("assistant-bulle-toggle") ? [document.getElementById("assistant-bulle-toggle")] : []),
      ];
    }

    // Exposé globalement pour que activerVue() (navigation entre pages)
    // puisse redemander l'application du verre une fois qu'une page
    // auparavant cachée (display:none) devient visible et a donc une
    // taille réelle mesurable.
    window.__lgRafraichirVisibles = function () {
      elementsGlassCibles().forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) appliquerAvecDebounce(el);
      });
    };

    elementsGlassCibles().forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) appliquerAvecDebounce(el);
    });

    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type !== "attributes" || m.attributeName !== "class") continue;
        const cible = m.target;
        if (cible.classList?.contains("modale-fond") && cible.classList.contains("ouverte")) {
          const boite = cible.querySelector(".modale-boite");
          if (boite && !boite.dataset.lgApplique) {
            boite.dataset.lgApplique = "1";
            setTimeout(() => appliquer(boite), 50);
          }
        }
      }
    }).observe(document.body, { attributes: true, attributeFilter: ["class"], subtree: true });

    console.log("[liquid-glass v2] module initialisé (port shuding/liquid-glass).", { supported });
  } catch (erreur) {
    console.error("[liquid-glass v2] erreur :", erreur);
  }
})();

// ══════════════════════ Gestes navigation semaine (EDT / Devoirs) ═════
// Sur les vues Emploi du temps et Devoirs :
//  - double-clic (souris) / double-tap (tactile) sur le bord gauche → semaine précédente (-1)
//  - double-clic (souris) / double-tap (tactile) sur le bord droit  → semaine suivante   (+1)
//  - glisser (souris) / swipe (tactile) horizontal vers la droite → semaine précédente (-1)
//  - glisser (souris) / swipe (tactile) horizontal vers la gauche → semaine suivante   (+1)
// Réutilise les mêmes actions que les boutons ◀ / ▶ déjà en place.
(function () {
  "use strict";

  const ZONE_BORD_RATIO = 0.18; // largeur du bord "actif" au double-clic/tap : 18% de chaque côté
  const DELAI_DOUBLE_CLIC = 400; // ms max entre les deux clics/taps
  const SEUIL_GLISSER_PX = 50;   // distance horizontale mini pour valider un glisser/swipe
  const TOLERANCE_VERTICALE = 80; // tolérance verticale (évite de confondre avec un scroll)

  function configurerGestesSemaine(idVue, precedent, suivant) {
    const vue = document.getElementById(idVue);
    if (!vue) return;

    const surBord = (clientX) => {
      const rect = vue.getBoundingClientRect();
      const x = clientX - rect.left;
      const largeur = rect.width;
      if (x <= largeur * ZONE_BORD_RATIO) return "gauche";
      if (x >= largeur * (1 - ZONE_BORD_RATIO)) return "droite";
      return null;
    };

    let dernierClicTemps = 0;
    let dernierClicCote = null;

    function gererClicSimple(clientX) {
      const cote = surBord(clientX);
      if (!cote) { dernierClicCote = null; return; }
      const maintenant = Date.now();
      if (cote === dernierClicCote && maintenant - dernierClicTemps < DELAI_DOUBLE_CLIC) {
        if (cote === "gauche") precedent(); else suivant();
        dernierClicTemps = 0;
        dernierClicCote = null;
      } else {
        dernierClicTemps = maintenant;
        dernierClicCote = cote;
      }
    }

    function traiterFinGeste(depart, arrivee) {
      const dx = arrivee.x - depart.x;
      const dy = arrivee.y - depart.y;
      if (Math.abs(dx) >= SEUIL_GLISSER_PX && Math.abs(dy) <= TOLERANCE_VERTICALE) {
        // Glisser/swipe horizontal validé.
        if (dx > 0) precedent(); else suivant();
        return true;
      }
      return false;
    }

    // ── Tactile (mobile/tablette) ──────────────────────────────────
    let departTactile = null;
    vue.addEventListener("touchstart", (e) => {
      const t = e.touches[0];
      departTactile = { x: t.clientX, y: t.clientY };
    }, { passive: true });

    vue.addEventListener("touchend", (e) => {
      if (!departTactile) return;
      const t = e.changedTouches[0];
      const etaitGlisser = traiterFinGeste(departTactile, { x: t.clientX, y: t.clientY });
      departTactile = null;
      if (!etaitGlisser) gererClicSimple(t.clientX);
    }, { passive: true });

    // ── Souris (PC) ───────────────────────────────────────────────
    // Le clic gauche déclenche toujours un mousedown → on écoute
    // globalement sur document pendant l'appui, mais on ne déclenche
    // une action QUE si le point de départ était dans cette vue ; sinon
    // on relâche tout de suite sans effet (donc aucune interférence
    // avec un clic sur un bouton, une carte, ou la pill de la nav).
    let departSouris = null;
    let boutonEnfonceIci = false;

    vue.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return; // clic gauche uniquement
      departSouris = { x: e.clientX, y: e.clientY };
      boutonEnfonceIci = true;
    });

    document.addEventListener("mouseup", (e) => {
      if (!boutonEnfonceIci || !departSouris) { boutonEnfonceIci = false; return; }
      boutonEnfonceIci = false;
      const etaitGlisser = traiterFinGeste(departSouris, { x: e.clientX, y: e.clientY });
      const dep = departSouris;
      departSouris = null;
      if (!etaitGlisser) gererClicSimple(dep.x);
    });
  }

  configurerGestesSemaine("vue-edt", () => { offsetEdt--; chargerEdt(); }, () => { offsetEdt++; chargerEdt(); });
  configurerGestesSemaine("vue-devoirs", () => { offsetDevoirs--; chargerDevoirs(); }, () => { offsetDevoirs++; chargerDevoirs(); });
})();
// ══════════════════════ Simulateur de notes « et si ? » ═══════════════
let simuData = null;            // réponse brute de /api/simulateur
let simuPeriodeChoisie = "";    // période actuellement affichée dans le simulateur
let simuNotesHypothetiques = {};// { matiere: [{valeur, coefficient}, …] } — notes ajoutées par l'utilisateur, pas encore réelles

async function chargerSimulateur() {
  const conteneur = document.getElementById("simu-liste-matieres");
  conteneur.innerHTML = '<div class="centre-info"><div class="spinner"></div>Chargement…</div>';

  const r = await fetch("/api/simulateur?periode=" + encodeURIComponent(simuPeriodeChoisie));
  const data = await r.json();
  if (!data.pret) {
    conteneur.innerHTML = '<div class="centre-info"><div class="emoji">⚠️</div>Pas encore connecté.</div>';
    return;
  }

  simuData = data;
  if (!simuPeriodeChoisie) simuPeriodeChoisie = data.periode || "";
  document.getElementById("lbl-select-periode-simu").textContent = data.periode || "Période";
  simuNotesHypothetiques = {}; // changement de période : on repart d'un simulateur vierge

  afficherSimulateur();
}

function simuMoyenneMatiere(nomMatiere) {
  const m = simuData.matieres[nomMatiere];
  if (!m) return null;
  const hypo = simuNotesHypothetiques[nomMatiere] || [];

  // Pas de notes hypothétiques → on retourne directement la moyenne
  // officielle calculée par PRONOTE (la vraie, pas une recopie maison).
  if (hypo.length === 0) {
    return m.moyenne_officielle != null ? m.moyenne_officielle : null;
  }

  // Notes hypothétiques ajoutées → on repart des notes brutes réelles
  // pour intégrer les hypo dans le calcul pondéré.
  const toutes = m.notes.concat(hypo);
  if (toutes.length === 0) return null;
  let sommePonderee = 0, sommeCoefs = 0;
  toutes.forEach((n) => {
    sommePonderee += n.valeur * n.coefficient;
    sommeCoefs += n.coefficient;
  });
  if (sommeCoefs === 0) return null;
  return sommePonderee / sommeCoefs;
}

function simuMoyenneGenerale() {
  const noms = Object.keys(simuData.matieres);
  const aucuneHypo = noms.every((n) => !(simuNotesHypothetiques[n] || []).length);

  // Aucune note hypothétique nulle part → on affiche directement la
  // moyenne générale officielle de PRONOTE, sans recalcul maison.
  if (aucuneHypo && simuData.moyenne_generale_actuelle != null) {
    const v = noteNum(simuData.moyenne_generale_actuelle);
    if (v !== null) return v;
  }

  // Au moins une matière a des hypo → on recalcule la générale
  // en mixant moyennes officielles (sans hypo) et calculées (avec hypo).
  let sommePonderee = 0, sommeCoefs = 0;
  noms.forEach((nom) => {
    const moy = simuMoyenneMatiere(nom);
    if (moy === null) return;
    const coefMatiere = simuData.matieres[nom].coefficient_matiere || 1;
    sommePonderee += moy * coefMatiere;
    sommeCoefs += coefMatiere;
  });
  if (sommeCoefs === 0) return null;
  return sommePonderee / sommeCoefs;
}

function afficherSimulateur() {
  const moyGen = simuMoyenneGenerale();
  const elMoy = document.getElementById("simu-moyenne-generale");
  elMoy.textContent = moyGen !== null ? moyGen.toFixed(2).replace(".", ",") : "—";

  const actuelle = noteNum(simuData.moyenne_generale_actuelle);
  const sub = document.getElementById("simu-moyenne-sub");
  if (actuelle !== null && moyGen !== null) {
    const diff = moyGen - actuelle;
    const signe = diff > 0 ? "+" : "";
    sub.textContent = `Moyenne réelle actuelle : ${actuelle.toFixed(2).replace(".", ",")}/20 (${signe}${diff.toFixed(2).replace(".", ",")})`;
  } else {
    sub.textContent = "Ajoute des notes hypothétiques ci-dessous pour voir l'effet.";
  }

  const conteneur = document.getElementById("simu-liste-matieres");
  const noms = Object.keys(simuData.matieres).sort((a, b) => a.localeCompare(b, "fr"));

  if (noms.length === 0) {
    conteneur.innerHTML = '<div class="centre-info"><div class="emoji">📭</div>Pas de notes pour cette période.</div>';
    return;
  }

  conteneur.innerHTML = noms.map((nom) => {
    const c = couleurMatiere(nom);
    const moy = simuMoyenneMatiere(nom);
    const hypo = simuNotesHypothetiques[nom] || [];
    const idSafe = "simu-" + nom.replace(/[^a-zA-Z0-9]/g, "_");

    const lignesHypo = hypo.map((n, i) => `
      <div class="simu-ligne-hypo" data-matiere="${escHtml(nom)}" data-index="${i}">
        <span class="simu-hypo-badge">hypothèse</span>
        <span>${escHtml(n.valeur)}/20 · coef ${escHtml(n.coefficient)}</span>
        <button class="btn-icone simu-btn-suppr" data-matiere="${escHtml(nom)}" data-index="${i}" title="Retirer">✕</button>
      </div>`).join("");

    return `
      <div class="carte simu-carte-matiere" style="margin-bottom:10px;">
        <div class="subjHead" style="margin-bottom:6px;">
          <div class="shTitle"><span class="shIcon" style="background:${c}22;color:${c};">📘</span>${escHtml(nom)}</div>
          <div class="shAvg" style="background:${c}18;color:${c};">${moy !== null ? moy.toFixed(2).replace(".", ",") : "—"}</div>
        </div>
        ${lignesHypo}
        <div class="simu-ajout" style="display:flex;gap:6px;margin-top:8px;">
          <input type="number" min="0" max="20" step="0.25" placeholder="Note /20" class="simu-input-note" id="${idSafe}-note" style="width:90px;">
          <input type="number" min="0.5" step="0.5" value="1" placeholder="Coef" class="simu-input-coef" id="${idSafe}-coef" style="width:70px;">
          <button class="btn secondaire petit simu-btn-ajouter" data-matiere="${escHtml(nom)}" data-id-note="${idSafe}-note" data-id-coef="${idSafe}-coef">+ Ajouter</button>
        </div>
      </div>`;
  }).join("");

  conteneur.querySelectorAll(".simu-btn-ajouter").forEach((btn) => {
    btn.addEventListener("click", () => {
      const matiere = btn.dataset.matiere;
      const inputNote = document.getElementById(btn.dataset.idNote);
      const inputCoef = document.getElementById(btn.dataset.idCoef);
      const valeur = parseFloat(String(inputNote.value).replace(",", "."));
      const coefficient = parseFloat(String(inputCoef.value).replace(",", ".")) || 1;
      if (isNaN(valeur) || valeur < 0 || valeur > 20) {
        inputNote.focus();
        return;
      }
      if (!simuNotesHypothetiques[matiere]) simuNotesHypothetiques[matiere] = [];
      simuNotesHypothetiques[matiere].push({ valeur, coefficient });
      afficherSimulateur();
    });
  });

  conteneur.querySelectorAll(".simu-btn-suppr").forEach((btn) => {
    btn.addEventListener("click", () => {
      const matiere = btn.dataset.matiere;
      const index = parseInt(btn.dataset.index, 10);
      if (simuNotesHypothetiques[matiere]) {
        simuNotesHypothetiques[matiere].splice(index, 1);
      }
      afficherSimulateur();
    });
  });
}

document.getElementById("btn-simu-reset")?.addEventListener("click", () => {
  simuNotesHypothetiques = {};
  afficherSimulateur();
});

// Sélecteur de période : réutilise la même feuille que l'onglet Notes si
// elle existe déjà (periodesNotesDisponibles / ouvrirSelecteurPeriode), sinon
// bascule simplement sur un select natif minimal pour rester fonctionnel.
document.getElementById("btn-select-periode-simu")?.addEventListener("click", () => {
  const periodes = (simuData && simuData.periodes) || periodesNotesDisponibles || [];
  if (periodes.length === 0) return;
  ouvrirFeuillePeriode("simulateur");
});

// ══════════════════ Notifications desktop natives (toasts Windows) ══════
// Différent des notifs navigateur (window.Notification) déjà utilisées pour
// les rappels : ici c'est un thread serveur Python qui tourne même app
// fermée dans le navigateur, et qui affiche un vrai toast Windows pour les
// nouvelles notes / nouveaux devoirs détectés sur PRONOTE.
async function chargerStatutNotifDesktop() {
  const zone = document.getElementById("notif-desktop-statut");
  const btnTest = document.getElementById("btn-notif-desktop-test");
  if (!zone) return;

  try {
    const r = await fetch("/api/notifications/statut");
    const data = await r.json();
    if (data.disponible) {
      const minutes = Math.round(data.intervalle_secondes / 60);
      zone.textContent = `✅ Actives — nouvelles notes/devoirs vérifiés toutes les ${minutes} min, même navigateur fermé.`;
      btnTest.style.display = "inline-block";
    } else {
      zone.innerHTML = `⚠️ Indisponibles sur cette installation (lib <code>win10toast</code> manquante, ou pas sous Windows).`;
      btnTest.style.display = "none";
    }
  } catch (e) {
    zone.textContent = "Erreur de vérification : " + e.message;
  }
}
chargerStatutNotifDesktop();

document.getElementById("btn-notif-desktop-test")?.addEventListener("click", async (e) => {
  const btn = e.target;
  btn.disabled = true;
  try {
    const r = await fetch("/api/notifications/test", { method: "POST" });
    const data = await r.json();
    if (!data.ok) alert(data.erreur || "Échec de l'envoi du test.");
  } catch (err) {
    alert("Erreur réseau : " + err.message);
  } finally {
    btn.disabled = false;
  }
});
