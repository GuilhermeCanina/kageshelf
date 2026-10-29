import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { AniListAnime, StoredAniListAssociation } from '../shared/anilistTypes'

interface AssociationDatabase {
  schemaVersion: 1
  associations: Record<string, StoredAniListAssociation>
}

function normalizedSourcePath(sourcePath: string): string {
  const resolved = path.resolve(sourcePath.trim())
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function validateAnime(value: unknown): AniListAnime {
  if (value === null || typeof value !== 'object') throw new Error('Registro do AniList inválido.')
  const input = value as Record<string, unknown>
  const title = input.title as Record<string, unknown> | null
  const cover = input.coverImage as Record<string, unknown> | null
  const startDate = input.startDate as Record<string, unknown> | null

  if (typeof input.id !== 'number' || !Number.isSafeInteger(input.id) || input.id <= 0 || !title || !cover) {
    throw new Error('O registro selecionado não contém os campos obrigatórios do AniList.')
  }

  for (const field of ['romaji', 'english', 'native', 'userPreferred']) {
    if (!isNullableString(title[field])) throw new Error('Título inválido no registro do AniList.')
  }
  for (const field of ['large', 'extraLarge']) {
    if (!isNullableString(cover[field])) throw new Error('Capa inválida no registro do AniList.')
  }
  const year = startDate?.year
  if (year !== undefined && year !== null && (typeof year !== 'number' || !Number.isInteger(year))) {
    throw new Error('Ano inválido no registro do AniList.')
  }

  const episodes = input.episodes
  if (episodes !== null && episodes !== undefined && (typeof episodes !== 'number' || !Number.isFinite(episodes))) {
    throw new Error('Quantidade de episódios inválida no registro do AniList.')
  }

  const safeUrl = (candidate: unknown): string | null => {
    if (candidate === null || candidate === undefined) return null
    if (typeof candidate !== 'string') return null
    try {
      const parsed = new URL(candidate)
      return parsed.protocol === 'https:' ? parsed.href : null
    } catch {
      return null
    }
  }
  const stringOrNull = (candidate: unknown): string | null => typeof candidate === 'string' ? candidate : null
  const nullableNumber = (candidate: unknown): number | null => typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null

  return {
    id: Number(input.id),
    title: {
      romaji: stringOrNull(title.romaji),
      english: stringOrNull(title.english),
      native: stringOrNull(title.native),
      userPreferred: stringOrNull(title.userPreferred)
    },
    coverImage: {
      large: safeUrl(cover.large),
      extraLarge: safeUrl(cover.extraLarge)
    },
    startDate: startDate && typeof startDate === 'object' ? { year: nullableNumber(year) } : null,
    seasonYear: nullableNumber(input.seasonYear),
    episodes: nullableNumber(episodes),
    format: stringOrNull(input.format),
    status: stringOrNull(input.status),
    siteUrl: safeUrl(input.siteUrl)
  }
}

async function readDatabase(filePath: string): Promise<AssociationDatabase> {
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<AssociationDatabase>
    if (parsed.schemaVersion !== 1 || !parsed.associations || typeof parsed.associations !== 'object' || Array.isArray(parsed.associations)) {
      throw new Error('Formato inesperado no arquivo de associações locais.')
    }
    return { schemaVersion: 1, associations: parsed.associations as Record<string, StoredAniListAssociation> }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, associations: {} }
    throw new Error(`Não foi possível ler as associações locais: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

async function writeDatabase(filePath: string, database: AssociationDatabase): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(database, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporaryPath, filePath)
  } catch (cause) {
    const { unlink } = await import('node:fs/promises')
    await unlink(temporaryPath).catch(() => undefined)
    throw new Error(`Não foi possível salvar a associação local: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

export async function getStoredAssociation(filePath: string, sourcePath: string): Promise<StoredAniListAssociation | null> {
  if (!sourcePath.trim()) return null
  const database = await readDatabase(filePath)
  const stored = database.associations[normalizedSourcePath(sourcePath)]
  if (!stored) return null
  if (typeof stored.sourcePath !== 'string' || normalizedSourcePath(stored.sourcePath) !== normalizedSourcePath(sourcePath) || typeof stored.updatedAt !== 'string' || !stored.updatedAt.trim()) {
    throw new Error('A associação local está incompleta. Remova o arquivo de associações corrompido ou selecione novamente o anime.')
  }
  return {
    sourcePath: path.resolve(stored.sourcePath),
    anime: validateAnime(stored.anime),
    updatedAt: stored.updatedAt
  }
}

export async function saveStoredAssociation(
  filePath: string,
  sourcePath: string,
  animeInput: unknown
): Promise<StoredAniListAssociation> {
  if (!sourcePath.trim()) throw new Error('Selecione a pasta de origem antes de associar um anime.')
  const absoluteSourcePath = path.resolve(sourcePath.trim())
  const anime = validateAnime(animeInput)
  const association: StoredAniListAssociation = { sourcePath: absoluteSourcePath, anime, updatedAt: new Date().toISOString() }
  const database = await readDatabase(filePath)
  database.associations[normalizedSourcePath(absoluteSourcePath)] = association
  await writeDatabase(filePath, database)
  return association
}

export async function deleteStoredAssociation(filePath: string, sourcePath: string): Promise<void> {
  if (!sourcePath.trim()) return
  const database = await readDatabase(filePath)
  delete database.associations[normalizedSourcePath(sourcePath)]
  await writeDatabase(filePath, database)
}
