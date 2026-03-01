import {
  ICopilotService,
  DiffChunk,
  ChangedFile,
  ReviewMode,
  InDepthAnalysis,
  AnalysisCategory,
  Recommendation,
  PRMetrics,
} from '../types';
import { CopilotService } from '../integrations/copilot';

const ANALYSIS_CATEGORIES = [
  'Code Quality',
  'Security',
  'Performance',
  'Error Handling',
  'Testing',
  'Documentation',
  'Architecture',
  'Dependencies',
] as const;

export class DeepAnalysisEngine {
  constructor(private readonly copilot: ICopilotService) {}

  async analyze(
    prNumber: number,
    chunks: DiffChunk[],
    changedFiles: ChangedFile[],
    mode: ReviewMode
  ): Promise<InDepthAnalysis> {
    const metrics = this.computeMetrics(chunks, changedFiles);
    const allContent = this.buildDiffSummary(chunks, 4000);

    const prompt = this.buildDeepAnalysisPrompt(allContent, metrics, mode);

    let rawResponse: string;
    try {
      rawResponse = await this.copilot.ask(prompt);
    } catch (err) {
      return this.fallbackAnalysis(prNumber, metrics, (err as Error).message);
    }

    const modelName = (this.copilot as CopilotService).getLastUsedModelName?.() ?? 'unknown';

    try {
      const jsonStr = rawResponse.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
      const parsed = JSON.parse(jsonStr) as {
        overallSummary: string;
        complexityScore: number;
        qualityGrade: string;
        categories: AnalysisCategory[];
        recommendations: Recommendation[];
      };

      return {
        prNumber,
        overallSummary: parsed.overallSummary ?? 'Analysis completed.',
        complexityScore: Math.min(100, Math.max(0, parsed.complexityScore ?? 50)),
        qualityGrade: this.validateGrade(parsed.qualityGrade),
        categories: (parsed.categories ?? []).map((c) => ({
          name: c.name,
          score: Math.min(100, Math.max(0, c.score ?? 50)),
          findings: c.findings ?? [],
          severity: c.severity ?? 'acceptable',
        })),
        recommendations: (parsed.recommendations ?? []).map((r) => ({
          priority: r.priority ?? 'medium',
          title: r.title ?? 'Recommendation',
          description: r.description ?? '',
          filePath: r.filePath,
          lineRange: r.lineRange,
        })),
        metrics,
        modelUsed: modelName,
      };
    } catch {
      return {
        prNumber,
        overallSummary: rawResponse.slice(0, 500),
        complexityScore: 50,
        qualityGrade: 'C',
        categories: [],
        recommendations: [],
        metrics,
        modelUsed: modelName,
      };
    }
  }

  async compareWithModels(
    prNumber: number,
    chunks: DiffChunk[],
    changedFiles: ChangedFile[],
    mode: ReviewMode,
    modelIds: string[]
  ): Promise<InDepthAnalysis[]> {
    const results: InDepthAnalysis[] = [];
    const metrics = this.computeMetrics(chunks, changedFiles);
    // Use a smaller budget for multi-model to save credits (prompt shared across models)
    const allContent = this.buildDiffSummary(chunks, 2500);
    const prompt = this.buildDeepAnalysisPrompt(allContent, metrics, mode);

    for (const modelId of modelIds) {
      try {
        const rawResponse = await this.copilot.ask(prompt, modelId);
        const jsonStr = rawResponse.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
        const parsed = JSON.parse(jsonStr);
        results.push({
          prNumber,
          overallSummary: parsed.overallSummary ?? 'Analysis completed.',
          complexityScore: Math.min(100, Math.max(0, parsed.complexityScore ?? 50)),
          qualityGrade: this.validateGrade(parsed.qualityGrade),
          categories: parsed.categories ?? [],
          recommendations: parsed.recommendations ?? [],
          metrics,
          modelUsed: modelId,
        });
      } catch {
        results.push(this.fallbackAnalysis(prNumber, metrics, `Model ${modelId} failed`));
      }
    }
    return results;
  }

