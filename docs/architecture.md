# PRism Architecture

## System Overview

PRism is a VS Code extension that integrates AI-powered pull request review directly into the developer's editor. It leverages GitHub Copilot (via VS Code's Language Model API) to analyze code diffs and provide actionable suggestions, without requiring any external API keys.

```
VS Code Extension Host
├── extension.ts          ← Activation, command registration, DI wiring
├── adapters/
│   └── githubAdapter.ts  ← GitHub REST API via @octokit/rest + VS Code auth
├── core/
│   ├── diffEngine.ts     ← Unified diff parser → DiffChunk[]
│   ├── riskAnalyzer.ts   ← Static heuristic risk scoring
│   └── reviewEngine.ts   ← Copilot prompt builder + response parser
├── integrations/
│   └── copilot.ts        ← VS Code LM API wrapper (vscode.lm)
├── providers/
│   ├── prTreeProvider.ts ← Sidebar TreeDataProvider
│   └── reviewResultsPanel.ts ← WebviewPanel for review output
└── types/index.ts        ← Shared TypeScript interfaces

Webview (React, bundled separately)
└── webview/src/
    ├── index.tsx         ← React root mount
    ├── App.tsx           ← Main UI: idle/loading/error/results states
    └── styles/main.css   ← VS Code CSS variable-based theming
```

---

## Module Descriptions

### `extension.ts`
The main entry point activated via `onView:prismPRList` or `onCommand:prism.openPRList`. Wires all services together via constructor injection and registers six commands: `openPRList`, `reviewPR`, `reviewFile`, `generateSummary`, `showRiskAnalysis`, and `applySuggestion`.

### `adapters/githubAdapter.ts`
Implements `IGitHubAdapter`. Uses `vscode.authentication.getSession('github', ['repo'])` to obtain an OAuth token, then instantiates `@octokit/rest` with that token. Auto-detects the repository owner/name from the workspace's git remote origin URL via the built-in `vscode.git` extension API.

**Key methods:**
- `listOpenPRs()` — fetches open PRs (up to 50)
- `getChangedFiles(prNumber)` — lists files changed in a PR
- `getDiff(prNumber, filePath)` — fetches full PR diff and extracts the per-file portion
- `submitReviewComment(...)` — posts inline review comments to GitHub

### `core/diffEngine.ts`
Parses unified diff strings (as returned by GitHub's API) into structured `DiffChunk` objects. Each chunk includes file path, change type (addition/deletion/modification), line range, content, and metadata flags (contains function definition, import change, auth-related keywords).

### `core/riskAnalyzer.ts`
A purely static (no AI) heuristic engine that scores each changed file on a 0–100 risk scale based on:
- File path patterns (auth directories, credentials, middleware, dependency files, migrations)
- Content patterns (auth keywords, large deletions, import changes, function density)

Outputs `RiskReport[]` sorted by score descending.

### `core/reviewEngine.ts`
Orchestrates AI review. For each `DiffChunk`, constructs a mode-specific prompt (one of: security, performance, clean-code, architecture, test-coverage, general), sends it to Copilot, and parses the JSON response into `ReviewResult`. Handles malformed responses with a graceful fallback.

### `integrations/copilot.ts`
Wraps `vscode.lm.selectChatModels` and `model.sendRequest` to interact with Copilot using the user's own subscription. No API keys stored or required.

### `providers/prTreeProvider.ts`
Implements `vscode.TreeDataProvider<PRTreeItem>` for the sidebar PR list. Each `PRTreeItem` triggers `prism.reviewPR` on click.

### `providers/reviewResultsPanel.ts`
Manages the `WebviewPanel` that renders the React UI. Communicates with the webview via `postMessage` (loading state, error state, full results). Uses a nonce-based Content Security Policy.

---

## Data Flow

```
User clicks PR in sidebar
        │
        ▼
prism.reviewPR command
        │
        ▼
GitHubAdapter.getChangedFiles(prNumber)
        │
        ▼
For each file:
  GitHubAdapter.getDiff(prNumber, filePath)
        │
        ▼
  DiffEngine.parse(diff) → DiffChunk[]
        │
        ▼
  For each chunk:
    ReviewEngine.reviewChunk(chunk, mode)
      │
      ▼
    CopilotService.ask(prompt)   ← vscode.lm API
      │
      ▼
    Parse JSON → ReviewResult
        │
        ▼
RiskAnalyzer.analyze(allChunks) → RiskReport[]
        │
        ▼
ReviewResultsPanel.updateResults(pr, results, riskReports)
        │
        ▼
React Webview renders results
```

---

## Security Model

1. **No external API keys.** All AI calls go through `vscode.lm`, which routes through the user's own GitHub Copilot subscription managed by VS Code.
2. **GitHub authentication** uses VS Code's built-in `vscode.authentication` provider for the `github` provider with the `repo` scope — the user is prompted by VS Code's standard OAuth flow.
3. **Webview CSP** enforces `default-src 'none'` with nonce-restricted script execution and no inline script injection. All webview resources are loaded from the extension's `dist/webview/` directory.
4. **No data exfiltration.** Code diffs are sent only to the Copilot LM API (via VS Code internals) and to the authenticated GitHub account's own API. No third-party services are contacted.

---

## Copilot Integration

PRism uses the [VS Code Language Model API](https://code.visualstudio.com/api/extension-guides/language-model) introduced in VS Code 1.90:

```typescript
// Select the user's Copilot model
const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
const model = models[0];

// Send a prompt
const response = await model.sendRequest(
  [vscode.LanguageModelChatMessage.User(prompt)],
  {},
  cancellationToken
);

// Stream the response
for await (const chunk of response.text) {
  fullText += chunk;
}
```

This means:
- Users must have an active GitHub Copilot subscription.
- The GitHub Copilot extension must be installed and signed in.
- PRism itself never handles, stores, or transmits any AI credentials.
