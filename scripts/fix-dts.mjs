#!/usr/bin/env node
// Fixes .d.ts files that reference the unpublished @siteping/core package.
//
// Core is an Internal Package: its JS is bundled into consumers via tsup
// `noExternal`, but its type declarations are emitted per-module by `tsc`
// (errors.d.ts, types.d.ts, ... with relative `./x.js` imports). Shipping a
// subset used to leave dangling imports in the published tarballs — the
// attw `internal-resolution-error` class tracked in #220.
//
// Cross-platform replacement for fix-dts.sh (no sed/cp).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const distDir = process.argv[2];
if (!distDir) {
  console.error("Usage: node fix-dts.mjs <dist-dir>");
  process.exit(1);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const coreDist = resolve(scriptDir, "..", "packages", "core", "dist");
const targetDir = resolve(distDir);

if (!existsSync(targetDir)) {
  console.error(`Target directory does not exist: ${targetDir}`);
  process.exit(1);
}

if (!existsSync(coreDist)) {
  console.error(`Core dist directory does not exist: ${coreDist}`);
  process.exit(1);
}

// Relative specifiers in declaration files are always quoted import/export
// paths — a global quoted-specifier rewrite is safe there.
const toCjsSpecifiers = (content) => content.replace(/(["'])\.\/([^"']+)\.js\1/g, "$1./$2.cjs$1");

const ownDts = readdirSync(targetDir).filter((f) => f.endsWith(".d.ts") || f.endsWith(".d.cts"));
const needsTesting = ownDts.some((f) => readFileSync(join(targetDir, f), "utf8").includes("@siteping/core/testing"));
const needsOidc = ownDts.some((f) => readFileSync(join(targetDir, f), "utf8").includes("@siteping/core/oidc"));

const coreFiles = readdirSync(coreDist).filter(
  (f) => f.endsWith(".d.ts") && (f !== "testing.d.ts" || needsTesting) && (f !== "oidc.d.ts" || needsOidc),
);

for (const file of coreFiles) {
  const content = readFileSync(join(coreDist, file), "utf8");
  const base =
    file === "index.d.ts"
      ? "siteping-core"
      : file === "testing.d.ts"
        ? "siteping-core-testing"
        : file === "oidc.d.ts"
          ? "siteping-core-oidc"
          : file.slice(0, -5);
  writeFileSync(join(targetDir, `${base}.d.ts`), content, "utf8");
  writeFileSync(join(targetDir, `${base}.d.cts`), toCjsSpecifiers(content), "utf8");
  console.log(`  Copied: ${file} -> ${base}.d.ts + ${base}.d.cts`);
}

const dtsFiles = readdirSync(targetDir).filter((f) => f.endsWith(".d.ts") || f.endsWith(".d.cts"));

for (const file of dtsFiles) {
  const filePath = join(targetDir, file);
  let content = readFileSync(filePath, "utf8");
  const original = content;
  const cjs = file.endsWith(".d.cts");
  const replacement = cjs ? "./siteping-core.cjs" : "./siteping-core.js";
  const testingReplacement = cjs ? "./siteping-core-testing.cjs" : "./siteping-core-testing.js";
  const oidcReplacement = cjs ? "./siteping-core-oidc.cjs" : "./siteping-core-oidc.js";

  content = content.replaceAll("'@siteping/core/testing'", `'${testingReplacement}'`);
  content = content.replaceAll('"@siteping/core/testing"', `"${testingReplacement}"`);
  content = content.replaceAll("'@siteping/core/oidc'", `'${oidcReplacement}'`);
  content = content.replaceAll('"@siteping/core/oidc"', `"${oidcReplacement}"`);
  content = content.replaceAll("'@siteping/core'", `'${replacement}'`);
  content = content.replaceAll('"@siteping/core"', `"${replacement}"`);

  if (content.includes("@siteping/core")) {
    console.error(`  UNRESOLVED reference to @siteping/core (subpath import?) in ${file}`);
    process.exit(1);
  }

  if (content !== original) {
    writeFileSync(filePath, content, "utf8");
    console.log(`  Patched: ${file}`);
  }
}

console.log("fix-dts: done");
