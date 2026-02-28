import React, { useEffect, useState, useCallback } from 'react';

// VS Code webview API
declare function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(state: unknown): void };
const vscode = acquireVsCodeApi();

// ──────────────────────────── Types ────────────────────────────

interface ReviewSuggestion {
  line: number;
  severity: 'info' | 'warning' | 'error';
  message: string;
  patch?: string;
  category?: string;
}

interface ReviewResult {
  chunkId: string;
  filePath: string;
  mode: string;
  suggestions: ReviewSuggestion[];
  summary: string;
  riskLevel: 'low' | 'medium' | 'high';
  modelUsed?: string;
}

interface RiskReport {
  filePath: string;
  score: number;
  level: 'low' | 'medium' | 'high';
  reasons: string[];
}

interface PullRequest {
  number: number;
  title: string;
  author: string;
  url: string;
  headBranch: string;
  baseBranch: string;
  changedFilesCount: number;
  createdAt: string;
}

interface AnalysisCategory {
  name: string;
  score: number;
  findings: string[];
  severity: 'good' | 'acceptable' | 'needs-improvement' | 'critical';
}

interface Recommendation {
  priority: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  filePath?: string;
  lineRange?: { start: number; end: number };
}

interface PRMetrics {
  totalFilesChanged: number;
  totalAdditions: number;
  totalDeletions: number;
  avgComplexityPerFile: number;
  hotspotFiles: string[];
  testCoverage: 'none' | 'partial' | 'good' | 'excellent';
}

interface InDepthAnalysis {
  prNumber: number;
  overallSummary: string;
  complexityScore: number;
  qualityGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  categories: AnalysisCategory[];
  recommendations: Recommendation[];
  metrics: PRMetrics;
  modelUsed: string;
}

interface StatusCheck {
  name: string;
  status: 'success' | 'failure' | 'pending' | 'neutral';
  description?: string;
}

interface MergeStatus {
  mergeable: boolean;
  mergeableState: 'clean' | 'dirty' | 'unstable' | 'blocked' | 'unknown';
  merged: boolean;
  mergedBy?: string;
  mergedAt?: string;
  behindBy: number;
  aheadBy: number;
  allowedMethods: ('merge' | 'squash' | 'rebase')[];
  statusChecks: StatusCheck[];
}

type AppState =
  | { state: 'idle' }
  | { state: 'loading'; message: string }
  | { state: 'error'; errorMessage: string }
  | { state: 'results'; pr: PullRequest; results: ReviewResult[]; riskReports: RiskReport[] }
  | { state: 'deepAnalysis'; pr: PullRequest; analysis: InDepthAnalysis; riskReports: RiskReport[] }
  | { state: 'multiModel'; pr: PullRequest; modelResults: { modelName: string; results: ReviewResult[] }[]; riskReports: RiskReport[] }
  | { state: 'mergeStatus'; pr: PullRequest; mergeStatus: MergeStatus };

type VSCodeMessage =
  | { command: 'loading'; data: { message: string } }
  | { command: 'error'; data: { message: string } }
  | { command: 'updateResults'; data: { pr: PullRequest; results: ReviewResult[]; riskReports: RiskReport[] } }
  | { command: 'updateDeepAnalysis'; data: { pr: PullRequest; analysis: InDepthAnalysis; riskReports: RiskReport[] } }
  | { command: 'updateMultiModelResults'; data: { pr: PullRequest; modelResults: { modelName: string; results: ReviewResult[] }[]; riskReports: RiskReport[] } }
  | { command: 'updateMergeStatus'; data: { pr: PullRequest; mergeStatus: MergeStatus } }
  | { command: 'refresh' };

// ──────────────────────────── Constants ────────────────────────────

const SEVERITY_ICON: Record<ReviewSuggestion['severity'], string> = {
  info: 'ℹ️',
  warning: '⚠️',
  error: '🔴',
};

const RISK_COLOR: Record<RiskReport['level'], string> = {
  low: 'var(--vscode-testing-iconPassed, #3fb950)',
  medium: 'var(--vscode-editorWarning-foreground, #e3b341)',
  high: 'var(--vscode-testing-iconFailed, #f85149)',
};

const GRADE_COLOR: Record<string, string> = {
  A: '#3fb950',
  B: '#58a6ff',
  C: '#e3b341',
  D: '#f0883e',
  F: '#f85149',
};

