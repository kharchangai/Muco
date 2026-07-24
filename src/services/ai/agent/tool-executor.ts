// tool-executor.ts

export interface ToolDefinition<
  TArgs = Record<string, unknown>,
  TResult = unknown,
> {
  name: string;
  description: string;
  execute: (args: TArgs) => Promise<TResult> | TResult;
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments?: unknown;
}

export interface ToolExecutionResult {
  toolCallId?: string;
  toolName: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export class ToolExecutor {
  private readonly tools = new Map<
    string,
    ToolDefinition
  >();

  public registerTool<
    TArgs = Record<string, unknown>,
    TResult = unknown,
  >(
    tool: ToolDefinition<TArgs, TResult>,
  ): void {
    if (!tool.name.trim()) {
      throw new Error("Tool name cannot be empty.");
    }

    if (typeof tool.execute !== "function") {
      throw new Error(
        `Tool "${tool.name}" must have an execute function.`,
      );
    }

    if (this.tools.has(tool.name)) {
      console.warn(
        `Tool "${tool.name}" is already registered and will be replaced.`,
      );
    }

    this.tools.set(
      tool.name,
      tool as ToolDefinition,
    );
  }

  public unregisterTool(
    toolName: string,
  ): boolean {
    return this.tools.delete(toolName);
  }

  public hasTool(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  public getTool(
    toolName: string,
  ): ToolDefinition | undefined {
    return this.tools.get(toolName);
  }

  public getAvailableTools(): Array<{
    name: string;
    description: string;
  }> {
    return Array.from(this.tools.values()).map(
      (tool) => ({
        name: tool.name,
        description: tool.description,
      }),
    );
  }

  public async execute(
    toolName: string,
    args: unknown = {},
  ): Promise<unknown> {
    const tool = this.tools.get(toolName);

    if (!tool) {
      throw new Error(
        `Tool "${toolName}" was not found.`,
      );
    }

    return await tool.execute(args);
  }

  public async executeCall(
    toolCall: ToolCall,
  ): Promise<ToolExecutionResult> {
    try {
      const result = await this.execute(
        toolCall.name,
        toolCall.arguments ?? {},
      );

      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        success: true,
        result,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        `Failed to execute tool "${toolCall.name}":`,
        error,
      );

      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        success: false,
        error: errorMessage,
      };
    }
  }

  public async executeCalls(
    toolCalls: ToolCall[],
  ): Promise<ToolExecutionResult[]> {
    return await Promise.all(
      toolCalls.map((toolCall) =>
        this.executeCall(toolCall),
      ),
    );
  }
}