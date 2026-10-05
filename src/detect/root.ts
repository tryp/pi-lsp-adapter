import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { pathExists } from "../util/helpers.js";

export interface RootDetectionResult {
  rootDir: string;
  marker: string;
  markerPath: string;
}

/**
 * Absolute path a marker points at inside `dir`, or undefined when it cannot.
 *
 * Shared with the workspace-scope suggestion so both agree on multi-segment
 * markers ("src/gen", "sub\\marker"). An absolute marker returns undefined:
 * it points at one fixed path, so it exists identically for every candidate
 * directory and would match the first one tried, turning root detection into a
 * coin flip. Treating it as "never matches" keeps the walk meaningful.
 */
export function markerPath(dir: string, marker: string): string | undefined {
  if (isAbsolute(marker)) return undefined;
  return join(dir, ...marker.split(/[\\/]+/));
}

export async function detectRoot(filePath: string, rootMarkers: string[]): Promise<RootDetectionResult | undefined> {
  let currentDir = dirname(resolve(filePath));
  const filesystemRoot = parse(currentDir).root;

  while (true) {
    for (const marker of rootMarkers) {
      const candidate = markerPath(currentDir, marker);
      if (candidate !== undefined && (await pathExists(candidate))) {
        return {
          rootDir: currentDir,
          marker,
          markerPath: candidate,
        };
      }
    }

    if (currentDir === filesystemRoot) {
      return undefined;
    }

    currentDir = dirname(currentDir);
  }
}
