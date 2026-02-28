import * as vscode from 'vscode';
import { ICopilotService, ModelInfo } from '../types';

/**
 * CopilotService uses the VS Code Language Model API (vscode.lm)
 * to send prompts via the user's own GitHub Copilot subscription.
 * Supports multiple models including Claude Opus, GPT-4, Gemini, etc.
 * No external API keys are used.
 */
export class CopilotService implements ICopilotService {
  private readonly vendor = 'copilot';
  private readonly preferredModelHints = [
    'claude-sonnet-4',
    'claude-3.7-sonnet',
    'gpt-4.1',
    'gpt-4o',
    'o4-mini',
    'o3',
    'o1',
    'claude-3.5-sonnet',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini',
  ];

  private activeModelName: string | undefined;

  async isAvailable(): Promise<boolean> {
    const models = await this.getAllModels();
    return models.length > 0;
  }

  async ask(prompt: string, modelId?: string): Promise<string> {
    const model = modelId
      ? await this.selectModelById(modelId)
      : await this.selectModel();

    this.activeModelName = model.name;
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];

    const response = await model.sendRequest(
      messages,
      {},
      new vscode.CancellationTokenSource().token
    );

    let fullText = '';
    for await (const chunk of response.text) {
      fullText += chunk;
    }

    return fullText.trim();
  }

  async listModels(): Promise<ModelInfo[]> {
    const models = await this.getAllModels();
    return models.map((m) => ({
      id: m.id,
      name: m.name,
      family: m.family,
      vendor: m.vendor,
      maxInputTokens: m.maxInputTokens,
    }));
  }

  async getActiveModel(): Promise<ModelInfo | undefined> {
    try {
      const model = await this.selectModel();
      return {
        id: model.id,
        name: model.name,
        family: model.family,
        vendor: model.vendor,
        maxInputTokens: model.maxInputTokens,
      };
    } catch {
      return undefined;
    }
  }

  getLastUsedModelName(): string {
    return this.activeModelName ?? 'unknown';
  }

  private getConfiguredModelId(): string | undefined {
    const modelId = vscode.workspace
      .getConfiguration('prism')
      .get<string>('copilotModelId', '')
      .trim();
    return modelId || undefined;
  }

  private getConfiguredFamily(): string | undefined {
    const family = vscode.workspace
      .getConfiguration('prism')
      .get<string>('copilotModelFamily', 'auto')
      .trim();

    if (!family || family.toLowerCase() === 'auto') {
      return undefined;
    }
    return family;
  }

  private async selectModelById(modelId: string): Promise<vscode.LanguageModelChat> {
    const models = await this.getAllModels();
    // Try exact id match first
    const exact = models.find((m) => m.id === modelId);
    if (exact) {
      return exact;
    }
    // Try fuzzy match on id/name/family
    const fuzzy = models.find((m) => {
      const searchText = `${m.id} ${m.family} ${m.name}`.toLowerCase();
      return searchText.includes(modelId.toLowerCase());
    });
    if (fuzzy) {
      return fuzzy;
    }
    throw new Error(
      `Model "${modelId}" not found. Available: ${models.map((m) => m.name).join(', ')}`
    );
  }

  private async selectModel(): Promise<vscode.LanguageModelChat> {
    const configuredModelId = this.getConfiguredModelId();
    if (configuredModelId) {
      return this.selectModelById(configuredModelId);
    }

    const configuredFamily = this.getConfiguredFamily();
    if (configuredFamily) {
      const modelsByFamily = await this.getAllModels({ family: configuredFamily });
      if (modelsByFamily.length > 0) {
        return this.pickPreferredModel(modelsByFamily);
      }
      throw new Error(
        `Configured Copilot model family "${configuredFamily}" was not found. Update prism.copilotModelFamily or set it to "auto".`
      );
    }

    const models = await this.getAllModels();
    if (models.length === 0) {
      throw new Error(
        'GitHub Copilot chat models are unavailable. Install/sign in to GitHub Copilot Chat and ensure your Copilot subscription is active.'
      );
    }
    return this.pickPreferredModel(models);
  }

  private async getAllModels(
    selector: Omit<vscode.LanguageModelChatSelector, 'vendor'> = {}
  ): Promise<vscode.LanguageModelChat[]> {
    return vscode.lm.selectChatModels({ vendor: this.vendor, ...selector });
  }

  private pickPreferredModel(models: readonly vscode.LanguageModelChat[]): vscode.LanguageModelChat {
    const rankModel = (model: vscode.LanguageModelChat): { hintRank: number; tokenRank: number; name: string } => {
      const searchText = `${model.id} ${model.family} ${model.name}`.toLowerCase();
      const hintRank = this.preferredModelHints.findIndex((hint) => searchText.includes(hint));
      return {
        hintRank: hintRank === -1 ? Number.MAX_SAFE_INTEGER : hintRank,
        tokenRank: model.maxInputTokens,
        name: model.name.toLowerCase(),
      };
    };

    const sorted = [...models].sort((a, b) => {
      const aRank = rankModel(a);
      const bRank = rankModel(b);
      if (aRank.hintRank !== bRank.hintRank) {
        return aRank.hintRank - bRank.hintRank;
      }
      if (aRank.tokenRank !== bRank.tokenRank) {
        return bRank.tokenRank - aRank.tokenRank;
      }
      return aRank.name.localeCompare(bRank.name);
    });

    return sorted[0];
  }
}
