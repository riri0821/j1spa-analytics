/**
 * Let a script in scripts/ import a module from src/lib/ unchanged.
 *
 * The app's own modules use bundler-style relative imports with no extension
 * ("./analytics"), which Next resolves and Node does not. The check scripts
 * sidestep this by only importing leaf modules that happen to have no such
 * imports; anything deeper - decisionSupport.js, which pulls in analytics.js
 * and alertsBatch.js - fails with ERR_MODULE_NOT_FOUND.
 *
 * Registering this hook appends ".js" to a relative specifier that has no
 * extension, and only after Node's own resolution has already failed, so it
 * cannot shadow a real file or a package.
 *
 * Call enableBundlerResolve() BEFORE importing the src/lib module, which
 * means the import has to be dynamic:
 *
 *   enableBundlerResolve();
 *   const { evaluateDecisionSupport } = await import("../src/lib/decisionSupport.js");
 */

import { register } from "node:module";

const HOOK = `
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.startsWith(".") && !/\\.[a-z]+$/i.test(specifier)) {
      return next(specifier + ".js", context);
    }
    throw err;
  }
}
`;

let registered = false;

export function enableBundlerResolve() {
  if (registered) return;
  // A data: URL keeps the hook in this file - a module loader hook runs on
  // its own thread and cannot be passed as a function.
  register(`data:text/javascript,${encodeURIComponent(HOOK)}`);
  registered = true;
}
