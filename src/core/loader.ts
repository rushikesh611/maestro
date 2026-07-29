import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { Skill, AgentDef } from './types';

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