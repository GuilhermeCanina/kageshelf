import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Confidence, PreviewRow, RowStatus, ScanResult, SubtitleFileInfo } from '../shared/types'
import { revalidatePreview } from '../shared/previewMetadata'

export const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.webm', '.avi', '.mov', '.m4v', '.ts', '.m2ts'])
export const SUBTITLE_EXTENSIONS = new Set(['.ass', '.ssa', '.srt', '.vtt', '.sub'])
const SEASON_FOLDER_PATTERNS = [
  /^season\s*0*(\d{1,2})$/i,
  /^temporada\s*0*(\d{1,2})$/i,
  /^s\s*0*(\d{1,2})$/i
]


interface EpisodeCandidate {
  episode: number
  season?: number
  score: number
  confidence: Confidence
  method: string
}

interface ParsedEpisode {
  status: 'identified' | 'review' | 'ambiguous'
  episode: number | null
  season: number | null
  confidence: Confidence | null
  method: string
  note: string
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function normalizePathForCompare(value: string): string {
  const resolved = path.resolve(value)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

export function assertSafeSourceAndDestination(sourcePath: string, destinationPath: string): void {
  const sourceSegments = path.resolve(sourcePath).split(path.sep).filter(Boolean)
  if (sourceSegments.some((segment) => /\[jellyfin\]$/i.test(segment))) {
    throw new Error('A origem parece estar dentro de uma pasta [Jellyfin]. Selecione a biblioteca bruta, não a saída já organizada.')
  }

  const sourceCompare = normalizePathForCompare(sourcePath)
  const destinationCompare = normalizePathForCompare(destinationPath)
  if (sourceCompare === destinationCompare) {
    throw new Error('A origem e o destino não podem ser a mesma pasta.')
  }
  if (isPathInside(sourceCompare, destinationCompare)) {
    throw new Error('O destino não pode ficar dentro da pasta de origem.')
  }
  if (isPathInside(destinationCompare, sourceCompare)) {
    throw new Error('A origem está dentro do destino. Escolha uma pasta de destino separada.')
  }
}

/**
 * Resolve roots through existing filesystem components before checking overlap.
 * This prevents lexical paths that use symlink aliases from hiding a physical
 * source/destination overlap. Missing destination components are appended to
 * the real path of the nearest existing ancestor.
 */
async function resolvePhysicalProspectivePath(inputPath: string): Promise<string> {
  const absolute = path.resolve(inputPath)
  let current = absolute
  const missingComponents: string[] = []

  while (true) {
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      info = null
    }

    if (info) {
      if (info.isSymbolicLink()) throw new Error(`Links simbólicos não são permitidos nas raízes de organização: ${current}`)
      if (missingComponents.length > 0 && !info.isDirectory()) {
        throw new Error(`O ancestral existente não é uma pasta: ${current}`)
      }
      const physical = await realpath(current)
      return path.resolve(physical, ...missingComponents.reverse())
    }

    const parent = path.dirname(current)
    if (parent === current) throw new Error(`Não foi possível resolver o caminho: ${inputPath}`)
    missingComponents.push(path.basename(current))
    current = parent
  }
}

export async function assertSafeSourceAndDestinationPhysical(sourcePath: string, destinationPath: string): Promise<void> {
  const sourceAbsolute = path.resolve(sourcePath)
  const destinationAbsolute = path.resolve(destinationPath)
  const sourceInfo = await lstat(sourceAbsolute)
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error(`A origem não é uma pasta segura: ${sourceAbsolute}`)
  }
  const destinationInfo = await lstat(destinationAbsolute).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (destinationInfo && (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink())) {
    throw new Error(`O destino não é uma pasta segura: ${destinationAbsolute}`)
  }

  const physicalSource = await realpath(sourceAbsolute)
  const physicalDestination = await resolvePhysicalProspectivePath(destinationAbsolute)
  assertSafeSourceAndDestination(physicalSource, physicalDestination)
}