const SEVERITY_COLOR: Record<string, string> = {
  good: '#3fb950',
  acceptable: '#58a6ff',
  'needs-improvement': '#e3b341',
  critical: '#f85149',
};

const PRIORITY_ICON: Record<string, string> = {
  low: '📋',
  medium: '📌',
  high: '⚠️',
  critical: '🚨',
};

const TEST_COVERAGE_ICON: Record<string, string> = {
  none: '❌',
  partial: '🟡',
  good: '✅',
  excellent: '🌟',
};

const MERGE_STATE_INFO: Record<string, { icon: string; label: string; color: string }> = {
  clean: { icon: '✅', label: 'Ready to merge', color: '#3fb950' },
  dirty: { icon: '❌', label: 'Has conflicts', color: '#f85149' },
  unstable: { icon: '⚠️', label: 'Checks failing', color: '#e3b341' },
  blocked: { icon: '🚫', label: 'Blocked', color: '#f85149' },
  unknown: { icon: '❓', label: 'Unknown', color: '#888' },
};

const MERGE_METHOD_INFO: Record<string, { icon: string; label: string; description: string }> = {
  merge: { icon: '🔀', label: 'Merge Commit', description: 'Creates a merge commit' },
  squash: { icon: '📦', label: 'Squash & Merge', description: 'Squash all commits into one' },
  rebase: { icon: '📐', label: 'Rebase & Merge', description: 'Rebase commits onto base' },
};

const CHECK_STATUS_ICON: Record<string, string> = {
  success: '✅',
  failure: '❌',
  pending: '⏳',
  neutral: '⚪',
};

// ──────────────────────────── Shared Components ────────────────────────────

function RiskBadge({ level }: { level: 'low' | 'medium' | 'high' }): React.ReactElement {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '12px',
        fontSize: '11px',
        fontWeight: 'bold',
        textTransform: 'uppercase',
        color: RISK_COLOR[level],
        border: `1px solid ${RISK_COLOR[level]}`,
      }}
    >
      {level}
    </span>
  );
}

function ModelBadge({ name }: { name: string }): React.ReactElement {
  return (
    <span className="model-badge">
      🤖 {name}
    </span>
  );
}

function LoadingView({ message }: { message: string }): React.ReactElement {
  return (
    <div className="loading-container">
      <div className="spinner" />
      <p className="loading-message">{message}</p>
    </div>
  );
}

function ErrorView({ message }: { message: string }): React.ReactElement {
  return (
    <div className="error-container">
      <span className="error-icon">⚠️</span>
      <p className="error-message">{message}</p>
    </div>
  );
}

function PRHeader({ pr, currentView }: { pr: PullRequest; currentView: string }): React.ReactElement {
  const sendAction = useCallback((action: string) => {
    vscode.postMessage({ command: action, data: { pr } });
  }, [pr]);

  return (
    <header className="pr-header">
      <h1 className="pr-title">
        PR #{pr.number}: {pr.title}
      </h1>
      <div className="pr-meta">
        {pr.author && <span>by {pr.author}</span>}
        {pr.headBranch && (
          <span>
            {pr.headBranch} → {pr.baseBranch}
          </span>
        )}
        <span>{pr.changedFilesCount} file(s) changed</span>
      </div>
      <div className="action-bar">
        <button
          className={`action-btn ${currentView === 'results' ? 'action-btn--active' : ''}`}
          onClick={() => sendAction('runReview')}
          title="Standard Review"
        >
          ▶ Review
        </button>
        <button
          className={`action-btn ${currentView === 'deepAnalysis' ? 'action-btn--active' : ''}`}
          onClick={() => sendAction('runDeepAnalysis')}
          title="In-Depth Analysis"
        >
          🔬 Deep Analysis
        </button>
        <button
          className={`action-btn ${currentView === 'multiModel' ? 'action-btn--active' : ''}`}
          onClick={() => sendAction('runMultiModel')}
          title="Multi-Model Comparative Review"
        >
          🤖 Multi-Model
        </button>
        <span className="action-divider" />
        <button
          className="action-btn"
          onClick={() => sendAction('runSummary')}
          title="Generate Summary"
        >
          📝 Summary
        </button>
        <button
          className="action-btn"
          onClick={() => sendAction('runRiskAnalysis')}
          title="Risk Analysis"
        >
          ⚠️ Risk
        </button>
        <button
          className={`action-btn ${currentView === 'mergeStatus' ? 'action-btn--active' : ''}`}
          onClick={() => sendAction('checkMergeStatus')}
          title="Check Merge Status"
        >
          🔀 Merge
        </button>
        <button
          className="action-btn action-btn--subtle"
          onClick={() => sendAction('selectModel')}
          title="Select AI Model"
        >
          ⚙️ Model
        </button>
      </div>
    </header>
  );
}

