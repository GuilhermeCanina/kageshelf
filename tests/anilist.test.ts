import { afterEach, describe, expect, it, vi } from 'vitest'
import { mapAniListAnimeForTest, searchAniListAnime } from '../src/main/anilist'

const sampleMedia = {
  id: 12345,
  title: { romaji: 'Ichigo Mashimaro', english: 'Strawberry Marshmallow', native: '苺ましまろ', userPreferred: 'Ichigo Mashimaro' },
  coverImage: { large: 'https://s4.anilist.co/file/test-cover.jpg', extraLarge: 'https://s4.anilist.co/file/test-cover-large.jpg' },
  startDate: { year: 2005 },
  seasonYear: 2005,
  episodes: 12,
  format: 'TV',
  status: 'FINISHED',
  siteUrl: 'https://anilist.co/anime/12345'
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AniList metadata mapping', () => {
  it('normalizes a media result while preserving optional fields', () => {
    const result = mapAniListAnimeForTest(sampleMedia)
    expect(result?.id).toBe(12345)
    expect(result?.title.romaji).toBe('Ichigo Mashimaro')
    expect(result?.startDate?.year).toBe(2005)
    expect(result?.episodes).toBe(12)
    expect(result?.coverImage.extraLarge).toContain('test-cover-large')
  })

  it('rejects malformed media records', () => {
    expect(mapAniListAnimeForTest(null)).toBeNull()
    expect(mapAniListAnimeForTest({ title: { romaji: 'No ID' } })).toBeNull()
  })
})

describe('AniList search API client', () => {
  it('sends a GraphQL search and maps its candidates', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { Page: { media: [sampleMedia] } } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await searchAniListAnime('GraphQL query test title')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://graphql.anilist.co')
    expect(result.results).toHaveLength(1)
    expect(result.results[0].title.romaji).toBe('Ichigo Mashimaro')
    expect(result.cached).toBe(false)
  })

  it('uses cache for the same normalized search query', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { Page: { media: [sampleMedia] } } })
    })
    vi.stubGlobal('fetch', fetchMock)

    const first = await searchAniListAnime('  Cache test title  ')
    const second = await searchAniListAnime('cache test title')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
  })

  it('provides a useful error for rate limiting', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ errors: [{ status: 429, message: 'Too Many Requests.' }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(searchAniListAnime('Rate limit test title')).rejects.toThrow('limitou temporariamente')
  })
})
