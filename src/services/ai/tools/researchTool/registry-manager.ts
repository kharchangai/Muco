// src/tools/researchTool/registry-manager.ts
import { exists, readDir, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';

export interface RegistryItem {
  description: string;
  status: 'processed' | 'todo';
  timestamp: string;
}

export interface ResearchRegistryData {
  [filename: string]: RegistryItem;
}

/**
 * Helper to parse YAML frontmatter and extract title & description without external dependencies.
 */
function parseYAMLFrontmatter(content: string): { title?: string; description?: string; type?: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;

  const yamlText = match[1];
  const result: Record<string, string> = {};
  const lines = yamlText.split('\n');

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex !== -1) {
      const key = line.slice(0, colonIndex).trim();
      let value = line.slice(colonIndex + 1).trim();
      
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }

  return result;
}

export class ResearchRegistry {
  private targetFolderPath: string = '';
  private data: ResearchRegistryData = {};

  private constructor() {}

  /**
   * Factory method to load, synchronize, and self-heal the registry.
   */
  public static async load(targetFolderPath: string): Promise<ResearchRegistry> {
    const instance = new ResearchRegistry();
    instance.targetFolderPath = targetFolderPath;
    
    // Run the self-healing synchronization process on startup
    await instance.syncWithDisk();
    return instance;
  }

  /**
   * Scans the physical directory, parses existing Markdown files,
   * and synchronizes them with the 'link_registry.json' file.
   */
  public async syncWithDisk(): Promise<void> {
    try {
      console.log("[Registry] Starting self-healing synchronization with disk...");

      const registryFilePath = await join(this.targetFolderPath, 'link_registry.json');

      // 1. Load existing link_registry.json if it exists
      let existingRegistry: ResearchRegistryData = {};
      if (await exists(registryFilePath)) {
        try {
          const rawContent = await readTextFile(registryFilePath);
          existingRegistry = JSON.parse(rawContent);
        } catch (e) {
          console.warn("[Registry] link_registry.json was corrupted. Will rebuild from disk state.", e);
        }
      }

      // 2. Scan physical directory for all .md files
      const diskProcessedFiles: Record<string, string> = {}; // filename -> description
      
      if (await exists(this.targetFolderPath)) {
        const entries = await readDir(this.targetFolderPath);
        
        for (const entry of entries) {
          if (entry.isFile && entry.name.endsWith('.md') && entry.name !== 'extracted-personal-context.md') {
            const filePath = await join(this.targetFolderPath, entry.name);
            const content = await readTextFile(filePath);
            
            const frontmatter = parseYAMLFrontmatter(content);
            if (frontmatter) {
              diskProcessedFiles[entry.name] = frontmatter.description || "No description found in YAML header.";
            }
          }
        }
      }

      // 3. Merge and Sync
      const synchronizedData: ResearchRegistryData = {};

      for (const [filename, description] of Object.entries(diskProcessedFiles)) {
        synchronizedData[filename] = {
          description,
          status: 'processed',
          timestamp: existingRegistry[filename]?.timestamp || new Date().toISOString()
        };
      }

      for (const [filename, item] of Object.entries(existingRegistry)) {
        if (item.status === 'todo' && !diskProcessedFiles[filename]) {
          synchronizedData[filename] = item;
        }
        
        if (item.status === 'processed' && !diskProcessedFiles[filename]) {
          console.log(`[Registry] Self-Healed: "${filename}" was marked PROCESSED but is missing on disk. Downgrading to TODO.`);
          synchronizedData[filename] = {
            description: item.description,
            status: 'todo',
            timestamp: new Date().toISOString()
          };
        }
      }

      this.data = synchronizedData;
      await this.save();
      console.log(`[Registry] Sync complete. ${Object.keys(this.data).length} items registered.`);

    } catch (error) {
      console.error("[Registry] Critical error during syncWithDisk:", error);
      this.data = {};
    }
  }

  /**
   * Saves the current in-memory registry state to link_registry.json.
   */
  private async save(): Promise<void> {
    try {
      const registryFilePath = await join(this.targetFolderPath, 'link_registry.json');
      await writeTextFile(registryFilePath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error("[Registry] Failed to save link_registry.json to disk:", error);
    }
  }

  /**
   * Registers a new item.
   */
  public async register(filename: string, description: string, status: 'processed' | 'todo'): Promise<void> {
    const existing = this.data[filename];
    
    if (existing && existing.status === 'processed' && status === 'todo') {
      return; 
    }

    this.data[filename] = {
      description,
      status,
      timestamp: new Date().toISOString()
    };
    
    await this.save();
    console.log(`[Registry] Registered: "${filename}" as [${status.toUpperCase()}]`);
  }

  /**
   * Gets all items with 'todo' status.
   */
  public getTodoQueue(): Array<{ filename: string; description: string }> {
    return Object.entries(this.data)
      .filter(([_, item]) => item.status === 'todo')
      .map(([filename, item]) => ({ filename, description: item.description }));
  }

  /**
   * Returns the entire registry.
   */
  public getExistingFilesGuide(): Record<string, { description: string; status: 'processed' | 'todo' }> {
    const guide: Record<string, { description: string; status: 'processed' | 'todo' }> = {};
    for (const [filename, item] of Object.entries(this.data)) {
      guide[filename] = {
        description: item.description,
        status: item.status
      };
    }
    return guide;
  }

  /**
   * Checks if a specific file is already in the registry.
   */
  public has(filename: string): boolean {
    return !!this.data[filename];
  }
}