import { contextBridge, ipcRenderer } from 'electron'
import type { AniListAnime } from '../shared/anilistTypes'
import type { EpisodeCorrection, ExecutionHistoryEntry, ExecutionProgress, ExecutionResult, OrganizationPlan, OrganizationPlanValidation, RollbackResult, ScanResult } from '../shared/types'
import type { AniListSearchResponse, StoredAniListAssociation } from '../shared/anilistTypes'

contextBridge.exposeInMainWorld('kageShelf', {
  selectDirectory: (initialPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('dialog:select-directory', initialPath),
  defaultDestination: (sourcePath: string): Promise<string> =>
    ipcRenderer.invoke('path:default-destination', sourcePath),
  scan: (sourcePath: string, destinationPath: string): Promise<ScanResult> =>
    ipcRenderer.invoke('library:scan', sourcePath, destinationPath),
  buildOrganizationPlan: (result: ScanResult, aniListId?: number | null): Promise<OrganizationPlan> =>
    ipcRenderer.invoke('plan:build', result, aniListId ?? null),
  validateOrganizationPlan: (plan: OrganizationPlan): Promise<OrganizationPlanValidation> =>
    ipcRenderer.invoke('plan:validate', plan),
  approveOrganizationPlan: (planId: string, previewSignature: string): Promise<{ validation: OrganizationPlanValidation; approvedAt: string }> =>
    ipcRenderer.invoke('plan:approve', planId, previewSignature),
  executeOrganizationPlan: (planId: string): Promise<ExecutionResult> =>
    ipcRenderer.invoke('execution:run', planId),
  cancelOrganizationExecution: (planId: string): Promise<void> =>
    ipcRenderer.invoke('execution:cancel', planId),
  onExecutionProgress: (callback: (progress: ExecutionProgress) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ExecutionProgress) => callback(progress)
    ipcRenderer.on('execution:progress', listener)
    return () => ipcRenderer.removeListener('execution:progress', listener)
  },
  rollbackOrganizationExecution: (runId: string): Promise<RollbackResult> =>
    ipcRenderer.invoke('execution:rollback', runId),
  listOrganizationExecutionHistory: (): Promise<ExecutionHistoryEntry[]> =>
    ipcRenderer.invoke('execution:history'),
  resumeOrganizationExecution: (runId: string): Promise<ExecutionResult> =>
    ipcRenderer.invoke('execution:resume', runId),
  searchAniList: (query: string): Promise<AniListSearchResponse> =>
    ipcRenderer.invoke('anilist:search', query),
  openAniListPage: (animeId: number): Promise<void> =>
    ipcRenderer.invoke('anilist:open-page', animeId),
  defaultDestinationForAnime: (sourcePath: string, title: string, year: number | null): Promise<string> =>
    ipcRenderer.invoke('path:destination-for-anime', sourcePath, title, year),
  getAniListAssociation: (sourcePath: string): Promise<StoredAniListAssociation | null> =>
    ipcRenderer.invoke('association:get', sourcePath),
  saveAniListAssociation: (sourcePath: string, anime: AniListAnime): Promise<StoredAniListAssociation> =>
    ipcRenderer.invoke('association:save', sourcePath, anime),
  removeAniListAssociation: (sourcePath: string): Promise<void> =>
    ipcRenderer.invoke('association:delete', sourcePath),
  getEpisodeCorrections: (sourcePath: string): Promise<EpisodeCorrection[]> =>
    ipcRenderer.invoke('episode-corrections:get', sourcePath),
  saveEpisodeCorrection: (sourcePath: string, correction: EpisodeCorrection): Promise<EpisodeCorrection> =>
    ipcRenderer.invoke('episode-corrections:save', sourcePath, correction),
  removeEpisodeCorrection: (sourcePath: string, relativePath: string): Promise<void> =>
    ipcRenderer.invoke('episode-corrections:delete', sourcePath, relativePath)
})
