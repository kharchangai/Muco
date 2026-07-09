// src/tools/researchTool/prompts.ts
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { z } from "zod";

// ============================================================================
// 1. SCHEMAS FOR STRUCTURED OUTPUT
// ============================================================================

export const NamingSchema = z.object({
  folder_name: z.string().describe("A clean, kebab-case name for the research folder based on the user's goal (e.g., 'alibaba-stock-drop')."),
  folder_description: z.string().describe("A short, 1-sentence description of what this research is about.")
});

export const FileSelectionSchema = z.object({
  relevant_files: z.array(z.string()).describe("List of exact filenames from the guide that might contain relevant information. Empty array if none.")
});

// ============================================================================
// 2. MODERN PROMPT TEMPLATES (Used with .withStructuredOutput() — NO format_instructions needed)
// ============================================================================

export const RESEARCH_NAMING_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system", 
    "You are a senior archivist. Your task is to analyze the user's goal and generate a folder identity."
  ],
  [
    "human", 
    "User Goal: \"{user_goal}\""
  ]
]);

export const PERSONAL_FILE_SELECTOR_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system", 
    `You are an intelligent research assistant and context-gatherer. 
Look at the user's personal memory guide below, which maps filenames to descriptions.
Your task is to cast a wide net and select ANY files that might contain relevant context, constraints, related projects, or user preferences.

INSTRUCTIONS:
1. NO EXACT MATCH REQUIRED: Look for indirect relationships. If the goal is about a technology (e.g., OKF, YAML), and a personal file mentions the user's software projects or coding preferences, IT IS RELEVANT.
2. BROADER CONTEXT: If a file might help the next AI agent understand *why* the user cares about this goal or *how* they plan to use it, include it.
3. BIAS TOWARDS INCLUSION: When in doubt, INCLUDE the file. It is much better to read an extra file than to miss crucial personal context.`
  ],
  [
    "human", 
    "User Goal: \"{user_goal}\"\n\nMemory Guide:\n{guide_json}"
  ]
]);

export const PERSONAL_DATA_EXTRACTOR_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system", 
    `You are a Strict Research Context Filter.
Read the personal file content below. Your ONLY job is to extract technical or project-related facts that directly impact WHAT needs to be researched.

CRITICAL FILTERING RULES (APPLY TO ALL DOMAINS):
1. IGNORE TONE & PERSONALITY: You MUST completely ignore any preferences about conversational tone (e.g., "friendly", "informal"), personality traits, or specific phrases the user likes/dislikes (e.g., "don't say how can I help you").
2. EXTRACT ONLY ACTIONABLE CONTEXT: Extract ONLY facts about the user's current projects, technical stack, target audience, specific problems, or architectural constraints that change HOW a search should be conducted.
3. FORMAT: Output a clean, bulleted list of ONLY the relevant facts.
4. If the file only contains conversational preferences or irrelevant personal details, output exactly: "NO_RELEVANT_INFO".
5. Output ONLY the extracted facts. No introductions or reasoning.`
  ],
  [
    "human", 
    "User Goal: \"{user_goal}\"\nFile Name: \"{file_name}\"\n\nContent:\n\"\"\"\n{file_content}\n\"\"\""
  ]
]);

export const AGENT_INSTRUCTION_GENERATOR_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system", 
    `You are a strict, no-nonsense Search Focus Architect. 
Your only job is to generate a highly concise, anonymous "Search Focus Directive" for an autonomous web search agent.

CRITICAL RULES FOR GENERATION:
1. NO BLOAT & NO PILLARS: Absolutely do NOT use terms like "Strategic Focus Pillars", "Pillar 1", or write long, dry academic paragraphs. 
2. ABSOLUTELY NO NAMES: Do NOT mention any personal names, user names, or project names (e.g., do NOT mention "Moko", "Mocu", etc.). Keep it 100% anonymous, objective, and technical.
3. EXTREMELY CONCISE: The entire output must be under 80 words. Use simple, direct bullet points.
4. SEARCH FOCUS ONLY: State only:
   - Core Focus (What to look for)
   - Priorities (What sources/details to value)
   - Exclusions (What to filter out)
5. PURE OUTPUT: Do NOT include any intro, outro, or explanation. Output ONLY the final bulleted directive.`
  ],
  [
    "human", 
    "User Goal: \"{user_goal}\"\n\nExtracted Personal Context:\n\"\"\"\n{extracted_context}\n\"\"\""
  ]
]);

