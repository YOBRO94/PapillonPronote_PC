#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pronote_connexion.py — Couche de connexion PRONOTE (login direct pronotepy).

Connexion via identifiant/mot de passe Pronote classiques (pas d'ENT, pas de
QR code, pas de Playwright). pronotepy gère lui-même le token de rafraîchissement
en interne pour la durée de vie du client Python ; on garde ici juste un petit
verrou anti-course pour éviter les requêtes concurrentes juste après connexion.

Nécessite : pronotepy, python-dotenv.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid as uuid_lib
from pathlib import Path

import pronotepy

log = logging.getLogger("pronote_web_dash")


# ─────────────────────────────────────────────────────────────────────────────
# Emplacement des données
# ─────────────────────────────────────────────────────────────────────────────
def _data_dir() -> Path:
    surcharge = os.environ.get("PRONOTE_DATA_DIR")
    if surcharge:
        d = Path(surcharge)
    else:
        base = Path(__file__).resolve().parent
        d = base / "data"
    d.mkdir(parents=True, exist_ok=True)
    return d


DATA_DIR = _data_dir()
UUID_FILE = DATA_DIR / "device_uuid_webdash.txt"


class PronoteError(Exception):
    pass


class PronoteConnexion:
    """Gère la connexion PRONOTE via identifiant/mot de passe direct."""

    def __init__(self, pronote_url: str, username: str | None = None, password: str | None = None):
        self.pronote_url = pronote_url
        self.username = username
        self.password = password
        self._client: pronotepy.Client | None = None
        # Verrou anti-course : juste après une connexion, PRONOTE peut renvoyer
        # "ERROR: 8 | La page a expiré" si deux requêtes partent trop vite en
        # concurrence sur la session toute neuve.
        self._request_lock = threading.RLock()
        self._just_connected_at: float = 0.0
        self._grace_period_s = 1.5

    # ── identité de l'appareil ───────────────────────────────────────────
    @staticmethod
    def get_device_uuid() -> str:
        """UUID stable, propre à cette appli, jamais régénéré après coup."""
        if UUID_FILE.exists():
            v = UUID_FILE.read_text().strip()
            if v:
                return v
        v = str(uuid_lib.uuid4())
        UUID_FILE.write_text(v)
        log.info(f"🆔 Nouveau device_uuid généré : {v}")
        return v

    def connect_sync(self, force: bool = False) -> pronotepy.Client:
        """Bloquant : à appeler depuis un thread, jamais depuis la boucle Flask."""
        if self._client and not force:
            try:
                self._client.session_check()
                return self._client
            except Exception:
                log.warning("⚠️  Session expirée, reconnexion…")
                self._client = None

        if not self.pronote_url or not self.username or not self.password:
            raise PronoteError(
                "PRONOTE_URL, PRONOTE_USERNAME et PRONOTE_PASSWORD doivent être "
                "renseignés dans config.env."
            )

        log.info("🔄 Connexion à PRONOTE (identifiant/mot de passe)…")
        client = pronotepy.Client(
            self.pronote_url,
            username=self.username,
            password=self.password,
            uuid=self.get_device_uuid(),
        )
        if not client.logged_in:
            raise PronoteError("Connexion échouée : identifiants refusés par PRONOTE.")

        log.info("✅ Connecté !")
        self._client = client
        self._just_connected_at = time.monotonic()
        return client

    @property
    def client(self) -> pronotepy.Client | None:
        return self._client

    def call(self, fn, *args, **kwargs):
        """Exécute un appel réseau au client PRONOTE de façon sérialisée.

        Empêche deux requêtes concurrentes de partir juste après la connexion
        initiale (cause de "ERROR: 8 | La page a expiré") : si on est encore
        dans la période de grâce suivant une connexion, on attend qu'elle se
        termine avant de laisser passer l'appel, et on sérialise tous les
        appels entre eux via un verrou réentrant.
        """
        with self._request_lock:
            ecoule = time.monotonic() - self._just_connected_at
            if self._just_connected_at and ecoule < self._grace_period_s:
                time.sleep(self._grace_period_s - ecoule)
            return fn(*args, **kwargs)

    def call_retry(self, fn, *args, **kwargs):
        """Comme call(), mais refait l'appel UNE fois si PRONOTE répond
        « page expirée » (ou toute autre PronoteAPIError).

        Quand la session expire, pronotepy la rouvre (refresh) puis renvoie la
        même requête, construite avec les anciens objets (identifiants
        périmés) : elle échoue de nouveau. Ici, `fn` est rappelée en entier,
        donc elle doit re-résoudre ses objets (période, etc.) à chaque appel.
        À réserver aux LECTURES : ne jamais l'utiliser pour envoyer quelque
        chose (réponse à un message, nouvelle discussion…).
        """
        with self._request_lock:
            try:
                return self.call(fn, *args, **kwargs)
            except pronotepy.exceptions.PronoteAPIError as e:
                log.warning("⚠️  PRONOTE a refusé la requête (%s) — nouvel essai", e)
                time.sleep(0.5)
                return self.call(fn, *args, **kwargs)
