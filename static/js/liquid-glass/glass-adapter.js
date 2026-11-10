/* ═══════════════════════════════════════════════════════════════
   Adaptateur Liquid Glass — applique l'effet verre aux éléments
   existants du dashboard (sidebar, topbar, cartes, boutons…)
   sans remplacer leur contenu HTML/JS.

   Principe : pour chaque élément ciblé, on crée un Container
   liquid-glass "sans enfant" et on injecte SON canvas en fond
   (position absolute, z-index -1) à l'intérieur de l'élément
   existant. Le contenu HTML d'origine reste par-dessus.
   ═══════════════════════════════════════════════════════════════ */

(function () {
  function appliquerGlassSurElement(el, options) {
    if (!el || el.dataset.glassApplique === '1') return;
    el.dataset.glassApplique = '1';

    // L'élément hôte doit pouvoir accueillir un enfant en absolute
    const positionActuelle = getComputedStyle(el).position;
    if (positionActuelle === 'static') {
      el.style.position = 'relative';
    }

    const container = new Container({
      borderRadius: options.borderRadius || 20,
      type: options.type || 'rounded',
      tintOpacity: options.tintOpacity !== undefined ? options.tintOpacity : 0.18
    });

    // On force la taille du wrapper glass sur celle de l'hôte
    container.element.style.position = 'absolute';
    container.element.style.top = '0';
    container.element.style.left = '0';
    container.element.style.width = '100%';
    container.element.style.height = '100%';
    container.element.style.zIndex = '0';
    container.element.style.pointerEvents = 'none';

    // Insère le calque glass en tout premier enfant (donc derrière le reste)
    el.insertBefore(container.element, el.firstChild);
    el.classList.add('a-glass');

    // S'assure que le contenu réel de l'élément reste bien au-dessus
    Array.from(el.children).forEach((enfant) => {
      if (enfant !== container.element && getComputedStyle(enfant).position === 'static') {
        enfant.style.position = 'relative';
        enfant.style.zIndex = '1';
      }
    });

    return container;
  }

  function initLiquidGlassDashboard() {
    if (typeof Container === 'undefined') {
      console.warn('Liquid Glass : Container non chargé, effet ignoré.');
      return;
    }

    const grandsPanneaux = [
      { sel: '.sidebar', opts: { borderRadius: 0, tintOpacity: 0.12 } },
      { sel: '.mobile-topbar', opts: { borderRadius: 0, tintOpacity: 0.12 } }
    ];
    const cartesEtBlocs = [
      { sel: '.carte', opts: { borderRadius: 16, tintOpacity: 0.16 } },
      { sel: '.devoir-carte', opts: { borderRadius: 14, tintOpacity: 0.16 } },
      { sel: '.cours-carte', opts: { borderRadius: 12, tintOpacity: 0.16 } },
      { sel: '.devoir-carte-mini', opts: { borderRadius: 12, tintOpacity: 0.16 } },
      { sel: '.modale-boite', opts: { borderRadius: 20, tintOpacity: 0.22 } },
      { sel: '.sidebar__profil', opts: { borderRadius: 14, tintOpacity: 0.16 } },
      { sel: '.assistant-flottant', opts: { borderRadius: 20, tintOpacity: 0.2 } }
    ];
    const boutons = [
      { sel: '.btn', opts: { borderRadius: 12, tintOpacity: 0.22 } },
      { sel: '.nav-item', opts: { borderRadius: 10, tintOpacity: 0.14 } },
      // .icon-btn volontairement exclu : petits boutons icône (croix de
      // fermeture, flèches…) où le calque glass injecté en enfant peut
      // se peindre par-dessus le glyphe texte et casser son clic/affichage.
      { sel: '.burger-btn', opts: { borderRadius: 10, tintOpacity: 0.2 } }
    ];

    // Panneaux principaux : présents dès le chargement
    grandsPanneaux.forEach(({ sel, opts }) => {
      document.querySelectorAll(sel).forEach((el) => appliquerGlassSurElement(el, opts));
    });

    // Cartes/blocs : peuvent apparaître dynamiquement selon la vue active,
    // on observe donc le DOM en plus du passage initial.
    const cibles = [...cartesEtBlocs, ...boutons];

    function appliquerSurToutesLesCibles(racine) {
      cibles.forEach(({ sel, opts }) => {
        racine.querySelectorAll(sel).forEach((el) => appliquerGlassSurElement(el, opts));
      });
    }

    appliquerSurToutesLesCibles(document);

    const observateur = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((noeud) => {
          if (noeud.nodeType !== 1) return;
          appliquerSurToutesLesCibles(noeud);
          cibles.forEach(({ sel, opts }) => {
            if (noeud.matches && noeud.matches(sel)) {
              appliquerGlassSurElement(noeud, opts);
            }
          });
        });
      });
    });
    observateur.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLiquidGlassDashboard);
  } else {
    initLiquidGlassDashboard();
  }
})();
