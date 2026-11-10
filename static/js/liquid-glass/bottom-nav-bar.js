/* ═══════════════════════════════════════════════════════════════
   LiquidGlassBottomNavBar — port vanilla JS fidèle du composant Vue
   LiquidGlassBottomNavBar.vue (vue-web-liquid-glass) : pilule de verre
   qui glisse avec un effet ressort + wobble (squash/stretch), un
   filtre SVG de réfraction déplacé/regénéré par item, glissable au
   doigt/souris, cliquable, avec fondu rapide du verre au repos.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  // Presets fidèles au composant Vue d'origine (LiquidGlassBottomNavBar.vue) :
  // thumbHeight est TOUJOURS < height, la pill reste contenue dans la barre,
  // centrée verticalement (jamais de débordement).
  // thumbScaleY relevé à ~1.4-1.5 (au lieu de 1.1-1.2) : avec l'ancienne
  // valeur, thumbHeight*scaleY dépassait à peine height (ex: 50*1.1=55 vs
  // barre de 54px — 0,5px de débordement par côté, invisible). Les vraies
  // implémentations iOS 26-like (voir recherche : pub.dev/liquid_tab_bar —
  // "balloons past the capsule, taller than the bar, escaping its top and
  // bottom edge evenly") font déborder la pille de façon nette et
  // symétrique quand elle est active.
  const SIZE_PRESETS = {
    small:  { height: 42, itemWidth: 60,  thumbHeight: 38, bezelWidth: 6,  glassThickness: 100, fontSize: "9px",  iconSize: 16, thumbScale: 1.4, thumbScaleY: 1.5 },
    medium: { height: 54, itemWidth: 80,  thumbHeight: 50, bezelWidth: 8,  glassThickness: 110, fontSize: "10px", iconSize: 20, thumbScale: 1.3, thumbScaleY: 1.45 },
    large:  { height: 67, itemWidth: 100, thumbHeight: 62, bezelWidth: 13, glassThickness: 120, fontSize: "12px", iconSize: 24, thumbScale: 1.3, thumbScaleY: 1.4 },
  };

  function lerp(a, b, t) { return a * (1 - t) + b * t; }

  class LiquidGlassBottomNavBar {
    /**
     * @param {HTMLElement} root - conteneur qui va recevoir la barre
     * @param {Array<{id:string,label:string,icon:string,badgeEl?:string}>} items
     * @param {object} opts - { size, color, onSelect(id), initial }
     */
    constructor(root, items, opts) {
      opts = opts || {};
      this.root = root;
      this.items = items;
      this.size = opts.size || "medium";
      this.dims = SIZE_PRESETS[this.size];
      this.color = opts.color || "#29947A";
      this.onSelect = opts.onSelect || function () {};
      this.value = opts.initial || items[0].id;

      this.pointerDown = false;
      this.initialPointerX = 0;
      this.initialThumbX = 0;
      this.currentThumbX = 0;
      this.thumbVelocity = 0; // vitesse du ressort (px/frame), pour l'overshoot
      this.wobbleX = 1;
      this.wobbleY = 1;
      // Suivi de l'état "actif" pour ne régénérer le filtre liquid glass
      // qu'aux TRANSITIONS (voir _render/_regenerateThumbGlass), pas à
      // chaque frame — coûteux car basé sur des boucles pixel par pixel.
      this._lastActiveRendered = null;
      this.animFrame = null;
      this.glassVisible = false;
      this.hideGlassTimeout = null;
      this.filterId = "lgnav-filter-" + Math.random().toString(36).slice(2, 9);
      this.bgFilterId = "lgnav-bgfilter-" + Math.random().toString(36).slice(2, 9);

      this._build();
      this._wireEvents();
      this._snapToValue(true);
      this._refreshFilters();

      window.addEventListener("resize", () => this._onResize());
    }

    get itemWidth() { return this.dims.itemWidth; }
    get thumbWidth() { return this.itemWidth - 4; }
    get sliderWidth() { return this.itemWidth * this.items.length; }
    get sliderHeight() { return this.dims.height; }
    get thumbHeight() { return this.dims.thumbHeight; }
    get thumbRadius() { return this.thumbHeight / 2; }

    _build() {
      const w = this.sliderWidth, h = this.sliderHeight;
      this.root.classList.add("lgnav");
      this.root.innerHTML = `
        <div class="lgnav__scroll">
          <div class="lgnav__wrap" style="width:${w}px;height:${h}px;border-radius:${h / 2}px;">
            <svg class="lgnav__defs" width="0" height="0" style="position:absolute;">
              <defs></defs>
            </svg>
            <div class="lgnav__bg" style="border-radius:${h / 2}px;"></div>
            <div class="lgnav__targets"></div>
            <div class="lgnav__thumb" style="width:${this.thumbWidth}px;height:${this.thumbHeight}px;top:${h / 2}px;">
              <div class="lgnav__thumb-inner" style="position:absolute;top:50%;left:50%;width:${this.thumbWidth}px;height:${this.thumbHeight}px;border-radius:${this.thumbRadius}px;"></div>
            </div>
            <div class="lgnav__items"></div>
          </div>
        </div>
      `;
      // L'ancien design partait du principe "thumbHeight TOUJOURS < height,
      // jamais de débordement" — .lgnav__wrap a donc très probablement
      // overflow:hidden dans le CSS (c'est justement ce qui garantissait
      // ça). On veut maintenant l'inverse (débordement voulu, voir
      // thumbScaleY ci-dessus) : on force overflow:visible en inline pour
      // être sûr, quel que soit le CSS externe.
      const wrapEl = this.root.querySelector(".lgnav__wrap");
      wrapEl.style.overflow = "visible";

      // Débordement max de la pill agrandie au-delà de la barre, en X
      // (voir _clampBounds) et en Y (nouveau, pour l'échappement vertical).
      // .lgnav__scroll a overflow-x:auto (coupe tout débordement) — on lui
      // donne donc un padding égal au débordement max dans les deux sens,
      // compensé par une marge négative égale, pour que la pill ne soit
      // jamais rognée, ni sur les côtés ni en haut/bas.
      const halfGrown = (this.thumbWidth * this.dims.thumbScale) / 2;
      const halfGrownY = Math.max(0, (this.thumbHeight * this.dims.thumbScaleY - this.sliderHeight) / 2) + 6;
      const scrollEl = this.root.querySelector(".lgnav__scroll");
      scrollEl.style.padding = `${halfGrownY}px ${halfGrown}px`;
      scrollEl.style.margin = `-${halfGrownY}px -${halfGrown}px`;

      this.svgDefs = this.root.querySelector(".lgnav__defs defs");
      this.bgEl = this.root.querySelector(".lgnav__bg");
      this.thumbEl = this.root.querySelector(".lgnav__thumb");
      this.thumbInnerEl = this.root.querySelector(".lgnav__thumb-inner");
      this.targetsEl = this.root.querySelector(".lgnav__targets");
      this.itemsEl = this.root.querySelector(".lgnav__items");

      this.items.forEach((item) => {
        const target = document.createElement("div");
        target.className = "lgnav__target";
        target.style.width = this.itemWidth + "px";
        target.dataset.id = item.id;
        this.targetsEl.appendChild(target);

        const cell = document.createElement("div");
        cell.className = "lgnav__item";
        cell.style.width = this.itemWidth + "px";
        cell.dataset.id = item.id;
        cell.innerHTML = `
          <span class="lgnav__icon">${item.icon || ""}</span>
          <span class="lgnav__label" style="font-size:${this.dims.fontSize};">${item.label}</span>
          ${item.badgeId ? `<span class="pastille-badge lgnav__badge" id="${item.badgeId}" hidden>0</span>` : ""}
        `;
        this.itemsEl.appendChild(cell);
      });
    }

    // Paramètres du filtre pill, paramétrables en largeur/hauteur : permet
    // de régénérer une VRAIE géométrie circulaire à la taille agrandie
    // (état actif) au lieu d'étirer via CSS scale() non-uniforme, ce qui
    // transformait les bouts arrondis en ellipses aplaties (la déformation
    // ne semblait alors visible qu'en haut/bas, jamais sur tout le tour).
    _thumbFilterOpts(w, h) {
      return {
        width: w, height: h, radius: h / 2,
        bezelWidth: this.dims.bezelWidth, glassThickness: this.dims.glassThickness * 1.8, refractiveIndex: 1.5,
        blur: 0, scaleRatio: 0.9, specularOpacity: 0.4, specularSaturation: 10,
      };
    }

    _refreshFilters() {
      if (typeof LiquidGlassCore === "undefined") return;
      const h = this.sliderHeight, w = this.sliderWidth;
      // Fond de la barre : réfraction très légère, juste assez pour donner
      // de la matière au verre — ne doit JAMAIS magnifier plus que la pill.
      LiquidGlassCore.creerFiltreLiquidGlass(this.svgDefs, this.bgFilterId, {
        width: w, height: h, radius: h / 2,
        bezelWidth: 10, glassThickness: 60, refractiveIndex: 1.15,
        blur: 2, scaleRatio: 0.1, specularOpacity: 1, specularSaturation: 19,
      });
      this.bgEl.style.backdropFilter = `url(#${this.bgFilterId})`;
      // Pill (thumb) au repos : taille de base, vrai cercle aux extrémités.
      LiquidGlassCore.creerFiltreLiquidGlass(this.svgDefs, this.filterId, this._thumbFilterOpts(this.thumbWidth, this.thumbHeight));
      this.thumbInnerEl.style.backdropFilter = `url(#${this.filterId})`;
      this._lastActiveRendered = false;
    }

    // Régénère le filtre pill à la taille réellement affichée (grossie ou
    // non), en recalculant le rayon = h/2 à CHAQUE fois : le biseau reste
    // donc toujours un vrai demi-cercle aux deux bouts, quelle que soit la
    // taille — jamais une ellipse issue d'un scale() CSS non-uniforme.
    _regenerateThumbGlass(w, h) {
      this.thumbInnerEl.style.width = w + "px";
      this.thumbInnerEl.style.height = h + "px";
      this.thumbInnerEl.style.borderRadius = (h / 2) + "px";
      LiquidGlassCore.creerFiltreLiquidGlass(this.svgDefs, this.filterId, this._thumbFilterOpts(w, h));
      // L'id du filtre ne change pas, mais on réaffecte quand même l'URL :
      // certains navigateurs ne re-rendent pas un backdrop-filter existant
      // après une mise à jour du <filter> référencé sans ce "toggle".
      this.thumbInnerEl.style.backdropFilter = "none";
      // eslint-disable-next-line no-unused-expressions
      this.thumbInnerEl.offsetHeight; // force reflow
      this.thumbInnerEl.style.backdropFilter = `url(#${this.filterId})`;
    }

    _onResize() {
      // Tailles fixes en px (pas de layout fluide ici) : on régénère juste
      // les filtres si jamais le device pixel ratio a changé (zoom navigateur).
      this._refreshFilters();
      this._snapToValue(true);
    }

    _indexOf(id) { return this.items.findIndex((it) => it.id === id); }

    // Bornes communes au clic (_targetXForIndex) et au drag (onMove) :
    // le blocage se déclenche quand la MOITIÉ de la pill agrandie (scale
    // au clic/drag) dépasserait de l'extrémité de la barre (x=0 à
    // gauche, x=sliderWidth à droite). Au-delà, la pill ne bouge plus
    // mais reste entière, jamais coupée.
    get _clampBounds() {
      const centerOffset = (this.itemWidth - this.thumbWidth) / 2;
      const grownWidth = this.thumbWidth * this.dims.thumbScale;
      const halfGrown = grownWidth / 2;
      const thumbCenterOffset = this.thumbWidth / 2; // du bord gauche du thumb à son centre
      // x = position du bord gauche du thumb (au repos, sans scale).
      // Le bord gauche visuel (agrandi) est à : x + thumbCenterOffset - halfGrown
      // On veut : bord gauche visuel >= -halfGrown (la moitié peut dépasser à gauche de x=0)
      //   => x >= -halfGrown - thumbCenterOffset + halfGrown = -thumbCenterOffset
      // Le bord droit visuel (agrandi) est à : x + thumbCenterOffset + halfGrown
      // On veut : bord droit visuel <= sliderWidth + halfGrown
      //   => x <= sliderWidth + halfGrown - thumbCenterOffset - halfGrown = sliderWidth - thumbCenterOffset
      const minPos = -thumbCenterOffset;
      const maxPos = this.sliderWidth - thumbCenterOffset;
      return { minPos, maxPos, centerOffset };
    }

    _targetXForIndex(index) {
      const { centerOffset, minPos, maxPos } = this._clampBounds;
      let x = index * this.itemWidth + centerOffset;
      if (x < minPos) x = minPos;
      if (x > maxPos) x = maxPos;
      return x;
    }

    _snapToValue(instant) {
      const idx = Math.max(0, this._indexOf(this.value));
      const dest = this._targetXForIndex(idx);
      if (instant) {
        this.currentThumbX = dest;
        this._render();
      } else {
        this._animateTo(dest);
      }
    }

    // Raideur/amortissement du ressort : sous-amorti exprès (damping < le
    // seuil critique) pour que la pille DÉPASSE sa cible et oscille avant
    // de se stabiliser — effet "jelly" voulu.
    static get SPRING_STIFFNESS() { return 0.22; }
    static get SPRING_DAMPING() { return 0.62; }

    _animateTo() {
      if (this.animFrame) cancelAnimationFrame(this.animFrame);
      const step = () => {
        if (this.pointerDown) return;
        const idx = Math.max(0, this._indexOf(this.value));
        const dest = this._targetXForIndex(idx);
        const diff = dest - this.currentThumbX;

        const accel = diff * LiquidGlassBottomNavBar.SPRING_STIFFNESS;
        this.thumbVelocity = (this.thumbVelocity + accel) * LiquidGlassBottomNavBar.SPRING_DAMPING;
        this.currentThumbX += this.thumbVelocity;

        const speed = Math.abs(this.thumbVelocity);
        const stretch = 1 + Math.min(speed * 0.025, 0.55);
        const squash = 1 / stretch;
        this.wobbleX = lerp(this.wobbleX, stretch, 0.35);
        this.wobbleY = lerp(this.wobbleY, squash, 0.35);

        const settled =
          Math.abs(diff) < 0.3 &&
          Math.abs(this.thumbVelocity) < 0.3 &&
          Math.abs(this.wobbleX - 1) < 0.01;
        if (settled) {
          this.currentThumbX = dest;
          this.thumbVelocity = 0;
          this.wobbleX = 1;
          this.wobbleY = 1;
          this._render();
          return;
        }
        this._render();
        this.animFrame = requestAnimationFrame(step);
      };
      step();
    }

    _render() {
      const active = this.pointerDown || this.glassVisible;

      // Ne régénère le filtre (coûteux, boucles pixel par pixel) QUE quand
      // l'état actif change réellement — pas à chaque frame.
      if (active !== this._lastActiveRendered) {
        const w = active ? this.thumbWidth * this.dims.thumbScale : this.thumbWidth;
        const h = active ? this.thumbHeight * this.dims.thumbScaleY : this.thumbHeight;
        this._regenerateThumbGlass(w, h);
        this._lastActiveRendered = active;
      }

      // Le thumb (conteneur de position/clic) ne porte plus le scale de
      // magnification — seulement sa position. La magnification réelle est
      // maintenant dans les vraies dimensions de thumbInnerEl (ci-dessus),
      // donc le biseau circulaire du filtre reste toujours un vrai cercle.
      this.thumbEl.style.transform = `translateX(${this.currentThumbX}px) translateY(-50%)`;

      // Le wobble (squash/stretch du rebond ressort) reste un léger scale
      // CSS transitoire sur thumbInnerEl, en plus de ses vraies dimensions
      // — une imperfection brève et minime, cohérente avec l'effet "jelly".
      this.thumbInnerEl.style.transform =
        `translate(-50%, -50%) scale(${this.wobbleX}) scaleY(${this.wobbleY})`;

      this.thumbInnerEl.classList.toggle("lgnav__thumb-inner--glass", active);
      this.itemsEl.style.zIndex = active ? "20" : "50";

      this.items.forEach((item) => {
        const cell = this.itemsEl.querySelector(`.lgnav__item[data-id="${item.id}"]`);
        if (!cell) return;
        const isSel = item.id === this.value;
        cell.classList.toggle("lgnav__item--actif", isSel);
        cell.style.color = isSel ? this.color : "";
      });

      this.root.style.transform = active ? "scale(1.04)" : "scale(1)";
    }

    _flashGlass() {
      if (this.hideGlassTimeout) clearTimeout(this.hideGlassTimeout);
      this.glassVisible = true;
      this._render();
      this.hideGlassTimeout = setTimeout(() => {
        this.glassVisible = false;
        this._render();
      }, 280);
    }

    _select(id, fromDrag) {
      const changed = id !== this.value;
      this.value = id;
      if (changed) this.onSelect(id);
      if (!fromDrag) this._flashGlass();
      if (!this.pointerDown) this._animateTo();
    }

    _wireEvents() {
      this.targetsEl.querySelectorAll(".lgnav__target").forEach((target) => {
        target.addEventListener("click", () => this._select(target.dataset.id, false));
      });
      this.itemsEl.querySelectorAll(".lgnav__item").forEach((cell) => {
        cell.addEventListener("click", () => this._select(cell.dataset.id, false));
      });

      const onDown = (e) => {
        const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
        this.pointerDown = true;
        this.initialPointerX = clientX;
        this.initialThumbX = this.currentThumbX;
        this.glassVisible = true;
        if (this.animFrame) cancelAnimationFrame(this.animFrame);
        this._render();
        window.addEventListener("mousemove", onMove);
        window.addEventListener("touchmove", onMove, { passive: false });
        window.addEventListener("mouseup", onUp);
        window.addEventListener("touchend", onUp);
      };

      const onMove = (e) => {
        if (!this.pointerDown) return;
        const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
        const delta = clientX - this.initialPointerX;
        let newPos = this.initialThumbX + delta;

        // Bornes DURES (pas d'élastique) : le blocage se déclenche dès que
        // la MOITIÉ de la pill agrandie dépasserait de l'extrémité de la
        // barre (voir _clampBounds). Au-delà, la pill ne bouge plus.
        const { minPos, maxPos } = this._clampBounds;
        if (newPos < minPos) newPos = minPos;
        if (newPos > maxPos) newPos = maxPos;

        const velocity = newPos - this.currentThumbX;
        const speed = Math.abs(velocity);
        const stretch = 1 + Math.min(speed * 0.05, 0.4);
        const squash = 1 / stretch;
        this.wobbleX = lerp(this.wobbleX, stretch, 0.2);
        this.wobbleY = lerp(this.wobbleY, squash, 0.2);

        this.currentThumbX = newPos;
        this._render();
      };

      const onUp = (e) => {
        this.pointerDown = false;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("touchmove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("touchend", onUp);

        const thumbCenter = this.currentThumbX + this.thumbWidth / 2;
        let index = Math.floor(thumbCenter / this.itemWidth);
        index = Math.max(0, Math.min(index, this.items.length - 1));
        const newItem = this.items[index];
        if (newItem) this._select(newItem.id, true);
        this._animateTo();

        if (this.hideGlassTimeout) clearTimeout(this.hideGlassTimeout);
        this.hideGlassTimeout = setTimeout(() => {
          this.glassVisible = false;
          this._render();
        }, 280);
      };

      this.thumbEl.addEventListener("mousedown", onDown);
      this.thumbEl.addEventListener("touchstart", onDown, { passive: true });
    }

    /** Change la sélection depuis l'extérieur (ex: navigation programmatique). */
    setValue(id, animate) {
      if (id === this.value) return;
      this.value = id;
      if (animate === false) this._snapToValue(true);
      else this._animateTo();
      this._render();
    }
  }

  window.LiquidGlassBottomNavBar = LiquidGlassBottomNavBar;
})();
