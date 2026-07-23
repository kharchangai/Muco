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
  useRecentTurns: z.boolean(),

  recentTurnCount: z.number().int().min(0).max(10),

  useRelevantMemorySearch: z.boolean(),

  reason: z.string(),
});

export type MemoryGateDecision = z.infer<typeof memoryGateSchema>;

export type MemoryGateResult = {
  messages: AgentMemoryMessage[];
  decision: MemoryGateDecision;
};

type LlmResponseContent =
  | string
  | Array<
      | string
      | {
          type?: string;
          text?: string;
          content?: string;
        }
    >
  | null
  | undefined;

function createEmptyDecision(
  reason = "No memory is needed.",
): MemoryGateDecision {
  return {
    useRecentTurns: false,
    recentTurnCount: 0,
    useRelevantMemorySearch: false,
    reason,
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

function getTextFromLlmContent(
  content: LlmResponseContent,
): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (!part || typeof part !== "object") {
        return "";
      }

      if (typeof part.text === "string") {
        return part.text;
      }

      if (typeof part.content === "string") {
        return part.content;
      }

      return "";
    })
    .join("")
    .trim();
}

function removeCodeFence(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json|JSON)?\s*/u, "")
    .replace(/\s*```$/u, "")
    .trim();
}

function findJsonObject(text: string): string | null {
  const cleanedText = removeCodeFence(text);

  if (
    cleanedText.startsWith("{") &&
    cleanedText.endsWith("}")
  ) {
    return cleanedText;
  }

  const firstBraceIndex = cleanedText.indexOf("{");

  if (firstBraceIndex === -1) {
    return null;
  }

  let depth = 0;
  let insideString = false;
  let escaped = false;

  for (
    let index = firstBraceIndex;
    index < cleanedText.length;
    index += 1
  ) {
    const character = cleanedText[index];

    if (insideString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (character === "\\") {
        escaped = true;
        continue;
      }

      if (character === '"') {
        insideString = false;
      }

      continue;
    }

    if (character === '"') {
      insideString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character === "}") {
      depth -= 1;

      if (depth === 0) {
        return cleanedText.slice(firstBraceIndex, index + 1);
      }
    }
  }

  return null;
}

function parseMemoryGateDecision(
  content: LlmResponseContent,
): MemoryGateDecision {
  const responseText = getTextFromLlmContent(content);

  if (!responseText) {
    throw new Error("The model returned an empty response.");
  }

  const jsonText = findJsonObject(responseText);

  if (!jsonText) {
    throw new Error(
      `Could not find a JSON object in the model response: ${responseText}`,
    );
  }

  const parsedJson: unknown = JSON.parse(jsonText);

  return memoryGateSchema.parse(parsedJson);
}

function buildMemoryGateSystemPrompt(): string {
  return `${memoryGatePrompt}

Return exactly one valid JSON object.

Do not use Markdown.
Do not use a code block.
Do not include any explanation before or after the JSON.

The JSON must have exactly this structure:

{
  "useRecentTurns": boolean,
  "recentTurnCount": integer,
  "useRelevantMemorySearch": boolean,
  "reason": string
}

Rules:
- "recentTurnCount" must be an integer from 0 to 10.
- Set "recentTurnCount" to 0 when "useRecentTurns" is false.
- "reason" must be short.
`;
}

async function getMemoryGateDecision(
  userMessage: string,
): Promise<MemoryGateDecision> {
  const llm = await getAsyncLLM("medium");

  const response = await llm.invoke([
    {
      role: "system",
      content: buildMemoryGateSystemPrompt(),
    },
    {
      role: "user",
      content: userMessage,
    },
  ]);

  return parseMemoryGateDecision(
    response.content as LlmResponseContent,
  );
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
    const decision = await getMemoryGateDecision(
      normalizedUserMessage,
    );

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

    return {
      messages: removeDuplicateMessages(memoryGroups.flat()),
      decision,
    };
  } catch (error) {
    console.error("Failed to process memory gate:", error);

    return {
      messages: [],
      decision: createEmptyDecision(
        "Memory gate failed, so memory retrieval was skipped.",
      ),
    };
  }
}