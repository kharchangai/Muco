import { ChatOpenAI } from "@langchain/openai";
import { JsonOutputParser, StringOutputParser } from "@langchain/core/output_parsers";
import { ChatPromptTemplate } from "@langchain/core/prompts";

// Import Tauri v2 FS and Path APIs to replace Node.js 'fs' and 'path'
import { readTextFile, exists } from '@tauri-apps/plugin-fs';
import { BaseDirectory } from '@tauri-apps/api/path';

import { 
    ROUTER_SYSTEM_PROMPT, 
    ROUTER_HUMAN_PROMPT,
    EXTRACTOR_SYSTEM_PROMPT,
    EXTRACTOR_HUMAN_PROMPT
} from "../prompts/context_builder_prompts";

export interface ExtractedContext {
    source_file: string;
    relevant_info: string;
}

export async function buildMemoryContext(
    recentMessages: string[],
    llm: ChatOpenAI
): Promise<ExtractedContext[]> {
    
    // Define relative paths within Tauri's AppLocalData directory
    const personalDir = "memory/Personal";
    const guidePath = `${personalDir}/guide.json`;

    // 1. Check if guide.json exists using Tauri FS API
    const guideExists = await exists(guidePath, { baseDir: BaseDirectory.AppData });
    if (!guideExists) {
        console.warn("[Context Builder] guide.json not found in personal memory. Skipping memory context extraction.");
        return [];
    }

    // Read guide.json content asynchronously
    const guideContent = await readTextFile(guidePath, { baseDir: BaseDirectory.AppData });

    // ==========================================
    // PHASE 1: The Router (Select relevant files)
    // ==========================================
    console.log("[Context Builder] Phase 1: Routing - Identifying relevant memory files...");
    
    const routerParser = new JsonOutputParser<string[]>();
    const routerPrompt = ChatPromptTemplate.fromMessages([
        ["system", ROUTER_SYSTEM_PROMPT],
        ["human", ROUTER_HUMAN_PROMPT]
    ]);

    const routerChain = routerPrompt.pipe(llm).pipe(routerParser);

    let selectedFiles: string[] = [];
    try {
        selectedFiles = await routerChain.invoke({
            guide_content: guideContent,
            new_messages: recentMessages.join("\n")
        });
    } catch (error) {
        console.error("[Context Builder] Failed to parse router output. Assuming no files selected.", error);
        return [];
    }

    if (!selectedFiles || selectedFiles.length === 0) {
        console.log("[Context Builder] No relevant personal files identified for this conversation.");
        return [];
    }

    console.log(`[Context Builder] Identified ${selectedFiles.length} relevant file(s):`, selectedFiles);

    // ==========================================
    // PHASE 2: The Extractor (Read & Extract parallelly)
    // ==========================================
    console.log("[Context Builder] Phase 2: Extracting - Reading selected files and extracting relevant info...");

    const extractorParser = new StringOutputParser();
    const extractorPrompt = ChatPromptTemplate.fromMessages([
        ["system", EXTRACTOR_SYSTEM_PROMPT],
        ["human", EXTRACTOR_HUMAN_PROMPT]
    ]);
    const extractorChain = extractorPrompt.pipe(llm).pipe(extractorParser);

    // Map each selected file to an extraction Promise (Runs them in parallel for speed)
    const extractionPromises = selectedFiles.map(async (fileName) => {
        // Prevent Path Traversal for security (essential for open-source projects)
        const safeFileName = fileName.replace(/^(\.\.(\/|\\|$))+/, '');
        const filePath = `${personalDir}/${safeFileName}`;
        
        const fileExists = await exists(filePath, { baseDir: BaseDirectory.AppData });
        if (!fileExists) {
            console.warn(`[Context Builder] Warning: File ${safeFileName} was selected by the router but does not exist on disk.`);
            return null;
        }

        // Read file using Tauri FS API
        const fileContent = await readTextFile(filePath, { baseDir: BaseDirectory.AppData });

        const extractedText = await extractorChain.invoke({
            new_messages: recentMessages.join("\n"),
            file_name: safeFileName,
            file_content: fileContent
        });

        // Filter out files where the LLM decided there was no relevant info
        if (extractedText.trim() === "NO_RELEVANT_INFO") {
            return null;
        }

        return {
            source_file: safeFileName,
            relevant_info: extractedText
        } as ExtractedContext;
    });

    // Wait for all extractions to finish
    const results = await Promise.all(extractionPromises);

    // Filter out null values (missing files or NO_RELEVANT_INFO)
    const finalContext = results.filter((item): item is ExtractedContext => item !== null);

    console.log(`[Context Builder] Extraction complete. ${finalContext.length} file(s) yielded relevant context.`);
    
    // Return the final array of extracted contexts to be used by the NEXT Agent
    return finalContext;
}