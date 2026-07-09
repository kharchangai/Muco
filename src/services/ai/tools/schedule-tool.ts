import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readTextFile, writeTextFile, exists, mkdir } from '@tauri-apps/plugin-fs';
import { join, appDataDir } from '@tauri-apps/api/path';
import { getAsyncLLM } from "./memory_tools"; 
import { StringOutputParser, StructuredOutputParser } from "@langchain/core/output_parsers";
import { RunnableSequence } from "@langchain/core/runnables";

// Enhanced schema to support flexible deletions without needing an ID first
const internalDecisionSchema = z.object({
  intent: z.enum(["CREATE", "READ", "DELETE"]).describe("The determined intent of the user."),
  createData: z.object({
    type: z.enum(["TIMER", "PLANNER"]).describe("TIMER for quick alarms/reminders, PLANNER for calendar events."),
    targetTime: z.string().describe("The calculated target date and time in ISO 8601 format (YYYY-MM-DDTHH:mm:ssZ). ALWAYS include 'Z'."),
    task: z.string().describe("A brief English or Persian description of the task."),
    ttsText: z.string().describe("A friendly, warm Persian reminder sentence that Mocu will read aloud when triggered.")
  }).optional(),
  readData: z.object({
    date: z.string().describe("The target date to query in YYYY-MM-DD format."),
    type: z.enum(["TIMER", "PLANNER", "ALL"]).default("ALL").describe("Filter to retrieve only TIMER, only PLANNER, or ALL events.")
  }).optional(),
  deleteData: z.object({
    id: z.string().optional().describe("The unique ID of the timer or planner event to cancel/delete. Use this if available in history."),
    type: z.enum(["TIMER", "PLANNER"]).describe("The type of the event to delete."),
    date: z.string().optional().describe("The target date of the event in YYYY-MM-DD format. Required if type is PLANNER."),
    allOnDate: z.boolean().optional().describe("Set to true if the user wants to cancel ALL plans/timers on this specific date, or conditionally cancel whatever exists."),
    taskKeyword: z.string().optional().describe("A keyword to match the task description to delete (e.g., 'youtube' or 'یوتیوب') if deleting a specific task without an ID.")
  }).optional()
});

const jsonParser = StructuredOutputParser.fromZodSchema(internalDecisionSchema);
const stringParser = new StringOutputParser();

async function getSchedulePaths() {
  const baseDir = await appDataDir();
  const scheduleRoot = await join(baseDir, "memory", "schedule");
  const plannerDir = await join(scheduleRoot, "planner");

  if (!(await exists(scheduleRoot))) await mkdir(scheduleRoot, { recursive: true });
  if (!(await exists(plannerDir))) await mkdir(plannerDir, { recursive: true });

  const timerPath = await join(scheduleRoot, "timer.json");
  return { plannerDir, timerPath };
}

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

const INTERNAL_SCHEDULER_PROMPT = `
You are an expert scheduling assistant. Your job is to analyze the user's request and determine their intent: CREATE a schedule/timer, READ existing schedules, or DELETE/CANCEL a schedule.

Current Time (UTC): {currentTime}

Recent Chat History for context:
{history}

User Query: "{query}"

Analyze the query and history carefully:
1. If the user wants to set, create, make, or schedule a new timer, reminder, alarm, or plan, select "CREATE".
2. If the user wants to check, read, view, or ask what plans/timers they have, select "READ".
3. If the user wants to cancel, delete, or remove a timer or plan (e.g., "اون برنامه رو کنسل کن" or "اگر برنامه‌ای برای پس‌فردا دارم لغوش کن"), select "DELETE".
   - If the request is conditional (e.g., "if I have plans on date X, cancel them"), set intent to "DELETE".
   - Fill "deleteData" fields:
     * "type": "PLANNER" or "TIMER".
     * "date": The calculated target date in YYYY-MM-DD format based on the query and Current Time.
     * "allOnDate": Set to true if they want to cancel all plans on that day, or if they want to clear any existing plans on that date.
     * "taskKeyword": Extract a keyword if they specified a specific task to delete (e.g., "youtube" or "یوتیوب").
     * "id": Only fill this if you see an exact ID in the recent chat history that the user is explicitly referring to.

You must output a JSON matching the requested schema.
Format Instructions:
{formatInstructions}
`;

