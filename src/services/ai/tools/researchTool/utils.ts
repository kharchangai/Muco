import { exists, readTextFile, writeTextFile, mkdir, BaseDirectory } from '@tauri-apps/plugin-fs';
import { join, appDataDir } from '@tauri-apps/api/path';
import { getAsyncLLM } from "../memory_tools"; 
import { FOLDER_MATCH_PROMPT, FolderMatchSchema } from "./prompts";

/**
 * Ensures the research directory and guide.json exist.
 * Uses LLM to find a matching folder or generate a new one.
 * Automatically updates guide.json and creates the new folder if needed.
 * @returns The ABSOLUTE path of the target folder.
 */
export async function findRelevantResearchFolder(userGoal: string): Promise<string | null> {
  try {
    const researchRootDir = 'research';
    const guideFileName = 'guide.json';
    
    // Get base directory
    const baseDir = await appDataDir();
    const guideRelativePath = await join(researchRootDir, guideFileName);

    // 1. Ensure 'research' folder exists, create if not
    const researchExists = await exists(researchRootDir, { baseDir: BaseDirectory.AppData });
    if (!researchExists) {
      console.log("[Research Router] 'research' folder missing. Creating it...");
      await mkdir(researchRootDir, { baseDir: BaseDirectory.AppData, recursive: true });
    }

    // 2. Ensure 'guide.json' exists, create if not with an empty object
    const guideExists = await exists(guideRelativePath, { baseDir: BaseDirectory.AppData });
    if (!guideExists) {
      console.log("[Research Router] 'guide.json' missing. Creating it...");
      await writeTextFile(guideRelativePath, JSON.stringify({}, null, 2), { baseDir: BaseDirectory.AppData });
    }

    // 3. Read and parse guide.json
    const rawGuide = await readTextFile(guideRelativePath, { baseDir: BaseDirectory.AppData });
    let guideJson: Record<string, string> = {};
    try {
      guideJson = JSON.parse(rawGuide);
    } catch (e) {
      console.warn("[Research Router] Failed to parse guide.json. Resetting to empty object.");
      guideJson = {};
    }

    // 4. Query LLM to check for matches or get suggestions
    console.log("[Research Router] Querying LLM for folder routing...");
    const rawModel = await getAsyncLLM();
    const structuredModel = rawModel.withStructuredOutput(FolderMatchSchema);
    const chain = FOLDER_MATCH_PROMPT.pipe(structuredModel);

    const matchResult = await chain.invoke({
      user_goal: userGoal,
      guide_json: JSON.stringify(guideJson, null, 2)
    });

    console.log("[Research Router] LLM Decision:", JSON.stringify(matchResult, null, 2));

    // 5. Handle Case A: Match Found
    if (matchResult.has_relevant_folder && matchResult.folder_name) {
      const targetFolder = matchResult.folder_name;
      const folderRelativePath = await join(researchRootDir, targetFolder);
      const folderExistsOnDisk = await exists(folderRelativePath, { baseDir: BaseDirectory.AppData });
      
      if (folderExistsOnDisk) {
        const absoluteFolderPath = await join(baseDir, folderRelativePath);
        console.log(`[Research Router] Proceeding with existing folder: "${absoluteFolderPath}"`);
        return absoluteFolderPath;
      } else {
        console.warn(`[Research Router] Matched folder "${targetFolder}" is missing on disk. Creating a new one instead.`);
        // Falls through to Case B if the matched folder was manually deleted
      }
    }

    // 6. Handle Case B: No Match (Create New Folder & Update Guide)
    console.log("[Research Router] No valid match found. Generating new folder...");
    
    // Use LLM suggestions or fallback names if LLM fails to provide them
    const newFolderName = matchResult.suggested_folder_name || `topic-${Date.now()}`;
    const newDescription = matchResult.suggested_description || `Research regarding: ${userGoal}`;

    const newFolderRelativePath = await join(researchRootDir, newFolderName);
    const newFolderAbsolutePath = await join(baseDir, newFolderRelativePath);

    // 6.1 Create the new folder on disk
    await mkdir(newFolderRelativePath, { baseDir: BaseDirectory.AppData, recursive: true });
    console.log(`[Research Router] Created new folder at: "${newFolderAbsolutePath}"`);

    // 6.2 Update guide.json with the new entry
    guideJson[newFolderName] = newDescription;
    await writeTextFile(guideRelativePath, JSON.stringify(guideJson, null, 2), { baseDir: BaseDirectory.AppData });
    console.log(`[Research Router] Successfully updated guide.json with "${newFolderName}"`);

    // Return the newly created absolute path
    return newFolderAbsolutePath;

  } catch (error) {
    console.error("[Research Router] Critical error in folder routing:", error);
    return null;
  }
}