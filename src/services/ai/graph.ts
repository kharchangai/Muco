import { StateGraph, START, END } from "@langchain/langgraph";
import { GraphState } from "./state";
// Removed callMemoryAgent since it no longer exists
import { callMainAgent } from "./nodes";

const builder = new StateGraph(GraphState)
  // Now we only have one main node that acts as the router and has access to all tools
  .addNode("main_agent", callMainAgent)
  
  // The new Sequence Flow:
  .addEdge(START, "main_agent")           // Send user input directly to the Main Agent
  .addEdge("main_agent", END);            // After the Main Agent replies (and uses tools if needed), finish the graph

export const workflow = builder;