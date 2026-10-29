import type { AniListAnime, AniListSearchResponse, StoredAniListAssociation } from './anilistTypes'

export type Confidence = 'alta' | 'média' | 'baixa'
export type RowStatus = 'identified' | 'review' | 'ambiguous' | 'conflict'
export type ContentKind = 'episode' | 'special' | 'movie'
export type MediaFileKind = 'video' | 'subtitle'
export type PlanItemStatus = 'ready' | 'review' | 'conflict' | 'pending'

export interface SubtitleFileInfo {
  relativePath: string
  originalName: string
  extension: string
  sizeBytes: number
  modifiedAtMs: number
}

export interface PreviewRow {
  id: string
  originalName: string
  relativePath: string
  extension: string
  sizeBytes: number
  /** File modification time rounded to milliseconds, used to invalidate stale corrections. */
  modifiedAtMs: number
  season: number | null
  episode: number | null
  contentKind: ContentKind
  /** Optional recognized label for a special, e.g. "OVA 01". */
  specialLabel?: string | null
  manuallyCorrected: boolean
  /** Parser result before duplicate detection/manual overrides. */
  detectedStatus: RowStatus
  /** Original parser note, unaffected by transient duplicate/conflict messages. */
  detectedNote: string
  confidence: Confidence | null
  method: string
  status: RowStatus
  statusLabel: string
  outputRelativePath: string | null
  note: string
}

export interface EpisodeCorrection {
  relativePath: string
  originalName: string
  sizeBytes: number
  modifiedAtMs: number
  contentKind: ContentKind
  specialLabel?: string | null
  season: number | null
  episode: number | null
  updatedAt: string
}

export interface ScanResult {
  sourcePath: string
  destinationPath: string
  seriesName: string
  destinationFolderName: string
  videoCount: number
  subtitleCount: number
  /** Metadata snapshot for every subtitle found during the read-only scan. */
  subtitleFiles?: SubtitleFileInfo[]
  totalVideoBytes: number
  rows: PreviewRow[]
  warnings: string[]
  scanDurationMs: number
  mode: 'read-only-preview'
  /** True when the host filesystem is case-insensitive for duplicate destination checks (Windows). */
  caseInsensitivePaths?: boolean
}


export interface MediaSnapshotEntry {
  relativePath: string
  kind: MediaFileKind
  sizeBytes: number
  modifiedAtMs: number
}

export interface DestinationTargetSnapshot {
  relativePath: string
  kind: 'missing' | 'file' | 'directory' | 'symlink' | 'other' | 'blocked'
  sizeBytes: number | null
  modifiedAtMs: number | null
  reason: string | null
}

export interface OrganizationPlanItem {
  id: string
  kind: MediaFileKind
  sourceRelativePath: string
  originalName: string
  destinationRelativePath: string | null
  sizeBytes: number
  modifiedAtMs: number
  status: PlanItemStatus
  reason: string
  /** Identification decisions captured from the preview for auditability; null for subtitle rows. */
  contentKind: ContentKind | null
  season: number | null
  episode: number | null
  manuallyCorrected: boolean
  confidence: Confidence | null
  method: string | null
  relatedVideoRelativePath?: string | null
}

export interface OrganizationPlanSummary {
  ready: number
  review: number
  conflict: number
  pending: number
  total: number
  totalBytes: number
}

export interface OrganizationPlanValidation {
  checkedAt: string
  fresh: boolean
  issues: string[]
}

export interface OrganizationPlan {
  id: string
  generatedAt: string
  sourcePath: string
  destinationPath: string
  previewSignature: string
  seriesName: string
  aniListId: number | null
  videoCount: number
  subtitleCount: number
  analysisOutdated: boolean
  sourceSnapshot: MediaSnapshotEntry[]
  destinationSnapshot: DestinationTargetSnapshot[]
  /** Existing supported media in the destination when the plan was created. */
  destinationLibrarySnapshot?: MediaSnapshotEntry[]
  /** Small summary used by the UI to show that the target already contains media. */
  destinationLibrarySummary?: { total: number; videos: number; subtitles: number; duplicateEpisodeIdentities: number }
  items: OrganizationPlanItem[]
  summary: OrganizationPlanSummary
  warnings: string[]
  validation: OrganizationPlanValidation | null
  approvedAt: string | null
}



export type ExecutionStatus = 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'rolled-back' | 'partially-rolled-back'
export type ExecutionStage = 'preparing' | 'copying' | 'completed' | 'cancelled' | 'failed' | 'rolling-back'

export interface ExecutionProgress {
  runId: string
  planId: string
  stage: ExecutionStage
  completedFiles: number
  totalFiles: number
  bytesCopied: number
  totalBytes: number
  currentFile: string | null
  message: string
}