export const scheduleTool = tool(
  async (input: { userRequest: string; chatHistory?: any[] }) => {
    try {
      const { userRequest, chatHistory } = input;
      const llm = await getAsyncLLM();
      const { plannerDir, timerPath } = await getSchedulePaths();
      const currentTimeIso = new Date().toISOString();

      const formattedHistory = chatHistory
        ? chatHistory.map((m: any) => `${m._getType() === 'human' ? 'User' : 'Mocu'}: ${m.content}`).join("\n")
        : "No history provided.";

      const formattedPrompt = INTERNAL_SCHEDULER_PROMPT
        .replace("{currentTime}", currentTimeIso)
        .replace("{history}", formattedHistory)
        .replace("{query}", userRequest)
        .replace("{formatInstructions}", jsonParser.getFormatInstructions());

      const scheduleChain = RunnableSequence.from([llm, stringParser, jsonParser]);
      const decision = await scheduleChain.invoke(formattedPrompt);

      console.log("[Schedule Tool] Internal LLM Decision:", decision);

      // ==========================================
      // 1. INTENT: CREATE
      // ==========================================
      if (decision.intent === "CREATE" && decision.createData) {
        const eventId = generateUUID();
        let targetTime = decision.createData.targetTime;
        if (!targetTime.endsWith("Z")) {
          targetTime += "Z";
        }

        if (decision.createData.type === "TIMER") {
          let timers: any[] = [];
          if (await exists(timerPath)) {
            try {
              const rawTimers = await readTextFile(timerPath);
              timers = JSON.parse(rawTimers);
            } catch {}
          }

          const newTimer = {
            id: eventId,
            time: targetTime,
            task: decision.createData.task,
            tts_text: decision.createData.ttsText,
            status: "PENDING"
          };

          timers.push(newTimer);
          await writeTextFile(timerPath, JSON.stringify(timers, null, 2));
          return `Successfully set timer for ${targetTime}`;

        } else {
          const targetDate = targetTime.split("T")[0]; // YYYY-MM-DD
          const targetMonth = targetDate.substring(0, 7); // YYYY-MM
          const plannerFile = `${targetMonth}.json`;
          const plannerFilePath = await join(plannerDir, plannerFile);

          let monthData: Record<string, any[]> = {};
          if (await exists(plannerFilePath)) {
            try {
              const rawData = await readTextFile(plannerFilePath);
              monthData = JSON.parse(rawData);
            } catch {}
          }

          if (!monthData[targetDate]) {
            monthData[targetDate] = [];
          }

          const newPlan = {
            id: eventId,
            time: targetTime.split("T")[1], // HH:mm:ssZ
            task: decision.createData.task,
            tts_text: decision.createData.ttsText,
            status: "PENDING"
          };

          monthData[targetDate].push(newPlan);
          await writeTextFile(plannerFilePath, JSON.stringify(monthData, null, 2));
          return `Successfully added plan to calendar on ${targetDate}`;
        }
      }

      // ==========================================
      // 2. INTENT: READ
      // ==========================================
      if (decision.intent === "READ" && decision.readData) {
        const { date, type } = decision.readData;
        const result: { timers: any[]; planner: any[] } = { timers: [], planner: [] };

        if ((type === "TIMER" || type === "ALL") && (await exists(timerPath))) {
          try {
            const rawTimers = await readTextFile(timerPath);
            const timers = JSON.parse(rawTimers);
            result.timers = timers.filter((t: any) => t.time.startsWith(date));
          } catch {}
        }

        if (type === "PLANNER" || type === "ALL") {
          const targetMonth = date.substring(0, 7); // YYYY-MM
          const plannerFile = `${targetMonth}.json`;
          const plannerFilePath = await join(plannerDir, plannerFile);

          if (await exists(plannerFilePath)) {
            try {
              const rawData = await readTextFile(plannerFilePath);
              const monthData = JSON.parse(rawData);
              result.planner = monthData[date] || [];
            } catch {}
          }
        }

        if (result.timers.length === 0 && result.planner.length === 0) {
          return `No schedules, plans, or timers found for ${date}.`;
        }

        return JSON.stringify(result, null, 2);
      }

      // ==========================================
      // 3. INTENT: DELETE
      // ==========================================
      if (decision.intent === "DELETE" && decision.deleteData) {
        const { id, type, date, allOnDate, taskKeyword } = decision.deleteData;

        if (type === "TIMER") {
          if (!(await exists(timerPath))) {
            return "No active timers or reminders found to cancel.";
          }
          const rawTimers = await readTextFile(timerPath);
          let timers = JSON.parse(rawTimers);
          const initialLength = timers.length;
          
          if (id) {
            timers = timers.filter((t: any) => t.id !== id);
          } else if (date) {
            timers = timers.filter((t: any) => !t.time.startsWith(date));
          }

          if (timers.length === initialLength) {
            return "Could not find any matching timer to cancel.";
          }

          await writeTextFile(timerPath, JSON.stringify(timers, null, 2));
          return "Successfully cancelled the timer.";

        } else {
          if (!date) {
            return "Error: Date is required to cancel a planner event.";
          }
          const targetMonth = date.substring(0, 7); // YYYY-MM
          const plannerFile = `${targetMonth}.json`;
          const plannerFilePath = await join(plannerDir, plannerFile);

          if (!(await exists(plannerFilePath))) {
            return `No plans found for the date ${date}.`;
          }

          const rawData = await readTextFile(plannerFilePath);
          const monthData = JSON.parse(rawData);

          if (!monthData[date] || monthData[date].length === 0) {
            return `No plans found for the date ${date}.`;
          }

          let deletedTasks: string[] = [];
          const initialLength = monthData[date].length;

          if (id) {
            const planToDelete = monthData[date].find((p: any) => p.id === id);
            if (planToDelete) deletedTasks.push(planToDelete.task);
            monthData[date] = monthData[date].filter((p: any) => p.id !== id);
          } else if (allOnDate) {
            deletedTasks = monthData[date].map((p: any) => p.task);
            delete monthData[date];
          } else if (taskKeyword) {
            const normalizedKeyword = taskKeyword.toLowerCase();
            const remainingPlans: any[] = [];
            monthData[date].forEach((p: any) => {
              if (p.task.toLowerCase().includes(normalizedKeyword) || p.tts_text.toLowerCase().includes(normalizedKeyword)) {
                deletedTasks.push(p.task);
              } else {
                remainingPlans.push(p);
              }
            });
            monthData[date] = remainingPlans;
          } else {
            if (monthData[date].length === 1) {
              deletedTasks.push(monthData[date][0].task);
              delete monthData[date];
            } else {
              const taskNames = monthData[date].map((p: any) => p.task).join(", ");
              return `Multiple plans found on ${date}: ${taskNames}. Please specify which one to cancel.`;
            }
          }

          if (deletedTasks.length === 0) {
            return "No matching programs found to cancel.";
          }

          if (monthData[date] && monthData[date].length === 0) {
            delete monthData[date];
          }

          await writeTextFile(plannerFilePath, JSON.stringify(monthData, null, 2));
          return `Successfully cancelled the following programs on ${date}: ${deletedTasks.join(", ")}`;
        }
      }

      return "No valid schedule action could be determined.";

    } catch (error) {
      console.error("[Schedule Tool] Error during execution:", error);
      return "An error occurred while managing your request.";
    }
  },
  {
    name: "schedule_action",
    description: "Use this tool for ANY scheduling, timers, alarms, calendar events, checking schedules, or canceling/deleting schedules.",
    schema: z.object({
      userRequest: z.string().describe("The raw user query."),
    }),
  }
);