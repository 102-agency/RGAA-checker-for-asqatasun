import { type Check, defineCheck, type ElementRef } from '../core/types.ts'

/**
 * Thématique 6 — Liens.
 *
 * Ce qui se mesure : l'existence d'un intitulé (6.2.1) et la présence de l'intitulé
 * visible dans le nom accessible (6.1.5). Ce qui se juge : le caractère « explicite »
 * d'un intitulé (6.1.1 à 6.1.4), que seul un humain peut trancher. Pour ne pas poser
 * une question par lien, seuls les intitulés suspects sont soumis au jugement : intitulés
 * génériques (« cliquez ici »), symboles, adresses brutes, et intitulés identiques qui
 * mènent à des destinations différentes. Les autres sont déclarés conformes, avec une
 * note qui le dit.
 */

type LinkKind = 'texte' | 'image' | 'composite' | 'svg'

interface LinkData {
  kind: LinkKind
  /** Nom accessible calculé (aria-labelledby, aria-label, contenu, alt, title). */
  name: string
  /** Texte réellement visible dans le lien (sans le texte réservé aux lecteurs d'écran). */
  label: string
  /** Destination, sans chaîne de requête superflue : sert à comparer les liens entre eux. */
  destination: string
  /** Texte de l'élément qui porte le lien (item, paragraphe, cellule, titre) : son contexte. */
  context: string
  ref: ElementRef
}

/** Intitulés qui ne disent rien de la destination hors de leur contexte. */
const GENERIC = new Set([
  'ici',
  'cliquez ici',
  'cliquer ici',
  'clic ici',
  'en savoir plus',
  'savoir plus',
  'lire la suite',
  'lire plus',
  'la suite',
  'suite',
  'voir plus',
  'voir la suite',
  'voir',
  'plus',
  'plus d infos',
  'plus d informations',
  'details',
  'detail',
  'lien',
  'ce lien',
  'telecharger',
  'consulter',
  'acceder',
  'cliquez',
  'here',
  'click here',
  'read more',
  'learn more',
  'more',
  'link',
])

/** Minuscules, sans accents ni ponctuation, espaces simples. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\p{Co}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Même chose, sans espaces : « Commander maintenant » devient « commandermaintenant ». */
function compact(text: string): string {
  return fold(text).replace(/ /g, '')
}

function isAddress(name: string): boolean {
  return (
    /^(https?:\/\/|www\.)\S+$/i.test(name.trim()) || /^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(name.trim())
  )
}

async function collectLinks(page: import('playwright').Page): Promise<LinkData[]> {
  return page.evaluate(() => {
    const { ref, norm, isRendered, isVisible, isHiddenFromAT, accName } = window.__rgaa

    /** Texte visible : exclut les nœuds rognés (`sr-only`) et les sous-arbres non rendus. */
    const visibleLabel = (root: Element): string => {
      let out = ''
      const walk = (node: Node) => {
        if (node.nodeType === 3) {
          const parent = node.parentElement
          if (parent && isVisible(parent)) out += node.nodeValue
          return
        }
        if (!(node instanceof Element) || !isRendered(node)) return
        if (['script', 'style', 'noscript', 'template'].includes(node.localName)) return
        const block = getComputedStyle(node).display !== 'inline'
        if (block) out += ' '
        for (const child of node.childNodes) walk(child)
        if (block) out += ' '
      }
      walk(root)
      return norm(out)
    }

    const destinationOf = (el: Element): string => {
      const href = el.getAttribute('href')
      if (!href) return ''
      try {
        const url = new URL(href, location.href)
        const path = `${url.pathname}${url.hash}`
        return url.host === location.host ? path : `${url.host}${path}`
      } catch {
        return href
      }
    }

    const links: LinkData[] = []
    for (const el of document.querySelectorAll('a[href], [role="link"]')) {
      if (isHiddenFromAT(el)) continue
      const images = Array.from(
        el.querySelectorAll('img, svg, [role="img"], canvas, object, embed, input[type="image"]'),
      )
      const label = visibleLabel(el)
      const onlySvg = images.length > 0 && images.every((image) => image.localName === 'svg')
      const kind: LinkData['kind'] =
        images.length === 0 ? 'texte' : label === '' ? (onlySvg ? 'svg' : 'image') : 'composite'
      const holder = el.closest(
        'li, p, td, th, dd, dt, h1, h2, h3, h4, h5, h6, figcaption, article',
      )
      // Le contexte n'apporte rien quand le lien est tout le texte de son conteneur.
      const around = holder && holder !== el ? norm(holder.textContent) : ''
      links.push({
        kind,
        name: accName(el),
        label,
        destination: destinationOf(el),
        context: around === norm(el.textContent) ? '' : around.slice(0, 160),
        ref: ref(el),
      })
    }
    return links
  })
}

