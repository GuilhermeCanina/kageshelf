import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import type {
  DestinationTargetSnapshot,
  MediaSnapshotEntry,
  OrganizationPlan,
  OrganizationPlanItem,
  OrganizationPlanValidation,
  PlanItemStatus,
  PreviewRow,
  ScanResult
} from '../shared/types'
import { previewSignature, summarizePlan } from '../shared/organizationPlan'
import { assertSafeSourceAndDestination, SUBTITLE_EXTENSIONS, VIDEO_EXTENSIONS } from './scanEngine'

interface ActualMediaFile extends MediaSnapshotEntry {
  absolutePath: string
  originalName: string
  extension: string
}

function normalizeRelative(value: string): string {
  const nativeNormalized = path.sep === '\\' ? value.replace(/\\/g, '/') : value
  return nativeNormalized.replace(/^\.\//, '')
}

function relativeKey(value: string, caseInsensitive: boolean): string {
  const normalized = normalizeRelative(value).normalize('NFKC')
  return caseInsensitive ? normalized.toLocaleLowerCase('en-US') : normalized
}

function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
}

function resolveSafeRelative(root: string, relativePath: string): string {
  const normalized = normalizeRelative(relativePath)
  if (!normalized || normalized.includes('\0') || path.posix.isAbsolute(normalized)) {
    throw new Error(`Caminho relativo inválido: ${relativePath}`)
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new Error(`O caminho contém segmentos inválidos: ${relativePath}`)
  }
  const resolved = path.resolve(root, ...segments)
  if (!inside(path.resolve(root), resolved) || resolved === path.resolve(root)) {
    throw new Error(`O caminho escapa da pasta raiz: ${relativePath}`)
  }
  return resolved
}

async function listSupportedMedia(root: string): Promise<ActualMediaFile[]> {
  const result: ActualMediaFile[] = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()!
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        pending.push(absolutePath)
        continue
      }
      if (!entry.isFile()) continue
      const extension = path.extname(entry.name).toLowerCase()
      const kind = VIDEO_EXTENSIONS.has(extension) ? 'video' : SUBTITLE_EXTENSIONS.has(extension) ? 'subtitle' : null
      if (!kind) continue
      const fileStat = await lstat(absolutePath)
      result.push({
        absolutePath,
        relativePath: normalizeRelative(path.relative(root, absolutePath)),
        originalName: entry.name,
        extension,
        kind,
        sizeBytes: fileStat.size,
        modifiedAtMs: Math.trunc(fileStat.mtimeMs)
      })
    }
  }
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true, sensitivity: 'base' }))
}

