import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseEpisodeName, scanLibrary } from '../src/main/scanEngine'

const tempRoots: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jas-001-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('parseEpisodeName', () => {
  it('detecta episódio num padrão de fansub com separadores e informações técnicas', () => {
    const parsed = parseEpisodeName('[#AnimeNSK]_Ichigo_Mashimaro_-_01_[Blu-Ray_1920x1080]_[HEVC_10Bit]_(4376A400)')
    expect(parsed.status).toBe('identified')
    expect(parsed.episode).toBe(1)
    expect(parsed.confidence).toBe('média')
  })

  it('detecta o episódio com marcador Final sem confundir 1920x1080, 10Bit ou hash', () => {
    const parsed = parseEpisodeName('[#AnimeNSK]_Ichigo_Mashimaro_-_12_Final_[Blu-Ray_1920x1080]_[HEVC_10Bit]_(29CD2F0E)')
    expect(parsed.status).toBe('identified')
    expect(parsed.episode).toBe(12)
    expect(parsed.confidence).toBe('média')
  })

  it('prioriza a marcação explícita SxxExx', () => {
    const parsed = parseEpisodeName('Some Anime S02E04 [1080p] [x265]')
    expect(parsed.status).toBe('identified')
    expect(parsed.season).toBe(2)
    expect(parsed.episode).toBe(4)
    expect(parsed.confidence).toBe('alta')
  })

  it('não tenta usar resolução ou codec como número de episódio', () => {
    const parsed = parseEpisodeName('Anime Movie [Blu-Ray_1920x1080]_[HEVC_10Bit]_(29CD2F0E)')
    expect(parsed.status).toBe('review')
    expect(parsed.episode).toBeNull()
  })

  it('marca como ambíguos dois possíveis episódios no mesmo nível de confiança', () => {
    const parsed = parseEpisodeName('Anime 01 [release] 02 [release]')
    expect(parsed.status).toBe('ambiguous')
  })
})

describe('scanLibrary', () => {
  it('faz uma prévia sem alterar a origem e conta vídeo/legenda', async () => {
    const temp = await makeTempRoot()
    const source = path.join(temp, 'Ichigo Mashimaro (2005)')
    await mkdir(path.join(source, 'Season 01'), { recursive: true })
    await writeFile(path.join(source, 'Season 01', '[#AnimeNSK]_Ichigo_Mashimaro_-_01_[Blu-Ray_1920x1080]_[HEVC_10Bit]_(4376A400).mkv'), 'test-video-01')
    await writeFile(path.join(source, 'Season 01', '[#AnimeNSK]_Ichigo_Mashimaro_-_12_Final_[Blu-Ray_1920x1080]_[HEVC_10Bit]_(29CD2F0E).mkv'), 'test-video-12')
    await writeFile(path.join(source, 'Season 01', 'Ichigo Mashimaro - 01.ass'), 'subtitle')

    const result = await scanLibrary(source)
    const originalFilesAfter = await readdir(path.join(source, 'Season 01'))

    expect(result.videoCount).toBe(2)
    expect(result.subtitleCount).toBe(1)
    expect(result.rows.map((row) => row.episode).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 12])
    expect(result.rows.every((row) => row.status === 'identified')).toBe(true)
    expect(result.destinationPath).toBe(path.join(temp, 'Ichigo Mashimaro (2005) [Jellyfin]'))
    expect(originalFilesAfter).toHaveLength(3)
    expect(result.mode).toBe('read-only-preview')
  })



  it('detects numbered OVAs from folder structure and proposes Season 00', async () => {
    const temp = await makeTempRoot()
    const source = path.join(temp, 'Example Anime (2024)')
    await mkdir(path.join(source, 'OVA'), { recursive: true })
    await writeFile(path.join(source, 'OVA', 'Example Anime - 01 [1080p].mkv'), 'ova-one')

    const result = await scanLibrary(source)
    const row = result.rows[0]
    expect(row.contentKind).toBe('special')
    expect(row.season).toBe(0)
    expect(row.episode).toBe(1)
    expect(row.specialLabel).toBe('OVA 01')
    expect(row.outputRelativePath).toBe('Season 00/Example Anime S00E01 - OVA 01.mkv')
  })

  it('does not mistake a series title containing Special for a conflicting special marker when its folder says OVA', async () => {
    const temp = await makeTempRoot()
    const source = path.join(temp, 'Specials A')
    await mkdir(path.join(source, 'OVA'), { recursive: true })
    await writeFile(path.join(source, 'OVA', 'Specials A - 01 [1080p].mkv'), 'ova-one')

    const result = await scanLibrary(source)
    const row = result.rows[0]
    expect(row.contentKind).toBe('special')
    expect(row.status).toBe('identified')
    expect(row.specialLabel).toBe('OVA 01')
    expect(row.outputRelativePath).toContain('Season 00/Specials A S00E01 - OVA 01.mkv')
  })

  it('detects specials numbered after or before the special marker', async () => {
    const temp = await makeTempRoot()
    const source = path.join(temp, 'Example Anime')
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'Example Anime OVA 02 [1080p].mkv'), 'ova-two')
    await writeFile(path.join(source, 'Example Anime - 03 Special [1080p].mkv'), 'special-three')

    const result = await scanLibrary(source)
    expect(result.rows.every((row) => row.contentKind === 'special' && row.status === 'identified')).toBe(true)
    expect(result.rows.map((row) => row.episode).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([2, 3])
  })

  it('keeps a possible movie for manual confirmation instead of guessing an episode', async () => {
    const temp = await makeTempRoot()
    const source = path.join(temp, 'Example Anime')
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'Example Anime The Movie (2024).mkv'), 'movie')

    const result = await scanLibrary(source)
    expect(result.rows[0].contentKind).toBe('movie')
    expect(result.rows[0].status).toBe('review')
    expect(result.rows[0].outputRelativePath).toBeNull()
  })

  it('marks a path with conflicting season folders as ambiguous', async () => {
    const temp = await makeTempRoot()
    const source = path.join(temp, 'Example Anime')
    await mkdir(path.join(source, 'Season 01', 'Season 02'), { recursive: true })
    await writeFile(path.join(source, 'Season 01', 'Season 02', 'Example Anime S02E01.mkv'), 'video')

    const result = await scanLibrary(source)
    expect(result.rows[0].status).toBe('ambiguous')
    expect(result.rows[0].note).toContain('temporada')
  })

  it('bloqueia um destino dentro da origem', async () => {
    const temp = await makeTempRoot()
    const source = path.join(temp, 'Anime')
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'Anime - 01 [1080p].mkv'), 'video')

    await expect(scanLibrary(source, path.join(source, 'Anime [Jellyfin]'))).rejects.toThrow('não pode ficar dentro')
  })

  it('bloqueia usar uma pasta [Jellyfin] como origem', async () => {
    const temp = await makeTempRoot()
    const source = path.join(temp, 'Anime [Jellyfin]')
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'Anime S01E01.mkv'), 'video')

    await expect(scanLibrary(source)).rejects.toThrow('origem parece estar dentro de uma pasta [Jellyfin]')
  })
})
