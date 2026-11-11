<div align="center">

<img width="72" src="static/logo.png" alt="PronoteDashboard logo" />

# PronoteDashboard

**Le dashboard web ultime pour ta vie scolaire PRONOTE — 100 % local, zéro compromis.**

[![Python](https://img.shields.io/badge/Python-3.11%2B-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://python.org)
[![Flask](https://img.shields.io/badge/Flask-web%20server-000000?style=for-the-badge&logo=flask&logoColor=white)](https://flask.palletsprojects.com)
[![License](https://img.shields.io/badge/Licence-MIT-22c55e?style=for-the-badge)](LICENSE)
[![pronotepy](https://img.shields.io/badge/pronotepy-2.15.7-6366f1?style=for-the-badge)](https://github.com/bain3/pronotepy)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=for-the-badge)](https://github.com/YOBRO94/PapillonPronote_PC)

</div>

---

<div align="center">

### 🎓 C'est quoi PronoteDashboard ?

</div>

<p align="center">
PronoteDashboard est un client web alternatif de PRONOTE qui tourne <b>entièrement en local</b> sur ta machine.<br>
Il se connecte directement à ton compte PRONOTE via <a href="https://github.com/bain3/pronotepy">pronotepy</a> et affiche tout dans une interface moderne inspirée de <a href="https://papillon.bzh">Papillon</a>, avec un design <i>liquid-glass</i>.
</p>

---

### ✨ Fonctionnalités

| | |
|---|---|
| 📅 **Emploi du temps** | Vue semaine avec export iCal |
| 📝 **Devoirs** | Marquer comme fait, ajouter des devoirs custom, priorités |
| 📊 **Notes & statistiques** | Évolution des moyennes, simulateur de notes, bulletins |
| 📰 **Actualités** | Lecture des infos et fils de discussion |
| 🔔 **Notifications desktop** | Alertes Windows natives (winotify) |
| 🤖 **Assistant IA** | Gemini (cloud) ou Ollama (100 % local) |
| 👤 **Profil & absences** | Vue complète du profil élève |
| 🔍 **Recherche globale** | Cherche dans les devoirs, cours, actualités |

---

### 🖥️ Compatibilité

| Fonctionnalité | Windows | macOS | Linux |
|---|:---:|:---:|:---:|
| Dashboard web (`app.py`) | ✅ | ✅ | ✅ |
| Setup interactif (`setup.py`) | ✅ | ✅ | ✅ |
| Icône systray (`launcher.py`) | ✅ | ⚠️ partiel | ❌ |
| Notifications desktop | ✅ | ❌ | ❌ |
| Compilation `.exe` | ✅ | ❌ | ❌ |

> Le dashboard web fonctionne sur **tous les OS**. Seul le launcher/systray est Windows-first.

---

### 🚀 Installation rapide

#### 1. Cloner le dépôt

```bash
git clone https://github.com/YOBRO94/PapillonPronote_PC.git
cd PapillonPronote_PC
```

#### 2. Lancer le setup interactif

```bash
python setup.py
```

> Installe les dépendances, crée ton `config.env` et propose de démarrer directement.  
> Fonctionne sur Windows, macOS et Linux.

#### 3. Ouvrir le dashboard

```
http://localhost:5001
```

---

### ⚙️ Configuration manuelle

Copie `config.example.env` en `config.env` et remplis tes identifiants :

```env
PRONOTE_URL=https://0xxxxxxxx.index-education.net/pronote/
PRONOTE_USERNAME=ton_identifiant
PRONOTE_PASSWORD=ton_mot_de_passe
GEMINI_API_KEY=              # optionnel
```

> `config.env` est dans le `.gitignore` — tes identifiants ne quittent jamais ta machine.

---

### 🖥️ Lancement

#### Tous OS — Dashboard web seul

```bash
python app.py
# → http://localhost:5001
```

#### Windows — Avec icône systray

```bash
python launcher.py
```

---

### 📦 Compiler en `.exe` (Windows uniquement)

```bash
pip install pyinstaller
pyinstaller --onefile --noconsole ^
    --name PronoteDashboard ^
    --add-data "templates;templates" ^
    --add-data "static;static" ^
    --add-data "pronotepy;pronotepy" ^
    --add-data "config.example.env;." ^
    --hidden-import winotify ^
    launcher.py
```

> ⚠️ Le dossier `python-embed/` n'est **pas** inclus dans ce dépôt. Il est distribué séparément avec les releases compilées.

---

### 🗂️ Structure du projet

```
PapillonPronote_PC/
├── app.py                  # Serveur Flask — toutes les routes API (3 000+ lignes)
├── launcher.py             # Point d'entrée exe / systray Windows
├── pronote_connexion.py    # Couche de connexion PRONOTE
├── setup.py                # Script d'installation interactif (tous OS)
├── config.example.env      # Modèle de configuration
├── requirements.txt        # Dépendances Python (platform-aware)
│
├── pronotepy/              # Lib PRONOTE embarquée (v2.15.7)
│   └── ent/
│
├── static/
│   ├── css/                # Styles — liquid-glass + overrides
│   ├── img/                # Assets images
│   ├── js/
│   │   ├── dashboard.js    # Logique front principale
│   │   ├── liquid-glass/   # Composants JS liquid-glass
│   │   └── vendor/         # Chart.js + Luxon (offline, pas de CDN)
│   └── logo.png
│
└── templates/
    ├── base.html
    ├── dashboard.html
    └── config_manquante.html
```

---

### 🤖 Assistant IA

PronoteDashboard intègre deux moteurs d'IA :

**Gemini (Google)** — cloud, clé API gratuite :
- Obtenir une clé : [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
- Renseigner `GEMINI_API_KEY` dans `config.env`

**Ollama** — 100 % local, aucune donnée ne sort de ta machine :
- Installer Ollama : [ollama.ai](https://ollama.ai)
- Télécharger un modèle : `ollama pull llama3`
- L'assistant bascule automatiquement sur Ollama si disponible

---

### 📋 Dépendances

| Package | Rôle | OS | Obligatoire |
|---|---|---|---|
| `flask` | Serveur web | Tous | ✅ |
| `python-dotenv` | Lecture config.env | Tous | ✅ |
| `google-genai` | Assistant IA Gemini | Tous | ⬜ optionnel |
| `pystray` | Icône systray | Windows | ⬜ optionnel |
| `Pillow` | Génération icône tray | Windows | ⬜ optionnel |
| `winotify` | Notifications desktop | Windows | ⬜ optionnel |

> `pronotepy` est **embarqué directement** dans le dossier `pronotepy/` — pas besoin de l'installer via pip.

---

### 📜 Licence

Distribué sous licence **MIT**.  
`pronotepy` est sous licence MIT — auteurs : [bain](https://github.com/bain3), [Xiloe](https://github.com/Xiloe).

---

<div align="center">
<sub>Fait avec ☕ et beaucoup de <code>pronotepy</code></sub>
</div>
