import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverPlugins, loadPluginResources } from '../../src/core/loader';

describe('plugin discovery', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const dir of tempRoots.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('discovers plugin folders, loads markdown skills and prompt definitions, and imports plugin tools', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'maestro-workspace-'));
    tempRoots.push(workspaceRoot);

    const pluginDir = join(workspaceRoot, 'plugins', 'demo-plugin');
    mkdirSync(join(pluginDir, 'skills'), { recursive: true });
    mkdirSync(join(pluginDir, 'prompts'), { recursive: true });
    mkdirSync(join(pluginDir, 'tools'), { recursive: true });

    writeFileSync(join(pluginDir, 'skills', 'diagnostics.md'), `---
name: diagnostics
description: Diagnose problems
---
Check the service logs.`);

    writeFileSync(join(pluginDir, 'prompts', 'incident.md'), `---
name: incident
---
Handle the incident with calm reasoning.`);

    writeFileSync(join(pluginDir, 'tools', 'hello.ts'), `export const tool = {
  name: 'hello_plugin',
  description: 'A simple plugin tool',
  parameters: { type: 'object', properties: {} },
  handler: async () => 'plugin-ok',
  risk: 'read'
};`);

    const plugins = await discoverPlugins(workspaceRoot, join(tmpdir(), 'maestro-home-'));
    const resources = await loadPluginResources({ workspaceRoot, homeDir: join(tmpdir(), 'maestro-home-') });

    expect(plugins.some(plugin => plugin.name === 'demo-plugin')).toBe(true);
    expect(resources.skills.some(skill => skill.name === 'diagnostics')).toBe(true);
    expect(resources.agents.some(agent => agent.name === 'incident')).toBe(true);
    expect(resources.tools.some(tool => tool.name === 'hello_plugin')).toBe(true);
  });
});
