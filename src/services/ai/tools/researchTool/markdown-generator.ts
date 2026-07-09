// src/tools/researchTool/markdown-generator.ts
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { getAsyncLLM } from "../memory_tools";
import { StructuredOutputParser } from "@langchain/core/output_parsers";
import { MARKDOWN_GENERATION_PROMPT, MarkdownGenerationSchema } from "./prompts";

export interface GeneratedMarkdownResult {
  filename: string;
  newLinks: Array<{ filename: string; description: string }>;
}

/**
 * FIX (ROOT CAUSE): Single, safe filename normalizer defined locally in this file.
 * The OLD logic only stripped a trailing ".txt" and then ran a generic
 * "[^a-z0-9-_] -> '-'" replace, which mangled ANY existing ".md" extension
 * into "-md" (since the dot itself matched the "unsafe character" pattern).
 * That produced the "name.md" -> "name-md.md" duplication bug whenever this
 * function was called with an already-normalized filename coming from the
 * registry (instead of a raw ".txt" source file).
 *
 * This version strips BOTH ".md" and ".txt" extensions FIRST (case-insensitive),
 * THEN slugifies the remaining base name, so it's fully idempotent no matter
 * what kind of filename comes in.
 *
 * Exported so it can be reused elsewhere (e.g. orchestrator.ts) via a plain
 * import from this file, without needing a separate utils module.
 */
export function normalizeFilename(rawName: string): string {
  const withoutExt = rawName
    .replace(/\.md$/i, "")
    .replace(/\.txt$/i, "");

  const slug = withoutExt
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_\s]/g, "") // strip apostrophes, punctuation, etc.
    .replace(/\s+/g, "-")          // spaces -> dashes
    .replace(/-+/g, "-")           // collapse multiple dashes
    .replace(/^-+|-+$/g, "");      // trim leading/trailing dashes

  return `${slug}.md`;
}

/**
 * Sanitizes a string for safe embedding inside a YAML double-quoted scalar.
 * Escapes backslashes/quotes and flattens newlines that would otherwise
 * break the YAML frontmatter structure.
 */
function sanitizeYamlString(input: string): string {
  return input
    .replace(/\\/g, '\\\\')   // escape backslashes first
    .replace(/"/g, '\\"')     // escape double quotes
    .replace(/\r?\n/g, ' ')   // flatten newlines to spaces
    .trim();
}

/**
 * Generates an OKF-compliant Markdown file with YAML frontmatter.
 * Extracts relevant facts, applies strict interlinking, and saves the file.
 * 
 * @param userGoal The main research goal.
 * @param personalContext Distilled instructions/context from the user's history.
 * @param rawContent The raw text content to transform.
 * @param existingFilesGuide Current registry of processed and todo files with descriptions.
 * @param targetFolderPath Path of the active research folder where the file will be saved.
 * @param sourceFileName Name of the source file (used to generate the output filename).
 *                        Can be a raw source name (e.g. "some-article.txt") OR an
 *                        already-normalized registry filename (e.g. "some-article.md").
 *                        Both are handled safely and idempotently by normalizeFilename().
 */
export async function generateOKFMarkdown(
  userGoal: string,
  personalContext: string,
  rawContent: string,
  existingFilesGuide: Record<string, { description: string; status: 'processed' | 'todo' }>,
  targetFolderPath: string,
  sourceFileName: string
): Promise<GeneratedMarkdownResult | null> {
  try {
    const model = await getAsyncLLM();
    const parser = StructuredOutputParser.fromZodSchema(MarkdownGenerationSchema);
    const chain = MARKDOWN_GENERATION_PROMPT.pipe(model).pipe(parser);

    console.log(`[Markdown Generator] Generating OKF document for source: "${sourceFileName}"...`);

    // Invoke the model
    const result = await chain.invoke({
      user_goal: userGoal,
      personal_context: personalContext,
      raw_content: rawContent,
      existing_files_guide: JSON.stringify(existingFilesGuide, null, 2),
      format_instructions: parser.getFormatInstructions()
    });

    // FIX: Use the idempotent normalizer instead of the old buggy regex chain.
    const outputFileName = normalizeFilename(sourceFileName);
    const finalFilePath = await join(targetFolderPath, outputFileName);

    // FIX: Normalize any newly proposed link filenames from the LLM as well,
    // so they're already clean and consistent BEFORE reaching the caller/orchestrator.
    const normalizedNewLinks = result.new_links_proposed.map(l => ({
      filename: normalizeFilename(l.filename),
      description: l.description
    }));

    // FIX: Also normalize existing_links_used, in case the model echoed back
    // a slightly different casing/format than what's actually in the registry.
    const normalizedExistingLinks = result.existing_links_used.map(f => normalizeFilename(f));

    // Combine all links used (existing + new) for the YAML frontmatter
    const allLinks = [
      ...normalizedExistingLinks,
      ...normalizedNewLinks.map(l => l.filename)
    ];

    // Build ISO 8601 Timestamp (Required for OKF)
    const timestamp = new Date().toISOString();

    // FIX: Sanitize title/description to prevent broken YAML from embedded
    // newlines, unescaped quotes, or backslashes coming from the LLM output.
    const safeTitle = sanitizeYamlString(result.title);
    const safeDescription = sanitizeYamlString(result.description);

    // FIX (YAML formatting): Removed the leading indentation that previously
    // existed inside the template literal (inherited from the code's own
    // indentation level). Frontmatter keys now start exactly at column 0,
    // which is required for reliable parsing by strict YAML parsers.
    const okfMarkdownContent = `---
type: "concept"
title: "${safeTitle}"
description: "${safeDescription}"
tags: ${JSON.stringify(result.tags)}
related_links: ${JSON.stringify(allLinks)}
timestamp: "${timestamp}"
---

# ${result.title}

${result.markdown_body.trim()}
`;

    // Save the file securely
    await writeTextFile(finalFilePath, okfMarkdownContent);
    console.log(`[Markdown Generator] Successfully saved OKF file: "${outputFileName}"`);

    return {
      filename: outputFileName,
      newLinks: normalizedNewLinks
    };

  } catch (error) {
    console.error(`[Markdown Generator] Error generating markdown for ${sourceFileName}:`, error);
    return null;
  }
}