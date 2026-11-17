import { type Check, defineCheck } from '../core/types.ts'

/** Thématique 2 — Cadres. */

const frames = defineCheck(['2.1.1', '2.2.1'], async (ctx, t) => {
  const frames = await ctx.page.evaluate(() => {
    const { ref, norm } = window.__rgaa
    return Array.from(document.querySelectorAll('iframe, frame')).map((el) => {
      let source = el.getAttribute('src') ?? ''
      try {
        // Sans la chaîne de requête : l'empreinte du jugement reste stable d'un chargement à l'autre.
        const url = new URL(source, location.href)
        source = url.host === location.host ? url.pathname : `${url.host}${url.pathname}`
      } catch {
        // `src` non analysable : on garde la valeur brute.
      }
      return {
        title: el.getAttribute('title'),
        cleanTitle: norm(el.getAttribute('title')),
        source,
        ref: ref(el),
      }
    })
  })

  for (const frame of frames) {
    // 2.1.1 — tout cadre, visible ou non, doit porter un attribut title.
    t('2.1.1').applicable()
    if (frame.title === null) {
      t('2.1.1').fail('Le cadre n’a pas d’attribut title.', frame.ref)
      continue // 2.2.1 ne porte que sur les cadres ayant un title.
    }

    // 2.2.1 — pertinence du title : un title vide ne décrit rien, le reste se juge.
    if (frame.cleanTitle === '') {
      t('2.2.1').fail('L’attribut title du cadre est vide.', frame.ref)
      continue
    }
    await t('2.2.1').judgePass({
      topic: 'frame.title',
      question: 'Ce titre de cadre décrit-il le contenu ou la fonction du cadre ?',
      evidence: { title: frame.cleanTitle, source: frame.source },
      ref: frame.ref,
    })
  }
})

export const checks: Check[] = [frames]
