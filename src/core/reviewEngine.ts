import {
  IReviewEngine,
  ICopilotService,
  DiffChunk,
  ChangedFile,
  ReviewResult,
  ReviewMode,
  ReviewSuggestion,
  InDepthAnalysis,
} from '../types';
import { CopilotService } from '../integrations/copilot';
import { DeepAnalysisEngine } from './deepAnalysisEngine';

const REVIEW_MODE_PROMPTS: Record<ReviewMode, string> = {
  security: `Review for security: auth flaws, injection (SQL/XSS/cmd), secrets exposure, crypto weakness, input validation.`,
  performance: `Review for performance: N+1 queries, memory leaks, blocking async, missing cache, algorithm complexity.`,
  'clean-code': `Review for clean code: DRY violations, long functions, bad names, magic values, SRP violations.`,
  architecture: `Review for architecture: tight coupling, missing abstractions, SOLID violations, circular deps, pattern misuse.`,
  'test-coverage': `Review for testing: missing unit tests, edge cases, untested error paths, brittle tests, missing integration tests.`,
  general: `Review comprehensively: bugs, security, performance, code quality, missing tests.`,
};

export class ReviewEngine implements IReviewEngine {
  private readonly deepEngine: DeepAnalysisEngine;

  constructor(private readonly copilot: ICopilotService) {
    this.deepEngine = new DeepAnalysisEngine(copilot);
  }

  buildPrompt(mode: ReviewMode, chunk: DiffChunk): string {
    const modeInstructions = REVIEW_MODE_PROMPTS[mode];
    const maxContentLength = 2000;
    const truncatedContent =
      chunk.content.length > maxContentLength
        ? chunk.content.slice(0, maxContentLength) + '\n... [truncated]'
        : chunk.content;

    return `${modeInstructions}

File: ${chunk.filePath} | ${chunk.type} | L${chunk.startLine}–${chunk.endLine}

\`\`\`diff
${truncatedContent}
\`\`\`

Respond as raw JSON: {"summary":"...","riskLevel":"low|medium|high","suggestions":[{"line":<n>,"severity":"info|warning|error","message":"...","patch":"optional"}]}`;
  }

  /**
   * Batch-review all chunks for a single file in one API call.
   * Falls back to per-chunk if the batch fails to parse.
   */
  async reviewFileChunks(chunks: DiffChunk[], mode: ReviewMode, modelId?: string): Promise<ReviewResult[]> {
    if (chunks.length === 0) { return []; }

    // If only one chunk, use the simpler single-chunk path
    if (chunks.length === 1) {
      return [await this.reviewChunk(chunks[0], mode, modelId)];
    }

    const modeInstructions = REVIEW_MODE_PROMPTS[mode];
    const perChunkLimit = Math.min(1200, Math.floor(3000 / chunks.length));
    const filePath = chunks[0].filePath;

    const chunkBlocks = chunks.map((c, i) => {
      const content = c.content.slice(0, perChunkLimit);
      return `[Chunk ${i + 1}] ${c.type} L${c.startLine}–${c.endLine}\n${content}`;
    }).join('\n---\n');

    const prompt = `${modeInstructions}\n\nFile: ${filePath}\n\n${chunkBlocks}\n\nRespond as raw JSON array, one entry per chunk:\n[{"summary":"...","riskLevel":"low|medium|high","suggestions":[{"line":<n>,"severity":"info|warning|error","message":"..."}]}]`;

    const getModelName = () => (this.copilot as CopilotService).getLastUsedModelName?.() ?? 'unknown';

    try {
      const rawResponse = await this.copilot.ask(prompt, modelId);
      const jsonStr = rawResponse.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
      const parsed = JSON.parse(jsonStr) as Array<{
        summary: string;
        riskLevel: 'low' | 'medium' | 'high';
        suggestions: ReviewSuggestion[];
      }>;

      const modelName = getModelName();
      return chunks.map((chunk, i) => {
        const entry = parsed[i] ?? { summary: 'No issues found.', riskLevel: 'low', suggestions: [] };
        return {
          chunkId: `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`,
          filePath: chunk.filePath,
          mode,
          suggestions: entry.suggestions ?? [],
          summary: entry.summary ?? '',
          riskLevel: entry.riskLevel ?? 'low',
          modelUsed: modelName,
        };
      });
    } catch {
      // Batch failed — fall back to single-chunk review for each
      const results: ReviewResult[] = [];
      for (const chunk of chunks) {
        results.push(await this.reviewChunk(chunk, mode, modelId));
      }
      return results;
    }
  }

  async reviewChunk(chunk: DiffChunk, mode: ReviewMode, modelId?: string): Promise<ReviewResult> {
    const prompt = this.buildPrompt(mode, chunk);
    const chunkId = `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`;
    const getModelName = () => (this.copilot as CopilotService).getLastUsedModelName?.() ?? 'unknown';

    let rawResponse: string;
    try {
      rawResponse = await this.copilot.ask(prompt, modelId);
    } catch (err) {
      return {
        chunkId,
        filePath: chunk.filePath,
        mode,
        suggestions: [],
        summary: `Copilot unavailable: ${(err as Error).message}`,
        riskLevel: 'low',
        modelUsed: getModelName(),
      };
    }

    try {
      // Strip markdown code fences if present
      const jsonStr = rawResponse.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
      const parsed = JSON.parse(jsonStr) as {
        summary: string;
        riskLevel: 'low' | 'medium' | 'high';
        suggestions: ReviewSuggestion[];
      };
      return {
        chunkId,
        filePath: chunk.filePath,
        mode,
        suggestions: parsed.suggestions ?? [],
        summary: parsed.summary ?? '',
        riskLevel: parsed.riskLevel ?? 'low',
        modelUsed: getModelName(),
      };
    } catch {
      // Fallback: return raw text as a single suggestion
      return {
        chunkId,
        filePath: chunk.filePath,
        mode,
        suggestions: [{ line: chunk.startLine, severity: 'info', message: rawResponse }],
        summary: 'Review completed (unstructured response)',
        riskLevel: 'low',
        modelUsed: getModelName(),
      };
    }
  }

  async deepAnalyze(
    prNumber: number,
    chunks: DiffChunk[],
    changedFiles: ChangedFile[],
    mode: ReviewMode
  ): Promise<InDepthAnalysis> {
    return this.deepEngine.analyze(prNumber, chunks, changedFiles, mode);
  }
}
