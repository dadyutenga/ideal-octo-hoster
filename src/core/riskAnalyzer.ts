import { IRiskAnalyzer, DiffChunk, RiskReport } from '../types';

export class RiskAnalyzer implements IRiskAnalyzer {
  analyze(chunks: DiffChunk[]): RiskReport[] {
    // Group chunks by file
    const fileMap = new Map<string, DiffChunk[]>();
    for (const chunk of chunks) {
      const existing = fileMap.get(chunk.filePath) ?? [];
      existing.push(chunk);
      fileMap.set(chunk.filePath, existing);
    }

    const reports: RiskReport[] = [];

    for (const [filePath, fileChunks] of fileMap) {
      const reasons: string[] = [];
      let score = 0;

      // Auth-related files
      if (/\/(auth|authentication|authorization|login|oauth)\//i.test(filePath)) {
        score += 30;
        reasons.push('File is in an authentication/authorization directory');
      }

      // Security-sensitive file names
      if (/\.(env|secret|key|pem|cert)(\.|$)/i.test(filePath)) {
        score += 25;
        reasons.push('File may contain sensitive credentials or certificates');
      }

      // Middleware
      if (/\/(middleware|interceptor)\//i.test(filePath)) {
        score += 20;
        reasons.push('File is middleware — changes may affect request/response pipeline');
      }

      // Dependency files
      if (/(package\.json|package-lock\.json|yarn\.lock|requirements\.txt|Gemfile|go\.sum|pom\.xml)/i.test(filePath)) {
        score += 20;
        reasons.push('Dependency file changed — supply chain risk');
      }

      // Schema / migrations
      if (/\/(migrations?|schema|model)\//i.test(filePath) || /\.(sql|prisma|graphql)$/.test(filePath)) {
        score += 15;
        reasons.push('Schema or migration change detected');
      }

      const allContent = fileChunks.map((c) => c.content).join('\n');

      // Auth logic in content
      const authMatches = (allContent.match(/\b(auth|token|password|credential|secret|jwt|oauth|session)\b/gi) ?? []).length;
      if (authMatches > 0) {
        score += Math.min(authMatches * 5, 20);
        reasons.push(`Contains ${authMatches} auth-related keyword(s)`);
      }

      // Large deletions
      const totalDeletions = fileChunks
        .filter((c) => c.type === 'deletion' || c.type === 'modification')
        .reduce((sum, c) => sum + c.content.split('\n').filter((l) => l.startsWith('-')).length, 0);
      if (totalDeletions > 50) {
        score += 15;
        reasons.push(`Large deletion: ${totalDeletions} lines removed`);
      } else if (totalDeletions > 20) {
        score += 8;
        reasons.push(`Notable deletion: ${totalDeletions} lines removed`);
      }

      // Import changes
      const importChanges = fileChunks.filter((c) => c.metadata.containsImportChange).length;
      if (importChanges > 0) {
        score += Math.min(importChanges * 3, 10);
        reasons.push(`${importChanges} chunk(s) contain import/dependency changes`);
      }

      // Function changes
      const functionChanges = fileChunks.filter((c) => c.metadata.containsFunction).length;
      if (functionChanges > 3) {
        score += 10;
        reasons.push(`${functionChanges} function-level changes detected`);
      }

      score = Math.min(score, 100);
      const level: RiskReport['level'] = score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low';

      if (reasons.length === 0) {
        reasons.push('No significant risk factors identified');
      }

      reports.push({ filePath, score, level, reasons });
    }

    // Sort by score descending
    reports.sort((a, b) => b.score - a.score);
    return reports;
  }
}
