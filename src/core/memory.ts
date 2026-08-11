import { createClient } from '@libsql/client';
import { randomUUID } from 'crypto';
import type { MemoryEntry, Memory } from './types';

/**
 * Formats a raw user query string safely for SQLite FTS5 MATCH expressions.
 * Preserves SRE punctuation (IP addresses, pod names, path slashes, status codes)
 * by escaping internal double quotes and wrapping punctuated tokens in phrase quotes.
 */
export function sanitizeFts5(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return 'nullquery';

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 'nullquery';

  const formattedTokens = tokens.map(token => {
    const escaped = token.replace(/"/g, '""');
    if (/[^a-zA-Z0-9]/.test(token) || /^(AND|OR|NOT|NEAR)$/i.test(token)) {
      return `"${escaped}"`;
    }
    return escaped;
  });

  return formattedTokens.join(' ');
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

    try {
      let sql = `
        SELECT m.* FROM memory m
        JOIN memory_fts fts ON m.rowid = fts.rowid
        WHERE m.agent_id = ? AND fts.content MATCH ?
      `;
      const args: any[] = [agentId, safeQuery];
      if (type) { sql += ` AND m.type = ?`; args.push(type); }
      sql += ` ORDER BY rank LIMIT ?`;
      args.push(limit);

      const rows = (await db.execute({ sql, args })).rows as unknown as MemoryEntry[];
      if (rows.length > 0) return rows;
    } catch {
      // FTS MATCH query syntax issue fallback
    }

    // Fallback: SQL LIKE search across individual words (not the whole phrase)
    const words = query.trim().split(/\s+/).filter(w => w.length > 2);
    if (words.length > 0) {
      const conditions = words.map(() => `content LIKE ?`);
      const likeArgs: any[] = [agentId, ...words.map(w => `%${w}%`)];
      let fallbackSql = `SELECT * FROM memory WHERE agent_id = ? AND (${conditions.join(' OR ')})`;
      if (type) { fallbackSql += ` AND type = ?`; likeArgs.push(type); }
      fallbackSql += ` ORDER BY created_at DESC LIMIT ?`;
      likeArgs.push(limit);

      try {
        const rows = (await db.execute({ sql: fallbackSql, args: likeArgs })).rows as unknown as MemoryEntry[];
        if (rows.length > 0) return rows;
      } catch { /* individual-word fallback failed */ }
    }

    // Second fallback: whole-phrase LIKE search
    let fallbackSql = `SELECT * FROM memory WHERE agent_id = ? AND content LIKE ?`;
    const fallbackArgs: any[] = [agentId, `%${query.trim()}%`];
    if (type) { fallbackSql += ` AND type = ?`; fallbackArgs.push(type); }
    fallbackSql += ` ORDER BY created_at DESC LIMIT ?`;
    fallbackArgs.push(limit);

    return (await db.execute({ sql: fallbackSql, args: fallbackArgs })).rows as unknown as MemoryEntry[];
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
      const rows = await search(agentId, query, undefined, limit);
      return rows.map(r => `[${r.type}] ${r.content.slice(0, 500)}`);
    },
  };

  return memory;
}