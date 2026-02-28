import React, { useEffect, useState, useCallback, useMemo } from 'react';

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

const SEVERITY_ICON: Record<string, string> = { info: 'i', warning: '!', error: '\u00d7' };

const RISK_COLOR: Record<string, string> = { low: '#3fb950', medium: '#e3b341', high: '#f85149' };

const GRADE_COLOR: Record<string, string> = { A: '#3fb950', B: '#58a6ff', C: '#e3b341', D: '#f0883e', F: '#f85149' };

const SEVERITY_COLOR: Record<string, string> = { good: '#3fb950', acceptable: '#58a6ff', 'needs-improvement': '#e3b341', critical: '#f85149' };

const MERGE_STATE: Record<string, { icon: string; label: string; color: string }> = {
  clean:   { icon: '\u2713', label: 'Ready to merge', color: '#3fb950' },
  dirty:   { icon: '\u00d7', label: 'Has conflicts',  color: '#f85149' },
  unstable:{ icon: '!',      label: 'Checks failing', color: '#e3b341' },
  blocked: { icon: '\u2298', label: 'Blocked',        color: '#f85149' },
  unknown: { icon: '?',      label: 'Unknown',        color: '#848d97' },
};

const MERGE_METHOD: Record<string, { label: string; desc: string }> = {
  merge:  { label: 'Merge Commit',    desc: 'All commits preserved with merge commit' },
  squash: { label: 'Squash & Merge',  desc: 'Combine all commits into one' },
  rebase: { label: 'Rebase & Merge',  desc: 'Linear history, no merge commit' },
};

const CHECK_ICON: Record<string, string> = { success: '\u2713', failure: '\u00d7', pending: '\u25cb', neutral: '\u2013' };

// ──────────────────────────── Shared Components ────────────────────────────

function Badge({ children, variant = 'default', size = 'sm' }: {
  children: React.ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'muted';
  size?: 'xs' | 'sm';
}): React.ReactElement {
  return <span className={`badge badge--${variant} badge--${size}`}>{children}</span>;
}

function RiskBadge({ level }: { level: 'low' | 'medium' | 'high' }): React.ReactElement {
  const v = level === 'low' ? 'success' : level === 'medium' ? 'warning' : 'danger';
  return <Badge variant={v} size="xs">{level.toUpperCase()}</Badge>;
}

function ModelBadge({ name }: { name: string }): React.ReactElement {
  return <Badge variant="info" size="sm">{name}</Badge>;
}

function Card({ children, className = '', accent }: {
  children: React.ReactNode;
  className?: string;
  accent?: string;
}): React.ReactElement {
  return (
    <div className={`card ${className}`} style={accent ? { '--card-accent': accent } as React.CSSProperties : undefined}>
      {children}
    </div>
  );
}

function SectionHead({ title, badge, right }: {
  title: string;
  badge?: React.ReactNode;
  right?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="section-head">
      <div className="section-head-left">
        <h2 className="section-title">{title}</h2>
        {badge}
      </div>
      {right && <div className="section-head-right">{right}</div>}
    </div>
  );
}

