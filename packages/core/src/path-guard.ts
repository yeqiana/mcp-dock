import path from "node:path";

/**
 * Returns true only when target resolves to root itself or a descendant.
 * On Windows, path.relative follows the platform's case-insensitive semantics.
 */
export function isPathInside(root: string, target: string): boolean {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  const relative = path.relative(absoluteRoot, absoluteTarget);

  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

export function assertPathInside(root: string, target: string): string {
  const absoluteTarget = path.resolve(target);

  if (!isPathInside(root, absoluteTarget)) {
    throw new Error("path_outside_allowed_root");
  }

  return absoluteTarget;
}