export const FolderMatchSchema = z.object({
  has_relevant_folder: z.boolean().describe("True if an existing folder is highly relevant to the user's goal."),
  folder_name: z.string().nullable().describe("The exact name of the matched folder. Null if no match is found."),
  suggested_folder_name: z.string().nullable().describe("If no match is found, suggest a concise, kebab-case name for a new folder."),
  suggested_description: z.string().nullable().describe("If no match is found, provide a brief description for this new folder based on the goal.")
});

export const FOLDER_MATCH_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are an advanced routing assistant. Your job is to determine if any of the existing research folders are highly relevant to the user's new research goal.

Look at the existing folders and their descriptions below. 
1. If one of them already covers the same topic, set 'has_relevant_folder' to true and return the exact 'folder_name' (key). Set suggested fields to null.
2. If it's a completely new topic or no folders exist, set 'has_relevant_folder' to false and 'folder_name' to null. Then, generate a 'suggested_folder_name' (in kebab-case, max 4 words) and a 'suggested_description' based on the user's goal.`
  ],
  [
    "human",
    "User Goal: \"{user_goal}\"\n\nExisting Folders Guide:\n\"\"\"\n{guide_json}\n\"\"\""
  ]
]);


// ============================================================================
// 3. LEGACY-STYLE PROMPT (Used with StructuredOutputParser — format_instructions REQUIRED)
// ============================================================================

export const MarkdownGenerationSchema = z.object({
  title: z.string().describe("A concise, highly descriptive title for the concept (OKF style), derived ONLY from facts present in the source."),
  description: z.string().describe("A 1-2 sentence FACTUAL summary of what this specific file covers. State facts only — do not explain implications or causes yourself; use a link instead if that connection matters."),
  tags: z.array(z.string()).describe("2 to 4 highly relevant tags describing the factual content ONLY (entities, events, numbers)."),
  existing_links_used: z.array(z.string()).describe("List of filenames from the provided existing files guide that were linked in the content body."),
  new_links_proposed: z.array(z.object({
    filename: z.string().describe("A safe kebab-case filename (ending with .md) for the new proposed concept."),
    description: z.string().describe("A brief explanation of what this proposed file should cover and why it bridges this fact to the user's goal.")
  })).describe("Propose a new link whenever a concept is needed to connect this fact to the user's goal/history, and it's NOT covered in the existing files guide."),
  markdown_body: z.string().describe("The clean, extracted markdown content. Copy/extract facts VERBATIM or near-verbatim from the source — never write your own analysis of WHY something matters. If the relevance to the user's goal needs explaining, express it via a markdown link (e.g., [Some Concept](filename.md)) instead of writing prose about it. Do not add any conversational filler, intro, or outro.")
});

export const MARKDOWN_GENERATION_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a strict Data Extraction Engine and OKF (Open Knowledge Format) Architect. 
  Your job is to extract facts that already exist in the raw source and structure them, while connecting them to the user's goal ONLY through links — never through your own written analysis.

  ### MANDATORY RULES:

  1. **Zero-Analysis Policy on TEXT (CRITICAL)**:
     - Extract ONLY the parts of the "Raw Source Content" that directly relate to the "User Goal" and "Personal Context & Instructions".
     - NEVER write your own explanation of WHY a fact matters, what it implies, or what it might cause. That includes phrases like "this may indicate...", "this suggests...", "this could lead to...".
     - Facts, quotes, and numbers from the source can be kept verbatim, INCLUDING direct quotes from the source describing strategy/intent (since those are the source's own words, not your analysis).
     - If a sentence in the source is pure narrative filler with no fact and no direct quote, discard it.

  2. **Linking Instead of Analysis (CRITICAL — this replaces the need to explain "why")**:
     - Whenever this content's relevance to the "User Goal" is NOT obvious on its own, DO NOT write a sentence explaining the connection yourself.
     - Instead, ADD A LINK to a file (existing or newly proposed) that carries that connective context. This is how relevance gets communicated — through links, not prose.
     - First, check the "Existing Files Guide". If a relevant concept already exists there, use its EXACT filename (e.g., [Concept Name](existing_file.md)).
     - If no existing file covers it, PROPOSE a new file for that missing connective concept — do not skip linking just because nothing exists yet. Missing a needed link is a bigger mistake than proposing one.
     - Do NOT add links that are irrelevant, decorative, or already fully explained by facts already present in the body — only link when it fills a real gap in connecting this content to the user's goal.

  3. **Output Format**: Strictly follow the JSON schema. The 'markdown_body' must contain raw, direct facts and quotes only — connection to relevance/context happens via links, never via your own written interpretation.

  {format_instructions}`
    ],
    [
      "human",
      `### Inputs:
      - **User Goal**: "{user_goal}"
      - **Personal Context & Instructions**: "{personal_context}"
      - **Raw Source Content**:
      """
      {raw_content}
      """
      - **Existing Files Guide (Processed & Planned)**:
      """
      {existing_files_guide}
      """`
  ]
]);

