import { lstat, realpath, stat, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod/v4";
import { isPathInside } from "@mcp-dock/core";

const RootSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().trim().min(1).max(80),
  path: z.string().trim().min(1),
}).strict();

const ConfigSchema = z.object({
  version: z.literal(1),
  roots: z.array(RootSchema).min(1).max(12),
  limits: z.object({
    maxScanEntries: z.number().int().min(1000).max(100000).default(30000),
    maxDepth: z.number().int().min(1).max(16).default(10),
    maxReadBytes: z.number().int().min(1024).max(131072).default(65536),
  }).strict(),
}).strict();

export interface SystemRoot {
  id: string;
  name: string;
  path: string;
}

export interface SystemConfig {
  roots: Map<string, SystemRoot>;
  limits: {
    maxScanEntries: number;
    maxDepth: number;
    maxReadBytes: number;
  };
}

export async function loadSystemConfig(
  configPath = process.env.MCP_DOCK_SYSTEM_MCP_CONFIG ??
    path.resolve(process.cwd(), "config/system-mcp.yaml"),
): Promise<SystemConfig> {
  const content = await readFile(path.resolve(configPath), "utf8");
  const parsed = ConfigSchema.parse(parse(content));
  const roots = new Map<string, SystemRoot>();

  for (const definition of parsed.roots) {
    if (!path.isAbsolute(definition.path)) {
      throw new Error("system_root_path_must_be_absolute: " + definition.id);
    }
    if (roots.has(definition.id)) {
      throw new Error("duplicate_system_root_id: " + definition.id);
    }

    const linkInfo = await lstat(definition.path);
    if (linkInfo.isSymbolicLink()) {
      throw new Error("system_root_must_not_be_symlink: " + definition.id);
    }

    const resolvedPath = await realpath(definition.path);
    const rootInfo = await stat(resolvedPath);
    if (!rootInfo.isDirectory()) {
      throw new Error("system_root_must_be_directory: " + definition.id);
    }

    for (const existing of roots.values()) {
      if (isPathInside(existing.path, resolvedPath) || isPathInside(resolvedPath, existing.path)) {
        throw new Error("overlapping_system_roots: " + existing.id + ":" + definition.id);
      }
    }

    roots.set(definition.id, {
      id: definition.id,
      name: definition.name,
      path: resolvedPath,
    });
  }

  return { roots, limits: parsed.limits };
}
