1. System Overview
Product Name (Working): PRism

A VS Code extension that enhances Pull Request reviews by:

Fetching PR diffs from GitHub

Structuring and chunking changes

Leveraging GitHub Copilot for AI-assisted review

Providing risk scoring and patch suggestions

Keeping the entire workflow inside VS Code

AI execution is fully delegated to GitHub Copilot.

No external AI APIs.
No local LLM.
No additional infrastructure.

2. High-Level Architecture
┌─────────────────────────────┐
│         VS Code             │
│  PRism Extension Host       │
└──────────────┬──────────────┘
               │
               ▼
 ┌─────────────────────────────┐
 │       Extension Core        │
 │                             │
 │  - GitHub Adapter           │
 │  - Diff Engine              │
 │  - Review Engine            │
 │  - Risk Analyzer            │
 │  - Copilot Interface        │
 └──────────────┬──────────────┘
               │
      ┌────────┴────────┐
      ▼                 ▼
 GitHub API        GitHub Copilot
 (PR data)          (AI analysis)

3. Core Modules
3.1 Extension Entry Layer

File:

src/extension.ts


Responsibilities:

Activation lifecycle

Register commands

Register tree views

Initialize services

Manage disposables

3.2 GitHub Adapter

File:

src/adapters/githubAdapter.ts


Responsibilities:

Fetch open PRs

Fetch changed files

Fetch unified diffs

Post review comments

Handle authentication via GitHub extension APIs

Integration Strategy:
Use the official GitHub Pull Requests extension APIs instead of manual REST calls where possible.

3.3 Diff Engine

File:

src/core/diffEngine.ts


Responsibilities:

Parse unified diffs

Chunk changes logically

Detect:

New functions

Modified blocks

Deleted logic

Dependency changes

Output Model:

interface DiffChunk {
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

3.4 Risk Analyzer

File:

src/core/riskAnalyzer.ts


Responsibilities:

Assign risk scores per file

Identify high-risk changes

Risk Factors:

Files under /auth/

Changes in middleware

Dependency updates

Large deletions

Schema modifications

Output:

interface RiskReport {
  filePath: string;
  score: number; // 0-100
  level: 'low' | 'medium' | 'high';
  reasons: string[];
}

3.5 Review Engine

File:

src/core/reviewEngine.ts


Responsibilities:

Build structured prompts

Apply review mode templates

Limit context size

Format Copilot response

Review Modes:

type ReviewMode =
  | 'security'
  | 'performance'
  | 'clean-code'
  | 'architecture'
  | 'test-coverage'
  | 'general';


Prompt Builder Example:

function buildPrompt(mode: ReviewMode, chunk: DiffChunk): string

3.6 Copilot Interface

File:

src/integrations/copilot.ts


Responsibilities:

Send prompts via Copilot Chat API

Capture structured output

Handle fallback if Copilot unavailable

Important:
No direct API key usage.
Must rely on official VS Code Copilot integration APIs.

3.7 Webview UI Layer

Folder:

webview/


Responsibilities:

Display PR list

Show file tree

Render risk badges

Show AI suggestions

Allow patch preview

Tech Stack:

React (recommended)

Webview messaging bridge

State management via Context or lightweight store

4. Extension API Layer Design

We design internal service interfaces to keep architecture clean.

4.1 Core Service Contracts
IGitHubAdapter
interface IGitHubAdapter {
  listOpenPRs(): Promise<PullRequest[]>;
  getChangedFiles(prNumber: number): Promise<ChangedFile[]>;
  getDiff(prNumber: number, filePath: string): Promise<string>;
  submitReviewComment(
    prNumber: number,
    filePath: string,
    body: string,
    line: number
  ): Promise<void>;
}

IDiffEngine
interface IDiffEngine {
  parse(diff: string): DiffChunk[];
}

IRiskAnalyzer
interface IRiskAnalyzer {
  analyze(chunks: DiffChunk[]): RiskReport[];
}

IReviewEngine
interface IReviewEngine {
  reviewChunk(
    chunk: DiffChunk,
    mode: ReviewMode
  ): Promise<ReviewResult>;
}

ICopilotService
interface ICopilotService {
  ask(prompt: string): Promise<string>;
}

4.2 Dependency Injection Pattern

Inside extension activation:

const github = new GitHubAdapter();
const diffEngine = new DiffEngine();
const riskAnalyzer = new RiskAnalyzer();
const copilot = new CopilotService();
const reviewEngine = new ReviewEngine(copilot);


Keeps components testable and replaceable.

5. Performance Strategy

Analyze file-by-file

Stream Copilot responses

Cache review results per file

Limit token size via chunk trimming

Avoid blocking main thread

Use:

setImmediate()


or async background execution for heavy tasks.

6. Security Model

No external servers

No telemetry by default

Only uses:

GitHub APIs

Copilot APIs

Enterprise compatible.

7. Extension Command Map

Commands registered:

prism.openPRList
prism.reviewFile
prism.reviewPR
prism.generateSummary
prism.applySuggestion
prism.showRiskAnalysis

📄 GITHUB README (Production-Ready)
PRism — AI-Assisted Pull Request Review in VS Code

PRism enhances your Pull Request review workflow directly inside VS Code using GitHub Copilot.

Review large AI-generated PRs without leaving your editor.

Why PRism?

Pull Requests are getting larger.
AI writes more code.
Review fatigue is real.

PRism helps you:

Review PRs inside VS Code

Focus on high-risk changes first

Use Copilot to analyze diffs

Apply AI suggestions safely

Generate structured review summaries

No external AI APIs.
No extra subscriptions.
Uses your existing GitHub Copilot subscription.

Features

Pull Request browser

Enhanced diff viewer

Risk scoring per file

Structured AI review modes

Patch preview and apply

Review summary generator

Requirements

VS Code

GitHub Pull Requests extension

GitHub Copilot subscription

Local clone of repository

Review Modes

Security Review

Performance Review

Clean Code Review

Architecture Review

Test Coverage Check

General Review

How It Works

Open repository in VS Code

Open PRism panel

Select Pull Request

Click “Review with Copilot”

Analyze suggestions

Apply improvements or generate summary

All AI interactions are handled by GitHub Copilot.

Privacy

PRism does not:

Send your code to external servers

Use third-party AI APIs

Store review data remotely

Everything runs within VS Code using official integrations.

Roadmap

Team review mode

Custom rule templates

CI integration

PR complexity scoring

Org policy enforcement

Contributing

Contributions welcome.
Architecture is modular and service-oriented.

See /docs/architecture.md for technical details.

License

MIT License

🧠 What You Have Now

You now have:

Engineering-grade architecture

Clean modular API layer

Clear service contracts

Proper README

Scalability path

Enterprise-safe positioning

This is no longer an idea.
This is a real dev tool blueprint.




please  make  suere  we  use  the  user  iwn  github  copilot  subscription  not  mine  for  the  project  as if  u understand  and  start   buid  this  
