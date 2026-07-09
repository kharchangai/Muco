import { ResearchRegistry } from "./registry-manager";
import { perplexitySearchTool } from "../perplexity_search_tool"; // Updated import
import { generateOKFMarkdown, normalizeFilename } from "./markdown-generator";
import {
  LinkScoringSchema,
  LINK_SCORING_PROMPT,
  SearchQuerySchema,
  QUERY_GENERATION_PROMPT,
  GoalEvaluationSchema,
  GOAL_EVALUATION_PROMPT
} from "./prompts";
import { getAsyncLLM } from "../memory_tools";
import { readSettings } from "../../../../store"; // Import settings reader

export interface SearchPipelineConfig {
  targetFolderPath: string;
  userGoal: string;
  personalContext: string; 
  scoreThreshold?: number;
}

/**
 * Main Autonomous Research Orchestrator for Project Moko.
 * Manages the loop of scoring, query generation, Perplexity search, markdown generation,
 * and status tracking. Uses a Dynamic Queue with Delta Scoring to prevent "Tunnel Vision".
 */
export async function runResearchPipeline(config: SearchPipelineConfig): Promise<void> {
  const {
    targetFolderPath,
    userGoal,
    personalContext,
    scoreThreshold = 4, // Exclude links with score < 4
  } = config;

  console.log(`[Pipeline] Starting autonomous research pipeline...`);
  console.log(`[Pipeline] Target Goal: "${userGoal}"`);

  // 1. Load Settings, Registry & LLM
  const settings = await readSettings();
  const maxDepth = settings.searchDepth ?? 3; // Use search depth from settings as maxDepth

  const registry = await ResearchRegistry.load(targetFolderPath);
  const rawModel = await getAsyncLLM();

  // 2. Fetch the current todo list from your registry
  const todoQueue = registry.getTodoQueue();
  if (todoQueue.length === 0) {
    console.log("[Pipeline] No pending 'todo' links found in registry. Exiting safely.");
    return;
  }

  console.log(`[Pipeline] Found ${todoQueue.length} pending links to evaluate.`);

  // 3. Initial Score and prioritize the links
  console.log("[Pipeline] Scoring initial links based on relevance to user goal...");
  const scoringModel = rawModel.withStructuredOutput(LinkScoringSchema);
  const scoringChain = LINK_SCORING_PROMPT.pipe(scoringModel);

  const scoringResponse = await scoringChain.invoke({
    user_goal: userGoal,
    todo_links: JSON.stringify(todoQueue, null, 2)
  });

  // Filter based on threshold and sort descending (highest score first)
  const prioritizedTasks = scoringResponse.scored_links
    .filter(item => item.score >= scoreThreshold)
    .sort((a, b) => b.score - a.score);

  console.log(`[Pipeline] Prioritized ${prioritizedTasks.length} initial links with score >= ${scoreThreshold}`);

  // 4. Execution Loop (Dynamic Queue)
  let currentDepth = 0;
  let isGoalMet = false;
  
  // Convert static array to a dynamic queue so we can inject new high-value links mid-flight
  const dynamicQueue = [...prioritizedTasks];

  while (dynamicQueue.length > 0 && currentDepth < maxDepth && !isGoalMet) {
    // Take the highest priority task off the top of the queue
    const task = dynamicQueue.shift();
    if (!task) break;

    const normalizedTaskFilename = normalizeFilename(task.filename);

    console.log(`\n--- [Step ${currentDepth + 1}/${maxDepth}] Researching: "${normalizedTaskFilename}" (Score: ${task.score}) ---`);

    try {
      // Ensure we have a description. If it's a new link added mid-flight, 
      // fetch it from the live registry or fallback to task.reason
      const liveRegistryItem = registry.getExistingFilesGuide()[normalizedTaskFilename];
      const description = liveRegistryItem ? liveRegistryItem.description : task.reason;

      // Step A: Generate optimized search query for Perplexity
      console.log(`[Pipeline] Generating optimized search query for: ${normalizedTaskFilename}`);
      const queryModel = rawModel.withStructuredOutput(SearchQuerySchema);
      const queryChain = QUERY_GENERATION_PROMPT.pipe(queryModel);

      const queryResult = await queryChain.invoke({
        user_goal: userGoal,
        link_filename: normalizedTaskFilename,
        link_description: description
      });

      console.log(`[Pipeline] Optimized Query: "${queryResult.search_query}"`);

      // Step B: Execute Perplexity Search
      console.log("[Pipeline] Fetching live web data...");
      const rawSearchResult = await perplexitySearchTool.invoke({ query: queryResult.search_query });

      if (typeof rawSearchResult !== "string" || rawSearchResult.trim().length === 0) {
        console.warn(`[Pipeline] Invalid or empty search result for ${normalizedTaskFilename}. Skipping to next task.`);
        currentDepth++;
        continue;
      }

      if (rawSearchResult.startsWith("Error:")) {
        console.warn(`[Pipeline] Search failed for ${normalizedTaskFilename}. Skipping to next task.`);
        currentDepth++;
        continue;
      }

      // Step C: Generate the OKF Markdown file
      console.log(`[Pipeline] Generating OKF Markdown for: ${normalizedTaskFilename}`);
      const existingFilesGuide = registry.getExistingFilesGuide();

      const generationResult = await generateOKFMarkdown(
        userGoal,
        personalContext,
        rawSearchResult,
        existingFilesGuide,
        targetFolderPath,
        normalizedTaskFilename
      );

      if (!generationResult) {
        console.warn(`[Pipeline] Markdown generation failed for ${normalizedTaskFilename}. Skipping registry update.`);
        await registry.syncWithDisk();
        currentDepth++;
        continue;
      }

      // Step D: Update Registry status for the just-processed task
      console.log(`[Pipeline] Registering "${generationResult.filename}" as PROCESSED.`);
      await registry.register(generationResult.filename, description, "processed");

      // =======================================================================
      // Step E: Register & DELTA SCORE newly proposed links
      // =======================================================================
      if (generationResult.newLinks.length > 0) {
        console.log(`[Pipeline] Found ${generationResult.newLinks.length} new proposed link(s). Processing...`);
        
        const freshLinksToScore = [];

        for (const link of generationResult.newLinks) {
          const normalizedLinkFilename = normalizeFilename(link.filename);
          // Only process truly new links that we haven't seen before
          if (!registry.has(normalizedLinkFilename)) {
            await registry.register(normalizedLinkFilename, link.description, "todo");
            freshLinksToScore.push({
              filename: normalizedLinkFilename,
              description: link.description
            });
            console.log(`[Pipeline] New link queued: "${normalizedLinkFilename}"`);
          }
        }

        // DELTA SCORING: Score only the newly discovered links on-the-fly!
        if (freshLinksToScore.length > 0) {
          console.log(`[Pipeline] Delta Scoring: Evaluating ${freshLinksToScore.length} newly discovered links...`);
          
          const deltaScoringResponse = await scoringChain.invoke({
            user_goal: userGoal,
            todo_links: JSON.stringify(freshLinksToScore, null, 2)
          });

          const validNewTasks = deltaScoringResponse.scored_links
            .filter(item => item.score >= scoreThreshold);

          if (validNewTasks.length > 0) {
            console.log(`[Pipeline] Adding ${validNewTasks.length} high-value new links to the active queue.`);
            // Add new high-scoring links to our dynamic execution queue
            dynamicQueue.push(...validNewTasks);
            // Re-sort the queue so any new "Score: 9" links jump straight to the front!
            dynamicQueue.sort((a, b) => b.score - a.score);
          } else {
            console.log(`[Pipeline] None of the new links met the score threshold of ${scoreThreshold}.`);
          }
        }
      }

      // Step F: Sync with disk to ensure self-healing and updated state
      await registry.syncWithDisk();

      // =======================================================================
      // Step G: Goal Adequacy Evaluation (Smart Circuit Breaker with Gatekeeper)
      // =======================================================================
      
      // Since dynamicQueue is always sorted, the next task is simply dynamicQueue[0]
      const nextTask = dynamicQueue[0];
      const hasPendingHighPriority = nextTask && nextTask.score >= 8;

      if (hasPendingHighPriority) {
        console.log(
          `[Pipeline] Skipping goal adequacy evaluation. ` +
          `Next task "${normalizeFilename(nextTask.filename)}" has a high-priority score of ${nextTask.score} (>= 8). ` +
          `We must process all critical leads first.`
        );
        isGoalMet = false; // Force loop to continue
      } else {
        const currentGuide = registry.getExistingFilesGuide();
        const processedSummary = Object.entries(currentGuide)
          .filter(([_, item]) => item.status === "processed")
          .map(([filename, item]) => `- ${filename}: ${item.description}`)
          .join("\n");

        console.log("[Pipeline] No high-priority tasks (Score >= 8) pending. Evaluating goal adequacy...");
        const evalModel = rawModel.withStructuredOutput(GoalEvaluationSchema);
        const evalChain = GOAL_EVALUATION_PROMPT.pipe(evalModel);

        const evaluation = await evalChain.invoke({
          user_goal: userGoal,
          processed_files_summary: processedSummary
        });

        console.log(`[Pipeline] Goal Evaluation: Achieved = ${evaluation.is_goal_achieved}. Reason: ${evaluation.reasoning}`);

        if (evaluation.is_goal_achieved) {
          isGoalMet = true;
          console.log("[Pipeline] Core goal achieved! Stopping the research loop early.");
        }
      }

    } catch (error) {
      console.error(`[Pipeline] Error processing task ${normalizedTaskFilename}:`, error);
      await registry.syncWithDisk();
    }

    currentDepth++;
  }

  console.log(`[Pipeline] Pipeline execution finished. Goal Met: ${isGoalMet}`);
}