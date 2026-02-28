// ──────────────────────────── Core Data Types ────────────────────────────

export interface PullRequest {
  number: number;
  title: string;
  author: string;
  url: string;
  headBranch: string;
  baseBranch: string;
  changedFilesCount: number;
  createdAt: string;
}

export interface ChangedFile {
  filePath: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
}

export interface DiffChunk {
  filePath: string;
  type: 'addition' | 'deletion' | 'modification';
  startLine: number;
  endLine: number;
  content: string;
  metadata: {
    containsFunction: boolean;
    containsImportChange: boolean;
    containsAuthLogic: boolean;
  };
}

// ──────────────────────────── Risk & Review ────────────────────────────

export interface RiskReport {
  filePath: string;
  score: number; // 0-100
  level: 'low' | 'medium' | 'high';
  reasons: string[];
}

export interface ReviewResult {
  chunkId: string;
  filePath: string;
  mode: ReviewMode;
  suggestions: ReviewSuggestion[];
  summary: string;
  riskLevel: 'low' | 'medium' | 'high';
  modelUsed?: string;
}

export interface ReviewSuggestion {
  line: number;
  severity: 'info' | 'warning' | 'error';
  message: string;
  patch?: string;
  category?: string;
}

export type ReviewMode =
  | 'security'
  | 'performance'
  | 'clean-code'
  | 'architecture'
  | 'test-coverage'
  | 'general';

// ──────────────────────────── Multi-Model ────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  family: string;
  vendor: string;
  maxInputTokens: number;
}

export type ModelVendor = 'copilot';

// ──────────────────────────── In-Depth Analysis ────────────────────────────

export interface InDepthAnalysis {
  prNumber: number;
  overallSummary: string;
  complexityScore: number; // 0-100
  qualityGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  categories: AnalysisCategory[];
  recommendations: Recommendation[];
  metrics: PRMetrics;
  modelUsed: string;
}

export interface AnalysisCategory {
  name: string;
  score: number; // 0-100
  findings: string[];
  severity: 'good' | 'acceptable' | 'needs-improvement' | 'critical';
}

export interface Recommendation {
  priority: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  filePath?: string;
  lineRange?: { start: number; end: number };
}

export interface PRMetrics {
  totalFilesChanged: number;
  totalAdditions: number;
  totalDeletions: number;
  avgComplexityPerFile: number;
  hotspotFiles: string[];
  testCoverage: 'none' | 'partial' | 'good' | 'excellent';
}

// ──────────────────────────── Comparative Review ────────────────────────────

export interface ComparativeReview {
  prNumber: number;
  modelReviews: ModelReviewEntry[];
  consensus: ConsensusResult;
}

export interface ModelReviewEntry {
  modelName: string;
  results: ReviewResult[];
  analysisTime: number; // ms
}

export interface ConsensusResult {
  agreedIssues: ReviewSuggestion[];
  conflictingOpinions: ConflictingOpinion[];
  overallRisk: 'low' | 'medium' | 'high';
  confidence: number; // 0-100
}

export interface ConflictingOpinion {
  topic: string;
  opinions: { model: string; view: string }[];
}

// ──────────────────────────── Service Interfaces ────────────────────────────

export interface IGitHubAdapter {
  listOpenPRs(): Promise<PullRequest[]>;
  getChangedFiles(prNumber: number): Promise<ChangedFile[]>;
  getDiff(prNumber: number, filePath: string): Promise<string>;
  submitReviewComment(prNumber: number, filePath: string, body: string, line: number): Promise<void>;
}

export interface IDiffEngine {
  parse(diff: string): DiffChunk[];
}

export interface IRiskAnalyzer {
  analyze(chunks: DiffChunk[]): RiskReport[];
}

export interface IReviewEngine {
  reviewChunk(chunk: DiffChunk, mode: ReviewMode): Promise<ReviewResult>;
  deepAnalyze?(prNumber: number, chunks: DiffChunk[], changedFiles: ChangedFile[], mode: ReviewMode): Promise<InDepthAnalysis>;
}

export interface ICopilotService {
  ask(prompt: string, modelId?: string): Promise<string>;
  isAvailable(): Promise<boolean>;
  listModels(): Promise<ModelInfo[]>;
  getActiveModel(): Promise<ModelInfo | undefined>;
}
