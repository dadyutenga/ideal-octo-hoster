# PRism — AI-Assisted Pull Request Review for VS Code

> Code review powered by **your own GitHub Copilot subscription** — no API keys, no external services.

[![VS Code Engine](https://img.shields.io/badge/VS%20Code-%5E1.90.0-blue)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB)](https://react.dev/)

---

## Features

- 🔍 **PR List Sidebar** — Browse all open pull requests for your repository directly in VS Code
- 🤖 **AI-Powered Review** — Uses GitHub Copilot (via VS Code's Language Model API) to review diff chunks
- 🛡️ **Risk Analysis** — Static heuristic scoring to surface high-risk files before you start reviewing
- 📋 **Multiple Review Modes** — Security, Performance, Clean Code, Architecture, Test Coverage, or General
- 📝 **PR Summary Generation** — One-click AI-generated structured summaries of any pull request
- ✏️ **Apply Suggestions** — Directly apply Copilot's suggested patches to your active editor
- 🔒 **Zero External API Calls** — All AI inference routes through your existing Copilot subscription

---

## Requirements

- **VS Code** `^1.90.0`
- **GitHub Copilot extension** installed and signed in with an active subscription
- **GitHub Pull Requests and Issues extension** (`GitHub.vscode-pull-request-github`)
- A workspace containing a GitHub repository

---

## Getting Started

### Installation

Install from the VS Code Marketplace (once published), or build from source:

```bash
git clone https://github.com/prism-dev/prism
cd prism
npm install
npm run build
npm run build:webview
npm run package
# Install the generated .vsix file in VS Code
```

### First Use

1. Open a GitHub repository in VS Code
2. Sign in to GitHub Copilot if prompted
3. Click the **PRism** icon in the Activity Bar (pull request icon)
4. The sidebar shows all open PRs — click any PR to start an AI review

---

## Commands

| Command | Description |
|---------|-------------|
| `PRism: Open Pull Request List` | Refresh and focus the PR sidebar |
| `PRism: Review Pull Request` | Run a full AI review on a selected PR |
| `PRism: Review Single File` | Review one specific file from a PR |
| `PRism: Generate PR Summary` | Generate a structured markdown summary |
| `PRism: Show Risk Analysis` | Show a risk-scored table of all changed files |
| `PRism: Apply Suggestion` | Apply a Copilot suggestion patch to the active editor |

---

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `prism.reviewMode` | enum | `general` | Review focus: `security`, `performance`, `clean-code`, `architecture`, `test-coverage`, `general` |
| `prism.autoReview` | boolean | `false` | Automatically trigger review when a PR is opened |
| `prism.maxChunkSize` | number | `100` | Maximum lines per diff chunk sent to Copilot |

---

## Architecture

PRism is structured around clean interfaces and dependency injection:

```
extension.ts  →  GitHubAdapter (Octokit + VS Code auth)
             →  DiffEngine    (unified diff parser)
             →  RiskAnalyzer  (static heuristics)
             →  ReviewEngine  →  CopilotService (vscode.lm API)
             →  PRTreeProvider  (sidebar)
             →  ReviewResultsPanel  (webview)
                    └─ React UI (webview/src/)
```

See [`docs/architecture.md`](./docs/architecture.md) for the full architecture documentation.

---

## How Copilot Integration Works

PRism uses VS Code's official **Language Model API** (`vscode.lm`) — the same API used by VS Code's built-in Copilot features:

```typescript
const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o' });
const response = await models[0].sendRequest(messages, {}, cancellationToken);
```

This means:
- ✅ Uses **your existing Copilot subscription** — no additional cost
- ✅ **No API keys** are stored or required
- ✅ All requests are authenticated and routed by VS Code itself
- ✅ Complies with your organization's Copilot policy settings

---

## Development

```bash
# Install dependencies
npm install

# Build extension bundle
npm run build

# Build webview React bundle
npm run build:webview

# Watch mode for extension
npm run watch

# Lint
npm run lint

# Package as .vsix
npm run package
```

### Project Structure

```
prism/
├── src/
│   ├── extension.ts              # Entry point
│   ├── types/index.ts            # Shared interfaces
│   ├── adapters/githubAdapter.ts # GitHub API client
│   ├── core/
│   │   ├── diffEngine.ts         # Diff parser
│   │   ├── riskAnalyzer.ts       # Risk scoring
│   │   └── reviewEngine.ts       # AI review orchestration
│   ├── integrations/copilot.ts   # VS Code LM API wrapper
│   └── providers/
│       ├── prTreeProvider.ts     # Sidebar tree view
│       └── reviewResultsPanel.ts # Webview panel
├── webview/
│   ├── src/
│   │   ├── index.tsx             # React entry
│   │   ├── App.tsx               # Main UI component
│   │   └── styles/main.css       # VS Code-themed CSS
│   └── tsconfig.json
├── docs/architecture.md
├── webpack.config.js             # Extension bundle config
├── webpack.webview.config.js     # Webview bundle config
└── tsconfig.json
```

---

## License

MIT — see [LICENSE](./LICENSE)

