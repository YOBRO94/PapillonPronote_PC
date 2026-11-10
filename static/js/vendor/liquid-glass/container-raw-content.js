// ── Extension maison : permet d'insérer du HTML existant (déjà présent
// dans le DOM du dashboard) comme contenu d'un Container liquid-glass-js,
// au lieu de se limiter aux Button générés par la lib. Le canvas WebGL du
// Container reste en z-index:-1 (comportement natif de la lib), donc le
// contenu ajouté ici s'affiche normalement par-dessus l'effet de verre.
Container.prototype.addRawContent = function (domNode) {
  domNode.style.position = "relative";
  domNode.style.zIndex = "1";
  this.element.appendChild(domNode);
  this.updateSizeFromDOM();
  return domNode;
};
