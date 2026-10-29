import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveLegacyUserDataPath } from '../src/main/userDataPath'

describe('resolveLegacyUserDataPath', () => {
  let temporaryRoot: string

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'kageshelf-user-data-'))
  })

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true })
  })

  it('uses the original display-name directory for a fresh profile', () => {
    expect(resolveLegacyUserDataPath(temporaryRoot)).toBe(path.join(temporaryRoot, 'Jellyfin Anime Supremo'))
  })

  it('prefers the existing legacy directory when it contains execution history', async () => {
    const displayNameDirectory = path.join(temporaryRoot, 'Jellyfin Anime Supremo')
    const kebabDirectory = path.join(temporaryRoot, 'jellyfin-anime-supremo')
    await mkdir(displayNameDirectory)
    await mkdir(path.join(kebabDirectory, 'organization-executions'), { recursive: true })
    await writeFile(path.join(kebabDirectory, 'organization-executions', 'run.json'), '{}', 'utf8')

    expect(resolveLegacyUserDataPath(temporaryRoot)).toBe(kebabDirectory)
  })

  it('does not modify either folder while selecting between legacy spellings', async () => {
    const displayNameDirectory = path.join(temporaryRoot, 'Jellyfin Anime Supremo')
    const kebabDirectory = path.join(temporaryRoot, 'jellyfin-anime-supremo')
    await mkdir(displayNameDirectory)
    await mkdir(kebabDirectory)
    await writeFile(path.join(displayNameDirectory, 'anime-associations.json'), '{}', 'utf8')
    await writeFile(path.join(kebabDirectory, 'episode-corrections.json'), '{}', 'utf8')

    const selected = resolveLegacyUserDataPath(temporaryRoot)
    expect([displayNameDirectory, kebabDirectory]).toContain(selected)
    expect(selected).toBe(displayNameDirectory)
  })
})
