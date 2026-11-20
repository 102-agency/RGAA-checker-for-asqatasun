// Thème choisi, appliqué avant le premier affichage (évite le flash clair/sombre).
// Script classique, chargé dans <head> ; l'interface (app.js) gère ensuite le bouton.
try {
  const saved = localStorage.getItem('rgaa-theme')
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved
} catch {
  // Stockage indisponible (navigation privée…) : le thème du système s'applique.
}
