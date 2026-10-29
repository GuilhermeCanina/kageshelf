import type { OrganizationPlan, OrganizationPlanSummary, ScanResult } from './types'

/**
 * Stable, non-cryptographic signature used only to notice when the current UI
 * preview differs from the preview used to build a plan. Disk freshness is
 * checked separately in the main process against file metadata snapshots.
 */
export function previewSignature(result: ScanResult): string {
  const payload = {
    sourcePath: result.sourcePath,
    destinationPath: result.destinationPath,
    seriesName: result.seriesName,
    videoCount: result.videoCount,
    subtitleCount: result.subtitleCount,
    subtitleFiles: (result.subtitleFiles ?? []).map((file) => [file.relativePath, file.sizeBytes, file.modifiedAtMs]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    rows: [...result.rows]
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      .map((row) => [
        row.relativePath,
        row.sizeBytes,
        row.modifiedAtMs,
        row.status,
        row.contentKind,
        row.specialLabel ?? null,
        row.season,
        row.episode,
        row.manuallyCorrected,
        row.outputRelativePath
      ])
  }
  const text = JSON.stringify(payload)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `preview-v1-${(hash >>> 0).toString(16).padStart(8, '0')}-${text.length}`
}

export function summarizePlan(items: OrganizationPlan['items']): OrganizationPlanSummary {
  const summary: OrganizationPlanSummary = {
    ready: 0,
    review: 0,
    conflict: 0,
    pending: 0,
    total: items.length,
    totalBytes: items.reduce((total, item) => total + item.sizeBytes, 0)
  }
  for (const item of items) summary[item.status] += 1
  return summary
}

export function planCanBeApproved(plan: OrganizationPlan, currentPreviewSignature: string | null): boolean {
  return currentPreviewSignature !== null
    && currentPreviewSignature === plan.previewSignature
    && !plan.analysisOutdated
    && plan.validation?.fresh === true
    && plan.summary.ready > 0
    && plan.summary.review === 0
    && plan.summary.conflict === 0
    && plan.summary.pending === 0
}

export function planBlockerMessages(plan: OrganizationPlan, currentPreviewSignature: string | null): string[] {
  const blockers: string[] = []
  if (currentPreviewSignature !== plan.previewSignature) blockers.push('A prévia mudou depois da geração do plano. Gere um novo plano.')
  if (plan.analysisOutdated) blockers.push('A análise já estava desatualizada quando o plano foi gerado. Reanalise a origem.')
  if (!plan.validation?.fresh) blockers.push('Revalide o plano no sistema de arquivos antes de aprová-lo.')
  if (plan.summary.ready === 0) blockers.push('O plano não contém arquivos prontos para organização.')
  if (plan.summary.review > 0) blockers.push(`${plan.summary.review} item(ns) precisam de revisão.`)
  if (plan.summary.conflict > 0) blockers.push(`${plan.summary.conflict} conflito(s) precisam ser resolvidos.`)
  if (plan.summary.pending > 0) blockers.push(`${plan.summary.pending} item(ns) estão pendentes; reanalise a biblioteca.`)
  return blockers
}
