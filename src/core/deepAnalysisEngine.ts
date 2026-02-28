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
    const allContent = this.buildDiffSummary(chunks);

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
    for (const modelId of modelIds) {
      const metrics = this.computeMetrics(chunks, changedFiles);
      const allContent = this.buildDiffSummary(chunks);
      const prompt = this.buildDeepAnalysisPrompt(allContent, metrics, mode);

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

  private buildDiffSummary(chunks: DiffChunk[]): string {
    const maxTotalLength = 12000;
    let totalLength = 0;
    const parts: string[] = [];

    for (const chunk of chunks) {
      const entry = `### ${chunk.filePath} (${chunk.type}, L${chunk.startLine}-${chunk.endLine})\n\`\`\`diff\n${chunk.content.slice(0, 1500)}\n\`\`\`\n`;
      if (totalLength + entry.length > maxTotalLength) {
        parts.push(`\n... (${chunks.length - parts.length} more chunks truncated)`);
        break;
      }
      parts.push(entry);
      totalLength += entry.length;
    }

    return parts.join('\n');
  }

  private buildDeepAnalysisPrompt(diffSummary: string, metrics: PRMetrics, mode: ReviewMode): string {
    return `You are a senior software engineer performing an in-depth pull request analysis.
Focus area: ${mode}

## PR Metrics
- Files changed: ${metrics.totalFilesChanged}
- Lines added: ${metrics.totalAdditions}
- Lines deleted: ${metrics.totalDeletions}
- Test coverage: ${metrics.testCoverage}
- Hotspot files: ${metrics.hotspotFiles.join(', ') || 'none'}

## Changes
${diffSummary}

Perform a deep, thorough analysis. Respond in this exact JSON format (no markdown code blocks, just raw JSON):
{
  "overallSummary": "Comprehensive 3-5 sentence summary of what this PR does and its impact",
  "complexityScore": <0-100, where 100 is extremely complex>,
  "qualityGrade": "A|B|C|D|F",
  "categories": [
    {
      "name": "${ANALYSIS_CATEGORIES.join('|')}",
      "score": <0-100>,
      "findings": ["finding 1", "finding 2"],
      "severity": "good|acceptable|needs-improvement|critical"
    }
  ],
  "recommendations": [
    {
      "priority": "low|medium|high|critical",
      "title": "Short title",
      "description": "Detailed actionable recommendation",
      "filePath": "optional/file/path.ts",
      "lineRange": { "start": 1, "end": 10 }
    }
  ]
}

Analyze ALL of these categories: ${ANALYSIS_CATEGORIES.join(', ')}. Be thorough and actionable.`;
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