function metadataEqual(a: MediaSnapshotEntry[], b: MediaSnapshotEntry[], caseInsensitive: boolean): boolean {
  const project = (entries: MediaSnapshotEntry[]) => entries
    .map((entry) => `${entry.kind}\u0000${relativeKey(entry.relativePath, caseInsensitive)}\u0000${entry.sizeBytes}\u0000${entry.modifiedAtMs}`)
    .sort()
  const left = project(a)
  const right = project(b)
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function listExistingDestinationMedia(root: string): Promise<ActualMediaFile[]> {
  const rootStat = await lstatIfMissing(root)
  if (!rootStat) return []
  // A symlink or non-directory destination is treated as a conflict by target
  // inspection, never followed for inventory purposes.
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return []
  return listSupportedMedia(root)
}

function jellyfinEpisodeIdentity(relativePath: string): string | null {
  const baseName = path.posix.basename(normalizeRelative(relativePath))
  const match = baseName.match(/\bS(\d{1,2})E(\d{1,3})\b/i)
  if (!match) return null
  return `S${String(Number(match[1])).padStart(2, '0')}E${String(Number(match[2])).padStart(2, '0')}`
}

function duplicateIdentityCount(files: ActualMediaFile[]): number {
  const groups = new Map<string, number>()
  for (const file of files.filter((candidate) => candidate.kind === 'video')) {
    const identity = jellyfinEpisodeIdentity(file.relativePath)
    if (identity) groups.set(identity, (groups.get(identity) ?? 0) + 1)
  }
  return [...groups.values()].filter((count) => count > 1).length
}


async function lstatIfMissing(targetPath: string) {
  try {
    return await lstat(targetPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return null
    throw error
  }
}

function statusLabelForRow(row: PreviewRow): { status: PlanItemStatus; reason: string } {
  if (row.status === 'conflict') return { status: 'conflict', reason: row.note || 'A análise já identificou um conflito para este arquivo.' }
  if (row.status !== 'identified' || !row.outputRelativePath) return { status: 'review', reason: row.note || 'A identificação do episódio precisa ser revisada.' }
  return { status: 'ready', reason: row.manuallyCorrected ? 'Identificação corrigida manualmente e pronta para conferência.' : `Identificado por: ${row.method}.` }
}

const SUBTITLE_SUFFIX_TOKEN = '(?:[a-z]{2,3}(?:[-_][a-z0-9]{2,8})?|forced|sdh|cc|hi|default|commentary|signs|lyrics|dub|hearing[-_]?impaired|visual[-_]?impaired)'
const SUBTITLE_SUFFIX_REGEX = new RegExp(`(?:\\.${SUBTITLE_SUFFIX_TOKEN})+$`, 'i')
const SUBTITLE_SUFFIX_CAPTURE_REGEX = new RegExp(`((?:\\.${SUBTITLE_SUFFIX_TOKEN})+)$`, 'i')

function subtitleBase(stem: string): string {
  const nativeNormalized = path.sep === '\\' ? stem.replace(/\\/g, '/') : stem
  return nativeNormalized.replace(SUBTITLE_SUFFIX_REGEX, '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
}

function subtitleSuffix(stem: string): string {
  const match = stem.match(SUBTITLE_SUFFIX_CAPTURE_REGEX)
  return match?.[1] ?? ''
}

function sourceDirectory(relativePath: string): string {
  return path.posix.dirname(normalizeRelative(relativePath))
}

function outputFileStem(relativePath: string): string {
  const base = path.posix.basename(normalizeRelative(relativePath))
  return base.slice(0, base.length - path.posix.extname(base).length)
}

async function inspectTarget(destinationRoot: string, relativePath: string): Promise<DestinationTargetSnapshot> {
  const normalized = normalizeRelative(relativePath)
  const targetPath = resolveSafeRelative(destinationRoot, normalized)
  let current = path.resolve(destinationRoot)
  const rootStat = await lstatIfMissing(current)
  if (rootStat?.isSymbolicLink()) {
    return { relativePath: normalized, kind: 'blocked', sizeBytes: null, modifiedAtMs: null, reason: 'A pasta de destino é um link simbólico.' }
  }
  if (rootStat && !rootStat.isDirectory()) {
    return { relativePath: normalized, kind: 'blocked', sizeBytes: null, modifiedAtMs: null, reason: 'O caminho de destino existe, mas não é uma pasta.' }
  }

  const segments = path.relative(path.resolve(destinationRoot), targetPath).split(path.sep)
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment)
    const parentStat = await lstatIfMissing(current)
    if (!parentStat) break
    if (parentStat.isSymbolicLink()) {
      return { relativePath: normalized, kind: 'blocked', sizeBytes: null, modifiedAtMs: null, reason: `O caminho passa por um link simbólico (${path.relative(destinationRoot, current)}).` }
    }
    if (!parentStat.isDirectory()) {
      return { relativePath: normalized, kind: 'blocked', sizeBytes: null, modifiedAtMs: null, reason: `Um componente do destino não é uma pasta (${path.relative(destinationRoot, current)}).` }
    }
  }

  const targetStat = await lstatIfMissing(targetPath)
  if (!targetStat) return { relativePath: normalized, kind: 'missing', sizeBytes: null, modifiedAtMs: null, reason: null }
  const kind: DestinationTargetSnapshot['kind'] = targetStat.isSymbolicLink()
    ? 'symlink'
    : targetStat.isFile()
      ? 'file'
      : targetStat.isDirectory()
        ? 'directory'
        : 'other'
  return {
    relativePath: normalized,
    kind,
    sizeBytes: targetStat.isFile() ? targetStat.size : null,
    modifiedAtMs: Math.trunc(targetStat.mtimeMs),
    reason: kind === 'file' ? 'Já existe um arquivo neste destino.' : `O destino já existe como ${kind === 'symlink' ? 'link simbólico' : kind === 'directory' ? 'pasta' : 'outro tipo de objeto'}.`
  }
}

export async function buildOrganizationPlan(result: ScanResult, aniListId: number | null = null): Promise<OrganizationPlan> {
  if (!result || result.mode !== 'read-only-preview') throw new Error('A origem do plano precisa ser uma prévia somente leitura válida.')
  if (!result.sourcePath?.trim() || !result.destinationPath?.trim()) throw new Error('O plano exige pastas de origem e destino válidas.')

  const sourcePath = path.resolve(result.sourcePath)
  const destinationPath = path.resolve(result.destinationPath)
  assertSafeSourceAndDestination(sourcePath, destinationPath)
  const sourceStat = await lstat(sourcePath).catch(() => null)
  if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('A origem não existe, não é uma pasta ou é um link simbólico.')

  const caseInsensitive = result.caseInsensitivePaths === true
  const actualMedia = await listSupportedMedia(sourcePath)
  const existingDestinationMedia = await listExistingDestinationMedia(destinationPath)
  const destinationLibrarySnapshot: MediaSnapshotEntry[] = existingDestinationMedia.map(({ relativePath, kind, sizeBytes, modifiedAtMs }) => ({ relativePath, kind, sizeBytes, modifiedAtMs }))
  const destinationLibrarySummary = {
    total: existingDestinationMedia.length,
    videos: existingDestinationMedia.filter((file) => file.kind === 'video').length,
    subtitles: existingDestinationMedia.filter((file) => file.kind === 'subtitle').length,
    duplicateEpisodeIdentities: duplicateIdentityCount(existingDestinationMedia)
  }
  const currentSnapshot = actualMedia.map(({ relativePath, kind, sizeBytes, modifiedAtMs }) => ({ relativePath, kind, sizeBytes, modifiedAtMs }))
  const expectedSnapshot = [
    ...result.rows.map((row) => ({ relativePath: normalizeRelative(row.relativePath), kind: 'video' as const, sizeBytes: row.sizeBytes, modifiedAtMs: row.modifiedAtMs })),
    ...(result.subtitleFiles ?? []).map((file) => ({ relativePath: normalizeRelative(file.relativePath), kind: 'subtitle' as const, sizeBytes: file.sizeBytes, modifiedAtMs: file.modifiedAtMs }))
  ]
  const analysisOutdated = !metadataEqual(expectedSnapshot, currentSnapshot, caseInsensitive)
  const warnings: string[] = []
  if (analysisOutdated) warnings.push('A origem mudou desde a análise ou o resultado de análise não contém a assinatura completa das legendas. Reanalise antes de considerar o plano pronto.')
  if (existingDestinationMedia.length > 0) warnings.push(`Biblioteca de destino indexada: ${destinationLibrarySummary.videos} vídeo(s), ${destinationLibrarySummary.subtitles} legenda(s); arquivos existentes serão comparados antes de qualquer cópia.`)
  if (destinationLibrarySummary.duplicateEpisodeIdentities > 0) warnings.push(`${destinationLibrarySummary.duplicateEpisodeIdentities} identidade(s) de episódio duplicadas já existem na biblioteca de destino; revise antes de executar.`)

  const currentByPath = new Map<string, ActualMediaFile>()
  for (const file of actualMedia) currentByPath.set(relativeKey(file.relativePath, caseInsensitive), file)
  const itemByVideoPath = new Map<string, OrganizationPlanItem>()
  const items: OrganizationPlanItem[] = []

  for (const row of result.rows) {
    const relativePath = normalizeRelative(row.relativePath)
    let statusAndReason = statusLabelForRow(row)
    let destinationRelativePath: string | null = null
    const current = currentByPath.get(relativeKey(relativePath, caseInsensitive))

    if (!current || current.kind !== 'video' || current.sizeBytes !== row.sizeBytes || current.modifiedAtMs !== row.modifiedAtMs) {
      statusAndReason = { status: 'pending', reason: 'O arquivo foi removido ou mudou desde a análise. Reanalise a biblioteca.' }
    } else if (row.outputRelativePath) {
      try {
        const target = normalizeRelative(row.outputRelativePath)
        // Reject absolute paths and traversal before preserving a destination in the plan.
        resolveSafeRelative(destinationPath, target)
        destinationRelativePath = target
      } catch (error) {
        statusAndReason = { status: 'conflict', reason: error instanceof Error ? error.message : 'Caminho de destino inválido.' }
      }
    }

    const item: OrganizationPlanItem = {
      id: `video:${relativePath}`,
      kind: 'video',
      sourceRelativePath: relativePath,
      originalName: row.originalName,
      destinationRelativePath,
      sizeBytes: row.sizeBytes,
      modifiedAtMs: row.modifiedAtMs,
      status: statusAndReason.status,
      reason: statusAndReason.reason,
      contentKind: row.contentKind,
      season: row.season,
      episode: row.episode,
      manuallyCorrected: row.manuallyCorrected,
      confidence: row.confidence,
      method: row.method
    }
    items.push(item)
    itemByVideoPath.set(relativeKey(relativePath, caseInsensitive), item)
  }

  const rowKeys = new Set(result.rows.map((row) => relativeKey(row.relativePath, caseInsensitive)))
  for (const file of actualMedia.filter((candidate) => candidate.kind === 'video')) {
    if (rowKeys.has(relativeKey(file.relativePath, caseInsensitive))) continue
    items.push({
      id: `video-new:${file.relativePath}`,
      kind: 'video',
      sourceRelativePath: file.relativePath,
      originalName: file.originalName,
      destinationRelativePath: null,
      sizeBytes: file.sizeBytes,
      modifiedAtMs: file.modifiedAtMs,
      status: 'pending',
      reason: 'Este vídeo apareceu depois da análise e ainda não tem identificação. Reanalise a biblioteca.',
      contentKind: null,
      season: null,
      episode: null,
      manuallyCorrected: false,
      confidence: null,
      method: null
    })
  }

  const scannedSubtitles = new Map<string, NonNullable<ScanResult['subtitleFiles']>[number]>()
  for (const file of result.subtitleFiles ?? []) scannedSubtitles.set(relativeKey(file.relativePath, caseInsensitive), file)
  for (const subtitle of actualMedia.filter((candidate) => candidate.kind === 'subtitle')) {
    const scanned = scannedSubtitles.get(relativeKey(subtitle.relativePath, caseInsensitive))
    let status: PlanItemStatus = 'ready'
    let reason = 'Legenda pareada pelo nome-base com um único vídeo.'
    let destinationRelativePath: string | null = null
    let relatedVideoRelativePath: string | null = null

    if (!scanned || scanned.sizeBytes !== subtitle.sizeBytes || scanned.modifiedAtMs !== subtitle.modifiedAtMs) {
      status = 'pending'
      reason = 'A legenda foi adicionada ou mudou desde a análise. Reanalise a biblioteca.'
    } else {
      const subtitleStem = path.posix.basename(subtitle.relativePath).slice(0, -path.posix.extname(subtitle.relativePath).length)
      const subtitleDir = sourceDirectory(subtitle.relativePath)
      const matchKey = subtitleBase(subtitleStem)
      const sameDirectoryCandidates = result.rows.filter((row) => {
        const rowRel = normalizeRelative(row.relativePath)
        const rowStem = path.posix.basename(rowRel).slice(0, -path.posix.extname(rowRel).length)
        return sourceDirectory(rowRel) === subtitleDir && subtitleBase(rowStem) === matchKey
      })
      // Strongest match is same-folder + normalized basename. If none exists,
      // allow a global exact basename match only when it uniquely identifies a video.
      const globalCandidates = sameDirectoryCandidates.length > 0 ? sameDirectoryCandidates : result.rows.filter((row) => {
        const rowRel = normalizeRelative(row.relativePath)
        const rowStem = path.posix.basename(rowRel).slice(0, -path.posix.extname(rowRel).length)
        return subtitleBase(rowStem) === matchKey
      })
      const candidates = globalCandidates

      if (candidates.length === 0) {
        status = 'review'
        reason = 'Não encontrei um vídeo com nome-base correspondente. A legenda não receberá destino automaticamente.'
      } else if (candidates.length > 1) {
        status = 'review'
        reason = sameDirectoryCandidates.length === 0
          ? 'A legenda corresponde ao nome-base de vídeos em pastas diferentes; a associação precisa de revisão.'
          : 'Esta legenda pode corresponder a mais de um vídeo. A associação precisa de revisão.'
      } else {
        const videoRow = candidates[0]
        if (sourceDirectory(normalizeRelative(videoRow.relativePath)) !== subtitleDir) {
          reason = 'Legenda pareada por nome-base único em outra pasta da origem.'
        }
        const videoPlanItem = itemByVideoPath.get(relativeKey(videoRow.relativePath, caseInsensitive))
        relatedVideoRelativePath = normalizeRelative(videoRow.relativePath)
        if (!videoPlanItem || !videoPlanItem.destinationRelativePath || videoPlanItem.status !== 'ready') {
          status = videoPlanItem?.status === 'conflict' ? 'conflict' : 'review'
          reason = 'O vídeo correspondente ainda não está pronto; resolva a identificação do vídeo primeiro.'
        } else {
          const videoOutput = videoPlanItem.destinationRelativePath
          const targetStem = outputFileStem(videoOutput)
          const targetDirectory = path.posix.dirname(videoOutput)
          const suffix = subtitleSuffix(subtitleStem)
          destinationRelativePath = path.posix.join(targetDirectory === '.' ? '' : targetDirectory, `${targetStem}${suffix}${subtitle.extension}`)
        }
      }
    }

    items.push({
      id: `subtitle:${subtitle.relativePath}`,
      kind: 'subtitle',
      sourceRelativePath: subtitle.relativePath,
      originalName: subtitle.originalName,
      destinationRelativePath,
      sizeBytes: subtitle.sizeBytes,
      modifiedAtMs: subtitle.modifiedAtMs,
      status,
      reason,
      contentKind: null,
      season: null,
      episode: null,
      manuallyCorrected: false,
      confidence: null,
      method: null,
      relatedVideoRelativePath
    })
  }

  // Detect output path collisions among all proposed media outputs.
  const outputGroups = new Map<string, OrganizationPlanItem[]>()
  for (const item of items) {
    if (!item.destinationRelativePath) continue
    const key = relativeKey(item.destinationRelativePath, caseInsensitive)
    const group = outputGroups.get(key) ?? []
    group.push(item)
    outputGroups.set(key, group)
  }
  for (const group of outputGroups.values()) {
    if (group.length < 2) continue
    for (const item of group) {
      item.status = 'conflict'
      item.reason = 'Mais de um arquivo propõe o mesmo caminho de destino. Ajuste a associação antes de aprovar o plano.'
    }
  }

  const destinationTargets = [...new Set(items.map((item) => item.destinationRelativePath).filter((value): value is string => Boolean(value)))].sort()
  const destinationSnapshot: DestinationTargetSnapshot[] = []
  const snapshotByKey = new Map<string, DestinationTargetSnapshot>()
  for (const relativePath of destinationTargets) {
    const snapshot = await inspectTarget(destinationPath, relativePath)
    destinationSnapshot.push(snapshot)
    snapshotByKey.set(relativeKey(relativePath, caseInsensitive), snapshot)
  }

  for (const item of items) {
    if (!item.destinationRelativePath) continue
    const target = snapshotByKey.get(relativeKey(item.destinationRelativePath, caseInsensitive))
    if (target && target.kind !== 'missing') {
      item.status = 'conflict'
      item.reason = target.reason ?? 'O destino já existe. Sobrescrita automática não é permitida.'
      if (target.kind === 'file' && target.sizeBytes !== item.sizeBytes) {
        item.reason = `Já existe um arquivo neste destino com tamanho diferente (${target.sizeBytes ?? '?'} B vs. ${item.sizeBytes} B). Não será sobrescrito.`
      } else if (target.kind === 'file' && target.sizeBytes === item.sizeBytes) {
        try {
          const sourceFile = resolveSafeRelative(sourcePath, item.sourceRelativePath)
          const targetFile = resolveSafeRelative(destinationPath, item.destinationRelativePath)
          const [sourceHash, targetHash] = await Promise.all([sha256File(sourceFile), sha256File(targetFile)])
          item.reason = sourceHash === targetHash
            ? 'Já existe um arquivo com conteúdo idêntico neste destino (SHA-256 igual). A cópia está bloqueada para evitar duplicação.'
            : 'Já existe um arquivo com o mesmo tamanho, mas conteúdo diferente (SHA-256 divergente). Resolva o conflito manualmente.'
        } catch {
          item.reason = 'Já existe um arquivo neste destino; não foi possível comparar o conteúdo com segurança.'
        }
      }
    }
  }

  // Index the existing organized library. A destination path collision above
  // catches exact output names; this second pass catches duplicate Jellyfin
  // episode identities under a different filename or subfolder.
  const existingIdentities = new Map<string, ActualMediaFile[]>()
  for (const file of existingDestinationMedia.filter((candidate) => candidate.kind === 'video')) {
    const identity = jellyfinEpisodeIdentity(file.relativePath)
    if (!identity) continue
    const group = existingIdentities.get(identity) ?? []
    group.push(file)
    existingIdentities.set(identity, group)
  }
  for (const item of items) {
    if (item.kind !== 'video' || !item.destinationRelativePath || item.status === 'conflict') continue
    const identity = jellyfinEpisodeIdentity(item.destinationRelativePath)
    if (!identity) continue
    const existing = (existingIdentities.get(identity) ?? []).filter((file) => relativeKey(file.relativePath, caseInsensitive) !== relativeKey(item.destinationRelativePath!, caseInsensitive))
    if (existing.length > 0) {
      item.status = 'conflict'
      item.reason = `A biblioteca de destino já contém a identidade ${identity} em ${existing.map((file) => `“${file.relativePath}”`).join(', ')}. A duplicação foi bloqueada.`
    }
  }

  items.sort((a, b) => a.sourceRelativePath.localeCompare(b.sourceRelativePath, undefined, { numeric: true, sensitivity: 'base' }) || a.kind.localeCompare(b.kind))
  const summary = summarizePlan(items)
  if (summary.review > 0) warnings.push(`${summary.review} item(ns) precisam de revisão antes que o plano possa ser aprovado.`)
  if (summary.conflict > 0) warnings.push(`${summary.conflict} conflito(s) precisam ser resolvidos; arquivos existentes não serão sobrescritos.`)
  if (summary.pending > 0) warnings.push(`${summary.pending} item(ns) estão pendentes porque a análise está desatualizada ou incompleta.`)
  if (summary.ready === 0) warnings.push('Nenhum item está pronto para uma futura organização.')

  return {
    id: randomUUID(),
    generatedAt: new Date().toISOString(),
    sourcePath,
    destinationPath,
    previewSignature: previewSignature(result),
    seriesName: result.seriesName,
    aniListId: aniListId !== null && Number.isSafeInteger(aniListId) && aniListId > 0 ? aniListId : null,
    videoCount: result.videoCount,
    subtitleCount: result.subtitleCount,
    analysisOutdated,
    sourceSnapshot: currentSnapshot,
    destinationSnapshot,
    destinationLibrarySnapshot,
    destinationLibrarySummary,
    items,
    summary,
    warnings: [...new Set(warnings)],
    validation: null,
    approvedAt: null
  }
}

function snapshotsEqual(a: DestinationTargetSnapshot, b: DestinationTargetSnapshot): boolean {
  return a.relativePath === b.relativePath
    && a.kind === b.kind
    && a.sizeBytes === b.sizeBytes
    && a.modifiedAtMs === b.modifiedAtMs
    && a.reason === b.reason
}

export async function validateOrganizationPlan(plan: OrganizationPlan): Promise<OrganizationPlanValidation> {
  const issues: string[] = []
  const sourcePath = path.resolve(plan.sourcePath)
  const destinationPath = path.resolve(plan.destinationPath)
  assertSafeSourceAndDestination(sourcePath, destinationPath)

  if (plan.analysisOutdated) issues.push('A análise já estava desatualizada quando o plano foi criado. Reanalise e gere outro plano.')

  let currentSourceSnapshot: MediaSnapshotEntry[] = []
  try {
    const rootStat = await lstat(sourcePath)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('A origem não existe, não é uma pasta ou é um link simbólico.')
    const media = await listSupportedMedia(sourcePath)
    currentSourceSnapshot = media.map(({ relativePath, kind, sizeBytes, modifiedAtMs }) => ({ relativePath, kind, sizeBytes, modifiedAtMs }))
    const insensitive = process.platform === 'win32'
    if (!metadataEqual(plan.sourceSnapshot, currentSourceSnapshot, insensitive)) {
      issues.push('Os vídeos ou as legendas da origem mudaram desde a geração do plano. Reanalise a biblioteca e gere outro plano.')
    }
  } catch (error) {
    issues.push(`Não foi possível verificar a origem: ${error instanceof Error ? error.message : String(error)}`)
  }

  for (const target of plan.destinationSnapshot) {
    try {
      const current = await inspectTarget(destinationPath, target.relativePath)
      if (!snapshotsEqual(target, current)) {
        issues.push(`O destino "${target.relativePath}" mudou desde a geração do plano. Gere e revise um novo plano.`)
      }
    } catch (error) {
      issues.push(`Não foi possível verificar o destino "${target.relativePath}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (plan.destinationLibrarySnapshot) {
    try {
      const currentMedia = await listExistingDestinationMedia(destinationPath)
      const currentSnapshot = currentMedia.map(({ relativePath, kind, sizeBytes, modifiedAtMs }) => ({ relativePath, kind, sizeBytes, modifiedAtMs }))
      if (!metadataEqual(plan.destinationLibrarySnapshot, currentSnapshot, process.platform === 'win32')) {
        issues.push('A biblioteca de destino mudou desde a geração do plano. Atualize o índice e gere/revalide novamente antes da execução.')
      }
    } catch (error) {
      issues.push(`Não foi possível indexar a biblioteca de destino: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const uniqueIssues = [...new Set(issues)]
  return { checkedAt: new Date().toISOString(), fresh: uniqueIssues.length === 0, issues: uniqueIssues }
}
