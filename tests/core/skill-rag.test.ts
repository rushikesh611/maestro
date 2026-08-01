import { describe, expect, test } from 'bun:test';
import { selectRelevantSkills } from '../../src/core/skill-rag';
import type { Skill } from '../../src/core/types';

const k8sSkill: Skill = {
  name: 'k8s-troubleshooting',
  description: 'Kubernetes pod and service debugging workflows',
  content: 'CrashLoopBackOff, OOMKilled, pod eviction, service endpoints',
  tags: ['kubernetes', 'debugging', 'production'],
};

const incidentSkill: Skill = {
  name: 'incident-response',
  description: 'Structured incident management and RCA postmortem',
  content: 'Detect, triage, mitigate, verify, postmortem',
  tags: ['incident', 'management', 'rca', 'postmortem'],
};

const linuxSkill: Skill = {
  name: 'linux-debugging',
  description: 'Linux OS process and network debugging',
  content: 'journalctl, strace, netstat, systemd, dmesg',
  tags: ['linux', 'debugging', 'os'],
};

const allSkills = [k8sSkill, incidentSkill, linuxSkill];

describe('Dynamic Skill Selection RAG (Task 2.2)', () => {
  test('selects k8s skill for kubernetes-related query', () => {
    const result = selectRelevantSkills('my kubernetes pod is in CrashLoopBackOff', allSkills, 1);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('k8s-troubleshooting');
  });

  test('selects incident skill for incident postmortem query', () => {
    const result = selectRelevantSkills('we need to do a postmortem after this incident', allSkills, 1);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('incident-response');
  });

  test('selects linux skill for journalctl/systemd query', () => {
    const result = selectRelevantSkills('check journalctl logs for systemd failures', allSkills, 1);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('linux-debugging');
  });

  test('returns top scoring skills for a broad SRE query (linux excluded — no overlap)', () => {
    const result = selectRelevantSkills('debug production kubernetes incident', allSkills, 3);
    const names = result.map(s => s.name);
    // 'linux-debugging' has no token overlap with this query → only 2 skills score > 0
    expect(names).toContain('k8s-troubleshooting');
    expect(names).toContain('incident-response');
    expect(names).not.toContain('linux-debugging');
  });

  test('returns first topK when query has no matching tokens', () => {
    const result = selectRelevantSkills('', allSkills, 2);
    expect(result).toHaveLength(2);
  });

  test('returns empty array when skills list is empty', () => {
    const result = selectRelevantSkills('kubernetes pod crash', [], 3);
    expect(result).toHaveLength(0);
  });

  test('does not inject more skills than available', () => {
    const result = selectRelevantSkills('linux debugging', [linuxSkill], 10);
    expect(result).toHaveLength(1);
  });
});
