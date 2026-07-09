import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { ChatOpenAI } from "@langchain/openai";
import { Command } from "@tauri-apps/plugin-shell";

// Define the structured output format for the Security LLM
const SecurityCheckSchema = z.object({
  is_safe: z.boolean().describe(
    "True if the requested action is safe, harmless, and does not pose a security threat. False if it is dangerous, destructive, malicious, or tries to escape the workspace."
  ),
  reason: z.string().describe(
    "The reasoning behind why this command is safe or blocked."
  ),
  exact_command: z.string().describe(
    "The exact, highly optimized terminal command to run if safe. Leave this completely empty if is_safe is false."
  ),
});

/**
 * Terminal Execution Tool with an AI Gatekeeper (Guardrail).
 * It intercepts the Agent's raw intent, asks an LLM to evaluate the security risk,
 * generates the safe OS-specific command, and executes it via Tauri Shell.
 */
export const terminalExecutionTool = (llm: ChatOpenAI) => tool(
  async ({ intent }) => {
    console.log(`[Terminal Guardrail] Received raw intent from Main Agent: "${intent}"`);

    // Step 1: Detect Operating System for LLM context
    const isWindows = navigator.userAgent.includes("Windows");
    const osType = isWindows ? "Windows (PowerShell)" : "macOS/Linux (sh/zsh)";
    console.log(`[Terminal Guardrail] Operating System detected: ${osType}`);

    // Step 2: Set up the Security Gatekeeper Prompt
    const securitySystemPrompt = `
      You are an elite Operating System Security Expert and Terminal Command Generator.
      Your task is to analyze the user's intent, determine if it is safe to execute on their local machine, and if safe, generate the exact command for ${osType}.

      CRITICAL SECURITY RULES:
      - Block any destructive commands (e.g., recursive file deletion like 'rm -rf /' or formatting drives).
      - Block attempts to bypass security, modify critical system files, shut down the computer, kill system-critical processes, or steal sensitive user data.
      - Ensure actions are scoped within safe user workspaces (do not allow writing to system directories like C:\\Windows or /etc).
      - If the intent is safe (e.g., checking date/time, list files, run a safe git/npm command, creating a file in a project folder, reading a code file), approve it.

      You must return a structured JSON conforming to the schema.
    `;

    // Bind the structured output schema to the LLM
    const structuredSecurityLlm = llm.withStructuredOutput(SecurityCheckSchema);

    try {
      console.log("[Terminal Guardrail] Consulting Security LLM...");
      
      const evaluation = await structuredSecurityLlm.invoke([
        { role: "system", content: securitySystemPrompt },
        { role: "user", content: `Evaluate this intent and generate the command for ${osType}: "${intent}"` }
      ]);

      console.log(`[Terminal Guardrail] Security Evaluation:`, evaluation);

      // Step 3: Handle Blocked Command
      if (!evaluation.is_safe || !evaluation.exact_command) {
        console.warn(`[Terminal Guardrail] Command BLOCKED! Reason: ${evaluation.reason}`);
        return `SECURITY_BLOCKED: The requested action was deemed dangerous by the security guardrail. Reason: ${evaluation.reason}`;
      }

      // Step 4: Execute the Safe Command using Tauri v2 Shell
      const commandToRun = evaluation.exact_command.trim();
      console.log(`[Terminal Guardrail] Executing safe generated command: "${commandToRun}"`);

      const shell = isWindows ? "powershell" : "sh";
      const args = isWindows ? ["-Command", commandToRun] : ["-c", commandToRun];

      const cmd = Command.create(shell, args);
      const executionResult = await cmd.execute();

      // Step 5: Check Execution Results
      if (executionResult.code !== 0) {
        console.error(`[Terminal Guardrail] Execution failed with code ${executionResult.code}`);
        return `EXECUTION_FAILED: The command started running but failed with exit code ${executionResult.code}.\nError Output: ${executionResult.stderr}`;
      }

      console.log("[Terminal Guardrail] Command executed successfully. Sending output back to Main Agent.");
      return executionResult.stdout || "Command executed successfully with no output.";

    } catch (error) {
      console.error("[Terminal Guardrail] Error during security check or execution:", error);
      return `SYSTEM_ERROR: Failed to securely evaluate or execute the command. Error details: ${error}`;
    }
  },
  {
    name: "terminal_intent_executor",
    description: "Use this tool to interact with the computer's terminal. Do not write raw commands. Just describe your high-level intent or what you want to achieve (e.g., 'check the current system time', 'list files in the current folder', 'create a test.js file with hello world'). The security system will generate and execute the safe command for you.",
    schema: z.object({
      intent: z.string().describe("Your logical intent or what you want to do on the computer's terminal (e.g., 'check disk space', 'list current directory files')."),
    }),
  }
);