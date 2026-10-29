import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scanLibrary } from '../src/main/scanEngine'
import { buildOrganizationPlan, validateOrganizationPlan } from '../src/main/organizationPlan'
import { planCanBeApproved, previewSignature } from '../src/shared/organizationPlan'

const tempRoots: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jas-plan-'))
  tempRoots.push(root)
  return root
}

async function makeLibrary(root: string, withSubtitle = true): Promise<{ source: string; destination: string }> {
  const source = path.join(root, 'Ichigo Mashimaro (2005)')
  const destination = path.join(root, 'Ichigo Mashimaro (2005) [Jellyfin]')
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, '[#Fansub]_Ichigo_Mashimaro_-_01_[1080p].mkv'), 'video-01')
  await writeFile(path.join(source, '[#Fansub]_Ichigo_Mashimaro_-_12_Final_[1080p].mkv'), 'video-12')
  if (withSubtitle) await writeFile(path.join(source, '[#Fansub]_Ichigo_Mashimaro_-_01_[1080p].pt-BR.srt'), 'subtitle-pt')
  return { source, destination }
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('organization plan', () => {
  it('creates a read-only plan with videos and an unambiguous language-suffixed subtitle', async () => {
    const root = await makeTempRoot()
    const { source, destination } = await makeLibrary(root)
    const scanned = await scanLibrary(source, destination)
    const plan = await buildOrganizationPlan(scanned)

    expect(plan.analysisOutdated).toBe(false)
    expect(plan.items).toHaveLength(3)
    expect(plan.summary.ready).toBe(3)
    expect(plan.summary.review).toBe(0)
    expect(plan.items.find((item) => item.kind === 'subtitle')?.destinationRelativePath).toBe('Season 01/Ichigo Mashimaro S01E01.pt-BR.srt')
    expect(plan.items.every((item) => item.status === 'ready')).toBe(true)
    expect(plan.validation).toBeNull()
    expect(plan.approvedAt).toBeNull()

    const validation = await validateOrganizationPlan(plan)
    expect(validation.fresh).toBe(true)
    expect(planCanBeApproved({ ...plan, validation }, previewSignature(scanned))).toBe(true)
  })

  it('marks an unmatched subtitle for review instead of guessing a video', async () => {
    const root = await makeTempRoot()
    const { source, destination } = await makeLibrary(root, false)
    await writeFile(path.join(source, 'random-commentary.srt'), 'subtitle')
    const scanned = await scanLibrary(source, destination)
    const plan = await buildOrganizationPlan(scanned)

    const subtitle = plan.items.find((item) => item.kind === 'subtitle')
    expect(subtitle?.status).toBe('review')
    expect(subtitle?.destinationRelativePath).toBeNull()
    expect(plan.summary.review).toBe(1)
    const validation = await validateOrganizationPlan(plan)
    expect(planCanBeApproved({ ...plan, validation }, previewSignature(scanned))).toBe(false)
  })



  it('pairs a language-suffixed subtitle in another folder only when the normalized basename is unique', async () => {
    const root = await makeTempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    await mkdir(path.join(source, 'Season 01'), { recursive: true })
    await mkdir(path.join(source, 'Subtitles'), { recursive: true })
    await writeFile(path.join(source, 'Season 01', 'Anime - 01 [1080p].mkv'), 'video')
    await writeFile(path.join(source, 'Subtitles', 'Anime - 01 [1080p].pt-BR.forced.ass'), 'subtitle')

    const scanned = await scanLibrary(source, destination)
    const plan = await buildOrganizationPlan(scanned)
    const subtitle = plan.items.find((item) => item.kind === 'subtitle')
    expect(subtitle?.status).toBe('ready')
    expect(subtitle?.relatedVideoRelativePath).toBe('Season 01/Anime - 01 [1080p].mkv')
    expect(subtitle?.destinationRelativePath).toBe('Season 01/Anime S01E01.pt-BR.forced.ass')
    expect(subtitle?.reason).toContain('outra pasta')
  })

  it('does not guess subtitle association when the same basename appears in multiple folders', async () => {
    const root = await makeTempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    await mkdir(path.join(source, 'Season 01'), { recursive: true })
    await mkdir(path.join(source, 'Season 02'), { recursive: true })
    await mkdir(path.join(source, 'Subtitles'), { recursive: true })
    await writeFile(path.join(source, 'Season 01', 'Anime - 01 [1080p].mkv'), 'video-one')
    await writeFile(path.join(source, 'Season 02', 'Anime - 01 [1080p].mkv'), 'video-two')
    await writeFile(path.join(source, 'Subtitles', 'Anime - 01 [1080p].pt-BR.srt'), 'subtitle')

    const plan = await buildOrganizationPlan(await scanLibrary(source, destination))
    const subtitle = plan.items.find((item) => item.kind === 'subtitle')
    expect(subtitle?.status).toBe('review')
    expect(subtitle?.destinationRelativePath).toBeNull()
    expect(subtitle?.reason).toContain('pastas diferentes')
  })

  it('detects a destination that already exists and prevents approval', async () => {
    const root = await makeTempRoot()
    const { source, destination } = await makeLibrary(root, false)
    const scanned = await scanLibrary(source, destination)
    await mkdir(path.join(destination, 'Season 01'), { recursive: true })
    await writeFile(path.join(destination, 'Season 01', 'Ichigo Mashimaro S01E01.mkv'), 'preexisting')

    const plan = await buildOrganizationPlan(scanned)
    expect(plan.summary.conflict).toBe(1)
    expect(plan.items.find((item) => item.destinationRelativePath === 'Season 01/Ichigo Mashimaro S01E01.mkv')?.status).toBe('conflict')
    const validation = await validateOrganizationPlan(plan)
    expect(validation.fresh).toBe(true)
    expect(planCanBeApproved({ ...plan, validation }, previewSignature(scanned))).toBe(false)
  })



  it('indexes existing destination media and detects a duplicate Jellyfin episode identity under a different name', async () => {
    const root = await makeTempRoot()
    const { source, destination } = await makeLibrary(root, false)
    await mkdir(path.join(destination, 'Season 01'), { recursive: true })
    await writeFile(path.join(destination, 'Season 01', 'Older Anime S01E01.mkv'), 'different episode file')

    const scanned = await scanLibrary(source, destination)
    const plan = await buildOrganizationPlan(scanned)
    expect(plan.destinationLibrarySummary?.videos).toBe(1)
    expect(plan.destinationLibrarySnapshot).toHaveLength(1)
    const firstEpisode = plan.items.find((item) => item.kind === 'video' && item.episode === 1)
    expect(firstEpisode?.status).toBe('conflict')
    expect(firstEpisode?.reason).toContain('identidade S01E01')
  })

  it('distinguishes an identical pre-existing target from a different file with the same target path', async () => {
    const root = await makeTempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    await mkdir(source, { recursive: true })
    await writeFile(path.join(source, 'Anime - 01 [1080p].mkv'), 'same-content')
    const scanned = await scanLibrary(source, destination)
    const plannedPath = path.join(destination, 'Season 01', 'Anime S01E01.mkv')
    await mkdir(path.dirname(plannedPath), { recursive: true })
    await writeFile(plannedPath, 'same-content')

    const plan = await buildOrganizationPlan(scanned)
    expect(plan.items[0].status).toBe('conflict')
    expect(plan.items[0].reason).toContain('conteúdo idêntico')

    await writeFile(plannedPath, 'different-size-and-content')
    const changedPlan = await buildOrganizationPlan(scanned)
    expect(changedPlan.items[0].status).toBe('conflict')
    expect(changedPlan.items[0].reason).toContain('Já existe um arquivo neste destino')
    expect(await (await import('node:fs/promises')).readFile(plannedPath, 'utf8')).toBe('different-size-and-content')
  })

  it('invalidates a plan when unrelated supported media is added to the existing destination library', async () => {
    const root = await makeTempRoot()
    const { source, destination } = await makeLibrary(root, false)
    await mkdir(path.join(destination, 'Season 01'), { recursive: true })
    await writeFile(path.join(destination, 'Season 01', 'Old S01E10.mkv'), 'existing')
    const scanned = await scanLibrary(source, destination)
    const plan = await buildOrganizationPlan(scanned)
    await writeFile(path.join(destination, 'Season 01', 'Later S01E11.mkv'), 'new existing media')

    const validation = await validateOrganizationPlan(plan)
    expect(validation.fresh).toBe(false)
    expect(validation.issues.some((issue) => issue.includes('biblioteca de destino mudou'))).toBe(true)
  })

  it('detects a destination changing after a plan is generated', async () => {
    const root = await makeTempRoot()
    const { source, destination } = await makeLibrary(root, false)
    const scanned = await scanLibrary(source, destination)
    const plan = await buildOrganizationPlan(scanned)
    await mkdir(path.join(destination, 'Season 01'), { recursive: true })
    await writeFile(path.join(destination, 'Season 01', 'Ichigo Mashimaro S01E01.mkv'), 'appeared-later')

    const validation = await validateOrganizationPlan(plan)
    expect(validation.fresh).toBe(false)
    expect(validation.issues.some((issue) => issue.includes('mudou desde a geração'))).toBe(true)
  })

  it('detects source files changed after plan generation', async () => {
    const root = await makeTempRoot()
    const { source, destination } = await makeLibrary(root, false)
    const scanned = await scanLibrary(source, destination)
    const plan = await buildOrganizationPlan(scanned)
    await writeFile(path.join(source, '[#Fansub]_Ichigo_Mashimaro_-_01_[1080p].mkv'), 'video-01-changed-and-longer')

    const validation = await validateOrganizationPlan(plan)
    expect(validation.fresh).toBe(false)
    expect(validation.issues.some((issue) => issue.includes('vídeos ou as legendas da origem mudaram'))).toBe(true)
  })

  it('marks new files since scan as pending and analysis as outdated', async () => {
    const root = await makeTempRoot()
    const { source, destination } = await makeLibrary(root, false)
    const scanned = await scanLibrary(source, destination)
    await writeFile(path.join(source, 'Ichigo Mashimaro - 03 [1080p].mkv'), 'new-video')

    const plan = await buildOrganizationPlan(scanned)
    expect(plan.analysisOutdated).toBe(true)
    expect(plan.summary.pending).toBe(1)
  })
})
