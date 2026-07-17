import { z } from "zod";

import { getAsyncLLM } from "../../../llm";
import { memoryGatePrompt } from "./prompts";
import { getRecentTurns } from "./getRecentTurns";
import { retrieveRelevantShortMemory } from "./retrieveRelevantMemory";

export type AgentMemoryMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
};

const memoryGateSchema = z.object({
  useRecentTurns: z
    .boolean()
    .describe("Whether recent conversation turns are needed."),

  recentTurnCount: z
    .number()
    .int()
    .min(0)
    .max(10)
    .describe("Number of recent turns to load. Use 0 when not needed."),

  useRelevantMemorySearch: z
    .boolean()
    .describe(
      "Whether semantic search in previous short-term memory is needed.",
    ),

  reason: z
    .string()
    .describe("A short internal explanation for the decision."),
});

export type MemoryGateDecision = z.infer<typeof memoryGateSchema>;

export type MemoryGateResult = {
  messages: AgentMemoryMessage[];
  decision: MemoryGateDecision;
};

function createEmptyDecision(): MemoryGateDecision {
  return {
    useRecentTurns: false,
    recentTurnCount: 0,
    useRelevantMemorySearch: false,
    reason: "No memory is needed.",
  };
}

function removeDuplicateMessages(
  messages: AgentMemoryMessage[],
): AgentMemoryMessage[] {
  const seen = new Set<string>();

  return messages.filter((message) => {
    const key = [
      message.role,
      message.content,
      message.createdAt ?? "",
    ].join(":");

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);

    return true;
  });
}

export async function getMemoryForAgent(
  userMessage: string,
): Promise<MemoryGateResult> {
  const normalizedUserMessage = userMessage.trim();

  if (!normalizedUserMessage) {
    return {
      messages: [],
      decision: createEmptyDecision(),
    };
  }

  try {
    const llm = await getAsyncLLM("medium");

    const structuredLlm = llm.withStructuredOutput(
      memoryGateSchema,
    );

    const decision = await structuredLlm.invoke([
      {
        role: "system",
        content: memoryGatePrompt,
      },
      {
        role: "user",
        content: normalizedUserMessage,
      },
    ]);

    const memoryRequests: Promise<AgentMemoryMessage[]>[] = [];

    if (
      decision.useRecentTurns &&
      decision.recentTurnCount > 0
    ) {
      memoryRequests.push(
        getRecentTurns(decision.recentTurnCount),
      );
    }

    if (decision.useRelevantMemorySearch) {
      memoryRequests.push(
        retrieveRelevantShortMemory(normalizedUserMessage),
      );
    }

    if (memoryRequests.length === 0) {
      return {
        messages: [],
        decision,
      };
    }

    const memoryGroups = await Promise.all(memoryRequests);

    const messages = removeDuplicateMessages(
      memoryGroups.flat(),
    );

    return {
      messages,
      decision,
    };
  } catch (error) {
    console.error("Failed to process memory gate:", error);

    return {
      messages: [],
      decision: createEmptyDecision(),
    };
  }
}