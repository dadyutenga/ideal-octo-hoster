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
  security: `You are a security code reviewer. Analyze this code diff for:
- Authentication and authorization vulnerabilities
- Injection attacks (SQL, XSS, command injection)
- Insecure data handling or exposure of secrets
- Cryptographic weaknesses
- Input validation issues`,

  performance: `You are a performance engineering expert. Analyze this code diff for:
- Unnecessary database queries or N+1 problems
- Memory leaks or excessive allocations
- Blocking operations in async contexts
- Missing caching opportunities
- Algorithm complexity issues`,

  'clean-code': `You are a clean code expert. Analyze this code diff for:
- Code duplication and DRY violations
- Long functions that should be decomposed
- Poor naming of variables, functions, or classes
- Magic numbers or strings
- Violation of Single Responsibility Principle`,

  architecture: `You are a software architect. Analyze this code diff for:
- Tight coupling and dependency violations
- Missing abstraction layers
- Violation of SOLID principles
- Circular dependencies
- Inappropriate use of design patterns`,

  'test-coverage': `You are a QA engineer and testing expert. Analyze this code diff for:
- Missing unit tests for new functions
- Missing edge case coverage
- Untested error paths
- Test quality issues (brittle, non-deterministic tests)
- Missing integration test scenarios`,

  general: `You are an expert code reviewer. Analyze this code diff comprehensively for:
- Bugs and logic errors
- Security concerns
- Performance issues
- Code quality and maintainability
- Missing tests or documentation`,
};

export class ReviewEngine implements IReviewEngine {
  private readonly deepEngine: DeepAnalysisEngine;

  constructor(private readonly copilot: ICopilotService) {
    this.deepEngine = new DeepAnalysisEngine(copilot);
  }

  buildPrompt(mode: ReviewMode, chunk: DiffChunk): string {
    const modeInstructions = REVIEW_MODE_PROMPTS[mode];
    const maxContentLength = 4000;
    const truncatedContent =
      chunk.content.length > maxContentLength
        ? chunk.content.slice(0, maxContentLength) + '\n... [truncated]'
        : chunk.content;

    return `${modeInstructions}

## File: ${chunk.filePath}
## Change Type: ${chunk.type}
## Lines: ${chunk.startLine}–${chunk.endLine}

\`\`\`diff
${truncatedContent}
\`\`\`

Respond in this exact JSON format (no markdown code blocks, just raw JSON):
{
  "summary": "One sentence summary of the change",
  "riskLevel": "low|medium|high",
  "suggestions": [
    {
      "line": <line number>,
      "severity": "info|warning|error",
      "message": "<clear actionable message>",
      "patch": "<optional suggested replacement code>"
    }
  ]
}`;
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
