import { createClient, type Client } from '@libsql/client'
import { randomUUID } from 'crypto'
import type { MemoryEntry } from './types';

export class Memory {
    private db: Client;

    constructor(url: string, authToken?: string) {
        this.db = createClient({ url, authToken });
        this.init();
    }

    private async init() {
        await this.db.execute(`
            CREATE TABLE IF NOT EXISTS memory (
              id TEXT PRIMARY KEY,
              agent_id TEXT NOT NULL,
              type TEXT NOT NULL,
              content TEXT NOT NULL,
              metadata TEXT,
              created_at INTEGER NOT NULL
            )
          `);
        await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_agent ON memory(agent_id)`);
        await this.db.execute(`CREATE INDEX IF NOT EXISTS idx_type ON memory(type)`);
        await this.db.execute(`
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, content_rowid=rowid)
          `);
    }

    async add(entry: Omit<MemoryEntry, 'id' | 'created_at'>) {
        const id = randomUUID()
        const now = Date.now()
        await this.db.execute({
            sql: `INSERT INTO memory (id, agent_id, type, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
            args: [id, entry.agent_id, entry.type, entry.content, entry.metadata ?? null, now],
        });
        await this.db.execute({
            sql: `INSERT INTO memory_fts (rowid, content) VALUES (last_insert_rowid(), ?)`,
            args: [entry.content],
        });
    }

    async search(agentId: string, query: string, type?: string, limit = 5): Promise<MemoryEntry[]> {
        let sql = `
          SELECT m.* FROM memory m
          JOIN memory_fts fts ON m.rowid = fts.rowid
          WHERE m.agent_id = ? AND fts.content MATCH ?
        `;
        const args: any[] = [agentId, query];
        if (type) { sql += ` AND m.type = ?`; args.push(type); }
        sql += ` ORDER BY rank LIMIT ?`;
        args.push(limit);
        return (await this.db.execute({ sql, args })).rows as unknown as MemoryEntry[];
    }

    async getRecent(agentId: string, type?: string, limit = 20): Promise<MemoryEntry[]> {
        let sql = `SELECT * FROM memory WHERE agent_id = ?`;
        const args: any[] = [agentId];
        if (type) { sql += ` AND type = ?`; args.push(type); }
        sql += ` ORDER BY created_at DESC LIMIT ?`;
        args.push(limit);
        return (await this.db.execute({ sql, args })).rows as unknown as MemoryEntry[];
    }

    async getLearnings(agentId: string, query: string): Promise<string[]> {
        return (await this.search(agentId, query, 'learning', 3)).map(r => r.content);
    }
}