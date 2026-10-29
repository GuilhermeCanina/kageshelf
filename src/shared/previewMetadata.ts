import type { AniListAnime } from './anilistTypes'
import type { EpisodeCorrection, PreviewRow, RowStatus, ScanResult } from './types'

/** Return a filesystem-safe series label for preview paths. */
export function safeSeriesName(value: string): string {
  let cleaned = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 150)
    .replace(/[. ]+$/g, '')

  if (!cleaned || cleaned === '.' || cleaned === '..') cleaned = 'Anime'
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(cleaned)) cleaned = `_${cleaned}`
  return cleaned
}

export function preferredAniListTitle(anime: AniListAnime, fallback: string): string {
  const candidates = [anime.title.romaji, anime.title.english, anime.title.userPreferred, anime.title.native, fallback]
  return safeSeriesName(candidates.find((candidate) => typeof candidate === 'string' && candidate.trim()) ?? 'Anime')
}

export function aniListYear(anime: AniListAnime): number | null {
  const year = anime.startDate?.year ?? anime.seasonYear
  return typeof year === 'number' && Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null
}

export function aniListFolderLabel(anime: AniListAnime, fallback: string): string {
  const title = preferredAniListTitle(anime, fallback)
  const year = aniListYear(anime)
  return year === null ? title : `${title} (${year})`
}

export function destinationFolderNameFromPath(inputPath: string): string {
  const normalized = inputPath.replace(/[\\/]+$/g, '')
  const segments = normalized.split(/[\\/]/g)
  return segments[segments.length - 1] || inputPath
}

function rowStatusLabel(status: RowStatus, manuallyCorrected: boolean): string {
  if (status === 'conflict') return 'Conflito'
  if (status === 'ambiguous') return 'Ambíguo'
  if (status === 'review') return 'Revisar'
  return manuallyCorrected ? 'Corrigido manualmente' : 'Identificado'
}

function isGeneratedWarning(warning: string): boolean {
  return /^\d+ vídeo\(s\) precisam de revisão/i.test(warning)
    || /^Nenhum vídeo está pronto/i.test(warning)
    || /^Há \d+ conflito\(s\)/i.test(warning)
}

function outputPathForRow(row: PreviewRow, seriesName: string, year: number | null): string | null {
  if (row.status !== 'identified') return null
  const safeTitle = safeSeriesName(seriesName)

  if (row.contentKind === 'movie') {
    if (!row.manuallyCorrected) return null
    const movieName = year === null ? safeTitle : `${safeTitle} (${year})`
    return `${movieName}${row.extension}`
  }

  if (row.season === null || row.episode === null) return null
  const season = row.contentKind === 'special' ? 0 : row.season
  if (!Number.isInteger(season) || season < 0 || season > 99 || !Number.isInteger(row.episode) || row.episode < 1 || row.episode > 999) return null
  const seasonLabel = String(season).padStart(2, '0')
  const episodeLabel = String(row.episode).padStart(2, '0')
  const specialSuffix = row.contentKind === 'special' && row.specialLabel?.trim()
    ? ` - ${safeSeriesName(row.specialLabel)}`
    : ''
  const fileName = `${safeTitle} S${seasonLabel}E${episodeLabel}${specialSuffix}${row.extension}`
  return `Season ${seasonLabel}/${fileName}`
}

/**
 * Rebuild statuses, output names, and duplicate detection from each row's parser result.
 * This makes manual edits reversible without losing the original parser decision.
 */
