import * as vscode from 'vscode';
import { ReviewResult, RiskReport, PullRequest, InDepthAnalysis } from '../types';

export class ReviewResultsPanel {
  public static currentPanel: ReviewResultsPanel | undefined;
  private static readonly viewType = 'prismReview';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];

  public static createOrShow(extensionUri: vscode.Uri): ReviewResultsPanel {
    const column = vscode.ViewColumn.Beside;
    if (ReviewResultsPanel.currentPanel) {
      ReviewResultsPanel.currentPanel._panel.reveal(column);
      return ReviewResultsPanel.currentPanel;
    }
    const panel = vscode.window.createWebviewPanel(
      ReviewResultsPanel.viewType,
      'PRism Review',
      column,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
      }
    );
    ReviewResultsPanel.currentPanel = new ReviewResultsPanel(panel, extensionUri);
    return ReviewResultsPanel.currentPanel;
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._update();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    this._panel.webview.onDidReceiveMessage(
      (message: { command: string; data?: { pr?: PullRequest } }) => {
        switch (message.command) {
          case 'refresh':
            this._update();
            break;
          case 'runReview':
            if (message.data?.pr) {
              vscode.commands.executeCommand('prism.reviewPR', message.data.pr);
            }
            break;
          case 'runDeepAnalysis':
            if (message.data?.pr) {
              vscode.commands.executeCommand('prism.deepAnalysis', message.data.pr);
            }
            break;
          case 'runMultiModel':
            if (message.data?.pr) {
              vscode.commands.executeCommand('prism.multiModelReview', message.data.pr);
            }
            break;
          case 'runSummary':
            if (message.data?.pr) {
              vscode.commands.executeCommand('prism.generateSummary', message.data.pr);
            }
            break;
          case 'runRiskAnalysis':
            if (message.data?.pr) {
              vscode.commands.executeCommand('prism.showRiskAnalysis', message.data.pr);
            }
            break;
          case 'selectModel':
            vscode.commands.executeCommand('prism.selectModel');
            break;
        }
      },
      null,
      this._disposables
    );
  }

  public updateResults(pr: PullRequest, results: ReviewResult[], riskReports: RiskReport[]): void {
    this._panel.title = `PRism: PR #${pr.number}`;
    this._panel.webview.postMessage({
      command: 'updateResults',
      data: { pr, results, riskReports },
    });
  }

  public updateDeepAnalysis(pr: PullRequest, analysis: InDepthAnalysis, riskReports: RiskReport[]): void {
    this._panel.title = `PRism: Deep Analysis PR #${pr.number}`;
    this._panel.webview.postMessage({
      command: 'updateDeepAnalysis',
      data: { pr, analysis, riskReports },
    });
  }

  public updateMultiModelResults(
    pr: PullRequest,
    modelResults: { modelName: string; results: ReviewResult[] }[],
    riskReports: RiskReport[]
  ): void {
    this._panel.title = `PRism: Multi-Model PR #${pr.number}`;
    this._panel.webview.postMessage({
      command: 'updateMultiModelResults',
      data: { pr, modelResults, riskReports },
    });
  }

  public showLoading(message: string): void {
    this._panel.webview.postMessage({ command: 'loading', data: { message } });
  }

  public showError(message: string): void {
    this._panel.webview.postMessage({ command: 'error', data: { message } });
  }

  private _update(): void {
    this._panel.webview.html = this._getHtmlForWebview();
  }

  private _getHtmlForWebview(): string {
    const webview = this._panel.webview;
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'index.js')
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource} 'unsafe-inline';">
  <title>PRism Review</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    ReviewResultsPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const d = this._disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
