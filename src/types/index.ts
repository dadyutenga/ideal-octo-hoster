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
}

export interface ReviewSuggestion {
  line: number;
  severity: 'info' | 'warning' | 'error';
  message: string;
  patch?: string;
}

export type ReviewMode =
  | 'security'
  | 'performance'
  | 'clean-code'
  | 'architecture'
  | 'test-coverage'
  | 'general';

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
}

export interface ICopilotService {
  ask(prompt: string): Promise<string>;
  isAvailable(): Promise<boolean>;
}
