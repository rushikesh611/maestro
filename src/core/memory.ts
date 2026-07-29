import { createClient } from '@libsql/client';
import { randomUUID } from 'crypto';
import type { MemoryEntry, Memory } from './types';

/**
 * FTS5 MATCH treats punctuation as query operators.
 * Strip everything except alphanumeric and spaces to prevent syntax errors.
 */
function sanitizeFts5(query: string): string {
  const cleaned = query.replace(/[^a-zA-Z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'nullquery'; // fallback that matches nothing
}

export async function createMemory(url: string, authToken?: string): Promise<Memory> {
  const db = createClient({ url, authToken });

  await db.execute(`
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_agent ON memory(agent_id)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_type ON memory(type)`);
  await db.execute(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, content_rowid=rowid)
  `);

  const search = async (agentId: string, query: string, type?: string, limit = 5): Promise<MemoryEntry[]> => {
    const safeQuery = sanitizeFts5(query);

    let sql = `
      SELECT m.* FROM memory m
      JOIN memory_fts fts ON m.rowid = fts.rowid
      WHERE m.agent_id = ? AND fts.content MATCH ?
    `;
    const args: any[] = [agentId, safeQuery];
    if (type) { sql += ` AND m.type = ?`; args.push(type); }
    sql += ` ORDER BY rank LIMIT ?`;
    args.push(limit);
    return (await db.execute({ sql, args })).rows as unknown as MemoryEntry[];
  };

  const memory: Memory = {
    async add(entry) {
      const id = randomUUID();
      const now = Date.now();
      const rs = await db.execute({
        sql: `INSERT INTO memory (id, agent_id, type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        args: [id, entry.agent_id, entry.type, entry.content, entry.metadata ?? null, now],
      });

      if (rs.lastInsertRowid === undefined) {
        throw new Error('Failed to get lastInsertRowid for FTS index');
      }

      await db.execute({
        sql: `INSERT INTO memory_fts (rowid, content) VALUES (?, ?)`,
        args: [rs.lastInsertRowid, entry.content] as any[],
      });
    },

    search,

    async getRecent(agentId, type?, limit = 20) {
      let sql = `SELECT * FROM memory WHERE agent_id = ?`;
      const args: any[] = [agentId];
      if (type) { sql += ` AND type = ?`; args.push(type); }
      sql += ` ORDER BY created_at DESC LIMIT ?`;
      args.push(limit);
      return (await db.execute({ sql, args })).rows as unknown as MemoryEntry[];
    },

    async getLearnings(agentId, query) {
      return (await search(agentId, query, 'learning', 3)).map(r => r.content);
    },

    async getRelevantContext(agentId, query, limit = 5) {
      const safeQuery = sanitizeFts5(query);
      const sql = `
        SELECT m.* FROM memory m
        JOIN memory_fts fts ON m.rowid = fts.rowid
        WHERE m.agent_id = ? AND fts.content MATCH ?
        ORDER BY rank LIMIT ?
      `;
      const rows = (await db.execute({ sql, args: [agentId, safeQuery, limit] })).rows as unknown as MemoryEntry[];
      return rows.map(r => `[${r.type}] ${r.content.slice(0, 500)}`);
    },
  };

  return memory;
}