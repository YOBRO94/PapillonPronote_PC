#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
setup.py — Installation interactive de PronoteDashboard.

Lance ce script une seule fois après le clone :
    python setup.py

Il installe les dépendances, crée ton config.env et te propose
de démarrer le dashboard directement.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG_ENV = HERE / "config.env"
CONFIG_EXAMPLE = HERE / "config.example.env"

# ── Couleurs ANSI ─────────────────────────────────────────────────────────────
RESET  = "\033[0m"
BOLD   = "\033[1m"
GREEN  = "\033[92m"
BLUE   = "\033[94m"
YELLOW = "\033[93m"
RED    = "\033[91m"
CYAN   = "\033[96m"


def _c(color: str, text: str) -> str:
    """Entoure le texte d'une couleur ANSI (désactivée si pas de TTY)."""
    if not sys.stdout.isatty():
        return text
    return f"{color}{text}{RESET}"


def _titre(texte: str) -> None:
    print()
    print(_c(BOLD + CYAN, f"  ● {texte}"))


def _ok(texte: str) -> None:
    print(_c(GREEN, f"  ✓ {texte}"))


def _info(texte: str) -> None:
    print(_c(BLUE, f"  ℹ {texte}"))


def _warn(texte: str) -> None:
    print(_c(YELLOW, f"  ⚠ {texte}"))


def _err(texte: str) -> None:
    print(_c(RED, f"  ✗ {texte}"))


def _ask(prompt: str, default: str = "") -> str:
    """Demande une valeur à l'utilisateur."""
    hint = f" [{default}]" if default else ""
    try:
        reponse = input(_c(BOLD, f"  → {prompt}{hint} : ")).strip()
    except (EOFError, KeyboardInterrupt):
        print()
        sys.exit(0)
    return reponse if reponse else default


# ── 0. Bannière ───────────────────────────────────────────────────────────────

def _banniere() -> None:
    print()
    print(_c(BOLD + CYAN, "╔══════════════════════════════════════════════╗"))
    print(_c(BOLD + CYAN, "║") + _c(BOLD, "        🎓 PronoteDashboard — Setup         ") + _c(BOLD + CYAN, "║"))
    print(_c(BOLD + CYAN, "╚══════════════════════════════════════════════╝"))
    print()
    print("  Ce script va :")
    print("  " + _c(CYAN, "1.") + " Installer les dépendances Python")
    print("  " + _c(CYAN, "2.") + " Créer ton fichier config.env")
    print("  " + _c(CYAN, "3.") + " (Optionnel) Démarrer le dashboard")
    print()


# ── 1. Vérification Python ────────────────────────────────────────────────────

def _verif_python() -> None:
    _titre("Vérification de Python")
    version = sys.version_info
    if version < (3, 11):
        _err(f"Python {version.major}.{version.minor} détecté — version 3.11+ requise.")
        _warn("Installe Python 3.11 ou plus récent : https://python.org/downloads")
        sys.exit(1)
    _ok(f"Python {version.major}.{version.minor}.{version.micro} — OK")


# ── 2. Installation des dépendances ──────────────────────────────────────────

def _installer_deps() -> None:
    _titre("Installation des dépendances")

    req = HERE / "requirements.txt"
    if not req.exists():
        _warn("requirements.txt introuvable — installation ignorée.")
        return

    _info("Lancement de : pip install -r requirements.txt")
    print()
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", str(req)],
        cwd=str(HERE),
    )
    print()
    if result.returncode != 0:
        _err("pip a signalé des erreurs (voir ci-dessus).")
        _warn("Continue quand même — certaines fonctions optionnelles peuvent manquer.")
    else:
        _ok("Dépendances installées avec succès.")


# ── 3. Configuration ──────────────────────────────────────────────────────────

def _configurer() -> None:
    _titre("Configuration de PRONOTE")

    if CONFIG_ENV.exists():
        _info("Un fichier config.env existe déjà.")
        reponse = _ask("Écraser avec de nouveaux identifiants ? (o/N)", "N")
        if reponse.lower() not in ("o", "oui", "y", "yes"):
            _ok("Configuration existante conservée.")
            return

    print()
    print("  Renseigne tes identifiants PRONOTE.")
    print("  " + _c(YELLOW, "⚠  Ces infos sont stockées LOCALEMENT dans config.env"))
    print("  " + _c(YELLOW, "   et ne sont jamais envoyées nulle part."))
    print()

    url = _ask("URL PRONOTE (ex: https://0xxxxxxxx.index-education.net/pronote/)")
    while not url.startswith("http"):
        _warn("L'URL doit commencer par http:// ou https://")
        url = _ask("URL PRONOTE")

    username = _ask("Identifiant PRONOTE")
    while not username:
        _warn("L'identifiant ne peut pas être vide.")
        username = _ask("Identifiant PRONOTE")

    # Mot de passe avec masquage si possible
    try:
        import getpass
        password = getpass.getpass(_c(BOLD, "  → Mot de passe PRONOTE (masqué) : "))
    except Exception:
        password = _ask("Mot de passe PRONOTE")

    print()
    _info("(Optionnel) Clé API Gemini pour l'assistant IA intégré.")
    _info("Obtenir une clé gratuite : https://aistudio.google.com/apikey")
    gemini_key = _ask("GEMINI_API_KEY (Entrée pour ignorer)", "")

    # Écrire config.env
    contenu = (
        f"PRONOTE_URL={url}\n"
        f"PRONOTE_USERNAME={username}\n"
        f"PRONOTE_PASSWORD={password}\n"
        f"GEMINI_API_KEY={gemini_key}\n"
    )
    CONFIG_ENV.write_text(contenu, encoding="utf-8")
    _ok(f"config.env créé dans {CONFIG_ENV.parent}")


# ── 4. Lancement optionnel ────────────────────────────────────────────────────

def _proposer_lancement() -> None:
    _titre("Prêt à démarrer !")
    print()
    print("  Pour lancer le dashboard manuellement :")
    print("  " + _c(BOLD + GREEN, "    python app.py"))
    print()
    print("  Puis ouvre ton navigateur sur :")
    print("  " + _c(BOLD + CYAN, "    http://localhost:5001"))
    print()

    reponse = _ask("Démarrer le dashboard maintenant ? (O/n)", "O")
    if reponse.lower() in ("", "o", "oui", "y", "yes"):
        print()
        _info("Démarrage de Flask sur http://127.0.0.1:5001 …")
        _info("Appuie sur Ctrl+C pour arrêter.")
        print()
        try:
            subprocess.run([sys.executable, str(HERE / "app.py")], cwd=str(HERE))
        except KeyboardInterrupt:
            print()
            _ok("Dashboard arrêté proprement.")
    else:
        print()
        _ok("Setup terminé. Lance `python app.py` quand tu veux.")

    print()


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    _banniere()
    _verif_python()
    _installer_deps()
    _configurer()
    _proposer_lancement()


if __name__ == "__main__":
    main()
