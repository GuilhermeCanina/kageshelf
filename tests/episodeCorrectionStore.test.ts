import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteStoredEpisodeCorrection, getStoredEpisodeCorrections, saveStoredEpisodeCorrection } from '../src/main/episodeCorrectionStore'

const tempRoots: string[] = []

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jas-corrections-'))
  tempRoots.push(root)
  return { root, database: path.join(root, 'data', 'episode-corrections.json') }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const correction = {
  relativePath: 'Season 01/unknown.mkv',
  originalName: 'unknown.mkv',
  sizeBytes: 12345,
  modifiedAtMs: 1772223334000,
  contentKind: 'episode' as const,
  season: 2,
  episode: 7,
  updatedAt: '2026-10-29T00:00:00.000Z'
}

describe('episode correction store', () => {
  it('persists a correction by source directory and reads it back', async () => {
    const { database, root } = await setup()
    await saveStoredEpisodeCorrection(database, path.join(root, 'source'), correction)
    const loaded = await getStoredEpisodeCorrections(database, path.join(root, 'source'))
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({ relativePath: correction.relativePath, contentKind: 'episode', season: 2, episode: 7 })
  })

  it('replaces a correction for the same relative path instead of duplicating it', async () => {
    const { database, root } = await setup()
    const source = path.join(root, 'source')
    await saveStoredEpisodeCorrection(database, source, correction)
    await saveStoredEpisodeCorrection(database, source, { ...correction, episode: 8 })
    const loaded = await getStoredEpisodeCorrections(database, source)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].episode).toBe(8)
  })

  it('deletes only the selected relative path correction', async () => {
    const { database, root } = await setup()
    const source = path.join(root, 'source')
    await saveStoredEpisodeCorrection(database, source, correction)
    await saveStoredEpisodeCorrection(database, source, { ...correction, relativePath: 'another.mkv', originalName: 'another.mkv' })
    await deleteStoredEpisodeCorrection(database, source, correction.relativePath)
    const loaded = await getStoredEpisodeCorrections(database, source)
    expect(loaded.map((item) => item.relativePath)).toEqual(['another.mkv'])
  })

  it('rejects path traversal and invalid episode values', async () => {
    const { database, root } = await setup()
    const source = path.join(root, 'source')
    await expect(saveStoredEpisodeCorrection(database, source, { ...correction, relativePath: '../outside.mkv' })).rejects.toThrow('Caminho relativo inválido')
    await expect(saveStoredEpisodeCorrection(database, source, { ...correction, episode: 0 })).rejects.toThrow('Episódios comuns')
  })

  it('stores specials in season 00 and movies without episode numbers', async () => {
    const { database, root } = await setup()
    const source = path.join(root, 'source')
    const special = await saveStoredEpisodeCorrection(database, source, { ...correction, contentKind: 'special', season: 0 })
    const movie = await saveStoredEpisodeCorrection(database, source, { ...correction, relativePath: 'movie.mkv', originalName: 'movie.mkv', contentKind: 'movie', season: null, episode: null })
    expect(special.season).toBe(0)
    expect(special.episode).toBe(7)
    expect(movie.season).toBeNull()
    expect(movie.episode).toBeNull()
  })
})
