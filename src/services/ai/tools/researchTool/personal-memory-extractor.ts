// src/tools/researchTool/personal-memory-extractor.ts
import { exists, readTextFile, writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { getAsyncLLM } from "../memory_tools";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { 
  PERSONAL_FILE_SELECTOR_PROMPT, 
  PERSONAL_DATA_EXTRACTOR_PROMPT, 
  AGENT_INSTRUCTION_GENERATOR_PROMPT,
  FileSelectionSchema
} from "./prompts";

export interface PersonalExtractionResult {
  targetFolder: string;
  distilledPrompt: string;
}

/**
 * Extracts personal memory based on the user's goal and saves the context
 * directly into the provided target folder path.
 * 
 * @param userGoal - The main research goal.
 * @param targetFolderPath - The ABSOLUTE path of the destination folder (handled by the router).
 */
export async function executePersonalResearch(
  userGoal: string, 
  targetFolderPath: string
): Promise<PersonalExtractionResult | null> {
  const model = await getAsyncLLM();
  
  try {
    console.log(`[Memory Extractor] Starting extraction for folder: "${targetFolderPath}"`);

    // Define paths for the target files using the provided absolute folder path
    const extractedFactsPath = await join(targetFolderPath, 'extracted-personal-context.md');
    const instructionsPath = await join(targetFolderPath, 'agent-instructions.txt');

    // ----------------------------------------------------------------------
    // STEP 1: Read Personal Guide & Select Relevant Files
    // ----------------------------------------------------------------------
    const personalGuidePath = await join('memory', 'Personal', 'guide.json');
    
    // Using BaseDirectory for relative internal app paths
    if (!(await exists(personalGuidePath, { baseDir: BaseDirectory.AppData }))) {
      console.log("[Memory Extractor] No personal guide.json found. Skipping personal extraction.");
      return null;
    }

    const personalGuideContent = await readTextFile(personalGuidePath, { baseDir: BaseDirectory.AppData });
    
    // Use the modern withStructuredOutput to prevent parsing errors
    const structuredModel = model.withStructuredOutput(FileSelectionSchema);
    const selectionChain = PERSONAL_FILE_SELECTOR_PROMPT.pipe(structuredModel);

    const selectionResult = await selectionChain.invoke({ 
      user_goal: userGoal, 
      guide_json: personalGuideContent
    });

    const filesToRead = selectionResult.relevant_files;
    if (!filesToRead || filesToRead.length === 0) {
      console.log("[Memory Extractor] No personal files deemed relevant for this goal.");
      return null;
    }
    console.log(`[Memory Extractor] Relevant files identified: ${filesToRead.join(', ')}`);

    // ----------------------------------------------------------------------
    // STEP 2: Read, Extract, and Combine Relevant Data
    // ----------------------------------------------------------------------
    let combinedExtractedFacts = "";
    const extractionChain = PERSONAL_DATA_EXTRACTOR_PROMPT.pipe(model).pipe(new StringOutputParser());

    for (const fileName of filesToRead) {
      const filePath = await join('memory', 'Personal', fileName);
      if (!(await exists(filePath, { baseDir: BaseDirectory.AppData }))) {
        console.warn(`[Memory Extractor] Warning: File ${fileName} selected but not found on disk.`);
        continue;
      }

      const fileContent = await readTextFile(filePath, { baseDir: BaseDirectory.AppData });
      
      const extractedText = await extractionChain.invoke({
        user_goal: userGoal,
        file_name: fileName,
        file_content: fileContent
      });
      
      if (extractedText.trim() !== "NO_RELEVANT_INFO") {
        combinedExtractedFacts += `\n### From ${fileName}:\n${extractedText.trim()}\n`;
      }
    }

    if (!combinedExtractedFacts.trim()) {
      console.log("[Memory Extractor] Files were read, but no specific relevant data was extracted.");
      return null;
    }

    // Write extracted facts to the target folder (Absolute path used, so no baseDir option is needed)
    await writeTextFile(extractedFactsPath, combinedExtractedFacts.trim());
    console.log("[Memory Extractor] Saved fresh extracted context to research folder.");

    // ----------------------------------------------------------------------
    // STEP 3: Generate Instructions for the Next Agent
    // ----------------------------------------------------------------------
    const instructionChain = AGENT_INSTRUCTION_GENERATOR_PROMPT.pipe(model).pipe(new StringOutputParser());
    
    const finalInstructions = await instructionChain.invoke({
      user_goal: userGoal,
      extracted_context: combinedExtractedFacts
    });
    
    // Write agent instructions to the target folder
    await writeTextFile(instructionsPath, finalInstructions.trim());
    console.log("[Memory Extractor] Generated and saved fresh instructions for the autonomous agent.");

    return {
      targetFolder: targetFolderPath,
      distilledPrompt: finalInstructions.trim()
    };

  } catch (error) {
    console.error("[Memory Extractor] Critical error during extraction:", error);
    throw error;
  }
}