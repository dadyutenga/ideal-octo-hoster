import * as vscode from 'vscode';
import { ICopilotService } from '../types';

/**
 * CopilotService uses the VS Code Language Model API (vscode.lm)
 * to send prompts via the user's own GitHub Copilot subscription.
 * No external API keys are used.
 */
export class CopilotService implements ICopilotService {
  private readonly modelFamily = 'gpt-4o';
  private readonly vendor = 'copilot';

  async isAvailable(): Promise<boolean> {
    const models = await vscode.lm.selectChatModels({
      vendor: this.vendor,
      family: this.modelFamily,
    });
    return models.length > 0;
  }

  async ask(prompt: string): Promise<string> {
    const models = await vscode.lm.selectChatModels({
      vendor: this.vendor,
      family: this.modelFamily,
    });

    if (models.length === 0) {
      throw new Error(
        'GitHub Copilot is not available. Please ensure you have an active Copilot subscription and the GitHub Copilot extension is installed.'
      );
    }

    const model = models[0];
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
}