export interface ExecutionFileRecord {
  sourceRelativePath: string
  destinationRelativePath: string
  sizeBytes: number
  sha256: string
  destinationModifiedAtMs: number
  kind: MediaFileKind
  /** Present when rollback successfully removed this generated destination. */
  rolledBackAt?: string
  /** Exact staging path used by the publication, for ownership-checked cleanup. */
  stagingRelativePath?: string
}

export interface ExecutionJournalItem {
  sourceRelativePath: string
  destinationRelativePath: string
  sizeBytes: number
  modifiedAtMs: number
  kind: MediaFileKind
}

export interface PendingPublication {
  sourceRelativePath: string
  destinationRelativePath: string
  tempRelativePath: string
  sizeBytes: number
  sha256: string
  tempDevice: number
  tempInode: number
  modifiedAtMs: number
  kind: MediaFileKind
  itemIndex: number
  method: 'hard-link' | 'exclusive-copy'
}

export interface PendingRollback {
  destinationRelativePath: string
  sha256: string
  sizeBytes: number
  device: number
  inode: number
  modifiedAtMs: number
}

export interface ExecutionJournal {
  /** Schema v1 is treated as legacy 0.7.1; new journals use schema v2. */
  schemaVersion?: number
  runId: string
  planId: string
  createdAt: string
  finishedAt: string | null
  status: ExecutionStatus | 'running'
  sourcePath: string
  destinationPath: string
  /** Full immutable item list retained to allow safe resume after interruption. */
  items?: ExecutionJournalItem[]
  /** Number of execution attempts, including safe resumes. */
  attempts?: number
  /** Durable intent written before publishing a fully verified temporary file. */
  pendingPublication?: PendingPublication | null
  /** Durable intent used to reconcile a rollback interrupted after unlink. */
  pendingRollback?: PendingRollback | null
  files: ExecutionFileRecord[]
  errors: string[]
}

export interface ExecutionHistoryEntry {
  runId: string
  planId: string
  createdAt: string
  finishedAt: string | null
  status: ExecutionStatus | 'running'
  sourcePath: string
  destinationPath: string
  totalFiles: number
  completedFiles: number
  remainingFiles: number
  rolledBackFiles: number
  attempts: number
  copiedBytes: number
  errors: string[]
  resumable: boolean
  rollbackAvailable: boolean
}

export interface ExecutionResult {
  runId: string
  planId: string
  status: ExecutionStatus
  copiedFiles: number
  copiedBytes: number
  errors: string[]
  rollbackAvailable: boolean
}

export interface RollbackResult {
  runId: string
  removedFiles: number
  skippedFiles: number
  errors: string[]
}

export interface OrganizationPlanApproval { validation: OrganizationPlanValidation; approvedAt: string }

export interface KageShelfApi {
  selectDirectory: (initialPath?: string) => Promise<string | null>
  defaultDestination: (sourcePath: string) => Promise<string>
  scan: (sourcePath: string, destinationPath: string) => Promise<ScanResult>
  buildOrganizationPlan: (result: ScanResult, aniListId?: number | null) => Promise<OrganizationPlan>
  validateOrganizationPlan: (plan: OrganizationPlan) => Promise<OrganizationPlanValidation>
  approveOrganizationPlan: (planId: string, previewSignature: string) => Promise<OrganizationPlanApproval>
  executeOrganizationPlan: (planId: string) => Promise<ExecutionResult>
  cancelOrganizationExecution: (planId: string) => Promise<void>
  onExecutionProgress: (callback: (progress: ExecutionProgress) => void) => () => void
  rollbackOrganizationExecution: (runId: string) => Promise<RollbackResult>
  listOrganizationExecutionHistory: () => Promise<ExecutionHistoryEntry[]>
  resumeOrganizationExecution: (runId: string) => Promise<ExecutionResult>
  searchAniList: (query: string) => Promise<AniListSearchResponse>
  openAniListPage: (animeId: number) => Promise<void>
  defaultDestinationForAnime: (sourcePath: string, title: string, year: number | null) => Promise<string>
  getAniListAssociation: (sourcePath: string) => Promise<StoredAniListAssociation | null>
  saveAniListAssociation: (sourcePath: string, anime: AniListAnime) => Promise<StoredAniListAssociation>
  removeAniListAssociation: (sourcePath: string) => Promise<void>
  getEpisodeCorrections: (sourcePath: string) => Promise<EpisodeCorrection[]>
  saveEpisodeCorrection: (sourcePath: string, correction: EpisodeCorrection) => Promise<EpisodeCorrection>
  removeEpisodeCorrection: (sourcePath: string, relativePath: string) => Promise<void>
}
