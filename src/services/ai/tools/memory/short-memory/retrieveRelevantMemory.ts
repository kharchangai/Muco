import {
  BaseDirectory,
  exists,
  readDir,
  readTextFile,
} from "@tauri-apps/plugin-fs";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { StructuredOutputParser } from "@langchain/core/output_parsers";
import { z } from "zod";

import { getAsyncLLM } from "../../../llm";
import {
  EmbeddingListItem,
  textSimilarity,
} from "../../textSimilarity";
import {
  CREATE_MEMORY_SEARCH_QUERY_PROMPT,
  SELECT_RELEVANT_MEMORY_PROMPT,
} from "./prompts";

export interface MemoryMessage {
  content: string;
}

export interface ShortTermTurn {
  id: string;
  createdAt: string;
  user: MemoryMessage;
  assistant: MemoryMessage;
  embedding?: number[];
}

export interface AgentMemoryMessage {
  role: "user" | "assistant";
  content: string;
}

interface ShortTermMemoryFile {
  date: string;
  turns: ShortTermTurn[];
}

interface LoadedMemoryFile {
  fileName: string;
  turns: ShortTermTurn[];
}

interface IndexedMemoryTurn {
  candidateId: string;
  fileName: string;
  turnIndex: number;
  globalIndex: number;
  turn: ShortTermTurn;
}

interface ScoredMemoryTurn extends IndexedMemoryTurn {
  score: number;
}

interface SelectedMemoryTurn {
  candidateId: string;
  includePrevious: boolean;
  includeNext: boolean;
}

export interface RelevantMemoryCandidate {
  id: string;
  originalTurnId: string;
  createdAt: string;
  score: number;
  userContent: string;
  assistantContent: string;
}

export interface RetrieveRelevantShortMemoryResult {
  searchQuery: string;
  candidates: RelevantMemoryCandidate[];
  selectedTurnIds: string[];
  messages: AgentMemoryMessage[];
}

export interface RetrieveRelevantShortMemoryOptions {
  maxFiles?: number;
  candidateLimit?: number;
  neighborCount?: number;
}

const SHORT_MEMORY_DIR = "memory/short-memory";

const DEFAULT_MAX_FILES = 5;
const DEFAULT_CANDIDATE_LIMIT = 5;
const DEFAULT_NEIGHBOR_COUNT = 2;

const relevanceDecisionSchema = z.object({
  selectedTurns: z.array(
    z.object({
      candidateId: z.string(),
      includePrevious: z.boolean(),
      includeNext: z.boolean(),
    }),
  ),
});

type RelevanceDecision = z.infer<typeof relevanceDecisionSchema>;

const relevanceParser = StructuredOutputParser.fromZodSchema(
  relevanceDecisionSchema,
);

function isDateMemoryFile(fileName: string): boolean {
  return /^\d{4}-\d{2}-\d{2}\.json$/.test(fileName);
}

function isValidEmbedding(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) => typeof item === "number" && Number.isFinite(item),
    )
  );
}

function isValidTurn(value: unknown): value is ShortTermTurn {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const turn = value as Partial<ShortTermTurn>;

  return (
    typeof turn.id === "string" &&
    turn.id.trim().length > 0 &&
    typeof turn.createdAt === "string" &&
    typeof turn.user?.content === "string" &&
    typeof turn.assistant?.content === "string" &&
    (turn.embedding === undefined || isValidEmbedding(turn.embedding))
  );
}

function isValidMemoryFile(value: unknown): value is ShortTermMemoryFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const memoryFile = value as Partial<ShortTermMemoryFile>;

  return (
    typeof memoryFile.date === "string" &&
    Array.isArray(memoryFile.turns)
  );
}

function getMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }

        if (
          typeof item === "object" &&
          item !== null &&
          "text" in item &&
          typeof item.text === "string"
        ) {
          return item.text;
        }

        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return String(content ?? "").trim();
}

function createCandidateId(
  fileName: string,
  turnIndex: number,
  turnId: string,
): string {
  return `${fileName}:${turnIndex}:${turnId}`;
}

