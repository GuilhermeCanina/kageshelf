import { link, mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertSafeSourceAndDestinationPhysical, scanLibrary } from '../src/main/scanEngine'
import { buildOrganizationPlan, validateOrganizationPlan } from '../src/main/organizationPlan'
import { executeOrganizationPlan, listOrganizationExecutionHistory, markInterruptedExecutionJournals, reconcilePendingPublication, resumeOrganizationExecution, rollbackOrganizationExecution } from '../src/main/organizationExecution'
import type { ExecutionJournal, OrganizationPlan } from '../src/shared/types'

const roots: string[] = []
async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'jas-copy-'))
  roots.push(root)
  return root
}
async function approvedPlan(source: string, destination: string): Promise<OrganizationPlan> {
  const scan = await scanLibrary(source, destination)
  const plan = await buildOrganizationPlan(scan)
  const validation = await validateOrganizationPlan(plan)
  return { ...plan, validation, approvedAt: new Date().toISOString() }
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('verified organization execution', () => {
  it('copies only approved files, checks SHA-256, and supports a safe rollback', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    const userData = path.join(root, 'user-data')
    await mkdir(source)
    const firstName = 'Anime - 01 [1080p].mkv'
    const secondName = 'Anime - 02 [1080p].mkv'
    await writeFile(path.join(source, firstName), 'episode-one-content')
    await writeFile(path.join(source, secondName), 'episode-two-content')
    const plan = await approvedPlan(source, destination)
    expect(plan.summary.ready).toBe(2)
    const events: string[] = []

    const result = await executeOrganizationPlan(plan, userData, (event) => events.push(event.stage), () => false)
    expect(result.status).toBe('completed')
    expect(result.copiedFiles).toBe(2)
    expect(events).toContain('copying')
    for (const item of plan.items) {
      const sourceBytes = await readFile(path.join(source, item.sourceRelativePath))
      const outputPath = path.join(destination, item.destinationRelativePath!)
      const outputBytes = await readFile(outputPath)
      expect(createHash('sha256').update(outputBytes).digest('hex')).toBe(createHash('sha256').update(sourceBytes).digest('hex'))
      if (process.platform !== 'win32') expect((await stat(outputPath)).mode & 0o777).toBe(0o644)
    }
    expect(await readFile(path.join(source, firstName), 'utf8')).toBe('episode-one-content')

    const rollback = await rollbackOrganizationExecution(userData, result.runId)
    expect(rollback.removedFiles).toBe(2)
    expect(rollback.skippedFiles).toBe(0)
    expect(await stat(source).then((s) => s.isDirectory())).toBe(true)
    for (const item of plan.items) await expect(stat(path.join(destination, item.destinationRelativePath!))).rejects.toThrow()
    const historyAfterRollback = await listOrganizationExecutionHistory(userData)
    expect(historyAfterRollback[0].status).toBe('rolled-back')
    expect(historyAfterRollback[0].completedFiles).toBe(2)
    expect(historyAfterRollback[0].rolledBackFiles).toBe(2)
    expect(historyAfterRollback[0].rollbackAvailable).toBe(false)
  })

  it('does not overwrite a destination that appears after the plan was built', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    await mkdir(source)
    await writeFile(path.join(source, 'Anime - 01 [1080p].mkv'), 'original')
    const plan = await approvedPlan(source, destination)
    const output = path.join(destination, plan.items[0].destinationRelativePath!)
    await mkdir(path.dirname(output), { recursive: true })
    await writeFile(output, 'do-not-overwrite')

    await expect(executeOrganizationPlan(plan, path.join(root, 'user-data'), () => undefined, () => false)).rejects.toThrow(/desatualizado/)
    expect(await readFile(output, 'utf8')).toBe('do-not-overwrite')
    expect(await readFile(path.join(source, 'Anime - 01 [1080p].mkv'), 'utf8')).toBe('original')
  })

  it('keeps a destination file during rollback if it was modified after copying', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    const userData = path.join(root, 'user-data')
    await mkdir(source)
    await writeFile(path.join(source, 'Anime - 01 [1080p].mkv'), 'episode-one')
    const plan = await approvedPlan(source, destination)
    const result = await executeOrganizationPlan(plan, userData, () => undefined, () => false)
    const output = path.join(destination, plan.items[0].destinationRelativePath!)
    await writeFile(output, 'changed by user')

    const rollback = await rollbackOrganizationExecution(userData, result.runId)
    expect(rollback.removedFiles).toBe(0)
    expect(rollback.skippedFiles).toBe(1)
    expect(await readFile(output, 'utf8')).toBe('changed by user')
  })

  it('supports cancellation before copying the first file', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    await mkdir(source)
    await writeFile(path.join(source, 'Anime - 01 [1080p].mkv'), 'episode-one')
    const plan = await approvedPlan(source, destination)
    const result = await executeOrganizationPlan(plan, path.join(root, 'user-data'), () => undefined, () => true)
    expect(result.status).toBe('cancelled')
    expect(result.copiedFiles).toBe(0)
    expect(await readFile(path.join(source, 'Anime - 01 [1080p].mkv'), 'utf8')).toBe('episode-one')
  })


  it('persists history and resumes a cancelled run without recopying verified files', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    const userData = path.join(root, 'user-data')
    await mkdir(source)
    await writeFile(path.join(source, 'Anime - 01 [1080p].mkv'), 'episode-one-content')
    await writeFile(path.join(source, 'Anime - 02 [1080p].mkv'), 'episode-two-content')
    const plan = await approvedPlan(source, destination)
    let cancel = false
    const first = await executeOrganizationPlan(plan, userData, (event) => {
      if (event.stage === 'copying' && event.completedFiles === 1) cancel = true
    }, () => cancel)
    expect(first.status).toBe('cancelled')
    expect(first.copiedFiles).toBe(1)

    let history = await listOrganizationExecutionHistory(userData)
    expect(history).toHaveLength(1)
    expect(history[0].resumable).toBe(true)
    expect(history[0].completedFiles).toBe(1)
    const completedPath = path.join(destination, plan.items[0].destinationRelativePath!)
    const before = await readFile(completedPath)

    const resumed = await resumeOrganizationExecution(userData, first.runId, () => undefined, () => false)
    expect(resumed.runId).toBe(first.runId)
    expect(resumed.status).toBe('completed')
    expect(resumed.copiedFiles).toBe(2)
    expect(await readFile(completedPath)).toEqual(before)
    for (const item of plan.items) {
      const destinationBytes = await readFile(path.join(destination, item.destinationRelativePath!))
      expect(destinationBytes.toString()).toContain('episode-')
    }
    history = await listOrganizationExecutionHistory(userData)
    expect(history[0].status).toBe('completed')
    expect(history[0].resumable).toBe(false)
  })

  it('marks old running journals as interrupted after a process restart', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    const userData = path.join(root, 'user-data')
    await mkdir(source)
    await writeFile(path.join(source, 'Anime - 01 [1080p].mkv'), 'episode-one-content')
    const plan = await approvedPlan(source, destination)
    const run = await executeOrganizationPlan(plan, userData, () => undefined, () => true)
    const journalPath = path.join(userData, 'organization-executions', `${run.runId}.json`)
    const journal = JSON.parse(await readFile(journalPath, 'utf8'))
    journal.status = 'running'
    journal.finishedAt = null
    await writeFile(journalPath, JSON.stringify(journal))

    await markInterruptedExecutionJournals(userData)
    const history = await listOrganizationExecutionHistory(userData)
    expect(history[0].status).toBe('interrupted')
    expect(history[0].resumable).toBe(true)
  })


  it('blocks resume if a source changed after some files were already copied', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    const userData = path.join(root, 'user-data')
    await mkdir(source)
    await writeFile(path.join(source, 'Anime - 01 [1080p].mkv'), 'episode-one-content')
    await writeFile(path.join(source, 'Anime - 02 [1080p].mkv'), 'episode-two-content')
    const plan = await approvedPlan(source, destination)
    let cancel = false
    const first = await executeOrganizationPlan(plan, userData, (event) => {
      if (event.stage === 'copying' && event.completedFiles === 1) cancel = true
    }, () => cancel)
    expect(first.status).toBe('cancelled')
    await writeFile(path.join(source, 'Anime - 02 [1080p].mkv'), 'changed-source-content')
    await expect(resumeOrganizationExecution(userData, first.runId, () => undefined, () => false)).rejects.toThrow(/origem mudou/)
    expect(await readFile(path.join(source, 'Anime - 02 [1080p].mkv'), 'utf8')).toBe('changed-source-content')
  })


  it('recovers a publication interrupted after an atomic hard-link but before journal commit', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    const userData = path.join(root, 'user-data')
    await mkdir(source)
    await mkdir(path.join(destination, 'Season 01'), { recursive: true })
    const sourceName = 'Anime - 01 [1080p].mkv'
    const content = 'recovery-content'
    await writeFile(path.join(source, sourceName), content)
    const sourceInfo = await stat(path.join(source, sourceName))
    const runId = randomUUID()
    const relativeDestination = 'Season 01/Anime S01E01.mkv'
    const target = path.join(destination, relativeDestination)
    const tempRelative = `Season 01/.Anime S01E01.mkv.${runId}.0.partial`
    const temp = path.join(destination, tempRelative)
    await writeFile(temp, content, { mode: 0o644 })
    const tempInfo = await stat(temp)
    await link(temp, target)
    const hash = createHash('sha256').update(content).digest('hex')
    const item = { sourceRelativePath: sourceName, destinationRelativePath: relativeDestination, sizeBytes: Buffer.byteLength(content), modifiedAtMs: Math.trunc(sourceInfo.mtimeMs), kind: 'video' as const }
    const journal: ExecutionJournal = {
      runId, planId: 'plan-recovery', createdAt: new Date().toISOString(), finishedAt: null, status: 'interrupted',
      sourcePath: source, destinationPath: destination, items: [item], pendingPublication: {
        sourceRelativePath: sourceName, destinationRelativePath: relativeDestination, tempRelativePath: tempRelative,
        sizeBytes: Buffer.byteLength(content), sha256: hash, tempDevice: tempInfo.dev, tempInode: tempInfo.ino,
        modifiedAtMs: item.modifiedAtMs, kind: 'video', itemIndex: 0, method: 'hard-link'
      }, files: [], errors: [], attempts: 1
    }
    await reconcilePendingPublication(journal, userData)
    expect(journal.pendingPublication).toBeNull()
    expect(journal.files).toHaveLength(1)
    expect(await readFile(target, 'utf8')).toBe(content)
    await expect(stat(temp)).rejects.toThrow()
    const history = await listOrganizationExecutionHistory(userData)
    expect(history[0].completedFiles).toBe(1)
  })

  it('does not adopt an unjournaled destination with a different inode after an interrupted publication', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    const userData = path.join(root, 'user-data')
    await mkdir(source)
    await mkdir(path.join(destination, 'Season 01'), { recursive: true })
    const sourceName = 'Anime - 01 [1080p].mkv'
    const content = 'same-content-does-not-prove-ownership'
    await writeFile(path.join(source, sourceName), content)
    const sourceInfo = await stat(path.join(source, sourceName))
    const runId = randomUUID()
    const relativeDestination = 'Season 01/Anime S01E01.mkv'
    const target = path.join(destination, relativeDestination)
    const tempRelative = `Season 01/.Anime S01E01.mkv.${runId}.0.partial`
    const temp = path.join(destination, tempRelative)
    await writeFile(temp, content)
    const tempInfo = await stat(temp)
    await writeFile(target, content)
    const hash = createHash('sha256').update(content).digest('hex')
    const item = { sourceRelativePath: sourceName, destinationRelativePath: relativeDestination, sizeBytes: Buffer.byteLength(content), modifiedAtMs: Math.trunc(sourceInfo.mtimeMs), kind: 'video' as const }
    const journal: ExecutionJournal = {
      runId, planId: 'plan-unowned', createdAt: new Date().toISOString(), finishedAt: null, status: 'interrupted',
      sourcePath: source, destinationPath: destination, items: [item], pendingPublication: {
        sourceRelativePath: sourceName, destinationRelativePath: relativeDestination, tempRelativePath: tempRelative,
        sizeBytes: Buffer.byteLength(content), sha256: hash, tempDevice: tempInfo.dev, tempInode: tempInfo.ino,
        modifiedAtMs: item.modifiedAtMs, kind: 'video', itemIndex: 0, method: 'hard-link'
      }, files: [], errors: [], attempts: 1
    }
    await expect(reconcilePendingPublication(journal, userData)).rejects.toThrow(/não é possível provar/)
    expect(await readFile(target, 'utf8')).toBe(content)
    expect(await readFile(temp, 'utf8')).toBe(content)
  })


  it('recovers a hard-link publication after a crash before the journal commit', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    const userData = path.join(root, 'user-data')
    await mkdir(source)
    await mkdir(path.join(destination, 'Season 01'), { recursive: true })
    const sourceName = 'Anime - 01 [1080p].mkv'
    const content = 'pending-publication-content'
    await writeFile(path.join(source, sourceName), content)
    const sourceInfo = await stat(path.join(source, sourceName))
    const runId = randomUUID()
    const relativeDestination = 'Season 01/Anime S01E01.mkv'
    const target = path.join(destination, relativeDestination)
    const tempRelativePath = `Season 01/.Anime S01E01.mkv.${runId}.0.partial`
    const temp = path.join(destination, tempRelativePath)
    await writeFile(temp, content, { mode: 0o644 })
    const tempInfo = await stat(temp)
    await link(temp, target)
    const digest = createHash('sha256').update(content).digest('hex')
    const item = { sourceRelativePath: sourceName, destinationRelativePath: relativeDestination, sizeBytes: Buffer.byteLength(content), modifiedAtMs: Math.trunc(sourceInfo.mtimeMs), kind: 'video' as const }
    const journal: ExecutionJournal = {
      runId, planId: 'plan-recovery', createdAt: new Date().toISOString(), finishedAt: null, status: 'interrupted',
      sourcePath: source, destinationPath: destination, items: [item], pendingPublication: {
        sourceRelativePath: sourceName, destinationRelativePath: relativeDestination, tempRelativePath,
        sizeBytes: Buffer.byteLength(content), sha256: digest, tempDevice: tempInfo.dev, tempInode: tempInfo.ino,
        modifiedAtMs: item.modifiedAtMs, kind: 'video', itemIndex: 0, method: 'hard-link'
      }, files: [], errors: [], attempts: 1
    }

    await reconcilePendingPublication(journal, userData)

    expect(journal.pendingPublication).toBeNull()
    expect(journal.files).toHaveLength(1)
    expect(await readFile(target, 'utf8')).toBe(content)
    await expect(stat(temp)).rejects.toThrow()
    expect((await listOrganizationExecutionHistory(userData))[0].completedFiles).toBe(1)
  })

  it('completes resume when reconciliation recovers the final pending publication', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    const userData = path.join(root, 'user-data')
    await mkdir(source)
    await mkdir(path.join(destination, 'Season 01'), { recursive: true })

    const sourceName = 'Anime - 01 [1080p].mkv'
    const content = 'recovered-final-publication-content'
    await writeFile(path.join(source, sourceName), content)
    const sourceInfo = await stat(path.join(source, sourceName))
    const runId = randomUUID()
    const relativeDestination = 'Season 01/Anime S01E01.mkv'
    const tempRelativePath = `Season 01/.Anime S01E01.mkv.${runId}.0.partial`
    const target = path.join(destination, relativeDestination)
    const temp = path.join(destination, tempRelativePath)

    await writeFile(temp, content, { mode: 0o644 })
    const tempInfo = await stat(temp)
    await link(temp, target)

    const digest = createHash('sha256').update(content).digest('hex')
    const item = {
      sourceRelativePath: sourceName,
      destinationRelativePath: relativeDestination,
      sizeBytes: Buffer.byteLength(content),
      modifiedAtMs: Math.trunc(sourceInfo.mtimeMs),
      kind: 'video' as const
    }
    const journal: ExecutionJournal = {
      schemaVersion: 2,
      pendingRollback: null,
      runId,
      planId: 'plan-final-recovery',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      status: 'interrupted',
      sourcePath: source,
      destinationPath: destination,
      items: [item],
      pendingPublication: {
        sourceRelativePath: sourceName,
        destinationRelativePath: relativeDestination,
        tempRelativePath,
        sizeBytes: item.sizeBytes,
        sha256: digest,
        tempDevice: tempInfo.dev,
        tempInode: tempInfo.ino,
        modifiedAtMs: item.modifiedAtMs,
        kind: 'video',
        itemIndex: 0,
        method: 'hard-link'
      },
      files: [],
      errors: [],
      attempts: 1
    }

    const journalDirectory = path.join(userData, 'organization-executions')
    await mkdir(journalDirectory, { recursive: true })
    await writeFile(path.join(journalDirectory, `${runId}.json`), JSON.stringify(journal, null, 2))

    const stages: string[] = []
    const resumed = await resumeOrganizationExecution(userData, runId, (event) => stages.push(event.stage), () => false)

    expect(resumed.status).toBe('completed')
    expect(resumed.copiedFiles).toBe(1)
    expect(resumed.rollbackAvailable).toBe(true)
    expect(stages).toContain('completed')
    expect(await readFile(target, 'utf8')).toBe(content)
    await expect(stat(temp)).rejects.toThrow()

    const history = await listOrganizationExecutionHistory(userData)
    expect(history[0].status).toBe('completed')
    expect(history[0].completedFiles).toBe(1)
    expect(history[0].resumable).toBe(false)
  })

  it('reconciles a pending publication before rolling back a mixed execution', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    const userData = path.join(root, 'user-data')
    await mkdir(source)
    await writeFile(path.join(source, 'Anime - 01 [1080p].mkv'), 'episode-one-content')
    await writeFile(path.join(source, 'Anime - 02 [1080p].mkv'), 'episode-two-content')

    const plan = await approvedPlan(source, destination)
    const executed = await executeOrganizationPlan(plan, userData, () => undefined, () => false)
    expect(executed.status).toBe('completed')

    const journalPath = path.join(userData, 'organization-executions', `${executed.runId}.json`)
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as ExecutionJournal
    const pendingItemIndex = journal.items!.length - 1
    const pendingItem = journal.items![pendingItemIndex]
    const pendingRecord = journal.files.find((file) => file.destinationRelativePath === pendingItem.destinationRelativePath)!
    const target = path.join(destination, pendingItem.destinationRelativePath)
    const tempRelativePath = path.join(
      path.dirname(pendingItem.destinationRelativePath),
      `.${path.basename(pendingItem.destinationRelativePath)}.${journal.runId}.${pendingItemIndex}.recovery.partial`
    )
    const temp = path.join(destination, tempRelativePath)
    await link(target, temp)
    const tempInfo = await stat(temp)
    const targetBytes = await readFile(target)

    journal.files = journal.files.filter((file) => file.destinationRelativePath !== pendingItem.destinationRelativePath)
    journal.pendingPublication = {
      sourceRelativePath: pendingItem.sourceRelativePath,
      destinationRelativePath: pendingItem.destinationRelativePath,
      tempRelativePath,
      sizeBytes: pendingRecord.sizeBytes,
      sha256: createHash('sha256').update(targetBytes).digest('hex'),
      tempDevice: tempInfo.dev,
      tempInode: tempInfo.ino,
      modifiedAtMs: pendingItem.modifiedAtMs,
      kind: pendingItem.kind,
      itemIndex: pendingItemIndex,
      method: 'hard-link'
    }
    journal.status = 'interrupted'
    journal.finishedAt = null
    await writeFile(journalPath, JSON.stringify(journal, null, 2))

    const rollback = await rollbackOrganizationExecution(userData, executed.runId)

    expect(rollback.removedFiles).toBe(2)
    expect(rollback.skippedFiles).toBe(0)
    for (const item of journal.items!) {
      await expect(stat(path.join(destination, item.destinationRelativePath))).rejects.toThrow()
      expect(await readFile(path.join(source, item.sourceRelativePath))).toBeTruthy()
    }
    await expect(stat(temp)).rejects.toThrow()

    const history = await listOrganizationExecutionHistory(userData)
    expect(history[0].status).toBe('rolled-back')
    expect(history[0].completedFiles).toBe(2)
    expect(history[0].rolledBackFiles).toBe(2)
    expect(history[0].rollbackAvailable).toBe(false)
  })

  it('rolls back recorded files while preserving an unproven pending publication', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    const userData = path.join(root, 'user-data')
    await mkdir(source)
    await writeFile(path.join(source, 'Anime - 01 [1080p].mkv'), 'episode-one-content')
    await writeFile(path.join(source, 'Anime - 02 [1080p].mkv'), 'episode-two-content')

    const plan = await approvedPlan(source, destination)
    const executed = await executeOrganizationPlan(plan, userData, () => undefined, () => false)
    const journalPath = path.join(userData, 'organization-executions', `${executed.runId}.json`)
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as ExecutionJournal
    const pendingItemIndex = journal.items!.length - 1
    const pendingItem = journal.items![pendingItemIndex]
    const pendingRecord = journal.files.find((file) => file.destinationRelativePath === pendingItem.destinationRelativePath)!
    const target = path.join(destination, pendingItem.destinationRelativePath)
    const tempRelativePath = path.join(
      path.dirname(pendingItem.destinationRelativePath),
      `.${path.basename(pendingItem.destinationRelativePath)}.${journal.runId}.${pendingItemIndex}.unproven.partial`
    )
    const temp = path.join(destination, tempRelativePath)
    const targetBytes = await readFile(target)
    await writeFile(temp, targetBytes)
    const tempInfo = await stat(temp)

    journal.files = journal.files.filter((file) => file.destinationRelativePath !== pendingItem.destinationRelativePath)
    journal.pendingPublication = {
      sourceRelativePath: pendingItem.sourceRelativePath,
      destinationRelativePath: pendingItem.destinationRelativePath,
      tempRelativePath,
      sizeBytes: pendingRecord.sizeBytes,
      sha256: createHash('sha256').update(targetBytes).digest('hex'),
      tempDevice: tempInfo.dev,
      tempInode: tempInfo.ino,
      modifiedAtMs: pendingItem.modifiedAtMs,
      kind: pendingItem.kind,
      itemIndex: pendingItemIndex,
      method: 'hard-link'
    }
    journal.status = 'interrupted'
    journal.finishedAt = null
    await writeFile(journalPath, JSON.stringify(journal, null, 2))

    const rollback = await rollbackOrganizationExecution(userData, executed.runId)
    const recordedItem = journal.items!.find((item) => item.destinationRelativePath !== pendingItem.destinationRelativePath)!
    const recordedTarget = path.join(destination, recordedItem.destinationRelativePath)

    expect(rollback.removedFiles).toBe(1)
    expect(rollback.skippedFiles).toBe(1)
    await expect(stat(recordedTarget)).rejects.toThrow()
    expect(await readFile(target)).toEqual(targetBytes)
    expect(await readFile(temp)).toEqual(targetBytes)
    for (const item of journal.items!) {
      expect(await readFile(path.join(source, item.sourceRelativePath), 'utf8')).toContain('episode-')
    }

    const history = await listOrganizationExecutionHistory(userData)
    expect(history[0].status).toBe('partially-rolled-back')
    expect(history[0].rolledBackFiles).toBe(1)
    expect(history[0].rollbackAvailable).toBe(true)
  })

  it('keeps an unproven pending publication visible and retryable after rollback', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    const userData = path.join(root, 'user-data')
    await mkdir(source)
    await mkdir(path.join(destination, 'Season 01'), { recursive: true })

    const sourceName = 'Anime - 01 [1080p].mkv'
    const content = 'same-content-but-independent-files'
    await writeFile(path.join(source, sourceName), content)
    const sourceInfo = await stat(path.join(source, sourceName))
    const runId = randomUUID()
    const relativeDestination = 'Season 01/Anime S01E01.mkv'
    const tempRelativePath = `Season 01/.Anime S01E01.mkv.${runId}.0.partial`
    const target = path.join(destination, relativeDestination)
    const temp = path.join(destination, tempRelativePath)
    await writeFile(temp, content)
    const tempInfo = await stat(temp)
    await writeFile(target, content)
    const digest = createHash('sha256').update(content).digest('hex')
    const item = {
      sourceRelativePath: sourceName,
      destinationRelativePath: relativeDestination,
      sizeBytes: Buffer.byteLength(content),
      modifiedAtMs: Math.trunc(sourceInfo.mtimeMs),
      kind: 'video' as const
    }
    const journal: ExecutionJournal = {
      schemaVersion: 2,
      pendingRollback: null,
      runId,
      planId: 'plan-unproven-rollback',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      status: 'rolled-back',
      sourcePath: source,
      destinationPath: destination,
      items: [item],
      pendingPublication: {
        sourceRelativePath: sourceName,
        destinationRelativePath: relativeDestination,
        tempRelativePath,
        sizeBytes: item.sizeBytes,
        sha256: digest,
        tempDevice: tempInfo.dev,
        tempInode: tempInfo.ino,
        modifiedAtMs: item.modifiedAtMs,
        kind: 'video',
        itemIndex: 0,
        method: 'hard-link'
      },
      files: [],
      errors: [],
      attempts: 1
    }
    const journalDirectory = path.join(userData, 'organization-executions')
    await mkdir(journalDirectory, { recursive: true })
    await writeFile(path.join(journalDirectory, `${runId}.json`), JSON.stringify(journal, null, 2))

    const historyBeforeRollback = await listOrganizationExecutionHistory(userData)
    expect(historyBeforeRollback[0].status).toBe('partially-rolled-back')
    expect(historyBeforeRollback[0].rollbackAvailable).toBe(true)

    const rollback = await rollbackOrganizationExecution(userData, runId)
    expect(rollback.removedFiles).toBe(0)
    expect(rollback.skippedFiles).toBe(1)
    expect(rollback.errors.join(' ')).toMatch(/preservada para revisão manual/i)
    expect(await readFile(target, 'utf8')).toBe(content)
    expect(await readFile(temp, 'utf8')).toBe(content)

    const history = await listOrganizationExecutionHistory(userData)
    expect(history[0].status).toBe('partially-rolled-back')
    expect(history[0].rollbackAvailable).toBe(true)
    expect(history[0].errors.join(' ')).toMatch(/preservada para revisão manual/i)
  })

  it('preserves a target when ownership of an interrupted publication cannot be proven', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    const userData = path.join(root, 'user-data')
    await mkdir(source)
    await mkdir(path.join(destination, 'Season 01'), { recursive: true })
    const sourceName = 'Anime - 01 [1080p].mkv'
    const content = 'same-content-but-independent-file'
    await writeFile(path.join(source, sourceName), content)
    const sourceInfo = await stat(path.join(source, sourceName))
    const runId = randomUUID()
    const relativeDestination = 'Season 01/Anime S01E01.mkv'
    const target = path.join(destination, relativeDestination)
    const tempRelativePath = `Season 01/.Anime S01E01.mkv.${runId}.0.partial`
    const temp = path.join(destination, tempRelativePath)
    await writeFile(temp, content)
    const tempInfo = await stat(temp)
    await writeFile(target, content)
    const digest = createHash('sha256').update(content).digest('hex')
    const item = { sourceRelativePath: sourceName, destinationRelativePath: relativeDestination, sizeBytes: Buffer.byteLength(content), modifiedAtMs: Math.trunc(sourceInfo.mtimeMs), kind: 'video' as const }
    const journal: ExecutionJournal = {
      runId, planId: 'plan-unowned', createdAt: new Date().toISOString(), finishedAt: null, status: 'interrupted',
      sourcePath: source, destinationPath: destination, items: [item], pendingPublication: {
        sourceRelativePath: sourceName, destinationRelativePath: relativeDestination, tempRelativePath,
        sizeBytes: Buffer.byteLength(content), sha256: digest, tempDevice: tempInfo.dev, tempInode: tempInfo.ino,
        modifiedAtMs: item.modifiedAtMs, kind: 'video', itemIndex: 0, method: 'hard-link'
      }, files: [], errors: [], attempts: 1
    }

    await expect(reconcilePendingPublication(journal, userData)).rejects.toThrow(/não é possível provar/)
    expect(await readFile(target, 'utf8')).toBe(content)
    expect(await readFile(temp, 'utf8')).toBe(content)
  })


  it('preserves an unowned legacy partial file during resume', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    const userData = path.join(root, 'user-data')
    await mkdir(source)
    await writeFile(path.join(source, 'Anime - 01 [1080p].mkv'), 'episode-one-content')
    const plan = await approvedPlan(source, destination)
    const cancelled = await executeOrganizationPlan(plan, userData, () => undefined, () => true)
    expect(cancelled.status).toBe('cancelled')

    const item = plan.items[0]
    const legacyTemp = path.join(path.dirname(path.join(destination, item.destinationRelativePath!)), `.${path.basename(item.destinationRelativePath!)}.${cancelled.runId}.0.partial`)
    await mkdir(path.dirname(legacyTemp), { recursive: true })
    await writeFile(legacyTemp, 'unowned data must be preserved')

    const resumed = await resumeOrganizationExecution(userData, cancelled.runId, () => undefined, () => false)
    expect(resumed.status).toBe('completed')
    expect(await readFile(legacyTemp, 'utf8')).toBe('unowned data must be preserved')
    expect(await readFile(path.join(destination, item.destinationRelativePath!), 'utf8')).toBe('episode-one-content')
  })

  it('recovers a rollback interrupted after deleting a destination but before journal commit', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    const userData = path.join(root, 'user-data')
    await mkdir(source)
    const sourceFile = path.join(source, 'Anime - 01 [1080p].mkv')
    await writeFile(sourceFile, 'rollback-crash-content')
    const plan = await approvedPlan(source, destination)
    const result = await executeOrganizationPlan(plan, userData, () => undefined, () => false)
    const item = plan.items[0]
    const target = path.join(destination, item.destinationRelativePath!)
    const targetInfo = await stat(target)
    const digest = createHash('sha256').update(await readFile(target)).digest('hex')
    const journalPath = path.join(userData, 'organization-executions', `${result.runId}.json`)
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as ExecutionJournal
    journal.status = 'partially-rolled-back'
    journal.pendingRollback = {
      destinationRelativePath: item.destinationRelativePath!,
      sha256: digest,
      sizeBytes: targetInfo.size,
      device: targetInfo.dev,
      inode: targetInfo.ino,
      modifiedAtMs: Math.trunc(targetInfo.mtimeMs)
    }
    await writeFile(journalPath, JSON.stringify(journal, null, 2))
    await unlink(target) // Simulate crash after unlink but before journal commit.

    const rollback = await rollbackOrganizationExecution(userData, result.runId)
    expect(rollback.errors).toHaveLength(0)
    const history = await listOrganizationExecutionHistory(userData)
    expect(history[0].status).toBe('rolled-back')
    expect(history[0].rolledBackFiles).toBe(1)
    expect(await readFile(sourceFile, 'utf8')).toBe('rollback-crash-content')
  })

  it.skipIf(process.platform === 'win32')('rejects source/destination overlap hidden by a symlinked ancestor', async () => {
    const root = await tempRoot()
    const realParent = path.join(root, 'real-parent')
    const aliasParent = path.join(root, 'alias-parent')
    const source = path.join(realParent, 'Anime')
    await mkdir(source, { recursive: true })
    await symlink(realParent, aliasParent, 'dir')
    const aliasedSource = path.join(aliasParent, 'Anime')
    const destinationHiddenInsideSource = path.join(source, 'NestedOutput')
    await expect(assertSafeSourceAndDestinationPhysical(aliasedSource, destinationHiddenInsideSource)).rejects.toThrow(/destino não pode ficar dentro/i)
  })

  it.skipIf(process.platform === 'win32')('preserves a literal backslash in a Linux source filename', async () => {
    const root = await tempRoot()
    const source = path.join(root, 'Anime')
    const destination = path.join(root, 'Anime [Jellyfin]')
    const userData = path.join(root, 'user-data')
    await mkdir(source)
    const literalBackslashName = 'Anime - 01 [1080p]\\group.mkv'
    await writeFile(path.join(source, literalBackslashName), 'literal-backslash-content')
    const plan = await approvedPlan(source, destination)
    expect(plan.summary.ready).toBe(1)
    const result = await executeOrganizationPlan(plan, userData, () => undefined, () => false)
    expect(result.status).toBe('completed')
    expect(await readFile(path.join(destination, plan.items[0].destinationRelativePath!), 'utf8')).toBe('literal-backslash-content')
  })

})
