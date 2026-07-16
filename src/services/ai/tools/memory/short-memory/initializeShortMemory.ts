import {
  BaseDirectory,
  exists,
  mkdir,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

const MEMORY_DIRECTORY = "memory";
const SHORT_MEMORY_DIRECTORY = `${MEMORY_DIRECTORY}/short-memory`;

type ShortMemoryFile = {
  date: string;
  turns: unknown[];
};

/**
 * Ensures that the short-memory directory and today's JSON file exist.
 *
 * Returns the AppData-relative path of today's short-memory file.
 */
export async function initializeShortMemory(): Promise<string> {
  const directoryExists = await exists(SHORT_MEMORY_DIRECTORY, {
    baseDir: BaseDirectory.AppData,
  });

  if (!directoryExists) {
    await mkdir(SHORT_MEMORY_DIRECTORY, {
      baseDir: BaseDirectory.AppData,
      recursive: true,
    });
  }

  const date = getLocalDateKey();
  const filePath = `${SHORT_MEMORY_DIRECTORY}/${date}.json`;

  const fileExists = await exists(filePath, {
    baseDir: BaseDirectory.AppData,
  });

  if (!fileExists) {
    const initialFile: ShortMemoryFile = {
      date,
      turns: [],
    };

    await writeTextFile(
      filePath,
      JSON.stringify(initialFile, null, 2),
      {
        baseDir: BaseDirectory.AppData,
      },
    );
  }

  return filePath;
}

/**
 * Returns the local calendar date in YYYY-MM-DD format.
 *
 * Using Date#toISOString directly is avoided because it uses UTC and can
 * create a file for the wrong day around midnight in local time.
 */
function getLocalDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}