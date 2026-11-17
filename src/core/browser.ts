import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { type Browser, type BrowserContext, chromium, type Page, type Response } from 'playwright'
import { UserError } from './errors.ts'
import { ASSETS } from './paths.ts'
import type { PageOptions } from './types.ts'

const require = createRequire(import.meta.url)
const AXE_SOURCE = require.resolve('axe-core/axe.min.js')

export const DEFAULT_VIEWPORT = { width: 1280, height: 900 }
const NAVIGATION_TIMEOUT_MS = 60_000

export interface LaunchOptions {
  /**
   * Bac à sable de Chromium (activé par défaut). Les pages auditées sont du
   * contenu tiers : le bac à sable isole leurs processus du système. À ne
   * désactiver que dans un conteneur qui n'autorise pas les espaces de noms.
   */
  sandbox?: boolean
  /** Dossier de bibliothèques système à ajouter au `LD_LIBRARY_PATH` du navigateur. */
  libraries?: string
}

/**
 * Variables d'environnement transmises au navigateur : le strict nécessaire
 * (affichage, langue, polices, fichiers temporaires). Les jetons, mots de passe
 * et autres secrets de l'environnement de l'utilisateur ne le traversent pas.
 */
const BROWSER_ENV =
  /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z]+|TZ|TMPDIR|TEMP|TMP|DISPLAY|WAYLAND_DISPLAY|XDG_[A-Z_]+|FONTCONFIG_[A-Z_]+|LD_LIBRARY_PATH|SYSTEMROOT|WINDIR|LOCALAPPDATA|APPDATA|PROGRAMFILES|USERPROFILE)$/

export function browserEnvironment(
  source: NodeJS.ProcessEnv,
  libraries?: string,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && BROWSER_ENV.test(name)) env[name] = value
  }
  if (libraries) {
    env.LD_LIBRARY_PATH = [libraries, env.LD_LIBRARY_PATH].filter(Boolean).join(':')
  }
  return env
}

function checkLibraries(libraries: string): string {
  if (!isAbsolute(libraries) || libraries.includes(':')) {
    throw new UserError(`Dossier de bibliothèques invalide : ${libraries} (chemin absolu attendu).`)
  }
  if (!existsSync(libraries) || !statSync(libraries).isDirectory()) {
    throw new UserError(`Dossier de bibliothèques introuvable : ${libraries}`)
  }
  return libraries
}

/**
 * Lance Chromium (celui de Playwright : `pnpm browser:install`).
 *
 * Sur une machine sans droits root où il manque des bibliothèques système
 * (libnspr4, libnss3…), on peut les extraire dans un dossier utilisateur et
 * l'indiquer par `--browser-libs` ou `RGAA_BROWSER_LIBS`.
 */
export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  const libraries = options.libraries ? checkLibraries(options.libraries) : undefined
  try {
    return await chromium.launch({
      env: browserEnvironment(process.env, libraries),
      chromiumSandbox: options.sandbox ?? true,
      // /dev/shm est minuscule sous WSL et en conteneur : sans ce drapeau, Chromium
      // plante (« Target crashed ») dès que plusieurs pages sont ouvertes.
      args: ['--disable-dev-shm-usage', '--disable-gpu'],
    })
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    const hints: string[] = []
    if (/Executable doesn't exist|browserType\.launch: .*not found/i.test(text)) {
      hints.push('Installer Chromium : pnpm browser:install (ou npx playwright install chromium).')
    }
    const missing = /error while loading shared libraries: (\S+)/.exec(text)?.[1]
    if (missing) {
      hints.push(
        `Bibliothèque système manquante (${missing}) : l'installer, ou l'extraire dans un dossier et le passer par --browser-libs.`,
      )
    }
    if (/sandbox|namespace|setuid/i.test(text)) {
      hints.push(
        'Le bac à sable de Chromium ne peut pas démarrer ici. En conteneur seulement : --no-sandbox.',
      )
    }
    throw new UserError(
      `Chromium ne démarre pas.${hints.length ? `\n  ${hints.join('\n  ')}` : `\n  ${text.split('\n')[0]}`}`,
    )
  }
}

/** Contexte de navigation prêt pour l'audit : français, axe-core et `window.__rgaa` injectés. */
export async function newContext(
  browser: Browser,
  options: PageOptions = {},
): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: options.viewport ?? DEFAULT_VIEWPORT,
    locale: 'fr-FR',
    colorScheme: options.colorScheme ?? 'light',
    reducedMotion: options.reducedMotion ?? 'no-preference',
    javaScriptEnabled: options.javaScriptEnabled ?? true,
    // Durcissement : la page auditée ne télécharge rien, n'installe pas de service
    // worker, n'obtient aucune permission et ne contourne pas sa propre CSP.
    acceptDownloads: false,
    serviceWorkers: 'block',
    permissions: [],
    bypassCSP: false,
    ignoreHTTPSErrors: false,
  })
  context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS)
  await context.addInitScript({ path: AXE_SOURCE })
  await context.addInitScript({ path: ASSETS.helpers })
  // L'indicateur de développement de Next.js (`<nextjs-portal>`) n'existe pas en
  // production : on le retire pour ne pas auditer l'outillage.
  await context.addInitScript(() => {
    const strip = () => {
      for (const portal of document.querySelectorAll('nextjs-portal')) portal.remove()
    }
    new MutationObserver(strip).observe(document, { childList: true, subtree: true })
  })
  // Une boîte de dialogue (alert, confirm, beforeunload) bloquerait la page : on la ferme.
  context.on('page', (page) => {
    page.on('dialog', (dialog) => {
      dialog.dismiss().catch(() => {})
    })
  })
  return context
}

/**
 * Charge l'URL et attend que la page soit stable : réseau calme, polices
 * chargées, puis un aller-retour de défilement pour déclencher les contenus
 * différés (images `loading="lazy"`, sections chargées à l'approche).
 */
export async function openPage(
  context: BrowserContext,
  url: string,
  options: { scripts?: boolean } = {},
): Promise<{ page: Page; response: Response | null }> {
  const page = await context.newPage()
  const response = await page.goto(url, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS })
  await settle(page, options.scripts ?? true)
  return { page, response }
}

/**
 * `scripts: false` : JavaScript est désactivé dans le contexte. Les minuteries de la page ne
 * tournent plus (un `setTimeout` n'aboutit jamais) : le parcours de défilement est alors omis.
 */
export async function settle(page: Page, scripts = true): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {})
  if (!scripts) {
    await page.waitForTimeout(150)
    return
  }
  await page.evaluate(async () => {
    await document.fonts.ready
    const step = Math.max(200, window.innerHeight - 100)
    // Plafond : une page à défilement infini ne bloque pas l'audit.
    const limit = Math.min(document.documentElement.scrollHeight, 60_000)
    for (let y = 0; y < limit; y += step) {
      window.scrollTo(0, y)
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    window.scrollTo(0, 0)
  })
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
  await page.waitForTimeout(150)
}
