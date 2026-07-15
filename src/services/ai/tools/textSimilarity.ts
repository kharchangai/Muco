import { OpenAIEmbeddings } from "@langchain/openai";
import { readSettings } from "../../../store";

export type TextSimilarityResult = {
  text1: string;
  text2: string;
  score: number;
};

export type TextListSimilarityItem = {
  text: string;
  score: number;
};

export type TextToListSimilarityResult = {
  sourceText: string;
  matches: TextListSimilarityItem[];
  bestMatch: TextListSimilarityItem | null;
};

export type ListToListSimilarityItem = {
  sourceText: string;
  matches: TextListSimilarityItem[];
  bestMatch: TextListSimilarityItem | null;
};

export type ListToListSimilarityResult = {
  results: ListToListSimilarityItem[];
};

export type MemoryEmbeddingInput = {
  content: string;
  context: string;
  key: string[];
  tags: string[];
};

export type EmbeddingListItem = {
  id: string;
  embedding: number[];
};

export type EmbeddingSimilarityItem = {
  id: string;
  score: number;
};

export type EmbeddingToListSimilarityResult = {
  matches: EmbeddingSimilarityItem[];
  bestMatch: EmbeddingSimilarityItem | null;
};

export type EmbeddingListToListSimilarityItem = {
  sourceId: string;
  matches: EmbeddingSimilarityItem[];
  bestMatch: EmbeddingSimilarityItem | null;
};

export type EmbeddingListToListSimilarityResult = {
  results: EmbeddingListToListSimilarityItem[];
};

function cosineSimilarity(vectorA: number[], vectorB: number[]): number {
  if (vectorA.length !== vectorB.length) {
    throw new Error(
      `Embedding dimensions do not match: ${vectorA.length} and ${vectorB.length}.`,
    );
  }

  if (vectorA.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let index = 0; index < vectorA.length; index += 1) {
    const valueA = vectorA[index];
    const valueB = vectorB[index];

    dotProduct += valueA * valueB;
    magnitudeA += valueA * valueA;
    magnitudeB += valueB * valueB;
  }

  const denominator = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);

  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
}

function roundScore(score: number): number {
  return Number(score.toFixed(6));
}

function assertValidEmbedding(
  embedding: number[],
  label: string,
): void {
  if (embedding.length === 0) {
    throw new Error(`${label} cannot be empty.`);
  }

  const hasInvalidValue = embedding.some(
    (value) => !Number.isFinite(value),
  );

  if (hasInvalidValue) {
    throw new Error(`${label} contains an invalid numeric value.`);
  }
}

/**
 * Converts all memory fields into one stable text representation.
 * This representation is sent to the embedding model.
 */
function createMemoryEmbeddingText({
  content,
  context,
  key,
  tags,
}: MemoryEmbeddingInput): string {
  return [
    `Content: ${content}`,
    `Context: ${context}`,
    `Key: ${key.join(", ")}`,
    `Tags: ${tags.join(", ")}`,
  ].join("\n");
}

export class TextSimilarity {
  private embeddings: OpenAIEmbeddings | null = null;

  private async getEmbeddings(): Promise<OpenAIEmbeddings> {
    if (this.embeddings) {
      return this.embeddings;
    }

    const settings = await readSettings();

    if (!settings.embeddingModel) {
      throw new Error(
        "Embedding model is not configured. Please set an Embedding Model in Mocu Settings.",
      );
    }

    if (!settings.embeddingBaseUrl) {
      throw new Error(
        "Embedding base URL is not configured. Please set an Embedding Base URL in Mocu Settings.",
      );
    }

    this.embeddings = new OpenAIEmbeddings({
      model: settings.embeddingModel,
      apiKey: settings.embeddingApiKey || "not-required",
      configuration: {
        baseURL: settings.embeddingBaseUrl,
      },
    });

    return this.embeddings;
  }

  private async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const embeddings = await this.getEmbeddings();
    const result = await embeddings.embedDocuments(texts);

    if (result.length !== texts.length) {
      throw new Error(
        `Embedding provider returned ${result.length} vectors for ${texts.length} texts.`,
      );
    }

