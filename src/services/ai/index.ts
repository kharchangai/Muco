import { HumanMessage } from "@langchain/core/messages";
import { workflow } from "./graph";

const app = workflow.compile();

export const chatWithMocu = async (userInput: string): Promise<string> => {
  try {
    const inputs = {
      messages: [new HumanMessage(userInput)],
    };

    const finalState = await app.invoke(inputs);
    
    if (!finalState.messages || finalState.messages.length === 0) {
      return "No messages returned from graph.";
    }

    const lastMessage = finalState.messages[finalState.messages.length - 1];
    const content = lastMessage.content;

    // 1. If content is already a plain string
    if (typeof content === "string") {
      return content;
    }

    // 2. If content is an array of blocks (common in newer LangChain versions)
    if (Array.isArray(content)) {
      return content
        .map((block) => {
          if (typeof block === "string") return block;
          if (block && typeof block === "object" && "text" in block) {
            return (block as any).text;
          }
          return "";
        })
        .join("");
    }

    // 3. Fallback
    return JSON.stringify(content);

  } catch (error) {
    console.error("Error in Mocu Graph:", error);
    return "I encounter an error while processing your request.";
  }
};