async function getAvailableMemoryFiles(): Promise<string[]> {
  const folderExists = await exists(SHORT_MEMORY_DIR, {
    baseDir: BaseDirectory.AppData,
  });

  if (!folderExists) {
    return [];
  }

  try {
    const entries = await readDir(SHORT_MEMORY_DIR, {
      baseDir: BaseDirectory.AppData,
    });

    return entries
      .filter(
        (entry) =>
          !entry.isDirectory &&
          isDateMemoryFile(entry.name),
      )
      .map((entry) => entry.name)
      .sort((first, second) => second.localeCompare(first));
  } catch (error) {
    console.error(
      "Failed to read the short-memory directory:",
      error,
    );

    return [];
  }
}

async function readTurnsFromFile(
  fileName: string,
): Promise<ShortTermTurn[]> {
  const filePath = `${SHORT_MEMORY_DIR}/${fileName}`;

  try {
    const content = await readTextFile(filePath, {
      baseDir: BaseDirectory.AppData,
    });

    const parsed: unknown = JSON.parse(content);

    if (!isValidMemoryFile(parsed)) {
      console.warn(`Invalid memory file format: ${filePath}`);
      return [];
    }

    return parsed.turns.filter(isValidTurn);
  } catch (error) {
    console.error(`Failed to read memory file: ${filePath}`, error);
    return [];
  }
}

async function loadLatestMemoryFiles(
  maxFiles: number,
): Promise<LoadedMemoryFile[]> {
  if (maxFiles <= 0) {
    return [];
  }

  const availableFiles = await getAvailableMemoryFiles();
  const selectedFileNames = availableFiles.slice(0, maxFiles);
  const loadedFiles: LoadedMemoryFile[] = [];

  /*
   * Files are read sequentially from newest to oldest.
   */
  for (const fileName of selectedFileNames) {
    const turns = await readTurnsFromFile(fileName);

    loadedFiles.push({
      fileName,
      turns,
    });
  }

  return loadedFiles;
}

/**
 * Creates one chronological turn list.
 *
 * The loaded files are initially ordered from newest to oldest.
 * They are reversed here so neighbor lookup can move through the
 * complete conversation timeline, including daily file boundaries.
 */
function createChronologicalTurnIndex(
  files: LoadedMemoryFile[],
): IndexedMemoryTurn[] {
  const indexedTurns: IndexedMemoryTurn[] = [];

  const chronologicalFiles = [...files].reverse();

  for (const file of chronologicalFiles) {
    file.turns.forEach((turn, turnIndex) => {
      indexedTurns.push({
        candidateId: createCandidateId(
          file.fileName,
          turnIndex,
          turn.id,
        ),
        fileName: file.fileName,
        turnIndex,
        globalIndex: indexedTurns.length,
        turn,
      });
    });
  }

  return indexedTurns.sort((first, second) => {
    const firstTime = new Date(first.turn.createdAt).getTime();
    const secondTime = new Date(second.turn.createdAt).getTime();

    if (Number.isNaN(firstTime) || Number.isNaN(secondTime)) {
      return first.globalIndex - second.globalIndex;
    }

    return firstTime - secondTime;
  }).map((item, globalIndex) => ({
    ...item,
    globalIndex,
  }));
}

async function createSearchQuery(
  userMessage: string,
): Promise<string> {
  const llm = await getAsyncLLM("cheap");

  const prompt = ChatPromptTemplate.fromTemplate(
    CREATE_MEMORY_SEARCH_QUERY_PROMPT,
  );

  const chain = prompt.pipe(llm);

  const response = await chain.invoke({
    userMessage,
  });

  const searchQuery = getMessageContent(response.content);

  return searchQuery || userMessage.trim();
}