    return result;
  }

  /**
   * Creates an embedding vector for one text.
   */
  public async embedText(text: string): Promise<number[]> {
    const [embedding] = await this.embedTexts([text]);

    if (!embedding) {
      throw new Error("Embedding provider did not return an embedding vector.");
    }

    assertValidEmbedding(embedding, "Generated embedding");

    return embedding;
  }

  /**
   * Combines memory content, context, keys, and tags into one text,
   * then creates one final embedding vector for the memory node.
   */
  public async embedMemory(
    memory: MemoryEmbeddingInput,
  ): Promise<number[]> {
    const embeddingText = createMemoryEmbeddingText(memory);

    return this.embedText(embeddingText);
  }

  /**
   * Compares one existing embedding against another existing embedding.
   * No embedding API request is made by this method.
   */
  public compareEmbeddingToEmbedding(
    embedding1: number[],
    embedding2: number[],
  ): number {
    assertValidEmbedding(embedding1, "First embedding");
    assertValidEmbedding(embedding2, "Second embedding");

    return roundScore(cosineSimilarity(embedding1, embedding2));
  }

  /**
   * Compares one existing embedding against a list of existing embeddings.
   * No embedding API request is made by this method.
   * Results are sorted from highest similarity to lowest similarity.
   */
  public compareEmbeddingToList(
    sourceEmbedding: number[],
    targetEmbeddings: EmbeddingListItem[],
  ): EmbeddingToListSimilarityResult {
    assertValidEmbedding(sourceEmbedding, "Source embedding");

    if (targetEmbeddings.length === 0) {
      return {
        matches: [],
        bestMatch: null,
      };
    }

    const matches = targetEmbeddings
      .map((target, index) => {
        if (!target.id) {
          throw new Error(
            `Target embedding at index ${index} does not have a valid ID.`,
          );
        }

        assertValidEmbedding(
          target.embedding,
          `Target embedding at index ${index}`,
        );

        return {
          id: target.id,
          score: this.compareEmbeddingToEmbedding(
            sourceEmbedding,
            target.embedding,
          ),
        };
      })
      .sort((first, second) => second.score - first.score);

    return {
      matches,
      bestMatch: matches[0] ?? null,
    };
  }

  /**
   * Compares every embedding in the source list against every embedding
   * in the target list. No embedding API request is made by this method.
   */
  public compareEmbeddingListToList(
    sourceEmbeddings: EmbeddingListItem[],
    targetEmbeddings: EmbeddingListItem[],
  ): EmbeddingListToListSimilarityResult {
    if (sourceEmbeddings.length === 0) {
      return {
        results: [],
      };
    }

    const results = sourceEmbeddings.map((source, sourceIndex) => {
      if (!source.id) {
        throw new Error(
          `Source embedding at index ${sourceIndex} does not have a valid ID.`,
        );
      }

      const comparison = this.compareEmbeddingToList(
        source.embedding,
        targetEmbeddings,
      );

      return {
        sourceId: source.id,
        matches: comparison.matches,
        bestMatch: comparison.bestMatch,
      };
    });

    return {
      results,
    };
  }

  /**
   * Compares one text with another text using semantic embeddings.
   */
  public async compareTextToText(
    text1: string,
    text2: string,
  ): Promise<TextSimilarityResult> {
    const [embedding1, embedding2] = await this.embedTexts([text1, text2]);

    if (!embedding1 || !embedding2) {
      throw new Error(
        "Embedding provider did not return vectors for both input texts.",
      );
    }

    return {
      text1,
      text2,
      score: this.compareEmbeddingToEmbedding(embedding1, embedding2),
    };
  }

  /**
   * Compares one text against every item in a list.
   * Results are sorted from highest similarity to lowest similarity.
   */
  public async compareTextToList(
    sourceText: string,
    textList: string[],
  ): Promise<TextToListSimilarityResult> {
    if (textList.length === 0) {
      return {
        sourceText,
        matches: [],
        bestMatch: null,
      };
    }

    const allTexts = [sourceText, ...textList];
    const allEmbeddings = await this.embedTexts(allTexts);

    const sourceEmbedding = allEmbeddings[0];
    const listEmbeddings = allEmbeddings.slice(1);

    if (!sourceEmbedding || listEmbeddings.length !== textList.length) {
      throw new Error(
        "Embedding provider returned an unexpected number of embedding vectors.",
      );
    }

    const matches = textList
      .map((text, index) => {
        const targetEmbedding = listEmbeddings[index];

        if (!targetEmbedding) {
          throw new Error(
            `Embedding provider did not return a vector for list item at index ${index}.`,
          );
        }

        return {
          text,
          score: this.compareEmbeddingToEmbedding(
            sourceEmbedding,
            targetEmbedding,
          ),
        };
      })
      .sort((first, second) => second.score - first.score);

    return {
      sourceText,
      matches,
      bestMatch: matches[0] ?? null,
    };
  }

  /**
   * Compares every text in the source list against every text in the target list.
   *
   * For each source text, it returns:
   * - all target matches in descending similarity order
   * - the best matching target text
   */
  public async compareListToList(
    sourceList: string[],
    targetList: string[],
  ): Promise<ListToListSimilarityResult> {
    if (sourceList.length === 0) {
      return {
        results: [],
      };
    }

    if (targetList.length === 0) {
      return {
        results: sourceList.map((sourceText) => ({
          sourceText,
          matches: [],
          bestMatch: null,
        })),
      };
    }

    const allTexts = [...sourceList, ...targetList];
    const allEmbeddings = await this.embedTexts(allTexts);

    if (allEmbeddings.length !== allTexts.length) {
      throw new Error(
        "Embedding provider returned an unexpected number of embedding vectors.",
      );
    }

    const sourceEmbeddings = allEmbeddings.slice(0, sourceList.length);
    const targetEmbeddings = allEmbeddings.slice(sourceList.length);

    const results = sourceList.map((sourceText, sourceIndex) => {
      const sourceEmbedding = sourceEmbeddings[sourceIndex];

      if (!sourceEmbedding) {
        throw new Error(
          `Embedding provider did not return a vector for source item at index ${sourceIndex}.`,
        );
      }

      const matches = targetList
        .map((targetText, targetIndex) => {
          const targetEmbedding = targetEmbeddings[targetIndex];

          if (!targetEmbedding) {
            throw new Error(
              `Embedding provider did not return a vector for target item at index ${targetIndex}.`,
            );
          }

          return {
            text: targetText,
            score: this.compareEmbeddingToEmbedding(
              sourceEmbedding,
              targetEmbedding,
            ),
          };
        })
        .sort((first, second) => second.score - first.score);

      return {
        sourceText,
        matches,
        bestMatch: matches[0] ?? null,
      };
    });

    return {
      results,
    };
  }
}

export const textSimilarity = new TextSimilarity();