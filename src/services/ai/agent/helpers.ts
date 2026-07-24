export const isRecord = (
  value: unknown,
): value is Record<string, unknown> => {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
};

export const getTextContent = (
  content: unknown,
): string => {
  if (typeof content === "string") {
    return content;
  }

  if (isRecord(content)) {
    if (typeof content.text === "string") {
      return content.text;
    }

    return "";
  }

  if (!Array.isArray(content)) {
    return "";
  }

  const textParts: string[] = [];

  for (const item of content) {
    const text = getTextContent(item).trim();

    if (text) {
      textParts.push(text);
    }
  }

  return textParts.join(" ");
};

export const getToolResultText = (
  result: unknown,
): string => {
  if (typeof result === "string") {
    return result;
  }

  if (result === null || result === undefined) {
    return "";
  }

  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
};

export const stripMarkdown = (
  text: string,
): string => {
  if (!text) {
    return "";
  }

  return text
    .replace(
      /!\[([^\]]*)\]\((?:[^)]+)\)/g,
      "$1",
    )
    .replace(
      /\[([^\]]+)\]\((?:[^)]+)\)/g,
      "$1",
    )
    .replace(/https?:\/\/[^\s]+/g, "")
    .replace(/[*_#`~>|]/g, "")
    .replace(/^\s*[-•]\s*/gm, "")
    .replace(/^\s*\d+[.)]\s*/gm, "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
};

export const dispatchAgentActivity = (
  activity: string | null,
): void => {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent("mocu_activity", {
      detail: activity,
    }),
  );
};