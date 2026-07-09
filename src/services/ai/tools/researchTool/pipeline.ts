// src/tools/researchTool/pipeline.ts
import { readTextFile } from '@tauri-apps/plugin-fs'; // Added to read the final report
import { join } from '@tauri-apps/api/path'; // Added to resolve the report path
import { findRelevantResearchFolder } from "./utils"; 
import { executePersonalResearch } from "./personal-memory-extractor";
import { readLocalTextSources } from "./source-reader"; 
import { generateOKFMarkdown } from "./markdown-generator"; 
import { ResearchRegistry } from "./registry-manager"; 
import { runResearchPipeline, SearchPipelineConfig } from "./orchestrator";
import { perplexitySearchTool } from "../perplexity_search_tool"; // Updated import

// IMPORT THE ANALYSIS ORCHESTRATOR
import { runAnalysisPipeline, AnalysisPipelineConfig } from "./analysis-orchestrator";

/**
 * Executes the Complete Autonomous Research Pipeline.
 * Integrates Local File Analysis, Personal Memory, Autonomous Web Research,
 * and compiles a Final Cohesive Analysis Report.
 * 
 * @param goal - The main research goal.
 * @param userFolder - Optional path to the user's local source folder.
 * @returns The full text content of the final analysis report (Markdown), or null if failed.
 */