const KIND_TEST: Record<LinkKind, string> = {
  texte: '6.1.1',
  image: '6.1.2',
  composite: '6.1.3',
  svg: '6.1.4',
}

const KIND_LABEL: Record<LinkKind, string> = {
  texte: 'lien texte',
  image: 'lien image',
  composite: 'lien composite',
  svg: 'lien SVG',
}

const links = defineCheck(
  ['6.1.1', '6.1.2', '6.1.3', '6.1.4', '6.1.5', '6.2.1'],
  async (ctx, t) => {
    const all = await ctx.memo('liens', () => collectLinks(ctx.page))

    // Destinations rencontrées pour chaque intitulé : deux liens de même nom qui mènent
    // ailleurs ne sont explicites que grâce à leur contexte.
    const destinations = new Map<string, Set<string>>()
    for (const link of all) {
      if (link.name === '') continue
      const key = fold(link.name)
      destinations.set(key, (destinations.get(key) ?? new Set()).add(link.destination))
    }

    for (const link of all) {
      // 6.2.1 — chaque lien a un intitulé.
      t('6.2.1').applicable()
      if (link.name === '') {
        t('6.2.1').fail(
          `Lien sans intitulé : ${KIND_LABEL[link.kind]} dont le nom accessible est vide.`,
          link.ref,
        )
        continue // les autres tests de la thématique portent sur l'intitulé.
      }

      // 6.1.5 — l'intitulé visible figure dans le nom accessible.
      if (link.label !== '') {
        t('6.1.5').applicable()
        const wanted = compact(link.label)
        if (wanted === '') {
          // Le libellé visible n'est qu'un symbole (« > », « × », « + ») : il se lit selon sa fonction.
          await t('6.1.5').judgePass({
            topic: 'link.symbol',
            question: `Le libellé visible « ${link.label} » est un symbole : le nom accessible « ${link.name} » exprime-t-il la fonction de ce symbole ?`,
            evidence: { label: link.label, name: link.name },
            ref: link.ref,
          })
        } else if (!compact(link.name).includes(wanted)) {
          t('6.1.5').fail(
            `Le nom accessible « ${link.name} » ne contient pas l’intitulé visible « ${link.label} ».`,
            link.ref,
          )
        }
      }

      // 6.1.1 à 6.1.4 — l'intitulé est explicite.
      const test = KIND_TEST[link.kind]
      t(test).applicable()
      const key = fold(link.name)
      const reason = GENERIC.has(key)
        ? 'cet intitulé est générique'
        : key === ''
          ? 'cet intitulé ne contient aucun mot'
          : isAddress(link.name)
            ? 'cet intitulé est une adresse brute'
            : (destinations.get(key)?.size ?? 0) > 1
              ? 'plusieurs liens portent cet intitulé et mènent à des destinations différentes'
              : null
      if (!reason) continue
      await t(test).judgePass({
        topic: 'link.explicit',
        question: `Ce ${KIND_LABEL[link.kind]} « ${link.name} » (${reason}) est-il explicite, seul ou grâce à son contexte ? Un lien ambigu pour tout le monde est non applicable : répondre « pass ».`,
        evidence: {
          type: link.kind,
          intitule: link.name,
          destination: link.destination,
          contexte: link.context,
        },
        ref: link.ref,
      })
    }

    for (const test of new Set(all.map((link) => KIND_TEST[link.kind]))) {
      t(test).note(
        'Seuls les intitulés suspects (génériques, symboles, adresses, homonymes) sont soumis au jugement : un intitulé explicite en apparence est déclaré conforme sans relecture.',
      )
    }
  },
)

export const checks: Check[] = [links]
