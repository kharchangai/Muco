export const CREATE_MEMORY_SEARCH_QUERY_PROMPT = `
You prepare semantic search queries for a personal AI memory system.

Convert the user's latest message into one concise search query that can be
used to retrieve relevant past conversations.

Instructions:
- Preserve the user's main intent.
- Preserve important names, entities, projects, topics, preferences,
  decisions, problems, plans, and time references.
- Resolve references only when the meaning is clear from the message itself.
- Do not answer the user.
- Do not explain your reasoning.
- Do not add information that is not present in the user's message.
- Write the query in the same language as the user's message.
- Return only the final search query as plain text.

User message:
{userMessage}
`;

export const SELECT_RELEVANT_MEMORY_PROMPT = `
You select relevant past conversations for a personal AI assistant.

The user's current message is:
<current_user_message>
{userMessage}
</current_user_message>

The semantic search query is:
<search_query>
{searchQuery}
</search_query>

The following past conversation turns were retrieved by semantic similarity:
<candidate_turns>
{candidateTurns}
</candidate_turns>

Your tasks:
1. Select only the candidate turns that are genuinely relevant and useful for
   understanding or answering the user's current message.
2. Do not select a turn merely because it contains similar words.
3. For each selected turn, decide whether earlier or later conversation turns
   are needed to understand or complete its context.
4. Set "includePrevious" to true only when up to two previous turns are needed.
5. Set "includeNext" to true only when up to two following turns are needed.
6. If no candidate is relevant, return an empty "selectedTurns" array.
7. Use only candidate IDs that appear in the provided candidate list.

{formatInstructions}
`;


export const memoryGatePrompt = `
You are a short-term memory gate for a personal AI assistant.

Your task is to decide whether the current user message needs conversational memory.

Available memory sources:

1. Recent turns:
Use this when the user refers to the immediate conversation, such as:
- "what did I say?"
- "continue"
- "that project"
- "do it again"
- unclear pronouns or references that depend on recent messages
- a follow-up question

2. Relevant past short-term memory search:
Use this when the user refers to a topic, decision, plan, preference, task, or detail that may have appeared earlier but is not necessarily in the latest turns.

3. Both:
Use both sources when the user needs immediate context and possibly older related context.

4. No memory:
Use no memory when the message is self-contained and can be answered without previous conversation context.

Return only the structured result.

Rules:
- Choose the minimum necessary memory.
- Do not request memory merely because the message contains a topic.
- Use recent turns only when immediate context is genuinely required.
- Use retrieval only when past relevant information could materially improve the answer.
- recentTurnCount must be between 0 and 10.
`;