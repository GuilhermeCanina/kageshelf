import { describe, expect, it } from 'vitest'
import type { AniListAnime } from '../src/shared/anilistTypes'
import type { EpisodeCorrection, ScanResult } from '../src/shared/types'
import {
  aniListFolderLabel,
  applyEpisodeCorrectionsToPreview,
  revalidatePreview,
  applyAniListMetadataToPreview,
  preferredAniListTitle,
  safeSeriesName
} from '../src/shared/previewMetadata'

const anime: AniListAnime = {
  id: 187331,
  title: { romaji: 'Sawaranaide Kotesashi-kun', english: 'Hands Off: Sawaranaide Kotesashi-kun', native: 'さわらないで小手指くん', userPreferred: 'Sawaranaide Kotesashi-kun' },
  coverImage: { large: 'https://s4.anilist.co/file/cover.jpg', extraLarge: 'https://s4.anilist.co/file/cover-large.jpg' },
  startDate: { year: 2025 },
  seasonYear: 2025,
  episodes: 12,
  format: 'TV',
  status: 'FINISHED',
  siteUrl: 'https://anilist.co/anime/187331'
}

const scanResult: ScanResult = {
  sourcePath: '/media/raw/Unhelpful Folder Name',
  destinationPath: '/media/raw/Unhelpful Folder Name [Jellyfin]',
  seriesName: 'Unhelpful Folder Name',
  destinationFolderName: 'Unhelpful Folder Name [Jellyfin]',
  videoCount: 2,
  subtitleCount: 0,
  totalVideoBytes: 100,
  warnings: [],
  scanDurationMs: 10,
  mode: 'read-only-preview',
  rows: [
    { id: '/media/raw/01.mkv', originalName: 'fansub-01.mkv', relativePath: 'fansub-01.mkv', extension: '.mkv', sizeBytes: 50, modifiedAtMs: 100, season: 1, episode: 1, contentKind: 'episode', manuallyCorrected: false, detectedStatus: 'identified', detectedNote: 'Parsed from file name.', confidence: 'média', method: 'fansub', status: 'identified', statusLabel: 'Identificado', outputRelativePath: 'Season 01/Unhelpful Folder Name S01E01.mkv', note: 'Parsed from file name.' },
    { id: '/media/raw/unknown.mkv', originalName: 'unknown.mkv', relativePath: 'unknown.mkv', extension: '.mkv', sizeBytes: 50, modifiedAtMs: 100, season: null, episode: null, contentKind: 'episode', manuallyCorrected: false, detectedStatus: 'review', detectedNote: 'Episode could not be identified.', confidence: null, method: 'none', status: 'review', statusLabel: 'Revisar', outputRelativePath: null, note: 'Episode could not be identified.' }
  ]
}

describe('AniList-based naming preview', () => {
  it('uses the selected romanized title for filenames and the year for the suggested destination folder', () => {
    const result = applyAniListMetadataToPreview(scanResult, anime, '/media/raw/Sawaranaide Kotesashi-kun (2025) [Jellyfin]')

    expect(result.seriesName).toBe('Sawaranaide Kotesashi-kun')
    expect(result.destinationFolderName).toBe('Sawaranaide Kotesashi-kun (2025) [Jellyfin]')
    expect(result.rows[0].outputRelativePath).toBe('Season 01/Sawaranaide Kotesashi-kun S01E01.mkv')
    expect(result.rows[0].confidence).toBe('média')
    expect(result.rows[1].outputRelativePath).toBeNull()
    expect(scanResult.rows[0].outputRelativePath).toContain('Unhelpful Folder Name')
  })

  it('uses a fallback title and omits year when metadata lacks it', () => {
    const withoutTitle = { ...anime, title: { romaji: null, english: null, native: null, userPreferred: null }, startDate: null, seasonYear: null }
    expect(preferredAniListTitle(withoutTitle, 'Folder title')).toBe('Folder title')
    expect(aniListFolderLabel(withoutTitle, 'Folder title')).toBe('Folder title')
  })

  it('sanitizes characters that are invalid in Windows and POSIX filenames', () => {
    expect(safeSeriesName('Foo/Bar: Baz?')).toBe('Foo Bar Baz')
    expect(safeSeriesName('CON')).toBe('_CON')
  })
})


