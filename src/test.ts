import { processUserMessage } from "./services/ai/tools/memory/processUserMessage";

export async function runTest() {
  try {
    const test = await processUserMessage(
      "سلام چطوری مکو؟",
    );

    console.log("--------------test----------------");
    console.log(test);
  } catch (error) {
    console.error("Test failed:", error);
  }
}