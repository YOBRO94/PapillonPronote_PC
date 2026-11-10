/* ═══════════════════════════════════════════════════════════════
   Liquid Glass — cœur de calcul (port vanilla JS, sans build-step,
   fidèle à vue-web-liquid-glass : surfaceEquations + displacementMap
   + specular). Tout tourne au runtime dans le navigateur via <canvas>.
   ═══════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  // ── Équations de surface du biseau (surfaceEquations.ts) ──
  const CONVEX_CIRCLE = { fn: (x) => Math.sqrt(1 - (1 - x) ** 2) };
  const CONVEX = { fn: (x) => Math.pow(1 - Math.pow(1 - x, 4), 1 / 4) };
  const CONCAVE = { fn: (x) => 1 - CONVEX_CIRCLE.fn(x) };
  const LIP = {
    fn: (x) => {
      const convex = CONVEX.fn(x * 2);
      const concave = CONCAVE.fn(x) + 0.1;
      const smootherstep = 6 * x ** 5 - 15 * x ** 4 + 10 * x ** 3;
      return convex * (1 - smootherstep) + concave * smootherstep;
    },
  };

  function getSurfaceFn(bezelType) {
    switch (bezelType) {
      case "convex_circle": return CONVEX_CIRCLE.fn;
      case "concave": return CONCAVE.fn;
      case "lip": return LIP.fn;
      case "convex_squircle":
      default: return CONVEX.fn;
    }
  }

  // ── Carte de déplacement 1D du biseau (displacementMap.ts) ──
  function calculateDisplacementMap(glassThickness, bezelWidth, bezelHeightFn, refractiveIndex, samples) {
    samples = samples || 128;
    const eta = 1 / refractiveIndex;
    function refract(normalX, normalY) {
      const dot = normalY;
      const k = 1 - eta * eta * (1 - dot * dot);
      if (k < 0) return null;
      const kSqrt = Math.sqrt(k);
      return [-(eta * dot + kSqrt) * normalX, eta - (eta * dot + kSqrt) * normalY];
    }
    const out = new Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = i / samples;
      const y = bezelHeightFn(x);
      const dx = x < 1 ? 0.0001 : -0.0001;
      const y2 = bezelHeightFn(x + dx);
      const derivative = (y2 - y) / dx;
      const magnitude = Math.sqrt(derivative * derivative + 1);
      const normal = [-derivative / magnitude, -1 / magnitude];
      const refracted = refract(normal[0], normal[1]);
      if (!refracted) { out[i] = 0; continue; }
      const remainingHeightOnBezel = y * bezelWidth;
      const remainingHeight = remainingHeightOnBezel + glassThickness;
      out[i] = refracted[0] * (remainingHeight / refracted[1]);
    }
    return out;
  }

  // ── Carte de déplacement 2D pour une forme "pilule"/cercle (displacementMap2) ──
  function calculateDisplacementMap2(canvasWidth, canvasHeight, objectWidth, objectHeight, radius, bezelWidth, maximumDisplacement, precomputedDisplacementMap, dpr) {
    precomputedDisplacementMap = precomputedDisplacementMap || [];
    const devicePixelRatio = dpr || (typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1);
    const bufferWidth = Math.floor(canvasWidth * devicePixelRatio);
    const bufferHeight = Math.floor(canvasHeight * devicePixelRatio);
    const imageData = new ImageData(bufferWidth, bufferHeight);
    const neutral = 0xff008080;
    new Uint32Array(imageData.data.buffer).fill(neutral);

    const radius_ = radius * devicePixelRatio;
    const bezel = bezelWidth * devicePixelRatio;
    const radiusSquared = radius_ ** 2;
    const radiusPlusOneSquared = (radius_ + 1) ** 2;
    const radiusMinusBezelSquared = (radius_ - bezel) ** 2;

    const objectWidth_ = objectWidth * devicePixelRatio;
    const objectHeight_ = objectHeight * devicePixelRatio;
    const widthBetweenRadiuses = objectWidth_ - radius_ * 2;
    const heightBetweenRadiuses = objectHeight_ - radius_ * 2;
    const objectX = (bufferWidth - objectWidth_) / 2;
    const objectY = (bufferHeight - objectHeight_) / 2;

    for (let y1 = 0; y1 < objectHeight_; y1++) {
      for (let x1 = 0; x1 < objectWidth_; x1++) {
        const idx = ((objectY + y1) * bufferWidth + objectX + x1) * 4;
        const isOnLeftSide = x1 < radius_;
        const isOnRightSide = x1 >= objectWidth_ - radius_;
        const isOnTopSide = y1 < radius_;
        const isOnBottomSide = y1 >= objectHeight_ - radius_;

        const x = isOnLeftSide ? x1 - radius_ : isOnRightSide ? x1 - radius_ - widthBetweenRadiuses : 0;
        const y = isOnTopSide ? y1 - radius_ : isOnBottomSide ? y1 - radius_ - heightBetweenRadiuses : 0;
        const distanceToCenterSquared = x * x + y * y;
        const isInBezel = distanceToCenterSquared <= radiusPlusOneSquared && distanceToCenterSquared >= radiusMinusBezelSquared;

        if (isInBezel) {
          const opacity = distanceToCenterSquared < radiusSquared ? 1 :
            1 - (Math.sqrt(distanceToCenterSquared) - Math.sqrt(radiusSquared)) / (Math.sqrt(radiusPlusOneSquared) - Math.sqrt(radiusSquared));
          const distanceFromCenter = Math.sqrt(distanceToCenterSquared);
          const distanceFromSide = radius_ - distanceFromCenter;
          const cos = x / distanceFromCenter;
          const sin = y / distanceFromCenter;
          const bezelIndex = ((distanceFromSide / bezel) * precomputedDisplacementMap.length) | 0;
          const distance = precomputedDisplacementMap[bezelIndex] || 0;
          const dX = (-cos * distance) / maximumDisplacement;
          const dY = (-sin * distance) / maximumDisplacement;
          imageData.data[idx] = 128 + dX * 127 * opacity;
          imageData.data[idx + 1] = 128 + dY * 127 * opacity;
          imageData.data[idx + 2] = 0;
          imageData.data[idx + 3] = 255;
        }
      }
    }
    return imageData;
  }

  // ── Carte spéculaire (specular.ts) ──
  function calculateRefractionSpecular(objectWidth, objectHeight, radius, bezelWidth, specularAngle, dpr) {
    specularAngle = specularAngle === undefined ? Math.PI / 3 : specularAngle;
    const devicePixelRatio = dpr || (typeof window !== "undefined" ? (window.devicePixelRatio || 1) : 1);
    const bufferWidth = Math.floor(objectWidth * devicePixelRatio);
    const bufferHeight = Math.floor(objectHeight * devicePixelRatio);
    const imageData = new ImageData(bufferWidth, bufferHeight);
    const radius_ = radius * devicePixelRatio;
    const bezel_ = bezelWidth * devicePixelRatio;
    const specularVector = [Math.cos(specularAngle), Math.sin(specularAngle)];
    const radiusSquared = radius_ ** 2;
    const radiusPlusOneSquared = (radius_ + devicePixelRatio) ** 2;
    const radiusMinusBezelSquared = (radius_ - bezel_) ** 2;
    const widthBetweenRadiuses = bufferWidth - radius_ * 2;
    const heightBetweenRadiuses = bufferHeight - radius_ * 2;

    for (let y1 = 0; y1 < bufferHeight; y1++) {
      for (let x1 = 0; x1 < bufferWidth; x1++) {
        const idx = (y1 * bufferWidth + x1) * 4;
        const isOnLeftSide = x1 < radius_;
        const isOnRightSide = x1 >= bufferWidth - radius_;
        const isOnTopSide = y1 < radius_;
        const isOnBottomSide = y1 >= bufferHeight - radius_;
        const x = isOnLeftSide ? x1 - radius_ : isOnRightSide ? x1 - radius_ - widthBetweenRadiuses : 0;
        const y = isOnTopSide ? y1 - radius_ : isOnBottomSide ? y1 - radius_ - heightBetweenRadiuses : 0;
        const distanceToCenterSquared = x * x + y * y;
        const isInBezel = distanceToCenterSquared <= radiusPlusOneSquared && distanceToCenterSquared >= radiusMinusBezelSquared;

        if (isInBezel) {
          const distanceFromCenter = Math.sqrt(distanceToCenterSquared);
          const distanceFromSide = radius_ - distanceFromCenter;
          const opacity = distanceToCenterSquared < radiusSquared ? 1 :
            1 - (distanceFromCenter - Math.sqrt(radiusSquared)) / (Math.sqrt(radiusPlusOneSquared) - Math.sqrt(radiusSquared));
          const cos = x / distanceFromCenter;
          const sin = -y / distanceFromCenter;
          const dotProduct = Math.abs(cos * specularVector[0] + sin * specularVector[1]);
          const coefficient = dotProduct * Math.sqrt(1 - (1 - distanceFromSide / (1 * devicePixelRatio)) ** 2);
          const color = 255 * coefficient;
          const finalOpacity = color * coefficient * opacity;
          imageData.data[idx] = color;
          imageData.data[idx + 1] = color;
          imageData.data[idx + 2] = color;
          imageData.data[idx + 3] = finalOpacity;
        }
      }
    }
    return imageData;
  }

  function imageDataToDataUrl(imageData) {
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.putImageData(imageData, 0, 0);
    return canvas.toDataURL("image/png");
  }

  /**
   * Construit (ou met à jour) un <filter> SVG "liquid glass" pour un
   * élément pilule/cercle donné, exactement comme Filter.vue :
   * feImage (déplacement) → feDisplacementMap → feColorMatrix (saturation)
   * → feImage (spéculaire) → feComposite/feComponentTransfer → feBlend.
   *
   * defsEl : élément <svg><defs> (ou <svg> tout court) où insérer le filtre.
   * Retourne { id, refresh(opts) } pour régénérer si la taille change.
   */
  function creerFiltreLiquidGlass(defsEl, id, opts) {
    opts = opts || {};
    const width = opts.width || 150;
    const height = opts.height || 150;
    const radius = opts.radius !== undefined ? opts.radius : Math.min(width, height) / 2;
    const bezelWidth = opts.bezelWidth || 12;
    const glassThickness = opts.glassThickness || 110;
    const refractiveIndex = opts.refractiveIndex || 1.5;
    const bezelType = opts.bezelType || "convex_squircle";
    const blur = opts.blur !== undefined ? opts.blur : 0;
    const scaleRatio = opts.scaleRatio !== undefined ? opts.scaleRatio : 0.1;
    const specularOpacity = opts.specularOpacity !== undefined ? opts.specularOpacity : 0.4;
    const specularSaturation = opts.specularSaturation !== undefined ? opts.specularSaturation : 10;

    const surfaceFn = getSurfaceFn(bezelType);
    const precomputedMap = calculateDisplacementMap(glassThickness, bezelWidth, surfaceFn, refractiveIndex);
    const maxDisplacement = Math.max.apply(null, precomputedMap.map((x) => Math.abs(x))) || 1;

    const dispData = calculateDisplacementMap2(width, height, width, height, radius, bezelWidth, 100, precomputedMap);
    const dispUrl = imageDataToDataUrl(dispData);
    const specData = calculateRefractionSpecular(width, height, radius, bezelWidth);
    const specUrl = imageDataToDataUrl(specData);
    const scale = maxDisplacement * scaleRatio;

    const svgNS = "http://www.w3.org/2000/svg";
    let filterEl = defsEl.querySelector("#" + id);
    if (!filterEl) {
      filterEl = document.createElementNS(svgNS, "filter");
      filterEl.setAttribute("id", id);
      filterEl.setAttribute("color-interpolation-filters", "sRGB");
      defsEl.appendChild(filterEl);
    }
    filterEl.innerHTML = `
      <feGaussianBlur in="SourceGraphic" stdDeviation="${blur}" result="blurred_source" />
      <feImage href="${dispUrl}" x="0" y="0" width="${width}" height="${height}" result="displacement_map" />
      <feDisplacementMap in="blurred_source" in2="displacement_map" scale="${scale}" xChannelSelector="R" yChannelSelector="G" result="displaced" />
      <feColorMatrix in="displaced" type="saturate" values="${specularSaturation}" result="displaced_saturated" />
      <feImage href="${specUrl}" x="0" y="0" width="${width}" height="${height}" result="specular_layer" />
      <feComposite in="displaced_saturated" in2="specular_layer" operator="in" result="specular_saturated" />
      <feComponentTransfer in="specular_layer" result="specular_faded">
        <feFuncA type="linear" slope="${specularOpacity}" />
      </feComponentTransfer>
      <feBlend in="specular_saturated" in2="displaced" mode="normal" result="withSaturation" />
      <feBlend in="specular_faded" in2="withSaturation" mode="normal" />
    `;
    return id;
  }

  global.LiquidGlassCore = {
    calculateDisplacementMap,
    calculateDisplacementMap2,
    calculateRefractionSpecular,
    imageDataToDataUrl,
    creerFiltreLiquidGlass,
  };
})(window);
