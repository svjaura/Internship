/**
 * Setup shared by the command-line scripts in scripts/. Call prepareScriptEnv() first,
 * then load app code with a dynamic import(), so the setup runs before any app module.
 *
 * - The app's server modules import "server-only", which throws anywhere except Next's
 *   server build. These scripts are server code run by hand, so "server-only" resolves to
 *   the package's own no-op entry (its "react-server" export), the same file Next uses.
 * - Loads .env.local from the app folder, if it exists, without overriding anything
 *   already set in the shell. Values are never printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { parseEnv } from "node:util";

let hooked = false;

export const APP_DIR = path.resolve(__dirname, "..", "..");

export function prepareScriptEnv(opts: { envFile?: string | false } = {}): { envFile: string | null } {
  if (!hooked) {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "server-only") {
          return nextResolve(specifier, { ...context, conditions: [...(context.conditions ?? []), "react-server"] });
        }
        return nextResolve(specifier, context);
      },
    });
    hooked = true;
  }

  if (opts.envFile === false) return { envFile: null };
  const file = path.resolve(APP_DIR, opts.envFile ?? ".env.local");
  if (!existsSync(file)) return { envFile: null };
  const parsed = parseEnv(readFileSync(file, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined && v !== undefined) process.env[k] = v;
  }
  return { envFile: path.relative(process.cwd(), file) || file };
}

/** A one-line error for the console. Never prints a stack, a request or a response. */
export function fail(message: string): never {
  console.error(`\nFAILED: ${message}`);
  process.exit(1);
}
