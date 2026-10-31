import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanLibrary } from './scanEngine'
import { buildOrganizationPlan, validateOrganizationPlan } from './organizationPlan'
import { executeOrganizationPlan, listOrganizationExecutionHistory, markInterruptedExecutionJournals, resumeOrganizationExecution, rollbackOrganizationExecution } from './organizationExecution'
import { planBlockerMessages, planCanBeApproved } from '../shared/organizationPlan'
import type { ExecutionProgress, OrganizationPlan, ScanResult } from '../shared/types'
import { searchAniListAnime } from './anilist'
import { deleteStoredAssociation, getStoredAssociation, saveStoredAssociation } from './associationStore'
import { safeSeriesName } from '../shared/previewMetadata'
import { deleteStoredEpisodeCorrection, getStoredEpisodeCorrections, saveStoredEpisodeCorrection } from './episodeCorrectionStore'
import { resolveLegacyUserDataPath } from './userDataPath'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Keep using the prior app-data directory so associations, corrections and execution
// history remain available after the product is renamed.
app.setPath('userData', resolveLegacyUserDataPath(app.getPath('appData')))

let mainWindow: BrowserWindow | null = null
const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (app.isReady()) createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}
const issuedPlans = new Map<string, OrganizationPlan>()
let activeExecutionPlanId: string | null = null
let activeRollbackRunId: string | null = null
const cancelledPlanIds = new Set<string>()

