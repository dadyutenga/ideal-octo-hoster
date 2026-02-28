import * as vscode from 'vscode';
import { GitHubAdapter } from './adapters/githubAdapter';
import { DiffEngine } from './core/diffEngine';
import { RiskAnalyzer } from './core/riskAnalyzer';
import { ReviewEngine } from './core/reviewEngine';
import { CopilotService } from './integrations/copilot';
import { PRTreeProvider, PRTreeItem } from './providers/prTreeProvider';
import { ReviewResultsPanel } from './providers/reviewResultsPanel';
import { ReviewMode, PullRequest, MergeMethod } from './types';

/** Extract PullRequest from a tree item or raw PR data */
function extractPR(arg: unknown): PullRequest | undefined {
  if (!arg) { return undefined; }
  if (arg instanceof PRTreeItem) { return arg.pr; }
  if (typeof arg === 'object' && 'number' in (arg as Record<string, unknown>)) {
    return arg as PullRequest;
  }
  return undefined;
}

export function activate(context: vscode.ExtensionContext): void {
  // --- Dependency Injection ---
  const github = new GitHubAdapter();
  const diffEngine = new DiffEngine();
  const riskAnalyzer = new RiskAnalyzer();
  const copilot = new CopilotService();
  const reviewEngine = new ReviewEngine(copilot);

  // --- Tree View ---
  const prTreeProvider = new PRTreeProvider(github);
  const treeView = vscode.window.createTreeView('prismPRList', {
    treeDataProvider: prTreeProvider,
    showCollapseAll: false,
  });

  // --- Command: Open PR List ---
  const openPRList = vscode.commands.registerCommand('prism.openPRList', async () => {
    prTreeProvider.refresh();
    await vscode.commands.executeCommand('prismPRList.focus');
  });

  // --- Command: Review PR ---
  const reviewPR = vscode.commands.registerCommand('prism.reviewPR', async (arg?: unknown) => {
    const pr = extractPR(arg);
    if (!pr) {
      vscode.window.showErrorMessage('PRism: No PR selected. Please select a PR from the PRism panel.');
      return;
    }
    const panel = ReviewResultsPanel.createOrShow(context.extensionUri);
    panel.showLoading(`Analyzing PR #${pr.number}: ${pr.title}…`);

    try {
      const config = vscode.workspace.getConfiguration('prism');
      const mode = (config.get<string>('reviewMode') ?? 'general') as ReviewMode;

      const changedFiles = await github.getChangedFiles(pr.number);
      const allChunks = [];
      const allResults = [];

      for (const file of changedFiles) {
        panel.showLoading(`Fetching diff for ${file.filePath}…`);
        const diff = await github.getDiff(pr.number, file.filePath);
        const chunks = diffEngine.parse(diff);
        allChunks.push(...chunks);

        for (const chunk of chunks) {
          panel.showLoading(`Reviewing ${file.filePath} (${chunk.startLine}–${chunk.endLine})…`);
          const result = await reviewEngine.reviewChunk(chunk, mode);
          allResults.push(result);
          // Avoid overwhelming Copilot
          await sleep(300);
        }
      }

      const riskReports = riskAnalyzer.analyze(allChunks);
      panel.updateResults(pr, allResults, riskReports);
    } catch (err) {
      panel.showError((err as Error).message);
      vscode.window.showErrorMessage(`PRism: Review failed — ${(err as Error).message}`);
    }
  });

  // --- Command: Review Single File ---
  const reviewFile = vscode.commands.registerCommand('prism.reviewFile', async () => {
    const prInput = await vscode.window.showInputBox({
      prompt: 'Enter PR number',
      placeHolder: '42',
    });
    if (!prInput) {
      return;
    }
    const prNumber = parseInt(prInput, 10);
    if (isNaN(prNumber)) {
      vscode.window.showErrorMessage('PRism: Invalid PR number.');
      return;
    }

    const files = await github.getChangedFiles(prNumber);
    const fileItems = files.map((f) => ({ label: f.filePath, description: f.status }));
    const selected = await vscode.window.showQuickPick(fileItems, { placeHolder: 'Select file to review' });
    if (!selected) {
      return;
    }

    const config = vscode.workspace.getConfiguration('prism');
    const mode = (config.get<string>('reviewMode') ?? 'general') as ReviewMode;

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `PRism: Reviewing ${selected.label}…`, cancellable: false },
      async () => {
        const diff = await github.getDiff(prNumber, selected.label);
        const chunks = diffEngine.parse(diff);
        const panel = ReviewResultsPanel.createOrShow(context.extensionUri);
        const results = [];
        for (const chunk of chunks) {
          const result = await reviewEngine.reviewChunk(chunk, mode);
          results.push(result);
        }
        const riskReports = riskAnalyzer.analyze(chunks);
        const prData: PullRequest = {
          number: prNumber,
          title: `File Review: ${selected.label}`,
          author: '',
          url: '',
          headBranch: '',
          baseBranch: '',
          changedFilesCount: 1,
          createdAt: new Date().toISOString(),
        };
        panel.updateResults(prData, results, riskReports);
      }
    );
  });

  // --- Command: Generate Summary ---
  const generateSummary = vscode.commands.registerCommand('prism.generateSummary', async (arg?: unknown) => {
    const prFromTree = extractPR(arg);
    let prNumber: number;
    if (prFromTree) {
      prNumber = prFromTree.number;
    } else {
      const prInput = await vscode.window.showInputBox({ prompt: 'Enter PR number to summarize', placeHolder: '42' });
      if (!prInput) {
        return;
      }
      prNumber = parseInt(prInput, 10);
      if (isNaN(prNumber)) {
        vscode.window.showErrorMessage('PRism: Invalid PR number.');
        return;
      }
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `PRism: Generating summary for PR #${prNumber}…`, cancellable: false },
      async () => {
        const files = await github.getChangedFiles(prNumber);
        const allDiffs: string[] = [];
        for (const file of files.slice(0, 10)) {
          const diff = await github.getDiff(prNumber, file.filePath);
          allDiffs.push(`### ${file.filePath}\n${diff.slice(0, 800)}`);
        }
        const prompt = `You are a senior software engineer. Generate a concise structured pull request review summary.

## Changed Files
${allDiffs.join('\n\n')}

Provide:
1. A 2-3 sentence summary of what this PR does
2. Key risks or concerns
3. Recommended review focus areas

Format as markdown.`;

        const summary = await copilot.ask(prompt);
        const doc = await vscode.workspace.openTextDocument({ content: summary, language: 'markdown' });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      }
    );
  });

  // --- Command: Show Risk Analysis ---
  const showRiskAnalysis = vscode.commands.registerCommand('prism.showRiskAnalysis', async (arg?: unknown) => {
    const prFromTree = extractPR(arg);
    let prNumber: number;
    if (prFromTree) {
      prNumber = prFromTree.number;
    } else {
      const prInput = await vscode.window.showInputBox({ prompt: 'Enter PR number for risk analysis', placeHolder: '42' });
      if (!prInput) {
        return;
      }
      prNumber = parseInt(prInput, 10);
      if (isNaN(prNumber)) {
        vscode.window.showErrorMessage('PRism: Invalid PR number.');
        return;
      }
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `PRism: Analyzing risk for PR #${prNumber}…`, cancellable: false },
      async () => {
        const files = await github.getChangedFiles(prNumber);
        const allChunks = [];
        for (const file of files) {
          const diff = await github.getDiff(prNumber, file.filePath);
          const chunks = diffEngine.parse(diff);
          allChunks.push(...chunks);
        }
        const riskReports = riskAnalyzer.analyze(allChunks);
        const riskLines = riskReports.map(
          (r) => `| ${r.filePath} | ${r.level.toUpperCase()} | ${r.score}/100 | ${r.reasons.join('; ')} |`
        );
        const content = `# Risk Analysis — PR #${prNumber}\n\n| File | Level | Score | Reasons |\n|------|-------|-------|--------|\n${riskLines.join('\n')}`;
        const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      }
    );
  });

  // --- Command: Apply Suggestion ---
  const applySuggestion = vscode.commands.registerCommand('prism.applySuggestion', async (patch?: string) => {
    if (!patch) {
      vscode.window.showInformationMessage('PRism: No patch to apply.');
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('PRism: No active editor to apply patch to.');
      return;
    }
    await editor.edit((editBuilder) => {
      editBuilder.replace(editor.selection, patch);
    });
    vscode.window.showInformationMessage('PRism: Suggestion applied.');
  });

  // --- Command: Select Model ---
  const selectModel = vscode.commands.registerCommand('prism.selectModel', async () => {
    const models = await copilot.listModels();
    if (models.length === 0) {
      vscode.window.showErrorMessage('PRism: No Copilot models available. Ensure GitHub Copilot is installed and active.');
      return;
    }
    const items = models.map((m) => ({
      label: m.name,
      description: `${m.family} · ${m.vendor}`,
      detail: `Max tokens: ${m.maxInputTokens.toLocaleString()} · ID: ${m.id}`,
      modelId: m.id,
    }));

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select AI model for reviews (Claude, GPT-4, Gemini, etc.)',
      title: 'PRism: Model Selection',
    });
    if (selected) {
      await vscode.workspace.getConfiguration('prism').update('copilotModelId', selected.modelId, true);
      vscode.window.showInformationMessage(`PRism: Now using ${selected.label}`);
    }
  });

  // --- Command: In-Depth Analysis ---
  const deepAnalysis = vscode.commands.registerCommand('prism.deepAnalysis', async (arg?: unknown) => {
    let prNumber: number;
    let prData: PullRequest;
    const prFromTree = extractPR(arg);

    if (prFromTree) {
      prNumber = prFromTree.number;
      prData = prFromTree;
    } else {
      const prInput = await vscode.window.showInputBox({
        prompt: 'Enter PR number for in-depth analysis',
        placeHolder: '42',
      });
      if (!prInput) { return; }
      prNumber = parseInt(prInput, 10);
      if (isNaN(prNumber)) {
        vscode.window.showErrorMessage('PRism: Invalid PR number.');
        return;
      }
      prData = {
        number: prNumber,
        title: `In-Depth Analysis: PR #${prNumber}`,
        author: '',
        url: '',
        headBranch: '',
        baseBranch: '',
        changedFilesCount: 0,
        createdAt: new Date().toISOString(),
      };
    }

    const panel = ReviewResultsPanel.createOrShow(context.extensionUri);
    panel.showLoading(`Running in-depth analysis on PR #${prNumber}…`);

    try {
      const config = vscode.workspace.getConfiguration('prism');
      const mode = (config.get<string>('reviewMode') ?? 'general') as ReviewMode;

      const changedFiles = await github.getChangedFiles(prNumber);
      prData.changedFilesCount = changedFiles.length;

      const allChunks = [];
      for (const file of changedFiles) {
        panel.showLoading(`Parsing ${file.filePath}…`);
        const diff = await github.getDiff(prNumber, file.filePath);
        const chunks = diffEngine.parse(diff);
        allChunks.push(...chunks);
      }

      panel.showLoading('Running deep AI analysis — this may take a moment…');
      const analysis = await reviewEngine.deepAnalyze(prNumber, allChunks, changedFiles, mode);

      const riskReports = riskAnalyzer.analyze(allChunks);
      panel.updateDeepAnalysis(prData, analysis, riskReports);
    } catch (err) {
      panel.showError((err as Error).message);
    }
  });

  // --- Command: Multi-Model Review ---
  const multiModelReview = vscode.commands.registerCommand('prism.multiModelReview', async (arg?: unknown) => {
    let prNumber: number;
    let prData: PullRequest;
    const prFromTree = extractPR(arg);

    if (prFromTree) {
      prNumber = prFromTree.number;
      prData = prFromTree;
    } else {
      const prInput = await vscode.window.showInputBox({
        prompt: 'Enter PR number for multi-model review',
        placeHolder: '42',
      });
      if (!prInput) { return; }
      prNumber = parseInt(prInput, 10);
      if (isNaN(prNumber)) {
        vscode.window.showErrorMessage('PRism: Invalid PR number.');
        return;
      }
      prData = {
        number: prNumber,
        title: `Multi-Model Review: PR #${prNumber}`,
        author: '',
        url: '',
        headBranch: '',
        baseBranch: '',
        changedFilesCount: 0,
        createdAt: new Date().toISOString(),
      };
    }

    const models = await copilot.listModels();
    if (models.length < 2) {
      vscode.window.showWarningMessage('PRism: Need at least 2 models for comparative review. Only 1 available.');
    }

    const modelItems = models.map((m) => ({
      label: m.name,
      description: m.family,
      picked: true,
      modelId: m.id,
    }));

    const selectedModels = await vscode.window.showQuickPick(modelItems, {
      placeHolder: 'Select models to compare (pick 2+)',
      title: 'PRism: Multi-Model Comparative Review',
      canPickMany: true,
    });

    if (!selectedModels || selectedModels.length === 0) { return; }

    const panel = ReviewResultsPanel.createOrShow(context.extensionUri);
    panel.showLoading(`Starting multi-model review on PR #${prNumber}…`);

    try {
      const config = vscode.workspace.getConfiguration('prism');
      const mode = (config.get<string>('reviewMode') ?? 'general') as ReviewMode;

      const changedFiles = await github.getChangedFiles(prNumber);
      prData.changedFilesCount = changedFiles.length;

      const allChunks = [];
      for (const file of changedFiles) {
        panel.showLoading(`Fetching diff for ${file.filePath}…`);
        const diff = await github.getDiff(prNumber, file.filePath);
        const chunks = diffEngine.parse(diff);
        allChunks.push(...chunks);
      }

      const riskReports = riskAnalyzer.analyze(allChunks);
      const modelResults: { modelName: string; results: import('./types').ReviewResult[] }[] = [];

      for (const model of selectedModels) {
        panel.showLoading(`Reviewing with ${model.label}…`);
        const results = [];
        for (const chunk of allChunks) {
          const result = await reviewEngine.reviewChunk(chunk, mode, model.modelId);
          results.push(result);
          await sleep(300);
        }
        modelResults.push({ modelName: model.label, results });
      }

      panel.updateMultiModelResults(prData, modelResults, riskReports);
    } catch (err) {
      panel.showError((err as Error).message);
    }
  });

  // --- Command: List Models ---
  const listModels = vscode.commands.registerCommand('prism.listModels', async () => {
    const models = await copilot.listModels();
    if (models.length === 0) {
      vscode.window.showInformationMessage('PRism: No Copilot models found.');
      return;
    }
    const activeModel = await copilot.getActiveModel();
    const lines = models.map(
      (m) => `| ${m.name} | ${m.family} | ${m.maxInputTokens.toLocaleString()} | ${m.id === activeModel?.id ? '✅ Active' : ''} |`
    );
    const content = `# Available AI Models\n\n| Model | Family | Max Tokens | Status |\n|-------|--------|------------|--------|\n${lines.join('\n')}`;
    const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
  });

  // --- Command: Check Merge Status ---
  const checkMergeStatus = vscode.commands.registerCommand('prism.checkMergeStatus', async (arg?: unknown) => {
    const pr = extractPR(arg);
    if (!pr) {
      vscode.window.showErrorMessage('PRism: No PR selected.');
      return;
    }

    const panel = ReviewResultsPanel.createOrShow(context.extensionUri);
    panel.showLoading(`Checking merge status for PR #${pr.number}…`);

    try {
      const status = await github.getMergeStatus(pr.number);
      panel.updateMergeStatus(pr, status);
    } catch (err) {
      panel.showError((err as Error).message);
    }
  });

  // --- Command: Merge PR ---
  const mergePR = vscode.commands.registerCommand('prism.mergePR', async (arg?: unknown) => {
    const pr = extractPR(arg);
    if (!pr) {
      vscode.window.showErrorMessage('PRism: No PR selected.');
      return;
    }

    // First check merge status
    const status = await github.getMergeStatus(pr.number);

    if (status.merged) {
      vscode.window.showInformationMessage(`PR #${pr.number} is already merged.`);
      return;
    }

    if (!status.mergeable) {
      const conflictAction = await vscode.window.showWarningMessage(
        `PR #${pr.number} has conflicts and cannot be merged.`,
        'View Status'
      );
      if (conflictAction === 'View Status') {
        const panel = ReviewResultsPanel.createOrShow(context.extensionUri);
        panel.updateMergeStatus(pr, status);
      }
      return;
    }

    // Pick merge method
    const methodItems: { label: string; description: string; method: MergeMethod }[] = [];
    if (status.allowedMethods.includes('merge')) {
      methodItems.push({ label: '$(git-merge) Merge Commit', description: 'Create a merge commit', method: 'merge' });
    }
    if (status.allowedMethods.includes('squash')) {
      methodItems.push({ label: '$(fold) Squash and Merge', description: 'Squash all commits into one', method: 'squash' });
    }
    if (status.allowedMethods.includes('rebase')) {
      methodItems.push({ label: '$(git-commit) Rebase and Merge', description: 'Rebase commits onto base branch', method: 'rebase' });
    }

    if (methodItems.length === 0) {
      vscode.window.showErrorMessage('PRism: No merge methods available for this repository.');
      return;
    }

    const selected = await vscode.window.showQuickPick(methodItems, {
      placeHolder: 'Select merge method',
      title: `PRism: Merge PR #${pr.number}`,
    });
    if (!selected) { return; }

    // Optional commit title for squash
    let commitTitle: string | undefined;
    if (selected.method === 'squash') {
      commitTitle = await vscode.window.showInputBox({
        prompt: 'Squash commit title (leave empty for default)',
        value: `${pr.title} (#${pr.number})`,
      });
      if (commitTitle === undefined) { return; } // Cancelled
    }

    // Confirm merge
    const confirm = await vscode.window.showWarningMessage(
      `Merge PR #${pr.number} "${pr.title}" using ${selected.method}?`,
      { modal: true },
      'Merge'
    );
    if (confirm !== 'Merge') { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `PRism: Merging PR #${pr.number}…`, cancellable: false },
      async () => {
        const result = await github.mergePR(pr.number, selected.method, commitTitle || undefined);
        if (result.success) {
          vscode.window.showInformationMessage(`PRism: PR #${pr.number} merged successfully! SHA: ${result.sha}`);
          prTreeProvider.refresh();
          const panel = ReviewResultsPanel.createOrShow(context.extensionUri);
          const updatedStatus = await github.getMergeStatus(pr.number);
          panel.updateMergeStatus(pr, updatedStatus);
        } else {
          vscode.window.showErrorMessage(`PRism: Merge failed — ${result.message}`);
        }
      }
    );
  });

  context.subscriptions.push(
    treeView,
    openPRList,
    reviewPR,
    reviewFile,
    generateSummary,
    showRiskAnalysis,
    applySuggestion,
    selectModel,
    deepAnalysis,
    multiModelReview,
    listModels,
    checkMergeStatus,
    mergePR
  );
}

export function deactivate(): void {
  // Cleanup handled via disposables
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
