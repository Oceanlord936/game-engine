import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "./parser.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const storyPath = join(__dirname, "..", process.argv[2] ?? "stories/sample.vns");
const source = readFileSync(storyPath, "utf-8");

const program = parse(source);

console.log(`Parsed ${program.labels.length} label(s) from ${storyPath}\n`);
console.log(JSON.stringify(program.labels, null, 2));

if (program.errors.length > 0) {
  console.error(`\n${program.errors.length} parse error(s):`);
  for (const err of program.errors) {
    console.error(`  line ${err.line}: ${err.message}`);
  }
  process.exitCode = 1;
}
