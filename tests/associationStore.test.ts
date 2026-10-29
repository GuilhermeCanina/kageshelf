import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteStoredAssociation, getStoredAssociation, saveStoredAssociation } from '../src/main/associationStore'

const roots: string[] = []
async function setup(): Promise<{ root: string; store: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jas-associations-'))
  roots.push(root)
  return { root, store: path.join(root, 'user-data', 'anime-associations.json') }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const anime = {
  id: 187331,
  title: { romaji: 'Sawaranaide Kotesashi-kun', english: null, native: 'さわらないで小手指くん', userPreferred: 'Sawaranaide Kotesashi-kun' },
  coverImage: { large: 'https://s4.anilist.co/file/cover.jpg', extraLarge: 'https://s4.anilist.co/file/cover-large.jpg' },
  startDate: { year: 2025 }, seasonYear: 2025, episodes: 12, format: 'TV', status: 'FINISHED', siteUrl: 'https://anilist.co/anime/187331'
}

describe('local AniList association store', () => {
  it('persists an association and reloads it for the same source folder', async () => {
    const { store } = await setup()
    const saved = await saveStoredAssociation(store, '/media/anime/Series', anime)
    const loaded = await getStoredAssociation(store, '/media/anime/Series')

    expect(saved.anime.id).toBe(187331)
    expect(loaded?.anime.title.romaji).toBe('Sawaranaide Kotesashi-kun')
    expect(loaded?.updatedAt).toBeTruthy()
    const disk = JSON.parse(await readFile(store, 'utf8'))
    expect(disk.schemaVersion).toBe(1)
  })

  it('removes the stored association without affecting other keys', async () => {
    const { store } = await setup()
    await saveStoredAssociation(store, '/media/anime/A', anime)
    await saveStoredAssociation(store, '/media/anime/B', { ...anime, id: 2 })
    await deleteStoredAssociation(store, '/media/anime/A')

    expect(await getStoredAssociation(store, '/media/anime/A')).toBeNull()
    expect((await getStoredAssociation(store, '/media/anime/B'))?.anime.id).toBe(2)
  })

  it('rejects invalid AniList IDs and does not silently create an association', async () => {
    const { store } = await setup()
    await expect(saveStoredAssociation(store, '/media/anime/A', { ...anime, id: -1 })).rejects.toThrow('campos obrigatórios')
    expect(await getStoredAssociation(store, '/media/anime/A')).toBeNull()
  })
})
