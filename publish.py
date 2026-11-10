#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
publish.py — Publie PronoteDashboard sur GitHub en une commande.

    python publish.py
"""

from __future__ import annotations
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# ── ANSI ──────────────────────────────────────────────────────────────────────
R = "\033[0m"
BOLD = "\033[1m"
DIM  = "\033[2m"
GREEN  = "\033[92m"
BLUE   = "\033[94m"
YELLOW = "\033[93m"
RED    = "\033[91m"
CYAN   = "\033[96m"
MAGENTA = "\033[95m"
WHITE  = "\033[97m"

def c(col: str, t: str) -> str:
    return f"{col}{t}{R}" if sys.stdout.isatty() else t

def ask(prompt: str, default: str = "") -> str:
    hint = f" {c(DIM, f'[{default}]')}" if default else ""
    try:
        v = input(c(BOLD, f"  {prompt}{hint} : ")).strip()
    except (EOFError, KeyboardInterrupt):
        print(); sys.exit(0)
    return v or default

def run(cmd: list[str], check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=str(HERE), check=check,
                          capture_output=True, text=True)

def step(n: int, label: str) -> None:
    print(f"\n {c(BOLD+CYAN, f'[{n}]')} {c(BOLD+WHITE, label)}")

def ok(msg: str)   -> None: print(f"     {c(GREEN,  '✓')} {msg}")
def info(msg: str) -> None: print(f"     {c(BLUE,   'ℹ')} {msg}")
def warn(msg: str) -> None: print(f"     {c(YELLOW, '⚠')} {msg}")
def err(msg: str)  -> None: print(f"     {c(RED,    '✗')} {msg}")

def line() -> None:
    print(f"  {c(DIM, '─' * 50)}")

# ── Vérifications préalables ──────────────────────────────────────────────────

def check_git() -> None:
    try:
        r = run(["git", "--version"])
        ok(f"git détecté  {c(DIM, r.stdout.strip())}")
    except FileNotFoundError:
        err("git introuvable — installe-le sur https://git-scm.com")
        sys.exit(1)

def check_identity() -> None:
    name  = run(["git", "config", "--global", "user.name"],  check=False).stdout.strip()
    email = run(["git", "config", "--global", "user.email"], check=False).stdout.strip()
    if not name or not email:
        warn("Identité git non configurée — on va la définir maintenant.")
        if not name:
            name = ask("Ton nom GitHub")
            run(["git", "config", "--global", "user.name", name])
        if not email:
            email = ask("Ton email GitHub")
            run(["git", "config", "--global", "user.email", email])
    ok(f"Identité  {c(DIM, f'{name} <{email}>')}")

# ── Collecte des infos ────────────────────────────────────────────────────────

def ask_repo() -> str:
    print()
    info("Entre l'URL de ton dépôt GitHub (crée-le d'abord sur github.com).")
    info(f"Exemple : {c(DIM, 'https://github.com/tonpseudo/PronoteDashboard.git')}")
    print()
    url = ask("URL du dépôt")
    while not url.startswith("http") and not url.startswith("git@"):
        warn("L'URL doit commencer par https:// ou git@")
        url = ask("URL du dépôt")
    return url

def ask_branch() -> str:
    return ask("Branche principale", "main")

def ask_message() -> str:
    return ask("Message du commit", "🎓 Initial release — PronoteDashboard v1.0")

def ask_visibility() -> None:
    print()
    info("Rappel : la visibilité (public / privé) se configure directement")
    info(f"sur {c(CYAN, 'github.com')} lors de la création du dépôt.")

# ── Git ───────────────────────────────────────────────────────────────────────

def git_init() -> None:
    if (HERE / ".git").exists():
        ok("Dépôt git déjà initialisé — on le réutilise.")
        return
    run(["git", "init"])
    ok("git init")

def git_add() -> None:
    run(["git", "add", "."])
    r = run(["git", "status", "--short"])
    n = len([l for l in r.stdout.strip().splitlines() if l.strip()])
    ok(f"git add   {c(DIM, f'{n} fichier(s) indexé(s)')}")

def git_commit(message: str) -> None:
    r = run(["git", "diff", "--cached", "--name-only"])
    if not r.stdout.strip():
        warn("Rien à commiter (repo déjà à jour).")
        return
    run(["git", "commit", "-m", message])
    ok(f"git commit  {c(DIM, repr(message))}")

def git_remote(url: str) -> None:
    existing = run(["git", "remote"], check=False).stdout.strip()
    if "origin" in existing.splitlines():
        current = run(["git", "remote", "get-url", "origin"], check=False).stdout.strip()
        if current != url:
            warn(f"Remote 'origin' existant : {c(DIM, current)}")
            overwrite = ask("Remplacer ? (o/N)", "N")
            if overwrite.lower() in ("o", "oui", "y", "yes"):
                run(["git", "remote", "set-url", "origin", url])
                ok(f"Remote mis à jour → {c(DIM, url)}")
            else:
                info("Remote conservé.")
                return
        else:
            ok(f"Remote déjà configuré  {c(DIM, url)}")
        return
    run(["git", "remote", "add", "origin", url])
    ok(f"git remote add origin  {c(DIM, url)}")

def git_push(branch: str) -> None:
    info(f"Push vers origin/{branch} …")
    result = run(["git", "push", "-u", "origin", branch], check=False)
    if result.returncode == 0:
        ok(f"Push réussi sur {c(CYAN, branch)} 🎉")
    else:
        # Essai avec --force si branche déjà existante
        if "rejected" in result.stderr or "non-fast-forward" in result.stderr:
            warn("Branche distante en conflit.")
            force = ask("Forcer le push (--force) ? (o/N)", "N")
            if force.lower() in ("o", "oui", "y", "yes"):
                r2 = run(["git", "push", "--force", "-u", "origin", branch], check=False)
                if r2.returncode == 0:
                    ok(f"Push forcé vers {c(CYAN, branch)} ✓")
                else:
                    err("Push échoué :")
                    print(c(DIM, r2.stderr.strip()))
                    sys.exit(1)
        else:
            err("Push échoué :")
            print(c(DIM, result.stderr.strip()))
            info("Vérifie que tu as les droits sur ce dépôt et que l'URL est correcte.")
            sys.exit(1)

# ── Bannière & résumé ─────────────────────────────────────────────────────────

def banner() -> None:
    print()
    print(c(BOLD+CYAN,    "  ╔══════════════════════════════════════════════╗"))
    print(c(BOLD+CYAN,    "  ║") + c(BOLD+WHITE, "      🚀 PronoteDashboard — GitHub Push      ") + c(BOLD+CYAN, "║"))
    print(c(BOLD+CYAN,    "  ╚══════════════════════════════════════════════╝"))

def recap(url: str, branch: str, message: str) -> bool:
    print()
    print(c(BOLD, "  Récapitulatif :"))
    line()
    print(f"  {c(DIM,'Dépôt   ')}  {c(CYAN, url)}")
    print(f"  {c(DIM,'Branche ')}  {c(GREEN, branch)}")
    print(f"  {c(DIM,'Commit  ')}  {c(MAGENTA, message)}")
    line()
    confirm = ask("Confirmer et publier ? (O/n)", "O")
    return confirm.lower() not in ("n", "non", "no")

def success(url: str) -> None:
    # Transformer l'URL git en URL web si besoin
    web = url.removesuffix(".git").replace("git@github.com:", "https://github.com/")
    print()
    print(c(BOLD+GREEN, "  ✓ Dépôt publié avec succès !"))
    print()
    print(f"  {c(DIM,'Lien :')}  {c(BOLD+CYAN, web)}")
    print()
    info("Prochaine étape : crée une Release sur GitHub :")
    info(f"{c(CYAN, web + '/releases/new')}")
    info("Tag suggéré : v1.0.0  —  attache le zip de l'appli pour les autres.")
    print()

# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    banner()

    step(1, "Vérification de l'environnement")
    check_git()
    check_identity()

    step(2, "Informations du dépôt")
    url     = ask_repo()
    branch  = ask_branch()
    message = ask_message()
    ask_visibility()

    if not recap(url, branch, message):
        print()
        warn("Publication annulée.")
        sys.exit(0)

    step(3, "Initialisation du dépôt local")
    git_init()

    step(4, "Ajout des fichiers")
    git_add()

    step(5, "Commit")
    git_commit(message)

    step(6, "Configuration du remote")
    git_remote(url)

    step(7, "Push vers GitHub")
    git_push(branch)

    success(url)


if __name__ == "__main__":
    main()
