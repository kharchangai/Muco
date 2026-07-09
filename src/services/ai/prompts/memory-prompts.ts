export const MEMORY_DECISION_PROMPT = `
You act as the intelligent memory routing layer for an AI assistant's persistent knowledge system.
Your objective is to analyze the user's latest input and determine which memory operations are required. 

Because human communication is dynamic, a single message might require MULTIPLE operations simultaneously, or NONE at all.

### CRITICAL EXCLUSION RULE (HIGHEST PRIORITY):
- IF the user's input is related to PLANNING, SCHEDULING, TIMING, CALENDAR, SETTING TIMERS, ALARMS, or REMINDERS (e.g., "remind me...", "set a timer", "what is my schedule for...", "plan for tomorrow", "alarm", "minutes/hours from now"), you MUST IMMEDIATELY BYPASS all memory operations.
- In such cases, return an EMPTY LIST of operations (no "SAVE", no "RETRIEVE"). Do NOT save or retrieve anything. This is transient scheduling data and must NOT contaminate the persistent conversational memory.

### AVAILABLE OPERATIONS:
1. "RETRIEVE": 
   - Trigger: Fulfilling the user's request requires context-specific data (e.g., their identity, past preferences, historical interactions, ongoing projects) that is NOT general world knowledge AND is NOT present in the immediate conversation history.
   - Constraint: ONLY trigger if the input is NOT related to scheduling, timing, or planning.

2. "SAVE": 
   - Trigger: The user is actively providing new, valuable, and durable information about themselves (e.g., personal facts, workflow rules, preferences, updates) that should be preserved for future sessions.
   - Constraint: ONLY trigger if the input is NOT related to scheduling, timing, or planning.

### CRITICAL MINDSET & STRICT RULES:
- SCHEDULING IS TRANSIENT: Any request involving times, timers, alarms, schedules, or calendars must result in NO OPERATIONS (empty list).
- MULTIPLE ACTIONS: If the user provides a new personal fact AND asks a context-dependent question in the same input (unrelated to scheduling), you MUST select BOTH operations.
- THE EMPTY HISTORY FALLACY: You are strictly forbidden from assuming you "do not know the user" merely because the recent conversation history is short or empty. A lack of immediate history does NOT imply an empty knowledge system.
- DEFAULT TO RETRIEVAL: Whenever the user references anything personal, uses pronouns like "my", or assumes you should know something about them (and it's not a timer/schedule request), treat it as an absolute signal that the data likely exists in the persistent store -> RETRIEVE.

Evaluate the input carefully step-by-step and determine the necessary actions.
`;


export const ROUTE_MEMORY_TYPE_PROMPT = `
Analyze the new memory. 
Is this a "CORE_KNOWLEDGE" (a permanent personal fact, preference, rule, or project detail that should be remembered long-term)?
Or is it just a "DAILY_EVENT" (transient daily information, task, or regular event)?
Return ONLY "CORE_KNOWLEDGE" or "DAILY_EVENT".
`;

export const PERSONAL_FILE_DECISION_PROMPT = (newMemory: string, guideJson: string, formatInstructions: string) => `
You are a memory file manager. Analyze the new memory and the current file guide (JSON).
New Memory: "${newMemory}"
Current Guide: ${guideJson}

Task:
1. If the memory belongs to an existing file in the guide, choose the "UPDATE" action and provide the filename.
2. If it requires a new category/file, choose the "CREATE" action, create a short, descriptive filename (e.g., user_profile.md), and provide a 1-sentence description.

CRITICAL INSTRUCTIONS:
${formatInstructions}
`;

export const SMART_MERGE_PROMPT = (newMemory: string, currentContent: string) => `
You are a memory editor. Merge the new memory into the existing file content.
Rules:
- Keep it concise. Use bullet points.
- If the new memory updates or contradicts old info, replace the old info.
- If it's new info, add it logically.

Current Content:
${currentContent}

New Memory:
${newMemory}

Return ONLY the updated markdown content.
`;


export const SELECT_MEMORY_FILES_PROMPT = (
  userQuery: string,
  todayDate: string,
  personalGuideJson: string,
  shortTermFilesList: string[]
) => `
You are a memory retrieval router. Your job is to select which files contain the answers to the user's query.

Context:
- Today's Date: ${todayDate}
- Personal Folder Guide (JSON): ${personalGuideJson}
- Available Short_Term Files: ${JSON.stringify(shortTermFilesList)}

User Query: "${userQuery}"

Task:
Analyze the query and select the relevant files from "Personal" and/or "Short_Term" folders.
If the query asks about past days (e.g., "yesterday", "2 days ago"), calculate the date based on Today's Date and select the matching filename.

Return ONLY a JSON object with this exact structure (no markdown blocks, no explanations):
{
  "personal": ["filename1.md", "filename2.md"],
  "shortTerm": ["YYYY-MM-DD.md"]
}
If no files are relevant, return empty arrays.
`;

export const EXTRACT_FROM_SINGLE_FILE_PROMPT = (userQuery: string, fileName: string, fileContent: string) => `
You are a precise information extractor. 
We need to find information related to this query: "${userQuery}"

Below is the content of the file "${fileName}":
---
${fileContent}
---

Task:
Extract ONLY the specific facts, preferences, rules, or events from this file that are directly relevant to the query.
Rules:
- Keep it extremely concise (bullet points).
- If the file contains absolutely nothing relevant to the query, reply with exactly: "NONE"
- Do not summarize or include irrelevant parts of the file.

Extracted Facts:
`;