export interface AniListAnime {
  id: number
  title: {
    romaji: string | null
    english: string | null
    native: string | null
    userPreferred: string | null
  }
  coverImage: {
    large: string | null
    extraLarge: string | null
  }
  startDate: { year: number | null } | null
  seasonYear: number | null
  episodes: number | null
  format: string | null
  status: string | null
  siteUrl: string | null
}

export interface AniListSearchResponse {
  query: string
  results: AniListAnime[]
  cached: boolean
}

export interface StoredAniListAssociation {
  sourcePath: string
  anime: AniListAnime
  updatedAt: string
}