function StatCard({ value, label, color, icon }: {
  value: string | number;
  label: string;
  color?: string;
  icon?: string;
}): React.ReactElement {
  return (
    <div className="stat-card">
      {icon && <span className="stat-icon" style={color ? { color } : undefined}>{icon}</span>}
      <span className="stat-value" style={color ? { color } : undefined}>{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function EmptyState({ icon, text }: { icon: string; text: string }): React.ReactElement {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <p>{text}</p>
    </div>
  );
}

// ──────────────────────────── Loading & Error ────────────────────────────

function LoadingView({ message }: { message: string }): React.ReactElement {
  return (
    <div className="loading-container">
      <div className="loader">
        <div className="loader-ring" />
        <div className="loader-ring loader-ring--2" />
        <div className="loader-ring loader-ring--3" />
      </div>
      <p className="loading-msg">{message}</p>
      <div className="loading-dots"><span /><span /><span /></div>
    </div>
  );
}

function ErrorView({ message }: { message: string }): React.ReactElement {
  return (
    <div className="error-container">
      <div className="error-badge">\u00d7</div>
      <h3 className="error-title">Something went wrong</h3>
      <p className="error-msg">{message}</p>
    </div>
  );
}

// ──────────────────────────── Navigation ────────────────────────────

function PRHeader({ pr, currentView }: { pr: PullRequest; currentView: string }): React.ReactElement {
  const sendAction = useCallback((action: string) => {
    vscode.postMessage({ command: action, data: { pr } });
  }, [pr]);

  const timeAgo = useMemo(() => {
    const ms = Date.now() - new Date(pr.createdAt).getTime();
    const d = Math.floor(ms / 86400000);
    if (d > 30) { return `${Math.floor(d / 30)}mo ago`; }
    if (d > 0) { return `${d}d ago`; }
    const h = Math.floor(ms / 3600000);
    return h > 0 ? `${h}h ago` : 'just now';
  }, [pr.createdAt]);

  const navItems = [
    { id: 'results',      label: 'Review',        action: 'runReview' },
    { id: 'deepAnalysis', label: 'Deep Analysis',  action: 'runDeepAnalysis' },
    { id: 'multiModel',   label: 'Multi-Model',    action: 'runMultiModel' },
    { id: 'mergeStatus',  label: 'Merge',           action: 'checkMergeStatus' },
  ];
  const utilItems = [
    { label: 'Summary', action: 'runSummary' },
    { label: 'Risk',    action: 'runRiskAnalysis' },
    { label: 'Model',   action: 'selectModel' },
  ];

  return (
    <header className="header">
      <div className="header-top">
        <span className="pr-badge">#{pr.number}</span>
        <div className="header-info">
          <h1 className="header-title">{pr.title}</h1>
          <div className="header-meta">
            {pr.author && <span className="meta-item">{pr.author}</span>}
            {pr.headBranch && (
              <span className="meta-item">
                <code className="branch">{pr.headBranch}</code>
                <span className="branch-arrow">\u2192</span>
                <code className="branch">{pr.baseBranch}</code>
              </span>
            )}
            <span className="meta-item">{pr.changedFilesCount} files</span>
            {pr.createdAt && <span className="meta-item meta-time">{timeAgo}</span>}
          </div>
        </div>
      </div>

      <nav className="nav">
        <div className="nav-main">
          {navItems.map((it) => (
            <button
              key={it.id}
              className={`nav-btn ${currentView === it.id ? 'nav-btn--active' : ''}`}
              onClick={() => sendAction(it.action)}
            >{it.label}</button>
          ))}
        </div>
        <div className="nav-sep" />
        <div className="nav-utils">
          {utilItems.map((it) => (
            <button
              key={it.action}
              className="nav-btn nav-btn--ghost"
              onClick={() => sendAction(it.action)}
            >{it.label}</button>
          ))}
        </div>
      </nav>
    </header>
  );
}

// ──────────────────────────── Score Visuals ────────────────────────────

function ScoreBar({ score, label, color }: { score: number; label: string; color?: string }): React.ReactElement {
  const c = color ?? (score >= 80 ? '#3fb950' : score >= 60 ? '#58a6ff' : score >= 40 ? '#e3b341' : '#f85149');
  return (
    <div className="score-bar">
      {label && (
        <div className="score-bar-head">
          <span>{label}</span>
          <span className="score-num">{score}<span className="score-max">/100</span></span>
        </div>
      )}
      <div className="score-track">
        <div className="score-fill" style={{ width: `${score}%`, background: `linear-gradient(90deg, ${c}88, ${c})` }} />
      </div>
    </div>
  );
}

function GradeCircle({ grade }: { grade: string }): React.ReactElement {
  const c = GRADE_COLOR[grade] ?? '#848d97';
  const pct = grade === 'A' ? 95 : grade === 'B' ? 80 : grade === 'C' ? 60 : grade === 'D' ? 40 : 20;
  const circumference = 2 * Math.PI * 32;
  return (
    <div className="grade" style={{ '--gc': c } as React.CSSProperties}>
      <svg className="grade-svg" viewBox="0 0 80 80">
        <circle className="grade-bg" cx="40" cy="40" r="32" />
        <circle
          className="grade-fill"
          cx="40" cy="40" r="32"
          strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
        />
      </svg>
      <span className="grade-letter">{grade}</span>
    </div>
  );
}

// ──────────────────────────── Risk & Review ────────────────────────────

function RiskTable({ reports }: { reports: RiskReport[] }): React.ReactElement {
  return (
    <section className="section">
      <SectionHead title="Risk Analysis" badge={<Badge variant="muted" size="xs">{reports.length} files</Badge>} />
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr><th>File</th><th>Level</th><th>Score</th><th>Reasons</th></tr>
          </thead>
          <tbody>
            {reports.map((r) => (
              <tr key={r.filePath}>
                <td><code className="fp">{r.filePath}</code></td>
                <td><RiskBadge level={r.level} /></td>
                <td>
                  <div className="mini-bar">
                    <div className="mini-bar-fill" style={{ width: `${r.score}%`, backgroundColor: RISK_COLOR[r.level] }} />
                  </div>
                  <span className="mini-bar-num">{r.score}</span>
                </td>
                <td>
                  <ul className="reason-list">
                    {r.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SuggestionItem({ suggestion }: { suggestion: ReviewSuggestion }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className={`sug sug--${suggestion.severity}`}>
      <div className="sug-head">
        <span className={`sug-indicator sug-indicator--${suggestion.severity}`}>{SEVERITY_ICON[suggestion.severity]}</span>
        <code className="sug-line">L{suggestion.line}</code>
        <span className={`sug-level sug-level--${suggestion.severity}`}>{suggestion.severity}</span>
        {suggestion.category && <Badge variant="info" size="xs">{suggestion.category}</Badge>}
      </div>
      <p className="sug-msg">{suggestion.message}</p>
      {suggestion.patch && (
        <div className="sug-patch">
          <button className="patch-btn" onClick={() => setOpen(!open)}>
            {open ? '\u25be Hide patch' : '\u25b8 View patch'}
          </button>
          {open && <pre className="code-block"><code>{suggestion.patch}</code></pre>}
        </div>
      )}
    </div>
  );
}

function ReviewResultCard({ result }: { result: ReviewResult }): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <Card className="result-card">
      <button className="result-head" onClick={() => setCollapsed(!collapsed)}>
        <div className="result-head-left">
          <span className="caret">{collapsed ? '\u25b8' : '\u25be'}</span>
          <code className="result-fp">{result.filePath}</code>
        </div>
        <div className="result-head-right">
          {result.modelUsed && <ModelBadge name={result.modelUsed} />}
          <RiskBadge level={result.riskLevel} />
          {result.suggestions.length > 0 && (
            <Badge variant="muted" size="xs">{result.suggestions.length}</Badge>
          )}
        </div>
      </button>
      {!collapsed && (
        <div className="result-body">
          {result.summary && <p className="result-summary">{result.summary}</p>}
          {result.suggestions.length > 0 ? (
            <div className="sug-list">
              {result.suggestions.map((s, i) => <SuggestionItem key={i} suggestion={s} />)}
            </div>
          ) : (
            <p className="no-issues">\u2713 No issues found</p>
          )}
        </div>
      )}
    </Card>
  );
}

// ──────────────────────────── Merge Status View ────────────────────────────

function MergeStatusView({ pr, mergeStatus }: { pr: PullRequest; mergeStatus: MergeStatus }): React.ReactElement {
  const info = MERGE_STATE[mergeStatus.mergeableState] ?? MERGE_STATE.unknown;
  const handleMerge = useCallback(() => {
    vscode.postMessage({ command: 'mergePR', data: { pr } });
  }, [pr]);

  return (
    <div className="page">
      <PRHeader pr={pr} currentView="mergeStatus" />
      <section className="section">
        <SectionHead title="Merge Status" />
        {mergeStatus.merged ? (
          <Card className="merge-banner merge-banner--merged" accent="#3fb950">
            <div className="merge-badge merge-badge--ok">\u2713</div>
            <div>
              <strong>Merged</strong>
              <p className="merge-sub">
                {mergeStatus.mergedBy && <>by <strong>{mergeStatus.mergedBy}</strong></>}
                {mergeStatus.mergedAt && <> on {new Date(mergeStatus.mergedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</>}
              </p>
            </div>
          </Card>
        ) : (
          <Card className={`merge-banner merge-banner--${mergeStatus.mergeableState}`} accent={info.color}>
            <div className="merge-badge" style={{ '--mc': info.color } as React.CSSProperties}>{info.icon}</div>
            <div>
              <strong style={{ color: info.color }}>{info.label}</strong>
              {mergeStatus.mergeableState === 'dirty' && <p className="merge-sub">Resolve conflicts before merging.</p>}
            </div>
          </Card>
        )}
      </section>

      {mergeStatus.statusChecks.length > 0 && (
        <section className="section">
          <SectionHead title="Status Checks" badge={
            <Badge variant={mergeStatus.statusChecks.every(c => c.status === 'success') ? 'success' : 'warning'} size="xs">
              {mergeStatus.statusChecks.filter(c => c.status === 'success').length}/{mergeStatus.statusChecks.length}
            </Badge>
          } />
          <div className="checks">
            {mergeStatus.statusChecks.map((ck, i) => (
              <div key={i} className={`check check--${ck.status}`}>
                <span className={`check-dot check-dot--${ck.status}`}>{CHECK_ICON[ck.status]}</span>
                <span className="check-name">{ck.name}</span>
                {ck.description && <span className="check-desc">{ck.description}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {!mergeStatus.merged && (
        <section className="section">
          <SectionHead title="Merge Options" />
          <div className="merge-options">
            {mergeStatus.allowedMethods.map((m) => (
              <Card key={m} className="merge-opt">
                <strong>{MERGE_METHOD[m].label}</strong>
                <span className="merge-opt-desc">{MERGE_METHOD[m].desc}</span>
              </Card>
            ))}
          </div>
          {mergeStatus.mergeable ? (
            <button className="btn-merge" onClick={handleMerge}>Merge Pull Request</button>
          ) : (
            <Card className="merge-blocked" accent="#f85149">
              <p>Cannot merge. Resolve blocking issues first.</p>
            </Card>
          )}
        </section>
      )}
    </div>
  );
}

// ──────────────────────────── Deep Analysis ────────────────────────────

function MetricsPanel({ metrics }: { metrics: PRMetrics }): React.ReactElement {
  const coverageIcon = metrics.testCoverage === 'excellent' ? '\u2605' : metrics.testCoverage === 'good' ? '\u2713' : metrics.testCoverage === 'partial' ? '\u25d0' : '\u00d7';
  return (
    <section className="section">
      <SectionHead title="Metrics" />
      <div className="stats-row">
        <StatCard value={metrics.totalFilesChanged} label="Files" icon="\u25ce" />
        <StatCard value={`+${metrics.totalAdditions}`} label="Added" color="#3fb950" icon="+" />
        <StatCard value={`\u2212${metrics.totalDeletions}`} label="Removed" color="#f85149" icon="\u2212" />
        <StatCard value={metrics.avgComplexityPerFile.toFixed(1)} label="Complexity" icon="\u25c8" />
        <StatCard value={metrics.testCoverage} label="Tests" icon={coverageIcon} />
      </div>
      {metrics.hotspotFiles.length > 0 && (
        <div className="hotspots">
          <h3 className="sub-title">Hotspot Files</h3>
          <div className="hotspot-chips">{metrics.hotspotFiles.map((f, i) => <code key={i} className="hotspot-chip">{f}</code>)}</div>
        </div>
      )}
    </section>
  );
}

function CategoryCard({ category }: { category: AnalysisCategory }): React.ReactElement {
  const color = SEVERITY_COLOR[category.severity] ?? '#848d97';
  return (
    <Card className="cat-card" accent={color}>
      <div className="cat-head">
        <span className="cat-name">{category.name}</span>
        <Badge variant={category.severity === 'good' ? 'success' : category.severity === 'acceptable' ? 'info' : category.severity === 'critical' ? 'danger' : 'warning'} size="xs">
          {category.severity.replace(/-/g, ' ')}
        </Badge>
      </div>
      <ScoreBar score={category.score} label="" color={color} />
      {category.findings.length > 0 && (
        <ul className="finding-list">
          {category.findings.map((f, i) => <li key={i}>{f}</li>)}
        </ul>
      )}
    </Card>
  );
}

function RecCard({ rec }: { rec: Recommendation }): React.ReactElement {
  const color = rec.priority === 'critical' ? '#f85149' : rec.priority === 'high' ? '#f0883e' : rec.priority === 'medium' ? '#e3b341' : '#58a6ff';
  return (
    <Card className="rec-card" accent={color}>
      <div className="rec-head">
        <span className="rec-title">{rec.title}</span>
        <Badge variant={rec.priority === 'critical' || rec.priority === 'high' ? 'danger' : rec.priority === 'medium' ? 'warning' : 'info'} size="xs">{rec.priority}</Badge>
      </div>
      <p className="rec-desc">{rec.description}</p>
      {rec.filePath && <code className="rec-file">{rec.filePath}{rec.lineRange ? `:${rec.lineRange.start}-${rec.lineRange.end}` : ''}</code>}
    </Card>
  );
}

function DeepAnalysisView({ pr, analysis, riskReports }: {
  pr: PullRequest; analysis: InDepthAnalysis; riskReports: RiskReport[];
}): React.ReactElement {
  return (
    <div className="page">
      <PRHeader pr={pr} currentView="deepAnalysis" />
      <section className="section">
        <div className="hero">
          <div className="hero-left">
            <SectionHead title="In-Depth Analysis" badge={<ModelBadge name={analysis.modelUsed} />} />
            <p className="hero-summary">{analysis.overallSummary}</p>
            <ScoreBar score={analysis.complexityScore} label="Complexity Score" />
          </div>
          <div className="hero-right">
            <GradeCircle grade={analysis.qualityGrade} />
          </div>
        </div>
      </section>

      <MetricsPanel metrics={analysis.metrics} />

      {analysis.categories.length > 0 && (
        <section className="section">
          <SectionHead title="Categories" badge={<Badge variant="muted" size="xs">{analysis.categories.length}</Badge>} />
          <div className="cat-grid">{analysis.categories.map((c, i) => <CategoryCard key={i} category={c} />)}</div>
        </section>
      )}

      {analysis.recommendations.length > 0 && (
        <section className="section">
          <SectionHead title="Recommendations" badge={<Badge variant="muted" size="xs">{analysis.recommendations.length}</Badge>} />
          <div className="rec-list">{analysis.recommendations.map((r, i) => <RecCard key={i} rec={r} />)}</div>
        </section>
      )}

      {riskReports.length > 0 && <RiskTable reports={riskReports} />}
    </div>
  );
}

// ──────────────────────────── Multi-Model ────────────────────────────

function MultiModelView({ pr, modelResults, riskReports }: {
  pr: PullRequest; modelResults: { modelName: string; results: ReviewResult[] }[]; riskReports: RiskReport[];
}): React.ReactElement {
  const [tab, setTab] = useState(0);
  const stats = useMemo(() => modelResults.map((mr) => ({
    name: mr.modelName,
    errors: mr.results.reduce((s, r) => s + r.suggestions.filter(x => x.severity === 'error').length, 0),
    warnings: mr.results.reduce((s, r) => s + r.suggestions.filter(x => x.severity === 'warning').length, 0),
    infos: mr.results.reduce((s, r) => s + r.suggestions.filter(x => x.severity === 'info').length, 0),
    total: mr.results.reduce((s, r) => s + r.suggestions.length, 0),
  })), [modelResults]);

  return (
    <div className="page">
      <PRHeader pr={pr} currentView="multiModel" />
      <section className="section">
        <SectionHead title="Model Comparison" badge={<Badge variant="muted" size="xs">{modelResults.length} models</Badge>} />
        <div className="cmp-row">
          {stats.map((ms) => (
            <Card key={ms.name} className="cmp-card">
              <ModelBadge name={ms.name} />
              <span className="cmp-total">{ms.total} issues</span>
              <div className="cmp-breakdown">
                {ms.errors > 0 && <span className="cmp-item cmp-item--error">{ms.errors} errors</span>}
                {ms.warnings > 0 && <span className="cmp-item cmp-item--warning">{ms.warnings} warnings</span>}
                {ms.infos > 0 && <span className="cmp-item cmp-item--info">{ms.infos} info</span>}
              </div>
            </Card>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="tabs">
          {modelResults.map((mr, i) => (
            <button key={i} className={`tab-btn ${i === tab ? 'tab-btn--active' : ''}`} onClick={() => setTab(i)}>
              {mr.modelName}
            </button>
          ))}
        </div>
        {modelResults[tab] && (() => {
          const grouped = modelResults[tab].results.reduce<Record<string, ReviewResult[]>>((acc, r) => {
            if (!acc[r.filePath]) { acc[r.filePath] = []; }
            acc[r.filePath].push(r);
            return acc;
          }, {});
          return Object.entries(grouped).map(([fp, frs]) => (
            <div key={fp} className="file-group">
              <h3 className="file-group-title">{fp}</h3>
              {frs.map((r) => <ReviewResultCard key={r.chunkId} result={r} />)}
            </div>
          ));
        })()}
      </section>

      {riskReports.length > 0 && <RiskTable reports={riskReports} />}
    </div>
  );
}

// ──────────────────────────── Results View ────────────────────────────

function ResultsView({ pr, results, riskReports }: {
  pr: PullRequest; results: ReviewResult[]; riskReports: RiskReport[];
}): React.ReactElement {
  const grouped = useMemo(() => results.reduce<Record<string, ReviewResult[]>>((acc, r) => {
    if (!acc[r.filePath]) { acc[r.filePath] = []; }
    acc[r.filePath].push(r);
    return acc;
  }, {}), [results]);

  const totals = useMemo(() => ({
    errors: results.reduce((s, r) => s + r.suggestions.filter(x => x.severity === 'error').length, 0),
    warnings: results.reduce((s, r) => s + r.suggestions.filter(x => x.severity === 'warning').length, 0),
    infos: results.reduce((s, r) => s + r.suggestions.filter(x => x.severity === 'info').length, 0),
    files: Object.keys(grouped).length,
  }), [results, grouped]);

  const models = useMemo(() => [...new Set(results.map(r => r.modelUsed).filter(Boolean))], [results]);

  return (
    <div className="page">
      <PRHeader pr={pr} currentView="results" />
      <section className="section">
        <div className="stats-row">
          <StatCard value={totals.files} label="Files" icon="\u25ce" />
          <StatCard value={totals.errors} label="Errors" color="#f85149" icon="\u00d7" />
          <StatCard value={totals.warnings} label="Warnings" color="#e3b341" icon="!" />
          <StatCard value={totals.infos} label="Info" color="#58a6ff" icon="i" />
        </div>
        {models.length > 0 && (
          <div className="models-bar">
            <span>Analyzed with</span>
            {models.map((m, i) => <ModelBadge key={i} name={m!} />)}
          </div>
        )}
      </section>

      {riskReports.length > 0 && <RiskTable reports={riskReports} />}

      <section className="section">
        <SectionHead title="Review Results" badge={<Badge variant="muted" size="xs">{results.length} chunks</Badge>} />
        {Object.entries(grouped).map(([fp, frs]) => (
          <div key={fp} className="file-group">
            <h3 className="file-group-title">{fp}</h3>
            {frs.map((r) => <ReviewResultCard key={r.chunkId} result={r} />)}
          </div>
        ))}
        {results.length === 0 && <EmptyState icon="\u2713" text="No review results yet." />}
      </section>
    </div>
  );
}

// ──────────────────────────── Idle ────────────────────────────

function IdleView(): React.ReactElement {
  return (
    <div className="idle">
      <div className="idle-logo">
        <svg viewBox="0 0 80 80" className="prism-svg">
          <defs>
            <linearGradient id="pg" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#58a6ff" />
              <stop offset="50%" stopColor="#bc8cff" />
              <stop offset="100%" stopColor="#f78166" />
            </linearGradient>
          </defs>
          <polygon points="40,8 72,64 8,64" fill="none" stroke="url(#pg)" strokeWidth="2.5" strokeLinejoin="round" />
          <polygon points="40,20 60,56 20,56" fill="none" stroke="url(#pg)" strokeWidth="1.5" strokeLinejoin="round" opacity="0.4" />
        </svg>
      </div>
      <h2 className="idle-title">PRism</h2>
      <p className="idle-sub">AI-Powered Code Review</p>
      <p className="idle-hint">Select a pull request from the sidebar to begin</p>
      <div className="idle-chips">
        <span className="chip" style={{ '--chip-c': '#58a6ff' } as React.CSSProperties}>AI Review</span>
        <span className="chip" style={{ '--chip-c': '#bc8cff' } as React.CSSProperties}>Deep Analysis</span>
        <span className="chip" style={{ '--chip-c': '#3fb950' } as React.CSSProperties}>Multi-Model</span>
        <span className="chip" style={{ '--chip-c': '#f0883e' } as React.CSSProperties}>Risk Scoring</span>
        <span className="chip" style={{ '--chip-c': '#f78166' } as React.CSSProperties}>Merge Control</span>
      </div>
    </div>
  );
}

// ──────────────────────────── App ────────────────────────────

export function App(): React.ReactElement {
  const [appState, setAppState] = useState<AppState>({ state: 'idle' });

  useEffect(() => {
    const handler = (event: MessageEvent<VSCodeMessage>) => {
      const msg = event.data;
      switch (msg.command) {
        case 'loading':
          setAppState({ state: 'loading', message: msg.data.message }); break;
        case 'error':
          setAppState({ state: 'error', errorMessage: msg.data.message }); break;
        case 'updateResults':
          setAppState({ state: 'results', pr: msg.data.pr, results: msg.data.results, riskReports: msg.data.riskReports }); break;
        case 'updateDeepAnalysis':
          setAppState({ state: 'deepAnalysis', pr: msg.data.pr, analysis: msg.data.analysis, riskReports: msg.data.riskReports }); break;
        case 'updateMultiModelResults':
          setAppState({ state: 'multiModel', pr: msg.data.pr, modelResults: msg.data.modelResults, riskReports: msg.data.riskReports }); break;
        case 'updateMergeStatus':
          setAppState({ state: 'mergeStatus', pr: msg.data.pr, mergeStatus: msg.data.mergeStatus }); break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  switch (appState.state) {
    case 'idle':         return <IdleView />;
    case 'loading':      return <LoadingView message={appState.message} />;
    case 'error':        return <ErrorView message={appState.errorMessage} />;
    case 'results':      return <ResultsView pr={appState.pr} results={appState.results} riskReports={appState.riskReports} />;
    case 'deepAnalysis': return <DeepAnalysisView pr={appState.pr} analysis={appState.analysis} riskReports={appState.riskReports} />;
    case 'multiModel':   return <MultiModelView pr={appState.pr} modelResults={appState.modelResults} riskReports={appState.riskReports} />;
    case 'mergeStatus':  return <MergeStatusView pr={appState.pr} mergeStatus={appState.mergeStatus} />;
  }
}
