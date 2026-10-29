import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const LEGACY_APP_DIRECTORY_NAMES = ['Jellyfin Anime Supremo', 'jellyfin-anime-supremo'] as const

function persistedDataScore(directory: string): number {
  let score = 0
  if (existsSync(path.join(directory, 'anime-associations.json'))) score += 3
  if (existsSync(path.join(directory, 'episode-corrections.json'))) score += 3

  try {
    const executionDirectory = path.join(directory, 'organization-executions')
    if (existsSync(executionDirectory)) {
      score += readdirSync(executionDirectory).filter((entry) => entry.endsWith('.json')).length * 2
    }
  } catch {
    // An inaccessible candidate receives no score; don't delete or modify either candidate.
  }

  return score
}

/**
 * Selects the existing data folder used by Jellyfin Anime Supremo, keeping user data
 * in place during the KageShelf rebrand. If both legacy spellings exist, prefer the
 * directory with the most recognizable persisted application data. No files are moved
 * or deleted by this function.
 */
export function resolveLegacyUserDataPath(appDataRoot: string): string {
  const candidates = LEGACY_APP_DIRECTORY_NAMES.map((name) => path.join(appDataRoot, name))
  const existing = candidates.filter((candidate) => existsSync(candidate))

  if (existing.length === 0) return candidates[0]
  return existing.sort((a, b) => persistedDataScore(b) - persistedDataScore(a))[0]
}
