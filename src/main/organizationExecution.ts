import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type {
  ExecutionFileRecord,
  ExecutionHistoryEntry,
  ExecutionJournal,
  ExecutionJournalItem,
  ExecutionProgress,
  ExecutionResult,
  OrganizationPlan,
  PendingPublication,
  RollbackResult
} from '../shared/types'
import { validateOrganizationPlan } from './organizationPlan'
import { assertSafeSourceAndDestinationPhysical } from './scanEngine'

const JOURNAL_DIR = 'organization-executions'
const RESUMABLE_STATUSES = new Set(['cancelled', 'failed', 'interrupted'])

function normalizeRelative(value: string): string {
  const nativeNormalized = path.sep === '\\' ? value.replace(/\\/g, '/') : value
  return nativeNormalized.replace(/^\.\//, '')
}

function safeResolve(root: string, relative: string): string {
  const normalized = normalizeRelative(relative)
  if (!normalized || normalized.includes('\0') || path.posix.isAbsolute(normalized)) throw new Error(`Caminho relativo inválido: ${relative}`)
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || (process.platform === 'win32' && (part.includes(':') || /[<>"|?*]/.test(part))))) throw new Error(`Caminho relativo inseguro: ${relative}`)
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, ...parts)
  const rel = path.relative(resolvedRoot, resolved)
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`O destino sai da pasta raiz: ${relative}`)
  return resolved
}

async function lstatMissing(filePath: string) {
  try { return await lstat(filePath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Walk/create directory components one by one, rejecting symlinks and non-directories. */
async function ensureDirectoryChain(directoryPath: string): Promise<void> {
  const resolved = path.resolve(directoryPath)
  const parsed = path.parse(resolved)
  const components = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)
  let current = parsed.root
  for (const component of components) {
    current = path.join(current, component)
    let info = await lstatMissing(current)
    if (!info) {
      let created = false
      try {
        await mkdir(current, { mode: 0o755 })
        created = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      info = await lstat(current)
      // Jellyfin commonly runs under a separate account on Linux. Newly created
      // library directories should be traversable by that service account.
      if (created && process.platform !== 'win32') await chmod(current, 0o755)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Caminho de pasta inseguro: ${current}`)
  }
}

async function assertNoSymlinkParents(root: string, relative: string, includeTarget: boolean): Promise<string> {
  const target = safeResolve(root, relative)
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`A pasta raiz não é segura: ${root}`)
  const parts = normalizeRelative(relative).split('/')
  let current = path.resolve(root)
  for (const part of parts.slice(0, includeTarget ? parts.length : -1)) {
    current = path.join(current, part)
    const info = await lstatMissing(current)
    if (!info) break
    if (info.isSymbolicLink()) throw new Error(`Link simbólico não permitido no caminho: ${current}`)
    if (current !== target && !info.isDirectory()) throw new Error(`Componente não é uma pasta: ${current}`)
  }
  return target
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function journalPath(userDataDir: string, runId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new Error('Identificador de execução inválido.')
  return path.join(userDataDir, JOURNAL_DIR, `${runId}.json`)
}

async function saveJournal(userDataDir: string, journal: ExecutionJournal): Promise<void> {
  journal.schemaVersion = 2
  journal.pendingRollback ??= null
  const directory = path.join(userDataDir, JOURNAL_DIR)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const target = journalPath(userDataDir, journal.runId)
  const temp = `${target}.${randomUUID()}.tmp`
  const handle = await open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(journal, null, 2), 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temp).catch(() => undefined)
    throw error
  } finally {
    await handle.close().catch(() => undefined)
  }
  try {
    await rename(temp, target)
    // Best-effort directory sync makes the atomic journal replacement more
    // resilient to power loss on POSIX. Some platforms do not allow syncing dirs.
    if (process.platform !== 'win32') {
      try {
        const directoryHandle = await open(directory, 'r')
        try { await directoryHandle.sync() } finally { await directoryHandle.close() }
      } catch { /* Unsupported by this filesystem; the journal file itself was synced. */ }
    }
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

async function readJournal(userDataDir: string, runId: string): Promise<ExecutionJournal> {
  const parsed = JSON.parse(await readFile(journalPath(userDataDir, runId), 'utf8')) as ExecutionJournal
  const validStatuses = new Set(['completed', 'cancelled', 'failed', 'interrupted', 'rolled-back', 'partially-rolled-back', 'running'])
  if (!parsed || parsed.runId !== runId || !Array.isArray(parsed.files) || !Array.isArray(parsed.errors) ||
      (parsed.schemaVersion !== undefined && ![1, 2].includes(parsed.schemaVersion)) ||
      typeof parsed.sourcePath !== 'string' || !path.isAbsolute(parsed.sourcePath) ||
      typeof parsed.destinationPath !== 'string' || !path.isAbsolute(parsed.destinationPath) ||
      typeof parsed.planId !== 'string' || !validStatuses.has(parsed.status)) {
    throw new Error('Registro de execução inválido.')
  }
  if (parsed.schemaVersion === 2 && parsed.pendingRollback === undefined) throw new Error('Diário v2 sem campo de recuperação de rollback.')
  if (parsed.items !== undefined && !Array.isArray(parsed.items)) throw new Error('Lista de itens inválida no diário.')
  for (const item of parsed.items ?? []) {
    if (!item || typeof item.sourceRelativePath !== 'string' || typeof item.destinationRelativePath !== 'string' ||
        !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 || !Number.isFinite(item.modifiedAtMs) ||
        !['video', 'subtitle'].includes(item.kind)) throw new Error('Item inválido no diário.')
    safeResolve(parsed.sourcePath, item.sourceRelativePath)
    safeResolve(parsed.destinationPath, item.destinationRelativePath)
  }
  for (const file of parsed.files) {
    if (!file || typeof file.sourceRelativePath !== 'string' || typeof file.destinationRelativePath !== 'string' ||
        !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || !/^[a-f0-9]{64}$/i.test(file.sha256) ||
        !Number.isFinite(file.destinationModifiedAtMs) || !['video', 'subtitle'].includes(file.kind)) {
      throw new Error('Registro de arquivo inválido no diário.')
    }
    safeResolve(parsed.sourcePath, file.sourceRelativePath)
    safeResolve(parsed.destinationPath, file.destinationRelativePath)
  }
  const pendingRollback = parsed.pendingRollback
  if (pendingRollback !== undefined && pendingRollback !== null) {
    if (typeof pendingRollback.destinationRelativePath !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(pendingRollback.sha256) ||
        !Number.isSafeInteger(pendingRollback.sizeBytes) || pendingRollback.sizeBytes < 0 ||
        !Number.isFinite(pendingRollback.device) || !Number.isFinite(pendingRollback.inode) ||
        !Number.isFinite(pendingRollback.modifiedAtMs)) {
      throw new Error('Intenção de rollback inválida no diário.')
    }
    safeResolve(parsed.destinationPath, pendingRollback.destinationRelativePath)
  }
  const pending = parsed.pendingPublication
  if (pending) {
    if (!parsed.items || !Number.isInteger(pending.itemIndex) || pending.itemIndex < 0 || pending.itemIndex >= parsed.items.length ||
        typeof pending.tempRelativePath !== 'string' || !/^[a-f0-9]{64}$/i.test(pending.sha256) ||
        !Number.isSafeInteger(pending.sizeBytes) || pending.sizeBytes < 0 ||
        !Number.isFinite(pending.tempDevice) || !Number.isFinite(pending.tempInode) ||
        !['hard-link', 'exclusive-copy'].includes(pending.method)) throw new Error('Intenção de publicação inválida no diário.')
    safeResolve(parsed.destinationPath, pending.destinationRelativePath)
    safeResolve(parsed.destinationPath, pending.tempRelativePath)
  }
  return parsed
}

function toResult(journal: ExecutionJournal): ExecutionResult {
  return {
    runId: journal.runId,
    planId: journal.planId,
    status: journal.status === 'running' ? 'interrupted' : journal.status,
    copiedFiles: journal.files.length,
    copiedBytes: journal.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    errors: [...journal.errors],
    rollbackAvailable: Boolean(journal.pendingPublication) || (journal.files.some((file) => !file.rolledBackAt) && journal.status !== 'rolled-back')
  }
}

function makeJournalItems(plan: OrganizationPlan): ExecutionJournalItem[] {
  return plan.items.map((item) => ({
    sourceRelativePath: item.sourceRelativePath,
    destinationRelativePath: item.destinationRelativePath!,
    sizeBytes: item.sizeBytes,
    modifiedAtMs: item.modifiedAtMs,
    kind: item.kind
  }))
}

function partialRelativePath(item: ExecutionJournalItem, runId: string, index: number, token = randomUUID()): string {
  const normalized = normalizeRelative(item.destinationRelativePath)
  const parts = normalized.split('/')
  const filename = parts.pop()!
  parts.push(`.${filename}.${runId}.${index}.${token}.partial`)
  return parts.join('/')
}

/** Legacy 0.7.1 staging path, checked only for an inode match with the final file. */
function legacyPartialRelativePath(item: ExecutionJournalItem, runId: string, index: number): string {
  const parts = normalizeRelative(item.destinationRelativePath).split('/')
  const filename = parts.pop()!
  parts.push(`.${filename}.${runId}.${index}.partial`)
  return parts.join('/')
}

async function unlinkOwnedTemp(tempPath: string, expected: { dev: number; ino: number } | null): Promise<void> {
  if (!expected) return
  const info = await lstatMissing(tempPath)
  if (!info) return
  if (info.isFile() && !info.isSymbolicLink() && info.dev === expected.dev && info.ino === expected.ino) {
    await unlink(tempPath)
  }
}

function isHardLinkUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EXDEV' || code === 'EMLINK'
}

/**
 * Reconcile an interrupted publication. We only auto-adopt a visible final path
 * when its device+inode prove it is the same file as the staged hard link.
 * Legacy exclusive-copy journals have no portable inode identity, so an
 * existing unjournaled target is conservatively preserved for manual inspection.
 */
export async function reconcilePendingPublication(journal: ExecutionJournal, userDataDir: string): Promise<void> {
  const pending: PendingPublication | null | undefined = journal.pendingPublication
  if (!pending) return
  const item = journal.items?.[pending.itemIndex]
  if (!item || item.sourceRelativePath !== pending.sourceRelativePath || item.destinationRelativePath !== pending.destinationRelativePath) {
    throw new Error('Intenção de publicação inválida no diário; nenhum arquivo foi removido.')
  }
  const target = await assertNoSymlinkParents(journal.destinationPath, pending.destinationRelativePath, true)
  const temp = await assertNoSymlinkParents(journal.destinationPath, pending.tempRelativePath, true)
  const targetInfo = await lstatMissing(target)
  const tempInfo = await lstatMissing(temp)

  if (!targetInfo) {
    if (tempInfo) {
      if (!tempInfo.isFile() || tempInfo.isSymbolicLink() || tempInfo.dev !== pending.tempDevice || tempInfo.ino !== pending.tempInode || tempInfo.size !== pending.sizeBytes || await sha256(temp) !== pending.sha256) {
        throw new Error(`Temporário de publicação alterado; preservado para inspeção: ${pending.tempRelativePath}`)
      }
      await unlink(temp)
    }
    journal.pendingPublication = null
    await saveJournal(userDataDir, journal)
    return
  }

  if (pending.method === 'hard-link' && targetInfo.isFile() && !targetInfo.isSymbolicLink() && targetInfo.dev === pending.tempDevice && targetInfo.ino === pending.tempInode && targetInfo.size === pending.sizeBytes && await sha256(target) === pending.sha256) {
    const existing = journal.files.find((file) => file.destinationRelativePath === pending.destinationRelativePath)
    if (existing && (existing.sizeBytes !== pending.sizeBytes || existing.sha256 !== pending.sha256)) {
      throw new Error(`Diário inconsistente para publicação interrompida: ${pending.destinationRelativePath}`)
    }
    if (!existing) {
      journal.files.push({
        sourceRelativePath: pending.sourceRelativePath,
        destinationRelativePath: pending.destinationRelativePath,
        sizeBytes: pending.sizeBytes,
        sha256: pending.sha256,
        destinationModifiedAtMs: Math.trunc(targetInfo.mtimeMs),
        kind: pending.kind,
        stagingRelativePath: pending.tempRelativePath
      })
    }
    journal.pendingPublication = null
    await saveJournal(userDataDir, journal)
    if (tempInfo && tempInfo.isFile() && !tempInfo.isSymbolicLink() && tempInfo.dev === pending.tempDevice && tempInfo.ino === pending.tempInode) {
      await unlink(temp).catch(() => undefined)
    }
    return
  }

  throw new Error(`Existe um destino após a interrupção, mas não é possível provar que foi publicado por esta execução: ${pending.destinationRelativePath}. Ele foi preservado; revise-o manualmente.`)
}

async function cleanTempsForRecordedFiles(journal: ExecutionJournal): Promise<void> {
  if (!journal.items) return
  for (const file of journal.files) {
    const index = journal.items.findIndex((item) => item.destinationRelativePath === file.destinationRelativePath)
    if (index < 0) continue
    const item = journal.items[index]
    const candidates = file.stagingRelativePath
      ? [file.stagingRelativePath]
      : [legacyPartialRelativePath(item, journal.runId, index)]
    const target = await assertNoSymlinkParents(journal.destinationPath, file.destinationRelativePath, true)
    const targetInfo = await lstatMissing(target)
    if (!targetInfo || !targetInfo.isFile() || targetInfo.isSymbolicLink() || targetInfo.size !== file.sizeBytes || await sha256(target) !== file.sha256) continue

    for (const relative of candidates) {
      const temp = await assertNoSymlinkParents(journal.destinationPath, relative, true)
      const tempInfo = await lstatMissing(temp)
      if (!tempInfo || !tempInfo.isFile() || tempInfo.isSymbolicLink()) continue
      // A matching hash alone is not proof of ownership. Only unlink a leftover
      // hard link that has the same device+inode as the final file recorded here.
      if (tempInfo.dev === targetInfo.dev && tempInfo.ino === targetInfo.ino &&
          tempInfo.size === file.sizeBytes && await sha256(temp) === file.sha256) {
        await unlink(temp)
      }
    }
  }
}

async function verifyRecordedFiles(journal: ExecutionJournal): Promise<void> {
  for (const file of journal.files) {
    const target = await assertNoSymlinkParents(journal.destinationPath, file.destinationRelativePath, true)
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.sizeBytes || await sha256(target) !== file.sha256) {
      throw new Error(`Não é seguro retomar: um arquivo já concluído está ausente ou foi alterado: ${file.destinationRelativePath}`)
    }
  }
}

async function validateRemainingItems(journal: ExecutionJournal): Promise<void> {
  if (!journal.items) throw new Error('Este registro é de uma versão antiga e não contém dados suficientes para retomar. Gere um novo plano.')
  const completed = new Set(journal.files.map((file) => file.destinationRelativePath))
  await ensureDirectoryChain(journal.destinationPath)
  for (const [index, item] of journal.items.entries()) {
    // Revalidate every source, including already-copied items, to avoid mixing
    // files from different source states during a resumed run.
    const source = await assertNoSymlinkParents(journal.sourcePath, item.sourceRelativePath, true)
    const sourceInfo = await lstat(source)
    if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.size !== item.sizeBytes || Math.trunc(sourceInfo.mtimeMs) !== item.modifiedAtMs) {
      throw new Error(`Não é seguro retomar: a origem mudou desde o plano: ${item.sourceRelativePath}`)
    }
    if (completed.has(item.destinationRelativePath)) continue
    const target = safeResolve(journal.destinationPath, item.destinationRelativePath)
    await ensureDirectoryChain(path.dirname(target))
    if (await lstatMissing(target)) throw new Error(`Não é seguro retomar porque o destino já existe e ainda não está registrado como concluído: ${item.destinationRelativePath}`)
  }
}

async function runJournal(
  journal: ExecutionJournal,
  userDataDir: string,
  emit: (progress: ExecutionProgress) => void,
  isCancelled: () => boolean
): Promise<ExecutionResult> {
  if (!journal.items) throw new Error('O registro não contém a lista de itens necessária para executar ou retomar.')
  const items = journal.items
  const totalFiles = items.length
  const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0)
  let bytesCopied = journal.files.reduce((sum, file) => sum + file.sizeBytes, 0)
  let completedFiles = journal.files.length
  const completedDestinations = new Set(journal.files.map((file) => file.destinationRelativePath))
  const progress = (stage: ExecutionProgress['stage'], currentFile: string | null, message: string) => emit({ runId: journal.runId, planId: journal.planId, stage, completedFiles, totalFiles, bytesCopied, totalBytes, currentFile, message })

  try {
    progress('preparing', null, completedFiles > 0 ? 'Retomando: arquivos previamente verificados serão preservados.' : 'Validando destinos e preparando a cópia.')
    await assertSafeSourceAndDestinationPhysical(journal.sourcePath, journal.destinationPath)
    const destRootBefore = await lstatMissing(journal.destinationPath)
    if (destRootBefore?.isSymbolicLink() || (destRootBefore && !destRootBefore.isDirectory())) throw new Error('A pasta de destino existe e não é segura.')
    await ensureDirectoryChain(journal.destinationPath)

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (completedDestinations.has(item.destinationRelativePath)) continue
      if (isCancelled()) {
        journal.status = 'cancelled'
        break
      }
      const source = await assertNoSymlinkParents(journal.sourcePath, item.sourceRelativePath, true)
      const sourceStat = await lstat(source)
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error(`A origem não é um arquivo regular: ${item.sourceRelativePath}`)
      if (sourceStat.size !== item.sizeBytes || Math.trunc(sourceStat.mtimeMs) !== item.modifiedAtMs) throw new Error(`A origem mudou antes da cópia: ${item.sourceRelativePath}`)

      const target = safeResolve(journal.destinationPath, item.destinationRelativePath)
      const targetParent = path.dirname(target)
      await ensureDirectoryChain(targetParent)
      if (await lstatMissing(target)) throw new Error(`O destino já existe; não será sobrescrito: ${item.destinationRelativePath}`)
      const tempRelative = partialRelativePath(item, journal.runId, index)
      const temp = safeResolve(journal.destinationPath, tempRelative)
      const hash = createHash('sha256')
      let currentBytes = 0
      let lastEmit = 0
      progress('copying', item.sourceRelativePath, `Copiando ${item.sourceRelativePath}`)
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (isCancelled()) { callback(new Error('JAS_EXECUTION_CANCELLED')); return }
          hash.update(chunk)
          currentBytes += chunk.length
          const now = Date.now()
          if (now - lastEmit >= 120) {
            lastEmit = now
            emit({ runId: journal.runId, planId: journal.planId, stage: 'copying', completedFiles, totalFiles, bytesCopied: bytesCopied + currentBytes, totalBytes, currentFile: item.sourceRelativePath, message: `Copiando ${item.sourceRelativePath}` })
          }
          callback(null, chunk)
        }
      })
      let tempIdentity: { dev: number; ino: number } | null = null
      try {
        // Create the unique staging file exclusively and capture its inode before
        // writing. Cleanup is permitted only if this exact inode is still there.
        const tempHandle = await open(temp, 'wx', 0o600)
        try {
          const createdStat = await tempHandle.stat()
          tempIdentity = { dev: createdStat.dev, ino: createdStat.ino }
          await pipeline(createReadStream(source), meter, createWriteStream(temp, { fd: tempHandle.fd, autoClose: false }))
          await tempHandle.sync()
        } finally {
          await tempHandle.close().catch(() => undefined)
        }
        const sourceAfter = await lstat(source)
        if (sourceAfter.size !== item.sizeBytes || Math.trunc(sourceAfter.mtimeMs) !== item.modifiedAtMs) throw new Error(`A origem mudou durante a cópia: ${item.sourceRelativePath}`)
        const sourceHash = hash.digest('hex')
        const tempStatBeforePublish = await lstat(temp)
        const tempHash = await sha256(temp)
        const sourceHashAfterCopy = await sha256(source)
        if (tempStatBeforePublish.size !== item.sizeBytes || currentBytes !== item.sizeBytes || tempHash !== sourceHash || sourceHashAfterCopy !== sourceHash) {
          throw new Error(`A cópia ou a origem não passou na verificação SHA-256: ${item.sourceRelativePath}`)
        }
        if (await lstatMissing(target)) throw new Error(`O destino apareceu durante a cópia; não será sobrescrito: ${item.destinationRelativePath}`)
        // Keep an incomplete staging file private; make only a verified file
        // readable to the Jellyfin service before publishing it under its final name.
        if (process.platform !== 'win32') await chmod(temp, 0o644)
        const tempStat = await lstat(temp)

        const pending: PendingPublication = {
          sourceRelativePath: item.sourceRelativePath,
          destinationRelativePath: item.destinationRelativePath,
          tempRelativePath: tempRelative,
          sizeBytes: item.sizeBytes,
          sha256: sourceHash,
          tempDevice: tempStat.dev,
          tempInode: tempStat.ino,
          modifiedAtMs: item.modifiedAtMs,
          kind: item.kind,
          itemIndex: index,
          method: 'hard-link'
        }
        journal.pendingPublication = pending
        await saveJournal(userDataDir, journal)

        try {
          await link(temp, target)
        } catch (linkError) {
          if (!isHardLinkUnsupported(linkError)) throw linkError
          // Fail closed. A direct copy to the final filename could expose a
          // partial file after a crash; portable rename cannot guarantee
          // no-replace semantics on every supported filesystem.
          journal.pendingPublication = null
          await saveJournal(userDataDir, journal)
          await unlinkOwnedTemp(temp, tempIdentity)
          throw new Error('Este sistema de arquivos não oferece publicação atômica sem sobrescrita por hard link. A cópia foi interrompida sem escrever no nome final; escolha um destino compatível.')
        }

        const targetStat = await lstat(target)
        const targetHash = await sha256(target)
        if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.size !== item.sizeBytes || targetHash !== sourceHash) {
          throw new Error(`O destino publicado não passou na verificação SHA-256: ${item.destinationRelativePath}`)
        }
        const fileRecord: ExecutionFileRecord = {
          sourceRelativePath: item.sourceRelativePath,
          destinationRelativePath: item.destinationRelativePath,
          sizeBytes: targetStat.size,
          sha256: sourceHash,
          destinationModifiedAtMs: Math.trunc(targetStat.mtimeMs),
          kind: item.kind,
          stagingRelativePath: tempRelative
        }
        journal.files.push(fileRecord)
        journal.pendingPublication = null
        completedDestinations.add(item.destinationRelativePath)
        bytesCopied += item.sizeBytes
        completedFiles += 1
        await saveJournal(userDataDir, journal)
        await unlink(temp).catch(() => undefined)
      } catch (error) {
        // If publication intent was durably saved, leave its staged file in
        // place. Resume can reconcile a proven hard link or stop safely.
        if (!journal.pendingPublication) await unlinkOwnedTemp(temp, tempIdentity).catch(() => undefined)
        if (error instanceof Error && error.message === 'JAS_EXECUTION_CANCELLED') {
          journal.status = 'cancelled'
          break
        }
        throw error
      }
    }
    if (journal.status === 'running') journal.status = 'completed'
  } catch (error) {
    journal.status = 'failed'
    journal.errors.push(error instanceof Error ? error.message : String(error))
  }
  journal.finishedAt = new Date().toISOString()
  await saveJournal(userDataDir, journal)
  const stage: ExecutionProgress['stage'] = journal.status === 'completed' ? 'completed' : journal.status === 'cancelled' ? 'cancelled' : 'failed'
  progress(stage, null, journal.status === 'completed' ? 'Cópia concluída e verificada.' : journal.status === 'cancelled' ? 'Execução cancelada. Os arquivos concluídos foram preservados.' : 'A execução parou por um erro; confira o histórico antes de tentar novamente.')
  return toResult(journal)
}

export async function executeOrganizationPlan(
  plan: OrganizationPlan,
  userDataDir: string,
  emit: (progress: ExecutionProgress) => void,
  isCancelled: () => boolean
): Promise<ExecutionResult> {
  if (!plan || !plan.approvedAt) throw new Error('Aprove o plano antes de executar a organização.')
  if (!plan.items.length || plan.summary.ready !== plan.items.length || plan.summary.review || plan.summary.conflict || plan.summary.pending) {
    throw new Error('O plano contém itens que não estão prontos. Resolva-os antes de executar.')
  }
  if (plan.items.some((item) => item.status !== 'ready' || !item.destinationRelativePath)) throw new Error('Todos os itens precisam ter destino válido e status pronto.')
  await assertSafeSourceAndDestinationPhysical(path.resolve(plan.sourcePath), path.resolve(plan.destinationPath))
  const validation = await validateOrganizationPlan(plan)
  if (!validation.fresh) throw new Error(`O plano está desatualizado: ${validation.issues.join(' ')}`)

  const journal: ExecutionJournal = {
    schemaVersion: 2,
    pendingRollback: null,
    runId: randomUUID(),
    planId: plan.id,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    sourcePath: path.resolve(plan.sourcePath),
    destinationPath: path.resolve(plan.destinationPath),
    items: makeJournalItems(plan),
    pendingPublication: null,
    files: [],
    errors: [],
    attempts: 1
  }
  await saveJournal(userDataDir, journal)
  return runJournal(journal, userDataDir, emit, isCancelled)
}

export async function resumeOrganizationExecution(
  userDataDir: string,
  runId: string,
  emit: (progress: ExecutionProgress) => void,
  isCancelled: () => boolean
): Promise<ExecutionResult> {
  const journal = await readJournal(userDataDir, runId)
  if (!RESUMABLE_STATUSES.has(journal.status)) throw new Error(`A execução ${journal.status} não pode ser retomada.`)
  if (!journal.items?.length) throw new Error('Este registro não contém um plano recuperável. Gere um novo plano e execute novamente.')
  await assertSafeSourceAndDestinationPhysical(journal.sourcePath, journal.destinationPath)
  await reconcilePendingRollback(journal, userDataDir)
  await reconcilePendingPublication(journal, userDataDir)
  await cleanTempsForRecordedFiles(journal)
  await verifyRecordedFiles(journal)

  const itemDestinations = new Set(journal.items.map((item) => item.destinationRelativePath))
  const recordedDestinations = new Set<string>()
  for (const file of journal.files) {
    if (!itemDestinations.has(file.destinationRelativePath) || recordedDestinations.has(file.destinationRelativePath)) {
      throw new Error('O diário contém registros de destino inconsistentes; a retomada foi bloqueada por segurança.')
    }
    recordedDestinations.add(file.destinationRelativePath)
  }

  const allItemsRecorded = journal.items.every((item) => recordedDestinations.has(item.destinationRelativePath))
  if (allItemsRecorded) {
    journal.status = 'completed'
    journal.finishedAt = new Date().toISOString()
    journal.attempts = (journal.attempts ?? 1) + 1
    await saveJournal(userDataDir, journal)
    const totalBytes = journal.items.reduce((sum, item) => sum + item.sizeBytes, 0)
    const copiedBytes = journal.files.reduce((sum, file) => sum + file.sizeBytes, 0)
    emit({
      runId: journal.runId,
      planId: journal.planId,
      stage: 'completed',
      completedFiles: journal.files.length,
      totalFiles: journal.items.length,
      bytesCopied: copiedBytes,
      totalBytes,
      currentFile: null,
      message: 'Recuperação concluída: todos os arquivos já estavam publicados e verificados.'
    })
    return toResult(journal)
  }

  await validateRemainingItems(journal)
  journal.status = 'running'
  journal.finishedAt = null
  journal.attempts = (journal.attempts ?? 1) + 1
  await saveJournal(userDataDir, journal)
  return runJournal(journal, userDataDir, emit, isCancelled)
}

/** Marks journals left in `running` by a previous app process as interrupted. */
export async function markInterruptedExecutionJournals(userDataDir: string): Promise<void> {
  const directory = path.join(userDataDir, JOURNAL_DIR)
  let names: string[]
  try { names = await readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const name of names.filter((entry) => /^[0-9a-f-]{36}\.json$/i.test(entry))) {
    const runId = name.slice(0, -5)
    try {
      const journal = await readJournal(userDataDir, runId)
      if (journal.status !== 'running') continue
      journal.status = 'interrupted'
      journal.finishedAt = new Date().toISOString()
      journal.errors.push('O aplicativo foi fechado ou interrompido durante a execução. Verifique os arquivos antes de retomar.')
      await saveJournal(userDataDir, journal)
    } catch {
      // Keep malformed journals untouched; the history view can report other valid records.
    }
  }
}

export async function listOrganizationExecutionHistory(userDataDir: string): Promise<ExecutionHistoryEntry[]> {
  const directory = path.join(userDataDir, JOURNAL_DIR)
  let names: string[]
  try { names = await readdir(directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const entries: ExecutionHistoryEntry[] = []
  for (const name of names.filter((entry) => /^[0-9a-f-]{36}\.json$/i.test(entry))) {
    const runId = name.slice(0, -5)
    try {
      const journal = await readJournal(userDataDir, runId)
      const totalFiles = journal.items?.length ?? journal.files.length
      const remainingFiles = (journal.status === 'running' || RESUMABLE_STATUSES.has(journal.status)) ? Math.max(0, totalFiles - journal.files.length) : 0
      entries.push({
        runId: journal.runId,
        planId: journal.planId,
        createdAt: journal.createdAt,
        finishedAt: journal.finishedAt,
        status: journal.status === 'rolled-back' && journal.pendingPublication ? 'partially-rolled-back' : journal.status,
        sourcePath: journal.sourcePath,
        destinationPath: journal.destinationPath,
        totalFiles,
        completedFiles: journal.files.length,
        remainingFiles,
        copiedBytes: journal.files.reduce((sum, file) => sum + file.sizeBytes, 0),
        rolledBackFiles: journal.files.filter((file) => Boolean(file.rolledBackAt)).length,
        attempts: journal.attempts ?? 1,
        errors: [...journal.errors],
        resumable: Boolean(journal.items?.length && remainingFiles > 0 && RESUMABLE_STATUSES.has(journal.status)),
        rollbackAvailable: Boolean(journal.pendingPublication) || (journal.files.some((file) => !file.rolledBackAt) && journal.status !== 'rolled-back')
      })
    } catch {
      // Skip malformed/corrupt history files rather than blocking all history.
    }
  }
  return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

async function reconcilePendingRollback(journal: ExecutionJournal, userDataDir: string): Promise<boolean> {
  const pending = journal.pendingRollback
  if (!pending) return false

  const file = journal.files.find((entry) => entry.destinationRelativePath === pending.destinationRelativePath)
  if (!file || file.sha256 !== pending.sha256 || file.sizeBytes !== pending.sizeBytes) {
    journal.pendingRollback = null
    journal.errors.push(`Intenção de rollback inconsistente para ${pending.destinationRelativePath}; nenhum arquivo foi removido.`)
    await saveJournal(userDataDir, journal)
    return false
  }

  const target = await assertNoSymlinkParents(journal.destinationPath, pending.destinationRelativePath, true)
  const info = await lstatMissing(target)
  if (!info) {
    // The prior rollback may have completed unlink immediately before a crash.
    file.rolledBackAt ??= new Date().toISOString()
    journal.pendingRollback = null
    await saveJournal(userDataDir, journal)
    return false
  }

  const sameOwnedFile = info.isFile() && !info.isSymbolicLink() &&
    info.dev === pending.device && info.ino === pending.inode &&
    info.size === pending.sizeBytes && Math.trunc(info.mtimeMs) === pending.modifiedAtMs &&
    await sha256(target) === pending.sha256

  if (!sameOwnedFile) {
    journal.pendingRollback = null
    journal.errors.push(`Rollback interrompido: ${pending.destinationRelativePath} mudou e foi preservado para revisão manual.`)
    await saveJournal(userDataDir, journal)
    return false
  }

  await unlink(target)
  file.rolledBackAt = new Date().toISOString()
  journal.pendingRollback = null
  await saveJournal(userDataDir, journal)
  return true
}

export async function rollbackOrganizationExecution(userDataDir: string, runId: string): Promise<RollbackResult> {
  const journal = await readJournal(userDataDir, runId)
  if (journal.status === 'rolled-back' && !journal.pendingPublication) return { runId, removedFiles: 0, skippedFiles: 0, errors: ['Esta execução já foi revertida.'] }
  // Rollback only touches destination files. If the original source directory
  // still exists, verify physical source/destination separation first.
  const sourceInfo = await lstatMissing(journal.sourcePath)
  if (sourceInfo) await assertSafeSourceAndDestinationPhysical(journal.sourcePath, journal.destinationPath)

  let removedFiles = 0
  let skippedFiles = 0
  const errors: string[] = []

  // A publication may have reached its final path immediately before a crash,
  // while its file record was not yet committed to the journal. Reconcile it
  // before deciding which destination files belong to this execution.
  if (journal.pendingPublication) {
    try {
      await reconcilePendingPublication(journal, userDataDir)
    } catch (error) {
      skippedFiles += 1
      const detail = error instanceof Error ? error.message : String(error)
      const message = `Publicação pendente preservada para revisão manual: ${detail}`
      errors.push(message)
      if (!journal.errors.includes(message)) journal.errors.push(message)
    }
  }

  removedFiles += await reconcilePendingRollback(journal, userDataDir) ? 1 : 0
  journal.status = 'partially-rolled-back'
  await saveJournal(userDataDir, journal)

  const unresolvedPublicationPath = journal.pendingPublication?.destinationRelativePath ?? null
  for (const file of [...journal.files].reverse()) {
    if (file.rolledBackAt) continue
    // If a pending publication for the same destination could not be proven,
    // do not let an older record authorize deleting that ambiguous path.
    if (unresolvedPublicationPath && file.destinationRelativePath === unresolvedPublicationPath) continue
    try {
      const target = await assertNoSymlinkParents(journal.destinationPath, file.destinationRelativePath, true)
      const info = await lstatMissing(target)
      if (!info || !info.isFile() || info.isSymbolicLink() || info.size !== file.sizeBytes ||
          Math.trunc(info.mtimeMs) !== file.destinationModifiedAtMs || await sha256(target) !== file.sha256) {
        skippedFiles += 1
        errors.push(`Preservado porque está ausente ou mudou desde a cópia: ${file.destinationRelativePath}`)
        continue
      }

      journal.pendingRollback = {
        destinationRelativePath: file.destinationRelativePath,
        sha256: file.sha256,
        sizeBytes: file.sizeBytes,
        device: info.dev,
        inode: info.ino,
        modifiedAtMs: Math.trunc(info.mtimeMs)
      }
      await saveJournal(userDataDir, journal)

      // Re-check identity after the durable intent has been recorded. If the
      // target changed, clear the intent and preserve it for manual review.
      const immediatelyBeforeDelete = await lstatMissing(target)
      if (!immediatelyBeforeDelete || !immediatelyBeforeDelete.isFile() || immediatelyBeforeDelete.isSymbolicLink() ||
          immediatelyBeforeDelete.dev !== info.dev || immediatelyBeforeDelete.ino !== info.ino ||
          immediatelyBeforeDelete.size !== info.size || Math.trunc(immediatelyBeforeDelete.mtimeMs) !== Math.trunc(info.mtimeMs) ||
          await sha256(target) !== file.sha256) {
        journal.pendingRollback = null
        await saveJournal(userDataDir, journal)
        skippedFiles += 1
        errors.push(`Preservado porque mudou durante a verificação: ${file.destinationRelativePath}`)
        continue
      }

      await unlink(target)
      removedFiles += 1
      file.rolledBackAt = new Date().toISOString()
      journal.pendingRollback = null
      await saveJournal(userDataDir, journal)
    } catch (error) {
      skippedFiles += 1
      errors.push(`${file.destinationRelativePath}: ${error instanceof Error ? error.message : String(error)}`)
      // Do not overwrite a durable intent from a failed item with a later item.
      // A later rollback call will reconcile this intent conservatively.
      if (journal.pendingRollback) break
    }
  }

  journal.status = !journal.pendingPublication && journal.files.every((file) => Boolean(file.rolledBackAt))
    ? 'rolled-back'
    : 'partially-rolled-back'
  journal.finishedAt = new Date().toISOString()
  await saveJournal(userDataDir, journal)
  return { runId, removedFiles, skippedFiles, errors }
}
