import { UserError } from '../core/errors.ts'

/**
 * Adresse du site audité : `http:` ou `https:` uniquement. Les autres schémas
 * (`file:`, `javascript:`, `data:`, `chrome:`…) donneraient au navigateur piloté
 * accès à autre chose qu'un site web. Les identifiants dans l'URL sont refusés :
 * ils finiraient en clair dans les rapports.
 */
export function parseSiteUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new UserError(
      `Adresse du site invalide : « ${input.slice(0, 200)} » (exemple : https://www.exemple.fr).`,
    )
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UserError(
      `Schéma refusé (${url.protocol}) : seules les adresses http et https sont auditées.`,
    )
  }
  if (url.username || url.password) {
    throw new UserError(
      "Identifiants refusés dans l'adresse : ils seraient écrits en clair dans les rapports.",
    )
  }
  url.hash = ''
  return url
}

/** Chemin canonique d'une URL : sans barre finale (sauf la racine). */
export function canonicalPath(url: URL): string {
  return url.pathname.replace(/\/+$/, '') || '/'
}

/**
 * Résout un chemin ou une URL donnée en argument par rapport au site.
 * Une URL d'un autre site est refusée : l'audit reste sur le site demandé.
 */
export function resolvePageUrl(base: URL, input: string): URL {
  let url: URL
  try {
    url = new URL(input, base)
  } catch {
    throw new UserError(`Chemin invalide : « ${input.slice(0, 200)} ».`)
  }
  if (url.origin !== base.origin) {
    throw new UserError(`${url.href} n'est pas sur le site audité (${base.origin}).`)
  }
  if (url.username || url.password) {
    throw new UserError(`Identifiants refusés dans l'adresse ${url.origin}${url.pathname}.`)
  }
  url.hash = ''
  return url
}
