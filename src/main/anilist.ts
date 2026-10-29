import type { AniListAnime, AniListSearchResponse } from '../shared/anilistTypes'

const ANILIST_ENDPOINT = 'https://graphql.anilist.co'
const REQUEST_TIMEOUT_MS = 15_000
// AniList's public documentation currently warns of a temporary lower limit.
// Explicit user-triggered searches are spaced to avoid bursts.
const MIN_REQUEST_INTERVAL_MS = 2_100
const RESULT_LIMIT = 8

interface AniListPayload {
  data?: {
    Page?: {
      media?: unknown[] | null
    } | null
  } | null
  errors?: Array<{ message?: string; status?: number }> | null
}

const resultCache = new Map<string, AniListAnime[]>()
let lastRequestAt = 0

const SEARCH_QUERY = `
  query SearchAnime($search: String!, $perPage: Int!) {
    Page(page: 1, perPage: $perPage) {
      media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
        id
        title { romaji english native userPreferred }
        coverImage { large extraLarge }
        startDate { year }
        seasonYear
        episodes
        format
        status
        siteUrl
      }
    }
  }
`

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function mapAnime(value: unknown): AniListAnime | null {
  const media = asRecord(value)
  if (!media || typeof media.id !== 'number') return null

  const title = asRecord(media.title)
  const coverImage = asRecord(media.coverImage)
  const startDate = asRecord(media.startDate)

  return {
    id: media.id,
    title: {
      romaji: nullableString(title?.romaji),
      english: nullableString(title?.english),
      native: nullableString(title?.native),
      userPreferred: nullableString(title?.userPreferred)
    },
    coverImage: {
      large: nullableString(coverImage?.large),
      extraLarge: nullableString(coverImage?.extraLarge)
    },
    startDate: startDate ? { year: nullableNumber(startDate.year) } : null,
    seasonYear: nullableNumber(media.seasonYear),
    episodes: nullableNumber(media.episodes),
    format: nullableString(media.format),
    status: nullableString(media.status),
    siteUrl: nullableString(media.siteUrl)
  }
}

function normalizeCacheKey(query: string): string {
  return query.trim().normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

function errorMessage(status: number, payload: AniListPayload): string {
  const apiMessage = payload.errors?.map((error) => error.message).filter(Boolean).join('; ')
  if (status === 429 || payload.errors?.some((error) => error.status === 429)) {
    return 'O AniList limitou temporariamente as consultas. Aguarde um pouco e tente novamente.'
  }
  if (status >= 500) return 'O AniList está indisponível no momento. Tente novamente mais tarde.'
  if (apiMessage) return `O AniList retornou um erro: ${apiMessage}`
  return `Não foi possível consultar o AniList (HTTP ${status}).`
}

async function waitForRequestSlot(): Promise<void> {
  const waitMs = Math.max(0, lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now())
  if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
  lastRequestAt = Date.now()
}

export async function searchAniListAnime(input: string): Promise<AniListSearchResponse> {
  const query = input.trim().replace(/\s+/g, ' ')
  if (!query) throw new Error('Digite o nome de um anime para pesquisar no AniList.')
  if (query.length > 120) throw new Error('A pesquisa precisa ter no máximo 120 caracteres.')

  const key = normalizeCacheKey(query)
  const cachedResults = resultCache.get(key)
  if (cachedResults) return { query, results: cachedResults, cached: true }

  await waitForRequestSlot()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(ANILIST_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: SEARCH_QUERY, variables: { search: query, perPage: RESULT_LIMIT } }),
      signal: controller.signal
    })

    if (response.status === 429) {
      throw new Error('O AniList limitou temporariamente as consultas. Aguarde um pouco e tente novamente.')
    }

    let payload: AniListPayload
    try {
      payload = await response.json() as AniListPayload
    } catch {
      throw new Error('A resposta do AniList não estava em um formato válido.')
    }

    if (!response.ok || payload.errors?.length || !payload.data?.Page) {
      throw new Error(errorMessage(response.status, payload))
    }

    const media = Array.isArray(payload.data.Page.media) ? payload.data.Page.media : []
    const results = media.map(mapAnime).filter((anime): anime is AniListAnime => anime !== null)
    resultCache.set(key, results)
    return { query, results, cached: false }
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') {
      throw new Error('A consulta ao AniList demorou demais. Verifique sua conexão e tente novamente.')
    }
    if (cause instanceof TypeError) {
      throw new Error('Não foi possível conectar ao AniList. Verifique sua conexão com a internet.')
    }
    throw cause instanceof Error ? cause : new Error(String(cause))
  } finally {
    clearTimeout(timeout)
  }
}

// Exported as a small pure helper to keep response validation covered by tests.
export function mapAniListAnimeForTest(value: unknown): AniListAnime | null {
  return mapAnime(value)
}
