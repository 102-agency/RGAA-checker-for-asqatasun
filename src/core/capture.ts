import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Locator, Page } from 'playwright'
import { assertSafeSegment, containedPath } from '../security/fs.ts'

/**
 * Captures d'écran des zones concernées par un échec ou une question.
 *
 * La capture montre l'élément entouré d'un cadre rouge, avec une marge de
 * contexte autour, pour qu'un évaluateur (humain ou IA) voie tout de suite de
 * quoi il s'agit. Les fichiers vont dans `<rapport>/preuves/<dossier>/<empreinte>.png`.
 */

/** Chemin relatif d'une capture, tel qu'il figure dans les rapports. */
export const SCREENSHOT_PATH = /^preuves\/[\p{L}\p{N}][\p{L}\p{N}._-]{0,127}\/[0-9a-f]{12}\.png$/u

/** Dossier des captures d'échecs (les questions sont rangées par sujet). */
export const FAILURE_FOLDER = 'echecs'

const MARK = 'data-rgaa-cible'
// `outline` et `box-shadow` : certains sites neutralisent l'un ou l'autre sur leurs champs.
const HIGHLIGHT = `[${MARK}]{outline:3px solid #d0021b !important;outline-offset:2px !important;box-shadow:0 0 0 5px #d0021b !important}`
/** Marge de contexte autour de l'élément, en pixels CSS. */
const MARGIN = 32
const TIMEOUT_MS = 4_000

/** Empreinte d'un échec : même test, même élément, même message = même empreinte sur toutes les pages. */
export function failureId(test: string, message: string, selector?: string): string {
  return createHash('sha1')
    .update(`${test}\n${selector ?? ''}\n${message}`)
    .digest('hex')
    .slice(0, 12)
}

/** Chemin relatif (dans le rapport) et absolu d'une capture. */
export function screenshotFile(
  outDir: string,
  folder: string,
  key: string,
): { relative: string; file: string } {
  const segment = assertSafeSegment(folder, 'Dossier de capture')
  return {
    relative: `preuves/${segment}/${key}.png`,
    file: containedPath(outDir, 'preuves', segment, `${key}.png`),
  }
}

/**
 * Capture la zone d'un élément, cadre rouge compris. Renvoie `false` si l'élément
 * est introuvable, masqué ou sans surface (la question ou l'échec reste alors sans image).
 *
 * L'élément est marqué d'un attribut le temps de la capture, puis démarqué :
 * les vérifications d'une page s'exécutent l'une après l'autre, aucune ne lit
 * la page pendant ce temps.
 */
export async function captureZone(page: Page, locator: Locator, file: string): Promise<boolean> {
  const handle = await locator
    .first()
    .elementHandle({ timeout: TIMEOUT_MS })
    .catch(() => null)
  if (!handle) return false
  try {
    await handle.scrollIntoViewIfNeeded({ timeout: TIMEOUT_MS }).catch(() => {})
    const box = await handle.boundingBox()
    const viewport = page.viewportSize()
    if (!box || !viewport || box.width < 1 || box.height < 1) return false
    const left = Math.max(0, Math.floor(box.x - MARGIN))
    const top = Math.max(0, Math.floor(box.y - MARGIN))
    const right = Math.min(viewport.width, Math.ceil(box.x + box.width + MARGIN))
    const bottom = Math.min(viewport.height, Math.ceil(box.y + box.height + MARGIN))
    if (right - left < 4 || bottom - top < 4) return false
    mkdirSync(dirname(file), { recursive: true })
    await handle.evaluate((el, mark) => el.setAttribute(mark, ''), MARK)
    try {
      await page.screenshot({
        path: file,
        clip: { x: left, y: top, width: right - left, height: bottom - top },
        style: HIGHLIGHT,
        timeout: TIMEOUT_MS,
      })
    } finally {
      await handle.evaluate((el, mark) => el.removeAttribute(mark), MARK).catch(() => {})
    }
    return true
  } catch {
    return false
  } finally {
    await handle.dispose().catch(() => {})
  }
}
