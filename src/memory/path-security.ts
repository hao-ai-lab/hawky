import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

export function isRealPathInsideRoot(rootPath: string, targetPath: string): boolean {
  try {
    const root = realpathSync(rootPath);
    const target = realpathSync(targetPath);
    const rel = relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
}
