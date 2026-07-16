import {initializeShortMemory} from "./services/ai/tools/memory/short-memory/initializeShortMemory"

export async function runTest() {
  try {
    initializeShortMemory()
  } catch (error) {
    console.error("Test failed:", error);
  }
}