function cleanSeriesName(folderName: string): string {
  return folderName
    .replace(/\s*\(\d{4}\)\s*$/, '')
    .replace(/\s*\[Jellyfin\]\s*$/i, '')
    .trim() || folderName.trim()
}

function seasonCandidatesFromPath(filePath: string, sourcePath: string): number[] {
  const relativeDirectory = path.relative(sourcePath, path.dirname(filePath))
  const segments = relativeDirectory ? relativeDirectory.split(path.sep) : []
  const seasons: number[] = []

  for (const segment of segments) {
    for (const pattern of SEASON_FOLDER_PATTERNS) {
      const match = segment.match(pattern)
      if (match) {
        const value = Number(match[1])
        if (value >= 1 && value <= 99) seasons.push(value)
      }
      // The legacy organizer accepts folders such as "Season 02 OVA" as
      // special folders associated with a parent season, not ordinary seasons.
      const specialSeason = segment.match(/^season\s*0*(\d{1,2})\s*[-_ ]+(?:ova|oav|special|especial|sp|extra)s?$/i)
        ?? segment.match(/^temporada\s*0*(\d{1,2})\s*[-_ ]+(?:ova|oav|special|especial|sp|extra)s?$/i)
      if (specialSeason) {
        const value = Number(specialSeason[1])
        if (value >= 1 && value <= 99) seasons.push(value)
      }
    }
  }

  return unique(seasons)
}

function detectSeasonFromPath(filePath: string, sourcePath: string): number | null {
  const seasons = seasonCandidatesFromPath(filePath, sourcePath)
  return seasons.length === 1 ? seasons[0] : null
}

