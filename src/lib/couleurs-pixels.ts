import { inflateSync } from 'node:zlib'

/**
 * Pixels et couleurs pour la thématique 3 (côté Node).
 *
 * Les captures d'écran de Chromium (PNG 8 bits) sont décodées ici, sans
 * dépendance : on échantillonne ensuite l'arrière-plan réellement peint derrière
 * chaque texte, que le CSS soit en oklab, en dégradé, sur une image ou sous une
 * transparence.
 */

export type Rgb = [number, number, number]
export type Rgba = [number, number, number, number]

export interface Bitmap {
  width: number
  height: number
  /** RGBA, 4 octets par pixel. */
  data: Uint8Array
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Décode un PNG non entrelacé, 8 bits, RGB ou RGBA (ce que produit Chromium). */
export function decodePng(buffer: Buffer): Bitmap {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (buffer[i] !== SIGNATURE[i]) throw new Error('Capture illisible : ce n’est pas un PNG')
  }
  let offset = 8
  let width = 0
  let height = 0
  let colorType = 6
  const chunks: Buffer[] = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]
      colorType = body[9] ?? 6
      if (depth !== 8 || body[12] !== 0)
        throw new Error('PNG non géré (profondeur ou entrelacement)')
      if (colorType !== 2 && colorType !== 6) throw new Error(`PNG non géré (type ${colorType})`)
    } else if (type === 'IDAT') {
      chunks.push(body)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  const channels = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(chunks))
  const stride = width * channels
  const out = new Uint8Array(width * height * 4)
  let previous = new Uint8Array(stride)
  let current = new Uint8Array(stride)
  let position = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[position++] ?? 0
    for (let x = 0; x < stride; x++) {
      const value = raw[position++] ?? 0
      const left = x >= channels ? (current[x - channels] ?? 0) : 0
      const up = previous[x] ?? 0
      const upLeft = x >= channels ? (previous[x - channels] ?? 0) : 0
      let result: number
      switch (filter) {
        case 0:
          result = value
          break
        case 1:
          result = value + left
          break
        case 2:
          result = value + up
          break
        case 3:
          result = value + ((left + up) >> 1)
          break
        default: {
          const estimate = left + up - upLeft
          const dl = Math.abs(estimate - left)
          const du = Math.abs(estimate - up)
          const dul = Math.abs(estimate - upLeft)
          result = value + (dl <= du && dl <= dul ? left : du <= dul ? up : upLeft)
        }
      }
      current[x] = result & 255
    }
    for (let x = 0; x < width; x++) {
      const target = (y * width + x) * 4
      out[target] = current[x * channels] ?? 0
      out[target + 1] = current[x * channels + 1] ?? 0
      out[target + 2] = current[x * channels + 2] ?? 0
      out[target + 3] = channels === 4 ? (current[x * channels + 3] ?? 255) : 255
    }
    const swap = previous
    previous = current
    current = swap
  }
  return { width, height, data: out }
}

// ─── Couleurs ───────────────────────────────────────────────────────────────

function channel(value: number): number {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Luminance relative WCAG d'une couleur sRGB. */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** Rapport de contraste WCAG entre deux couleurs opaques. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a[0], a[1], a[2])
  const lb = luminance(b[0], b[1], b[2])
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Superpose `front` (avec son alpha) sur un fond opaque. */
export function blend(front: Rgba, back: Rgb): Rgb {
  const alpha = front[3]
  return [
    Math.round(front[0] * alpha + back[0] * (1 - alpha)),
    Math.round(front[1] * alpha + back[1] * (1 - alpha)),
    Math.round(front[2] * alpha + back[2] * (1 - alpha)),
  ]
}

export function hex(color: readonly number[]): string {
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(color[i] ?? 0)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

/** Rapport affiché : une décimale, arrondi vers le bas (2,96 ne devient pas 3,0). */
export function ratioLabel(ratio: number): string {
  return (Math.floor(ratio * 10) / 10).toFixed(1).replace('.', ',')
}

// ─── Échantillonnage ────────────────────────────────────────────────────────

/** Boîte en pixels de la capture : `[x, y, largeur, hauteur]`. */
export type Box = [number, number, number, number]

/**
 * Couleurs (entières 0xRRGGBB) et effectifs des pixels de la capture dans la
 * boîte, avec un pas de grille qui borne le nombre d'échantillons.
 */
export function samplePixels(
  bitmap: Bitmap,
  box: Box,
  limit = 3000,
  into: Map<number, number> = new Map(),
): Map<number, number> {
  const x0 = Math.max(0, Math.floor(box[0]))
  const y0 = Math.max(0, Math.floor(box[1]))
  const x1 = Math.min(bitmap.width, Math.ceil(box[0] + box[2]))
  const y1 = Math.min(bitmap.height, Math.ceil(box[1] + box[3]))
  if (x1 <= x0 || y1 <= y0) return into
  const area = (x1 - x0) * (y1 - y0)
  const step = Math.max(1, Math.ceil(Math.sqrt(area / limit)))
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * bitmap.width + x) * 4
      const key =
        ((bitmap.data[i] ?? 0) << 16) | ((bitmap.data[i + 1] ?? 0) << 8) | (bitmap.data[i + 2] ?? 0)
      into.set(key, (into.get(key) ?? 0) + 1)
    }
  }
  return into
}

export function unpack(key: number): Rgb {
  return [(key >> 16) & 255, (key >> 8) & 255, key & 255]
}

/** Part des pixels écartés comme non significatifs (aliasing, bord d'un élément voisin). */
export const SIGNIFICANCE = 0.03

export interface Worst {
  ratio: number
  /** Couleur du fond au pire pixel significatif. */
  background: Rgb
  /** Couleur du texte tel qu'il est peint sur ce fond. */
  foreground: Rgb
  /** Nombre de couleurs de fond distinctes sous le texte (1 = fond uni). */
  backgrounds: number
}

/**
 * Pire contraste d'un texte de couleur `text` (alpha compris) sur les pixels
 * échantillonnés, en ignorant les 3 % de pixels les plus défavorables : un
 * grain isolé d'une photo n'est pas « l'arrière-plan du texte ».
 */
export function worstContrast(text: Rgba, pixels: Map<number, number>): Worst | null {
  const rows: { ratio: number; key: number; count: number }[] = []
  let total = 0
  for (const [key, count] of pixels) {
    const background = unpack(key)
    rows.push({ ratio: contrast(blend(text, background), background), key, count })
    total += count
  }
  if (total === 0) return null
  rows.sort((a, b) => a.ratio - b.ratio)
  const ignored = Math.floor(total * SIGNIFICANCE)
  let seen = 0
  for (const row of rows) {
    seen += row.count
    if (seen > ignored) {
      const background = unpack(row.key)
      return {
        ratio: row.ratio,
        background,
        foreground: blend(text, background),
        backgrounds: rows.length,
      }
    }
  }
  return null
}

/** Nombre de couleurs distinctes (quantifiées sur 5 bits) : une photographie en compte des centaines. */
export function colorDiversity(pixels: Map<number, number>): number {
  const bins = new Set<number>()
  for (const key of pixels.keys()) {
    const [r, g, b] = unpack(key)
    bins.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3))
  }
  return bins.size
}