describe('manual episode correction preview', () => {
  it('applies a matching correction and updates the proposed path without changing automatic confidence', () => {
    const correction: EpisodeCorrection = {
      relativePath: 'unknown.mkv', originalName: 'unknown.mkv', sizeBytes: 50, modifiedAtMs: 100,
      contentKind: 'special', specialLabel: 'OVA 02', season: 0, episode: 2, updatedAt: '2026-10-29T00:00:00.000Z'
    }
    const result = applyEpisodeCorrectionsToPreview(scanResult, [correction])
    const row = result.rows.find((item) => item.relativePath === 'unknown.mkv')!
    expect(row.manuallyCorrected).toBe(true)
    expect(row.status).toBe('identified')
    expect(row.confidence).toBeNull()
    expect(row.outputRelativePath).toBe('Season 00/Unhelpful Folder Name S00E02 - OVA 02.mkv')
  })

  it('ignores a correction when the file signature has changed', () => {
    const correction: EpisodeCorrection = {
      relativePath: 'unknown.mkv', originalName: 'unknown.mkv', sizeBytes: 999, modifiedAtMs: 100,
      contentKind: 'episode', season: 1, episode: 9, updatedAt: '2026-10-29T00:00:00.000Z'
    }
    const result = applyEpisodeCorrectionsToPreview(scanResult, [correction])
    const row = result.rows.find((item) => item.relativePath === 'unknown.mkv')!
    expect(row.manuallyCorrected).toBe(false)
    expect(row.outputRelativePath).toBeNull()
    expect(result.warnings.some((warning) => warning.includes('não foram aplicadas'))).toBe(true)
  })

  it('proposes a movie in the destination root, not a Season folder', () => {
    const correction: EpisodeCorrection = {
      relativePath: 'unknown.mkv', originalName: 'unknown.mkv', sizeBytes: 50, modifiedAtMs: 100,
      contentKind: 'movie', season: null, episode: null, updatedAt: '2026-10-29T00:00:00.000Z'
    }
    const corrected = applyEpisodeCorrectionsToPreview(scanResult, [correction])
    const named = revalidatePreview(corrected, 'Example Movie', '/media/Example Movie [Jellyfin]', 2020)
    expect(named.rows.find((item) => item.relativePath === 'unknown.mkv')?.outputRelativePath).toBe('Example Movie (2020).mkv')
  })

  it('uses host filesystem case rules for duplicate destination paths', () => {
    const first = {
      ...scanResult.rows[0], id: 'movie-a', originalName: 'movie-a.mkv', relativePath: 'movie-a.mkv',
      extension: '.mkv', contentKind: 'movie' as const, season: null, episode: null, manuallyCorrected: true,
      detectedStatus: 'identified' as const, status: 'identified' as const
    }
    const second = {
      ...first, id: 'movie-b', originalName: 'movie-b.MKV', relativePath: 'movie-b.MKV', extension: '.MKV'
    }

    const linuxPreview = revalidatePreview({ ...scanResult, caseInsensitivePaths: false, rows: [first, second] }, 'Example', '/output', 2020)
    expect(linuxPreview.rows.every((row) => row.status === 'identified')).toBe(true)

    const windowsPreview = revalidatePreview({ ...scanResult, caseInsensitivePaths: true, rows: [first, second] }, 'Example', '/output', 2020)
    expect(windowsPreview.rows.every((row) => row.status === 'conflict')).toBe(true)
  })

  it('re-evaluates duplicate episode conflicts after a manual correction', () => {
    const first = scanResult.rows[0]
    const duplicate = {
      ...first,
      id: '/media/raw/copy.mkv',
      originalName: 'copy.mkv',
      relativePath: 'copy.mkv',
      sizeBytes: 75,
      modifiedAtMs: 200,
      note: 'Duplicate filename candidate.'
    }
    const duplicated = revalidatePreview({ ...scanResult, rows: [first, duplicate] })
    expect(duplicated.rows.every((row) => row.status === 'conflict')).toBe(true)
    const correction: EpisodeCorrection = {
      relativePath: 'copy.mkv', originalName: 'copy.mkv', sizeBytes: 75, modifiedAtMs: 200,
      contentKind: 'episode', season: 1, episode: 2, updatedAt: '2026-10-29T00:00:00.000Z'
    }
    const fixed = applyEpisodeCorrectionsToPreview(duplicated, [correction])
    expect(fixed.rows.find((row) => row.relativePath === 'fansub-01.mkv')?.status).toBe('identified')
    expect(fixed.rows.find((row) => row.relativePath === 'copy.mkv')?.status).toBe('identified')
    expect(fixed.rows.find((row) => row.relativePath === 'copy.mkv')?.outputRelativePath).toBe('Season 01/Unhelpful Folder Name S01E02.mkv')
  })
})
