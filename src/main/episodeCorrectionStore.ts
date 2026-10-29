import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ContentKind, EpisodeCorrection } from '../shared/types'

interface CorrectionDatabase {
  schemaVersion: 1
  corrections: Record<string, EpisodeCorrection[]>
}

function normalizeSourcePath(sourcePath: string): string {
  const resolved = path.resolve(sourcePath.trim())
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function validInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
}

function isUnsafeRelativePath(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) return true
  const windowsPaths = path.sep === '\\'
  const normalized = windowsPaths ? value.replace(/\\/g, '/') : value
  return path.isAbsolute(value)
    || (windowsPaths && path.win32.isAbsolute(value))
    || (windowsPaths && /^[a-z]:/i.test(value))
    || normalized.startsWith('/')
    || normalized.split('/').some((part) => part === '..')
}

function validateCorrection(input: unknown): EpisodeCorrection {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Correção de episódio inválida.')
  const value = input as Record<string, unknown>
  if (typeof value.relativePath !== 'string' || isUnsafeRelativePath(value.relativePath)) {
    throw new Error('Caminho relativo inválido na correção.')
  }
  if (typeof value.originalName !== 'string' || !value.originalName.trim() || value.originalName.length > 1024) throw new Error('Nome original inválido na correção.')
  if (!validInteger(value.sizeBytes, 0, Number.MAX_SAFE_INTEGER)) throw new Error('Tamanho de arquivo inválido na correção.')
  if (!validInteger(value.modifiedAtMs, 0, Number.MAX_SAFE_INTEGER)) throw new Error('Data de modificação inválida na correção.')
  const contentKind = value.contentKind as ContentKind
  if (!['episode', 'special', 'movie'].includes(contentKind)) throw new Error('Tipo de conteúdo inválido.')

  let season: number | null = null
  let episode: number | null = null
  if (contentKind === 'episode') {
    const inputSeason = value.season
    const inputEpisode = value.episode
    if (!validInteger(inputSeason, 1, 99) || !validInteger(inputEpisode, 1, 999)) throw new Error('Episódios comuns precisam de temporada de 1 a 99 e episódio de 1 a 999.')
    season = inputSeason
    episode = inputEpisode
  } else if (contentKind === 'special') {
    const inputEpisode = value.episode
    if (!validInteger(inputEpisode, 1, 999)) throw new Error('Especiais precisam de um número de episódio entre 1 e 999.')
    season = 0
    episode = inputEpisode
  }

  const specialLabel = typeof value.specialLabel === 'string' ? value.specialLabel.trim().slice(0, 100) : null
  return {
    relativePath: value.relativePath,
    originalName: value.originalName,
    sizeBytes: value.sizeBytes,
    modifiedAtMs: value.modifiedAtMs,
    contentKind,
    specialLabel: contentKind === 'special' ? (specialLabel || null) : null,
    season,
    episode,
    updatedAt: typeof value.updatedAt === 'string' && value.updatedAt.trim() ? value.updatedAt : new Date().toISOString()
  }
}

async function readDatabase(filePath: string): Promise<CorrectionDatabase> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<CorrectionDatabase>
    if (parsed.schemaVersion !== 1 || !parsed.corrections || typeof parsed.corrections !== 'object' || Array.isArray(parsed.corrections)) {
      throw new Error('Formato inesperado no banco local de correções.')
    }
    return { schemaVersion: 1, corrections: parsed.corrections as Record<string, EpisodeCorrection[]> }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, corrections: {} }
    throw new Error(`Não foi possível ler as correções locais: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

async function writeDatabase(filePath: string, database: CorrectionDatabase): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, filePath)
  } catch (cause) {
    const { unlink } = await import('node:fs/promises')
    await unlink(temporaryPath).catch(() => undefined)
    throw new Error(`Não foi possível salvar a correção local: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

export async function getStoredEpisodeCorrections(filePath: string, sourcePath: string): Promise<EpisodeCorrection[]> {
  if (!sourcePath.trim()) return []
  const database = await readDatabase(filePath)
  const records = database.corrections[normalizeSourcePath(sourcePath)] ?? []
  if (!Array.isArray(records)) throw new Error('A lista local de correções está inválida.')
  return records.map(validateCorrection)
}

export async function saveStoredEpisodeCorrection(filePath: string, sourcePath: string, correctionInput: unknown): Promise<EpisodeCorrection> {
  if (!sourcePath.trim()) throw new Error('Selecione a pasta de origem antes de salvar uma correção.')
  const correction = validateCorrection(correctionInput)
  correction.updatedAt = new Date().toISOString()
  const database = await readDatabase(filePath)
  const key = normalizeSourcePath(sourcePath)
  const previousValue = database.corrections[key] ?? []
  if (!Array.isArray(previousValue)) throw new Error('A lista local de correções está inválida.')
  const previous = previousValue.map(validateCorrection)
  database.corrections[key] = [...previous.filter((item) => item.relativePath !== correction.relativePath), correction]
  await writeDatabase(filePath, database)
  return correction
}

export async function deleteStoredEpisodeCorrection(filePath: string, sourcePath: string, relativePath: string): Promise<void> {
  if (!sourcePath.trim()) return
  if (isUnsafeRelativePath(relativePath)) {
    throw new Error('Caminho relativo inválido para remover a correção.')
  }
  const database = await readDatabase(filePath)
  const key = normalizeSourcePath(sourcePath)
  const previousValue = database.corrections[key] ?? []
  if (!Array.isArray(previousValue)) throw new Error('A lista local de correções está inválida.')
  database.corrections[key] = previousValue.map(validateCorrection).filter((item) => item.relativePath !== relativePath)
  if (database.corrections[key].length === 0) delete database.corrections[key]
  await writeDatabase(filePath, database)
}
