import { MessagesAnnotation, Annotation } from "@langchain/langgraph";

// We extend the default MessagesAnnotation to include our custom memory state
export const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec,
  
  // This holds the context retrieved or updated by the Memory Agent
  memoryContext: Annotation<string>({
    reducer: (state, update) => update, // Overwrite with the latest retrieved memory per turn
    default: () => "", // Default is empty if no memory is found
  }),
});