function assertTrustedRenderer(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    throw new Error('Solicitação rejeitada: origem IPC não autorizada.')
  }

  const senderFrame = event.senderFrame
  const mainFrame = mainWindow.webContents.mainFrame
  if (!senderFrame || senderFrame.processId !== mainFrame.processId || senderFrame.routingId !== mainFrame.routingId) {
    throw new Error('Solicitação rejeitada: somente o frame principal pode chamar a API IPC.')
  }

  const actualUrl = senderFrame.url
  const expectedUrl = mainWindow.webContents.getURL()
  if (!actualUrl || !expectedUrl) throw new Error('Não foi possível validar a origem da solicitação.')

  // In development Vite can append a query string, so same-origin is allowed.
  const actual = new URL(actualUrl)
  const expected = new URL(expectedUrl)
  if (actual.protocol === 'file:') {
    if (actual.href !== expected.href) throw new Error('Solicitação rejeitada: documento inesperado.')
  } else if (actual.origin !== expected.origin) {
    throw new Error('Solicitação rejeitada: origem inesperada.')
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1120,
    minHeight: 720,
    title: 'KageShelf 1.0.1',
    backgroundColor: '#0b0e14',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    try {
      const target = new URL(targetUrl)
      const current = new URL(mainWindow!.webContents.getURL())
      if (current.protocol === 'file:') {
        if (target.href !== current.href) event.preventDefault()
      } else if (target.protocol !== current.protocol || target.origin !== current.origin) {
        event.preventDefault()
      }
    } catch {
      event.preventDefault()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

ipcMain.handle('dialog:select-directory', async (event, initialPath?: string) => {
  assertTrustedRenderer(event)
  const options: Electron.OpenDialogOptions = {
    title: 'Selecionar pasta',
    properties: ['openDirectory', 'dontAddToRecent']
  }
  if (typeof initialPath === 'string' && initialPath.trim() && existsSync(initialPath)) {
    options.defaultPath = initialPath
  }

  const result = await dialog.showOpenDialog(mainWindow!, options)
  return result.canceled ? null : result.filePaths[0] ?? null
})

ipcMain.handle('path:default-destination', (event, sourcePath: unknown) => {
  assertTrustedRenderer(event)
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) return ''
  const resolved = path.resolve(sourcePath.trim())
  return path.join(path.dirname(resolved), `${path.basename(resolved)} [Jellyfin]`)
})

ipcMain.handle('library:scan', async (event, sourcePath: unknown, destinationPath: unknown) => {
  assertTrustedRenderer(event)
  if (typeof sourcePath !== 'string' || typeof destinationPath !== 'string') {
    throw new Error('Informe caminhos válidos para origem e destino.')
  }
  return scanLibrary(sourcePath, destinationPath)
})

ipcMain.handle('plan:build', async (event, scanResult: unknown, aniListId: unknown) => {
  assertTrustedRenderer(event)
  if (!scanResult || typeof scanResult !== 'object') throw new Error('Analise a biblioteca antes de gerar um plano.')
  const candidate = scanResult as Partial<ScanResult>
  if (candidate.mode !== 'read-only-preview' || typeof candidate.sourcePath !== 'string' || typeof candidate.destinationPath !== 'string' || !Array.isArray(candidate.rows)) {
    throw new Error('A prévia recebida não é válida para gerar um plano.')
  }
  if (aniListId !== null && aniListId !== undefined && (typeof aniListId !== 'number' || !Number.isSafeInteger(aniListId) || aniListId <= 0)) {
    throw new Error('ID do AniList inválido para registrar no plano.')
  }
  const plan = await buildOrganizationPlan(candidate as ScanResult, typeof aniListId === 'number' ? aniListId : null)
  issuedPlans.set(plan.id, plan)
  while (issuedPlans.size > 40) issuedPlans.delete(issuedPlans.keys().next().value as string)
  return plan
})

ipcMain.handle('plan:validate', async (event, plan: unknown) => {
  assertTrustedRenderer(event)
  if (!plan || typeof plan !== 'object') throw new Error('Não há plano válido para revalidar.')
  const candidate = plan as Partial<OrganizationPlan>
  if (typeof candidate.id !== 'string' || typeof candidate.previewSignature !== 'string') throw new Error('Identificador de plano inválido.')
  const canonical = issuedPlans.get(candidate.id)
  if (!canonical || canonical.previewSignature !== candidate.previewSignature) throw new Error('Este plano não foi emitido por esta sessão. Gere um plano novo.')
  const validation = await validateOrganizationPlan(canonical)
  canonical.validation = validation
  canonical.approvedAt = null
  return validation
})

ipcMain.handle('plan:approve', async (event, planId: unknown, previewSignatureValue: unknown) => {
  assertTrustedRenderer(event)
  if (typeof planId !== 'string' || typeof previewSignatureValue !== 'string') throw new Error('Dados de aprovação inválidos.')
  const canonical = issuedPlans.get(planId)
  if (!canonical || canonical.previewSignature !== previewSignatureValue) throw new Error('Este plano não corresponde à prévia atual. Gere-o novamente.')
  const validation = await validateOrganizationPlan(canonical)
  canonical.validation = validation
  if (!validation.fresh) throw new Error(`O plano está desatualizado: ${validation.issues.join(' ')}`)
  const blockers = planBlockerMessages(canonical, canonical.previewSignature)
  if (blockers.length || !planCanBeApproved(canonical, canonical.previewSignature)) throw new Error(`O plano não pode ser aprovado: ${blockers.join(' ')}`)
  canonical.approvedAt = new Date().toISOString()
  return { validation, approvedAt: canonical.approvedAt }
})

ipcMain.handle('execution:run', async (event, planId: unknown) => {
  assertTrustedRenderer(event)
  if (typeof planId !== 'string') throw new Error('Identificador do plano inválido.')
  if (activeExecutionPlanId || activeRollbackRunId) throw new Error('Já existe uma operação de organização ou reversão em andamento.')
  const canonical = issuedPlans.get(planId)
  if (!canonical || !canonical.approvedAt) throw new Error('Aprove o plano nesta sessão antes de executá-lo.')
  activeExecutionPlanId = planId
  cancelledPlanIds.delete(planId)
  try {
    return await executeOrganizationPlan(
      canonical,
      app.getPath('userData'),
      (progress: ExecutionProgress) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('execution:progress', progress)
      },
      () => cancelledPlanIds.has(planId)
    )
  } finally {
    const finishedPlan = issuedPlans.get(planId)
    if (finishedPlan) finishedPlan.approvedAt = null
    activeExecutionPlanId = null
    cancelledPlanIds.delete(planId)
  }
})

ipcMain.handle('execution:cancel', (event, planId: unknown) => {
  assertTrustedRenderer(event)
  if (typeof planId === 'string' && planId === activeExecutionPlanId) cancelledPlanIds.add(planId)
})

ipcMain.handle('execution:rollback', async (event, runId: unknown) => {
  assertTrustedRenderer(event)
  if (activeExecutionPlanId || activeRollbackRunId) throw new Error('Aguarde a operação atual terminar antes de reverter arquivos.')
  if (typeof runId !== 'string') throw new Error('Identificador da execução inválido.')
  activeRollbackRunId = runId
  try {
    return await rollbackOrganizationExecution(app.getPath('userData'), runId)
  } finally {
    activeRollbackRunId = null
  }
})

