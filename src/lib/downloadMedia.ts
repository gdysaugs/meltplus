type SaveGeneratedAssetOptions = {
  source: string
  filenamePrefix: string
  fallbackExtension: string
}

type PrepareGeneratedAssetOptions = {
  source: string
  fallbackExtension: string
}

export type PreparedGeneratedAsset = {
  url: string
  extension: string
  release: () => void
}

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
}

const sanitizeFilenamePart = (value: string) => {
  const cleaned = value.trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
  return cleaned || 'asset'
}

const getExtensionFromMime = (mimeType: string) => {
  const normalized = mimeType.trim().toLowerCase()
  return MIME_EXTENSION_MAP[normalized] ?? null
}

const getExtensionFromSource = (source: string) => {
  const dataUrlMatch = source.match(/^data:([^;,]+)[;,]/i)
  if (dataUrlMatch) {
    return getExtensionFromMime(dataUrlMatch[1]) ?? null
  }

  try {
    const url = new URL(source)
    const pathname = url.pathname.toLowerCase()
    const ext = pathname.split('.').pop()
    if (ext && ext.length <= 5) return ext
  } catch {
    const cleaned = source.split('#')[0].split('?')[0].toLowerCase()
    const ext = cleaned.split('.').pop()
    if (ext && ext.length <= 5) return ext
  }

  return null
}

const triggerDownload = (href: string, filename: string) => {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.download = filename
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

const dataUrlToBlob = (source: string) => {
  const commaIndex = source.indexOf(',')
  if (commaIndex === -1) throw new Error('invalid_data_url')

  const header = source.slice(0, commaIndex)
  const payload = source.slice(commaIndex + 1)
  const mimeType = header.match(/^data:([^;,]+)/i)?.[1] || 'application/octet-stream'
  if (!/;base64(?:;|$)/i.test(header)) {
    return new Blob([decodeURIComponent(payload)], { type: mimeType })
  }

  const chunks: ArrayBuffer[] = []
  const chunkSize = 4 * 1024 * 1024
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    const binary = atob(payload.slice(offset, offset + chunkSize))
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    chunks.push(bytes.buffer)
  }
  return new Blob(chunks, { type: mimeType })
}

const createPreparedBlob = (blob: Blob, fallbackExtension: string): PreparedGeneratedAsset => {
  const url = URL.createObjectURL(blob)
  let released = false
  return {
    url,
    extension: getExtensionFromMime(blob.type) ?? fallbackExtension.toLowerCase(),
    release: () => {
      if (released) return
      released = true
      URL.revokeObjectURL(url)
    },
  }
}

export const prepareGeneratedAsset = async ({
  source,
  fallbackExtension,
}: PrepareGeneratedAssetOptions): Promise<PreparedGeneratedAsset> => {
  const extension = getExtensionFromSource(source) ?? fallbackExtension.toLowerCase()

  if (source.startsWith('data:')) {
    return createPreparedBlob(dataUrlToBlob(source), extension)
  }

  if (source.startsWith('blob:')) {
    return { url: source, extension, release: () => undefined }
  }

  try {
    const response = await fetch(source)
    if (!response.ok) throw new Error('fetch_failed')
    return createPreparedBlob(await response.blob(), extension)
  } catch {
    return { url: source, extension, release: () => undefined }
  }
}

export const saveGeneratedAsset = ({ source, filenamePrefix, fallbackExtension }: SaveGeneratedAssetOptions) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const baseName = sanitizeFilenamePart(filenamePrefix) + '-' + timestamp
  const extension = getExtensionFromSource(source) ?? fallbackExtension.toLowerCase()
  triggerDownload(source, baseName + '.' + extension)
}