const SPECIAL_MARKER = /(?:^|[\s._\-\[\]()])(?<kind>OVA|OAV|SPECIAL|ESPECIAL|SP|EXTRA)(?:S)?(?=$|[\s._\-\[\]()])/gi
const SPECIAL_NUMBER_PATTERNS = [
  /\b(?:OVA|OAV|SPECIAL|ESPECIAL|SP|EXTRA)S?\s*[-_.#:]*\s*0*(\d{1,3})\b/gi,
  /(?:^|[\s._-])0*(\d{1,3})\s*(?:OVA|OAV|SPECIAL|ESPECIAL|SP|EXTRA)S?\b/gi
]

function canonicalSpecialKind(value: string): string {
  const lower = value.toLowerCase()
  if (lower.startsWith('ova')) return 'OVA'
  if (lower.startsWith('oav')) return 'OAV'
  if (lower.startsWith('sp')) return 'SP'
  if (lower.startsWith('extra')) return 'Extra'
  return 'Special'
}

function specialKindFromPath(filePath: string, sourcePath: string): string | null {
  const relativeDirectory = path.relative(sourcePath, path.dirname(filePath))
  const segments = relativeDirectory ? relativeDirectory.split(path.sep) : []
  for (const segment of segments) {
    const match = segment.match(/^\s*(OVAs?|OAVs?|Specials?|Especiais?|SPs?|Extras?)\s*$/i)
    if (match) return canonicalSpecialKind(match[1])
    const seasonSpecial = segment.match(/^\s*(?:Season|Temporada)\s*0*\d{1,2}\s*[-_ ]+((?:OVAs?|OAVs?|Specials?|Especiais?|SPs?|Extras?))\s*$/i)
    if (seasonSpecial) return canonicalSpecialKind(seasonSpecial[1])
  }
  return null
}

interface SpecialDetection {
  kind: string
  number: number | null
  confidence: Confidence | null
  ambiguous: boolean
  label: string | null
  note: string
}

function detectSpecial(baseName: string, filePath: string, sourcePath: string, parsed: ParsedEpisode): SpecialDetection | null {
  const pathKind = specialKindFromPath(filePath, sourcePath)
  const markers = [...baseName.matchAll(SPECIAL_MARKER)].map((match) => canonicalSpecialKind(match.groups?.kind ?? match[1]))
  const numbers: number[] = []
  const numberedKinds: string[] = []
  for (const pattern of SPECIAL_NUMBER_PATTERNS) {
    for (const match of baseName.matchAll(pattern)) {
      const number = Number(match[1])
      if (Number.isInteger(number) && number >= 1 && number <= 999) {
        numbers.push(number)
        const markerMatch = match[0].match(/OVA|OAV|ESPECIAL|SPECIAL|EXTRA|SP/i)
        if (markerMatch) numberedKinds.push(canonicalSpecialKind(markerMatch[0]))
      }
    }
  }
  const distinctNumbers = unique(numbers)
  // A title can legitimately contain words like "Special" (for example,
  // "Specials A"). Only markers tied to a special number should influence
  // filename classification; an explicit special folder remains authoritative.
  if (!pathKind && markers.length > 0 && distinctNumbers.length === 0) return null
  const kinds = unique([...(pathKind ? [pathKind] : []), ...numberedKinds])
  if (kinds.length === 0) return null
  if (distinctNumbers.length > 1 || kinds.length > 1) {
    return {
      kind: kinds[0] ?? 'Special', number: null, confidence: null, ambiguous: true, label: null,
      note: `O nome/pasta contém marcadores de especial conflitantes${distinctNumbers.length > 1 ? ` (números ${distinctNumbers.join(', ')})` : ''}. Revise manualmente.`
    }
  }

  const kind = kinds[0]
  const explicitSpecialNumber = distinctNumbers[0] ?? null
  const number = explicitSpecialNumber ?? (parsed.status === 'identified' ? parsed.episode : null)
  if (number === null && parsed.status === 'ambiguous') {
    return { kind, number: null, confidence: null, ambiguous: true, label: null, note: `O especial ${kind} contém identificação de episódio ambígua: ${parsed.note}` }
  }
  if (number === null) {
    return { kind, number: null, confidence: null, ambiguous: false, label: kind, note: `Marcador ${kind} encontrado, mas o número do especial não pôde ser identificado com segurança.` }
  }
  const label = `${kind} ${String(number).padStart(2, '0')}`
  const confidence: Confidence | null = explicitSpecialNumber !== null ? 'média' : parsed.confidence
  return { kind, number, confidence, ambiguous: false, label, note: `Especial ${label} identificado por marcador de nome/pasta.` }
}

function looksLikeMovie(baseName: string): boolean {
  return /(?:^|[\s._\-\[\]()])(?:the\s+movie|movie\s+edition|movie|film|filme|gekijouban|gekijōban|劇場版)(?=$|[\s._\-\[\]()])/i.test(baseName)
}

function addNumericCandidate(candidates: EpisodeCandidate[], match: RegExpMatchArray, score: number, method: string): void {
  const episode = Number(match[1])
  if (Number.isInteger(episode) && episode >= 1 && episode <= 999) {
    candidates.push({ episode, score, confidence: score >= 3 ? 'alta' : score === 2 ? 'média' : 'baixa', method })
  }
}

export function parseEpisodeName(baseName: string): ParsedEpisode {
  const explicit: EpisodeCandidate[] = []
  const seasonEpisodeRegex = /\bS(\d{1,2})E(\d{1,3})\b/gi
  for (const match of baseName.matchAll(seasonEpisodeRegex)) {
    const season = Number(match[1])
    const episode = Number(match[2])
    if (season >= 1 && season <= 99 && episode >= 1 && episode <= 999) {
      explicit.push({ season, episode, score: 4, confidence: 'alta', method: 'Padrão SxxExx' })
    }
  }

  if (explicit.length > 0) {
    const keys = unique(explicit.map((candidate) => `${candidate.season}:${candidate.episode}`))
    if (keys.length > 1) {
      return { status: 'ambiguous', episode: null, season: null, confidence: null, method: 'SxxExx conflitantes', note: 'O nome contém mais de uma identificação explícita de temporada/episódio.' }
    }
    const best = explicit[0]
    return { status: 'identified', episode: best.episode, season: best.season ?? null, confidence: 'alta', method: best.method, note: 'Identificação explícita no nome.' }
  }

  const candidates: EpisodeCandidate[] = []
  const highPatterns: Array<[RegExp, string]> = [
    [/\b(?:EPISODIO|EPISÓDIO|EPISODE)\s*[-_. ]*(\d{1,3})\b/gi, 'Marcador Episode'],
    [/\bEP\s*[-_. ]*(\d{1,3})\b/gi, 'Marcador EP']
  ]

  for (const [pattern, method] of highPatterns) {
    for (const match of baseName.matchAll(pattern)) {
      addNumericCandidate(candidates, match, 3, method)
    }
  }

  // Some fansub releases put a marker after the episode, e.g. 12_Final.
  const markedPattern = /(?:^|[\s._-])(\d{1,3})(?=[\s._-]*(?:final|end|last|complete)(?:[\s._-]*(?:\[|$)))/gi
  for (const match of baseName.matchAll(markedPattern)) addNumericCandidate(candidates, match, 2, 'Número seguido de Final/End/Last/Complete')

  // A separator-number directly before a release block, e.g. Anime_-_01_[1080p].
  const separatedBeforeBlock = /[-_]\s*(\d{1,3})(?=[\s._-]*(?:\[|$))/g
  for (const match of baseName.matchAll(separatedBeforeBlock)) addNumericCandidate(candidates, match, 2, 'Número após separador, antes do bloco técnico')

  // Number immediately before a bracketed release tag.
  const numberBeforeBlock = /(?:^|[\s._-])(\d{1,3})(?=[\s._-]*\[)/g
  for (const match of baseName.matchAll(numberBeforeBlock)) addNumericCandidate(candidates, match, 2, 'Número antes de bloco técnico')

  // Low-confidence fallback only when the number is truly at the end.
  const genericTrailingNumber = /(?:^|[\s._-])(\d{1,3})$/g
  for (const match of baseName.matchAll(genericTrailingNumber)) addNumericCandidate(candidates, match, 1, 'Número genérico no final do nome')

  if (candidates.length === 0) {
    return { status: 'review', episode: null, season: null, confidence: null, method: 'Não identificado', note: 'Não encontrei um padrão de episódio reconhecível.' }
  }

  const highestScore = Math.max(...candidates.map((candidate) => candidate.score))
  const best = candidates.filter((candidate) => candidate.score === highestScore)
  const distinctEpisodes = unique(best.map((candidate) => candidate.episode))
  if (distinctEpisodes.length > 1) {
    return { status: 'ambiguous', episode: null, season: null, confidence: null, method: 'Candidatos conflitantes', note: `O nome contém possíveis episódios ${distinctEpisodes.join(', ')} com a mesma prioridade.` }
  }

  const chosen = best[0]
  return {
    status: 'identified',
    episode: chosen.episode,
    season: chosen.season ?? null,
    confidence: chosen.confidence,
    method: chosen.method,
    note: chosen.score === 1 ? 'Identificação de baixa confiança; revisar antes de qualquer organização.' : 'Identificação baseada no padrão do nome.'
  }
}

async function listFilesRecursively(root: string, warnings: string[]): Promise<string[]> {
  const files: string[] = []
  const pending = [root]

  while (pending.length > 0) {
    const current = pending.pop()!
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warnings.push(`Não foi possível ler "${current}": ${message}`)
      continue
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue // Never follow links in the first prototype.
      if (entry.isDirectory()) pending.push(fullPath)
      else if (entry.isFile()) files.push(fullPath)
    }
  }

  return files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
}

export async function scanLibrary(sourceInput: string, destinationInput = ''): Promise<ScanResult> {
  const startedAt = Date.now()
  if (!sourceInput.trim()) throw new Error('Selecione uma pasta de origem primeiro.')

  const sourcePath = path.resolve(sourceInput.trim())
  const sourceStat = await lstat(sourcePath).catch(() => null)
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('A pasta de origem não existe ou não pode ser acessada.')

  const sourceFolderName = path.basename(sourcePath)
  const destinationPath = path.resolve(destinationInput.trim() || path.join(path.dirname(sourcePath), `${sourceFolderName} [Jellyfin]`))
  await assertSafeSourceAndDestinationPhysical(sourcePath, destinationPath)

  const warnings: string[] = []
  const allFiles = await listFilesRecursively(sourcePath, warnings)
  const videoFiles = allFiles.filter((file) => VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase()))
  const subtitleFilePaths = allFiles.filter((file) => SUBTITLE_EXTENSIONS.has(path.extname(file).toLowerCase()))
  const subtitleFiles: SubtitleFileInfo[] = []
  for (const filePath of subtitleFilePaths) {
    const fileStat = await stat(filePath)
    subtitleFiles.push({
      relativePath: path.relative(sourcePath, filePath),
      originalName: path.basename(filePath),
      extension: path.extname(filePath).toLowerCase(),
      sizeBytes: fileStat.size,
      modifiedAtMs: Math.trunc(fileStat.mtimeMs)
    })
  }

  if (videoFiles.length === 0) {
    throw new Error('Nenhum vídeo compatível foi encontrado. Formatos suportados: MKV, MP4, WEBM, AVI, MOV, M4V, TS e M2TS.')
  }

  const seriesName = cleanSeriesName(sourceFolderName)
  const rows: PreviewRow[] = []

  for (const filePath of videoFiles) {
    const fileStat = await stat(filePath)
    const extension = path.extname(filePath)
    const baseName = path.basename(filePath, extension)
    const relativePath = path.relative(sourcePath, filePath)
    const parsed = parseEpisodeName(baseName)
    const folderSeasons = seasonCandidatesFromPath(filePath, sourcePath)
    const folderSeason = folderSeasons.length === 1 ? folderSeasons[0] : null
    const special = detectSpecial(baseName, filePath, sourcePath, parsed)
    const hasExplicitEpisodeMarker = /\bS\d{1,2}E\d{1,3}\b|\b(?:EP|EPISODE|EPISÓDIO)\s*[-_. ]*\d{1,3}\b/i.test(baseName)
    const movieHint = !special && looksLikeMovie(baseName) && !hasExplicitEpisodeMarker
    let contentKind: PreviewRow['contentKind'] = 'episode'
    let specialLabel: string | null = null
    let season: number | null = parsed.season ?? folderSeason ?? 1
    let episode: number | null = parsed.status === 'identified' ? parsed.episode : null
    let status: RowStatus = parsed.status
    let method = parsed.method
    let confidence = parsed.confidence
    let statusLabel = parsed.status === 'identified' ? 'Identificado' : parsed.status === 'ambiguous' ? 'Ambíguo' : 'Revisar'
    let note = parsed.note
    let outputRelativePath: string | null = null

    const seasonConflict = special
      ? folderSeasons.length > 1
      : !movieHint && (folderSeasons.length > 1 || (parsed.season !== null && folderSeason !== null && parsed.season !== folderSeason))
    if (seasonConflict) {
      status = 'ambiguous'
      season = null
      episode = null
      confidence = null
      method = 'Temporadas conflitantes'
      statusLabel = 'Ambíguo'
      note = `Foram detectadas temporadas incompatíveis${folderSeasons.length ? ` (${folderSeasons.join(', ')})` : ''}${parsed.season !== null ? ` e S${String(parsed.season).padStart(2, '0')} no nome` : ''}. Revise manualmente.`
    } else if (special) {
      contentKind = 'special'
      season = 0
      specialLabel = special.label
      method = `Marcador de especial (${special.kind})`
      if (special.ambiguous) {
        status = 'ambiguous'
        episode = null
        confidence = null
        statusLabel = 'Ambíguo'
        note = special.note
      } else if (special.number === null) {
        status = 'review'
        episode = null
        confidence = null
        statusLabel = 'Revisar'
        note = special.note
      } else if (special.confidence === 'baixa') {
        episode = special.number
        confidence = 'baixa'
        status = 'review'
        statusLabel = 'Revisar especial'
        note = `${special.note} A numeração extraída tem baixa confiança; confirme manualmente.`
      } else {
        episode = special.number
        confidence = special.confidence ?? 'média'
        status = 'identified'
        statusLabel = 'Especial identificado'
        note = special.note
      }
    } else if (movieHint) {
      contentKind = 'movie'
      season = null
      episode = null
      status = 'review'
      statusLabel = 'Confirmar filme'
      confidence = null
      method = 'Marcador provável de filme'
      note = 'O nome sugere um filme. Confirme manualmente o tipo de conteúdo antes de gerar o caminho final.'
    } else {
      if (parsed.status === 'identified' && parsed.episode !== null) {
        if (parsed.confidence === 'baixa') {
          status = 'review'
          statusLabel = 'Revisar'
        }
      }
      if (folderSeasons.length > 1) {
        status = 'ambiguous'
        season = null
        episode = null
        confidence = null
        statusLabel = 'Ambíguo'
        note = `Mais de uma temporada foi detectada no caminho: ${folderSeasons.join(', ')}.`
      }
    }

    const detectedNote = contentKind === 'special' || contentKind === 'movie'
      ? note
      : folderSeason === null && parsed.season === null
        ? `${note} Temporada 1 foi presumida por estar fora de uma pasta Season/Temporada.`
        : note

    // Output paths are regenerated centrally from the row so manual corrections
    // and AniList metadata remain the single source of truth.
    if (contentKind === 'episode' && status === 'identified' && season !== null && episode !== null) {
      const seasonFolder = `Season ${String(season).padStart(2, '0')}`
      const finalName = `${seriesName} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}${extension}`
      outputRelativePath = path.join(seasonFolder, finalName)
    } else if (contentKind === 'special' && status === 'identified' && episode !== null && specialLabel) {
      const seasonFolder = 'Season 00'
      const finalName = `${seriesName} S00E${String(episode).padStart(2, '0')} - ${specialLabel}${extension}`
      outputRelativePath = path.join(seasonFolder, finalName)
    }

    rows.push({
      id: filePath,
      originalName: path.basename(filePath),
      relativePath,
      extension: extension.toLowerCase(),
      sizeBytes: fileStat.size,
      modifiedAtMs: Math.trunc(fileStat.mtimeMs),
      season,
      episode,
      contentKind,
      specialLabel,
      manuallyCorrected: false,
      detectedStatus: status,
      detectedNote,
      confidence,
      method,
      status,
      statusLabel,
      outputRelativePath,
      note: detectedNote
    })
  }

  if (subtitleFiles.length > 0) warnings.push('As legendas entram no plano quando correspondem sem ambiguidade ao nome de um vídeo; as demais exigem revisão manual.')
  const specialCount = rows.filter((row) => row.contentKind === 'special').length
  const movieHintCount = rows.filter((row) => row.contentKind === 'movie').length
  if (specialCount > 0) warnings.push(`${specialCount} especial(is) detectado(s); confira os números e títulos antes de organizar.`)
  if (movieHintCount > 0) warnings.push(`${movieHintCount} possível(is) filme(s) aguardam confirmação manual.`)

  return revalidatePreview({
    sourcePath,
    destinationPath,
    seriesName,
    destinationFolderName: path.basename(destinationPath),
    videoCount: videoFiles.length,
    subtitleCount: subtitleFiles.length,
    subtitleFiles,
    totalVideoBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
    rows,
    warnings,
    scanDurationMs: Date.now() - startedAt,
    mode: 'read-only-preview',
    caseInsensitivePaths: process.platform === 'win32'
  })
}
