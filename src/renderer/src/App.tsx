import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, ArrowRight, Check, CheckCircle2, ChevronDown, ClipboardList, CircleDot, ExternalLink, FileText, FileVideo, Folder, FolderOpen, HardDrive, History, Home, Info, Layers, List, Plus, RefreshCw, Search, Settings, ShieldCheck, X, type LucideIcon } from 'lucide-react'
import type { ContentKind, EpisodeCorrection, ExecutionHistoryEntry, ExecutionProgress, ExecutionResult, RollbackResult, ScanResult, PreviewRow, OrganizationPlan, PlanItemStatus } from '../../shared/types'
import type { AniListAnime } from '../../shared/anilistTypes'
import { aniListYear, applyAniListMetadataToPreview, applyEpisodeCorrectionsToPreview, destinationFolderNameFromPath, preferredAniListTitle, revalidatePreview } from '../../shared/previewMetadata'
import { planBlockerMessages, planCanBeApproved, previewSignature } from '../../shared/organizationPlan'

type NavItem = 'Início' | 'Prévia' | 'Plano' | 'Relatórios' | 'Configurações'
type FilterKey = 'all' | 'identified' | 'review'

const navItems: Array<{ label: NavItem; icon: LucideIcon }> = [
  { label: 'Início', icon: Home },
  { label: 'Prévia', icon: List },
  { label: 'Plano', icon: ClipboardList },
  { label: 'Relatórios', icon: History },
  { label: 'Configurações', icon: Settings }
]

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(1)} ${units[index]}`
}

function shortPath(value: string, maxLength = 48): string {
  if (value.length <= maxLength) return value
  return `…${value.slice(value.length - maxLength + 1)}`
}

function statusClass(row: PreviewRow): string {
  if (row.status === 'identified') return 'status status-good'
  if (row.status === 'conflict') return 'status status-conflict'
  if (row.status === 'ambiguous') return 'status status-ambiguous'
  return 'status status-review'
}

function Confidence({ value }: { value: PreviewRow['confidence'] }) {
  if (!value) return <span className="confidence confidence-na">—</span>
  const className = value === 'alta' ? 'confidence confidence-high' : value === 'média' ? 'confidence confidence-medium' : 'confidence confidence-low'
  const label = value === 'alta' ? 'Alta' : value === 'média' ? 'Média' : 'Baixa'
  return <span className={className}>{label}</span>
}

function EmptyState({ onPick }: { onPick: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-illustration"><FolderOpen size={31} strokeWidth={1.7} aria-hidden="true" /><i><Plus size={14} strokeWidth={2} aria-hidden="true" /></i></div>
      <h2>Vamos organizar seus animes?</h2>
      <p>Escolha a pasta da série. A versão 1.0.0 reúne identificação, metadados, plano e cópia verificada; a origem permanece intacta.</p>
      <button className="button button-primary" onClick={onPick}>Escolher pasta de origem</button>
    </div>
  )
}

export default function App() {
  const [activeNav, setActiveNav] = useState<NavItem>('Início')
  const [sourcePath, setSourcePath] = useState('')
  const [destinationPath, setDestinationPath] = useState('')
  const [result, setResult] = useState<ScanResult | null>(null)
  const [baseResult, setBaseResult] = useState<ScanResult | null>(null)
  const [destinationIsAutomatic, setDestinationIsAutomatic] = useState(true)
  const [selectedRow, setSelectedRow] = useState<PreviewRow | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [aniListQuery, setAniListQuery] = useState('')
  const [aniListResults, setAniListResults] = useState<AniListAnime[]>([])
  const [selectedAnime, setSelectedAnime] = useState<AniListAnime | null>(null)
  const [aniListBusy, setAniListBusy] = useState(false)
  const [aniListError, setAniListError] = useState('')
  const [aniListNotice, setAniListNotice] = useState('')
  const [episodeCorrections, setEpisodeCorrections] = useState<EpisodeCorrection[]>([])
  const [draftKind, setDraftKind] = useState<ContentKind>('episode')
  const [draftSeason, setDraftSeason] = useState('1')
  const [draftEpisode, setDraftEpisode] = useState('')
  const [correctionBusy, setCorrectionBusy] = useState(false)
  const [correctionError, setCorrectionError] = useState('')
  const [organizationPlan, setOrganizationPlan] = useState<OrganizationPlan | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [planError, setPlanError] = useState('')
  const [planNotice, setPlanNotice] = useState('')
  const [planFilter, setPlanFilter] = useState<'all' | PlanItemStatus>('all')
  const [executionBusy, setExecutionBusy] = useState(false)
  const [executionProgress, setExecutionProgress] = useState<ExecutionProgress | null>(null)
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null)
  const [executionError, setExecutionError] = useState('')
  const [rollbackBusy, setRollbackBusy] = useState(false)
  const [rollbackResult, setRollbackResult] = useState<RollbackResult | null>(null)
  const [executionHistory, setExecutionHistory] = useState<ExecutionHistoryEntry[]>([])
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyError, setHistoryError] = useState('')
  const [historyActionRunId, setHistoryActionRunId] = useState<string | null>(null)
  const analysisRequestId = useRef(0)
  const planRequestId = useRef(0)
  const aniListSearchRequestId = useRef(0)

  function invalidateAnalysisRequest(): void {
    analysisRequestId.current += 1
    aniListSearchRequestId.current += 1
    setBusy(false)
    setAniListBusy(false)
    setCorrectionBusy(false)

    // A changed preview context invalidates any in-flight plan request and
    // revokes approval of a plan built from the previous context. Keep the
    // active plan intact while copying so its cancel action remains available.
    if (!executionBusy) {
      planRequestId.current += 1
      setPlanBusy(false)
      setOrganizationPlan((current) => {
        if (!current) return current
        const reason = 'O contexto da prévia foi alterado. Revalide o plano antes de aprová-lo novamente.'
        const issues = current.validation?.issues ?? []
        return {
          ...current,
          approvedAt: null,
          validation: {
            checkedAt: new Date().toISOString(),
            fresh: false,
            issues: issues.includes(reason) ? issues : [...issues, reason]
          }
        }
      })
    }
  }

  useEffect(() => window.kageShelf.onExecutionProgress(setExecutionProgress), [])
  useEffect(() => { if (activeNav === 'Relatórios') void refreshExecutionHistory() }, [activeNav])

  const identifiedCount = result?.rows.filter((row) => row.status === 'identified').length ?? 0
  const reviewCount = result?.rows.filter((row) => row.status !== 'identified').length ?? 0

  const visibleRows = useMemo(() => {
    if (!result) return []
    const needle = search.trim().toLocaleLowerCase('pt-BR')
    return result.rows.filter((row) => {
      const matchesSearch = !needle || row.originalName.toLocaleLowerCase('pt-BR').includes(needle) || (row.outputRelativePath ?? '').toLocaleLowerCase('pt-BR').includes(needle)
      const matchesFilter = filter === 'all' || (filter === 'identified' && row.status === 'identified') || (filter === 'review' && row.status !== 'identified')
      return matchesSearch && matchesFilter
    })
  }, [result, search, filter])

  const treeGroups = useMemo(() => {
    if (!result) return []
    const groups = new Map<string, string[]>()
    for (const row of result.rows) {
      if (!row.outputRelativePath) continue
      const segments = row.outputRelativePath.replace(/\\/g, '/').split('/')
      const seasonFolder = segments.length > 1 ? segments[0] : 'Arquivos na raiz'
      const fileName = segments.length > 1 ? segments.slice(1).join('/') : segments[0]
      if (!seasonFolder || !fileName) continue
      const items = groups.get(seasonFolder) ?? []
      if (!items.includes(fileName)) items.push(fileName)
      groups.set(seasonFolder, items)
    }
    return [...groups.entries()].map(([seasonFolder, items]) => ({ seasonFolder, items }))
  }, [result])
  const treeDisplayedCount = treeGroups.reduce((total, group) => total + group.items.length, 0)
  const treeGroupsVisible = useMemo(() => {
    let remaining = 13
    return treeGroups.map((group) => {
      const items = group.items.slice(0, remaining)
      remaining = Math.max(0, remaining - items.length)
      return { seasonFolder: group.seasonFolder, items }
    }).filter((group) => group.items.length > 0)
  }, [treeGroups])
  const treeRows = treeGroupsVisible.flatMap((group) => group.items)

  async function pickSource(): Promise<void> {
    if (executionBusy) return
    setError('')
    setNotice('')
    let selectionRequestId: number | null = null
    try {
      const picked = await window.kageShelf.selectDirectory(sourcePath || undefined)
      if (!picked) return
      invalidateAnalysisRequest()
      selectionRequestId = analysisRequestId.current
      setSourcePath(picked)
      setDestinationPath('')
      setDestinationIsAutomatic(true)
      // Clear the previous preview/plan context before waiting for IPC.
      setResult(null)
      setBaseResult(null)
      setSelectedRow(null)
      setEpisodeCorrections([])
      setCorrectionError('')
      setAniListResults([])
      setSelectedAnime(null)
      setAniListError('')
      setAniListNotice('')

      const suggested = await window.kageShelf.defaultDestination(picked)
      // Do not let a stale picker response overwrite a newer path selection.
      if (selectionRequestId === null || analysisRequestId.current !== selectionRequestId) return
      setDestinationPath(suggested)
    } catch (cause) {
      if (selectionRequestId !== null && analysisRequestId.current !== selectionRequestId) return
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function pickDestination(): Promise<void> {
    if (executionBusy) return
    setError('')
    setNotice('')
    try {
      const picked = await window.kageShelf.selectDirectory(destinationPath || undefined)
      if (!picked) return
      invalidateAnalysisRequest()
      setDestinationPath(picked)
      setDestinationIsAutomatic(false)
      setResult(null)
      setBaseResult(null)
      setSelectedRow(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function analyze(): Promise<void> {
    if (executionBusy) return
    invalidateAnalysisRequest()
    const requestId = analysisRequestId.current
    const requestedSourcePath = sourcePath
    const requestedDestinationPath = destinationPath
    const useAutomaticDestination = destinationIsAutomatic
    const isCurrentRequest = () => analysisRequestId.current === requestId

    setError('')
    setNotice('')
    setSelectedRow(null)
    setCorrectionError('')
    setBusy(true)
    try {
      const scanned = await window.kageShelf.scan(requestedSourcePath, requestedDestinationPath)
      if (!isCurrentRequest()) return

      setBaseResult(scanned)
      setDestinationPath(scanned.destinationPath)
      setAniListQuery(scanned.seriesName)
      setAniListResults([])
      setAniListError('')
      setAniListNotice('')
      setSelectedAnime(null)

      let corrections: EpisodeCorrection[] = []
      try {
        corrections = await window.kageShelf.getEpisodeCorrections(requestedSourcePath)
      } catch (correctionCause) {
        if (!isCurrentRequest()) return
        setCorrectionError(correctionCause instanceof Error ? correctionCause.message : String(correctionCause))
      }
      if (!isCurrentRequest()) return

      setEpisodeCorrections(corrections)
      const correctedPreview = applyEpisodeCorrectionsToPreview(scanned, corrections)
      let shownPreview = correctedPreview
      let targetPath = scanned.destinationPath

      try {
        const association = await window.kageShelf.getAniListAssociation(requestedSourcePath)
        if (!isCurrentRequest()) return
        if (association) {
          if (useAutomaticDestination) {
            targetPath = await window.kageShelf.defaultDestinationForAnime(
              requestedSourcePath,
              preferredAniListTitle(association.anime, scanned.seriesName),
              aniListYear(association.anime)
            )
            if (!isCurrentRequest()) return
          }
          setSelectedAnime(association.anime)
          setAniListQuery(preferredAniListTitle(association.anime, scanned.seriesName))
          setAniListNotice(`Associação salva recuperada para AniList #${association.anime.id}.`)
          shownPreview = applyAniListMetadataToPreview(correctedPreview, association.anime, targetPath)
        }
      } catch (associationCause) {
        if (!isCurrentRequest()) return
        setAniListError(associationCause instanceof Error ? associationCause.message : String(associationCause))
      }
      if (!isCurrentRequest()) return

      setDestinationPath(targetPath)
      setResult(shownPreview)
      if (shownPreview.rows.length > 0) setActiveNav('Prévia')
      const warningCount = shownPreview.warnings.length
      if (warningCount > 0) setNotice('Análise concluída com observações. Confira os conflitos e os itens que precisam de revisão.')
      else setNotice(`Análise concluída em ${scanned.scanDurationMs} ms. Nenhum arquivo foi alterado.`)
    } catch (cause) {
      if (!isCurrentRequest()) return
      setError(cause instanceof Error ? cause.message : String(cause))
      setResult(null)
      setBaseResult(null)
      setEpisodeCorrections([])
    } finally {
      if (isCurrentRequest()) setBusy(false)
    }
  }

  function showOrganizerNotice(): void {
    setNotice('O aplicativo copia itens aprovados, verifica SHA-256 e preserva a origem.')
    setError('')
  }

  async function generateOrganizationPlan(): Promise<void> {
    if (executionBusy) return
    if (!result) {
      setPlanError('Analise uma pasta antes de gerar um plano de organização.')
      setActiveNav('Plano')
      return
    }
    const requestId = ++planRequestId.current
    setPlanBusy(true)
    setPlanError('')
    setPlanNotice('')
    try {
      const plan = await window.kageShelf.buildOrganizationPlan(result, selectedAnime?.id ?? null)
      if (requestId !== planRequestId.current) return
      setOrganizationPlan(plan)
      setExecutionProgress(null)
      setExecutionResult(null)
      setExecutionError('')
      setRollbackResult(null)
      setPlanNotice(`Plano ${plan.id.slice(0, 8)} gerado. Nenhum arquivo foi alterado.`)
      setActiveNav('Plano')
    } catch (cause) {
      if (requestId !== planRequestId.current) return
      setPlanError(cause instanceof Error ? cause.message : String(cause))
      setActiveNav('Plano')
    } finally {
      if (requestId === planRequestId.current) setPlanBusy(false)
    }
  }

  async function revalidateOrganizationPlan(): Promise<void> {
    if (!organizationPlan || executionBusy) return
    const currentSignature = result ? previewSignature(result) : null
    if (currentSignature !== organizationPlan.previewSignature) {
      setPlanError('A prévia mudou desde a geração deste plano. Gere um novo plano antes de validá-lo.')
      return
    }
    const requestId = ++planRequestId.current
    setPlanBusy(true)
    setPlanError('')
    setPlanNotice('')
    try {
      const validation = await window.kageShelf.validateOrganizationPlan(organizationPlan)
      if (requestId !== planRequestId.current) return
      const updated = { ...organizationPlan, validation, approvedAt: null }
      setOrganizationPlan(updated)
      setPlanNotice(validation.fresh
        ? 'A origem e os destinos foram rechecados. O plano continua somente leitura.'
        : 'Foram detectadas mudanças desde a geração do plano. Reanalise e gere um plano novo.')
    } catch (cause) {
      if (requestId !== planRequestId.current) return
      setPlanError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (requestId === planRequestId.current) setPlanBusy(false)
    }
  }

  async function approveOrganizationPlan(): Promise<void> {
    if (!organizationPlan || executionBusy) return
    const currentSignature = result ? previewSignature(result) : null
    const blockers = planBlockerMessages(organizationPlan, currentSignature)
    if (blockers.length > 0 || !planCanBeApproved(organizationPlan, currentSignature)) {
      setPlanError(`O plano ainda não pode ser aprovado: ${blockers.join(' ')}`)
      return
    }

    // Recheck the filesystem immediately before a local approval. This is still
    // a read-only operation; it does not execute the plan.
    const requestId = ++planRequestId.current
    setPlanBusy(true)
    setPlanError('')
    try {
      const approval = await window.kageShelf.approveOrganizationPlan(organizationPlan.id, organizationPlan.previewSignature)
      if (requestId !== planRequestId.current) return
      setOrganizationPlan({ ...organizationPlan, validation: approval.validation, approvedAt: approval.approvedAt })
      setPlanNotice('Plano aprovado. A cópia só começa após uma segunda confirmação explícita.')
    } catch (cause) {
      if (requestId !== planRequestId.current) return
      setPlanError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (requestId === planRequestId.current) setPlanBusy(false)
    }
  }

  async function executeApprovedOrganizationPlan(): Promise<void> {
    if (!organizationPlan || !organizationPlan.approvedAt || executionBusy || planBusy) return
    const currentSignature = result ? previewSignature(result) : null
    if (currentSignature !== organizationPlan.previewSignature) {
      setPlanError('A prévia mudou desde a geração deste plano. Gere um novo plano antes de executar a cópia.')
      return
    }
    if (!organizationPlan.validation?.fresh) {
      setPlanError('Revalide o plano antes de executar a cópia.')
      return
    }
    if (!window.confirm(`Copiar ${organizationPlan.items.length} arquivos (${formatBytes(organizationPlan.summary.totalBytes)}) para:
${organizationPlan.destinationPath}

A origem será preservada. Continuar?`)) return
    setExecutionBusy(true)
    setExecutionError('')
    setExecutionResult(null)
    setRollbackResult(null)
    setExecutionProgress({ runId: '', planId: organizationPlan.id, stage: 'preparing', completedFiles: 0, totalFiles: organizationPlan.items.length, bytesCopied: 0, totalBytes: organizationPlan.summary.totalBytes, currentFile: null, message: 'Validando plano antes de iniciar.' })
    try {
      const result = await window.kageShelf.executeOrganizationPlan(organizationPlan.id)
      setExecutionResult(result)
      setOrganizationPlan((current) => current && current.id === result.planId ? { ...current, approvedAt: null, validation: { checkedAt: new Date().toISOString(), fresh: false, issues: ['A execução alterou o destino; gere e valide um novo plano antes de outra operação.'] } } : current)
      if (result.status === 'completed') setPlanNotice(`Cópia concluída: ${result.copiedFiles} arquivo(s), com verificação SHA-256.`)
      else if (result.status === 'cancelled') setPlanNotice(`Execução cancelada após copiar ${result.copiedFiles} arquivo(s). Os arquivos concluídos foram preservados.`)
      else setExecutionError(result.errors.join(' ') || 'A execução terminou com falha. Confira o registro antes de tentar novamente.')
    } catch (cause) {
      setExecutionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setExecutionBusy(false)
    }
  }

  async function cancelApprovedOrganizationPlan(): Promise<void> {
    if (!organizationPlan || !executionBusy) return
    await window.kageShelf.cancelOrganizationExecution(organizationPlan.id)
    setPlanNotice('Cancelamento solicitado. A cópia atual será interrompida de forma controlada.')
  }

  async function rollbackLastExecution(): Promise<void> {
    if (!executionResult?.rollbackAvailable || rollbackBusy) return
    if (!window.confirm('Tentar reverter esta execução? Só serão removidos arquivos criados por ela que ainda correspondam ao conteúdo verificado.')) return
    setRollbackBusy(true)
    setExecutionError('')
    try {
      const result = await window.kageShelf.rollbackOrganizationExecution(executionResult.runId)
      setRollbackResult(result)
      if (result.errors.length) setExecutionError(result.errors.join(' '))
      else setPlanNotice(`Reversão concluída: ${result.removedFiles} arquivo(s) removido(s). A origem permaneceu intacta.`)
      setExecutionResult((current) => current ? { ...current, status: result.skippedFiles === 0 ? 'rolled-back' : 'partially-rolled-back', rollbackAvailable: result.skippedFiles > 0, errors: [...current.errors, ...result.errors] } : current)
    } catch (cause) {
      setExecutionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRollbackBusy(false)
    }
  }


  async function refreshExecutionHistory(): Promise<void> {
    setHistoryBusy(true)
    setHistoryError('')
    try {
      setExecutionHistory(await window.kageShelf.listOrganizationExecutionHistory())
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setHistoryBusy(false)
    }
  }

  async function resumeHistoryExecution(entry: ExecutionHistoryEntry): Promise<void> {
    if (!entry.resumable || executionBusy) return
    setHistoryActionRunId(entry.runId)
    setExecutionBusy(true)
    setExecutionError('')
    setExecutionResult(null)
    setExecutionProgress({ runId: entry.runId, planId: entry.planId, stage: 'preparing', completedFiles: entry.completedFiles, totalFiles: entry.totalFiles, bytesCopied: entry.copiedBytes, totalBytes: 0, currentFile: null, message: 'Revalidando os arquivos antes de retomar.' })
    try {
      const result = await window.kageShelf.resumeOrganizationExecution(entry.runId)
      setExecutionResult(result)
      if (result.status === 'completed') setNotice(`Retomada concluída: ${result.copiedFiles} arquivo(s) verificados.`)
      else if (result.status === 'cancelled') setNotice(`Retomada cancelada após ${result.copiedFiles} arquivo(s) concluídos.`)
      else setExecutionError(result.errors.join(' ') || 'A retomada terminou com atenção. Confira o histórico.')
    } catch (cause) {
      setExecutionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setExecutionBusy(false)
      setHistoryActionRunId(null)
      await refreshExecutionHistory()
    }
  }

  async function rollbackHistoryExecution(entry: ExecutionHistoryEntry): Promise<void> {
    if (!entry.rollbackAvailable || executionBusy || rollbackBusy) return
    if (!window.confirm(`Reverter a execução ${entry.runId.slice(0, 8)}? Só serão removidos arquivos ainda idênticos aos registrados. Arquivos alterados serão preservados.`)) return
    setRollbackBusy(true)
    setHistoryError('')
    try {
      const result = await window.kageShelf.rollbackOrganizationExecution(entry.runId)
      if (result.errors.length) setHistoryError(result.errors.join(' '))
      else setNotice(`Reversão concluída: ${result.removedFiles} arquivo(s) removido(s).`)
      await refreshExecutionHistory()
    } catch (cause) {
      setHistoryError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRollbackBusy(false)
    }
  }

  function executionStatusLabel(status: ExecutionHistoryEntry['status']): string {
    const labels: Record<ExecutionHistoryEntry['status'], string> = {
      completed: 'Concluída', cancelled: 'Cancelada', failed: 'Falhou', interrupted: 'Interrompida', running: 'Em andamento',
      'rolled-back': 'Revertida', 'partially-rolled-back': 'Reversão parcial'
    }
    return labels[status]
  }

  async function searchAniList(): Promise<void> {
    if (executionBusy) return
    const requestId = ++aniListSearchRequestId.current
    const query = aniListQuery
    setAniListError('')
    setAniListNotice('')
    setAniListBusy(true)
    try {
      const response = await window.kageShelf.searchAniList(query)
      if (requestId !== aniListSearchRequestId.current) return
      setAniListResults(response.results)
      if (response.results.length === 0) {
        setAniListNotice('Nenhuma correspondência encontrada. Tente outro título ou pesquise pelo nome romanizado.')
      } else if (response.cached) {
        setAniListNotice(`${response.results.length} resultado(s) recuperado(s) do cache local.`)
      } else {
        setAniListNotice(`${response.results.length} candidato(s) encontrado(s). Confira o ano e o formato antes de associar.`)
      }
    } catch (cause) {
      if (requestId !== aniListSearchRequestId.current) return
      setAniListError(cause instanceof Error ? cause.message : String(cause))
      setAniListResults([])
    } finally {
      if (requestId === aniListSearchRequestId.current) setAniListBusy(false)
    }
  }

  async function chooseAniListAnime(anime: AniListAnime): Promise<void> {
    if (executionBusy) return
    if (!sourcePath.trim() || !baseResult) {
      setAniListError('Analise uma pasta antes de associar os metadados do AniList.')
      return
    }

    invalidateAnalysisRequest()
    const requestId = analysisRequestId.current
    const requestedSourcePath = sourcePath
    const requestedBaseResult = baseResult
    const requestedCorrections = episodeCorrections
    const requestedDestinationPath = destinationPath
    const useAutomaticDestination = destinationIsAutomatic
    const requestedSelectedRow = selectedRow

    setAniListBusy(true)
    setAniListError('')
    setAniListNotice('')
    try {
      let targetPath = requestedDestinationPath || requestedBaseResult.destinationPath
      if (useAutomaticDestination) {
        targetPath = await window.kageShelf.defaultDestinationForAnime(
          requestedSourcePath,
          preferredAniListTitle(anime, requestedBaseResult.seriesName),
          aniListYear(anime)
        )
        if (analysisRequestId.current !== requestId) return
      }
      await window.kageShelf.saveAniListAssociation(requestedSourcePath, anime)
      if (analysisRequestId.current !== requestId) return
      setSelectedAnime(anime)
      setAniListResults([])
      setAniListQuery(preferredAniListTitle(anime, requestedBaseResult.seriesName))
      setDestinationPath(targetPath)
      const correctedBase = applyEpisodeCorrectionsToPreview(requestedBaseResult, requestedCorrections)
      const metadataPreview = applyAniListMetadataToPreview(correctedBase, anime, targetPath)
      setResult(metadataPreview)
      if (requestedSelectedRow) setSelectedRow(metadataPreview.rows.find((row) => row.id === requestedSelectedRow.id) ?? null)
      setAniListNotice(`Associado a “${metadataPreview.seriesName}”. A escolha foi salva localmente e atualizou a prévia; cada episódio ainda precisa ser validado.`)
      setNotice('Metadados aplicados à prévia. Nenhum arquivo foi alterado.')
    } catch (cause) {
      if (analysisRequestId.current !== requestId) return
      setAniListError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (analysisRequestId.current === requestId) setAniListBusy(false)
    }
  }

  async function clearAniListAnime(): Promise<void> {
    if (executionBusy) return
    invalidateAnalysisRequest()
    const requestId = analysisRequestId.current
    const requestedSourcePath = sourcePath
    const requestedBaseResult = baseResult
    const requestedCorrections = episodeCorrections
    const requestedDestinationPath = destinationPath
    const useAutomaticDestination = destinationIsAutomatic
    const requestedSelectedRow = selectedRow

    setAniListBusy(true)
    setAniListError('')
    try {
      if (requestedSourcePath.trim()) await window.kageShelf.removeAniListAssociation(requestedSourcePath)
      if (analysisRequestId.current !== requestId) return

      let resetPath = requestedDestinationPath || requestedBaseResult?.destinationPath || ''
      if (requestedBaseResult && useAutomaticDestination) {
        resetPath = await window.kageShelf.defaultDestination(requestedSourcePath)
        if (analysisRequestId.current !== requestId) return
      }

      setSelectedAnime(null)
      setAniListResults([])
      if (requestedBaseResult) {
        const correctedBase = applyEpisodeCorrectionsToPreview(requestedBaseResult, requestedCorrections)
        const restored = revalidatePreview(correctedBase, correctedBase.seriesName, resetPath)
        setResult(restored)
        setDestinationPath(resetPath)
        setSelectedRow(requestedSelectedRow ? restored.rows.find((row) => row.id === requestedSelectedRow.id) ?? null : null)
      }
      setAniListNotice('Associação local removida. A prévia voltou a usar o nome da pasta de origem. Nenhum arquivo foi alterado.')
      setNotice('Associação removida. Nenhum arquivo foi alterado.')
    } catch (cause) {
      if (analysisRequestId.current !== requestId) return
      setAniListError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (analysisRequestId.current === requestId) setAniListBusy(false)
    }
  }

  function selectPreviewRow(row: PreviewRow): void {
    setSelectedRow(row)
    setDraftKind(row.contentKind)
    setDraftSeason(row.season === null || row.season === 0 ? '1' : String(row.season))
    setDraftEpisode(row.episode === null ? '' : String(row.episode))
    setCorrectionError('')
  }

  function currentPreviewWithCorrections(corrections: EpisodeCorrection[]): ScanResult | null {
    if (!baseResult) return null
    const corrected = applyEpisodeCorrectionsToPreview(baseResult, corrections)
    return selectedAnime
      ? applyAniListMetadataToPreview(corrected, selectedAnime, destinationPath || corrected.destinationPath)
      : revalidatePreview(corrected, corrected.seriesName, destinationPath || corrected.destinationPath)
  }

  async function saveManualCorrection(event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault()
    if (executionBusy) return
    if (!selectedRow || !baseResult || !sourcePath.trim()) return
    setCorrectionError('')

    const episodeValue = draftKind === 'movie' ? null : Number(draftEpisode)
    const seasonValue = draftKind === 'episode' ? Number(draftSeason) : draftKind === 'special' ? 0 : null
    if (draftKind !== 'movie' && (!Number.isInteger(episodeValue) || episodeValue === null || episodeValue < 1 || episodeValue > 999)) {
      setCorrectionError('Informe um episódio válido entre 1 e 999.')
      return
    }
    if (draftKind === 'episode' && (!Number.isInteger(seasonValue) || seasonValue === null || seasonValue < 1 || seasonValue > 99)) {
      setCorrectionError('Informe uma temporada válida entre 1 e 99.')
      return
    }

    const correction: EpisodeCorrection = {
      relativePath: selectedRow.relativePath,
      originalName: selectedRow.originalName,
      sizeBytes: selectedRow.sizeBytes,
      modifiedAtMs: selectedRow.modifiedAtMs,
      contentKind: draftKind,
      specialLabel: draftKind === 'special'
        ? `${(selectedRow.specialLabel ?? 'Special').replace(/\s+\d{1,3}$/, '').trim()} ${String(episodeValue).padStart(2, '0')}`
        : null,
      season: seasonValue,
      episode: episodeValue,
      updatedAt: new Date().toISOString()
    }

    invalidateAnalysisRequest()
    const requestId = analysisRequestId.current
    setCorrectionBusy(true)
    try {
      const saved = await window.kageShelf.saveEpisodeCorrection(sourcePath, correction)
      if (analysisRequestId.current !== requestId) return
      const nextCorrections = [...episodeCorrections.filter((item) => item.relativePath !== saved.relativePath), saved]
      setEpisodeCorrections(nextCorrections)
      const nextPreview = currentPreviewWithCorrections(nextCorrections)
      if (nextPreview) {
        setResult(nextPreview)
        const refreshedRow = nextPreview.rows.find((row) => row.id === selectedRow.id) ?? null
        if (refreshedRow) selectPreviewRow(refreshedRow)
        else setSelectedRow(null)
      }
      setNotice('Correção salva localmente e aplicada à prévia. Nenhum arquivo foi alterado.')
    } catch (cause) {
      if (analysisRequestId.current !== requestId) return
      setCorrectionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (analysisRequestId.current === requestId) setCorrectionBusy(false)
    }
  }

  async function removeManualCorrection(): Promise<void> {
    if (executionBusy) return
    if (!selectedRow || !sourcePath.trim()) return
    invalidateAnalysisRequest()
    const requestId = analysisRequestId.current
    setCorrectionBusy(true)
    setCorrectionError('')
    try {
      await window.kageShelf.removeEpisodeCorrection(sourcePath, selectedRow.relativePath)
      if (analysisRequestId.current !== requestId) return
      const nextCorrections = episodeCorrections.filter((item) => item.relativePath !== selectedRow.relativePath)
      setEpisodeCorrections(nextCorrections)
      const nextPreview = currentPreviewWithCorrections(nextCorrections)
      if (nextPreview) {
        setResult(nextPreview)
        const refreshedRow = nextPreview.rows.find((row) => row.id === selectedRow.id) ?? null
        if (refreshedRow) selectPreviewRow(refreshedRow)
        else setSelectedRow(null)
      }
      setNotice('Correção removida. A identificação automática voltou à prévia; nenhum arquivo foi alterado.')
    } catch (cause) {
      if (analysisRequestId.current !== requestId) return
      setCorrectionError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (analysisRequestId.current === requestId) setCorrectionBusy(false)
    }
  }

  function formatAniListValue(value: string | null): string {
    if (!value) return 'Não informado'
    const spaced = value.replace(/_/g, ' ').toLocaleLowerCase('pt-BR')
    return spaced.charAt(0).toLocaleUpperCase('pt-BR') + spaced.slice(1)
  }

  const pageTitle = activeNav === 'Início' ? 'Visão geral' : activeNav
  const currentPreviewSignature = result ? previewSignature(result) : null
  const planPreviewIsCurrent = Boolean(organizationPlan && currentPreviewSignature === organizationPlan.previewSignature)
  const planBlockers = organizationPlan ? planBlockerMessages(organizationPlan, currentPreviewSignature) : []
  const canApproveCurrentPlan = Boolean(organizationPlan && planCanBeApproved(organizationPlan, currentPreviewSignature))
  const visiblePlanItems = organizationPlan?.items.filter((item) => planFilter === 'all' || item.status === planFilter) ?? []

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark"><Layers size={23} strokeWidth={1.7} aria-hidden="true" /></div>
          <div className="brand-copy">
            <div className="brand-title">Kage<span>Shelf</span></div>
            <div className="brand-version">VERSÃO <b>v1.0.0</b></div>
          </div>
        </div>

        <div className="nav-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Navegação principal">
          {navItems.map((item) => (
            <button key={item.label} className={`nav-item ${activeNav === item.label ? 'active' : ''}`} onClick={() => { setActiveNav(item.label); setError(''); setNotice('') }}>
              <span className="nav-glyph"><item.icon size={17} strokeWidth={1.8} aria-hidden="true" /></span>
              <span>{item.label}</span>
              {item.label === 'Prévia' && result && <span className="nav-count">{result.videoCount}</span>}
              {item.label === 'Plano' && organizationPlan && <span className="nav-count">{organizationPlan.summary.total}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-spacer" />
        <div className="sidebar-safety">
          <div className="safety-icon"><Check size={14} strokeWidth={2.2} aria-hidden="true" /></div>
          <div>
            <strong>Modo seguro</strong>
            <p>A origem nunca é alterada. Cópias exigem aprovação e confirmação.</p>
          </div>
        </div>
        <div className="sidebar-footer">
          <span className="online-dot" /> Versão estável 1.0.0
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>Workspace</span><span className="crumb-sep">/</span><strong>{pageTitle}</strong></div>
          <div className="topbar-right">
            <span className="local-pill"><span className="online-dot" /> LOCAL</span>
            <div className="avatar">JA</div>
          </div>
        </header>

        {activeNav === 'Configurações' ? (
          <section className="page-content">
            <div className="page-heading"><div><div className="eyebrow">PREFERÊNCIAS</div><h1>Configurações</h1><p>Preferências locais do aplicativo.</p></div></div>
            <div className="settings-card">
              <h3>Versão e comportamento</h3>
              <div className="setting-row"><div><strong>Versão do aplicativo</strong><p>KageShelf 1.0.0</p></div><span className="setting-value">Estável</span></div>
              <div className="setting-row"><div><strong>Operações de arquivos</strong><p>Cópias aprovadas são verificadas por SHA-256; a origem é preservada.</p></div><span className="setting-value setting-safe">Cópia verificada</span></div>
              <div className="setting-row"><div><strong>Seguimento de links simbólicos</strong><p>Pastas e arquivos simbólicos são ignorados durante a varredura.</p></div><span className="setting-value">Desativado</span></div>
            </div>
          </section>
        ) : activeNav === 'Relatórios' ? (
          <section className="page-content">
            <div className="page-heading"><div><div className="eyebrow">HISTÓRICO LOCAL · 1.0.0</div><h1>Execuções</h1><p>Operações salvas localmente. Execuções interrompidas podem ser retomadas após revalidar origem e destino.</p></div><button className="button button-secondary" onClick={() => void refreshExecutionHistory()} disabled={historyBusy}>{historyBusy ? 'Atualizando…' : 'Atualizar histórico'}</button></div>
            {historyError && <div className="alert alert-error"><span><AlertTriangle size={14} strokeWidth={1.9} aria-hidden="true" /></span><p>{historyError}</p><button onClick={() => setHistoryError('')} aria-label="Fechar aviso"><X size={14} strokeWidth={1.9} aria-hidden="true" /></button></div>}
            {executionError && <div className="alert alert-error"><span><AlertTriangle size={14} strokeWidth={1.9} aria-hidden="true" /></span><p>{executionError}</p><button onClick={() => setExecutionError('')} aria-label="Fechar aviso"><X size={14} strokeWidth={1.9} aria-hidden="true" /></button></div>}
            {executionBusy && historyActionRunId && <section className="execution-card"><strong>Retomando execução {historyActionRunId.slice(0, 8)}</strong><p>{executionProgress?.message ?? 'Revalidando os arquivos…'}</p>{executionProgress && <><div className="execution-progress-track"><span style={{ width: `${executionProgress.totalBytes > 0 ? Math.min(100, (executionProgress.bytesCopied / executionProgress.totalBytes) * 100) : 0}%` }} /></div><small>{executionProgress.completedFiles}/{executionProgress.totalFiles} arquivo(s) · {formatBytes(executionProgress.bytesCopied)} / {formatBytes(executionProgress.totalBytes)}</small><button className="button button-danger" onClick={() => void window.kageShelf.cancelOrganizationExecution(historyActionRunId)}>Cancelar retomada</button></>}</section>}
            {historyBusy && executionHistory.length === 0 ? <div className="empty-panel"><h3>Carregando histórico…</h3></div> : executionHistory.length === 0 ? <div className="empty-panel"><div className="panel-symbol"><History size={23} strokeWidth={1.7} aria-hidden="true" /></div><h3>Nenhuma execução registrada</h3><p>As cópias, cancelamentos e falhas aparecerão aqui.</p><button className="button button-secondary" onClick={() => setActiveNav('Início')}>Voltar ao início</button></div> : <div className="execution-history-list">{executionHistory.map((entry) => <article className="execution-history-card" key={entry.runId}><div className="history-card-top"><div><strong>Execução {entry.runId.slice(0, 8)}</strong><small>{new Date(entry.createdAt).toLocaleString()}</small></div><span className={`plan-status ${entry.status === 'completed' ? 'plan-status-ready' : entry.status === 'failed' || entry.status === 'interrupted' ? 'plan-status-conflict' : entry.status === 'cancelled' || entry.status === 'running' ? 'plan-status-review' : 'plan-status-pending'}`}>{executionStatusLabel(entry.status)}</span></div><div className="history-paths"><div><small>Origem</small><code>{entry.sourcePath}</code></div><div><small>Destino</small><code>{entry.destinationPath}</code></div></div><div className="history-stats"><span>{entry.completedFiles}/{entry.totalFiles} arquivo(s) verificados</span><span>{formatBytes(entry.copiedBytes)} copiados</span>{entry.remainingFiles > 0 && <span>{entry.remainingFiles} pendente(s)</span>}{entry.rolledBackFiles > 0 && <span>{entry.rolledBackFiles} revertido(s)</span>}{entry.attempts > 1 && <span>{entry.attempts} tentativas/retomadas</span>}</div>{entry.errors.length > 0 && entry.status !== 'completed' && <p className="history-errors">{entry.errors.slice(-2).join(' ')}</p>}<div className="history-actions">{entry.resumable && <button className="button button-primary" onClick={() => void resumeHistoryExecution(entry)} disabled={executionBusy || rollbackBusy}>Retomar com validação</button>}{entry.rollbackAvailable && <button className="button button-secondary" onClick={() => void rollbackHistoryExecution(entry)} disabled={executionBusy || rollbackBusy}>{rollbackBusy ? 'Aguarde…' : 'Reverter arquivos registrados'}</button>}</div></article>)}</div>}
          </section>
        ) : activeNav === 'Plano' ? (
          <section className="page-content plan-page">
            <div className="page-heading">
              <div>
                <div className="eyebrow">1.0.0 · CÓPIA VERIFICADA</div>
                <h1>Plano de organização</h1>
                <p>Revalide, aprove e confirme antes de copiar. Cada arquivo é verificado por SHA-256.</p>
              </div>
              <div className="read-only-tag"><CircleDot size={14} strokeWidth={1.8} aria-hidden="true" /> {executionBusy ? 'CÓPIA EM ANDAMENTO' : executionResult?.status === 'completed' ? 'CÓPIA CONCLUÍDA' : 'EXECUÇÃO CONTROLADA'}</div>
            </div>

            {planError && <div className="alert alert-error"><span><AlertTriangle size={14} strokeWidth={1.9} aria-hidden="true" /></span><div><strong>Plano não aprovado</strong><p>{planError}</p></div><button onClick={() => setPlanError('')} aria-label="Fechar aviso"><X size={14} strokeWidth={1.9} aria-hidden="true" /></button></div>}
            {planNotice && !planError && <div className="alert alert-info"><span><Info size={14} strokeWidth={1.9} aria-hidden="true" /></span><p>{planNotice}</p><button onClick={() => setPlanNotice('')} aria-label="Fechar aviso"><X size={14} strokeWidth={1.9} aria-hidden="true" /></button></div>}

            {!result ? (
              <div className="empty-panel plan-empty"><div className="panel-symbol"><ClipboardList size={23} strokeWidth={1.7} aria-hidden="true" /></div><h3>Faça uma análise primeiro</h3><p>O plano precisa de uma prévia atual. Volte ao início, selecione a origem e analise a biblioteca.</p><button className="button button-primary" onClick={() => setActiveNav('Início')}>Ir para análise</button></div>
            ) : !organizationPlan ? (
              <div className="empty-panel plan-empty"><div className="panel-symbol"><ClipboardList size={23} strokeWidth={1.7} aria-hidden="true" /></div><h3>Nenhum plano foi gerado</h3><p>Usaremos a prévia atual, incluindo a associação do AniList e as correções salvas, para preparar a lista de operações proposta.</p><button className="button button-primary" onClick={() => void generateOrganizationPlan()} disabled={planBusy || executionBusy}>{planBusy ? 'Gerando plano…' : 'Gerar plano de organização'}</button></div>
            ) : (
              <>
                {!planPreviewIsCurrent && <div className="plan-banner plan-banner-danger"><strong>Plano desatualizado</strong><span>A prévia atual mudou depois que este plano foi criado. Gere um plano novo antes de validar ou aprovar.</span><button className="button button-secondary" onClick={() => void generateOrganizationPlan()} disabled={planBusy || executionBusy}>Gerar novo plano</button></div>}
                {organizationPlan.analysisOutdated && <div className="plan-banner plan-banner-danger"><strong>A origem mudou antes da geração</strong><span>Alguns arquivos não correspondem à análise usada. Reanalise a biblioteca e gere outro plano.</span><button className="button button-secondary" onClick={() => { setActiveNav('Prévia'); setNotice('Reanalise a biblioteca para atualizar a lista de vídeos e legendas.') }}>Ir para prévia</button></div>}

                <div className="plan-summary-grid">
                  <div className="plan-stat plan-stat-ready"><span>Prontos</span><strong>{organizationPlan.summary.ready}</strong><small>Podem compor o plano</small></div>
                  <div className="plan-stat plan-stat-review"><span>Revisão</span><strong>{organizationPlan.summary.review}</strong><small>Precisam de decisão</small></div>
                  <div className="plan-stat plan-stat-conflict"><span>Conflitos</span><strong>{organizationPlan.summary.conflict}</strong><small>Destinos ocupados ou duplicados</small></div>
                  <div className="plan-stat plan-stat-pending"><span>Pendentes</span><strong>{organizationPlan.summary.pending}</strong><small>Reanálise necessária</small></div>
                </div>
                {organizationPlan.destinationLibrarySummary && organizationPlan.destinationLibrarySummary.total > 0 && (
                  <div className="plan-banner">
                    <strong>Biblioteca existente indexada</strong>
                    <span>{organizationPlan.destinationLibrarySummary.videos} vídeo(s) · {organizationPlan.destinationLibrarySummary.subtitles} legenda(s) no destino. {organizationPlan.destinationLibrarySummary.duplicateEpisodeIdentities > 0 ? `${organizationPlan.destinationLibrarySummary.duplicateEpisodeIdentities} identidade(s) de episódio duplicadas já existem e exigem revisão.` : 'O plano verifica colisões de caminho e identidade antes de aprovar.'}</span>
                  </div>
                )}

                <section className="plan-toolbar-card">
                  <div className="plan-toolbar-info">
                    <div><span>ORIGEM</span><code>{organizationPlan.sourcePath}</code></div>
                    <div><span>DESTINO PROPOSTO</span><code>{organizationPlan.destinationPath}</code></div>
                    <div><span>ANIME / ANILIST</span><code>{organizationPlan.seriesName}{organizationPlan.aniListId ? ` · AniList #${organizationPlan.aniListId}` : ' · sem associação confirmada'}</code></div>
                    <div><span>PLANO</span><code>{organizationPlan.id} · {new Date(organizationPlan.generatedAt).toLocaleString()}</code></div>
                  </div>
                  <div className="plan-actions">
                    <button className="button button-secondary" onClick={() => void generateOrganizationPlan()} disabled={planBusy || executionBusy}>{planBusy ? 'Gerando…' : <><RefreshCw size={14} aria-hidden="true" /> Regenerar</>}</button>
                    <button className="button button-secondary" onClick={() => void revalidateOrganizationPlan()} disabled={planBusy || executionBusy || !planPreviewIsCurrent}>{planBusy ? 'Verificando…' : 'Revalidar plano'}</button>
                    <button className="button button-primary" onClick={() => void approveOrganizationPlan()} disabled={!canApproveCurrentPlan || planBusy || executionBusy} title={planBlockers.join(' ')}>{organizationPlan.approvedAt && planPreviewIsCurrent ? 'Plano aprovado' : 'Aprovar plano'}</button>
                    {executionBusy
                      ? historyActionRunId
                        ? <button className="button button-danger" onClick={() => void window.kageShelf.cancelOrganizationExecution(historyActionRunId)}>Cancelar retomada</button>
                        : <button className="button button-danger" onClick={() => void cancelApprovedOrganizationPlan()}>Cancelar cópia</button>
                      : organizationPlan.approvedAt && organizationPlan.validation?.fresh && planPreviewIsCurrent && !executionResult && !planBusy
                        ? <button className="button button-primary" onClick={() => void executeApprovedOrganizationPlan()}>Executar cópia verificada</button>
                        : null}
                  </div>
                </section>

                {organizationPlan.validation && (
                  <div className={`plan-validation ${organizationPlan.validation.fresh && planPreviewIsCurrent ? 'plan-validation-good' : 'plan-validation-bad'}`}>
                    <div><strong>{organizationPlan.validation.fresh ? 'O sistema de arquivos não mudou desde a geração' : 'O plano precisa ser regenerado'}</strong><span>Última verificação: {new Date(organizationPlan.validation.checkedAt).toLocaleString()}</span></div>
                    {organizationPlan.validation.issues.length > 0 && <ul>{organizationPlan.validation.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
                  </div>
                )}
                {organizationPlan.approvedAt && planPreviewIsCurrent && organizationPlan.validation?.fresh && <div className="plan-banner plan-banner-success"><strong>Plano aprovado em {new Date(organizationPlan.approvedAt).toLocaleString()}</strong><span>O plano foi aprovado e pode ser executado após nova confirmação. A origem sempre será preservada.</span></div>}
                {!organizationPlan.validation && <div className="plan-banner"><strong>Validação pendente</strong><span>Gere o plano e depois revalide-o para comparar os arquivos atuais com o snapshot da geração.</span></div>}

                {executionError && <div className="alert alert-error"><span><AlertTriangle size={14} strokeWidth={1.9} aria-hidden="true" /></span><div><strong>Execução / reversão</strong><p>{executionError}</p></div><button onClick={() => setExecutionError('')} aria-label="Fechar aviso"><X size={14} strokeWidth={1.9} aria-hidden="true" /></button></div>}
                {(executionBusy || executionResult) && <section className="plan-validation plan-validation-good execution-card">
                  <div><strong>{executionBusy ? 'Cópia em andamento' : executionResult?.status === 'completed' ? 'Cópia concluída e verificada' : executionResult?.status === 'cancelled' ? 'Cópia cancelada' : executionResult?.status === 'rolled-back' ? 'Execução revertida' : executionResult?.status === 'partially-rolled-back' ? 'Reversão parcial — arquivos preservados' : 'Execução encerrada com atenção'}</strong><span>{executionProgress?.message ?? 'Registro da execução disponível.'}</span></div>
                  {executionProgress && <><div className="execution-progress-track"><span style={{ width: `${executionProgress.totalBytes > 0 ? Math.min(100, (executionProgress.bytesCopied / executionProgress.totalBytes) * 100) : 0}%` }} /></div><small>{executionProgress.completedFiles}/{executionProgress.totalFiles} arquivo(s) · {formatBytes(executionProgress.bytesCopied)} / {formatBytes(executionProgress.totalBytes)}{executionProgress.currentFile ? ` · ${executionProgress.currentFile}` : ''}</small></>}
                  {executionResult && <><p>{executionResult.copiedFiles} arquivo(s) copiados · {formatBytes(executionResult.copiedBytes)} · execução {executionResult.runId.slice(0, 8)}</p>{executionResult.rollbackAvailable && <button className="button button-secondary" onClick={() => void rollbackLastExecution()} disabled={rollbackBusy}>{rollbackBusy ? 'Revertendo…' : 'Reverter esta execução'}</button>}</>}
                  {rollbackResult && <small>Reversão: {rollbackResult.removedFiles} removido(s), {rollbackResult.skippedFiles} preservado(s).</small>}
                </section>}
                {organizationPlan.warnings.length > 0 && <section className="warnings-card"><div className="warnings-heading"><span><AlertTriangle size={14} strokeWidth={1.9} aria-hidden="true" /></span><div><h3>Observações do plano</h3><p>Esses itens impedem ou limitam uma aprovação completa.</p></div></div><ul>{organizationPlan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></section>}

                <section className="plan-table-card">
                  <div className="card-heading table-heading">
                    <div><h2>Operações propostas</h2><p>{organizationPlan.summary.total} item(ns) · {formatBytes(organizationPlan.summary.totalBytes)} no total · confirme e execute apenas após validar o plano</p></div>
                    <div className="table-tools"><select aria-label="Filtrar itens do plano" value={planFilter} onChange={(event) => setPlanFilter(event.target.value as 'all' | PlanItemStatus)}><option value="all">Todos os status</option><option value="ready">Prontos</option><option value="review">Revisão</option><option value="conflict">Conflitos</option><option value="pending">Pendentes</option></select></div>
                  </div>
                  <div className="table-scroll plan-table-scroll">
                    <table className="plan-table">
                      <thead><tr><th>Tipo</th><th>Arquivo de origem</th><th>Destino relativo</th><th>Tamanho</th><th>Status / motivo</th></tr></thead>
                      <tbody>
                        {visiblePlanItems.map((item) => (
                          <tr key={item.id}>
                            <td><span className={`plan-kind ${item.kind}`}>{item.kind === 'video' ? 'Vídeo' : 'Legenda'}</span></td>
                            <td><div className="file-name"><span className="file-type">{item.kind === 'video' ? <FileVideo size={14} strokeWidth={1.8} aria-hidden="true" /> : <FileText size={14} strokeWidth={1.8} aria-hidden="true" />}</span><div><strong>{item.originalName}</strong><small>{item.sourceRelativePath}</small></div></div></td>
                            <td>{item.destinationRelativePath ? <code className="plan-destination">{item.destinationRelativePath}</code> : <span className="muted">Sem destino — requer revisão</span>}</td>
                            <td>{formatBytes(item.sizeBytes)}</td>
                            <td><div className="plan-item-status"><span className={`plan-status plan-status-${item.status}`}>{item.status === 'ready' ? 'Pronto' : item.status === 'review' ? 'Revisão' : item.status === 'conflict' ? 'Conflito' : 'Pendente'}</span><small>{item.reason}</small></div></td>
                          </tr>
                        ))}
                        {visiblePlanItems.length === 0 && <tr><td colSpan={5} className="plan-no-rows">Não há itens para o filtro selecionado.</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </section>
                <div className="plan-footnote"><Info size={15} strokeWidth={1.8} aria-hidden="true" /><p>Uma aprovação apenas marca este plano como conferido. A execução copia apenas os itens aprovados, valida o SHA-256 e mantém a origem intacta. É possível reverter arquivos que ainda correspondam ao registro.</p></div>
                {planBlockers.length > 0 && <section className="plan-blockers"><h3>O que impede a aprovação</h3><ul>{planBlockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></section>}
              </>
            )}
            <footer className="bottom-bar"><div className="bottom-hint"><span className="hint-dot" /> <span>A origem não será modificada; a cópia exige aprovação e confirmação.</span></div><div className="bottom-actions"><button className="button button-secondary" onClick={() => setActiveNav('Prévia')} disabled={!result}>Voltar à prévia</button><button className="button button-primary" onClick={() => void generateOrganizationPlan()} disabled={!result || planBusy}>{planBusy ? 'Gerando…' : organizationPlan ? 'Regenerar plano' : 'Gerar plano'}</button></div></footer>
          </section>
        ) : (
          <section className="page-content">
            <div className="page-heading">
              <div>
                <div className="eyebrow">ORGANIZAÇÃO INTELIGENTE DE ANIMES</div>
                <h1>{activeNav === 'Prévia' ? 'Prévia da biblioteca' : 'Sua biblioteca, sob controle.'}</h1>
                <p>{activeNav === 'Prévia' ? 'Revise a identificação e os nomes propostos antes de qualquer operação.' : 'Analise os arquivos e prepare uma estrutura organizada para o Jellyfin.'}</p>
              </div>
              <div className="read-only-tag"><CircleDot size={14} strokeWidth={1.8} aria-hidden="true" /> PRÉVIA SOMENTE LEITURA</div>
            </div>

            <section className="paths-card">
              <div className="path-field">
                <label htmlFor="sourcePath"><span className="field-icon"><FolderOpen size={14} strokeWidth={1.8} aria-hidden="true" /></span> Pasta de origem <em>não será alterada</em></label>
                <div className="path-control">
                  <input id="sourcePath" value={sourcePath} disabled={executionBusy} onChange={(event) => { invalidateAnalysisRequest(); setSourcePath(event.target.value); setDestinationPath(''); setDestinationIsAutomatic(true); setResult(null); setBaseResult(null); setSelectedAnime(null); setEpisodeCorrections([]); setCorrectionError(''); setSelectedRow(null); setAniListResults([]); setAniListNotice(''); setAniListError('') }} placeholder="Selecione a pasta que contém os episódios…" spellCheck={false} />
                  <button className="button button-secondary browse-button" onClick={() => void pickSource()} disabled={executionBusy}>Explorar</button>
                </div>
              </div>
              <div className="path-divider"><ArrowRight size={17} strokeWidth={1.7} aria-hidden="true" /></div>
              <div className="path-field">
                <label htmlFor="destinationPath"><span className="field-icon output-icon"><Folder size={14} strokeWidth={1.8} aria-hidden="true" /></span> Destino sugerido <em>será criado no futuro</em></label>
                <div className="path-control">
                  <input id="destinationPath" value={destinationPath} disabled={executionBusy} onChange={(event) => { invalidateAnalysisRequest(); setDestinationPath(event.target.value); setDestinationIsAutomatic(false); setResult(null); setBaseResult(null) }} placeholder="A pasta de saída será sugerida aqui…" spellCheck={false} />
                  <button className="button button-secondary browse-button" onClick={() => void pickDestination()} disabled={executionBusy}>Explorar</button>
                </div>
              </div>
              <button className="button button-primary analyze-button" onClick={() => void analyze()} disabled={busy || executionBusy || !sourcePath.trim()}>
                <span className="button-icon">{busy ? <RefreshCw size={16} className="spin-icon" aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}</span>{busy ? 'Analisando…' : 'Analisar arquivos'}
              </button>
            </section>

            {error && <div className="alert alert-error"><span><AlertTriangle size={14} strokeWidth={1.9} aria-hidden="true" /></span><div><strong>Não foi possível analisar</strong><p>{error}</p></div><button onClick={() => setError('')} aria-label="Fechar aviso"><X size={14} strokeWidth={1.9} aria-hidden="true" /></button></div>}
            {notice && !error && <div className="alert alert-info"><span><Info size={14} strokeWidth={1.9} aria-hidden="true" /></span><p>{notice}</p><button onClick={() => setNotice('')} aria-label="Fechar aviso"><X size={14} strokeWidth={1.9} aria-hidden="true" /></button></div>}

            {result ? (
              <>
                <div className="stats-grid">
                  <div className="stat-card"><div className="stat-icon icon-purple"><FolderOpen size={21} strokeWidth={1.8} aria-hidden="true" /></div><div className="stat-body"><strong>{result.videoCount}</strong><span>Vídeos encontrados</span></div><div className="stat-foot">Arquivos de vídeo</div></div>
                  <div className="stat-card"><div className="stat-icon icon-green"><FileText size={21} strokeWidth={1.8} aria-hidden="true" /></div><div className="stat-body"><strong>{result.subtitleCount}</strong><span>Legendas encontradas</span></div><div className="stat-foot">Incluídas no plano quando pareadas</div></div>
                  <div className="stat-card"><div className="stat-icon icon-blue"><HardDrive size={21} strokeWidth={1.8} aria-hidden="true" /></div><div className="stat-body"><strong>{formatBytes(result.totalVideoBytes)}</strong><span>Tamanho total dos vídeos</span></div><div className="stat-foot">Leitura concluída</div></div>
                  <div className="stat-card"><div className="stat-icon icon-amber"><CheckCircle2 size={21} strokeWidth={1.8} aria-hidden="true" /></div><div className="stat-body"><strong>{identifiedCount}<small> / {result.videoCount}</small></strong><span>Identificados pela prévia</span></div><div className="stat-foot">{reviewCount ? `${reviewCount} exigem revisão` : 'Nenhuma revisão sinalizada'}</div></div>
                </div>

                <div className="work-grid">
                  <section className="table-card">
                    <div className="card-heading table-heading">
                      <div><h2>Arquivos detectados</h2><p>Esta tabela mostra uma proposta, não executa alterações.</p></div>
                      <div className="table-tools">
                        <div className="search-box"><Search size={15} strokeWidth={1.8} aria-hidden="true" /><input aria-label="Buscar arquivos" placeholder="Buscar arquivos…" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
                        <select aria-label="Filtrar arquivos" value={filter} onChange={(event) => setFilter(event.target.value as FilterKey)}><option value="all">Todos</option><option value="identified">Identificados</option><option value="review">Revisar</option></select>
                      </div>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead><tr><th>Arquivo original</th><th>Episódio</th><th>Confiança</th><th>Nome proposto</th><th>Status</th></tr></thead>
                        <tbody>
                          {visibleRows.map((row) => (
                            <tr key={row.id} className={selectedRow?.id === row.id ? 'selected-row' : ''} onClick={() => selectPreviewRow(row)} title={row.note}>
                              <td><div className="file-name"><span className="file-type"><FileText size={13} strokeWidth={1.8} aria-hidden="true" /></span><div><strong>{row.originalName}</strong><small>{row.relativePath === row.originalName ? 'Pasta raiz' : row.relativePath}</small></div></div></td>
                              <td>{row.contentKind === 'movie' ? <span className="episode-number">Filme</span> : row.episode !== null ? <span className="episode-number">{`S${String(row.contentKind === 'special' ? 0 : row.season ?? 1).padStart(2, '0')}E${String(row.episode).padStart(2, '0')}`}</span> : <span className="muted">—</span>}</td>
                              <td>{row.manuallyCorrected ? <span className="confidence confidence-high">Manual</span> : <Confidence value={row.confidence} />}</td>
                              <td><span className="proposed-name" title={row.outputRelativePath ?? row.note}>{row.outputRelativePath ?? 'Precisa de revisão'}</span></td>
                              <td><span className={statusClass(row)}><span className="status-dot" />{row.statusLabel}</span></td>
                            </tr>
                          ))}
                          {visibleRows.length === 0 && <tr><td colSpan={5} className="no-results">Nenhum arquivo corresponde ao filtro.</td></tr>}
                        </tbody>
                      </table>
                    </div>
                    <div className="table-footer"><span>Exibindo <strong>{visibleRows.length}</strong> de <strong>{result.rows.length}</strong> vídeos</span><span>Varredura em {result.scanDurationMs} ms</span></div>
                  </section>

                  <aside className="right-column">
                    <section className="side-card series-card">
                      <div className="series-cover">
                        {selectedAnime?.coverImage.extraLarge || selectedAnime?.coverImage.large ? (
                          <img src={selectedAnime.coverImage.extraLarge ?? selectedAnime.coverImage.large ?? ''} alt={`Capa de ${selectedAnime.title.romaji ?? selectedAnime.title.english ?? result.seriesName}`} onError={(event) => { event.currentTarget.style.display = 'none' }} />
                        ) : <><span>JAS</span><small>ANIME LIBRARY</small></>}
                      </div>
                      <div className="series-info">
                        <div className="eyebrow">{selectedAnime ? 'ANILIST ASSOCIADO' : 'SÉRIE ANALISADA'}</div>
                        <h3>{selectedAnime?.title.romaji ?? selectedAnime?.title.english ?? result.seriesName}</h3>
                        {selectedAnime ? (
                          <>
                            <p>{selectedAnime.startDate?.year ?? selectedAnime.seasonYear ?? 'Ano desconhecido'} · {selectedAnime.episodes == null ? 'Episódios não informados' : `${selectedAnime.episodes} episódios`}</p>
                            <div className="series-chip">{formatAniListValue(selectedAnime.format)} · AniList #{selectedAnime.id}</div>
                          </>
                        ) : <><p>{result.videoCount} vídeos · {result.subtitleCount} legendas</p><div className="series-chip">Análise local · metadados não associados</div></>}
                      </div>
                    </section>

                    <section className="side-card anilist-card">
                      <div className="side-card-title"><h3>Metadados do AniList</h3><span>CONSULTA MANUAL</span></div>
                      <p className="anilist-intro">Pesquise a série e escolha o registro correto. Não há associação automática por nome.</p>
                      <form className="anilist-search" onSubmit={(event) => { event.preventDefault(); void searchAniList() }}>
                        <input aria-label="Pesquisar anime no AniList" value={aniListQuery} disabled={aniListBusy || executionBusy} onChange={(event) => { setAniListQuery(event.target.value); setAniListError(''); setAniListNotice(''); setAniListResults([]) }} maxLength={120} placeholder="Nome romanizado do anime…" />
                        <button className="button button-primary" type="submit" disabled={aniListBusy || executionBusy || !aniListQuery.trim()}>{aniListBusy ? 'Buscando…' : 'Buscar'}</button>
                      </form>
                      {aniListError && <div className="anilist-message anilist-error" role="alert">{aniListError}</div>}
                      {aniListNotice && !aniListError && <div className="anilist-message" role="status">{aniListNotice}</div>}
                      {selectedAnime && (
                        <div className="anilist-selected">
                          <div><strong>Registro selecionado</strong><span>Associação salva localmente para esta pasta. Os nomes propostos usam o título escolhido; isso não valida cada episódio.</span></div>
                          <button className="button button-secondary" type="button" disabled={aniListBusy || executionBusy} onClick={() => void clearAniListAnime()}>Remover</button>
                        </div>
                      )}
                      {aniListResults.length > 0 && (
                        <div className="anilist-results" aria-label="Resultados do AniList">
                          {aniListResults.map((anime) => {
                            const title = anime.title.romaji ?? anime.title.english ?? anime.title.userPreferred ?? `AniList #${anime.id}`
                            const year = anime.startDate?.year ?? anime.seasonYear
                            return (
                              <article className="anilist-result" key={anime.id}>
                                {anime.coverImage.large || anime.coverImage.extraLarge ? <img src={anime.coverImage.large ?? anime.coverImage.extraLarge ?? ''} alt="" onError={(event) => { event.currentTarget.style.display = 'none' }} /> : <div className="anilist-no-cover">JAS</div>}
                                <div className="anilist-result-content">
                                  <strong>{title}</strong>
                                  {anime.title.english && anime.title.english !== title && <span className="anilist-alt-title">{anime.title.english}</span>}
                                  <span className="anilist-meta">{year ?? 'Ano ?'} · {anime.episodes == null ? 'Episódios ?' : `${anime.episodes} ep.`} · {formatAniListValue(anime.format)}</span>
                                  {anime.title.native && <span className="anilist-native">{anime.title.native}</span>}
                                  <div className="anilist-result-actions"><a href={anime.siteUrl ?? `https://anilist.co/anime/${anime.id}`} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void window.kageShelf.openAniListPage(anime.id) }}>Ver no AniList <ExternalLink size={12} aria-hidden="true" /></a><button className="button button-secondary" type="button" disabled={aniListBusy || executionBusy || !baseResult} onClick={() => void chooseAniListAnime(anime)}>{aniListBusy ? 'Salvando…' : 'Associar'}</button></div>
                                </div>
                              </article>
                            )
                          })}
                        </div>
                      )}
                      <p className="anilist-footnote">Os dados são públicos e consultados sob demanda. A associação altera apenas a prévia e é salva localmente. Ela não confirma, por si só, a identificação dos episódios.</p>
                    </section>

                    <section className="side-card tree-card">
                      <div className="side-card-title"><h3>Estrutura de destino</h3><span>PRÉVIA</span></div>
                      <div className="tree-root"><ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" /><span className="tree-folder"><Folder size={14} strokeWidth={1.8} aria-hidden="true" /></span><strong>{result.destinationFolderName}</strong></div>
                      {treeRows.length > 0 ? (
                        <div className="tree-children">
                          {treeGroupsVisible.map((group) => (
                            <div className="tree-group" key={group.seasonFolder}>
                              <div className="tree-season"><Folder size={13} strokeWidth={1.8} aria-hidden="true" />{group.seasonFolder}</div>
                              {group.items.map((item) => <div className="tree-file" key={`${group.seasonFolder}/${item}`}><FileText size={11} strokeWidth={1.8} aria-hidden="true" /><span>{item}</span></div>)}
                            </div>
                          ))}
                          {treeDisplayedCount > treeRows.length && <div className="tree-more">+ mais arquivos</div>}
                        </div>
                      ) : <div className="tree-empty">Ainda não há nomes prontos para mostrar.</div>}
                    </section>

                    <section className="side-card detail-card correction-card">
                      <div className="side-card-title"><h3>{selectedRow ? 'Revisão do episódio' : 'Regras de segurança'}</h3><span>{selectedRow ? 'EDIÇÃO LOCAL' : 'SOMENTE LEITURA'}</span></div>
                      {selectedRow ? (
                        <>
                          <div className="detail-content">
                            <strong>{selectedRow.originalName}</strong>
                            <p>{selectedRow.note}</p>
                            <div className="detail-line"><span>Tamanho</span><b>{formatBytes(selectedRow.sizeBytes)}</b></div>
                            <div className="detail-line"><span>Método original</span><b>{selectedRow.method}</b></div>
                            <div className="detail-line"><span>Estado da identificação</span><b>{selectedRow.manuallyCorrected ? 'Correção manual' : selectedRow.statusLabel}</b></div>
                          </div>
                          <form className="correction-form" onSubmit={(event) => void saveManualCorrection(event)}>
                            <label htmlFor="contentKind">Tipo de conteúdo</label>
                            <select id="contentKind" value={draftKind} disabled={executionBusy} onChange={(event) => {
                              const nextKind = event.target.value as ContentKind
                              setDraftKind(nextKind)
                              if (nextKind === 'special') setDraftSeason('0')
                              else if (nextKind === 'episode') setDraftSeason(selectedRow.season && selectedRow.season > 0 ? String(selectedRow.season) : '1')
                            }}>
                              <option value="episode">Episódio de temporada</option>
                              <option value="special">Especial (Season 00)</option>
                              <option value="movie">Filme</option>
                            </select>
                            {draftKind === 'episode' && (
                              <div className="correction-input-grid">
                                <div><label htmlFor="episodeSeason">Temporada</label><input id="episodeSeason" type="number" disabled={executionBusy} min="1" max="99" step="1" value={draftSeason} onChange={(event) => setDraftSeason(event.target.value)} required /></div>
                                <div><label htmlFor="episodeNumber">Episódio</label><input id="episodeNumber" type="number" disabled={executionBusy} min="1" max="999" step="1" value={draftEpisode} onChange={(event) => setDraftEpisode(event.target.value)} required /></div>
                              </div>
                            )}
                            {draftKind === 'special' && (
                              <div className="correction-input-grid">
                                <div><label>Temporada</label><div className="fixed-season">Season 00</div></div>
                                <div><label htmlFor="specialNumber">Número do especial</label><input id="specialNumber" type="number" disabled={executionBusy} min="1" max="999" step="1" value={draftEpisode} onChange={(event) => setDraftEpisode(event.target.value)} required /></div>
                              </div>
                            )}
                            {draftKind === 'movie' && <p className="correction-help">O filme será proposto na raiz da biblioteca, sem pasta Season.</p>}
                            {correctionError && <div className="anilist-message anilist-error" role="alert">{correctionError}</div>}
                            <button className="button button-primary correction-save" type="submit" disabled={correctionBusy || executionBusy}>{correctionBusy ? 'Salvando…' : 'Salvar correção'}</button>
                            {selectedRow.manuallyCorrected && <button className="button button-secondary correction-reset" type="button" disabled={correctionBusy || executionBusy} onClick={() => void removeManualCorrection()}>Restaurar identificação automática</button>}
                          </form>
                          {selectedRow.outputRelativePath && <div className="detail-proposed"><small>CAMINHO PROPOSTO</small><code>{selectedRow.outputRelativePath}</code></div>}
                        </>
                      ) : (
                        <div className="rules-list"><div><span className="rule-check"><Check size={11} strokeWidth={2} aria-hidden="true" /></span><span>Origem nunca é alterada</span></div><div><span className="rule-check"><Check size={11} strokeWidth={2} aria-hidden="true" /></span><span>Correções salvas por pasta</span></div><div><span className="rule-check"><Check size={11} strokeWidth={2} aria-hidden="true" /></span><span>Duplicados bloqueiam a prévia</span></div><div><span className="rule-check"><Check size={11} strokeWidth={2} aria-hidden="true" /></span><span>Confiança automática não é alterada</span></div><div><span className="rule-check"><Check size={11} strokeWidth={2} aria-hidden="true" /></span><span>Cópia verificada; origem preservada</span></div></div>
                      )}
                    </section>
                  </aside>
                </div>

                {result.warnings.length > 0 && <section className="warnings-card"><div className="warnings-heading"><span><AlertTriangle size={14} strokeWidth={1.9} aria-hidden="true" /></span><div><h3>Observações da análise</h3><p>Leia estes pontos antes de confiar na prévia.</p></div></div><ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></section>}
              </>
            ) : (
              <div className="welcome-grid">
                <div className="welcome-main"><EmptyState onPick={() => void pickSource()} /></div>
                <aside className="welcome-side">
                  <div className="side-card release-card"><div className="release-symbol"><ShieldCheck size={17} strokeWidth={1.8} aria-hidden="true" /></div><div className="eyebrow">KAGESHELF · VERSÃO ESTÁVEL 1.0.0</div><h3>Cópia verificada, origem preservada.</h3><p>Versão estável. Revise e aprove cada plano; conflitos são bloqueados e a origem permanece intacta.</p><div className="release-progress"><div><span>Interface</span><b>Refinada</b></div><div className="progress-track"><span style={{ width: '100%' }} /></div><div><span>Lançamento</span><b>Estável</b></div><div className="progress-track"><span style={{ width: '100%' }} /></div></div></div>
                  <div className="side-card quick-card"><h3>O que funciona agora</h3><div className="quick-list"><div><span className="quick-icon">01</span><span>Selecionar pastas locais</span></div><div><span className="quick-icon">02</span><span>Encontrar vídeos e legendas</span></div><div><span className="quick-icon">03</span><span>Gerar prévia de episódios</span></div><div><span className="quick-icon">04</span><span>Cópia verificada com SHA-256</span></div></div></div>
                </aside>
              </div>
            )}

            <footer className="bottom-bar">
              <div className="bottom-hint"><span className="hint-dot" /> <span>Seus arquivos permanecem no computador.</span></div>
              <div className="bottom-actions">
                {result && <button className="button button-secondary" onClick={() => void analyze()} disabled={busy || executionBusy}>{busy ? <><RefreshCw size={14} className="spin-icon" aria-hidden="true" /> Analisando…</> : <><RefreshCw size={14} aria-hidden="true" /> Reanalisar</>}</button>}
                <button className="button button-secondary" onClick={() => setActiveNav('Plano')} disabled={!result}>Ver plano</button>
                <button className="button button-primary" onClick={() => void generateOrganizationPlan()} disabled={!result || planBusy || executionBusy}><ClipboardList size={15} aria-hidden="true" /> {planBusy ? 'Gerando plano…' : 'Gerar plano'} <span className="button-next"><ArrowRight size={15} strokeWidth={1.8} aria-hidden="true" /></span></button>
              </div>
            </footer>
          </section>
        )}
      </main>
    </div>
  )
}
