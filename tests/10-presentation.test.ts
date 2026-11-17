import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TestResult } from '../src/core/types.ts'
import { checks } from '../src/themes/10-presentation.ts'
import { type Bench, type BenchOptions, startBench } from './harness.ts'

let bench: Bench
beforeAll(async () => {
  bench = await startBench()
})
afterAll(async () => {
  await bench.stop()
})

const DIR = '10-presentation'

/** Les vérifications qui statuent sur au moins un des tests donnés (l'audit d'une page-témoin reste rapide). */
const pick = (...tests: string[]) =>
  checks.filter((check) => check.tests.some((test) => tests.includes(test)))

function run(fixture: string, tests: string[], options?: BenchOptions) {
  return bench.audit(pick(...tests), `${DIR}/${fixture}.html`, options)
}

const messages = (result: TestResult | undefined) =>
  (result?.failures ?? []).map((failure) => failure.message).join('\n')

const status = (page: Record<string, TestResult>, test: string) =>
  `${test}=${page[test]?.status ?? 'absent'}`

describe('Thématique 10 — présentation de l’information', () => {
  describe('10.1 balises, attributs et espaces de présentation', () => {
    it('relève les balises, attributs et espaces de présentation', async () => {
      const page = await run('markup-ko', ['10.1.1', '10.1.2', '10.1.3'])
      expect(status(page, '10.1.1')).toBe('10.1.1=NC')
      expect(messages(page['10.1.1'])).toContain('<center>')
      expect(messages(page['10.1.1'])).toContain('<font>')
      expect(status(page, '10.1.2')).toBe('10.1.2=NC')
      expect(messages(page['10.1.2'])).toContain('« border » sur <table>')
      expect(messages(page['10.1.2'])).toContain('« width » sur <table>')
      expect(messages(page['10.1.2'])).toContain('« align » sur <td>')
      expect(messages(page['10.1.2'])).toContain('« color » sur <font>')
      expect(status(page, '10.1.3')).toBe('10.1.3=NC')
      expect(messages(page['10.1.3'])).toContain('S E R V I C E S')
      expect(messages(page['10.1.3'])).toContain('insécables')
    })

    it('une page propre est conforme (<b>, <i>, <u> HTML 5, width/height d’image, size de select)', async () => {
      const page = await run('markup-ok', ['10.1.1', '10.1.2', '10.1.3'])
      expect(status(page, '10.1.1')).toBe('10.1.1=C')
      expect(status(page, '10.1.2')).toBe('10.1.2=C')
      expect(status(page, '10.1.3')).toBe('10.1.3=C')
    })

    it('<u> est une balise de présentation hors HTML 5', async () => {
      const page = await run('markup-html4', ['10.1.1'])
      expect(page['10.1.1']?.status).toBe('NC')
      expect(messages(page['10.1.1'])).toContain('<u>')
    })

    it('des espaces qui alignent des colonnes dans un texte préformaté attendent un jugement', async () => {
      const text = 'Nom Age Ville Jean 12 Nîmes Marie 34 Alès'
      const pending = await run('pre-colonnes', ['10.1.3'])
      expect(pending['10.1.3']?.status).toBe('AV')
      const evidence = { texte: text }
      const refused = await run('pre-colonnes', ['10.1.3'], {
        decisions: [{ topic: 'presentation.espaces-pre', evidence, answer: 'fail' }],
      })
      expect(refused['10.1.3']?.status).toBe('NC')
      const accepted = await run('pre-colonnes', ['10.1.3'], {
        decisions: [{ topic: 'presentation.espaces-pre', evidence, answer: 'pass' }],
      })
      expect(accepted['10.1.3']?.status).toBe('C')
    })
  })

  describe('10.2 et 10.3 page sans feuilles de styles', () => {
    it('relève le texte généré par le CSS et le texte qui disparaît sans styles', async () => {
      const page = await run('sans-css-ko', ['10.2.1'])
      expect(page['10.2.1']?.status).toBe('NC')
      expect(messages(page['10.2.1'])).toContain('(obligatoire)')
      expect(messages(page['10.2.1'])).toContain('Texte masqué par l’attribut hidden')
    })

    it('une page dont le contenu est dans le HTML est conforme sans styles', async () => {
      const page = await run('sans-css-ok', ['10.2.1', '10.3.1'])
      expect(status(page, '10.2.1')).toBe('10.2.1=C')
      expect(status(page, '10.3.1')).toBe('10.3.1=C')
    })

    it('une image d’arrière-plan attend un jugement, puis suit la décision', async () => {
      const evidence = { image: `/${DIR}/logo.svg` }
      const pending = await run('fond-image', ['10.2.1'])
      expect(pending['10.2.1']?.status).toBe('AV')
      expect(pending['10.2.1']?.pending[0]?.evidence).toEqual(evidence)
      const refused = await run('fond-image', ['10.2.1'], {
        decisions: [{ topic: 'presentation.image-fond', evidence, answer: 'fail' }],
      })
      expect(refused['10.2.1']?.status).toBe('NC')
      const accepted = await run('fond-image', ['10.2.1'], {
        decisions: [{ topic: 'presentation.image-fond', evidence, answer: 'pass' }],
      })
      expect(accepted['10.2.1']?.status).toBe('C')
    })

    it('un ordre visuel inversé par le CSS attend un jugement, puis suit la décision', async () => {
      const evidence = { ordre: 'Premier paragraphe › Deuxième paragraphe', cas: 'pile inversée' }
      const pending = await run('ordre-ko', ['10.3.1'])
      expect(pending['10.3.1']?.status).toBe('AV')
      expect(pending['10.3.1']?.pending[0]?.evidence).toEqual(evidence)
      const refused = await run('ordre-ko', ['10.3.1'], {
        decisions: [{ topic: 'presentation.ordre-lecture', evidence, answer: 'fail' }],
      })
      expect(refused['10.3.1']?.status).toBe('NC')
      const accepted = await run('ordre-ko', ['10.3.1'], {
        decisions: [{ topic: 'presentation.ordre-lecture', evidence, answer: 'pass' }],
      })
      expect(accepted['10.3.1']?.status).toBe('C')
    })

    it('un ordre visuel conforme à l’ordre du code est conforme', async () => {
      const page = await run('ordre-ok', ['10.3.1'])
      expect(page['10.3.1']?.status).toBe('C')
    })
  })

  describe('10.5 sans feuille de styles', () => {
    it('sans feuille de styles, les tests sont non applicables', async () => {
      const page = await run('sans-style', ['10.5.1', '10.5.2', '10.5.3'])
      expect(page['10.5.1']?.status).toBe('NA')
      expect(page['10.5.2']?.status).toBe('NA')
      expect(page['10.5.3']?.status).toBe('NA')
    })
  })

  describe('10.4.1 et 10.4.2 zoom à 200 %', () => {
    it('relève le texte rogné à 200 % et le zoom interdit par la balise viewport', async () => {
      const page = await run('zoom-ko', ['10.4.1', '10.4.2'])
      expect(status(page, '10.4.1')).toBe('10.4.1=NC')
      expect(messages(page['10.4.1'])).toContain('est rogné')
      expect(status(page, '10.4.2')).toBe('10.4.2=NC')
      expect(messages(page['10.4.2'])).toContain('user-scalable')
      expect(messages(page['10.4.2'])).toContain('maximum-scale')
    })

    it('une page fluide est conforme à 200 %', async () => {
      const page = await run('zoom-ok', ['10.4.1', '10.4.2'])
      expect(status(page, '10.4.1')).toBe('10.4.1=C')
      expect(status(page, '10.4.2')).toBe('10.4.2=C')
    })
  })

  describe('10.5 couleurs de police et de fond', () => {
    it('relève les couleurs déclarées sans leur pendant', async () => {
      const page = await run('couleurs-ko', ['10.5.1', '10.5.2', '10.5.3'])
      expect(status(page, '10.5.1')).toBe('10.5.1=NC')
      expect(messages(page['10.5.1'])).toContain('.a')
      expect(status(page, '10.5.2')).toBe('10.5.2=NC')
      expect(messages(page['10.5.2'])).toContain('.b')
      expect(status(page, '10.5.3')).toBe('10.5.3=NC')
      expect(messages(page['10.5.3'])).toContain('.c')
    })

    it('des couleurs de police et de fond héritées d’un parent sont conformes', async () => {
      const page = await run('couleurs-ok', ['10.5.1', '10.5.2', '10.5.3'])
      expect(status(page, '10.5.1')).toBe('10.5.1=C')
      expect(status(page, '10.5.2')).toBe('10.5.2=C')
      expect(status(page, '10.5.3')).toBe('10.5.3=C')
    })
  })

  describe('10.6 liens signalés par la couleur', () => {
    it('un lien de texte trop proche du texte en contraste est non conforme', async () => {
      const page = await run('liens-contraste-ko', ['10.6.1'])
      expect(page['10.6.1']?.status).toBe('NC')
      expect(messages(page['10.6.1'])).toContain('contraste')
    })

    it('un lien sans indication au survol est non conforme', async () => {
      const page = await run('liens-survol-ko', ['10.6.1'])
      expect(page['10.6.1']?.status).toBe('NC')
      expect(messages(page['10.6.1'])).toContain('au survol')
      expect(messages(page['10.6.1'])).not.toContain('contraste de')
    })

    it('un lien sans indication au focus est non conforme', async () => {
      const page = await run('liens-focus-ko', ['10.6.1'])
      expect(page['10.6.1']?.status).toBe('NC')
      expect(messages(page['10.6.1'])).toContain('au focus')
    })

    it('un lien avec contraste, survol et focus est conforme', async () => {
      const page = await run('liens-ok', ['10.6.1'])
      expect(page['10.6.1']?.status).toBe('C')
    })

    it('des liens soulignés ne sont pas signalés par la seule couleur : non applicable', async () => {
      const page = await run('liens-souligne', ['10.6.1'])
      expect(page['10.6.1']?.status).toBe('NA')
    })
  })

  describe('10.7 focus visible', () => {
    it('relève le focus supprimé', async () => {
      const page = await run('focus-ko', ['10.7.1'])
      expect(page['10.7.1']?.status).toBe('NC')
      expect(page['10.7.1']?.failures.length).toBe(2)
      expect(messages(page['10.7.1'])).toContain('aucun changement visible')
    })

    it('relève un anneau de focus de la couleur du fond', async () => {
      const page = await run('focus-invisible-blanc', ['10.7.1'])
      expect(page['10.7.1']?.status).toBe('NC')
    })

    it('le focus natif, un anneau d’auteur et un champ sont conformes', async () => {
      const page = await run('focus-ok', ['10.7.1'])
      expect(page['10.7.1']?.status, messages(page['10.7.1'])).toBe('C')
    })

    it('un anneau posé sur le pseudo-élément d’une carte entière est vu', async () => {
      const ok = await run('focus-carte', ['10.7.1'])
      expect(ok['10.7.1']?.status, messages(ok['10.7.1'])).toBe('C')
      const ko = await run('focus-carte-ko', ['10.7.1'])
      expect(ko['10.7.1']?.status).toBe('NC')
    })

    it('le focus d’une case à cocher masquée se lit sur son libellé', async () => {
      const ok = await run('focus-case', ['10.7.1'])
      expect(ok['10.7.1']?.status, messages(ok['10.7.1'])).toBe('C')
      const ko = await run('focus-case-ko', ['10.7.1'])
      expect(ko['10.7.1']?.status).toBe('NC')
    })

    it('un focus peu contrasté attend un jugement, puis suit la décision', async () => {
      const pending = await run('focus-faible', ['10.7.1'])
      expect(pending['10.7.1']?.status).toBe('AV')
      const evidence = pending['10.7.1']?.pending[0]?.evidence ?? {}
      expect(evidence.balise).toBe('a')
      const refused = await run('focus-faible', ['10.7.1'], {
        decisions: [{ topic: 'presentation.focus-faible', evidence, answer: 'fail' }],
      })
      expect(refused['10.7.1']?.status).toBe('NC')
      const accepted = await run('focus-faible', ['10.7.1'], {
        decisions: [{ topic: 'presentation.focus-faible', evidence, answer: 'pass' }],
      })
      expect(accepted['10.7.1']?.status).toBe('C')
    })

    it('sans élément focalisable, le test est non applicable', async () => {
      const page = await run('focus-aucun', ['10.7.1'])
      expect(page['10.7.1']?.status).toBe('NA')
    })
  })

  describe('10.8 contenus cachés', () => {
    it('relève un panneau jamais révélé et un lien visible retiré de l’arbre d’accessibilité', async () => {
      const page = await run('cache-ko', ['10.8.1'])
      expect(page['10.8.1']?.status).toBe('NC')
      expect(messages(page['10.8.1'])).toContain('atteignable au clavier')
      expect(messages(page['10.8.1'])).toContain('n’est pas révélé')
    })

    it('un panneau révélé au clavier, un <details> et un libellé référencé sont conformes', async () => {
      const page = await run('cache-ok', ['10.8.1'])
      expect(page['10.8.1']?.status, messages(page['10.8.1'])).toBe('C')
    })

    it('un texte visible en aria-hidden attend un jugement', async () => {
      const evidence = { texte: 'Lire', balise: 'span' }
      const pending = await run('cache-aria', ['10.8.1'])
      expect(pending['10.8.1']?.status).toBe('AV')
      expect(pending['10.8.1']?.pending[0]?.evidence).toEqual(evidence)
      const refused = await run('cache-aria', ['10.8.1'], {
        decisions: [{ topic: 'presentation.aria-hidden-visible', evidence, answer: 'fail' }],
      })
      expect(refused['10.8.1']?.status).toBe('NC')
      const accepted = await run('cache-aria', ['10.8.1'], {
        decisions: [{ topic: 'presentation.aria-hidden-visible', evidence, answer: 'pass' }],
      })
      expect(accepted['10.8.1']?.status).toBe('C')
    })

    it('des initiales ou un texte repris à côté pour les technologies d’assistance sont redondants', async () => {
      const page = await run('cache-initiales', ['10.8.1'])
      expect(page['10.8.1']?.status, messages(page['10.8.1'])).toBe('C')
    })

    it('un contenu masqué sans contrôle ni référence attend un jugement', async () => {
      const evidence = { texte: 'Texte masqué sans aucun contrôle ni référence', balise: 'div' }
      const pending = await run('cache-inconnu', ['10.8.1'])
      expect(pending['10.8.1']?.status).toBe('AV')
      expect(pending['10.8.1']?.pending[0]?.evidence).toEqual(evidence)
      const accepted = await run('cache-inconnu', ['10.8.1'], {
        decisions: [{ topic: 'presentation.contenu-cache', evidence, answer: 'pass' }],
      })
      expect(accepted['10.8.1']?.status).toBe('C')
      const refused = await run('cache-inconnu', ['10.8.1'], {
        decisions: [{ topic: 'presentation.contenu-cache', evidence, answer: 'fail' }],
      })
      expect(refused['10.8.1']?.status).toBe('NC')
    })
  })

  describe('10.9 et 10.10 forme, taille et position', () => {
    const SHAPE = [
      '10.9.1',
      '10.9.2',
      '10.9.3',
      '10.9.4',
      '10.10.1',
      '10.10.2',
      '10.10.3',
      '10.10.4',
    ]
    const topic = 'presentation.forme.texte'
    const evidence = { phrase: 'Cliquez sur le bouton à droite pour valider le formulaire.' }

    it('une consigne qui désigne par la position attend un jugement', async () => {
      const pending = await run('forme-texte', SHAPE)
      expect(pending['10.9.1']?.status).toBe('AV')
      expect(pending['10.10.1']?.status).toBe('AV')
      expect(pending['10.9.1']?.pending[0]?.evidence).toEqual(evidence)
      expect(pending['10.9.2']?.status).toBe('NA')
    })

    it('suit chacune des quatre réponses', async () => {
      const answer = (value: string) =>
        run('forme-texte', SHAPE, { decisions: [{ topic, evidence, answer: value }] })
      const pass = await answer('pass')
      expect(status(pass, '10.9.1')).toBe('10.9.1=C')
      expect(status(pass, '10.10.1')).toBe('10.10.1=NA')
      const fail = await answer('fail')
      expect(status(fail, '10.9.1')).toBe('10.9.1=NC')
      const alternative = await answer('alternative')
      expect(status(alternative, '10.9.1')).toBe('10.9.1=C')
      expect(status(alternative, '10.10.1')).toBe('10.10.1=C')
      const weak = await answer('alternative-insuffisante')
      expect(status(weak, '10.9.1')).toBe('10.9.1=C')
      expect(status(weak, '10.10.1')).toBe('10.10.1=NC')
    })

    it('une consigne qui nomme l’élément ne pose pas de question', async () => {
      const page = await run('forme-ok', SHAPE)
      for (const test of SHAPE) expect(status(page, test)).toBe(`${test}=NA`)
    })

    it('une série d’icônes sans texte ni alternative attend un jugement (images)', async () => {
      const page = await run('forme-image', SHAPE)
      expect(page['10.9.2']?.status).toBe('AV')
      expect(page['10.10.2']?.status).toBe('AV')
      expect(page['10.9.2']?.pending[0]?.evidence.motif).toContain('4 svg')
    })

    it('un contrôle signalé par le style seul attend un jugement, avec aria-current non', async () => {
      const pending = await run('forme-etat', SHAPE)
      expect(pending['10.9.1']?.status).toBe('AV')
      expect(pending['10.9.1']?.pending[0]?.evidence.distinct).toBe('Services')
      const ok = await run('forme-etat-ok', SHAPE)
      expect(status(ok, '10.9.1')).toBe('10.9.1=NA')
    })

    it('un média temporel et un média non temporel attendent un jugement', async () => {
      const page = await run('forme-media', SHAPE)
      expect(page['10.9.3']?.status).toBe('AV')
      expect(page['10.10.3']?.status).toBe('AV')
      expect(page['10.9.4']?.status).toBe('AV')
      expect(page['10.10.4']?.status).toBe('AV')
      expect(page['10.9.3']?.pending[0]?.evidence).toEqual({
        balise: 'video',
        source: `/${DIR}/x.mp4`,
      })
    })
  })

  describe('10.11 reflow', () => {
    it('relève un contenu qui impose un défilement horizontal à 320 px', async () => {
      const page = await run('reflow-ko', ['10.11.1', '10.11.2'])
      expect(status(page, '10.11.1')).toBe('10.11.1=NC')
      expect(messages(page['10.11.1'])).toContain('défilement horizontal')
      expect(status(page, '10.11.2')).toBe('10.11.2=NA')
    })

    it('relève un contenu rogné hors de la fenêtre quand le débordement est masqué', async () => {
      const page = await run('reflow-rogne', ['10.11.1'])
      expect(page['10.11.1']?.status).toBe('NC')
    })

    it('une page fluide est conforme', async () => {
      const page = await run('reflow-ok', ['10.11.1', '10.11.2'])
      expect(status(page, '10.11.1')).toBe('10.11.1=C')
    })

    it('un tableau de données qui dépasse est un cas particulier admis', async () => {
      const page = await run('reflow-tableau', ['10.11.1'])
      expect(page['10.11.1']?.status, messages(page['10.11.1'])).toBe('C')
      expect(page['10.11.1']?.notes.join('\n')).toContain('Cas particulier admis (tableau)')
    })

    it('un contenu masqué à 320 px attend un jugement, puis suit la décision', async () => {
      const evidence = { texte: 'Information réservée aux grands écrans' }
      const pending = await run('reflow-masque', ['10.11.1'])
      expect(pending['10.11.1']?.status).toBe('AV')
      expect(pending['10.11.1']?.pending[0]?.evidence).toEqual(evidence)
      const refused = await run('reflow-masque', ['10.11.1'], {
        decisions: [{ topic: 'presentation.contenu-masque', evidence, answer: 'fail' }],
      })
      expect(refused['10.11.1']?.status).toBe('NC')
      const accepted = await run('reflow-masque', ['10.11.1'], {
        decisions: [{ topic: 'presentation.contenu-masque', evidence, answer: 'pass' }],
      })
      expect(accepted['10.11.1']?.status).toBe('C')
    })

    it('un libellé réduit à une icône qui garde son nom accessible n’est pas perdu', async () => {
      const page = await run('reflow-icone', ['10.11.1'])
      expect(page['10.11.1']?.status, messages(page['10.11.1'])).toBe('C')
    })

    it('un texte en écriture verticale qui dépasse 256 px de haut est non conforme (10.11.2)', async () => {
      const page = await run('vertical-ko', ['10.11.1', '10.11.2'])
      expect(status(page, '10.11.2')).toBe('10.11.2=NC')
    })

    it('un texte vertical qui tient dans 256 px de haut est conforme (10.11.2)', async () => {
      const page = await run('vertical-ok', ['10.11.1', '10.11.2'])
      expect(status(page, '10.11.2')).toBe('10.11.2=C')
    })
  })

  describe('10.12 espacement du texte', () => {
    it('relève un texte rogné quand l’espacement augmente', async () => {
      const page = await run('espacement-ko', ['10.12.1'])
      expect(page['10.12.1']?.status).toBe('NC')
      expect(messages(page['10.12.1'])).toContain('est rogné')
    })

    it('relève des textes qui se chevauchent quand l’espacement augmente', async () => {
      const page = await run('espacement-chevauche', ['10.12.1'])
      expect(page['10.12.1']?.status).toBe('NC')
      expect(messages(page['10.12.1'])).toContain('se chevauchent')
    })

    it('une page fluide est conforme', async () => {
      const page = await run('espacement-ok', ['10.12.1'])
      expect(page['10.12.1']?.status).toBe('C')
    })
  })

  describe('états ouverts (menus, panneaux)', () => {
    it('10.7 : le focus d’un lien qui n’apparaît qu’à l’ouverture d’un menu est mesuré', async () => {
      const ko = await run('menu-ouvert-focus-ko', ['10.7.1'])
      expect(ko['10.7.1']?.status).toBe('NC')
      expect(messages(ko['10.7.1'])).toContain('Premier lien du menu')
      const ok = await run('menu-ouvert-focus-ok', ['10.7.1'])
      expect(ok['10.7.1']?.status, messages(ok['10.7.1'])).toBe('C')
    })

    it('10.4.1 et 10.11.1 : un texte rogné dans un menu ouvert est relevé', async () => {
      const ko = await run('menu-ouvert-rogne-ko', ['10.4.1', '10.11.1'])
      expect(ko['10.4.1']?.status).toBe('NC')
      expect(messages(ko['10.4.1'])).toContain('ouvert')
      expect(ko['10.11.1']?.status).toBe('NC')
      const ok = await run('menu-ouvert-ok', ['10.4.1', '10.11.1', '10.12.1'])
      expect(status(ok, '10.4.1'), messages(ok['10.4.1'])).toBe('10.4.1=C')
      expect(status(ok, '10.11.1'), messages(ok['10.11.1'])).toBe('10.11.1=C')
      expect(status(ok, '10.12.1'), messages(ok['10.12.1'])).toBe('10.12.1=C')
    })

    it('10.4.1 et 10.11.1 : le calque décoratif d’un effet de survol, rangé hors de sa cellule, n’est pas un texte rogné', async () => {
      const page = await run('menu-ouvert-calque-ok', ['10.4.1', '10.11.1'])
      expect(status(page, '10.4.1'), messages(page['10.4.1'])).toBe('10.4.1=C')
      expect(status(page, '10.11.1'), messages(page['10.11.1'])).toBe('10.11.1=C')
    })

    it('10.12 : un texte rogné par l’espacement dans un menu ouvert est relevé', async () => {
      const ko = await run('menu-ouvert-espacement-ko', ['10.12.1'])
      expect(ko['10.12.1']?.status).toBe('NC')
      expect(messages(ko['10.12.1'])).toContain('ouvert')
    })
  })

  describe('10.13 et 10.14 contenus additionnels', () => {
    const ADDITIONAL = ['10.13.1', '10.13.2', '10.13.3', '10.14.1', '10.14.2']

    it('une infobulle CSS sur un déclencheur non focalisable recouvre du texte, ne se masque pas et n’apparaît pas au clavier', async () => {
      const page = await run('survol-css-ko', ADDITIONAL)
      expect(status(page, '10.13.1')).toBe('10.13.1=NC')
      expect(messages(page['10.13.1'])).toContain('Échap')
      expect(status(page, '10.13.3')).toBe('10.13.3=C')
      expect(status(page, '10.14.1')).toBe('10.14.1=NC')
      expect(messages(page['10.14.1'])).toContain('focus')
    })

    it('une infobulle séparée du bouton par un vide disparaît quand le pointeur la rejoint', async () => {
      const page = await run('survol-ecart-ko', ADDITIONAL)
      expect(status(page, '10.13.2')).toBe('10.13.2=NC')
      expect(messages(page['10.13.2'])).toContain('disparaît')
      expect(status(page, '10.14.1')).toBe('10.14.1=C')
    })

    it('une infobulle au survol et au focus, survolable et persistante est conforme', async () => {
      const page = await run('survol-ok', ADDITIONAL)
      expect(status(page, '10.13.1'), messages(page['10.13.1'])).toBe('10.13.1=NA')
      expect(status(page, '10.13.2'), messages(page['10.13.2'])).toBe('10.13.2=C')
      expect(status(page, '10.13.3'), messages(page['10.13.3'])).toBe('10.13.3=C')
      expect(status(page, '10.14.1'), messages(page['10.14.1'])).toBe('10.14.1=C')
      expect(status(page, '10.14.2'), messages(page['10.14.2'])).toBe('10.14.2=C')
    })

    it('une infobulle qui recouvre du texte et se masque avec Échap est conforme', async () => {
      const page = await run('survol-esc-ok', ADDITIONAL)
      expect(status(page, '10.13.1'), messages(page['10.13.1'])).toBe('10.13.1=C')
      expect(status(page, '10.13.3'), messages(page['10.13.3'])).toBe('10.13.3=C')
    })

    it('un contenu qui n’apparaît qu’au focus d’un champ n’apparaît pas au survol', async () => {
      const page = await run('focus-seul-ko', ADDITIONAL)
      expect(status(page, '10.14.2')).toBe('10.14.2=NC')
      expect(messages(page['10.14.2'])).toContain('pas au survol')
    })

    it('un contenu additionnel qui disparaît seul est non conforme', async () => {
      const page = await run('survol-js-ko', ADDITIONAL)
      expect(status(page, '10.13.3')).toBe('10.13.3=NC')
      expect(messages(page['10.13.3'])).toContain('disparaît seul')
    })

    it('sans contenu additionnel, les tests sont non applicables', async () => {
      const page = await run('focus-aucun', ADDITIONAL)
      for (const test of ADDITIONAL) expect(status(page, test)).toBe(`${test}=NA`)
    })
  })

  it('chaque test de la thématique est déclaré par une vérification', () => {
    const declared = new Set(checks.flatMap((check) => check.tests))
    const expected = [
      '10.1.1',
      '10.1.2',
      '10.1.3',
      '10.2.1',
      '10.3.1',
      '10.4.1',
      '10.4.2',
      '10.5.1',
      '10.5.2',
      '10.5.3',
      '10.6.1',
      '10.7.1',
      '10.8.1',
      '10.9.1',
      '10.9.2',
      '10.9.3',
      '10.9.4',
      '10.10.1',
      '10.10.2',
      '10.10.3',
      '10.10.4',
      '10.11.1',
      '10.11.2',
      '10.12.1',
      '10.13.1',
      '10.13.2',
      '10.13.3',
      '10.14.1',
      '10.14.2',
    ]
    expect(expected.filter((test) => !declared.has(test))).toEqual([])
  })
})