// ============================================================================
// 4. RESEARCH PIPELINE PROMPTS (Used with .withStructuredOutput() — NO format_instructions needed)
// ============================================================================

/**
 * Zod Schema for evaluating and scoring pending research links.
 * Ensures the output is a strictly formatted array of objects.
 */
export const LinkScoringSchema = z.object({
  scored_links: z.array(z.object({
    filename: z.string().describe("The exact filename of the concept/link from the provided list."),
    score: z.number().min(0).max(9).describe("Relevance score from 0 to 9 based on the user intent."),
    reason: z.string().describe("A very short, 1-sentence justification for why this score was given.")
  })).describe("List of all provided links, strictly sorted by score in descending order (highest score first).")
});

/**
 * Prompt Template for the Link Prioritization Engine.
 * Instructs the model to evaluate how each link serves the user's primary goal.
 */
export const LINK_SCORING_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a highly precise Content Evaluation and Relevance Architect for an autonomous AI agent.
Your core task is to evaluate a list of pending research links (todo) and score each one strictly based on the "User Goal".

### SCORING CRITERIA (0 to 9):
- 7 to 9 (Excellent/Critical): The link's description indicates it is directly aligned with the user goal, highly relevant, and provides essential context.
- 4 to 6 (Medium/Contextual): The link is somewhat related but might lack direct impact, or serves only as background information.
- 0 to 3 (Poor/Irrelevant): The link is largely disconnected from the primary user goal and would waste research resources.

### RULES:
1. Evaluate EVERY link provided in the input.
2. Score each link using the 0-9 scale.
3. Provide a brief, logical reason for the score.
4. Return the final list sorted from the highest score to the lowest.`
  ],
  [
    "human",
    `### Inputs:
- **User Goal**: "{user_goal}"

- **List of Links to Evaluate**:
"""
{todo_links}
"""`
  ]
]);

/**
 * Zod Schema for the optimized search query.
 * Ensures the model returns a clean, isolated string ready to be passed directly to the Perplexity tool.
 */
export const SearchQuerySchema = z.object({
  search_query: z.string().describe("A highly optimized, keyword-dense search query designed specifically for the Perplexity search engine.")
});

/**
 * Prompt Template for generating a precise web search query.
 * It combines the user's overarching goal with the specific contextual needs of a pending link.
 */
export const QUERY_GENERATION_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are a Search Query Architect for an autonomous research agent (Project Moko).
Your task is to generate a highly effective, precise internet search query for the Perplexity search engine.

### STRICT RULES:
1. FOCUS ON FACTS: The query must target explicit facts, data points, or specific events (Zero-Analysis Policy).
2. COMBINE CONTEXT: Use the "Link Description" to know exactly WHAT is missing. Use the "User Goal" to know WHY we need it, ensuring the query is perfectly aligned.
3. BE CONCISE: Avoid conversational fluff (e.g., do not use "Search for...", "Find me..."). Use keyword-dense, direct phrasing.
4. PERPLEXITY OPTIMIZED: Phrase the query as a direct question or a precise topical lookup that an AI search engine can easily parse to find up-to-date information.`
  ],
  [
    "human",
    `### Inputs:
- **User Goal**: "{user_goal}"
- **Target Link (Filename)**: "{link_filename}"
- **Link Description**: "{link_description}"`
  ]
]);

