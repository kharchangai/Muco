// src/tools/researchTool/source-reader.ts
import { exists, readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';

export interface SourceDocuments {
  [fileName: string]: string;
}

interface FileHashes {
  [fileName: string]: string;
}

/**
 * Generates a SHA-256 hash of the given text content using the native Web Crypto API.
 */
async function calculateSHA256(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Reads only new or modified .txt files from the source folder.
 * Saves and compares file hashes in 'source_hashes.json' inside the active research folder.
 * 
 * @param sourceFolderPath Path to the folder containing raw .txt files.
 * @param targetResearchFolderPath Path to the active research folder where results are saved.
 */
export async function readLocalTextSources(
  sourceFolderPath: string,
  targetResearchFolderPath: string
): Promise<SourceDocuments | null> {
  try {
    console.log(`[Source Reader] Checking source folder: "${sourceFolderPath}"`);

    // 1. Check if the source folder exists
    const folderExists = await exists(sourceFolderPath);
    if (!folderExists) {
      console.warn(`[Source Reader] Source folder not found: "${sourceFolderPath}"`);
      return null;
    }

    // 2. Load existing hashes if they exist in the active research folder
    const hashFilePath = await join(targetResearchFolderPath, 'source_hashes.json');
    let existingHashes: FileHashes = {};

    if (await exists(hashFilePath)) {
      try {
        const hashContent = await readTextFile(hashFilePath);
        existingHashes = JSON.parse(hashContent);
        console.log("[Source Reader] Loaded existing file hashes manifest.");
      } catch (parseError) {
        console.warn("[Source Reader] Could not parse source_hashes.json, starting fresh.", parseError);
      }
    }

    // 3. Read all entries in the directory
    const entries = await readDir(sourceFolderPath);
    const sources: SourceDocuments = {};
    const updatedHashes: FileHashes = { ...existingHashes };
    let hasNewOrModifiedFiles = false;

    for (const entry of entries) {
      // Process only files that end with .txt
      if (entry.isFile && entry.name.toLowerCase().endsWith('.txt')) {
        const filePath = await join(sourceFolderPath, entry.name);
        const content = await readTextFile(filePath);
        
        // Calculate current file hash
        const currentHash = await calculateSHA256(content);

        // Check if the file is unchanged
        if (existingHashes[entry.name] === currentHash) {
          console.log(`[Source Reader] Skipping unchanged file: "${entry.name}"`);
          continue; 
        }

        console.log(`[Source Reader] Reading new/modified file: "${entry.name}"`);
        sources[entry.name] = content;
        updatedHashes[entry.name] = currentHash;
        hasNewOrModifiedFiles = true;
      }
    }

    // 4. Save the updated hashes back to the active research folder if changes occurred
    if (hasNewOrModifiedFiles) {
      await writeTextFile(hashFilePath, JSON.stringify(updatedHashes, null, 2));
      console.log(`[Source Reader] Saved updated hashes to: "${hashFilePath}"`);
    }

    const fileCount = Object.keys(sources).length;
    console.log(`[Source Reader] Loaded ${fileCount} new or modified source files.`);
    
    return fileCount > 0 ? sources : null;

  } catch (error) {
    console.error("[Source Reader] Error reading source directory:", error);
    return null;
  }
}