export async function executeResearchPipeline(
  goal: string, 
  userFolder?: string
): Promise<string | null> {
  
  // =====================================================================
  // STEP 1: Route to Target Folder (Find or Create)
  // =====================================================================
  const resolvedFolderPath = await findRelevantResearchFolder(goal);
  console.log(`[Pipeline] Resolved folder path: "${resolvedFolderPath}"`);

  if (!resolvedFolderPath) {
    console.error("[Pipeline] Pipeline aborted: Failed to resolve or create a target folder.");
    return "Error: Failed to resolve or create a target folder for this research.";
  }

  // =====================================================================
  // STEP 2: Extract Personal Memory Context
  // =====================================================================
  let extractedPersonalContext = "";

  try {
    console.log("[Pipeline] Initiating personal memory extraction step...");
    const extractionResult = await executePersonalResearch(goal, resolvedFolderPath);
    
    if (extractionResult) {
      console.log("[Pipeline] Personal memory extraction completed successfully.");
      extractedPersonalContext = extractionResult.distilledPrompt;
    } else {
      console.log("[Pipeline] Personal memory extraction skipped (No relevant data found).");
    }
  } catch (error) {
    console.error("[Pipeline] Error occurred during personal memory extraction:", error);
  }

  // =====================================================================
  // STEP 3: Ingestion / Bootstrapping Phase
  // =====================================================================
  const registry = await ResearchRegistry.load(resolvedFolderPath);

  if (userFolder) {
    // -----------------------------------------------------------------
    // CASE A: User provided a local folder -> Ingest local files
    // -----------------------------------------------------------------
    try {
      console.log(`[Pipeline] Analyzing local files from source folder: "${userFolder}"...`);
      const localDocs = await readLocalTextSources(userFolder, resolvedFolderPath);

      if (localDocs) {
        const fileNames = Object.keys(localDocs);
        console.log(`[Pipeline] Found ${fileNames.length} new/modified local files to ingest.`);

        for (const [fileName, content] of Object.entries(localDocs)) {
          console.log(`[Pipeline] Processing local file: "${fileName}"`);

          const generationResult = await generateOKFMarkdown(
            goal,
            extractedPersonalContext,
            content,
            registry.getExistingFilesGuide(),
            resolvedFolderPath,
            fileName
          );

          if (generationResult) {
            await registry.register(
              generationResult.filename, 
              `Analyzed local source: ${fileName}`, 
              "processed"
            );

            for (const link of generationResult.newLinks) {
              if (!registry.has(link.filename)) {
                await registry.register(link.filename, link.description, "todo");
                console.log(`[Pipeline] Added new todo task from local file: "${link.filename}"`);
              }
            }
          }
        }
        await registry.syncWithDisk();
        console.log("[Pipeline] Local files ingestion completed successfully.");
      } else {
        console.log("[Pipeline] No new or modified local files found.");
      }
    } catch (error) {
      console.error("[Pipeline] Error during local files ingestion:", error);
    }
  } else {
    // -----------------------------------------------------------------
    // CASE B: Fallback (No folder provided) -> Bootstrapping via Public Search
    // -----------------------------------------------------------------
    try {
      console.log("[Pipeline] No local folder provided. Bootstrapping via Public Search...");

      const existingGuide = registry.getExistingFilesGuide();
      const hasProcessedFiles = Object.values(existingGuide).some(item => item.status === "processed");

      if (!hasProcessedFiles) {
        console.log(`[Pipeline] Bootstrapping: Executing initial public search for goal: "${goal}"`);
        
        // Use the updated perplexitySearchTool that loads settings internally
        const rawBootstrapResult = await perplexitySearchTool.invoke({ 
          query: `Provide a comprehensive overview and key aspects of: ${goal}` 
        });

        if (typeof rawBootstrapResult === "string" && rawBootstrapResult.trim().length > 0 && !rawBootstrapResult.startsWith("Error:")) {
          const initialFileName = "initial-overview.txt";
          
          console.log("[Pipeline] Bootstrapping: Generating initial OKF Overview Markdown...");
          const generationResult = await generateOKFMarkdown(
            goal,
            extractedPersonalContext,
            rawBootstrapResult,
            existingGuide,
            resolvedFolderPath,
            initialFileName
          );

          if (generationResult) {
            await registry.register(
              generationResult.filename,
              `Initial public search overview for goal: ${goal}`,
              "processed"
            );

            for (const link of generationResult.newLinks) {
              if (!registry.has(link.filename)) {
                await registry.register(link.filename, link.description, "todo");
                console.log(`[Pipeline] Queued todo task from bootstrap search: "${link.filename}"`);
              }
            }
            
            await registry.syncWithDisk();
            console.log("[Pipeline] Bootstrapping completed. Registry populated with initial leads.");
          }
        } else {
          console.warn("[Pipeline] Bootstrapping search failed or returned empty result.");
        }
      } else {
        console.log("[Pipeline] Registry already contains processed files. Skipping bootstrap phase.");
      }
    } catch (error) {
      console.error("[Pipeline] Error during public search bootstrapping:", error);
    }
  }

  // =====================================================================
  // STEP 4: Execute Autonomous Web Research Loop (Perplexity Phase)
  // =====================================================================
  try {
    console.log("[Pipeline] Initiating main autonomous web research loop...");

    // Search settings (API Key, Base URL, depth) are loaded internally by runResearchPipeline
    const searchConfig: SearchPipelineConfig = {
      targetFolderPath: resolvedFolderPath,
      userGoal: goal,
      personalContext: extractedPersonalContext,
      scoreThreshold: 4
    };

    await runResearchPipeline(searchConfig);
    console.log("[Pipeline] Main autonomous web research loop finished successfully.");

  } catch (error) {
    console.error("[Pipeline] Critical error in main research loop:", error);
  }

  // =====================================================================
  // STEP 5: Execute Final Cohesive Analysis Phase (Synthesis)
  // =====================================================================
  try {
    console.log("\n[Pipeline] Initiating Final Analysis and Synthesis Phase...");

    const analysisConfig: AnalysisPipelineConfig = {
      targetFolderPath: resolvedFolderPath,
      userGoal: goal,
      personalContext: extractedPersonalContext,
      maxSteps: 10 
    };

    // Run the analysis orchestrator
    await runAnalysisPipeline(analysisConfig);
    console.log("[Pipeline] Final Cohesive Analysis Report compiled successfully.");

  } catch (error) {
    console.error("[Pipeline] Critical error in Final Analysis phase:", error);
  }

  // =====================================================================
  // STEP 6: Read and Return the Final Report to the Calling Agent (Tool Output)
  // =====================================================================
  try {
    console.log("[Pipeline] Fetching final analysis report from disk for tool return...");
    const reportPath = await join(resolvedFolderPath, "final-analysis-report.md");
    const finalReportContent = await readTextFile(reportPath);
    
    // Return the actual compiled analysis markdown
    return finalReportContent;

  } catch (error) {
    console.error("[Pipeline] Failed to read final report from disk:", error);
    return `Error: Research pipeline completed successfully, but the final analysis report could not be read from the disk path: "${resolvedFolderPath}".`;
  }
}