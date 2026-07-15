import { JsonOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

import { textSimilarity } from "../textSimilarity";
import { getAsyncLLM } from "../memory_tools";
import { MEMORY_ENRICHMENT_SYSTEM_PROMPT } from "./prompts";

export type MemoryEnrichment = {
  type: string;
  context: string;
  key: string[];
  tags: string[];
};

export type MemoryNode = {
  id: string;
  content: string;
  createdAt: string;
  type: string;
  context: string;
  key: string[];
  tags: string[];
  embedding: number[];
};

const MEMORY_DIRECTORY = "memory";
const TAGS_FILE_PATH = `${MEMORY_DIRECTORY}/tags.json`;
const TAG_SIMILARITY_THRESHOLD = 0.7;

const memoryEnrichmentParser = new JsonOutputParser<MemoryEnrichment>();

const memoryEnrichmentPrompt = ChatPromptTemplate.fromMessages([
  ["system", MEMORY_ENRICHMENT_SYSTEM_PROMPT],
  [
    "human",
    `
Atomic memory:

{content}

{formatInstructions}
`,
  ],
]);

export async function enrichAtomicMemory(
  content: string,
): Promise<MemoryNode> {
  const llm = await getAsyncLLM();

  const chain = memoryEnrichmentPrompt
    .pipe(llm)
    .pipe(memoryEnrichmentParser);

  const enrichment = await chain.invoke({
    content,
    formatInstructions: memoryEnrichmentParser.getFormatInstructions(),
  });

  const tags = await synchronizeTags(enrichment.tags);

  const embeddingText = createEmbeddingText({
    content,
    context: enrichment.context,
    key: enrichment.key,
    tags,
  });

  const embedding = await textSimilarity.embedText(embeddingText);

  return {
    id: crypto.randomUUID(),
    content,
    createdAt: new Date().toISOString(),
    type: enrichment.type,
    context: enrichment.context,
    key: enrichment.key,
    tags,
    embedding,
  };
}

function createEmbeddingText({
  content,
  context,
  key,
  tags,
}: Pick<MemoryNode, "content" | "context" | "key" | "tags">): string {
  return [
    `Content: ${content}`,
    `Context: ${context}`,
    `Key: ${key.join(", ")}`,
    `Tags: ${tags.join(", ")}`,
  ].join("\n");
}

async function synchronizeTags(modelTags: string[]): Promise<string[]> {
  await ensureMemoryDirectory();

  const storedTags = await readStoredTags();

  if (modelTags.length === 0) {
    return [];
  }

  if (storedTags.length === 0) {
    const uniqueModelTags = [...new Set(modelTags)];

    await saveTags(uniqueModelTags);

    return uniqueModelTags;
  }

  const similarityResult = await textSimilarity.compareListToList(
    modelTags,
    storedTags,
  );

  const synchronizedTags = similarityResult.results.map((result) => {
    const bestMatch = result.bestMatch;

    if (
      bestMatch &&
      bestMatch.score >= TAG_SIMILARITY_THRESHOLD
    ) {
      return bestMatch.text;
    }

    return result.sourceText;
  });

  const updatedStoredTags = [
    ...new Set([...storedTags, ...synchronizedTags]),
  ];

  await saveTags(updatedStoredTags);

  return [...new Set(synchronizedTags)];
}

async function ensureMemoryDirectory(): Promise<void> {
  const directoryExists = await exists(MEMORY_DIRECTORY, {
    baseDir: BaseDirectory.AppData,
  });

  if (directoryExists) {
    return;
  }

  await mkdir(MEMORY_DIRECTORY, {
    baseDir: BaseDirectory.AppData,
    recursive: true,
  });
}

async function readStoredTags(): Promise<string[]> {
  const tagsFileExists = await exists(TAGS_FILE_PATH, {
    baseDir: BaseDirectory.AppData,
  });

  if (!tagsFileExists) {
    await saveTags([]);

    return [];
  }

  try {
    const fileContent = await readTextFile(TAGS_FILE_PATH, {
      baseDir: BaseDirectory.AppData,
    });

    const parsedContent: unknown = JSON.parse(fileContent);

    if (
      !Array.isArray(parsedContent) ||
      !parsedContent.every((value) => typeof value === "string")
    ) {
      throw new Error("tags.json must contain a JSON array of strings.");
    }

    return parsedContent;
  } catch (error) {
    console.warn(
      "Unable to read tags.json. Replacing it with an empty tag list.",
      error,
    );

    await saveTags([]);

    return [];
  }
}

async function saveTags(tags: string[]): Promise<void> {
  await writeTextFile(
    TAGS_FILE_PATH,
    JSON.stringify(tags, null, 2),
    {
      baseDir: BaseDirectory.AppData,
    },
  );
}