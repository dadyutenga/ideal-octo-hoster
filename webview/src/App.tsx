import React, { useEffect, useState } from 'react';

interface ReviewSuggestion {
  line: number;
  severity: 'info' | 'warning' | 'error';
  message: string;
  patch?: string;
}

interface ReviewResult {
  chunkId: string;
  filePath: string;
  mode: string;
  suggestions: ReviewSuggestion[];
  summary: string;
  riskLevel: 'low' | 'medium' | 'high';
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

type AppState =
  | { state: 'idle' }
  | { state: 'loading'; message: string }
  | { state: 'error'; errorMessage: string }
  | { state: 'results'; pr: PullRequest; results: ReviewResult[]; riskReports: RiskReport[] };

type VSCodeMessage =
  | { command: 'loading'; data: { message: string } }
  | { command: 'error'; data: { message: string } }
  | { command: 'updateResults'; data: { pr: PullRequest; results: ReviewResult[]; riskReports: RiskReport[] } }
  | { command: 'refresh' };

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
        <RiskBadge level={result.riskLevel} />
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

  return (
    <div className="results-container">
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
      </header>

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
  }
}
