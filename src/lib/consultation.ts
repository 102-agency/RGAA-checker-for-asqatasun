import { UserError } from '../core/errors.ts'
import { resolvePageUrl } from '../security/url.ts'

/**
 * Lectures de fichiers pour la thématique 13 : GIF animés (13.8) et PDF balisés (13.3).
 * Tout téléchargement reste sur le site audité (`resolvePageUrl`), borné en taille et en durée.
 */

const TIMEOUT_MS = 10_000

async function download(base: URL, href: string, maxBytes: number): Promise<Uint8Array | null> {
  let url: URL
  try {
    url = resolvePageUrl(base, href)
  } catch (error) {
    if (error instanceof UserError) return null // autre site : on ne le contacte pas.
    throw error
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
    headers: { range: `bytes=0-${maxBytes - 1}` },
  }).catch(() => null)
  if (!response || !(response.ok || response.status === 206) || !response.body) return null
  // Lecture bornée : on s'arrête à `maxBytes` même si le serveur ignore l'en-tête Range.
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  while (total < maxBytes) {
    const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
    if (done || !value) break
    chunks.push(value)
    total += value.length
  }
  await reader.cancel().catch(() => {})
  const out = new Uint8Array(Math.min(total, maxBytes))
  let offset = 0
  for (const chunk of chunks) {
    const slice = chunk.subarray(0, Math.max(0, out.length - offset))
    out.set(slice, offset)
    offset += slice.length
  }
  return out
}

export interface GifInfo {
  frames: number
  /** Durée d'un tour, en millisecondes. */
  loopMs: number
  /** Nombre de tours : 0 = en boucle sans fin ; `null` : un seul passage. */
  loops: number | null
}

/** Nombre d'images, durée et boucle d'un GIF ; `null` si le fichier n'est pas un GIF lisible. */
export function parseGif(bytes: Uint8Array): GifInfo | null {
  const signature = String.fromCharCode(...bytes.subarray(0, 6))
  if (signature !== 'GIF87a' && signature !== 'GIF89a') return null
  let frames = 0
  let loopMs = 0
  let loops: number | null = null
  let position = 13
  const flags = bytes[10] ?? 0
  if (flags & 0x80) position += 3 * 2 ** ((flags & 0x07) + 1)
  while (position < bytes.length) {
    const block = bytes[position]
    if (block === 0x3b) break
    if (block === 0x21) {
      const label = bytes[position + 1]
      if (label === 0xf9) {
        loopMs += ((bytes[position + 4] ?? 0) | ((bytes[position + 5] ?? 0) << 8)) * 10
      } else if (label === 0xff && bytes[position + 2] === 11) {
        const application = String.fromCharCode(...bytes.subarray(position + 3, position + 14))
        if (application.startsWith('NETSCAPE') && bytes[position + 14] === 3) {
          loops = (bytes[position + 16] ?? 0) | ((bytes[position + 17] ?? 0) << 8)
        }
      }
      position += 2
      while (position < bytes.length && (bytes[position] ?? 0) > 0)
        position += (bytes[position] ?? 0) + 1
      position += 1
    } else if (block === 0x2c) {
      frames += 1
      const local = bytes[position + 9] ?? 0
      position += 10
      if (local & 0x80) position += 3 * 2 ** ((local & 0x07) + 1)
      position += 1 // taille minimale du code LZW
      while (position < bytes.length && (bytes[position] ?? 0) > 0)
        position += (bytes[position] ?? 0) + 1
      position += 1
    } else {
      return { frames, loopMs, loops }
    }
  }
  return { frames, loopMs, loops }
}

export async function gifInfo(base: URL, href: string): Promise<GifInfo | null> {
  const bytes = await download(base, href, 3 * 1024 * 1024)
  return bytes ? parseGif(bytes) : null
}

export type PdfTagging = 'balisé' | 'balisage non repéré' | 'non vérifié'

/**
 * Un PDF balisé contient une structure logique (`/StructTreeRoot`) : sans elle, aucun lecteur d'écran
 * ne peut le parcourir. Le catalogue peut se cacher dans un flux compressé : « balisage non repéré »
 * est un indice, pas une preuve.
 */
export async function pdfTagging(base: URL, href: string): Promise<PdfTagging> {
  const bytes = await download(base, href, 6 * 1024 * 1024)
  if (!bytes || String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') return 'non vérifié'
  const text = new TextDecoder('latin1').decode(bytes)
  return text.includes('/StructTreeRoot')
    ? 'balisé'
    : text.length >= 6 * 1024 * 1024
      ? 'non vérifié'
      : 'balisage non repéré'
}