function RiskTable({ reports }: { reports: RiskReport[] }): React.ReactElement {
  return (
    <section className="section">
      <h2 className="section-title">Risk Analysis</h2>
      <table className="risk-table">
        <thead>
          <tr>
            <th>File</th>
            <th>Level</th>
            <th>Score</th>
            <th>Reasons</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.filePath}>
              <td className="file-path">{r.filePath}</td>
              <td>
                <RiskBadge level={r.level} />
              </td>
              <td>{r.score}/100</td>
              <td>
                <ul className="reasons-list">
                  {r.reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function SuggestionItem({ suggestion }: { suggestion: ReviewSuggestion }): React.ReactElement {
  return (
    <div className={`suggestion suggestion--${suggestion.severity}`}>
      <div className="suggestion-header">
        <span className="suggestion-icon">{SEVERITY_ICON[suggestion.severity]}</span>
        <span className="suggestion-line">Line {suggestion.line}</span>
        <span className={`suggestion-severity suggestion-severity--${suggestion.severity}`}>
          {suggestion.severity}
        </span>
        {suggestion.category && <span className="suggestion-category">{suggestion.category}</span>}
      </div>
      <p className="suggestion-message">{suggestion.message}</p>
      {suggestion.patch && (
        <details className="suggestion-patch">
          <summary>View suggested patch</summary>
          <pre><code>{suggestion.patch}</code></pre>
        </details>
      )}
    </div>
  );
}

function ReviewResultCard({ result }: { result: ReviewResult }): React.ReactElement {
  return (
    <div className="result-card">
      <div className="result-card-header">
        <span className="result-file">{result.filePath}</span>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {result.modelUsed && <ModelBadge name={result.modelUsed} />}
          <RiskBadge level={result.riskLevel} />
        </div>
      </div>
      {result.summary && <p className="result-summary">{result.summary}</p>}
      {result.suggestions.length > 0 && (
        <div className="suggestions-list">
          {result.suggestions.map((s, i) => (
            <SuggestionItem key={i} suggestion={s} />
          ))}
        </div>
      )}
      {result.suggestions.length === 0 && (
        <p className="no-suggestions">✅ No suggestions for this chunk.</p>
      )}
    </div>
  );
}

// ──────────────────────────── Score Visualizations ────────────────────────────

function ScoreBar({ score, label, color }: { score: number; label: string; color?: string }): React.ReactElement {
  const barColor = color ?? (score >= 80 ? '#3fb950' : score >= 60 ? '#58a6ff' : score >= 40 ? '#e3b341' : '#f85149');
  return (
    <div className="score-bar">
      <div className="score-bar-label">
        <span>{label}</span>
        <span>{score}/100</span>
      </div>
      <div className="score-bar-track">
        <div className="score-bar-fill" style={{ width: `${score}%`, backgroundColor: barColor }} />
      </div>
    </div>
  );
}

function GradeCircle({ grade }: { grade: string }): React.ReactElement {
  const color = GRADE_COLOR[grade] ?? '#888';
  return (
    <div className="grade-circle" style={{ borderColor: color, color }}>
      {grade}
    </div>
  );
}

// ──────────────────────────── Merge Status View ────────────────────────────

function MergeStatusView({
  pr,
  mergeStatus,
}: {
  pr: PullRequest;
  mergeStatus: MergeStatus;
}): React.ReactElement {
  const stateInfo = MERGE_STATE_INFO[mergeStatus.mergeableState] ?? MERGE_STATE_INFO.unknown;

  const handleMerge = useCallback(() => {
    vscode.postMessage({ command: 'mergePR', data: { pr } });
  }, [pr]);

  return (
    <div className="results-container">
      <PRHeader pr={pr} currentView="mergeStatus" />

      <section className="section merge-status-section">
        <h2 className="section-title">Merge Status</h2>

        {mergeStatus.merged ? (
          <div className="merge-banner merge-banner--merged">
            <span className="merge-banner-icon">✅</span>
            <div className="merge-banner-content">
              <strong>This PR has been merged</strong>
              {mergeStatus.mergedBy && <span>by {mergeStatus.mergedBy}</span>}
              {mergeStatus.mergedAt && <span> on {new Date(mergeStatus.mergedAt).toLocaleDateString()}</span>}
            </div>
          </div>
        ) : (
          <div className={`merge-banner merge-banner--${mergeStatus.mergeableState}`}>
            <span className="merge-banner-icon">{stateInfo.icon}</span>
            <div className="merge-banner-content">
              <strong style={{ color: stateInfo.color }}>{stateInfo.label}</strong>
              {!mergeStatus.mergeable && mergeStatus.mergeableState === 'dirty' && (
                <p className="merge-conflict-hint">This branch has conflicts that must be resolved before merging.</p>
              )}
            </div>
          </div>
        )}
      </section>

      {mergeStatus.statusChecks.length > 0 && (
        <section className="section">
          <h2 className="section-title">Status Checks</h2>
          <div className="status-checks-list">
            {mergeStatus.statusChecks.map((check, i) => (
              <div key={i} className={`status-check status-check--${check.status}`}>
                <span className="status-check-icon">{CHECK_STATUS_ICON[check.status]}</span>
                <span className="status-check-name">{check.name}</span>
                {check.description && <span className="status-check-desc">{check.description}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {!mergeStatus.merged && (
        <section className="section">
          <h2 className="section-title">Merge Options</h2>
          <div className="merge-methods-grid">
            {mergeStatus.allowedMethods.map((method) => {
              const info = MERGE_METHOD_INFO[method];
              return (
                <div key={method} className="merge-method-card">
                  <span className="merge-method-icon">{info.icon}</span>
                  <div className="merge-method-info">
                    <strong>{info.label}</strong>
                    <span className="merge-method-desc">{info.description}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {mergeStatus.mergeable && (
            <button
              className="merge-button"
              onClick={handleMerge}
            >
              🔀 Merge Pull Request
            </button>
          )}

          {!mergeStatus.mergeable && !mergeStatus.merged && (
            <div className="merge-blocked-info">
              <p>⚠️ This PR cannot be merged in its current state. Resolve the issues above before merging.</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ──────────────────────────── Deep Analysis View ────────────────────────────

function MetricsPanel({ metrics }: { metrics: PRMetrics }): React.ReactElement {
  return (
    <section className="section">
      <h2 className="section-title">PR Metrics</h2>
      <div className="metrics-grid">
        <div className="metric-card">
          <div className="metric-value">{metrics.totalFilesChanged}</div>
          <div className="metric-label">Files Changed</div>
        </div>
        <div className="metric-card metric-card--additions">
          <div className="metric-value">+{metrics.totalAdditions}</div>
          <div className="metric-label">Additions</div>
        </div>
        <div className="metric-card metric-card--deletions">
          <div className="metric-value">-{metrics.totalDeletions}</div>
          <div className="metric-label">Deletions</div>
        </div>
        <div className="metric-card">
          <div className="metric-value">{TEST_COVERAGE_ICON[metrics.testCoverage]}</div>
          <div className="metric-label">Test Coverage: {metrics.testCoverage}</div>
        </div>
      </div>
      {metrics.hotspotFiles.length > 0 && (
        <div className="hotspot-files">
          <h3 className="subsection-title">🔥 Hotspot Files</h3>
          <ul className="hotspot-list">
            {metrics.hotspotFiles.map((f, i) => (
              <li key={i} className="file-path">{f}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function CategoryCard({ category }: { category: AnalysisCategory }): React.ReactElement {
  const color = SEVERITY_COLOR[category.severity] ?? '#888';
  return (
    <div className="category-card" style={{ borderLeftColor: color }}>
      <div className="category-header">
        <span className="category-name">{category.name}</span>
        <span className="category-severity" style={{ color }}>{category.severity.replace('-', ' ')}</span>
      </div>
      <ScoreBar score={category.score} label="" color={color} />
      {category.findings.length > 0 && (
        <ul className="category-findings">
          {category.findings.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RecommendationCard({ rec }: { rec: Recommendation }): React.ReactElement {
  return (
    <div className={`recommendation recommendation--${rec.priority}`}>
      <div className="recommendation-header">
        <span>{PRIORITY_ICON[rec.priority]} {rec.title}</span>
        <span className={`priority-badge priority-badge--${rec.priority}`}>{rec.priority}</span>
      </div>
      <p className="recommendation-desc">{rec.description}</p>
      {rec.filePath && (
        <span className="recommendation-file">
          📁 {rec.filePath}
          {rec.lineRange && ` (L${rec.lineRange.start}-${rec.lineRange.end})`}
        </span>
      )}
    </div>
  );
}

function DeepAnalysisView({
  pr,
  analysis,
  riskReports,
}: {
  pr: PullRequest;
  analysis: InDepthAnalysis;
  riskReports: RiskReport[];
}): React.ReactElement {
  return (
    <div className="results-container">
      <PRHeader pr={pr} currentView="deepAnalysis" />

      <section className="section deep-analysis-header">
        <div className="deep-header-row">
          <div className="deep-header-left">
            <h2 className="section-title">In-Depth Analysis</h2>
            <ModelBadge name={analysis.modelUsed} />
          </div>
          <div className="deep-header-right">
            <GradeCircle grade={analysis.qualityGrade} />
          </div>
        </div>
        <p className="analysis-summary">{analysis.overallSummary}</p>
        <ScoreBar score={analysis.complexityScore} label="Complexity" />
      </section>

      <MetricsPanel metrics={analysis.metrics} />

      {analysis.categories.length > 0 && (
        <section className="section">
          <h2 className="section-title">Category Breakdown</h2>
          <div className="categories-grid">
            {analysis.categories.map((c, i) => (
              <CategoryCard key={i} category={c} />
            ))}
          </div>
        </section>
      )}

      {analysis.recommendations.length > 0 && (
        <section className="section">
          <h2 className="section-title">Recommendations</h2>
          <div className="recommendations-list">
            {analysis.recommendations.map((r, i) => (
              <RecommendationCard key={i} rec={r} />
            ))}
          </div>
        </section>
      )}

      {riskReports.length > 0 && <RiskTable reports={riskReports} />}
    </div>
  );
}

// ──────────────────────────── Multi-Model View ────────────────────────────

function MultiModelView({
  pr,
  modelResults,
  riskReports,
}: {
  pr: PullRequest;
  modelResults: { modelName: string; results: ReviewResult[] }[];
  riskReports: RiskReport[];
}): React.ReactElement {
  const [activeTab, setActiveTab] = useState(0);

  const totalIssues = modelResults.map((mr) => ({
    name: mr.modelName,
    errors: mr.results.reduce((s, r) => s + r.suggestions.filter((sg) => sg.severity === 'error').length, 0),
    warnings: mr.results.reduce((s, r) => s + r.suggestions.filter((sg) => sg.severity === 'warning').length, 0),
    infos: mr.results.reduce((s, r) => s + r.suggestions.filter((sg) => sg.severity === 'info').length, 0),
    total: mr.results.reduce((s, r) => s + r.suggestions.length, 0),
  }));

  return (
    <div className="results-container">
      <PRHeader pr={pr} currentView="multiModel" />

      <section className="section">
        <h2 className="section-title">Multi-Model Comparison</h2>
        <table className="risk-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Errors</th>
              <th>Warnings</th>
              <th>Info</th>
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {totalIssues.map((ti) => (
              <tr key={ti.name}>
                <td><ModelBadge name={ti.name} /></td>
                <td style={{ color: '#f85149' }}>{ti.errors}</td>
                <td style={{ color: '#e3b341' }}>{ti.warnings}</td>
                <td style={{ color: '#58a6ff' }}>{ti.infos}</td>
                <td><strong>{ti.total}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="section">
        <div className="model-tabs">
          {modelResults.map((mr, i) => (
            <button
              key={i}
              className={`model-tab ${i === activeTab ? 'model-tab--active' : ''}`}
              onClick={() => setActiveTab(i)}
            >
              {mr.modelName}
            </button>
          ))}
        </div>

        {modelResults[activeTab] && (
          <div className="model-tab-content">
            {(() => {
              const grouped = modelResults[activeTab].results.reduce<Record<string, ReviewResult[]>>((acc, r) => {
                if (!acc[r.filePath]) { acc[r.filePath] = []; }
                acc[r.filePath].push(r);
                return acc;
              }, {});

              return Object.entries(grouped).map(([filePath, fileResults]) => (
                <div key={filePath} className="file-group">
                  <h3 className="file-group-title">📄 {filePath}</h3>
                  {fileResults.map((r) => (
                    <ReviewResultCard key={r.chunkId} result={r} />
                  ))}
                </div>
              ));
            })()}
          </div>
        )}
      </section>

      {riskReports.length > 0 && <RiskTable reports={riskReports} />}
    </div>
  );
}

// ──────────────────────────── Standard Results View ────────────────────────────

function ResultsView({
  pr,
  results,
  riskReports,
}: {
  pr: PullRequest;
  results: ReviewResult[];
  riskReports: RiskReport[];
}): React.ReactElement {
  const groupedResults = results.reduce<Record<string, ReviewResult[]>>((acc, r) => {
    if (!acc[r.filePath]) {
      acc[r.filePath] = [];
    }
    acc[r.filePath].push(r);
    return acc;
  }, {});

  const modelNames = [...new Set(results.map((r) => r.modelUsed).filter(Boolean))];

  return (
    <div className="results-container">
      <PRHeader pr={pr} currentView="results" />

      {modelNames.length > 0 && (
        <div className="model-info-bar">
          Analyzed with: {modelNames.map((m, i) => (
            <ModelBadge key={i} name={m!} />
          ))}
        </div>
      )}

      {riskReports.length > 0 && <RiskTable reports={riskReports} />}

      <section className="section">
        <h2 className="section-title">Review Results</h2>
        {Object.entries(groupedResults).map(([filePath, fileResults]) => (
          <div key={filePath} className="file-group">
            <h3 className="file-group-title">📄 {filePath}</h3>
            {fileResults.map((r) => (
              <ReviewResultCard key={r.chunkId} result={r} />
            ))}
          </div>
        ))}
        {results.length === 0 && <p className="no-results">No review results available.</p>}
      </section>
    </div>
  );
}

// ──────────────────────────── Main App ────────────────────────────

export function App(): React.ReactElement {
  const [appState, setAppState] = useState<AppState>({ state: 'idle' });

  useEffect(() => {
    const handler = (event: MessageEvent<VSCodeMessage>) => {
      const message = event.data;
      switch (message.command) {
        case 'loading':
          setAppState({ state: 'loading', message: message.data.message });
          break;
        case 'error':
          setAppState({ state: 'error', errorMessage: message.data.message });
          break;
        case 'updateResults':
          setAppState({
            state: 'results',
            pr: message.data.pr,
            results: message.data.results,
            riskReports: message.data.riskReports,
          });
          break;
        case 'updateDeepAnalysis':
          setAppState({
            state: 'deepAnalysis',
            pr: message.data.pr,
            analysis: message.data.analysis,
            riskReports: message.data.riskReports,
          });
          break;
        case 'updateMultiModelResults':
          setAppState({
            state: 'multiModel',
            pr: message.data.pr,
            modelResults: message.data.modelResults,
            riskReports: message.data.riskReports,
          });
          break;
        case 'updateMergeStatus':
          setAppState({
            state: 'mergeStatus',
            pr: message.data.pr,
            mergeStatus: message.data.mergeStatus,
          });
          break;
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  switch (appState.state) {
    case 'idle':
      return (
        <div className="idle-container">
          <div className="idle-icon">🔍</div>
          <h2>PRism</h2>
          <p>Select a pull request from the sidebar to start a review.</p>
          <div className="idle-features">
            <div className="feature-pill">🤖 Multi-Model</div>
            <div className="feature-pill">🔬 Deep Analysis</div>
            <div className="feature-pill">📊 Risk Scoring</div>
            <div className="feature-pill">🛡️ Security Review</div>
          </div>
        </div>
      );
    case 'loading':
      return <LoadingView message={appState.message} />;
    case 'error':
      return <ErrorView message={appState.errorMessage} />;
    case 'results':
      return (
        <ResultsView
          pr={appState.pr}
          results={appState.results}
          riskReports={appState.riskReports}
        />
      );
    case 'deepAnalysis':
      return (
        <DeepAnalysisView
          pr={appState.pr}
          analysis={appState.analysis}
          riskReports={appState.riskReports}
        />
      );
    case 'multiModel':
      return (
        <MultiModelView
          pr={appState.pr}
          modelResults={appState.modelResults}
          riskReports={appState.riskReports}
        />
      );
    case 'mergeStatus':
      return (
        <MergeStatusView
          pr={appState.pr}
          mergeStatus={appState.mergeStatus}
        />
      );
  }
}
