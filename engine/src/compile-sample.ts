import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parse } from "./parser.ts";
import { compile } from "./compiler.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const storyPath = join(__dirname, "..", process.argv[2] ?? "stories/sample.vns");
const source = readFileSync(storyPath, "utf-8");

const program = parse(source);
if (program.errors.length > 0) {
  for (const err of program.errors) console.error(`line ${err.line}: ${err.message}`);
  process.exit(1);
}

const { instructions } = compile(program);

console.log(`Compiled to ${instructions.length} flat instruction(s):\n`);
instructions.forEach((instr, i) => {
  console.log(`${String(i).padStart(3, " ")}  ${JSON.stringify(instr)}`);
});
