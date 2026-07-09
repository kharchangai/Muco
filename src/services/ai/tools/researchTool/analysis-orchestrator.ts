// src/tools/researchTool/analysis-orchestrator.ts
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { ResearchRegistry } from "./registry-manager";
import { getAsyncLLM } from "../memory_tools";

// Import the schema and prompt directly from your prompts.ts file
import { AnalysisDecisionSchema, ANALYSIS_AGENT_PROMPT } from "./prompts";

export interface AnalysisPipelineConfig {
  targetFolderPath: string;
  userGoal: string;
  personalContext: string;
  maxSteps?: number;
}

const REPORT_HEADER = "### Research Analysis Report\n\n";
const REPORT_FILENAME = "final-analysis-report.md";

/**
 * Helper to strip the YAML frontmatter and return only the markdown body.
 */
function extractBodyFromOKF(markdownContent: string): string {
  const yamlRegex = /^---\r?\n([\s\S]*?)\r?\n---/;
  return markdownContent.replace(yamlRegex, "").trim();
}

/**
 * Main Analysis Orchestrator Loop
 */
export async function runAnalysisPipeline(config: AnalysisPipelineConfig): Promise<void> {
  const { targetFolderPath, userGoal, personalContext, maxSteps = 10 } = config;

  console.log(`\n[Analyzer] Starting Analysis Agent Pipeline...`);
  console.log(`[Analyzer] Target Goal: "${userGoal}"\n`);

  // 1. Initialize services and load the model
  const registry = await ResearchRegistry.load(targetFolderPath);
  const rawModel = await getAsyncLLM();

  // Bind your exported schema to the model for structured output
  const agentModel = rawModel.withStructuredOutput(AnalysisDecisionSchema);

  // Create the execution chain using your ChatPromptTemplate
  const agentChain = ANALYSIS_AGENT_PROMPT.pipe(agentModel);

  // 2. Initialize path and visited tracker
  const reportPath = await join(targetFolderPath, REPORT_FILENAME);
  const visitedFiles = new Set<string>();
  let lastFileContent = "No file read yet. This is the first step. Pick a file to start.";

  let currentStep = 0;
  let isFinished = false;

  // 3. Main decision and crawling loop
  while (!isFinished && currentStep < maxSteps) {
    console.log(`--- [Analysis Step ${currentStep + 1}/${maxSteps}] ---`);

    // 3.1. Read the CURRENT state of the report DIRECTLY from the disk file.
    // This guarantees that the model always reads exactly what is saved on disk.
    let currentAnalysisBody = "";
    try {
      const fileContent = await readTextFile(reportPath);
      currentAnalysisBody = extractBodyFromOKF(fileContent);
      console.log(`[Analyzer] Successfully read existing analysis from disk.`);
    } catch (error) {
      console.log(`[Analyzer] No existing report file found on disk (or first step). Starting fresh.`);
    }

    // Get the current state of files from your registry
    const registryGuide = registry.getExistingFilesGuide();

    // Filter files that are 'processed' and have not been visited yet
    const availableFilesEntries = Object.entries(registryGuide)
      .filter(([filename, item]) => item.status === "processed" && !visitedFiles.has(filename));

    const availableFilenamesSet = new Set(availableFilesEntries.map(([filename]) => filename));

    const availableFilesArray = availableFilesEntries.map(
      ([filename, item]) => `- ${filename}: ${item.description}`
    );

    // If no new processed files are available, finish the analysis
    if (availableFilesArray.length === 0) {
      console.log(`[Analyzer] No more unread processed files available. Finishing analysis.`);
      isFinished = true;
      break;
    }

    const availableFiles = availableFilesArray.join("\n");
    const currentAnalysisForPrompt = REPORT_HEADER + (currentAnalysisBody || "(empty so far)");

    console.log(`[Analyzer] Agent is thinking...`);

    let decision;
    try {
      // Invoke the chain with the exact variables defined in your prompt template
      decision = await agentChain.invoke({
        user_goal: userGoal,
        personal_context: personalContext,
        current_analysis: currentAnalysisForPrompt,
        last_file_content: lastFileContent,
        available_files: availableFiles
      });
    } catch (error) {
      console.error(`[Analyzer] LLM invocation failed on step ${currentStep + 1}:`, error);
      console.log(`[Analyzer] Stopping the loop safely and saving whatever we have so far.`);
      break;
    }

    console.log(`[Analyzer] Thought: "${decision.thought}"`);

    // 3.2. Tool: Overwrite the report on disk with the newly integrated/merged analysis.
    if (decision.updated_analysis && decision.updated_analysis.trim().length > 0) {
      console.log(`[Analyzer] Writing integrated and updated analysis to disk...`);
      const finalReport = REPORT_HEADER + decision.updated_analysis.trim();
      try {
        await writeTextFile(reportPath, finalReport);
      } catch (writeError) {
        console.error(`[Analyzer] Failed to write updated report to disk:`, writeError);
      }
    } else {
      console.log(`[Analyzer] No changes made to the analysis report in this step.`);
    }

    // 3.3. Check if the agent decided to finish
    if (decision.is_finished || !decision.next_file_to_read) {
      console.log(`[Analyzer] Agent declared the research finished!`);
      isFinished = true;
      break;
    }

    const nextFile = decision.next_file_to_read;

    // 3.4. GUARD: Defend against hallucinated filenames.
    if (!availableFilenamesSet.has(nextFile)) {
      console.warn(`[Analyzer] Agent chose a file NOT in the available list: "${nextFile}". Ignoring and retrying.`);
      lastFileContent = `Error: "${nextFile}" is not a valid filename from the "Available Unread Files" list. You MUST pick the exact filename as written in that list, or set is_finished to true if nothing relevant remains.`;
      currentStep++;
      continue;
    }

    // 3.5. GUARD: Defend against re-selecting an already visited file
    if (visitedFiles.has(nextFile)) {
      console.warn(`[Analyzer] Agent tried to re-select an already visited file: "${nextFile}"`);
      lastFileContent = `Error: You already read "${nextFile}" in a previous step. Please choose a different unread file, or finish the research if nothing new remains.`;
      currentStep++;
      continue;
    }

    console.log(`[Analyzer] Agent decided to read: "${nextFile}"`);

    try {
      // 3.6. Tool: Read file using Tauri APIs
      const filePath = await join(targetFolderPath, nextFile);
      const rawContent = await readTextFile(filePath);

      // Extract markdown body (strip YAML frontmatter)
      lastFileContent = extractBodyFromOKF(rawContent);

      // Add file to visited set to prevent loops
      visitedFiles.add(nextFile);
      console.log(`[Analyzer] Successfully read and extracted body from "${nextFile}".`);

    } catch (error) {
      console.error(`[Analyzer] Failed to read file "${nextFile}":`, error);
      lastFileContent = `Error: Could not read file ${nextFile}. It might be deleted or inaccessible. Please pick another file.`;
      visitedFiles.add(nextFile);
    }

    currentStep++;
  }

  // 4. Final log of the completed report (read directly from disk for verification)
  try {
    const finalReport = await readTextFile(reportPath);
    console.log(`\n================ FINAL COHESIVE ANALYSIS ================`);
    console.log(finalReport);
    console.log(`=========================================================`);
  } catch (error) {
    console.error(`[Analyzer] Could not read final report from disk:`, error);
  }
}