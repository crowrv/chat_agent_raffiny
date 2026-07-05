import { realpathSync } from "node:fs";

// Canonicalize a filesystem path (resolve symlinks and, on case-insensitive
// filesystems like macOS, the true on-disk casing). The hub reports its
// projectRoot and the shell/feeder verify it by string equality, so both sides
// must canonicalize the same way or an identity check fails when the repo is
// reached via a symlink or a differently-cased path. Falls back to the input if
// the path can't be resolved (e.g. it doesn't exist yet).
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
