#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
launcher.py — Point d'entrée unique pour la version "exe tout-en-un".

Objectif : à côté de l'exe compilé, il ne doit rester visible QUE :
    PronoteDashboard.exe
    python-embed\\

Tout le reste (code, templates, static, pronotepy) est embarqué DANS l'exe
par PyInstaller. Ce qui doit rester modifiable sur disque (config.env avec
tes identifiants, data\\ avec le device_uuid) est stocké dans un dossier
caché à côté de l'exe, créé et rempli automatiquement au premier lancement
— tu n'as jamais besoin d'y toucher à la main.

Compilation (depuis Windows, avec python-embed\\python.exe) :
    python-embed\\python.exe -m PyInstaller --onefile --noconsole ^
        --name PronoteDashboard ^
        --add-data "templates;templates" ^
        --add-data "static;static" ^
        --add-data "pronotepy;pronotepy" ^
        --add-data "config.example.env;." ^
        --hidden-import winotify ^
        launcher.py

Dépendance supplémentaire pour les notifications desktop natives (pas des
notifs navigateur) : pip install winotify dans python-embed avant de
compiler. Sans elle, l'app continue de fonctionner normalement, simplement
sans notifications desktop (dégradation silencieuse, voir app.py).
(winotify remplace win10toast : win10toast est abandonnée depuis 2019 et
cassée sur Python 3.14+ car elle importe pkg_resources, retiré par défaut
de setuptools récents. winotify n'a pas ce problème.)

Après compilation : ne garder que dist\\PronoteDashboard.exe + python-embed\\
"""

from __future__ import annotations

import ctypes
import os
import shutil
import sys
import threading
import webbrowser
from pathlib import Path

# ---------------------------------------------------------------------------
# 1. Localiser l'exe et préparer les chemins, AVANT tout import lourd
# ---------------------------------------------------------------------------


def dossier_exe() -> Path:
    """Dossier où se trouve réellement l'exe (ou le script en mode dev)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parent


def dossier_ressources() -> Path:
    """Dossier temporaire où PyInstaller extrait templates/, static/,
    pronotepy/ etc. quand l'exe est en mode --onefile (attribut _MEIPASS)."""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parent


EXE_DIR = dossier_exe()
RES_DIR = dossier_ressources()

# Dossier caché à côté de l'exe pour tout ce qui doit rester modifiable
# (identifiants, token Pronote, cache éventuel). Attribut "caché" posé sous
# Windows via l'API ctypes plus bas.
DONNEES_DIR = EXE_DIR / ".pronote_data"
DONNEES_DIR.mkdir(exist_ok=True)

CONFIG_ENV = DONNEES_DIR / "config.env"
DATA_DIR = DONNEES_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

# Rendre les libs de python-embed importables (utile seulement si ce script
# tourne via python-embed\python.exe plutôt que via l'exe compilé)
SITE_PACKAGES = EXE_DIR / "python-embed" / "Lib" / "site-packages"
if SITE_PACKAGES.exists() and str(SITE_PACKAGES) not in sys.path:
    sys.path.insert(0, str(SITE_PACKAGES))

# app.py (embarqué par PyInstaller) doit trouver templates/, static/,
# pronotepy/ dans son dossier de travail : on se place dans RES_DIR pour ça.
sys.path.insert(0, str(RES_DIR))


def _premiere_configuration() -> None:
    """Au tout premier lancement : crée config.env depuis le modèle si
    absent, et ouvre-le pour que l'utilisateur remplisse ses identifiants."""
    if CONFIG_ENV.exists():
        return
    modele = RES_DIR / "config.example.env"
    if modele.exists():
        shutil.copy(modele, CONFIG_ENV)
    else:
        CONFIG_ENV.write_text(
            "PRONOTE_URL=\nPRONOTE_USERNAME=\nPRONOTE_PASSWORD=\n",
            encoding="utf-8",
        )
    os.startfile(CONFIG_ENV)  # type: ignore[attr-defined]  # ouvre Bloc-notes sous Windows


def _cacher_dossier_windows(chemin: Path) -> None:
    """Pose l'attribut FICHIER_CACHÉ sous Windows (no-op sur les autres OS)."""
    if os.name != "nt":
        return
    FILE_ATTRIBUTE_HIDDEN = 0x02
    try:
        ctypes.windll.kernel32.SetFileAttributesW(str(chemin), FILE_ATTRIBUTE_HIDDEN)  # type: ignore[attr-defined]
    except Exception:
        pass  # pas bloquant si ça échoue, juste un confort visuel


_premiere_configuration()
_cacher_dossier_windows(DONNEES_DIR)

# config.env et data\ doivent être lus/écrits par app.py depuis DONNEES_DIR,
# pas depuis RES_DIR (qui est un dossier temporaire recréé à chaque lancement
# en mode --onefile). On informe app.py via des variables d'environnement.
os.environ["PRONOTE_CONFIG_ENV_PATH"] = str(CONFIG_ENV)
os.environ["PRONOTE_DATA_DIR"] = str(DATA_DIR)

# ---------------------------------------------------------------------------
# 2. Imports lourds (après avoir posé tous les chemins ci-dessus)
# ---------------------------------------------------------------------------

import pystray
from PIL import Image, ImageDraw

URL_DASHBOARD = "http://127.0.0.1:5001"

_icone_tray: "pystray.Icon | None" = None


def _icone_par_defaut() -> Image.Image:
    chemin_icone = RES_DIR / "static" / "favicon.ico"
    if chemin_icone.exists():
        try:
            return Image.open(chemin_icone)
        except Exception:
            pass
    img = Image.new("RGBA", (64, 64), (30, 30, 30, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((2, 2, 62, 62), fill=(37, 99, 235, 255))
    d.text((22, 16), "P", fill=(255, 255, 255, 255))
    return img


def _demarrer_flask() -> None:
    os.chdir(RES_DIR)  # pour que app.py retrouve templates/, static/, pronotepy/
    import app as flask_app  # import tardif

    flask_app.app.run(host="127.0.0.1", port=5001, debug=False, use_reloader=False)


def _ouvrir_dashboard(icon=None, item=None) -> None:
    webbrowser.open(URL_DASHBOARD)


def _ouvrir_configuration(icon=None, item=None) -> None:
    os.startfile(CONFIG_ENV)  # type: ignore[attr-defined]


def _quitter(icon, item) -> None:
    icon.stop()
    os._exit(0)


def main() -> None:
    global _icone_tray

    threading.Thread(target=_demarrer_flask, daemon=True).start()
    threading.Timer(1.5, _ouvrir_dashboard).start()

    menu = pystray.Menu(
        pystray.MenuItem("Ouvrir le dashboard", _ouvrir_dashboard, default=True),
        pystray.MenuItem("Modifier mes identifiants", _ouvrir_configuration),
        pystray.MenuItem("Quitter", _quitter),
    )
    _icone_tray = pystray.Icon("PronoteDashboard", _icone_par_defaut(), "Dashboard Pronote", menu)
    _icone_tray.run()


if __name__ == "__main__":
    main()
