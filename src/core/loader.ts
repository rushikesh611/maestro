import { existsSync } from 'fs';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { pathToFileURL } from 'url';
import type { Skill, AgentDef, Tool } from './types';

export interface PluginDefinition {
    name: string;
    directory: string;
    baseDir: string;
}

export interface PluginResourceBundle {
    plugins: PluginDefinition[];
    skills: Skill[];
    agents: AgentDef[];
    tools: Tool[];
}

function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
    if (!match) return { frontmatter: {}, body: content.trim() };

    const fm: Record<string, any> = {};
    const frontmatterBlock = match[1]!;
    const bodyBlock = match[2]!;

    for (const line of frontmatterBlock.split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx > 0) {
            const key = line.slice(0, idx).trim();
            let val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
            if (val.startsWith('[') && val.endsWith(']')) {
                fm[key] = val.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^["']|["']$/g, ''));
            } else if (val.includes(',') && !val.includes(' ')) {
                fm[key] = val.split(',').map((s: string) => s.trim());
            } else {
                fm[key] = val;
            }
        }
    }
    return { frontmatter: fm, body: bodyBlock.trim() };
}

export async function loadSkills(dir: string): Promise<Skill[]> {
    const skills: Skill[] = [];
    try {
        const files = (await readdir(dir)).filter(f => f.endsWith('.md'));
        for (const file of files) {
            const raw = await readFile(join(dir, file), 'utf-8');
            const { frontmatter, body } = parseFrontmatter(raw);
            skills.push({
                name: frontmatter.name || file.replace('.md', ''),
                description: frontmatter.description || '',
                content: body,
                tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
            });
        }
    } catch { /* dir missing */ }
    return skills;
}

export async function loadAgents(dir: string): Promise<AgentDef[]> {
    const agents: AgentDef[] = [];
    try {
        const files = (await readdir(dir)).filter(f => f.endsWith('.md'));
        for (const file of files) {
            const raw = await readFile(join(dir, file), 'utf-8');
            const { frontmatter, body } = parseFrontmatter(raw);
            agents.push({
                name: frontmatter.name || file.replace('.md', ''),
                description: frontmatter.description || '',
                systemPrompt: body,
                model: frontmatter.model,
            });
        }
    } catch { /* dir missing */ }
    return agents;
}

async function loadPluginTools(dir: string): Promise<Tool[]> {
    if (!existsSync(dir)) return [];

    const files = (await readdir(dir)).filter(f => /\.(ts|js|mjs|cjs)$/.test(f)).sort();
    const tools: Tool[] = [];

    for (const file of files) {
        const modulePath = join(dir, file);
        try {
            const module = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
            const exported = (module as Record<string, unknown>).default ?? (module as Record<string, unknown>).tool ?? (module as Record<string, unknown>).tools;

            if (Array.isArray(exported)) {
                for (const item of exported) {
                    const tool = normalizeTool(item);
                    if (tool) tools.push(tool);
                }
            } else {
                const tool = normalizeTool(exported);
                if (tool) tools.push(tool);
            }
        } catch (error: any) {
            console.warn(`⚠️ Failed to load plugin tool ${modulePath}: ${error.message}`);
        }
    }

    return tools;
}

function normalizeTool(value: unknown): Tool | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<Tool>;
    if (typeof candidate.name === 'string' && typeof candidate.description === 'string' && typeof candidate.handler === 'function') {
        return candidate as Tool;
    }
    return null;
}

async function discoverPluginDirectories(baseDir: string): Promise<PluginDefinition[]> {
    if (!existsSync(baseDir)) return [];

    const entries = (await readdir(baseDir, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name));

    const plugins: PluginDefinition[] = [];
    for (const entry of entries) {
        const pluginDir = join(baseDir, entry.name);
        const hasResources = [join(pluginDir, 'skills'), join(pluginDir, 'prompts'), join(pluginDir, 'agents'), join(pluginDir, 'tools')]
            .some(dir => existsSync(dir));
        if (hasResources || existsSync(join(pluginDir, 'plugin.json'))) {
            plugins.push({ name: entry.name, directory: pluginDir, baseDir });
        }
    }

    return plugins;
}

export async function discoverPlugins(workspaceRoot: string, homeDir?: string): Promise<PluginDefinition[]> {
    const roots = [join(workspaceRoot, 'plugins')];
    if (homeDir) roots.push(join(homeDir, '.maestro', 'plugins'));

    const discovered: PluginDefinition[] = [];
    for (const root of roots) {
        const plugins = await discoverPluginDirectories(root);
        for (const plugin of plugins) {
            if (!discovered.some(existing => existing.directory === plugin.directory)) {
                discovered.push(plugin);
            }
        }
    }

    return discovered;
}

export async function loadPluginResources(opts: { workspaceRoot: string; homeDir?: string }): Promise<PluginResourceBundle> {
    const plugins = await discoverPlugins(opts.workspaceRoot, opts.homeDir);
    const skills: Skill[] = [];
    const agents: AgentDef[] = [];
    const tools: Tool[] = [];

    for (const plugin of plugins) {
        const skillDir = join(plugin.directory, 'skills');
        const promptDir = existsSync(join(plugin.directory, 'prompts')) ? join(plugin.directory, 'prompts') : join(plugin.directory, 'agents');
        const toolDir = join(plugin.directory, 'tools');

        skills.push(...await loadSkills(skillDir));
        agents.push(...await loadAgents(promptDir));
        tools.push(...await loadPluginTools(toolDir));
    }

    return { plugins, skills, agents, tools };
}