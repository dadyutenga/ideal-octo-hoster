import { IDiffEngine, DiffChunk } from '../types';

export class DiffEngine implements IDiffEngine {
  parse(diff: string): DiffChunk[] {
    const chunks: DiffChunk[] = [];
    if (!diff || diff.trim() === '') {
      return chunks;
    }

    const fileBlocks = diff.split(/^diff --git /m).filter(Boolean);

    for (const block of fileBlocks) {
      const lines = block.split('\n');
      const filePathMatch = lines[0].match(/b\/(.+)$/);
      if (!filePathMatch) {
        continue;
      }
      const filePath = filePathMatch[1].trim();

      // Find hunk headers (@@ -a,b +c,d @@)
      const hunkPattern = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
      let currentHunkLines: string[] = [];
      let currentStartLine = 0;
      let hasAdditions = false;
      let hasDeletions = false;

      const flushHunk = () => {
        if (currentHunkLines.length === 0) {
          return;
        }
        const content = currentHunkLines.join('\n');
        const type: DiffChunk['type'] =
          hasAdditions && hasDeletions
            ? 'modification'
            : hasAdditions
            ? 'addition'
            : 'deletion';

        chunks.push({
          filePath,
          type,
          startLine: currentStartLine,
          endLine: currentStartLine + currentHunkLines.length - 1,
          content,
          metadata: {
            containsFunction: /\b(function|def |func |=>|async |class )\b/.test(content),
            containsImportChange: /^[+-]\s*(import|require|from)\b/.test(content),
            containsAuthLogic:
              /\b(auth|token|password|credential|secret|jwt|oauth|session|login|logout)\b/i.test(
                content
              ),
          },
        });

        currentHunkLines = [];
        hasAdditions = false;
        hasDeletions = false;
      };

      for (const line of lines) {
        const hunkMatch = line.match(hunkPattern);
        if (hunkMatch) {
          flushHunk();
          currentStartLine = parseInt(hunkMatch[2], 10);
          continue;
        }
        if (currentStartLine > 0) {
          currentHunkLines.push(line);
          if (line.startsWith('+') && !line.startsWith('+++')) {
            hasAdditions = true;
          } else if (line.startsWith('-') && !line.startsWith('---')) {
            hasDeletions = true;
          }
        }
      }
      flushHunk();
    }

    return chunks;
  }
}