/**
 * Zod Schema for Goal Adequacy Evaluation.
 * Returns a strict boolean flag to control the agent's main execution loop.
 */
export const GoalEvaluationSchema = z.object({
  is_goal_achieved: z.boolean().describe("Set to TRUE if the currently processed information fully satisfies the User Goal. FALSE if more research is required."),
  reasoning: z.string().describe("A very brief, one-sentence logical explanation supporting the boolean decision.")
});

/**
 * Prompt Template for the Adequacy Evaluator (Smart Circuit Breaker).
 * Acts as an objective supervisor comparing the collected facts against the original goal.
 */
export const GOAL_EVALUATION_PROMPT = ChatPromptTemplate.fromMessages([
  [
    "system",
    `You are the Final Adequacy Evaluator for Project Moko.
Your responsibility is to act as a strict supervisor and determine if the agent's current research loop should be terminated.

### STRICT RULES:
1. Compare the "User Goal" with the "Processed Facts/Files".
2. Ask yourself: Can the user's primary objective be fully addressed using ONLY the facts currently collected?
3. If YES -> Set is_goal_achieved to TRUE. (Do not waste resources continuing).
4. If NO -> Set is_goal_achieved to FALSE. (Identify what critical piece of the puzzle is still missing).
5. DO NOT be overly demanding. If the core question is answered factually, stop the search. We strictly follow a Zero-Analysis Policy.`
  ],
  [
    "human",
    `### Inputs:
- **User Goal**: "{user_goal}"

- **Currently Processed Facts/Files (Completed Research)**:
"""
{processed_files_summary}
"""`
  ]
]);


export const AnalysisDecisionSchema = z.object({
  thought: z.string().describe(
    "Your reasoning about what to do next based on the goal, current findings, and how to integrate new data."
  ),
  updated_analysis: z.string().describe(
    "The COMPLETE, fully integrated, and updated analysis report body. You MUST merge the new facts from the last read file into the existing analysis structure. Reorganize, edit, or update existing headings to maintain a single, cohesive, and comprehensive document. Do NOT just append new sections at the bottom if they logically belong under existing headings."
  ),
  next_file_to_read: z.string().nullable().describe(
    "The exact filename of the next file to read from the available list. Return null if finished."
  ),
  is_finished: z.boolean().describe(
    "Set to true ONLY if the goal is fully answered or no useful files remain."
  )
});

export const ANALYSIS_AGENT_PROMPT = ChatPromptTemplate.fromTemplate(`
You are an expert Data Synthesis Agent.
Your mission is to maintain, update, and build a single, comprehensive, and fully integrated analysis report to answer the user's goal.

User Goal: {user_goal}
Personal Context: {personal_context}

--- CURRENT STATE ---
Current Analysis Report (Read this carefully to know what has been analyzed so far):
{current_analysis}

Last Read File Content (Analyze this and integrate its facts into the report above):
{last_file_content}

Available Unread Files:
{available_files}

--- INSTRUCTIONS FOR INTEGRATION ---
1. Carefully read the "Current Analysis Report" and the "Last Read File Content".
2. Extract explicit facts from the "Last Read File Content" that are relevant to the user's goal.
3. INTEGRATE these new facts into the "Current Analysis Report" to produce the "updated_analysis".
   - Do NOT simply append new sections or repeat existing headings.
   - Merge new information into existing sections (e.g., financial metrics, market competition, regulatory issues) where they logically belong.
   - Update existing figures, dates, or facts if the new file provides more accurate, corrected, or detailed information.
   - Keep the entire document unified, logical, and flowing.
4. Review the "Available Unread Files" list.
5. If the goal is not yet fully answered, choose the MOST RELEVANT file from the available list to read next and put its name in "next_file_to_read".
6. If you have fully answered the goal, or if no available files are relevant, set "is_finished" to true and "next_file_to_read" to null.
7. NEVER hallucinate filenames. Only pick from the provided list.
`);