function findTopCandidates(
  queryEmbedding: number[],
  indexedTurns: IndexedMemoryTurn[],
  candidateLimit: number,
): ScoredMemoryTurn[] {
  if (candidateLimit <= 0) {
    return [];
  }

  /*
   * Embeddings created by another model or with another dimension
   * cannot be compared with the current query embedding.
   */
  const comparableTurns = indexedTurns.filter(
    (item) =>
      isValidEmbedding(item.turn.embedding) &&
      item.turn.embedding.length === queryEmbedding.length,
  );

  if (comparableTurns.length === 0) {
    return [];
  }

  const targetEmbeddings: EmbeddingListItem[] =
    comparableTurns.map((item) => ({
      id: item.candidateId,
      embedding: item.turn.embedding as number[],
    }));

  const comparison = textSimilarity.compareEmbeddingToList(
    queryEmbedding,
    targetEmbeddings,
  );

  const turnByCandidateId = new Map(
    comparableTurns.map((item) => [
      item.candidateId,
      item,
    ]),
  );

  return comparison.matches
    .slice(0, candidateLimit)
    .map((match) => {
      const indexedTurn = turnByCandidateId.get(match.id);

      if (!indexedTurn) {
        return null;
      }

      return {
        ...indexedTurn,
        score: match.score,
      };
    })
    .filter(
      (item): item is ScoredMemoryTurn => item !== null,
    );
}

