import { inflateSync } from 'node:zlib'

/**
 * Décodage minimal de PNG (8 bits, non entrelacé, RGB ou RGBA) : suffisant
 * pour comparer deux captures d'écran de Playwright, sans dépendance.
 */
export interface Pixels {
  width: number
  height: number
  /** RGBA, 4 octets par pixel. */
  data: Uint8Array
}

export function decodePng(buffer: Buffer): Pixels {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('Ce n’est pas un PNG')
  let offset = 8
  let width = 0
  let height = 0
  let channels = 4
  const idat: Buffer[] = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      const depth = body[8]
      const colorType = body[9]
      const interlace = body[12]
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        throw new Error(`PNG non pris en charge (profondeur ${depth}, type ${colorType})`)
      }
      channels = colorType === 6 ? 4 : 3
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = new Uint8Array(width * height * 4)
  let previous = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = new Uint8Array(stride)
    const start = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const value = raw[start + x] ?? 0
      const left = x >= channels ? (line[x - channels] ?? 0) : 0
      const up = previous[x] ?? 0
      const upLeft = x >= channels ? (previous[x - channels] ?? 0) : 0
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = up
      else if (filter === 3) predicted = (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      }
      line[x] = (value + predicted) & 0xff
    }
    for (let x = 0; x < width; x++) {
      const from = x * channels
      const to = (y * width + x) * 4
      out[to] = line[from] ?? 0
      out[to + 1] = line[from + 1] ?? 0
      out[to + 2] = line[from + 2] ?? 0
      out[to + 3] = channels === 4 ? (line[from + 3] ?? 255) : 255
    }
    previous = line
  }
  return { width, height, data: out }
}

function channel(value: number): number {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

export interface Difference {
  pixels: number
  /** Pixels qui diffèrent d'au moins une unité visible. */
  changed: number
  /** Pixels dont l'ancien et le nouveau rendu contrastent au moins 3:1. */
  strong: number
  /** Meilleur contraste entre un pixel avant et après. */
  maxContrast: number
}

/**
 * Compare le rendu d'une zone sans focus (`before`) et avec (`after`) : combien
 * de pixels changent, et combien changent assez (3:1) pour qu'on les distingue.
 * `again` : seconde capture sans focus, pour ignorer ce qui change sans le focus.
 */
export function compareCaptures(before: Pixels, after: Pixels, again?: Pixels): Difference {
  if (before.width !== after.width || before.height !== after.height) {
    // Zone de taille différente : le focus a changé la mise en page.
    return {
      pixels: after.width * after.height,
      changed: after.width * after.height,
      strong: after.width * after.height,
      maxContrast: 21,
    }
  }
  let changed = 0
  let strong = 0
  let maxContrast = 1
  for (let i = 0; i < before.data.length; i += 4) {
    const dr = Math.abs((before.data[i] ?? 0) - (after.data[i] ?? 0))
    const dg = Math.abs((before.data[i + 1] ?? 0) - (after.data[i + 1] ?? 0))
    const db = Math.abs((before.data[i + 2] ?? 0) - (after.data[i + 2] ?? 0))
    if (dr + dg + db < 12) continue
    // Zone qui bouge toute seule (animation, vidéo) : une seconde capture sans focus la trahit.
    if (
      again &&
      again.data.length === before.data.length &&
      Math.abs((again.data[i] ?? 0) - (before.data[i] ?? 0)) +
        Math.abs((again.data[i + 1] ?? 0) - (before.data[i + 1] ?? 0)) +
        Math.abs((again.data[i + 2] ?? 0) - (before.data[i + 2] ?? 0)) >=
        12
    ) {
      continue
    }
    changed += 1
    const l1 = luminance(before.data[i] ?? 0, before.data[i + 1] ?? 0, before.data[i + 2] ?? 0)
    const l2 = luminance(after.data[i] ?? 0, after.data[i + 1] ?? 0, after.data[i + 2] ?? 0)
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    if (ratio >= 3) strong += 1
    if (ratio > maxContrast) maxContrast = ratio
  }
  return { pixels: before.width * before.height, changed, strong, maxContrast }
}
