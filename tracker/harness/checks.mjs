import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const tracker = fileURLToPath(new URL('..', import.meta.url));
const workspace = join(tracker, '..');

function frontmatter(text, file) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${file}: missing YAML frontmatter.`);
  return match[1];
}

const checks = {
  async mcp() {
    const config = JSON.parse(await readFile(join(workspace, '.cursor', 'mcp.json'), 'utf8'));
    for (const name of ['rea', 'context7']) {
      if (!config.mcpServers?.[name]) throw new Error(`.cursor/mcp.json: server "${name}" is not registered.`);
    }
    const rea = config.mcpServers.rea.args.join(' ');
    if (!/rea-agents@\d+\.\d+\.\d+/.test(rea)) throw new Error('.cursor/mcp.json: pin rea-agents to an exact version.');
    return 'rea, context7 registered';
  },
  async rules() {
    const dir = join(workspace, '.cursor', 'rules');
    const files = (await readdir(dir)).filter(name => name.endsWith('.mdc'));
    for (const required of ['cleanroom-reverse-engineering.mdc', 'tracker-code.mdc', 'context7-sources.mdc']) {
      if (!files.includes(required)) throw new Error(`.cursor/rules/${required} is missing.`);
      const meta = frontmatter(await readFile(join(dir, required), 'utf8'), required);
      if (!/description:/.test(meta)) throw new Error(`${required}: description is missing.`);
    }
    return `${files.length} rules`;
  },
  async skills() {
    const dir = join(workspace, '.cursor', 'skills');
    for (const name of ['jira-spec-extraction', 'ticket-processing']) {
      const text = await readFile(join(dir, name, 'SKILL.md'), 'utf8');
      const meta = frontmatter(text, `${name}/SKILL.md`);
      if (!new RegExp(`name: ${name}\\b`).test(meta)) throw new Error(`${name}/SKILL.md: name must be ${name}.`);
      if (text.split('\n').length > 500) throw new Error(`${name}/SKILL.md: keep it under 500 lines.`);
    }
    return 'jira-spec-extraction, ticket-processing';
  },
  async spec() {
    const text = await readFile(join(tracker, 'spec', 'jira-rest-v3.md'), 'utf8');
    for (const endpoint of ['POST /rest/api/3/issue', '/transitions', '/comment', '/rest/api/3/search/jql']) {
      if (!text.includes(endpoint)) throw new Error(`spec/jira-rest-v3.md does not cover ${endpoint}.`);
    }
    return 'spec covers issue, transitions, comment, search';
  }
};

const name = process.argv[2];
if (!checks[name]) {
  console.error(`Usage: node harness/checks.mjs <${Object.keys(checks).join('|')}>`);
  process.exit(2);
}
try {
  console.log(`ok ${name}: ${await checks[name]()}`);
} catch (error) {
  console.error(`fail ${name}: ${error.code === 'ENOENT' ? `${error.path} does not exist.` : error.message}`);
  process.exit(1);
}