function formatCandidatesForPrompt(
  candidates: ScoredMemoryTurn[],
): string {
  return candidates
    .map(
      (candidate, index) => [
        `Candidate ${index + 1}`,
        `Candidate ID: ${candidate.candidateId}`,
        `Created at: ${candidate.turn.createdAt}`,
        `Similarity score: ${candidate.score}`,
        `User: ${candidate.turn.user.content}`,
        `Assistant: ${candidate.turn.assistant.content}`,
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

async function selectRelevantCandidates(
  userMessage: string,
  searchQuery: string,
  candidates: ScoredMemoryTurn[],
): Promise<SelectedMemoryTurn[]> {
  if (candidates.length === 0) {
    return [];
  }

  const llm = await getAsyncLLM("cheap");

  const prompt = ChatPromptTemplate.fromTemplate(
    SELECT_RELEVANT_MEMORY_PROMPT,
  );

  const chain = prompt
    .pipe(llm)
    .pipe(relevanceParser);

  try {
    const result: RelevanceDecision = await chain.invoke({
      userMessage,
      searchQuery,
      candidateTurns: formatCandidatesForPrompt(candidates),
      formatInstructions:
        relevanceParser.getFormatInstructions(),
    });

    const validCandidateIds = new Set(
      candidates.map((candidate) => candidate.candidateId),
    );

    const selectedById = new Map<string, SelectedMemoryTurn>();

    for (const selection of result.selectedTurns) {
      if (!validCandidateIds.has(selection.candidateId)) {
        continue;
      }

      const existingSelection = selectedById.get(
        selection.candidateId,
      );

      if (existingSelection) {
        existingSelection.includePrevious =
          existingSelection.includePrevious ||
          selection.includePrevious;

        existingSelection.includeNext =
          existingSelection.includeNext ||
          selection.includeNext;

        continue;
      }

      selectedById.set(selection.candidateId, {
        candidateId: selection.candidateId,
        includePrevious: selection.includePrevious,
        includeNext: selection.includeNext,
      });
    }

    return [...selectedById.values()];
  } catch (error) {
    console.error(
      "Failed to select relevant memory candidates:",
      error,
    );

    return [];
  }
}

function collectSelectedTurnsWithNeighbors(
  indexedTurns: IndexedMemoryTurn[],
  selections: SelectedMemoryTurn[],
  neighborCount: number,
): ShortTermTurn[] {
  if (selections.length === 0) {
    return [];
  }

  const normalizedNeighborCount = Math.max(
    0,
    Math.floor(neighborCount),
  );

  const indexedTurnByCandidateId = new Map(
    indexedTurns.map((item) => [
      item.candidateId,
      item,
    ]),
  );

  const selectedIndexes = new Set<number>();

  for (const selection of selections) {
    const selectedTurn = indexedTurnByCandidateId.get(
      selection.candidateId,
    );

    if (!selectedTurn) {
      continue;
    }

    selectedIndexes.add(selectedTurn.globalIndex);

    if (selection.includePrevious) {
      const startIndex = Math.max(
        0,
        selectedTurn.globalIndex - normalizedNeighborCount,
      );

      for (
        let index = startIndex;
        index < selectedTurn.globalIndex;
        index += 1
      ) {
        selectedIndexes.add(index);
      }
    }

    if (selection.includeNext) {
      const endIndex = Math.min(
        indexedTurns.length - 1,
        selectedTurn.globalIndex + normalizedNeighborCount,
      );

      for (
        let index = selectedTurn.globalIndex + 1;
        index <= endIndex;
        index += 1
      ) {
        selectedIndexes.add(index);
      }
    }
  }

  return [...selectedIndexes]
    .sort((first, second) => first - second)
    .map((index) => indexedTurns[index]?.turn)
    .filter(
      (turn): turn is ShortTermTurn => turn !== undefined,
    );
}

function formatTurnsForAgent(
  turns: ShortTermTurn[],
): AgentMemoryMessage[] {
  return turns.flatMap((turn) => {
    const messages: AgentMemoryMessage[] = [];

    if (turn.user.content.trim()) {
      messages.push({
        role: "user",
        content: turn.user.content,
      });
    }

    if (turn.assistant.content.trim()) {
      messages.push({
        role: "assistant",
        content: turn.assistant.content,
      });
    }

    return messages;
  });
}

function formatCandidatesForResult(
  candidates: ScoredMemoryTurn[],
): RelevantMemoryCandidate[] {
  return candidates.map((candidate) => ({
    id: candidate.candidateId,
    originalTurnId: candidate.turn.id,
    createdAt: candidate.turn.createdAt,
    score: candidate.score,
    userContent: candidate.turn.user.content,
    assistantContent: candidate.turn.assistant.content,
  }));
}

/**
 * Retrieves relevant conversation turns from the five latest
 * short-memory files.
 *
 * Process:
 * 1. Convert the current user message into a semantic search query.
 * 2. Create an embedding for the search query.
 * 3. Compare it with stored turn embeddings.
 * 4. Select the five highest-scoring candidates.
 * 5. Ask an LLM to verify relevance.
 * 6. Add up to two previous or next turns when requested.
 * 7. Return compact messages for the main Agent.
 */
export async function retrieveRelevantShortMemory(
  userMessage: string,
  options: RetrieveRelevantShortMemoryOptions = {},
): Promise<RetrieveRelevantShortMemoryResult> {
  const normalizedUserMessage = userMessage.trim();

  if (!normalizedUserMessage) {
    return {
      searchQuery: "",
      candidates: [],
      selectedTurnIds: [],
      messages: [],
    };
  }

  const maxFiles = Math.max(
    0,
    Math.floor(options.maxFiles ?? DEFAULT_MAX_FILES),
  );

  const candidateLimit = Math.max(
    0,
    Math.floor(
      options.candidateLimit ?? DEFAULT_CANDIDATE_LIMIT,
    ),
  );

  const neighborCount = Math.max(
    0,
    Math.floor(
      options.neighborCount ?? DEFAULT_NEIGHBOR_COUNT,
    ),
  );

  try {
    const searchQuery = await createSearchQuery(
      normalizedUserMessage,
    );

    const queryEmbedding = await textSimilarity.embedText(
      searchQuery,
    );

    const loadedFiles = await loadLatestMemoryFiles(maxFiles);

    if (loadedFiles.length === 0) {
      return {
        searchQuery,
        candidates: [],
        selectedTurnIds: [],
        messages: [],
      };
    }

    const indexedTurns = createChronologicalTurnIndex(
      loadedFiles,
    );

    const candidates = findTopCandidates(
      queryEmbedding,
      indexedTurns,
      candidateLimit,
    );

    if (candidates.length === 0) {
      return {
        searchQuery,
        candidates: [],
        selectedTurnIds: [],
        messages: [],
      };
    }

    const selections = await selectRelevantCandidates(
      normalizedUserMessage,
      searchQuery,
      candidates,
    );

    const selectedTurns = collectSelectedTurnsWithNeighbors(
      indexedTurns,
      selections,
      neighborCount,
    );

    return {
      searchQuery,
      candidates: formatCandidatesForResult(candidates),
      selectedTurnIds: selections.map(
        (selection) => selection.candidateId,
      ),
      messages: formatTurnsForAgent(selectedTurns),
    };
  } catch (error) {
    console.error(
      "Failed to retrieve relevant short-term memory:",
      error,
    );

    return {
      searchQuery: normalizedUserMessage,
      candidates: [],
      selectedTurnIds: [],
      messages: [],
    };
  }
}