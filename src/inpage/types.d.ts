/**
 * Types de `window.__rgaa`, l'API injectée dans chaque page auditée
 * (implémentation : `helpers.js`). À utiliser dans les fonctions passées à
 * `page.evaluate`.
 */
export interface RgaaElementRef {
  selector: string
  snippet: string
}

export interface RgaaInPage {
  /** Espaces normalisés et bords rognés. */
  norm(value: string | null | undefined): string
  /** Sélecteur CSS unique de l'élément. */
  selector(el: Element): string
  /** Balise ouvrante + début du contenu (220 caractères par défaut). */
  snippet(el: Element, max?: number): string
  /** `{ selector, snippet }`, à renvoyer vers Node pour `fail(message, ref)`. */
  ref(el: Element): RgaaElementRef
  /** Rendu : ni `display:none`, ni `visibility:hidden`. */
  isRendered(el: Element): boolean
  /** Visible à l'écran : rendu, boîte non nulle, ni transparent ni rogné (`sr-only`). */
  isVisible(el: Element): boolean
  /** Retiré de l'arbre d'accessibilité : non rendu, `aria-hidden="true"`, `inert`. */
  isHiddenFromAT(el: Element): boolean
  /** Nom accessible calculé (algorithme accname, via axe-core). */
  accName(el: Element): string
  /** Rôle ARIA effectif (explicite ou implicite), ou `null`. */
  role(el: Element): string | null
  /** Texte visible, contenus masqués exclus. */
  visibleText(el: Element, options?: { skipAriaHidden?: boolean }): string
  /** Texte exposé aux technologies d'assistance : sans les sous-arbres `aria-hidden` (doublons décoratifs). */
  readableText(el: Element): string
  /** Couleur CSS quelconque (oklch, color-mix…) vers sRGB `[r, g, b, a]`. */
  rgba(color: string): [number, number, number, number]
  /** Superpose `front` (avec alpha) sur un fond opaque. */
  blend(front: number[], back: number[]): [number, number, number]
  /** Luminance relative WCAG. */
  luminance(rgb: number[]): number
  /** Rapport de contraste WCAG entre deux couleurs opaques. */
  contrast(a: number[], b: number[]): number
  /** Éléments atteignables à la tabulation, dans l'ordre du DOM. */
  tabbables(root?: ParentNode): HTMLElement[]
  /** À appeler après une modification du DOM, avant `accName` / `role`. */
  resetTree(): void
}

declare global {
  interface Window {
    __rgaa: RgaaInPage
  }
}