  private computeMetrics(chunks: DiffChunk[], changedFiles: ChangedFile[]): PRMetrics {
    const totalAdditions = changedFiles.reduce((s, f) => s + f.additions, 0);
    const totalDeletions = changedFiles.reduce((s, f) => s + f.deletions, 0);

    const fileSizes = new Map<string, number>();
    for (const chunk of chunks) {
      const current = fileSizes.get(chunk.filePath) ?? 0;
      fileSizes.set(chunk.filePath, current + chunk.content.split('\n').length);
    }

    const sizes = [...fileSizes.values()];
    const avgComplexity = sizes.length > 0 ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0;

    const hotspotFiles = [...fileSizes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([path]) => path);

    const hasTestFiles = changedFiles.some(
      (f) => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f.filePath) || /\/tests?\//.test(f.filePath)
    );
    const testFileCount = changedFiles.filter(
      (f) => /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f.filePath) || /\/tests?\//.test(f.filePath)
    ).length;
    const nonTestCount = changedFiles.length - testFileCount;

    let testCoverage: PRMetrics['testCoverage'] = 'none';
    if (hasTestFiles) {
      const ratio = nonTestCount > 0 ? testFileCount / nonTestCount : 1;
      if (ratio >= 0.8) {
        testCoverage = 'excellent';
      } else if (ratio >= 0.5) {
        testCoverage = 'good';
      } else {
        testCoverage = 'partial';
      }
    }

    return {
      totalFilesChanged: changedFiles.length,
      totalAdditions,
      totalDeletions,
      avgComplexityPerFile: avgComplexity,
      hotspotFiles,
      testCoverage,
    };
  }

  private buildDiffSummary(chunks: DiffChunk[], budget: number = 4000): string {
    let totalLength = 0;
    const parts: string[] = [];
    const perChunkLimit = Math.min(600, Math.floor(budget / Math.max(chunks.length, 1)));

    for (const chunk of chunks) {
      const entry = `## ${chunk.filePath} (${chunk.type}, L${chunk.startLine}-${chunk.endLine})\n${chunk.content.slice(0, perChunkLimit)}\n`;
      if (totalLength + entry.length > budget) {
        parts.push(`... (${chunks.length - parts.length} more chunks omitted)`);
        break;
      }
      parts.push(entry);
      totalLength += entry.length;
    }

    return parts.join('\n');
  }

  private buildDeepAnalysisPrompt(diffSummary: string, metrics: PRMetrics, mode: ReviewMode): string {
    return `Analyze this PR (focus: ${mode}). Files: ${metrics.totalFilesChanged}, +${metrics.totalAdditions}/-${metrics.totalDeletions}, tests: ${metrics.testCoverage}, hotspots: ${metrics.hotspotFiles.slice(0, 3).join(', ') || 'none'}.

${diffSummary}

Respond as raw JSON (no code fences):
{"overallSummary":"2-3 sentence summary","complexityScore":<0-100>,"qualityGrade":"A|B|C|D|F","categories":[{"name":"<one of: ${ANALYSIS_CATEGORIES.join(', ')}>","score":<0-100>,"findings":["..."],"severity":"good|acceptable|needs-improvement|critical"}],"recommendations":[{"priority":"low|medium|high|critical","title":"...","description":"...","filePath":"..."}]}
Cover all categories: ${ANALYSIS_CATEGORIES.join(', ')}.`;
  }

  private validateGrade(grade: string | undefined): InDepthAnalysis['qualityGrade'] {
    const valid = ['A', 'B', 'C', 'D', 'F'];
    const upper = (grade ?? 'C').toUpperCase();
    return valid.includes(upper) ? (upper as InDepthAnalysis['qualityGrade']) : 'C';
  }

  private fallbackAnalysis(prNumber: number, metrics: PRMetrics, error: string): InDepthAnalysis {
    return {
      prNumber,
      overallSummary: `Unable to complete deep analysis: ${error}`,
      complexityScore: 0,
      qualityGrade: 'C',
      categories: [],
      recommendations: [],
      metrics,
      modelUsed: 'unknown',
    };
  }
}
