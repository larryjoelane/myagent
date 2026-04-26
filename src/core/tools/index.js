// Tool registry. Each tool exports { name, description, schema, run(args, ctx) }.
// `ctx` carries per-request state — currently just { outputDir }.
//
// Adding a tool is two steps: write the file under src/core/tools/, then
// add it to the array below. Tools listed here become available to the
// model automatically (the system prompt enumerates them via toolDocs()).

const readFile = require('./readFile');
const listDir = require('./listDir');
const writeFile = require('./writeFile');

const TOOLS = [readFile, listDir, writeFile];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function getTool(name) {
  return BY_NAME.get(name);
}

function toolDocs() {
  return TOOLS.map((t) => {
    const args = Object.entries(t.schema)
      .map(([k, v]) => `    "${k}": <${v.type}>  // ${v.description}`)
      .join('\n');
    return `- ${t.name}: ${t.description}\n  arguments:\n${args}`;
  }).join('\n\n');
}

module.exports = { TOOLS, getTool, toolDocs };