export function revalidatePreview(
  base: ScanResult,
  seriesName = base.seriesName,
  destinationPath = base.destinationPath,
  year: number | null = null
): ScanResult {
  const rows = base.rows.map((row) => {
    const status = row.manuallyCorrected ? 'identified' : (row.detectedStatus ?? row.status)
    const note = row.manuallyCorrected
      ? `Correção manual salva localmente (${row.contentKind === 'movie' ? 'filme' : row.contentKind === 'special' ? 'especial' : `temporada ${row.season}, episódio ${row.episode}`}).`
      : (row.detectedNote ?? row.note)
    const staged: PreviewRow = {
      ...row,
      status,
      statusLabel: rowStatusLabel(status, row.manuallyCorrected),
      note,
      outputRelativePath: null
    }
    staged.outputRelativePath = outputPathForRow(staged, seriesName, year)
    return staged
  })

  const byOutput = new Map<string, PreviewRow[]>()
  const byEpisodeIdentity = new Map<string, PreviewRow[]>()
  for (const row of rows) {
    if (!row.outputRelativePath) continue
    const outputKey = base.caseInsensitivePaths === true ? row.outputRelativePath.toLocaleLowerCase('en-US') : row.outputRelativePath
    const outputGroup = byOutput.get(outputKey) ?? []
    outputGroup.push(row)
    byOutput.set(outputKey, outputGroup)

    if (row.contentKind !== 'movie' && row.season !== null && row.episode !== null) {
      const season = row.contentKind === 'special' ? 0 : row.season
      const identityKey = `${row.contentKind}:${season}:E${row.episode}`
      const identityGroup = byEpisodeIdentity.get(identityKey) ?? []
      identityGroup.push(row)
      byEpisodeIdentity.set(identityKey, identityGroup)
    }
  }

  const conflictingIds = new Set<string>()
  for (const group of [...byOutput.values(), ...byEpisodeIdentity.values()]) {
    if (group.length > 1) for (const row of group) conflictingIds.add(row.id)
  }
  for (const row of rows) {
    if (conflictingIds.has(row.id)) {
      row.status = 'conflict'
      row.statusLabel = 'Conflito'
      row.note = 'Outro arquivo propõe o mesmo caminho ou a mesma identidade de episódio. Ajuste a identificação antes de considerar a prévia pronta.'
    }
  }

  const staticWarnings = base.warnings.filter((warning) => !isGeneratedWarning(warning))
  const reviewCount = rows.filter((row) => row.status !== 'identified').length
  const conflictCount = rows.filter((row) => row.status === 'conflict').length
  if (reviewCount > 0) staticWarnings.push(`${reviewCount} vídeo(s) precisam de revisão; não devem ser organizados automaticamente.`)
  if (conflictCount > 0) staticWarnings.push(`Há ${conflictCount} conflito(s) de episódio ou destino; resolva-os antes de qualquer organização.`)
  if (rows.every((row) => row.status !== 'identified')) staticWarnings.push('Nenhum vídeo está pronto para uma futura etapa de organização.')

  return {
    ...base,
    seriesName,
    destinationPath,
    destinationFolderName: destinationFolderNameFromPath(destinationPath),
    rows,
    warnings: [...new Set(staticWarnings)]
  }
}

/** Applies only corrections that still match the same file signature. Stale decisions are ignored. */
export function applyEpisodeCorrectionsToPreview(base: ScanResult, corrections: EpisodeCorrection[]): ScanResult {
  if (corrections.length === 0) return revalidatePreview(base)
  const byRelativePath = new Map(corrections.map((correction) => [correction.relativePath, correction]))
  const seen = new Set<string>()
  let staleCount = 0

  const rows = base.rows.map((row) => {
    const correction = byRelativePath.get(row.relativePath)
    if (!correction) return row
    seen.add(correction.relativePath)
    const fingerprintMatches = correction.originalName === row.originalName
      && correction.sizeBytes === row.sizeBytes
      && correction.modifiedAtMs === row.modifiedAtMs
    if (!fingerprintMatches) {
      staleCount += 1
      return row
    }
    return {
      ...row,
      contentKind: correction.contentKind,
      specialLabel: correction.specialLabel ?? (correction.contentKind === 'special' ? row.specialLabel ?? null : null),
      season: correction.season,
      episode: correction.episode,
      manuallyCorrected: true,
      method: 'Correção manual salva',
      note: 'Correção manual recuperada do armazenamento local.'
    }
  })
  staleCount += corrections.filter((correction) => !seen.has(correction.relativePath)).length
  const warnings = staleCount > 0
    ? [...base.warnings, `${staleCount} correção(ões) salva(s) não foram aplicadas porque o arquivo foi removido ou mudou. Revise e salve a correção novamente.`]
    : base.warnings

  return revalidatePreview({ ...base, rows, warnings })
}

/** Rebuild names from selected AniList metadata without treating it as proof of episode identity. */
export function applyAniListMetadataToPreview(
  base: ScanResult,
  anime: AniListAnime,
  destinationPath: string
): ScanResult {
  const seriesName = preferredAniListTitle(anime, base.seriesName)
  return revalidatePreview(base, seriesName, destinationPath, aniListYear(anime))
}
