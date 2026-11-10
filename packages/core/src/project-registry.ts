import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const ProjectSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().trim().min(1).max(120),
  root: z.string().trim().min(1),
  description: z.string().max(500).optional(),
}).strict();

const ProjectFileSchema = z.object({
  version: z.literal(1),
  projects: z.array(ProjectSchema).min(1),
}).strict();

export type ProjectDefinition = {
  id: string;
  name: string;
  root: string;
  description?: string;
};

export type ProjectSummary = ProjectDefinition & {
  exists: boolean;
  isGitRepository: boolean;
};

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function isGitRepository(root: string): Promise<boolean> {
  try {
    await stat(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

export class ProjectRegistry {
  readonly #projects: Map<string, ProjectDefinition>;

  constructor(projects: ProjectDefinition[]) {
    const indexed = new Map<string, ProjectDefinition>();

    for (const project of projects) {
      if (indexed.has(project.id)) {
        throw new Error(`duplicate_project_id: ${project.id}`);
      }
      indexed.set(project.id, project);
    }

    this.#projects = indexed;
  }

  get(projectId: string): ProjectDefinition {
    const project = this.#projects.get(projectId);
    if (!project) {
      throw new Error(`unknown_project_id: ${projectId}`);
    }
    return project;
  }

  async list(): Promise<ProjectSummary[]> {
    return await Promise.all(
      [...this.#projects.values()].map(async (project) => ({
        ...project,
        exists: await isDirectory(project.root),
        isGitRepository: await isGitRepository(project.root),
      })),
    );
  }

  async getSummary(projectId: string): Promise<ProjectSummary> {
    const project = this.get(projectId);
    return {
      ...project,
      exists: await isDirectory(project.root),
      isGitRepository: await isGitRepository(project.root),
    };
  }
}

export async function loadProjectRegistry(
  configPath = process.env.MCP_DOCK_PROJECTS_CONFIG ??
    path.resolve(process.cwd(), "config/projects.yaml"),
): Promise<ProjectRegistry> {
  const absoluteConfigPath = path.resolve(configPath);
  const content = await readFile(absoluteConfigPath, "utf8");
  const parsed = ProjectFileSchema.parse(parse(content));

  const projects: ProjectDefinition[] = parsed.projects.map((project) => {
    if (!path.isAbsolute(project.root)) {
      throw new Error(`project_root_must_be_absolute: ${project.id}`);
    }

    return {
      id: project.id,
      name: project.name,
      root: path.resolve(project.root),
      ...(project.description ? { description: project.description } : {}),
    };
  });

  return new ProjectRegistry(projects);
}
