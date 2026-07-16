import { JsonOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

import { getAsyncLLM } from "../../llm";
import { textSimilarity } from "../textSimilarity";
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

const memoryEnrichmentParser =
  new JsonOutputParser<MemoryEnrichment>();

const memoryEnrichmentPrompt =
  ChatPromptTemplate.fromMessages([
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

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException(
      "The operation was cancelled.",
      "AbortError",
    );
  }
}

/**
 * Enriches an atomic memory, synchronizes its tags and creates its embedding.
 *
 * The operation is cancelled by calling:
 *
 * controller.abort()
 *
 * The AbortError is intentionally not caught here and must propagate to the
 * caller, so createMemory can stop before writing the final memory file.
 */
export async function enrichAtomicMemory(
  content: string,
  signal?: AbortSignal,
): Promise<MemoryNode> {
  throwIfAborted(signal);

  const normalizedContent = content.trim();

  if (!normalizedContent) {
    throw new Error("Atomic memory content cannot be empty.");
  }

  const llm = await getAsyncLLM("cheap");

  throwIfAborted(signal);

  const chain = memoryEnrichmentPrompt
    .pipe(llm)
    .pipe(memoryEnrichmentParser);

  /*
   * The signal is passed through LangChain invocation config.
   * Compatible LLM providers can cancel the underlying HTTP request.
   */
  const enrichment = await chain.invoke(
    {
      content: normalizedContent,
      formatInstructions:
        memoryEnrichmentParser.getFormatInstructions(),
    },
    {
      signal,
    },
  );

  throwIfAborted(signal);

  const tags = await synchronizeTags(
    enrichment.tags,
    signal,
  );

  throwIfAborted(signal);

  const embeddingText = createEmbeddingText({
    content: normalizedContent,
    context: enrichment.context,
    key: enrichment.key,
    tags,
  });

  /*
   * Update textSimilarity.embedText to accept signal:
   *
   * embedText(text: string, signal?: AbortSignal)
   */
  const embedding = await textSimilarity.embedText(
    embeddingText,
    signal,
  );

  throwIfAborted(signal);

  return {
    id: crypto.randomUUID(),
    content: normalizedContent,
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
}: Pick<
  MemoryNode,
  "content" | "context" | "key" | "tags"
>): string {
  return [
    `Content: ${content}`,
    `Context: ${context}`,
    `Key: ${key.join(", ")}`,
    `Tags: ${tags.join(", ")}`,
  ].join("\n");
}

/**
 * Maps model-generated tags to existing semantically similar tags and stores
 * any genuinely new tags in memory/tags.json.
 *
 * Important:
 * Cancellation before saveTags prevents tag changes. A Tauri write already
 * started cannot always be forcibly interrupted, but checks prevent moving on
 * to subsequent work after cancellation.
 */
async function synchronizeTags(
  modelTags: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);

  await ensureMemoryDirectory(signal);

  throwIfAborted(signal);

  const storedTags = await readStoredTags(signal);

  throwIfAborted(signal);

  if (modelTags.length === 0) {
    return [];
  }

  if (storedTags.length === 0) {
    const uniqueModelTags = [...new Set(modelTags)];

    await saveTags(uniqueModelTags, signal);

    throwIfAborted(signal);

    return uniqueModelTags;
  }

  /*
   * Update textSimilarity.compareListToList to accept signal:
   *
   * compareListToList(
   *   sourceTexts: string[],
   *   targetTexts: string[],
   *   signal?: AbortSignal,
   * )
   */
  const similarityResult =
    await textSimilarity.compareListToList(
      modelTags,
      storedTags,
      signal,
    );

  throwIfAborted(signal);

  const synchronizedTags = similarityResult.results.map(
    (result) => {
      const bestMatch = result.bestMatch;

      if (
        bestMatch &&
        bestMatch.score >= TAG_SIMILARITY_THRESHOLD
      ) {
        return bestMatch.text;
      }

      return result.sourceText;
    },
  );

  const uniqueSynchronizedTags = [
    ...new Set(synchronizedTags),
  ];

  const updatedStoredTags = [
    ...new Set([
      ...storedTags,
      ...uniqueSynchronizedTags,
    ]),
  ];

  await saveTags(updatedStoredTags, signal);

  throwIfAborted(signal);

  return uniqueSynchronizedTags;
}

async function ensureMemoryDirectory(
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  const directoryExists = await exists(
    MEMORY_DIRECTORY,
    {
      baseDir: BaseDirectory.AppData,
    },
  );

  throwIfAborted(signal);

  if (directoryExists) {
    return;
  }

  await mkdir(MEMORY_DIRECTORY, {
    baseDir: BaseDirectory.AppData,
    recursive: true,
  });

  throwIfAborted(signal);
}

async function readStoredTags(
  signal?: AbortSignal,
): Promise<string[]> {
  throwIfAborted(signal);

  const tagsFileExists = await exists(
    TAGS_FILE_PATH,
    {
      baseDir: BaseDirectory.AppData,
    },
  );

  throwIfAborted(signal);

  if (!tagsFileExists) {
    await saveTags([], signal);

    throwIfAborted(signal);

    return [];
  }

  try {
    const fileContent = await readTextFile(
      TAGS_FILE_PATH,
      {
        baseDir: BaseDirectory.AppData,
      },
    );

    throwIfAborted(signal);

    const parsedContent: unknown = JSON.parse(fileContent);

    if (
      !Array.isArray(parsedContent) ||
      !parsedContent.every(
        (value) => typeof value === "string",
      )
    ) {
      throw new Error(
        "tags.json must contain a JSON array of strings.",
      );
    }

    return parsedContent;
  } catch (error) {
    /*
     * AbortError must never be treated as a corrupted tags file.
     * Otherwise cancelling a request could erase the tags list.
     */
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    console.warn(
      "Unable to read tags.json. Replacing it with an empty tag list.",
      error,
    );

    throwIfAborted(signal);

    await saveTags([], signal);

    throwIfAborted(signal);

    return [];
  }
}

async function saveTags(
  tags: string[],
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);

  await writeTextFile(
    TAGS_FILE_PATH,
    JSON.stringify(tags, null, 2),
    {
      baseDir: BaseDirectory.AppData,
    },
  );

  throwIfAborted(signal);
}