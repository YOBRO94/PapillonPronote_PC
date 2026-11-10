#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
app.py — Dashboard web PRONOTE avancé (style Papillon) sur http://localhost:5001

Un seul script Flask + templates HTML/CSS/JS (vanilla + Chart.js via CDN).
Connexion PRONOTE directe (identifiant/mot de passe) via pronotepy — voir
pronote_connexion.py.

Installation :
    pip install -r requirements.txt

Configuration : copier config.example.env en config.env et renseigner
    PRONOTE_URL, PRONOTE_USERNAME, PRONOTE_PASSWORD.

Lancement :
    python app.py
    -> ouvre http://localhost:5001
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import re
import statistics
import threading
import time
import unicodedata
import uuid
from pathlib import Path
from html import escape as html_escape, unescape as html_unescape
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

from pronote_connexion import DATA_DIR, PronoteConnexion

try:
    from google import genai
except ImportError:  # google-genai pas installé : l'assistant reste désactivé proprement
    genai = None

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
log = logging.getLogger("pronote_web_dash")

load_dotenv(os.environ.get("PRONOTE_CONFIG_ENV_PATH", "config.env"))

PRONOTE_URL = os.getenv("PRONOTE_URL", "")
PRONOTE_USERNAME = os.getenv("PRONOTE_USERNAME")
PRONOTE_PASSWORD = os.getenv("PRONOTE_PASSWORD")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# ── Fuseau horaire ────────────────────────────────────────────────────────
# CRITIQUE : ne jamais utiliser datetime.date.today() / datetime.datetime.now()
# nus dans ce fichier. Le serveur peut tourner en UTC (VM, hébergeur, etc.),
# ce qui décale "aujourd'hui" et l'heure "actuelle" par rapport à la réalité
# côté élève (ex: cours du jour manquants la nuit, "prochain cours" faux,
# devoirs mal classés). On fixe explicitement Europe/Paris partout.
#
# Note technique : pronotepy renvoie des datetime NAÏFS (sans tzinfo) déjà
# exprimés en heure locale de l'établissement (ex: l.start, h.date). Pour
# rester comparables avec ces objets, _maintenant() renvoie donc elle aussi
# un datetime naïf, mais calculé à partir de l'heure réelle de Paris (et pas
# de l'horloge système si jamais elle tourne en UTC ou un autre fuseau).
FUSEAU = ZoneInfo("Europe/Paris")


def _maintenant() -> datetime.datetime:
    """Datetime actuel en heure de Paris, naïf (sans tzinfo) pour rester
    directement comparable aux objets datetime renvoyés par pronotepy."""
    return datetime.datetime.now(FUSEAU).replace(tzinfo=None)


def _aujourdhui() -> datetime.date:
    """Date du jour en France, indépendamment du fuseau du serveur."""
    return _maintenant().date()


_client_gemini = None
if genai and GEMINI_API_KEY:
    try:
        _client_gemini = genai.Client(api_key=GEMINI_API_KEY)
    except Exception:
        _client_gemini = None

JOURS_FR = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]
MOIS_FR = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
]


def _date_longue_fr(d: datetime.date) -> str:
    """Équivalent de d.strftime('%A %d %B %Y') mais indépendant de la locale
    système (qui donne du texte en anglais par défaut sur la plupart des
    machines, ex: 'Sunday 13 September 2026' au lieu de 'Dimanche 13
    septembre 2026' — configurer locale.setlocale() serait fragile, car ça
    dépend de locales installées, qui varient selon l'OS/l'environnement)."""
    return f"{JOURS_FR[d.weekday()]} {d.day} {MOIS_FR[d.month - 1]} {d.year}"

