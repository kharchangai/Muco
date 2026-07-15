import { z } from "zod";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { getAsyncLLM } from "../memory_tools";
import { ATOMIC_MEMORY_EXTRACTION_PROMPT } from "./prompts";

export const AtomicMemorySchema = z.object({
  content: z.string().trim().min(1),
});

export const AtomicMemoryExtractionSchema = z.object({
  memories: z.array(AtomicMemorySchema),
});

export type AtomicMemory = z.infer<typeof AtomicMemorySchema>;

/**
 * Raw JSON Schema for the provider.
 *
 * Do not add `description`, `title`, `default`, or `$ref` here.
 * Some OpenAI-compatible providers reject schemas where `$ref`
 * is combined with additional JSON Schema keywords.
 */
const AtomicMemoryExtractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    memories: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          content: {
            type: "string",
          },
        },
        required: ["content"],
      },
    },
  },
  required: ["memories"],
} as const;

/**
 * Extracts independent atomic memory candidates from a raw user message.
 *
 * This function only extracts standalone memory statements.
 * It does not create IDs, keys, tags, contexts, embeddings, links,
 * timestamps, files, or database records.
 */
export async function extractAtomicMemories(
  userText: string
): Promise<AtomicMemory[]> {
  const text = userText?.trim();

  if (!text) {
    return [];
  }

  try {
    const model = await getAsyncLLM();

    const structuredModel = model.withStructuredOutput(
      AtomicMemoryExtractionJsonSchema,
      {
        name: "atomic_memory_extraction",
      }
    );

    const result = await structuredModel.invoke([
      new SystemMessage(ATOMIC_MEMORY_EXTRACTION_PROMPT),
      new HumanMessage(text),
    ]);

    const validatedResult = AtomicMemoryExtractionSchema.safeParse(result);

    if (!validatedResult.success) {
      console.error(
        "[Atomic memory extraction] Invalid structured response:",
        validatedResult.error
      );

      return [];
    }

    return validatedResult.data.memories;
  } catch (error) {
    console.error("[Atomic memory extraction] Failed:", error);
    return [];
  }
}