ipcMain.handle('execution:history', async (event) => {
  assertTrustedRenderer(event)
  return listOrganizationExecutionHistory(app.getPath('userData'))
})

ipcMain.handle('execution:resume', async (event, runId: unknown) => {
  assertTrustedRenderer(event)
  if (typeof runId !== 'string') throw new Error('Identificador da execução inválido.')
  if (activeExecutionPlanId || activeRollbackRunId) throw new Error('Já existe uma operação de organização ou reversão em andamento.')
  activeExecutionPlanId = runId
  cancelledPlanIds.delete(runId)
  try {
    return await resumeOrganizationExecution(
      app.getPath('userData'),
      runId,
      (progress: ExecutionProgress) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('execution:progress', progress)
      },
      () => cancelledPlanIds.has(runId)
    )
  } finally {
    activeExecutionPlanId = null
    cancelledPlanIds.delete(runId)
  }
})

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  // Any journal still marked running belongs to a previous app process.
  await markInterruptedExecutionJournals(app.getPath('userData')).catch(() => undefined)
  // Keep the legacy application ID so an NSIS update can replace the existing install.
  app.setAppUserModelId('com.jellyfinanimesupremo.app')
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('path:destination-for-anime', (event, sourcePath: unknown, title: unknown, year: unknown) => {
  assertTrustedRenderer(event)
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new Error('Selecione uma pasta de origem primeiro.')
  if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new Error('Título inválido para sugerir a pasta de destino.')
  if (year !== null && year !== undefined && (typeof year !== 'number' || !Number.isInteger(year) || year < 1900 || year > 2200)) {
    throw new Error('Ano inválido para sugerir a pasta de destino.')
  }
  const source = path.resolve(sourcePath.trim())
  const safeTitle = safeSeriesName(title)
  const yearValue = typeof year === 'number' ? year : null
  const folderLabel = yearValue === null ? safeTitle : `${safeTitle} (${yearValue})`
  return path.join(path.dirname(source), `${folderLabel} [Jellyfin]`)
})

const associationFilePath = () => path.join(app.getPath('userData'), 'anime-associations.json')

ipcMain.handle('association:get', async (event, sourcePath: unknown) => {
  assertTrustedRenderer(event)
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) return null
  return getStoredAssociation(associationFilePath(), sourcePath)
})

ipcMain.handle('association:save', async (event, sourcePath: unknown, anime: unknown) => {
  assertTrustedRenderer(event)
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new Error('Selecione a pasta de origem antes de associar um anime.')
  return saveStoredAssociation(associationFilePath(), sourcePath, anime)
})

ipcMain.handle('association:delete', async (event, sourcePath: unknown) => {
  assertTrustedRenderer(event)
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) return
  await deleteStoredAssociation(associationFilePath(), sourcePath)
})


const correctionFilePath = () => path.join(app.getPath('userData'), 'episode-corrections.json')

ipcMain.handle('episode-corrections:get', async (event, sourcePath: unknown) => {
  assertTrustedRenderer(event)
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) return []
  return getStoredEpisodeCorrections(correctionFilePath(), sourcePath)
})

ipcMain.handle('episode-corrections:save', async (event, sourcePath: unknown, correction: unknown) => {
  assertTrustedRenderer(event)
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) throw new Error('Selecione a pasta de origem antes de salvar uma correção.')
  return saveStoredEpisodeCorrection(correctionFilePath(), sourcePath, correction)
})

ipcMain.handle('episode-corrections:delete', async (event, sourcePath: unknown, relativePath: unknown) => {
  assertTrustedRenderer(event)
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) return
  if (typeof relativePath !== 'string') throw new Error('Caminho relativo inválido para remover a correção.')
  await deleteStoredEpisodeCorrection(correctionFilePath(), sourcePath, relativePath)
})

ipcMain.handle('anilist:search', async (event, query: unknown) => {
  assertTrustedRenderer(event)
  if (typeof query !== 'string') throw new Error('Informe o nome do anime para a pesquisa.')
  return searchAniListAnime(query)
})

ipcMain.handle('anilist:open-page', async (event, animeId: unknown) => {
  assertTrustedRenderer(event)
  if (typeof animeId !== 'number' || !Number.isSafeInteger(animeId) || animeId <= 0) {
    throw new Error('Identificador de anime inválido.')
  }
  await shell.openExternal(`https://anilist.co/anime/${animeId}`)
})