app = Flask(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# CORS restreint pour le userscript BetterPronote++ (tourne dans le navigateur
# sur le domaine du VRAI Pronote, ex: https://xxx.index-education.net, et doit
# pouvoir lire/écrire les devoirs custom sur cette appli qui tourne en local).
# On n'ouvre PAS un "*" global : uniquement les origines Pronote plausibles
# (toutatice, index-education, et localhost pour le dev), et seulement sur les
# routes /api/devoirs/custom/* dont ce script a besoin.
# ─────────────────────────────────────────────────────────────────────────────
ORIGINES_AUTORISEES_SUFFIXES = (".index-education.net", ".toutatice.fr", "127.0.0.1", "localhost")


def _origine_autorisee(origine: str) -> bool:
    if not origine:
        return False
    try:
        hote = origine.split("://", 1)[1].split("/", 1)[0].split(":")[0]
    except IndexError:
        return False
    return any(hote == s.lstrip(".") or hote.endswith(s) for s in ORIGINES_AUTORISEES_SUFFIXES)


@app.after_request
def _cors_headers(resp):
    origine = request.headers.get("Origin", "")
    if request.path.startswith("/api/devoirs/custom") and _origine_autorisee(origine):
        resp.headers["Access-Control-Allow-Origin"] = origine
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
        resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@app.route("/api/devoirs/custom", methods=["OPTIONS"])
@app.route("/api/devoirs/custom/<path:_sous_chemin>", methods=["OPTIONS"])
def _cors_preflight(_sous_chemin=None):
    # Le navigateur envoie une requête OPTIONS avant tout POST/DELETE cross-
    # origin (preflight CORS) : on répond juste 200, les headers sont posés
    # par _cors_headers ci-dessus via after_request.
    return ("", 200)


connexion = PronoteConnexion(
    pronote_url=PRONOTE_URL,
    username=PRONOTE_USERNAME, password=PRONOTE_PASSWORD,
)

# État partagé simple (un seul utilisateur local, pas besoin de plus)
etat = {
    "statut": "Démarrage…",
    "connecte": False,
    "en_cours": False,
    "erreur": None,
}
_verrou = threading.Lock()

# Cache des devoirs déjà listés (id -> objet Homework pronotepy), rempli à
# chaque appel de /api/devoirs. On réutilise ces objets tels quels pour le
# "fait/pas fait" au lieu de re-résoudre l'ID via un nouvel appel c.homework(...)
# — exactement comme le faisait le bot Telegram d'origine (assignCache), qui
# gardait l'objet déjà chargé en mémoire plutôt que de le re-chercher par ID.
_cache_devoirs: dict[str, object] = {}


# ─────────────────────────────────────────────────────────────────────────────
# Connexion (thread de fond, ne bloque jamais Flask)
# ─────────────────────────────────────────────────────────────────────────────
def _se_connecter(force: bool = False):
    with _verrou:
        if etat["en_cours"]:
            return
        etat["en_cours"] = True
        etat["erreur"] = None

    def _travail():
        try:
            etat["statut"] = "🔄 Connexion à PRONOTE…"
            connexion.connect_sync(force=force)
            etat["connecte"] = True
            etat["statut"] = "✅ Connecté"
        except Exception as e:
            log.exception("Échec de connexion PRONOTE")
            etat["connecte"] = False
            etat["erreur"] = str(e)
            etat["statut"] = f"❌ Connexion échouée : {e}"
        finally:
            etat["en_cours"] = False

    threading.Thread(target=_travail, daemon=True).start()


def _client_pret():
    if not connexion.client:
        return False
    try:
        connexion.call(connexion.client.session_check)
        return True
    except Exception:
        etat["connecte"] = False
        return False


def _periode_par_nom(c, nom: str):
    if not nom or nom == "default":
        return c.current_period
    for p in c.periods:
        if nom in p.name or p.name == nom:
            return p
    return c.current_period


def _lire_periode(c, period, attribut: str):
    """Lit un attribut RÉSEAU d'une période (grades, averages, absences, delays,
    punishments, overall_average, class_overall_average) sous verrou, avec
    reprise si la session a expiré. La période est re-résolue par son nom à
    chaque essai : après un refresh() de pronotepy, les anciens objets Period
    ont des identifiants périmés."""
    nom = period.name

    def lire():
        p = next((x for x in c.periods if x.name == nom), None) or c.current_period
        return getattr(p, attribut)

    return connexion.call_retry(lire)


def _infos_perso(info) -> dict:
    """Adresse / email / téléphone / INE. ClientInfo les charge par un POST
    direct (PageInfosPerso) qui contourne le verrou : on les lit donc ici, sous
    connexion.call, chaque champ restant tolérant à l'échec (droits PRONOTE)."""
    res = {"adresse": None, "email": None, "telephone": None, "ine": None}
    try:
        t = info.address
        adresse = ", ".join(x for x in t[:4] if x)
        ville = " ".join(x for x in (t[4], t[5]) if x)
        if ville:
            adresse = f"{adresse} — {ville}" if adresse else ville
        res["adresse"] = adresse or None
    except Exception:
        pass
    try:
        res["email"] = info.email or None
    except Exception:
        pass
    try:
        res["telephone"] = info.phone or None
    except Exception:
        pass
    try:
        res["ine"] = info.ine_number or None
    except Exception:
        pass
    return res


def _bornes_semaine(offset: int):
    today = _aujourdhui()
    lundi = today - datetime.timedelta(days=today.weekday()) + datetime.timedelta(weeks=offset)
    dimanche = lundi + datetime.timedelta(days=6)
    return lundi, dimanche


def _corriger_creneau_pc_svt_lundi(cours_jour: list, jour_semaine: int) -> list:
    """PRONOTE indique par erreur (côté établissement) que le cours de
    Physique-Chimie du lundi matin se termine à 10:45, directement enchaîné
    sur les SVT — alors qu'en réalité PC finit à 10:30 et SVT commence à
    10:45 (15 min d'intercours). On corrige uniquement ce cas précis,
    identifié par jour + matière + horaires exacts, pour ne jamais toucher
    à un autre créneau par erreur."""
    if jour_semaine != 0:  # 0 = lundi
        return cours_jour
    for l in cours_jour:
        if (
            not l.canceled
            and l.subject
            and l.subject.name
            and l.subject.name.strip().upper() == "PHYSIQUE-CHIMIE"
            and l.start.strftime("%H:%M") == "09:00"
            and l.end.strftime("%H:%M") == "10:45"
        ):
            l.end = l.end.replace(hour=10, minute=30)
    return cours_jour


def _dedupliquer_cours_annules(lessons: list) -> list:
    """PRONOTE renvoie parfois DEUX entrées pour le même créneau quand un
    cours est remplacé/déplacé : l'originale (canceled=True) ET la nouvelle
    qui la remplace, toutes deux sur un horaire qui se chevauche. Sans
    filtrage, l'emploi du temps affiche les deux — un cours annulé "fantôme"
    à côté de son remplaçant, ce qui prête à confusion (voir capture élève).

    Règle : pour chaque cours ANNULÉ, s'il existe un autre cours NON annulé
    du même jour dont le créneau horaire chevauche le sien, on retire
    l'annulé (le remplaçant suffit). Un cours annulé sans remplaçant sur son
    créneau reste affiché normalement (l'élève doit savoir que ce cours-là
    n'a pas lieu, sans qu'un autre cours ne le rende évident)."""
    def _chevauchent(a, b) -> bool:
        return a.start < b.end and b.start < a.end

    non_annules = [l for l in lessons if not l.canceled]
    resultat = []
    for l in lessons:
        if l.canceled and any(_chevauchent(l, autre) for autre in non_annules):
            continue  # remplacé par un cours actif sur le même créneau : on masque l'annulé
        resultat.append(l)
    return resultat


def _note_a_dict(g) -> dict:
    return {
        "id": getattr(g, "id", None),
        "date": g.date.strftime("%d/%m/%Y") if g.date else "",
        "date_iso": g.date.isoformat() if g.date else None,
        "matiere": g.subject.name if g.subject else "?",
        "note": g.grade,
        "bareme": g.out_of,
        "moyenne_classe": g.average or "—",
        "note_max": getattr(g, "max", None) or "",
        "note_min": getattr(g, "min", None) or "",
        "coefficient": g.coefficient or "—",
        "commentaire": g.comment or "",
        "optionnelle": bool(getattr(g, "is_optionnal", False)),
        "bonus": bool(getattr(g, "is_bonus", False)),
    }


def _note_valeur_num(note_str, bareme_str):
    """Convertit 'note/bareme' en valeur sur 20, ou None si non numérique
    (dispense, absent, non noté, etc.)."""
    try:
        note = float(str(note_str).replace(",", "."))
        bareme = float(str(bareme_str).replace(",", "."))
        if bareme <= 0:
            return None
        return round(note / bareme * 20, 2)
    except (ValueError, TypeError):
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Pages
# ─────────────────────────────────────────────────────────────────────────────
CONFIG_ENV_PATH = os.environ.get("PRONOTE_CONFIG_ENV_PATH", "config.env")
_VARIABLES_REQUISES = (
    ("PRONOTE_URL", "Adresse de ton Pronote", "https://0000000x.index-education.net/pronote/eleve.html"),
    ("PRONOTE_USERNAME", "Ton identifiant Pronote", "prenom.nom"),
    ("PRONOTE_PASSWORD", "Ton mot de passe Pronote", "mon_mot_de_passe"),
)


def _recharger_config() -> None:
    """Relit config.env à chaud : après avoir corrigé le fichier, un simple
    rechargement de la page suffit, sans relancer l'appli. (La clé Gemini,
    elle, n'est prise en compte qu'au démarrage.)"""
    global PRONOTE_URL, PRONOTE_USERNAME, PRONOTE_PASSWORD
    load_dotenv(CONFIG_ENV_PATH, override=True)
    PRONOTE_URL = os.getenv("PRONOTE_URL", "")
    PRONOTE_USERNAME = os.getenv("PRONOTE_USERNAME")
    PRONOTE_PASSWORD = os.getenv("PRONOTE_PASSWORD")
    connexion.pronote_url = PRONOTE_URL
    connexion.username = PRONOTE_USERNAME
    connexion.password = PRONOTE_PASSWORD


def _diagnostic_config() -> dict:
    """État de la configuration, SANS jamais exposer les valeurs (mot de passe)."""
    valeurs = {
        "PRONOTE_URL": PRONOTE_URL,
        "PRONOTE_USERNAME": PRONOTE_USERNAME,
        "PRONOTE_PASSWORD": PRONOTE_PASSWORD,
    }
    chemin = Path(CONFIG_ENV_PATH).expanduser()
    chemin_abs = chemin if chemin.is_absolute() else Path.cwd() / chemin
    variables = [{
        "nom": nom, "aide": aide, "exemple": exemple,
        "ok": bool((valeurs[nom] or "").strip()),
    } for nom, aide, exemple in _VARIABLES_REQUISES]
    url = (PRONOTE_URL or "").strip()
    return {
        "fichier": str(chemin_abs),
        "fichier_existe": chemin_abs.is_file(),
        "exemple_existe": (chemin_abs.parent / "config.example.env").is_file(),
        "variables": variables,
        "manquantes": [v["nom"] for v in variables if not v["ok"]],
        "url_suspecte": bool(url) and not url.lower().startswith(("http://", "https://")),
        "gemini": bool(GEMINI_API_KEY),
    }


@app.route("/")
def accueil():
    # Config modifiable à chaud : on relit le fichier tant qu'il manque quelque chose
    if not (PRONOTE_URL and PRONOTE_USERNAME and PRONOTE_PASSWORD):
        _recharger_config()
    diag = _diagnostic_config()
    if diag["manquantes"] or diag["url_suspecte"]:
        return render_template("config_manquante.html", diag=diag), 503
    if not etat["connecte"] and not etat["en_cours"] and not etat["erreur"]:
        _se_connecter()
    return render_template("dashboard.html")


@app.route("/api/statut")
def api_statut():
    return jsonify(etat)


# ── Détails techniques de connexion (onglet "Gestion") ───────────────────────
@app.route("/api/gestion")
def api_gestion():
    donnees = dict(etat)
    donnees["device_uuid"] = connexion.get_device_uuid()
    donnees["pronote_url"] = PRONOTE_URL
    if _client_pret():
        try:
            donnees["nom_utilisateur"] = connexion.client.info.name
        except Exception:
            donnees["nom_utilisateur"] = None
    else:
        donnees["nom_utilisateur"] = None
    return jsonify(donnees)


@app.route("/api/reconnexion", methods=["POST"])
def api_reconnexion():
    _se_connecter(force=True)
    return jsonify({"ok": True})


# ── Modes rapides de l'assistant (Résumé / Explications / Quiz / Conseils /
#    Devoirs / Objectifs) — consignes additionnelles injectées par-dessus
#    l'instruction système de base, pour les DEUX providers (Gemini ET
#    Ollama). Contrairement à ProNote+ (où ces boutons renvoient un texte
#    statique en dur, toujours identique, sans appel IA réel — voir
#    AIAssistant.tsx ligne 105 : "Simuler une réponse IA"), ici c'est une
#    vraie consigne envoyée au vrai modèle à chaque message.
MODES_ASSISTANT: dict[str, dict[str, str]] = {
    "resume": {
        "label": "Résumé de cours",
        "consigne": (
            "MODE ACTIF : Résumé de cours. L'élève va te donner un cours, un "
            "chapitre ou un document à résumer. Structure ta réponse avec : "
            "les concepts clés (liste numérotée), les points à retenir "
            "(puces), et si pertinent une application pratique. Reste "
            "concis — un résumé qui fait aussi long que l'original ne sert "
            "à rien."
        ),
    },
    "explication": {
        "label": "Explications",
        "consigne": (
            "MODE ACTIF : Explication d'un concept difficile. Explique "
            "étape par étape : définition claire, contexte, un exemple "
            "concret et parlant, puis comment l'appliquer. Si le concept "
            "s'y prête, termine par une astuce mnémotechnique simple pour "
            "le retenir. Adapte le niveau d'explication à un élève du "
            "secondaire, sauf si le contexte PRONOTE indique un niveau "
            "différent."
        ),
    },
    "quiz": {
        "label": "Quiz de révision",
        "consigne": (
            "MODE ACTIF : Génération d'un quiz de révision. Crée un vrai "
            "quiz à choix multiples (4 options A/B/C/D) sur le sujet exact "
            "demandé par l'élève — jamais de questions génériques ou "
            "d'exemple toutes faites. Nombre de questions : celui demandé, "
            "ou 5 par défaut. Donne les réponses correctes à la toute fin, "
            "clairement séparées des questions (pour ne pas les spoiler "
            "en lisant)."
        ),
    },
    "conseils": {
        "label": "Conseils d'étude",
        "consigne": (
            "MODE ACTIF : Conseils d'étude personnalisés. Base tes conseils "
            "sur les VRAIES données PRONOTE fournies ci-dessous si elles "
            "sont pertinentes (ex : une matière où la moyenne est basse, "
            "des devoirs en retard, une charge de travail chargée cette "
            "semaine) plutôt que des conseils génériques. Sois concret et "
            "actionnable : 3 à 5 conseils maximum, pas un pavé."
        ),
    },
    "devoirs": {
        "label": "Aide aux devoirs",
        "consigne": (
            "MODE ACTIF : Aide aux devoirs. Aide l'élève à comprendre et "
            "résoudre son devoir sans lui donner bêtement la réponse finale "
            "s'il s'agit d'un exercice à résoudre (mathématiques, "
            "physique...) : guide-le étape par étape, pose des questions "
            "pour le faire réfléchir, et ne donne la solution complète que "
            "s'il bloque vraiment ou la demande explicitement. Pour un "
            "devoir de rédaction/dissertation, tu peux aider à structurer "
            "et donner des pistes, mais n'écris pas le devoir à sa place."
        ),
    },
    "objectifs": {
        "label": "Objectifs",
        "consigne": (
            "MODE ACTIF : Définition d'objectifs d'apprentissage. Aide "
            "l'élève à se fixer des objectifs concrets et mesurables (ex : "
            "\"passer de 12 à 14 de moyenne en maths d'ici la fin du "
            "trimestre\"), en t'appuyant sur ses VRAIES données PRONOTE "
            "(moyennes actuelles par matière) quand c'est pertinent. "
            "Propose éventuellement des étapes intermédiaires réalistes."
        ),
    },
}


def _consigne_mode(mode: str | None) -> str:
    """Renvoie la consigne additionnelle du mode demandé, ou chaîne vide si
    le mode est absent/inconnu (comportement par défaut, sans mode)."""
    if not mode or mode not in MODES_ASSISTANT:
        return ""
    return "\n\n" + MODES_ASSISTANT[mode]["consigne"]


# ── Contexte Pronote pour l'assistant IA (accès total aux données) ──────────
def _contexte_pronote_pour_ia() -> str:
    """Construit un résumé texte EXHAUSTIF des données PRONOTE de l'élève,
    injecté dans le prompt Gemini à chaque message. Contrairement au bot
    Telegram d'origine (qui n'envoyait que cours + devoirs du jour), on
    donne ici un accès complet : profil, emploi du temps de la semaine,
    toutes les notes détaillées par matière, absences/retards détaillés,
    actualités (lues et non lues), et discussions en cours."""
    if not _client_pret():
        return "(Élève non connecté à PRONOTE pour le moment.)"

    c = connexion.client
    morceaux = []
    today = _aujourdhui()

    # ── Profil complet ──
    try:
        infos_profil = [f"Nom : {c.info.name}", f"Classe : {c.info.class_name}", f"Établissement : {c.info.establishment}"]
        try:
            if c.info.delegue:
                infos_profil.append(f"Délégué de classe : oui ({', '.join(c.info.delegue)})")
        except Exception:
            pass
        try:
            perso = connexion.call(_infos_perso, c.info)
            if perso["email"]:
                infos_profil.append(f"Email : {perso['email']}")
            if perso["telephone"]:
                infos_profil.append(f"Téléphone : {perso['telephone']}")
        except Exception:
            pass
        morceaux.append("PROFIL ÉLÈVE :\n" + "\n".join(f"  - {ligne}" for ligne in infos_profil))
    except Exception:
        log.exception("Contexte IA : échec profil")

    morceaux.append(f"DATE ET HEURE ACTUELLES (Europe/Paris) : {_maintenant().strftime('%A %d %B %Y, %Hh%M')}")

    # ── Emploi du temps : toute la semaine en cours, pas juste aujourd'hui ──
    try:
        lundi = today - datetime.timedelta(days=today.weekday())
        dimanche = lundi + datetime.timedelta(days=6)
        lessons_semaine = sorted(connexion.call(c.lessons, lundi, dimanche), key=lambda l: l.start)
        for _offset_jour in range(7):
            _jour_boucle = lundi + datetime.timedelta(days=_offset_jour)
            _cours_ce_jour = [l for l in lessons_semaine if l.start.date() == _jour_boucle]
            _corriger_creneau_pc_svt_lundi(_cours_ce_jour, _jour_boucle.weekday())
        if lessons_semaine:
            lignes = []
            jour_courant = None
            for l in lessons_semaine:
                jour = l.start.strftime("%A %d/%m")
                if jour != jour_courant:
                    lignes.append(f"  {jour} :")
                    jour_courant = jour
                lignes.append(
                    f"    - {l.start.strftime('%H:%M')}-{l.end.strftime('%H:%M')} : "
                    f"{l.subject.name if l.subject else '?'}"
                    f"{' (ANNULÉ)' if l.canceled else ''}"
                    f"{' — salle ' + l.classrooms[0] if l.classrooms else ''}"
                    f"{' — ' + l.teacher_name if l.teacher_name else ''}"
                )
            morceaux.append("EMPLOI DU TEMPS DE LA SEMAINE :\n" + "\n".join(lignes))
        else:
            morceaux.append("EMPLOI DU TEMPS DE LA SEMAINE : aucun cours trouvé.")
    except Exception:
        log.exception("Contexte IA : échec emploi du temps semaine")

    # ── Devoirs : 14 jours passés + 14 jours à venir, avec statut fait/pas fait ──
    try:
        debut_devoirs = today - datetime.timedelta(days=14)
        fin_devoirs = today + datetime.timedelta(days=14)
        homeworks = sorted(connexion.call(c.homework, debut_devoirs, fin_devoirs), key=lambda h: h.date)
        if homeworks:
            lignes = [
                f"  - [{'FAIT' if h.done else 'À FAIRE'}] {h.date.strftime('%d/%m/%Y')} — "
                f"{h.subject.name if h.subject else '?'} : {(h.description or '').strip()[:300]}"
                for h in homeworks
            ]
            morceaux.append(
                "DEVOIRS (2 semaines passées à 2 semaines à venir) :\n" + "\n".join(lignes)
            )
        else:
            morceaux.append("DEVOIRS : aucun sur les 4 dernières semaines.")
    except Exception:
        log.exception("Contexte IA : échec devoirs")

    # ── Notes : toutes les notes de la période en cours + moyennes détaillées ──
    try:
        period = c.current_period
        grades = sorted(
            _lire_periode(c, period, 'grades'),
            key=lambda g: g.date or datetime.date.min, reverse=True,
        )
        if grades:
            lignes = [
                f"  - {g.date.strftime('%d/%m/%Y') if g.date else '?'} — "
                f"{g.subject.name if g.subject else '?'} : {g.grade}/{g.out_of} "
                f"(coeff {g.coefficient or '—'}, moyenne classe {g.average or '—'}/20)"
                f"{' — ' + g.comment if g.comment else ''}"
                for g in grades
            ]
            morceaux.append(f"TOUTES LES NOTES DE LA PÉRIODE {period.name} :\n" + "\n".join(lignes))
        else:
            morceaux.append(f"NOTES DE LA PÉRIODE {period.name} : aucune note pour le moment.")

        try:
            morceaux.append(f"MOYENNE GÉNÉRALE ACTUELLE : {_lire_periode(c, period, 'overall_average') or '—'}/20")
        except Exception:
            pass

        # Moyennes détaillées par matière si disponibles
        try:
            moyennes_matieres = _lire_periode(c, period, 'averages')
            if moyennes_matieres:
                lignes_moy = [
                    f"  - {m.subject.name if m.subject else '?'} : {m.student or '—'}/20 "
                    f"(classe : {m.class_average or '—'}/20, min {m.min or '—'}, max {m.max or '—'})"
                    for m in moyennes_matieres
                ]
                morceaux.append("MOYENNES PAR MATIÈRE :\n" + "\n".join(lignes_moy))
        except Exception:
            pass
    except Exception:
        log.exception("Contexte IA : échec notes")

    # ── Absences / retards détaillés (pas juste un comptage) ──
    try:
        period = c.current_period
        absences = _lire_periode(c, period, 'absences')
        retards = _lire_periode(c, period, 'delays')

        if absences:
            lignes_abs = [
                f"  - Du {a.from_date.strftime('%d/%m/%Y %H:%M') if a.from_date else '?'} "
                f"au {a.to_date.strftime('%d/%m/%Y %H:%M') if a.to_date else '?'} "
                f"({a.hours or '—'}h) — {'justifiée' if a.justified else 'NON JUSTIFIÉE'}"
                f"{' — motif : ' + ', '.join(a.reasons) if a.reasons else ''}"
                for a in absences
            ]
            morceaux.append(f"ABSENCES DÉTAILLÉES ({period.name}) :\n" + "\n".join(lignes_abs))
        else:
            morceaux.append(f"ABSENCES ({period.name}) : aucune.")

        if retards:
            lignes_ret = [
                f"  - {r.date.strftime('%d/%m/%Y %H:%M') if r.date else '?'} — {r.minutes} min — "
                f"{'justifié' if r.justified else 'NON JUSTIFIÉ'}"
                f"{' — ' + r.justification if r.justification else ''}"
                for r in retards
            ]
            morceaux.append(f"RETARDS DÉTAILLÉS ({period.name}) :\n" + "\n".join(lignes_ret))
        else:
            morceaux.append(f"RETARDS ({period.name}) : aucun.")

        punitions = _lire_periode(c, period, 'punishments')
        if punitions:
            lignes_pun = [
                f"  - {p.given.strftime('%d/%m/%Y %H:%M') if p.given else '?'} — {p.nature or '?'}"
                f"{' (EXCLUSION)' if p.exclusion else ''}"
                f"{' — motif : ' + ', '.join(p.reasons) if p.reasons else ''}"
                f"{' — donné par ' + p.giver if p.giver else ''}"
                for p in punitions
            ]
            morceaux.append(f"PUNITIONS ({period.name}) :\n" + "\n".join(lignes_pun))
        else:
            morceaux.append(f"PUNITIONS ({period.name}) : aucune.")
    except Exception:
        log.exception("Contexte IA : échec absences/retards/punitions")

    # ── Actualités : toutes (lues + non lues), pas seulement les non lues ──
    try:
        infos = connexion.call(c.information_and_surveys)
        if infos:
            lignes = [
                f"  - [{'NON LU' if not i.read else 'lu'}] {i.title} "
                f"(catégorie {i.category}, auteur {i.author})"
                for i in infos[:25]
            ]
            morceaux.append("ACTUALITÉS DE L'ÉTABLISSEMENT :\n" + "\n".join(lignes))
    except Exception:
        log.exception("Contexte IA : échec actualités")

    # ── Discussions / messagerie ──
    try:
        discs = connexion.call(c.discussions)
        if discs:
            lignes = [
                f"  - {'[NON LU] ' if d.unread else ''}\"{d.subject}\" avec {d.creator}"
                for d in discs[:20]
            ]
            morceaux.append("DISCUSSIONS (messagerie) :\n" + "\n".join(lignes))
    except Exception:
        log.exception("Contexte IA : échec discussions")

    return "\n\n".join(morceaux) if morceaux else "(Aucune donnée disponible.)"


# Historique de conversation en mémoire (un seul utilisateur local, comme le
# reste de l'état de l'appli). Format Gemini : liste de {role, parts:[{text}]}.
_historique_assistant: list[dict] = []
_MAX_TOURS_HISTORIQUE = 20  # ~20 échanges gardés avant purge des plus anciens


# ─────────────────────────────────────────────────────────────────────────────
# Assistant IA LOCAL (Ollama) — alternative à Gemini, 100% en local.
# Contrairement à l'historique Gemini ci-dessus (perdu au redémarrage du
# serveur), celui-ci est PERSISTÉ SUR DISQUE : la mémoire de conversation
# survit aux redémarrages, comme demandé.
# ─────────────────────────────────────────────────────────────────────────────
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434").rstrip("/")
OLLAMA_HISTORIQUE_FILE = DATA_DIR / "ollama_historique.json"
OLLAMA_CONFIG_FILE = DATA_DIR / "ollama_config.json"
_verrou_ollama = threading.Lock()
_MAX_TOURS_HISTORIQUE_OLLAMA = 30  # un peu plus que Gemini vu que c'est la mémoire "longue durée" de l'utilisateur


def _charger_historique_ollama() -> list[dict]:
    """Format : liste de {role: 'user'|'assistant', content: str}. C'est le
    format natif de l'API Ollama /api/chat, pas besoin de conversion."""
    if not OLLAMA_HISTORIQUE_FILE.exists():
        return []
    try:
        with open(OLLAMA_HISTORIQUE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        log.exception("Échec lecture ollama_historique.json")
        return []


def _sauver_historique_ollama(historique: list[dict]) -> None:
    try:
        OLLAMA_HISTORIQUE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(OLLAMA_HISTORIQUE_FILE, "w", encoding="utf-8") as f:
            json.dump(historique, f, ensure_ascii=False, indent=2)
    except Exception:
        log.exception("Échec écriture ollama_historique.json")


def _charger_config_ollama() -> dict:
    """Pour l'instant, seul le modèle choisi est persisté."""
    if not OLLAMA_CONFIG_FILE.exists():
        return {"modele": None}
    try:
        with open(OLLAMA_CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        log.exception("Échec lecture ollama_config.json")
        return {"modele": None}


def _sauver_config_ollama(config: dict) -> None:
    try:
        OLLAMA_CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(OLLAMA_CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
    except Exception:
        log.exception("Échec écriture ollama_config.json")


# ─────────────────────────────────────────────────────────────────────────────
# Rappels programmés par l'assistant IA (function calling Gemini)
# ─────────────────────────────────────────────────────────────────────────────
# L'IA peut poser un rappel ("rappelle-moi à 12h50 de faire mes devoirs").
# On stocke ces rappels dans un petit fichier JSON (persistant entre
# redémarrages du serveur), et un thread de fond vérifie régulièrement les
# échéances passées pour les faire "sonner" côté client (polling).
RAPPELS_FILE = DATA_DIR / "rappels_assistant.json"
_verrou_rappels = threading.Lock()


def _charger_rappels() -> list[dict]:
    if not RAPPELS_FILE.exists():
        return []
    try:
        with open(RAPPELS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        log.exception("Échec lecture rappels_assistant.json")
        return []


def _sauver_rappels(rappels: list[dict]) -> None:
    try:
        RAPPELS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(RAPPELS_FILE, "w", encoding="utf-8") as f:
            json.dump(rappels, f, ensure_ascii=False, indent=2)
    except Exception:
        log.exception("Échec écriture rappels_assistant.json")


def _ajouter_rappel(quand_iso: str, message: str) -> dict:
    with _verrou_rappels:
        rappels = _charger_rappels()
        nouveau = {
            "id": str(uuid.uuid4()),
            "quand": quand_iso,  # ISO 8601, naïf, heure de Paris
            "message": message,
            "cree_le": _maintenant().isoformat(),
            "declenche": False,
            "vu": False,
        }
        rappels.append(nouveau)
        _sauver_rappels(rappels)
        return nouveau


def _rappels_a_declencher() -> list[dict]:
    """Renvoie les rappels dont l'échéance est passée et qui n'ont pas encore
    été marqués comme déclenchés, puis les marque comme tels."""
    with _verrou_rappels:
        rappels = _charger_rappels()
        maintenant = _maintenant()
        a_declencher = []
        modifie = False
        for r in rappels:
            if r.get("declenche"):
                continue
            try:
                echeance = datetime.datetime.fromisoformat(r["quand"])
            except Exception:
                continue
            if echeance <= maintenant:
                r["declenche"] = True
                modifie = True
                a_declencher.append(r)
        if modifie:
            _sauver_rappels(rappels)
        return a_declencher


def _rappels_en_attente() -> list[dict]:
    with _verrou_rappels:
        return [r for r in _charger_rappels() if not r.get("declenche")]


# ─────────────────────────────────────────────────────────────────────────────
# Devoirs custom (ajoutés à la main quand le prof ne les met pas sur PRONOTE)
# ─────────────────────────────────────────────────────────────────────────────
# Stockés à part dans un JSON local, fusionnés avec les devoirs PRONOTE dans
# /api/devoirs et /api/aujourdhui, et exposés en lecture brute (toutes dates
# confondues) via /api/devoirs/custom/tous pour le userscript BetterPronote++,
# qui les affiche directement sur la vraie page Pronote (visuel uniquement,
# aucune écriture réelle côté Pronote : voir doc de cette route plus bas).
DEVOIRS_CUSTOM_FILE = DATA_DIR / "devoirs_custom.json"
_verrou_devoirs_custom = threading.Lock()


def _charger_devoirs_custom() -> list[dict]:
    if not DEVOIRS_CUSTOM_FILE.exists():
        return []
    try:
        with open(DEVOIRS_CUSTOM_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        log.exception("Échec lecture devoirs_custom.json")
        return []


def _sauver_devoirs_custom(devoirs: list[dict]) -> None:
    try:
        DEVOIRS_CUSTOM_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(DEVOIRS_CUSTOM_FILE, "w", encoding="utf-8") as f:
            json.dump(devoirs, f, ensure_ascii=False, indent=2)
    except Exception:
        log.exception("Échec écriture devoirs_custom.json")


# ── Priorités (devoirs PRONOTE natifs) ──────────────────────────────────────
# PRONOTE n'a pas de notion de priorité : on la stocke localement, à part,
# indexée par l'id du devoir PRONOTE (même mécanisme que devoirs_custom.json,
# mais un fichier séparé car ce ne sont pas des devoirs mais des métadonnées
# attachées à des devoirs qui existent déjà côté PRONOTE).
PRIORITES_FILE = DATA_DIR / "devoirs_priorites.json"
_verrou_priorites = threading.Lock()


def _charger_priorites() -> dict[str, str]:
    if not PRIORITES_FILE.exists():
        return {}
    try:
        with open(PRIORITES_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        log.exception("Échec lecture devoirs_priorites.json")
        return {}


def _sauver_priorites(priorites: dict[str, str]) -> None:
    try:
        PRIORITES_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(PRIORITES_FILE, "w", encoding="utf-8") as f:
            json.dump(priorites, f, ensure_ascii=False, indent=2)
    except Exception:
        log.exception("Échec écriture devoirs_priorites.json")


def _devoirs_custom_pour_semaine(lundi: datetime.date, dimanche: datetime.date) -> list[dict]:
    with _verrou_devoirs_custom:
        tous = _charger_devoirs_custom()
    resultat = []
    for d in tous:
        try:
            date_d = datetime.date.fromisoformat(d["date_iso"])
        except Exception:
            continue
        if lundi <= date_d <= dimanche:
            resultat.append(d)
    return resultat


def _devoir_custom_vers_json(d: dict) -> dict:
    date_d = datetime.date.fromisoformat(d["date_iso"])
    return {
        "id": d["id"],
        "date": date_d.strftime("%d/%m/%Y"),
        "date_iso": d["date_iso"],
        "matiere": d["matiere"],
        "description": d["description"],
        "fait": bool(d.get("fait", False)),
        "priorite": d.get("priorite") if d.get("priorite") in ("haute", "moyenne", "basse") else "moyenne",
        "custom": True,
    }


# ── Déclaration de l'outil "programmer_rappel" pour le function calling Gemini ──
OUTIL_PROGRAMMER_RAPPEL = {
    "name": "programmer_rappel",
    "description": (
        "Programme un rappel qui sera notifié à l'élève à une date/heure précise "
        "dans le futur. Utilise cet outil chaque fois que l'utilisateur demande "
        "explicitement d'être rappelé de quelque chose à un moment donné (ex: "
        "'rappelle-moi à midi 50 de faire mes devoirs', 'préviens-moi dans 20 "
        "minutes'). Calcule toi-même l'horodatage exact au format ISO 8601 "
        "(YYYY-MM-DDTHH:MM:SS) à partir de la date/heure actuelle fournie dans "
        "le contexte et de la demande de l'utilisateur. Le rappel doit se "
        "déclencher même si aucune information réelle ne le justifie (par "
        "exemple si l'élève n'a en réalité pas de devoirs) : le rôle de cet "
        "outil est uniquement de programmer un rappel demandé, pas de vérifier "
        "s'il est fondé."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "quand_iso": {
                "type": "string",
                "description": "Horodatage exact du rappel au format ISO 8601 (YYYY-MM-DDTHH:MM:SS), en heure de Paris, calculé à partir de maintenant.",
            },
            "message": {
                "type": "string",
                "description": "Le message du rappel à afficher à l'élève au moment voulu (ex: 'Faire tes devoirs').",
            },
        },
        "required": ["quand_iso", "message"],
    },
}


# ── Vue "Aujourd'hui" ────────────────────────────────────────────────────────
def _construire_aujourdhui() -> dict:
    """Données de la vue « Aujourd'hui » (réutilisées par le résumé du matin)."""
    if not _client_pret():
        return {"pret": False}
    c = connexion.client
    today = _aujourdhui()

    # Cours du jour
    # NB : ne PAS passer `today` deux fois — pronotepy convertit alors la
    # borne de fin en minuit du même jour (date_to == date_from à minuit),
    # ce qui exclut tous les cours de la journée. En passant None, la lib
    # étend elle-même la borne de fin à 23:59:59 du jour de départ.
    lessons = sorted(connexion.call(c.lessons, today, None), key=lambda l: l.start)
    lessons = _corriger_creneau_pc_svt_lundi(lessons, today.weekday())
    lessons = _dedupliquer_cours_annules(lessons)
    cours = [{
        "debut": l.start.strftime("%H:%M"),
        "fin": l.end.strftime("%H:%M"),
        "matiere": l.subject.name if l.subject else "?",
        "salle": l.classrooms[0] if l.classrooms else "",
        "prof": l.teacher_name or "",
        "annule": l.canceled,
        "en_cours": l.start <= _maintenant() <= l.end,
    } for l in lessons]

    # Prochain cours
    maintenant = _maintenant()
    prochain = next((l for l in lessons if not l.canceled and l.start > maintenant), None)
    prochain_dict = None
    if prochain:
        prochain_dict = {
            "matiere": prochain.subject.name if prochain.subject else "?",
            "debut": prochain.start.strftime("%H:%M"),
            "salle": prochain.classrooms[0] if prochain.classrooms else "",
        }

    # Devoirs pour demain / à venir sous 3 jours
    dans_3_jours = today + datetime.timedelta(days=3)
    homeworks = connexion.call(c.homework, today, dans_3_jours)
    homeworks = sorted([h for h in homeworks if not h.done], key=lambda h: h.date)
    for h in homeworks:
        _cache_devoirs[str(h.id)] = h
    devoirs_urgents_pronote = [{
        "id": h.id,
        "date": h.date.strftime("%d/%m/%Y"),
        "matiere": h.subject.name if h.subject else "?",
        "description": h.description or "",
        "custom": False,
    } for h in homeworks]

    devoirs_urgents_custom = [
        _devoir_custom_vers_json(d) for d in _devoirs_custom_pour_semaine(today, dans_3_jours)
        if not d.get("fait")
    ]
    devoirs_urgents = sorted(devoirs_urgents_pronote + devoirs_urgents_custom, key=lambda d: d["date"])[:5]

    # Dernières notes (3 dernières, toutes périodes confondues via période courante)
    period = c.current_period
    grades = sorted(_lire_periode(c, period, 'grades'), key=lambda g: g.date or datetime.date.min, reverse=True)
    dernieres_notes = [_note_a_dict(g) for g in grades[:3]]

    # Actualités non lues
    try:
        infos = connexion.call(c.information_and_surveys, only_unread=True)
        nb_actus_non_lues = len(infos)
    except Exception:
        nb_actus_non_lues = 0

    # Messages non lus
    try:
        discs = connexion.call(c.discussions, only_unread=True)
        nb_messages_non_lus = sum(max(d.unread, 1) for d in discs) if discs else 0
    except Exception:
        nb_messages_non_lus = 0

    return {
        "pret": True,
        "date": _date_longue_fr(today),
        "cours": cours,
        "prochain_cours": prochain_dict,
        "devoirs_urgents": devoirs_urgents,
        "dernieres_notes": dernieres_notes,
        "nb_actus_non_lues": nb_actus_non_lues,
        "nb_messages_non_lus": nb_messages_non_lus,
    }


@app.route("/api/aujourdhui")
def api_aujourdhui():
    return jsonify(_construire_aujourdhui())


# ── Compteurs non lus (léger : rafraîchit les pastilles après un marquage) ────
@app.route("/api/badges")
def api_badges():
    """Compteurs non lus de la barre de navigation. Un compteur qui n'a pas pu
    être lu vaut None (le front garde alors l'ancienne valeur au lieu de
    masquer à tort la pastille). Renvoie aussi le détail des non lus : le
    front s'en sert pour déclencher une notification quand quelque chose de
    NOUVEAU arrive (et pas seulement quand un compteur change)."""
    if not _client_pret():
        return jsonify({"pret": False}), 200
    c = connexion.client
    actus_non_lues = None
    try:
        infos = connexion.call_retry(c.information_and_surveys, only_unread=True)
        nb_actus = len(infos)
        actus_non_lues = [{
            "id": str(i.id), "titre": i.title or "(sans titre)", "auteur": i.author,
        } for i in infos]
    except Exception:
        log.exception("api_badges : échec compteur actualités")
        nb_actus = None
    messages_non_lus = None
    try:
        discs = connexion.call_retry(c.discussions, only_unread=True)
        nb_messages = sum(max(d.unread, 1) for d in discs) if discs else 0
        messages_non_lus = [{
            "id": str(d.id), "sujet": d.subject or "(sans objet)",
            "auteur": d.creator or "Moi", "non_lus": max(d.unread, 1),
        } for d in (discs or [])]
    except Exception:
        log.exception("api_badges : échec compteur messages")
        nb_messages = None
    return jsonify({
        "pret": True,
        "nb_actus_non_lues": nb_actus,
        "nb_messages_non_lus": nb_messages,
        "actus_non_lues": actus_non_lues,
        "messages_non_lus": messages_non_lus,
    })


# ── Notes ────────────────────────────────────────────────────────────────────
@app.route("/api/notes")
def api_notes():
    if not _client_pret():
        return jsonify({"pret": False}), 200
    c = connexion.client
    period_name = request.args.get("periode", "")
    period = _periode_par_nom(c, period_name)

    grades = _lire_periode(c, period, 'grades')
    notes = [_note_a_dict(g) for g in grades]
    notes.sort(key=lambda n: n["date_iso"] or "", reverse=True)

    # Moyennes par matière : la MIENNE (student), pas celle de la classe.
    moyennes_par_matiere = {}
    try:
        for m in _lire_periode(c, period, 'averages'):
            nom = m.subject.name if m.subject else "?"
            moyennes_par_matiere[nom] = {
                "moyenne": m.student or "—",
                "bareme": m.out_of or "20",
                "moyenne_classe": m.class_average or "—",
                "min": m.min or "—",
                "max": m.max or "—",
            }
    except Exception:
        log.exception("api_notes: échec récupération des moyennes par matière")

    return jsonify({
        "pret": True,
        "periode": period.name,
        "periodes": [p.name for p in c.periods],
        "moyenne_generale": _lire_periode(c, period, 'overall_average') or "—",
        "moyenne_classe": _lire_periode(c, period, 'class_overall_average') or "—",
        "moyennes_par_matiere": moyennes_par_matiere,
        "notes": notes,
    })


@app.route("/api/simulateur")
def api_simulateur():
    """Données de base pour le simulateur de notes « et si ? » : pour chaque
    matière de la période, les notes réelles (valeur/20 + coefficient) et le
    coefficient de la matière au bulletin, pour que le calcul « et si j'avais
    X/20 en plus » se fasse côté client sans refaire d'appel réseau à chaque
    changement de curseur."""
    if not _client_pret():
        return jsonify({"pret": False}), 200
    c = connexion.client
    period_name = request.args.get("periode", "")
    period = _periode_par_nom(c, period_name)

    grades = _lire_periode(c, period, 'grades')

    matieres: dict[str, dict] = {}
    for g in grades:
        nom = g.subject.name if g.subject else "?"
        valeur = _note_valeur_num(g.grade, g.out_of)
        if valeur is None:
            continue  # note non chiffrée (dispense, absent...) : exclue du calcul
        try:
            coef_note = float(str(g.coefficient).replace(",", ".")) if g.coefficient not in (None, "—") else 1.0
        except (ValueError, TypeError):
            coef_note = 1.0
        matieres.setdefault(nom, {"coefficient_matiere": 1.0, "notes": []})
        matieres[nom]["notes"].append({"valeur": valeur, "coefficient": coef_note})

    # Coefficient de CHAQUE MATIÈRE (celui du bulletin, distinct du coefficient
    # de chaque note) ET moyenne officielle Pronote par matière :
    # vient des "averages", pas des "grades".
    try:
        for m in _lire_periode(c, period, 'averages'):
            nom = m.subject.name if m.subject else "?"
            if nom not in matieres:
                continue
            try:
                matieres[nom]["coefficient_matiere"] = float(str(m.subject.coefficient).replace(",", "."))
            except (ValueError, TypeError, AttributeError):
                pass
            # Moyenne officielle calculée par PRONOTE pour cette matière
            # (student_average est déjà sur 20 ; on la stocke brute, le JS
            # l'utilisera directement quand aucune note hypothétique n'est ajoutée)
            try:
                moy_off = m.student_average
                if moy_off not in (None, "—", ""):
                    matieres[nom]["moyenne_officielle"] = float(str(moy_off).replace(",", "."))
            except (ValueError, TypeError, AttributeError):
                pass
    except Exception:
        log.exception("api_simulateur: échec récupération des coefficients de matière")

    return jsonify({
        "pret": True,
        "periode": period.name,
        "periodes": [p.name for p in c.periods],
        "moyenne_generale_actuelle": _lire_periode(c, period, 'overall_average') or None,
        "matieres": matieres,
    })


@app.route("/api/notes/evolution")
def api_notes_evolution():
    """Historique chronologique des notes (toutes périodes de l'année) pour
    tracer une courbe d'évolution de la moyenne générale au fil du temps."""
    if not _client_pret():
        return jsonify({"pret": False}), 200
    c = connexion.client

    points = []
    par_matiere: dict[str, list] = {}

    for period in sorted(c.periods, key=lambda p: p.start):
        try:
            grades = _lire_periode(c, period, 'grades')
        except Exception:
            continue
        for g in grades:
            if not g.date:
                continue
            valeur = _note_valeur_num(g.grade, g.out_of)
            if valeur is None:
                continue
            matiere = g.subject.name if g.subject else "?"
            points.append({
                "date": g.date.isoformat(),
                "valeur": valeur,
                "matiere": matiere,
            })
            par_matiere.setdefault(matiere, []).append({"date": g.date.isoformat(), "valeur": valeur})

    points.sort(key=lambda p: p["date"])

    # Moyenne cumulative (moyenne glissante de toutes les notes reçues jusque-là)
    cumul = []
    somme, n = 0.0, 0
    for p in points:
        somme += p["valeur"]
        n += 1
        cumul.append({"date": p["date"], "moyenne": round(somme / n, 2)})

    return jsonify({
        "pret": True,
        "points": points,
        "moyenne_cumulative": cumul,
        "par_matiere": par_matiere,
    })


@app.route("/api/notes/statistiques")
def api_notes_statistiques():
    """Statistiques avancées + données prêtes pour 4 graphiques, sur les
    VRAIES notes de la période (pas d'exemple codé en dur) :
      - moyenne pondérée (par coefficient de note), médiane, écart-type
      - meilleure / pire matière (par moyenne simple de ses notes)
      - comparaison par matière (ma moyenne vs moyenne de classe)
      - profil radar (moyenne par matière / 20)
      - répartition des coefficients par matière (camembert)
    """
    if not _client_pret():
        return jsonify({"pret": False}), 200
    c = connexion.client
    period_name = request.args.get("periode", "")
    period = _periode_par_nom(c, period_name)

    grades = _lire_periode(c, period, 'grades')

    valeurs: list[float] = []
    poids: list[float] = []
    par_matiere: dict[str, list[tuple[float, float]]] = {}  # nom -> [(valeur/20, coef_note), ...]

    for g in grades:
        valeur = _note_valeur_num(g.grade, g.out_of)
        if valeur is None:
            continue
        try:
            coef = float(str(g.coefficient).replace(",", ".")) if g.coefficient not in (None, "—") else 1.0
        except (ValueError, TypeError):
            coef = 1.0
        valeurs.append(valeur)
        poids.append(coef)
        nom = g.subject.name if g.subject else "?"
        par_matiere.setdefault(nom, []).append((valeur, coef))

    if not valeurs:
        return jsonify({"pret": True, "periode": period.name, "aucune_note": True})

    # ── Moyenne générale officielle PRONOTE (overall_average) ──
    # On utilise la valeur calculée par PRONOTE en priorité absolue.
    # La "moyenne pondérée maison" (somme coefs×note / somme coefs) n'est
    # gardée qu'en repli si overall_average est absent, et le label JS
    # l'indique explicitement grâce au flag "moyenne_officielle".
    moyenne_officielle = None
    try:
        oa = _lire_periode(c, period, 'overall_average')
        if oa not in (None, "", "—"):
            moyenne_officielle = round(float(str(oa).replace(",", ".")), 2)
    except Exception:
        pass
    somme_ponderee = sum(v * p for v, p in zip(valeurs, poids))
    somme_poids = sum(poids)
    moyenne_ponderee_maison = round(somme_ponderee / somme_poids, 2) if somme_poids > 0 else None
    moyenne_ponderee = moyenne_officielle if moyenne_officielle is not None else moyenne_ponderee_maison
    mediane = statistics.median(valeurs)
    ecart_type = statistics.pstdev(valeurs) if len(valeurs) > 1 else 0.0

    # ── Moyenne par matière (simple, pour classement meilleure/pire + radar) ──
    moyennes_simples: dict[str, float] = {
        nom: sum(v for v, _ in notes) / len(notes) for nom, notes in par_matiere.items()
    }
    classement = sorted(moyennes_simples.items(), key=lambda kv: kv[1], reverse=True)
    meilleure_matiere = classement[0][0] if classement else None
    pire_matiere = classement[-1][0] if classement else None

    # ── Comparaison par matière (ma moyenne vs moyenne de classe) + radar ──
    # On utilise DIRECTEMENT les moyennes officielles calculées par PRONOTE
    # (m.student, déjà exprimée sur m.out_of, donc sur 20 dans 99 % des cas),
    # exactement comme le fait /api/notes — on ne recalcule RIEN soi-même.
    comparaison_matieres = []
    radar = []
    coefficients_matiere = []  # coefficient bulletin par matière (pas somme des coefs de notes)
    try:
        for m in _lire_periode(c, period, 'averages'):
            nom = m.subject.name if m.subject else "?"

            # Moyenne officielle PRONOTE de l'élève : m.student est une chaîne
            # sur m.out_of (ex "13,5" sur 20). On la normalise sur 20.
            ma_moy = None
            if m.student not in (None, "", "—"):
                try:
                    val = float(str(m.student).replace(",", "."))
                    bareme = float(str(m.out_of).replace(",", ".")) if m.out_of not in (None, "", "—") else 20.0
                    ma_moy = round(val / bareme * 20, 2) if bareme > 0 else None
                except (ValueError, TypeError):
                    pass

            # Moyenne de classe officielle PRONOTE
            moy_classe = None
            if m.class_average not in (None, "", "—"):
                try:
                    val_c = float(str(m.class_average).replace(",", "."))
                    bareme = float(str(m.out_of).replace(",", ".")) if m.out_of not in (None, "", "—") else 20.0
                    moy_classe = round(val_c / bareme * 20, 2) if bareme > 0 else None
                except (ValueError, TypeError):
                    pass

            comparaison_matieres.append({
                "matiere": nom,
                "votre_moyenne": ma_moy,
                "moyenne_classe": moy_classe,
            })
            if ma_moy is not None:
                radar.append({"matiere": nom, "valeur": ma_moy})

            # Coefficient de la matière au bulletin (vient de m.subject.coefficient,
            # pas de la somme des coefficients de chaque note individuelle)
            coef_mat = 1.0
            try:
                coef_mat = float(str(m.subject.coefficient).replace(",", "."))
            except (ValueError, TypeError, AttributeError):
                pass
            coefficients_matiere.append({"matiere": nom, "coefficient": round(coef_mat, 2)})

        if comparaison_matieres:
            classement = sorted(
                [d for d in comparaison_matieres if d["votre_moyenne"] is not None],
                key=lambda d: d["votre_moyenne"], reverse=True,
            )
            if classement:
                meilleure_matiere = classement[0]["matiere"]
                pire_matiere = classement[-1]["matiere"]
    except Exception:
        log.exception("api_notes_statistiques: échec comparaison par matière")
        # Repli uniquement si averages est totalement inaccessible : on
        # indique clairement que ces moyennes sont recalculées, pas officielles.
        comparaison_matieres = [
            {"matiere": nom, "votre_moyenne": round(moy, 2), "moyenne_classe": None}
            for nom, moy in moyennes_simples.items()
        ]
        radar = [{"matiere": nom, "valeur": round(moy, 2)} for nom, moy in moyennes_simples.items()]
        # Camembert : somme des coefs de notes par matière (approximation de repli)
        coefficients_matiere = [
            {"matiere": nom, "coefficient": round(sum(c_ for _, c_ in notes), 2)}
            for nom, notes in par_matiere.items()
        ]

    return jsonify({
        "pret": True,
        "periode": period.name,
        "aucune_note": False,
        "statistiques": {
            "moyenne_ponderee": round(moyenne_ponderee, 2) if moyenne_ponderee is not None else None,
            # True = valeur issue directement de PRONOTE (overall_average)
            # False = recalcul maison par manque de données PRONOTE (repli)
            "moyenne_est_officielle": moyenne_officielle is not None,
            "mediane": round(mediane, 2),
            "ecart_type": round(ecart_type, 2),
            "meilleure_matiere": meilleure_matiere,
            "pire_matiere": pire_matiere,
            "nombre_notes": len(valeurs),
            "total_coefficients": round(somme_poids, 2),
        },
        "comparaison_matieres": sorted(comparaison_matieres, key=lambda d: d["matiere"]),
        "radar": sorted(radar, key=lambda d: d["matiere"]),
        "coefficients_matiere": sorted(coefficients_matiere, key=lambda d: d["matiere"]),
    })


# ── Emploi du temps ──────────────────────────────────────────────────────────
# Cache des objets Lesson déjà listés par /api/edt (id -> objet pronotepy),
# pour que /api/edt/<id>/contenu puisse récupérer .content sans re-scanner
# toute la semaine.
_cache_cours: dict[str, object] = {}


@app.route("/api/edt")
def api_edt():
    if not _client_pret():
        return jsonify({"pret": False}), 200
    c = connexion.client
    offset = int(request.args.get("offset", 0))
    lundi, dimanche = _bornes_semaine(offset)
    lessons = sorted(connexion.call(c.lessons, lundi, dimanche), key=lambda l: l.start)
    for l in lessons:
        _cache_cours[str(l.id)] = l

    # Devoirs de la semaine (PRONOTE + custom), pour signaler d'un badge les
    # jours où un devoir a été donné.
    homeworks = connexion.call(c.homework, lundi, dimanche)
    devoirs_par_date: dict[str, int] = {}
    for h in homeworks:
        devoirs_par_date[h.date.isoformat()] = devoirs_par_date.get(h.date.isoformat(), 0) + 1
    for d in _devoirs_custom_pour_semaine(lundi, dimanche):
        devoirs_par_date[d["date_iso"]] = devoirs_par_date.get(d["date_iso"], 0) + 1

    jours = []
    for i, nom in enumerate(JOURS_FR):
        jour_date = lundi + datetime.timedelta(days=i)
        cours_jour = [l for l in lessons if l.start.weekday() == i]
        cours_jour = _corriger_creneau_pc_svt_lundi(cours_jour, i)
        cours_jour = _dedupliquer_cours_annules(cours_jour)
        jours.append({
            "nom": nom,
            "date": jour_date.strftime("%d/%m"),
            "nb_devoirs": devoirs_par_date.get(jour_date.isoformat(), 0),
            "cours": [{
                "id": l.id,
                "debut": l.start.strftime("%H:%M"),
                "fin": l.end.strftime("%H:%M"),
                "matiere": l.subject.name if l.subject else "?",
                "salle": l.classrooms[0] if l.classrooms else "",
                "prof": l.teacher_name or "",
                "annule": l.canceled,
            } for l in sorted(cours_jour, key=lambda l: l.start)],
        })

    return jsonify({
        "pret": True,
        "semaine_du": lundi.strftime("%d/%m/%Y"),
        "offset": offset,
        "jours": jours,
    })


@app.route("/api/edt/<lesson_id>/contenu")
def api_edt_contenu(lesson_id):
    """Contenu détaillé d'un cours (cahier de texte PRONOTE) + pièces jointes
    + devoirs (PRONOTE et custom) rattachés à la même date, pour le popup
    ouvert au clic sur un cours dans l'emploi du temps."""
    if not _client_pret():
        return jsonify({"ok": False, "erreur": "non connecté"}), 400

    lecon = _cache_cours.get(str(lesson_id))
    if not lecon:
        return jsonify({"ok": False, "erreur": "cours introuvable (recharge l'emploi du temps)"}), 404

    resultat = {
        "ok": True,
        "matiere": lecon.subject.name if lecon.subject else "?",
        "debut": lecon.start.strftime("%H:%M"),
        "fin": lecon.end.strftime("%H:%M"),
        "salle": lecon.classrooms[0] if lecon.classrooms else "",
        "prof": lecon.teacher_name or "",
        "annule": lecon.canceled,
        "titre": None,
        "description": None,
        "categorie": None,
        "pieces_jointes": [],
        "devoirs": [],
    }

    try:
        contenu = connexion.call(lambda: lecon.content)
        if contenu:
            resultat["titre"] = contenu.title
            resultat["description"] = contenu.description
            resultat["categorie"] = contenu.category
            resultat["pieces_jointes"] = [{
                "nom": p.name, "url": p.url, "type": p.type,
            } for p in contenu.files]
    except Exception:
        log.exception("Échec récupération contenu du cours %s", lesson_id)

    try:
        c = connexion.client
        jour = lecon.start.date()
        homeworks = connexion.call(c.homework, jour, jour)
        for h in homeworks:
            if h.date == jour and (not h.subject or not lecon.subject or h.subject.name == lecon.subject.name):
                resultat["devoirs"].append({
                    "id": h.id, "matiere": h.subject.name if h.subject else "?",
                    "description": h.description or "", "fait": h.done, "custom": False,
                })
        for d in _devoirs_custom_pour_semaine(jour, jour):
            resultat["devoirs"].append(_devoir_custom_vers_json(d))
    except Exception:
        log.exception("Échec récupération devoirs du jour pour le cours %s", lesson_id)

    return jsonify(resultat)


# ── Devoirs ───────────────────────────────────────────────────────────────────
@app.route("/api/devoirs")
def api_devoirs():
    if not _client_pret():
        return jsonify({"pret": False}), 200
    c = connexion.client
    offset = int(request.args.get("offset", 0))
    lundi, dimanche = _bornes_semaine(offset)
    homeworks = sorted(connexion.call(c.homework, lundi, dimanche), key=lambda h: h.date)

    # On alimente le cache avec les objets fraîchement listés : c'est sur ce
    # cache que /api/devoirs/<id>/fait s'appuiera pour éviter de re-chercher
    # (et potentiellement rater) l'objet via un nouvel appel c.homework(...).
    for h in homeworks:
        _cache_devoirs[str(h.id)] = h

    priorites = _charger_priorites()
    devoirs_pronote = [{
        "id": h.id,
        "date": h.date.strftime("%d/%m/%Y"),
        "matiere": h.subject.name if h.subject else "?",
        "description": h.description or "",
        "fait": h.done,
        "priorite": priorites.get(str(h.id), "moyenne"),
        "custom": False,
    } for h in homeworks]

    devoirs_custom = [_devoir_custom_vers_json(d) for d in _devoirs_custom_pour_semaine(lundi, dimanche)]
    tous_devoirs = sorted(devoirs_pronote + devoirs_custom, key=lambda d: d["date"])

    return jsonify({
        "pret": True,
        "semaine_du": lundi.strftime("%d/%m/%Y"),
        "offset": offset,
        "devoirs": tous_devoirs,
    })


@app.route("/api/devoirs/custom/tous")
def api_devoirs_custom_tous():
    """Liste brute de TOUS les devoirs custom (toutes dates confondues), sans
    notion de semaine PRONOTE. Consommée par le userscript BetterPronote++,
    qui tourne sur le vrai domaine Pronote et les injecte visuellement dans
    la page Cahier de textes / Travail à faire — affichage local uniquement,
    ça n'écrit jamais rien dans la vraie base PRONOTE de l'établissement."""
    with _verrou_devoirs_custom:
        tous = _charger_devoirs_custom()
    return jsonify({"ok": True, "devoirs": [_devoir_custom_vers_json(d) for d in tous]})


@app.route("/api/devoirs/custom", methods=["POST"])
def api_devoir_custom_ajouter():
    payload = request.json or {}
    matiere = (payload.get("matiere") or "").strip()
    description = (payload.get("description") or "").strip()
    date_iso = (payload.get("date_iso") or "").strip()
    priorite = (payload.get("priorite") or "moyenne").strip()
    if priorite not in ("haute", "moyenne", "basse"):
        priorite = "moyenne"

    if not matiere or not description or not date_iso:
        return jsonify({"ok": False, "erreur": "matière, description et date sont obligatoires"}), 400
    try:
        datetime.date.fromisoformat(date_iso)
    except ValueError:
        return jsonify({"ok": False, "erreur": "date invalide (format attendu AAAA-MM-JJ)"}), 400

    nouveau = {
        "id": f"local-{uuid.uuid4()}",
        "matiere": matiere,
        "description": description,
        "date_iso": date_iso,
        "fait": False,
        "priorite": priorite,
        "cree_le": _maintenant().isoformat(),
    }
    with _verrou_devoirs_custom:
        devoirs = _charger_devoirs_custom()
        devoirs.append(nouveau)
        _sauver_devoirs_custom(devoirs)

    return jsonify({"ok": True, "devoir": _devoir_custom_vers_json(nouveau)})


@app.route("/api/devoirs/custom/<devoir_id>", methods=["DELETE"])
def api_devoir_custom_supprimer(devoir_id):
    with _verrou_devoirs_custom:
        devoirs = _charger_devoirs_custom()
        restants = [d for d in devoirs if d["id"] != devoir_id]
        if len(restants) == len(devoirs):
            return jsonify({"ok": False, "erreur": "devoir introuvable"}), 404
        _sauver_devoirs_custom(restants)
    return jsonify({"ok": True})


@app.route("/api/devoirs/custom/<devoir_id>/fait", methods=["POST"])
def api_devoir_custom_fait(devoir_id):
    nouvel_etat = bool((request.json or {}).get("fait", True))
    with _verrou_devoirs_custom:
        devoirs = _charger_devoirs_custom()
        cible = next((d for d in devoirs if d["id"] == devoir_id), None)
        if not cible:
            return jsonify({"ok": False, "erreur": "devoir introuvable"}), 404
        cible["fait"] = nouvel_etat
        _sauver_devoirs_custom(devoirs)
    return jsonify({"ok": True, "fait": nouvel_etat})


@app.route("/api/devoirs/custom/<devoir_id>/priorite", methods=["POST"])
def api_devoir_custom_priorite(devoir_id):
    priorite = ((request.json or {}).get("priorite") or "").strip()
    if priorite not in ("haute", "moyenne", "basse"):
        return jsonify({"ok": False, "erreur": "priorité invalide (haute/moyenne/basse)"}), 400
    with _verrou_devoirs_custom:
        devoirs = _charger_devoirs_custom()
        cible = next((d for d in devoirs if d["id"] == devoir_id), None)
        if not cible:
            return jsonify({"ok": False, "erreur": "devoir introuvable"}), 404
        cible["priorite"] = priorite
        _sauver_devoirs_custom(devoirs)
    return jsonify({"ok": True, "priorite": priorite})


@app.route("/api/devoirs/<homework_id>/priorite", methods=["POST"])
def api_devoir_priorite(homework_id):
    """Fixe la priorité (haute/moyenne/basse) d'un devoir PRONOTE natif.
    Stockée localement (fichier à part) puisque PRONOTE n'a pas ce champ."""
    priorite = ((request.json or {}).get("priorite") or "").strip()
    if priorite not in ("haute", "moyenne", "basse"):
        return jsonify({"ok": False, "erreur": "priorité invalide (haute/moyenne/basse)"}), 400
    with _verrou_priorites:
        priorites = _charger_priorites()
        priorites[str(homework_id)] = priorite
        _sauver_priorites(priorites)
    return jsonify({"ok": True, "priorite": priorite})


@app.route("/api/devoirs/<homework_id>/fait", methods=["POST"])
def api_devoir_fait(homework_id):
    if not _client_pret():
        return jsonify({"ok": False, "erreur": "non connecté"}), 400
    nouvel_etat = bool((request.json or {}).get("fait", True))

    # 1) Priorité au cache : l'objet Homework déjà chargé lors du dernier
    #    /api/devoirs (ou /api/aujourdhui). C'est l'approche qui marchait
    #    côté bot Telegram (assignCache) : on réutilise l'objet tel quel au
    #    lieu de re-chercher l'ID via un nouvel appel c.homework(...), qui
    #    peut échouer selon la fenêtre de dates interrogée.
    cible = _cache_devoirs.get(str(homework_id))

    # 2) Filet de sécurité si le cache est vide (ex: redémarrage du serveur
    #    sans être repassé par /api/devoirs avant de cliquer) : on retente
    #    une recherche large.
    if not cible:
        c = connexion.client
        today = _aujourdhui()
        for debut, fin in [
            (today - datetime.timedelta(weeks=6), today + datetime.timedelta(weeks=20)),
            (today - datetime.timedelta(weeks=52), None),
        ]:
            try:
                hw_list = connexion.call(c.homework, debut, fin)
            except Exception:
                log.exception("Échec récupération devoirs (fenêtre %s → %s)", debut, fin)
                continue
            for h in hw_list:
                _cache_devoirs[str(h.id)] = h
            cible = next((h for h in hw_list if str(h.id) == str(homework_id)), None)
            if cible:
                break

    if not cible:
        return jsonify({"ok": False, "erreur": "devoir introuvable"}), 404

    try:
        connexion.call(cible.set_done, nouvel_etat)
        return jsonify({"ok": True, "fait": nouvel_etat})
    except Exception as e:
        log.exception("Échec set_done")
        return jsonify({"ok": False, "erreur": str(e)}), 500


# ── Actualités / informations de l'établissement ────────────────────────────
@app.route("/api/actualites")
def api_actualites():
    if not _client_pret():
        return jsonify({"pret": False}), 200
    c = connexion.client
    try:
        infos = connexion.call(c.information_and_surveys)
    except Exception as e:
        log.exception("Échec récupération actualités")
        return jsonify({"pret": True, "actualites": [], "erreur": str(e)})

    infos.sort(key=lambda i: i.creation_date or datetime.datetime.min, reverse=True)

    return jsonify({
        "pret": True,
        "actualites": [{
            "id": i.id,
            "titre": i.title or "(sans titre)",
            "auteur": i.author,
            "categorie": i.category,
            "date": i.creation_date.strftime("%d/%m/%Y %H:%M") if i.creation_date else "",
            "lu": bool(i.read),
            "sondage": i.survey,
        } for i in infos],
    })


def _actus_brutes(c, modes: str = "[0..3]") -> list[tuple[int, dict]]:
    """JSON brut de PRONOTE pour les actualités, avec le numéro du mode
    d'affichage. information_and_surveys() fusionne les 4 modes : une même
    actualité peut donc apparaître plusieurs fois. Avec modes="[0]", on fait la
    même requête que le client web après un marquage lu / non lu."""
    donnees = {"modesAffActus": {"_T": 26, "V": modes}}
    if modes == "[0]":
        donnees["genreRequeteActualite"] = 0
    rep = connexion.call(c.post, "PageActualites", 8, donnees)
    resultat = []
    for mode, liste in enumerate(rep["dataSec"]["data"]["listeModesAff"]):
        for obj in liste["listeActualites"]["V"]:
            resultat.append((mode, obj))
    return resultat


def _copies_non_lues(c, info_id: str, modes: str = "[0..3]") -> list[int] | None:
    """Modes dans lesquels l'actualité apparaît encore non lue (None = absente)."""
    copies = [(m, o) for m, o in _actus_brutes(c, modes) if str(o.get("N")) == str(info_id)]
    if not copies:
        return None
    return [m for m, o in copies if not o.get("lue")]


def _marquer_actu_lue(c, info_id: str) -> tuple[bool, str | None, int, str | None]:
    """Marque une actualité comme lue sur PRONOTE, puis RELIT l'état brut pour
    vérifier que PRONOTE l'a bien pris en compte. Utilise la requête du client
    web de PRONOTE (marqueLueSeulement), avec en secours celle de pronotepy.
    Tout est consigné dans les logs ([actus]).

    Renvoie (ok, erreur, code_http, tentative_ayant_marché).
    Partagé par la route unitaire et par « tout marquer comme lu »."""
    brutes = [(m, o) for m, o in _actus_brutes(c) if str(o.get("N")) == str(info_id)]
    if not brutes:
        return False, "actualité introuvable", 404, None
    log.info("[actus] id=%s présente dans les modes %s, lue par mode=%s",
             info_id, [m for m, _ in brutes], [bool(o.get("lue")) for _, o in brutes])
    log.info("[actus] objet brut : %s", json.dumps(brutes[0][1], ensure_ascii=False)[:1500])

    brut = brutes[0][1]
    # Dans la liste, PRONOTE enveloppe les objets : {"_T": 24, "V": {...}}.
    # La requête de saisie du client web attend l'objet à plat.
    public = brut.get("public") or {"N": c.info.id, "G": 4, "L": c.info.name}
    if isinstance(public, dict) and "V" in public:
        public = public["V"]

    def payload_web():
        # Reproduit à l'identique la requête envoyée par le client web de
        # PRONOTE quand on bascule une actualité lue (marqueLueSeulement :
        # ne touche pas à « J'ai pris connaissance »).
        return {
            "genreSaisie": 0,
            "listeActualites": [{
                "N": brut["N"],
                "L": brut.get("L"),
                "validationDirecte": True,
                "genrePublic": 4,
                "public": public,
                "estPublic": True,
                "lue": True,
                "supprimee": False,
                "marqueLueSeulement": True,
                "saisieActualite": False,
                "listeQuestions": [],
            }],
            "saisieActualite": False,
        }

    def payload_pronotepy():
        return {
            "listeActualites": [{
                "N": info_id, "validationDirecte": True,
                "genrePublic": 4, "public": public, "lue": True,
            }],
            "saisieActualite": False,
        }

    for nom, construire in (("web", payload_web), ("pronotepy", payload_pronotepy)):
        try:
            rep = connexion.call(c.post, "SaisieActualites", 8, construire())
            log.info("[actus] tentative %s : réponse %s", nom,
                     json.dumps(rep, ensure_ascii=False)[:800])
            if (rep.get("dataSec", {}).get("RapportSaisie", {}) or {}).get("_erreurSaisie_"):
                log.warning("[actus] tentative %s : PRONOTE signale une erreur de saisie", nom)
                continue
        except Exception:
            log.exception("[actus] tentative %s : exception", nom)
            continue
        mode0 = _copies_non_lues(c, info_id, "[0]")
        tous = _copies_non_lues(c, info_id, "[0..3]")
        log.info("[actus] tentative %s : non lus après = mode[0] %s | modes[0..3] %s",
                 nom, mode0, tous)
        if mode0 == []:
            return True, None, 200, nom

    return False, "PRONOTE n'a pas pris en compte la demande (voir les logs [actus]).", 502, None


@app.route("/api/actualites/<info_id>/lue", methods=["POST"])
def api_actualite_lue(info_id):
    if not _client_pret():
        return jsonify({"ok": False, "erreur": "non connecté"}), 400
    c = connexion.client
    try:
        ok, erreur, code, tentative = _marquer_actu_lue(c, info_id)
        if ok:
            return jsonify({"ok": True, "tentative": tentative})
        return jsonify({"ok": False, "erreur": erreur}), code
    except Exception as e:
        log.exception("Échec marquage actualité %s comme lue", info_id)
        return jsonify({"ok": False, "erreur": str(e)}), 500


@app.route("/api/actualites/tout_lu", methods=["POST"])
def api_actualites_tout_lu():
    """« Tout marquer comme lu » : réutilise, une par une, la requête déjà
    validée pour une actualité (pas de requête groupée devinée)."""
    if not _client_pret():
        return jsonify({"ok": False, "erreur": "non connecté"}), 400
    c = connexion.client
    try:
        non_lues = connexion.call_retry(c.information_and_surveys, only_unread=True)
    except Exception as e:
        log.exception("Tout lu actus : échec liste")
        return jsonify({"ok": False, "erreur": str(e)}), 500
    ids = list(dict.fromkeys(str(i.id) for i in non_lues))  # sans doublons, ordre gardé
    reussies, echecs = 0, []
    for info_id in ids:
        try:
            ok, erreur, _code, _t = _marquer_actu_lue(c, info_id)
        except Exception as e:
            ok, erreur = False, str(e)
        if ok:
            reussies += 1
        else:
            echecs.append({"id": info_id, "erreur": erreur})
    return jsonify({"ok": not echecs, "total": len(ids), "reussies": reussies, "echecs": echecs})


@app.route("/api/discussions/<int:disc_id>/lue", methods=["POST"])
def api_discussion_lue(disc_id):
    """Marque une discussion comme lue directement sur PRONOTE
    (Discussion.mark_as de pronotepy)."""
    if not _client_pret():
        return jsonify({"ok": False, "erreur": "non connecté"}), 400
    c = connexion.client
    try:
        discussions = connexion.call(c.discussions)
        cible = discussions[disc_id] if 0 <= disc_id < len(discussions) else None
        if not cible:
            return jsonify({"ok": False, "erreur": "discussion introuvable"}), 404
        connexion.call(cible.mark_as, True)
        return jsonify({"ok": True})
    except Exception as e:
        log.exception("Échec marquage discussion %s comme lue", disc_id)
        return jsonify({"ok": False, "erreur": str(e)}), 500


@app.route("/api/discussions/<int:disc_id>/non_lue", methods=["POST"])
def api_discussion_non_lue(disc_id):
    """Marque une discussion comme NON lue (Discussion.mark_as(False) de
    pronotepy : même commande « pourLu » que pour « lue », avec lu=False).
    ⚠ Non testé en conditions réelles : voir les logs [discussions]."""
    if not _client_pret():
        return jsonify({"ok": False, "erreur": "non connecté"}), 400
    c = connexion.client
    try:
        discussions = connexion.call(c.discussions)
        cible = discussions[disc_id] if 0 <= disc_id < len(discussions) else None
        if not cible:
            return jsonify({"ok": False, "erreur": "discussion introuvable"}), 404
        connexion.call(cible.mark_as, False)
        log.info("[discussions] id=%s marquée non lue", disc_id)
        return jsonify({"ok": True})
    except Exception as e:
        log.exception("Échec marquage discussion %s comme non lue", disc_id)
        return jsonify({"ok": False, "erreur": str(e)}), 500


@app.route("/api/discussions/tout_lu", methods=["POST"])
def api_discussions_tout_lu():
    if not _client_pret():
        return jsonify({"ok": False, "erreur": "non connecté"}), 400
    c = connexion.client
    try:
        discussions = connexion.call(c.discussions)
    except Exception as e:
        log.exception("Tout lu discussions : échec liste")
        return jsonify({"ok": False, "erreur": str(e)}), 500
    reussies, echecs = 0, []
    for idx, d in enumerate(discussions):
        if not d.unread:
            continue
        try:
            connexion.call(d.mark_as, True)
            reussies += 1
        except Exception as e:
            log.exception("Tout lu discussions : échec sur %s", idx)
            echecs.append({"id": idx, "erreur": str(e)})
    return jsonify({"ok": not echecs, "reussies": reussies, "echecs": echecs})


def _html_pronote_vers_html_propre(html_brut: str) -> str:
    """Reconstruit un HTML propre et sûr à partir du HTML brut renvoyé par
    Pronote pour le contenu d'une actualité.

    Pourquoi cette fonction existe : pronotepy expose `Information.content`
    qui appelle en interne `Util.html_parse`, lequel fait juste
    `re.sub("<.*?>", "", html)` — ça retire TOUTES les balises, y compris
    les <p>, <br>, <li> qui séparaient les paragraphes, SANS les remplacer
    par un saut de ligne. Résultat : des actualités avec plusieurs
    paragraphes bien séparés dans Pronote arrivent collées en un seul bloc
    de texte illisible côté dashboard (ex : "Madame, Monsieur,Durant le
    mois de septembre...").

    On repart donc ici du HTML brut (accessible via `cible._raw_content`,
    rempli par `cible.content()`/`cible.attachments()`) et on :
      1. Neutralise les balises dangereuses (script/style) avant tout.
      2. Convertit les balises de structure Pronote usuelles en HTML propre
         équivalent (paragraphes, retours à la ligne, listes, gras, liens).
      3. Échappe tout le texte restant puis ne réautorise que les quelques
         balises qu'on vient de générer nous-mêmes.
    """
    if not html_brut:
        return ""

    texte = html_brut

    # 1) Neutraliser scripts/styles avant toute autre transformation
    texte = re.sub(r"(?is)<script.*?>.*?</script>", "", texte)
    texte = re.sub(r"(?is)<style.*?>.*?</style>", "", texte)

    # 2) Normaliser les sauts de ligne/paragraphes/listes Pronote en
    #    marqueurs internes, AVANT de dépouiller le reste des balises.
    texte = re.sub(r"(?i)<br\s*/?>", "\u0000BR\u0000", texte)
    texte = re.sub(r"(?i)</p>", "\u0000PFIN\u0000", texte)
    texte = re.sub(r"(?i)<p[^>]*>", "", texte)
    # Pronote (éditeur type contenteditable) encapsule très souvent chaque
    # ligne dans <div>...</div> plutôt que <p>...</p>/<br>, sans balise de
    # saut de ligne explicite entre les blocs. Sans traitement, ces actus
    # arrivent collées en un seul bloc de texte illisible (balises retirées
    # plus loin sans laisser de saut de ligne).
    #
    # Dans du HTML généré par un éditeur contenteditable, une ligne vide
    # volontaire (vraie séparation de paragraphe) se traduit typiquement par
    # un <div> ne contenant que &nbsp;/espaces (voire complètement vide).
    # On distingue donc :
    #   - un <div> vide (ou juste &nbsp;) -> saut de PARAGRAPHE (ligne vide)
    #   - un <div> normal -> simple retour à la ligne (<br>), pas de ligne
    #     vide, pour respecter la mise en forme réelle vue dans Pronote.
    texte = re.sub(
        r"(?i)<div[^>]*>(?:\s|&nbsp;)*</div>",
        "\u0000PFIN\u0000",
        texte,
    )
    texte = re.sub(r"(?i)</div>", "\u0000BR\u0000", texte)
    texte = re.sub(r"(?i)<div[^>]*>", "", texte)
    texte = re.sub(r"(?i)</li>", "\u0000LIFIN\u0000", texte)
    texte = re.sub(r"(?i)<li[^>]*>", "\u0000LIDEB\u0000", texte)
    texte = re.sub(r"(?i)<ul[^>]*>", "\u0000ULDEB\u0000", texte)
    texte = re.sub(r"(?i)</ul>", "\u0000ULFIN\u0000", texte)
    texte = re.sub(r"(?i)<ol[^>]*>", "\u0000OLDEB\u0000", texte)
    texte = re.sub(r"(?i)</ol>", "\u0000OLFIN\u0000", texte)
    texte = re.sub(r"(?i)</(strong|b)[^>]*>", "\u0000GRASFIN\u0000", texte)
    texte = re.sub(r"(?i)<(strong|b)[^>]*>", "\u0000GRASDEB\u0000", texte)
    texte = re.sub(r"(?i)</(em|i)[^>]*>", "\u0000ITALFIN\u0000", texte)
    texte = re.sub(r"(?i)<(em|i)[^>]*>", "\u0000ITALDEB\u0000", texte)

    # Liens : on ne garde que les liens http(s). Pour un lien dont le href
    # n'est pas http(s) (javascript:, mailto: exclu volontairement ici,
    # etc.), on retire la balise <a>...</a> mais on garde son texte visible
    # plutôt que de laisser une balise fermante orpheline plus loin.
    def _filtrer_lien_non_http(m: "re.Match[str]") -> str:
        href, texte_lien = m.group(1), m.group(2)
        if href.lower().strip().startswith(("http://", "https://")):
            return m.group(0)  # inchangé, traité à l'étape suivante
        return texte_lien

    texte = re.sub(
        r'(?is)<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>',
        _filtrer_lien_non_http,
        texte,
    )

    liens: list[str] = []

    def _capturer_lien(m: "re.Match[str]") -> str:
        href = m.group(1)
        idx = len(liens)
        liens.append(href)
        return f"\u0000LIENDEB{idx}\u0000"

    texte = re.sub(r'(?i)<a[^>]*href="([^"]*)"[^>]*>', _capturer_lien, texte)
    texte = re.sub(r"(?i)</a>", "\u0000LIENFIN\u0000", texte)

    # 3) Retirer toutes les balises HTML restantes (celles qu'on ne gère
    #    pas explicitement : span, font, table Pronote spécifiques…)
    texte = re.sub(r"<[^>]*>", "", texte)

    # 4) Dé-échapper les entités HTML (&nbsp;, &eacute;, etc.) puis
    #    ré-échapper proprement pour la sortie finale (sécurité XSS)
    texte = html_unescape(texte)
    texte = html_escape(texte)

    # 5) Nettoyer les <br> en trop en bordure de paragraphe (issus des
    #    <div> normaux juste avant/après un <div> vide) pour éviter des
    #    paragraphes du style <p><br>texte</p> ou <p>texte<br></p>.
    texte = re.sub(r"(\u0000BR\u0000)+\u0000PFIN\u0000", "\u0000PFIN\u0000", texte)
    texte = re.sub(r"\u0000PFIN\u0000(\u0000BR\u0000)+", "\u0000PFIN\u0000", texte)
    texte = re.sub(r"^(\u0000BR\u0000)+", "", texte)
    texte = re.sub(r"(\u0000BR\u0000)+$", "", texte)

    # 6) Réintroduire les balises HTML propres à partir des marqueurs
    texte = texte.replace("\u0000BR\u0000", "<br>")
    texte = texte.replace("\u0000PFIN\u0000", "</p><p>")
    texte = texte.replace("\u0000LIDEB\u0000", "<li>")
    texte = texte.replace("\u0000LIFIN\u0000", "</li>")
    texte = texte.replace("\u0000ULDEB\u0000", "<ul>")
    texte = texte.replace("\u0000ULFIN\u0000", "</ul>")
    texte = texte.replace("\u0000OLDEB\u0000", "<ol>")
    texte = texte.replace("\u0000OLFIN\u0000", "</ol>")
    texte = texte.replace("\u0000GRASDEB\u0000", "<b>")
    texte = texte.replace("\u0000GRASFIN\u0000", "</b>")
    texte = texte.replace("\u0000ITALDEB\u0000", "<i>")
    texte = texte.replace("\u0000ITALFIN\u0000", "</i>")
    texte = texte.replace("\u0000LIENFIN\u0000", "</a>")

    def _reinjecter_lien(m: "re.Match[str]") -> str:
        idx = int(m.group(1))
        href_propre = html_escape(liens[idx], quote=True)
        return f'<a href="{href_propre}" target="_blank" rel="noopener noreferrer">'

    texte = re.sub(r"\u0000LIENDEB(\d+)\u0000", _reinjecter_lien, texte)

    texte_final = f"<p>{texte}</p>"
    # Nettoyage final : paragraphes vides (retire le <p></p> systématique
    # laissé par un dernier </p> suivi de rien, et par les listes qui se
    # sont retrouvées entre deux </p><p>).
    texte_final = re.sub(r"<p>\s*</p>", "", texte_final)
    return texte_final if re.sub(r"<[^>]*>", "", texte_final).strip() else ""


@app.route("/api/actualites/<info_id>/contenu")
def api_actualite_contenu(info_id):
    if not _client_pret():
        return jsonify({"pret": False}), 200
    c = connexion.client
    try:
        infos = connexion.call(c.information_and_surveys)
        cible = next((i for i in infos if i.id == info_id), None)
        if not cible:
            return jsonify({"ok": False, "erreur": "introuvable"}), 404

        # On appelle .content() d'abord pour déclencher _fetch_content() et
        # remplir cible._raw_content (API interne de pronotepy), puis on
        # reconstruit nous-mêmes un HTML propre à partir du brut plutôt que
        # d'utiliser cible.content directement (voir _html_pronote_vers_html_propre
        # pour le pourquoi : pronotepy retire les balises sans les remplacer
        # par des sauts de ligne, ce qui colle tous les paragraphes ensemble).
        connexion.call(cible.content)
        html_brut = ""
        if cible._raw_content:
            try:
                # `_raw_content` (listeQuestions) peut contenir PLUSIEURS blocs de
                # texte pour une même actualité (ex : actu en plusieurs parties,
                # ou bloc de question de sondage séparé du texte principal).
                # Prendre uniquement [0] tronquait ou ratait le contenu réel de
                # certaines actus. On concatène désormais tous les blocs qui ont
                # un texte non vide.
                morceaux_html = []
                for bloc in cible._raw_content:
                    try:
                        morceau = bloc.get("texte", {}).get("V", "")
                    except AttributeError:
                        morceau = ""
                    if morceau and morceau.strip():
                        morceaux_html.append(morceau)
                html_brut = "<br><br>".join(morceaux_html)
            except (KeyError, IndexError, TypeError):
                log.exception("Structure inattendue pour _raw_content de l'actualité %s", info_id)
        contenu = _html_pronote_vers_html_propre(html_brut)

        pieces_jointes = []
        try:
            for piece in connexion.call(cible.attachments):
                pieces_jointes.append({
                    "nom": piece.name,
                    "url": piece.url,
                    "type": piece.type,  # 0 = lien, 1 = fichier
                })
        except Exception:
            log.exception("Échec récupération pièces jointes actualité %s", info_id)

        return jsonify({"ok": True, "contenu": contenu, "pieces_jointes": pieces_jointes})
    except Exception as e:
        log.exception("Échec lecture actualité")
        return jsonify({"ok": False, "erreur": str(e)}), 500


# ── Vie scolaire : absences / retards / punitions ─────────────────────────────
@app.route("/api/absences")
def api_absences():
    if not _client_pret():
        return jsonify({"pret": False}), 200
    c = connexion.client
    period_name = request.args.get("periode", "")
    period = _periode_par_nom(c, period_name)

    try:
        absences = _lire_periode(c, period, 'absences')
        retards = _lire_periode(c, period, 'delays')
    except Exception as e:
        log.exception("Échec récupération absences/retards")
        return jsonify({"pret": True, "absences": [], "retards": [], "punitions": [], "erreur": str(e)})

    try:
        punitions = _lire_periode(c, period, 'punishments')
    except Exception:
        log.exception("Échec récupération punitions")
        punitions = []

    absences_liste = sorted([{
        "id": a.id,
        "debut": a.from_date.strftime("%d/%m/%Y %H:%M") if a.from_date else "",
        "fin": a.to_date.strftime("%d/%m/%Y %H:%M") if a.to_date else "",
        "justifiee": a.justified,
        "heures": a.hours or "—",
        "jours": a.days,
        "motifs": a.reasons,
    } for a in absences], key=lambda a: a["debut"], reverse=True)

    retards_liste = sorted([{
        "id": r.id,
        "date": r.date.strftime("%d/%m/%Y %H:%M") if r.date else "",
        "minutes": r.minutes,
        "justifie": r.justified,
        "justification": r.justification or "",
        "motifs": r.reasons,
    } for r in retards], key=lambda r: r["date"], reverse=True)

    def _date_punition(p):
        try:
            return p.given.strftime("%d/%m/%Y %H:%M") if p.given else ""
        except Exception:
            return ""

    punitions_liste = sorted([{
        "id": p.id,
        "date": _date_punition(p),
        "nature": p.nature or "",
        "motifs": p.reasons or [],
        "circonstances": p.circumstances or "",
        "donneur": p.giver or "",
        "exclusion": p.exclusion,
        "devoir": p.homework or "",
    } for p in punitions], key=lambda p: p["date"], reverse=True)

    return jsonify({
        "pret": True,
        "periode": period.name,
        "periodes": [p.name for p in c.periods],
        "absences": absences_liste,
        "retards": retards_liste,
        "punitions": punitions_liste,
        "total_heures_absence": sum(
            float(a["heures"].replace(",", ".")) for a in absences_liste
            if a["heures"] not in ("—", "") and a["heures"].replace(",", ".").replace(".", "", 1).isdigit()
        ) if absences_liste else 0,
    })


# ── Messagerie ────────────────────────────────────────────────────────────────
@app.route("/api/discussions")
def api_discussions():
    if not _client_pret():
        return jsonify({"pret": False}), 200
    c = connexion.client
    try:
        discussions = connexion.call(c.discussions)
    except Exception as e:
        log.exception("Échec récupération discussions")
        return jsonify({"pret": True, "discussions": [], "erreur": str(e)})

    liste = []
    for idx, d in enumerate(discussions):
        try:
            date = connexion.call(lambda d=d: d.date)
            date_str = date.strftime("%d/%m/%Y %H:%M") if date else ""
        except Exception:
            date_str = ""
        liste.append({
            "id": idx,
            "sujet": d.subject or "(sans objet)",
            "createur": d.creator or "Moi",
            "non_lus": d.unread,
            "ferme": d.closed,
            "date": date_str,
        })
    liste.sort(key=lambda d: d["date"], reverse=True)

    return jsonify({"pret": True, "discussions": liste})


@app.route("/api/discussions/<int:disc_id>/messages")
def api_discussion_messages(disc_id):
    if not _client_pret():
        return jsonify({"pret": False}), 200
    c = connexion.client
    try:
        discussions = connexion.call(c.discussions)
        cible = discussions[disc_id] if 0 <= disc_id < len(discussions) else None
        if not cible:
            return jsonify({"ok": False, "erreur": "discussion introuvable"}), 404
        messages = connexion.call(lambda: cible.messages)

        # Même souci que pour les actualités (voir _html_pronote_vers_html_propre) :
        # pronotepy retire les balises HTML des messages sans les remplacer par
        # des sauts de ligne, ce qui colle tout le texte. On refait donc le même
        # appel POST que Discussion.messages en interne pour récupérer le JSON
        # brut, et on reconstruit un HTML propre par message quand il est HTML.
        html_brut_par_id: dict[str, str] = {}
        try:
            resp_brut = connexion.call(
                cible._client.post,
                "ListeMessages",
                131,
                {"listePossessionsMessages": cible._possessions},
            )
            for mj in resp_brut["dataSec"]["data"]["listeMessages"]["V"]:
                if mj.get("estHTML", False):
                    html_brut_par_id[mj["N"]] = mj.get("contenu", {}).get("V", "")
        except Exception:
            log.exception("Échec récupération JSON brut des messages (fallback texte simple)")
    except Exception as e:
        log.exception("Échec lecture messages")
        return jsonify({"ok": False, "erreur": str(e)}), 500

    def _contenu_message(m):
        brut = html_brut_par_id.get(m.id)
        if brut:
            return _html_pronote_vers_html_propre(brut)
        # Pas de HTML brut dispo (message texte simple) : on échappe et on
        # convertit les retours à la ligne existants en <br>.
        return f"<p>{html_escape(m.content or '').replace(chr(10), '<br>')}</p>"

    return jsonify({
        "ok": True,
        "sujet": cible.subject or "(sans objet)",
        "ferme": cible.closed,
        "messages": [{
            "id": m.id,
            "auteur": m.author or "Moi",
            "moi": m.author is None,
            "contenu": _contenu_message(m),
            "date": m.created.strftime("%d/%m/%Y %H:%M") if m.created else "",
            "vu": m.seen,
        } for m in messages],
    })


@app.route("/api/discussions/<int:disc_id>/repondre", methods=["POST"])
def api_discussion_repondre(disc_id):
    if not _client_pret():
        return jsonify({"ok": False, "erreur": "non connecté"}), 400
    c = connexion.client
    contenu = (request.json or {}).get("message", "").strip()
    if not contenu:
        return jsonify({"ok": False, "erreur": "message vide"}), 400

    try:
        discussions = connexion.call(c.discussions)
        cible = discussions[disc_id] if 0 <= disc_id < len(discussions) else None
        if not cible:
            return jsonify({"ok": False, "erreur": "discussion introuvable"}), 404
        if cible.closed:
            return jsonify({"ok": False, "erreur": "discussion fermée"}), 400
        connexion.call(cible.reply, contenu)
        return jsonify({"ok": True})
    except Exception as e:
        log.exception("Échec envoi réponse")
        return jsonify({"ok": False, "erreur": str(e)}), 500


@app.route("/api/discussions/nouveau", methods=["POST"])
def api_discussion_nouveau():
    if not _client_pret():
        return jsonify({"ok": False, "erreur": "non connecté"}), 400
    c = connexion.client
    payload = request.json or {}
    objet = (payload.get("objet") or "(sans objet)").strip() or "(sans objet)"
    contenu = (payload.get("message") or "").strip()
    ids_destinataires = payload.get("destinataires") or []

    if not contenu:
        return jsonify({"ok": False, "erreur": "message vide"}), 400
    if not ids_destinataires:
        return jsonify({"ok": False, "erreur": "aucun destinataire"}), 400

    try:
        tous_recipients = connexion.call(c.get_recipients)
        choisis = [r for r in tous_recipients if r.id in ids_destinataires]
        if not choisis:
            return jsonify({"ok": False, "erreur": "destinataire(s) introuvable(s)"}), 404

        connexion.call(c.new_discussion, objet, contenu, choisis)
        return jsonify({"ok": True})
    except Exception as e:
        log.exception("Échec création nouvelle discussion")
        return jsonify({"ok": False, "erreur": str(e)}), 500


# ── Destinataires possibles pour un nouveau message ──────────────────────────
@app.route("/api/destinataires")
def api_destinataires():
    if not _client_pret():
        return jsonify({"ok": False, "erreur": "non connecté"}), 400
    c = connexion.client
    try:
        recipients = connexion.call(c.get_recipients)
        return jsonify({
            "ok": True,
            "destinataires": [{
                "id": r.id,
                "nom": r.name,
                "type": r.type,
                "email": r.email,
                "fonctions": r.functions,
            } for r in recipients],
        })
    except Exception as e:
        log.exception("Échec récupération destinataires")
        return jsonify({"ok": False, "erreur": str(e)}), 500


# ── Profil élève (infos personnelles extraites de PRONOTE) ───────────────────
@app.route("/api/profil")
def api_profil():
    if not _client_pret():
        return jsonify({"pret": False}), 200
    c = connexion.client
    info = c.info

    photo_url = None
    try:
        photo = info.profile_picture
        if photo:
            photo_url = photo.url
    except Exception:
        log.exception("Échec récupération photo de profil")

    donnees = {
        "pret": True,
        "nom": info.name,
        "classe": info.class_name,
        "etablissement": info.establishment,
        "delegue": info.delegue,
        "photo_url": photo_url,
    }

    # Les infos "personnelles" (adresse, email, tél, INE) nécessitent un
    # appel PRONOTE supplémentaire (PageInfosPerso) : lu sous verrou, tolérant.
    donnees.update(connexion.call(_infos_perso, info))

    return jsonify(donnees)


# ─────────────────────────────────────────────────────────────────────────────
# Rafraîchissement global (bouton unique du front)
# ─────────────────────────────────────────────────────────────────────────────
@app.route("/api/rafraichir", methods=["POST"])
def api_rafraichir():
    """Vide les caches du serveur et vérifie la session PRONOTE (reconnexion
    en arrière-plan si elle est morte). Le front recharge ensuite toutes ses
    vues : pas besoin de relancer l'appli."""
    _cache_devoirs.clear()
    _cache_contenu_actus.clear()
    _cache_contenu_discussions.clear()
    reconnexion = False
    if not _client_pret():
        reconnexion = True
        _se_connecter(force=True)
    return jsonify({"ok": True, "reconnexion": reconnexion})


# ─────────────────────────────────────────────────────────────────────────────
# Recherche dans les actualités et les messages
# ─────────────────────────────────────────────────────────────────────────────
# La recherche par titre / auteur / catégorie se fait directement dans le
# front (listes déjà chargées). Cette route sert à chercher AUSSI dans le
# contenu, ce qui oblige à lire chaque actualité / discussion : on garde donc
# le texte lu en cache (TTL) et on borne le nombre d'éléments parcourus.
_cache_contenu_actus: dict[str, tuple[float, str]] = {}
_cache_contenu_discussions: dict[str, tuple[float, str]] = {}
_TTL_CONTENU_S = 600
_MAX_ELEMENTS_RECHERCHE = 60


def _normaliser(texte: str) -> str:
    """Minuscules + sans accents, pour une recherche tolérante."""
    t = unicodedata.normalize("NFD", texte or "")
    return "".join(ch for ch in t if unicodedata.category(ch) != "Mn").lower()


def _texte_brut(html: str) -> str:
    return re.sub(r"\s+", " ", html_unescape(re.sub(r"<[^>]+>", " ", html or ""))).strip()


def _extrait(texte: str, requete_norm: str, marge: int = 50) -> str:
    """Court extrait du texte autour de la première occurrence de la requête."""
    pos = _normaliser(texte).find(requete_norm)
    if pos < 0:
        return ""
    # La normalisation NFD peut décaler les index si le texte contient des
    # caractères composés : on borne simplement.
    debut = max(0, pos - marge)
    fin = min(len(texte), pos + len(requete_norm) + marge)
    return ("…" if debut > 0 else "") + texte[debut:fin].strip() + ("…" if fin < len(texte) else "")


def _contenu_actu_texte(info) -> str:
    cle = str(info.id)
    en_cache = _cache_contenu_actus.get(cle)
    if en_cache and time.monotonic() - en_cache[0] < _TTL_CONTENU_S:
        return en_cache[1]
    connexion.call(info.content)  # remplit info._raw_content
    morceaux = []
    for bloc in (info._raw_content or []):
        try:
            morceaux.append(bloc.get("texte", {}).get("V", ""))
        except AttributeError:
            pass
    texte = _texte_brut(" ".join(morceaux))
    _cache_contenu_actus[cle] = (time.monotonic(), texte)
    return texte


def _contenu_discussion_texte(d) -> str:
    cle = str(d.id)
    en_cache = _cache_contenu_discussions.get(cle)
    if en_cache and time.monotonic() - en_cache[0] < _TTL_CONTENU_S:
        return en_cache[1]
    messages = connexion.call(lambda: d.messages)
    texte = _texte_brut(" ".join((m.content or "") for m in messages))
    _cache_contenu_discussions[cle] = (time.monotonic(), texte)
    return texte


@app.route("/api/recherche")
def api_recherche():
    """?q=...&portee=actus|messages. Renvoie les ids correspondants (ceux des
    listes /api/actualites et /api/discussions) avec un extrait."""
    if not _client_pret():
        return jsonify({"pret": False}), 200
    c = connexion.client
    q = _normaliser((request.args.get("q") or "").strip())
    portee = request.args.get("portee", "actus")
    if len(q) < 2:
        return jsonify({"pret": True, "resultats": [], "partiel": False})

    resultats, partiel = [], False
    try:
        if portee == "actus":
            infos = connexion.call(c.information_and_surveys)
            infos.sort(key=lambda i: i.creation_date or datetime.datetime.min, reverse=True)
            vus = set()
            for n, i in enumerate(infos):
                if str(i.id) in vus:
                    continue
                vus.add(str(i.id))
                en_tete = " ".join([i.title or "", i.author or "", i.category or ""])
                if q in _normaliser(en_tete):
                    resultats.append({"id": str(i.id), "ou": "titre", "extrait": ""})
                    continue
                if n >= _MAX_ELEMENTS_RECHERCHE:
                    partiel = True
                    continue
                try:
                    texte = _contenu_actu_texte(i)
                except Exception:
                    log.exception("Recherche : contenu actu %s illisible", i.id)
                    continue
                if q in _normaliser(texte):
                    resultats.append({"id": str(i.id), "ou": "contenu", "extrait": _extrait(texte, q)})
        else:
            discussions = connexion.call(c.discussions)
            for idx, d in enumerate(discussions):
                en_tete = " ".join([d.subject or "", d.creator or ""])
                if q in _normaliser(en_tete):
                    resultats.append({"id": idx, "ou": "titre", "extrait": ""})
                    continue
                if idx >= _MAX_ELEMENTS_RECHERCHE:
                    partiel = True
                    continue
                try:
                    texte = _contenu_discussion_texte(d)
                except Exception:
                    log.exception("Recherche : discussion %s illisible", idx)
                    continue
                if q in _normaliser(texte):
                    resultats.append({"id": idx, "ou": "contenu", "extrait": _extrait(texte, q)})
    except Exception as e:
        log.exception("Échec recherche")
        return jsonify({"pret": True, "resultats": [], "partiel": False, "erreur": str(e)})
    return jsonify({"pret": True, "resultats": resultats, "partiel": partiel})


# ─────────────────────────────────────────────────────────────────────────────
# Résumé du matin
# ─────────────────────────────────────────────────────────────────────────────
def _liste_francaise(elements: list[str]) -> str:
    if len(elements) <= 1:
        return "".join(elements)
    return ", ".join(elements[:-1]) + " et " + elements[-1]


def _donnees_resume_matin() -> dict | None:
    donnees = _construire_aujourdhui()
    if not donnees.get("pret"):
        return None
    c = connexion.client

    cours_actifs = [x for x in donnees["cours"] if not x["annule"]]
    cours_annules = [x for x in donnees["cours"] if x["annule"]]

    demain = (_aujourdhui() + datetime.timedelta(days=1)).strftime("%d/%m/%Y")
    aujourdhui_str = _aujourdhui().strftime("%d/%m/%Y")
    devoirs = []
    for d in donnees["devoirs_urgents"]:
        devoirs.append({
            "matiere": d["matiere"],
            "description": d["description"],
            "date": d["date"],
            "pour": ("aujourd'hui" if d["date"] == aujourdhui_str
                     else "demain" if d["date"] == demain else d["date"]),
        })

    actus, messages = [], []
    try:
        for i in connexion.call(c.information_and_surveys, only_unread=True)[:8]:
            actus.append({"titre": i.title or "(sans titre)", "auteur": i.author})
    except Exception:
        log.exception("Résumé du matin : actualités")
    try:
        for d in (connexion.call(c.discussions, only_unread=True) or [])[:8]:
            messages.append({"sujet": d.subject or "(sans objet)", "auteur": d.creator or "Moi",
                             "non_lus": max(d.unread, 1)})
    except Exception:
        log.exception("Résumé du matin : messages")

    return {
        "date": donnees["date"],
        "cours": cours_actifs,
        "cours_annules": cours_annules,
        "devoirs": devoirs,
        "actus": actus,
        "messages": messages,
        "nb_actus_non_lues": donnees["nb_actus_non_lues"],
        "nb_messages_non_lus": donnees["nb_messages_non_lus"],
    }


def _texte_resume_matin(d: dict) -> str:
    """Résumé rédigé sans IA (toujours disponible, ne consomme aucun quota)."""
    heure = _maintenant().hour
    lignes = ["Bonjour !" if heure < 18 else "Bonsoir !"]

    if d["cours"]:
        premier, dernier = d["cours"][0], d["cours"][-1]
        lignes.append(
            f"Aujourd'hui, tu as {len(d['cours'])} cours, de {premier['debut']} à {dernier['fin']}. "
            f"Le premier : {premier['matiere']}"
            + (f" en {premier['salle']}" if premier["salle"] else "") + "."
        )
    else:
        lignes.append("Aucun cours aujourd'hui.")
    if d["cours_annules"]:
        lignes.append("Cours annulé : " + _liste_francaise(
            [f"{x['matiere']} ({x['debut']})" for x in d["cours_annules"]]) + ".")

    if d["devoirs"]:
        lignes.append("Devoirs à ne pas oublier : " + "; ".join(
            f"{x['matiere']} pour {x['pour']}" + (f" — {tronquer_texte(x['description'], 70)}" if x["description"] else "")
            for x in d["devoirs"]) + ".")
    else:
        lignes.append("Aucun devoir urgent dans les 3 prochains jours.")

    nouveautes = []
    if d["nb_actus_non_lues"]:
        nouveautes.append(f"{d['nb_actus_non_lues']} actualité(s) non lue(s)"
                          + (" (" + _liste_francaise([a['titre'] for a in d['actus'][:3]]) + ")" if d["actus"] else ""))
    if d["nb_messages_non_lus"]:
        nouveautes.append(f"{d['nb_messages_non_lus']} message(s) non lu(s)"
                          + (" (" + _liste_francaise([m['sujet'] for m in d['messages'][:3]]) + ")" if d["messages"] else ""))
    lignes.append("Nouveautés : " + " et ".join(nouveautes) + "." if nouveautes
                  else "Rien de nouveau à lire.")
    return "\n".join(lignes)


def tronquer_texte(s: str, n: int) -> str:
    s = (s or "").strip()
    return s if len(s) <= n else s[:n].rstrip() + "…"


@app.route("/api/resume_matin")
def api_resume_matin():
    """Résumé du jour : cours, devoirs urgents, nouveautés non lues.
    ?ia=1 demande en plus une version rédigée par l'assistant (Gemini)."""
    if not _client_pret():
        return jsonify({"pret": False}), 200
    try:
        donnees = _donnees_resume_matin()
    except Exception as e:
        log.exception("Échec résumé du matin")
        return jsonify({"pret": True, "ok": False, "erreur": str(e)})
    if donnees is None:
        return jsonify({"pret": False}), 200

    reponse = {"pret": True, "ok": True, "donnees": donnees, "texte": _texte_resume_matin(donnees),
               "texte_ia": None, "ia_disponible": bool(_client_gemini)}

    if request.args.get("ia") == "1":
        if not _client_gemini:
            reponse["erreur_ia"] = "Assistant non configuré : ajoute GEMINI_API_KEY dans config.env."
        else:
            try:
                r = _client_gemini.models.generate_content(
                    model="gemini-3.1-flash-lite",
                    contents=[{"role": "user", "parts": [{"text":
                        "Voici les données du jour d'un élève (JSON). Rédige son résumé du matin : "
                        "5 phrases maximum, ton chaleureux et direct, en français, tutoiement, "
                        "sans markdown ni liste. Mentionne les cours, les devoirs urgents (en "
                        "premier si pour demain) et les nouveautés non lues. N'invente rien.\n\n"
                        + json.dumps(donnees, ensure_ascii=False)}]}],
                )
                reponse["texte_ia"] = (r.text or "").strip() or None
            except Exception as e:
                log.exception("Résumé du matin : échec Gemini")
                reponse["erreur_ia"] = str(e)
    return jsonify(reponse)


# ─────────────────────────────────────────────────────────────────────────────
# Bulletin (Period.report)
# ─────────────────────────────────────────────────────────────────────────────
@app.route("/api/bulletin")
def api_bulletin():
    if not _client_pret():
        return jsonify({"pret": False}), 200
    c = connexion.client
    period = _periode_par_nom(c, request.args.get("periode", ""))
    periodes = [p.name for p in c.periods]
    try:
        rapport = _lire_periode(c, period, "report")
    except Exception as e:
        log.exception("Échec récupération bulletin")
        return jsonify({"pret": True, "periode": period.name, "periodes": periodes,
                        "disponible": False, "matieres": [], "appreciations": [], "erreur": str(e)})

    if rapport is None:  # bulletin pas encore publié
        return jsonify({"pret": True, "periode": period.name, "periodes": periodes,
                        "disponible": False, "matieres": [], "appreciations": []})

    return jsonify({
        "pret": True,
        "periode": period.name,
        "periodes": periodes,
        "disponible": True,
        "appreciations": rapport.comments,
        "matieres": [{
            "nom": m.name,
            "moyenne": m.student_average,
            "moyenne_classe": m.class_average,
            "min": m.min_average,
            "max": m.max_average,
            "coefficient": m.coefficient,
            "professeurs": m.teachers,
            "appreciations": m.comments,
        } for m in rapport.subjects],
    })


# ─────────────────────────────────────────────────────────────────────────────
# Professeurs et contacts
# ─────────────────────────────────────────────────────────────────────────────
@app.route("/api/professeurs")
def api_professeurs():
    """Équipe pédagogique (Client.get_teaching_staff). Chaque personne est
    rapprochée, par son nom, d'un destinataire de la messagerie pour que le
    front puisse ouvrir « Nouveau message » avec lui déjà sélectionné."""
    if not _client_pret():
        return jsonify({"pret": False}), 200
    c = connexion.client
    try:
        equipe = connexion.call_retry(c.get_teaching_staff)
    except Exception as e:
        log.exception("Échec récupération équipe pédagogique")
        return jsonify({"pret": True, "professeurs": [], "erreur": str(e)})

    destinataires = {}
    try:
        for r in connexion.call(c.get_recipients):
            destinataires[_normaliser(r.name)] = r
    except Exception:
        log.exception("Professeurs : destinataires de la messagerie illisibles")

    liste = []
    for t in equipe:
        r = destinataires.get(_normaliser(t.name))
        liste.append({
            "id": t.id,
            "nom": t.name,
            "type": t.type,
            "matieres": [m.name for m in t.subjects],
            "destinataire_id": r.id if r is not None and r.with_discussion else None,
            "email": r.email if r is not None else None,
        })

    # Repli : la page « Équipe pédagogique » est parfois désactivée par
    # l'établissement (réponse vide). On se rabat alors sur la liste des
    # destinataires de la messagerie, qui contient aussi profs et personnel.
    if not liste and destinataires:
        log.info("Équipe pédagogique vide : repli sur les destinataires de la messagerie")
        for r in destinataires.values():
            liste.append({
                "id": r.id,
                "nom": r.name,
                "type": r.type,
                "matieres": [f for f in (r.functions or []) if f],
                "destinataire_id": r.id if r.with_discussion else None,
                "email": r.email,
            })
    liste.sort(key=lambda x: (x["type"] != "teacher", _normaliser(x["nom"])))
    return jsonify({"pret": True, "professeurs": liste})


@app.route("/api/debug/destinataires")
def api_debug_destinataires():
    """DEBUG : JSON brut renvoyé par PRONOTE pour les destinataires (profs G=3,
    personnel G=34). ?n=3 limite le nombre d'entrées par type (défaut 3)."""
    if not _client_pret():
        return jsonify({"pret": False}), 200
    n = request.args.get("n", default=3, type=int)
    c = connexion.client
    sortie = {}
    for nom, genre in (("profs", 3), ("personnel", 34)):
        try:
            rep = connexion.call(
                c.post, "ListeRessourcesPourCommunication", 131,
                {"onglet": {"N": 0, "G": genre}},
            )
            liste = rep["dataSec"]["data"]["listeRessourcesPourCommunication"]["V"]
            sortie[nom] = {"total": len(liste), "exemples": liste[:n]}
        except Exception as e:
            log.exception("Debug destinataires %s", nom)
            sortie[nom] = {"erreur": str(e)}
    return app.response_class(
        json.dumps(sortie, ensure_ascii=False, indent=2), mimetype="application/json"
    )


# ─────────────────────────────────────────────────────────────────────────────
# Export iCal de l'emploi du temps
# ─────────────────────────────────────────────────────────────────────────────
@app.route("/api/edt/ical")
def api_edt_ical():
    """Lien d'abonnement iCal (Client.export_ical). ⚠ Ce lien contient un jeton
    secret : quiconque l'a peut lire ton emploi du temps."""
    if not _client_pret():
        return jsonify({"ok": False, "erreur": "non connecté"}), 400
    try:
        url = connexion.call_retry(connexion.client.export_ical)
        return jsonify({"ok": True, "url": url})
    except Exception as e:
        log.exception("Échec export iCal")
        return jsonify({"ok": False, "erreur": str(e)}), 500


@app.route("/api/edt/ical/fichier")
def api_edt_ical_fichier():
    """Télécharge le .ics (récupéré côté serveur pour éviter les blocages CORS)."""
    from flask import Response
    import requests

    if not _client_pret():
        return jsonify({"ok": False, "erreur": "non connecté"}), 400
    try:
        url = connexion.call_retry(connexion.client.export_ical)
        rep = requests.get(url, timeout=20)
        rep.raise_for_status()
        if b"BEGIN:VCALENDAR" not in rep.content[:200]:
            raise ValueError("PRONOTE n'a pas renvoyé de calendrier iCal valide.")
        return Response(
            rep.content, mimetype="text/calendar",
            headers={"Content-Disposition": 'attachment; filename="emploi_du_temps.ics"'},
        )
    except Exception as e:
        log.exception("Échec téléchargement iCal")
        return jsonify({"ok": False, "erreur": str(e)}), 502


@app.route("/api/assistant", methods=["POST"])
def api_assistant():
    if not _client_gemini:
        return jsonify({
            "ok": False,
            "erreur": "Assistant non configuré : ajoute GEMINI_API_KEY dans config.env.",
        }), 400

    payload = request.json or {}
    message = (payload.get("message") or "").strip()
    mode = (payload.get("mode") or "").strip() or None
    if not message:
        return jsonify({"ok": False, "erreur": "message vide"}), 400

    contexte = _contexte_pronote_pour_ia()

    instruction_systeme = (
        "Tu es l'assistant personnel de l'élève, intégré à son dashboard PRONOTE. "
        "Tu n'es PAS limité à un rôle scolaire : tu es un assistant généraliste "
        "complet, capable de répondre à absolument toute demande (culture "
        "générale, aide aux devoirs, code, conversation, conseils, calculs, "
        "rédaction, etc.), exactement comme un assistant IA classique. En plus "
        "de ça, tu as un accès total et en temps réel à ses données PRONOTE "
        "(profil, emploi du temps, devoirs, notes, vie scolaire (absences/retards/punitions), actualités, "
        "messagerie), fournies ci-dessous à chaque message, que tu dois "
        "utiliser pour répondre précisément dès que la question s'y prête.\n\n"
        "Tu peux aussi PROGRAMMER DES RAPPELS pour l'élève via l'outil "
        "`programmer_rappel`. Utilise-le systématiquement dès que l'utilisateur "
        "demande à être rappelé de quelque chose à une heure/date donnée — "
        "même si la chose à rappeler n'est pas réelle ou pas confirmée par les "
        "données PRONOTE (ex: il n'a pas de devoirs mais demande quand même "
        "qu'on le lui rappelle : tu programmes le rappel sans discuter). "
        "Calcule l'horodatage exact à partir de la date/heure actuelle donnée "
        "ci-dessous. Confirme toujours brièvement à l'utilisateur que le "
        "rappel est bien programmé, avec l'heure exacte.\n\n"
        "Réponds toujours en français, de manière naturelle et concise, en "
        "tutoyant l'élève."
        f"{_consigne_mode(mode)}\n\n"
        f"DONNÉES PRONOTE ACTUELLES :\n{contexte}"
    )

    outils = [{"function_declarations": [OUTIL_PROGRAMMER_RAPPEL]}]

    try:
        contenus = list(_historique_assistant) + [
            {"role": "user", "parts": [{"text": message}]}
        ]

        rappels_crees_ce_tour = []

        # Boucle de function calling : Gemini peut enchaîner plusieurs appels
        # d'outils avant de donner sa réponse finale en texte.
        for _ in range(5):  # garde-fou anti-boucle infinie
            reponse = _client_gemini.models.generate_content(
                model="gemini-3.1-flash-lite",
                contents=contenus,
                config={"system_instruction": instruction_systeme, "tools": outils},
            )

            candidat = reponse.candidates[0] if reponse.candidates else None
            parts = candidat.content.parts if candidat and candidat.content else []
            appels_fonction = [p for p in parts if getattr(p, "function_call", None)]

            if not appels_fonction:
                texte_reponse = (reponse.text or "").strip() or "Désolé, je n'ai pas de réponse à te donner."
                break

            # On ajoute le tour de "l'IA qui appelle une fonction" à l'historique
            # de la requête, puis on lui renvoie le résultat de la fonction.
            contenus.append({"role": "model", "parts": [
                {"function_call": {"name": fc.function_call.name, "args": dict(fc.function_call.args or {})}}
                for fc in appels_fonction
            ]})

            reponses_fonctions = []
            for fc in appels_fonction:
                nom = fc.function_call.name
                args = dict(fc.function_call.args or {})

                if nom == "programmer_rappel":
                    quand_iso = str(args.get("quand_iso", "")).strip()
                    msg_rappel = str(args.get("message", "")).strip() or "Rappel"
                    try:
                        # Validation du format avant enregistrement
                        datetime.datetime.fromisoformat(quand_iso)
                        rappel = _ajouter_rappel(quand_iso, msg_rappel)
                        rappels_crees_ce_tour.append(rappel)
                        resultat = {"ok": True, "rappel_id": rappel["id"], "quand": quand_iso}
                    except Exception as e:
                        resultat = {"ok": False, "erreur": f"horodatage invalide : {e}"}
                else:
                    resultat = {"ok": False, "erreur": f"fonction inconnue : {nom}"}

                reponses_fonctions.append({
                    "function_response": {"name": nom, "response": resultat}
                })

            contenus.append({"role": "user", "parts": reponses_fonctions})
        else:
            texte_reponse = "Désolé, j'ai eu un souci pendant le traitement de ta demande."

        _historique_assistant.append({"role": "user", "parts": [{"text": message}]})
        _historique_assistant.append({"role": "model", "parts": [{"text": texte_reponse}]})
        if len(_historique_assistant) > _MAX_TOURS_HISTORIQUE * 2:
            del _historique_assistant[: len(_historique_assistant) - _MAX_TOURS_HISTORIQUE * 2]

        return jsonify({
            "ok": True,
            "reponse": texte_reponse,
            "rappels_crees": [{"id": r["id"], "quand": r["quand"], "message": r["message"]} for r in rappels_crees_ce_tour],
        })
    except Exception as e:
        log.exception("Échec appel Gemini")
        return jsonify({"ok": False, "erreur": str(e)}), 500


@app.route("/api/assistant/reset", methods=["POST"])
def api_assistant_reset():
    _historique_assistant.clear()
    return jsonify({"ok": True})


# ─────────────────────────────────────────────────────────────────────────────
# Assistant IA LOCAL (Ollama)
# ─────────────────────────────────────────────────────────────────────────────

@app.route("/api/ollama/statut")
def api_ollama_statut():
    """Vérifie que le serveur Ollama local répond, et renvoie les modèles
    déjà téléchargés (ceux qu'Ollama 'trouve' sur la machine, via /api/tags —
    aucun appel à un serveur distant, tout reste en local)."""
    import requests
    try:
        r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=4)
        r.raise_for_status()
        modeles = [m["name"] for m in r.json().get("models", [])]
    except Exception as e:
        return jsonify({"disponible": False, "erreur": str(e), "url": OLLAMA_URL})

    config = _charger_config_ollama()
    modele_choisi = config.get("modele")
    if modele_choisi not in modeles:
        modele_choisi = modeles[0] if modeles else None

    return jsonify({
        "disponible": True,
        "url": OLLAMA_URL,
        "modeles": modeles,
        "modele_choisi": modele_choisi,
    })


@app.route("/api/ollama/modele", methods=["POST"])
def api_ollama_choisir_modele():
    modele = ((request.json or {}).get("modele") or "").strip()
    if not modele:
        return jsonify({"ok": False, "erreur": "modèle vide"}), 400
    with _verrou_ollama:
        config = _charger_config_ollama()
        config["modele"] = modele
        _sauver_config_ollama(config)
    return jsonify({"ok": True, "modele": modele})


@app.route("/api/assistant/modes")
def api_assistant_modes():
    """Liste des modes rapides (Résumé/Explications/Quiz/Conseils/Devoirs/
    Objectifs), communs aux deux providers Gemini et Ollama."""
    return jsonify({
        "modes": [
            {"id": mid, "label": m["label"]} for mid, m in MODES_ASSISTANT.items()
        ]
    })


@app.route("/api/ollama/chat", methods=["POST"])
def api_ollama_chat():
    import requests

    payload = request.json or {}
    message = (payload.get("message") or "").strip()
    mode = (payload.get("mode") or "").strip() or None
    if not message:
        return jsonify({"ok": False, "erreur": "message vide"}), 400

    config = _charger_config_ollama()
    modele = config.get("modele")
    if not modele:
        return jsonify({
            "ok": False,
            "erreur": "Aucun modèle Ollama sélectionné. Choisis-en un dans les réglages de l'assistant local.",
        }), 400

    contexte = _contexte_pronote_pour_ia()
    instruction_systeme = (
        "Tu es l'assistant personnel local de l'élève (exécuté via Ollama, "
        "entièrement sur sa machine, sans aucun appel à un service distant). "
        "Tu es un assistant généraliste complet : culture générale, aide aux "
        "devoirs, code, conversation, conseils, calculs, rédaction, etc. Tu as "
        "aussi accès à ses données PRONOTE actuelles, fournies ci-dessous, à "
        "utiliser dès que la question s'y prête. Réponds toujours en français, "
        "de façon naturelle et concise, en tutoyant l'élève."
        f"{_consigne_mode(mode)}\n\n"
        f"DONNÉES PRONOTE ACTUELLES :\n{contexte}"
    )

    with _verrou_ollama:
        historique = _charger_historique_ollama()

        messages = (
            [{"role": "system", "content": instruction_systeme}]
            + historique
            + [{"role": "user", "content": message}]
        )

        try:
            r = requests.post(
                f"{OLLAMA_URL}/api/chat",
                json={"model": modele, "messages": messages, "stream": False},
                timeout=120,  # les modèles locaux peuvent être lents selon le matériel
            )
            r.raise_for_status()
            texte_reponse = (r.json().get("message", {}) or {}).get("content", "").strip()
            texte_reponse = texte_reponse or "Désolé, je n'ai pas de réponse à te donner."
        except requests.exceptions.ConnectionError:
            return jsonify({
                "ok": False,
                "erreur": f"Impossible de joindre Ollama sur {OLLAMA_URL}. Le serveur Ollama est-il lancé (`ollama serve`) ?",
            }), 502
        except Exception as e:
            log.exception("Échec appel Ollama")
            return jsonify({"ok": False, "erreur": str(e)}), 500

        # Mémoire persistée sur disque : survit aux redémarrages du serveur.
        historique.append({"role": "user", "content": message})
        historique.append({"role": "assistant", "content": texte_reponse})
        if len(historique) > _MAX_TOURS_HISTORIQUE_OLLAMA * 2:
            del historique[: len(historique) - _MAX_TOURS_HISTORIQUE_OLLAMA * 2]
        _sauver_historique_ollama(historique)

    return jsonify({"ok": True, "reponse": texte_reponse, "modele": modele})


@app.route("/api/ollama/historique")
def api_ollama_historique():
    return jsonify({"ok": True, "historique": _charger_historique_ollama()})


@app.route("/api/ollama/reset", methods=["POST"])
def api_ollama_reset():
    with _verrou_ollama:
        _sauver_historique_ollama([])
    return jsonify({"ok": True})


# ── Rappels : liste en attente + polling des rappels dus ─────────────────────
@app.route("/api/rappels")
def api_rappels():
    return jsonify({"ok": True, "rappels": _rappels_en_attente()})


@app.route("/api/rappels/dus")
def api_rappels_dus():
    """Appelé en polling par le front : renvoie les rappels dont l'échéance
    vient d'être atteinte (et les marque comme déclenchés, une seule fois)."""
    dus = _rappels_a_declencher()
    return jsonify({
        "ok": True,
        "rappels": [{"id": r["id"], "message": r["message"], "quand": r["quand"]} for r in dus],
    })


@app.route("/api/rappels/<rappel_id>", methods=["DELETE"])
def api_rappel_supprimer(rappel_id):
    with _verrou_rappels:
        rappels = _charger_rappels()
        rappels = [r for r in rappels if r["id"] != rappel_id]
        _sauver_rappels(rappels)
    return jsonify({"ok": True})


# ─────────────────────────────────────────────────────────────────────────────
# Notifications desktop natives (vraies notifs Windows, pas des notifs
# navigateur) pour les nouvelles notes / nouveaux devoirs.
#
# Tourne dans un thread de fond indépendant de tout onglet ouvert : même
# navigateur fermé, tant que l'exe/python.exe tourne en tray, les toasts
# s'affichent. Utilise winotify (pip install winotify) — contrairement à
# win10toast (abandonnée depuis 2019, cassée sur Python 3.14+ car elle
# importe pkg_resources, retiré de setuptools par défaut), winotify est
# maintenue et n'a pas cette dépendance cassée. No-op silencieux sur un OS
# autre que Windows ou si la lib n'est pas installée.
# ─────────────────────────────────────────────────────────────────────────────
try:
    from winotify import Notification as _WinotifyNotification
    _winotify_disponible = os.name == "nt"
except Exception:
    _winotify_disponible = False  # lib absente, ou OS non Windows : notifs desktop désactivées, pas bloquant

NOTIF_VUS_FILE = DATA_DIR / "notif_watcher_vus.json"
_verrou_notif_watcher = threading.Lock()
INTERVALLE_WATCHER_SECONDES = int(os.getenv("NOTIF_INTERVALLE_SECONDES", "120"))


def _charger_notif_vus() -> dict:
    """{ 'notes': [id, ...], 'devoirs': [id, ...] } — ce qu'on a déjà notifié,
    pour ne jamais notifier deux fois la même chose, y compris entre deux
    redémarrages de l'app (persisté sur disque)."""
    if not NOTIF_VUS_FILE.exists():
        return {"notes": [], "devoirs": []}
    try:
        with open(NOTIF_VUS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        log.exception("Échec lecture notif_watcher_vus.json")
        return {"notes": [], "devoirs": []}


def _sauver_notif_vus(vus: dict) -> None:
    try:
        NOTIF_VUS_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(NOTIF_VUS_FILE, "w", encoding="utf-8") as f:
            json.dump(vus, f, ensure_ascii=False, indent=2)
    except Exception:
        log.exception("Échec écriture notif_watcher_vus.json")


def _envoyer_toast(titre: str, message: str) -> None:
    if not _winotify_disponible:
        return
    try:
        toast = _WinotifyNotification(
            app_id="Dashboard PRONOTE",
            title=titre,
            msg=message,
            duration="short",
        )
        toast.show()  # non-bloquant : winotify programme l'affichage via le planificateur Windows
    except Exception:
        log.exception("Échec affichage toast Windows")


def _cycle_watcher_notifications() -> None:
    """Un seul passage : compare les notes/devoirs actuels à ceux déjà notifiés,
    notifie les nouveaux, met à jour le fichier des "vus"."""
    if not _client_pret():
        return

    with _verrou_notif_watcher:
        vus = _charger_notif_vus()
        notes_vues = set(vus.get("notes", []))
        devoirs_vus = set(vus.get("devoirs", []))

        c = connexion.client
        nouveaux_ids_notes = set(notes_vues)
        nouveaux_ids_devoirs = set(devoirs_vus)

        # ── Notes ──
        try:
            grades = connexion.call(lambda: list(c.current_period.grades))
            for g in grades:
                gid = str(g.id)
                if gid in notes_vues:
                    continue
                nouveaux_ids_notes.add(gid)
                if notes_vues:  # pas de spam de TOUTES les notes au tout premier lancement
                    matiere = g.subject.name if g.subject else "?"
                    _envoyer_toast("📊 Nouvelle note", f"{matiere} : {g.grade}/{g.out_of}")
        except Exception:
            log.exception("Watcher notifs : échec lecture des notes")

        # ── Devoirs ──
        try:
            from datetime import timedelta
            aujourdhui = _maintenant().date()
            homeworks = connexion.call(lambda: list(c.homework(aujourdhui, aujourdhui + timedelta(days=60))))
            for h in homeworks:
                hid = str(h.id)
                if hid in devoirs_vus:
                    continue
                nouveaux_ids_devoirs.add(hid)
                if devoirs_vus:
                    matiere = h.subject.name if h.subject else "?"
                    _envoyer_toast("📚 Nouveau devoir", f"{matiere} — pour le {h.date.strftime('%d/%m/%Y')}")
        except Exception:
            log.exception("Watcher notifs : échec lecture des devoirs")

        # Purge des très vieux ids pour que le fichier ne grossisse pas indéfiniment
        vus["notes"] = list(nouveaux_ids_notes)[-500:]
        vus["devoirs"] = list(nouveaux_ids_devoirs)[-500:]
        _sauver_notif_vus(vus)


def _boucle_watcher_notifications() -> None:
    while True:
        try:
            _cycle_watcher_notifications()
        except Exception:
            log.exception("Watcher notifs : erreur inattendue dans le cycle")
        time.sleep(INTERVALLE_WATCHER_SECONDES)


if _winotify_disponible:
    threading.Thread(target=_boucle_watcher_notifications, daemon=True).start()
    log.info(f"Watcher de notifications desktop démarré (toutes les {INTERVALLE_WATCHER_SECONDES}s).")
else:
    log.info("Notifications desktop désactivées (winotify absent ou OS non Windows).")


@app.route("/api/notifications/statut")
def api_notifications_statut():
    return jsonify({
        "disponible": _winotify_disponible,
        "intervalle_secondes": INTERVALLE_WATCHER_SECONDES,
    })


@app.route("/api/notifications/test", methods=["POST"])
def api_notifications_test():
    """Bouton 'tester' côté réglages : envoie un toast immédiatement."""
    if not _winotify_disponible:
        return jsonify({"ok": False, "erreur": "Notifications desktop indisponibles (winotify absent ou OS non Windows)."}), 400
    _envoyer_toast("🔔 Test de notification", "Si tu vois ceci, les notifications desktop fonctionnent !")
    return jsonify({"ok": True})


if __name__ == "__main__":
    print("=" * 60)
    print("  Dashboard PRONOTE — http://localhost:5001")
    print("=" * 60)
    app.run(host="127.0.0.1", port=5001, debug=False)