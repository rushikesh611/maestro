export interface Message {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

export interface ToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string }
}

// Low-level executable functions the LLM can call 
export interface Tool {
    name: string;
    description: string;
    parameters: Record<string, any>;
    handler: (args: any, ctx: Context) => Promise<string>;
    risk: 'read' | 'mutate' | 'dangerous'
}

// Skills = markdown expertise injected into the system prompt
export interface Skill {
    name: string;
    description: string;
    content: string;
    tags: string[];
}

// Agents = markdown personality definitions for sub-agents
export interface AgentDef {
    name: string;
    description: string;
    systemPrompt: string;
    model?: string;
}

export interface Context {
    agentId: string;
    parentId?: string;
    memory: Memory;
    llm: LLM;
    workingDir: string;
    skills: Skill[];
    onApprove?: (tool: string, args: any, risk: string) => Promise<boolean>;
}

export interface AgentState {
    id: string;
    name: string;
    systemPrompt: string;
    messages: Message[];
    tools: Map<string, Tool>;
    skills: Skill[];
    llm: LLM;
    memory: Memory;
    workingDir: string;
    maxIterations: number;
    iteration: number;
    parentId?: string;
    onApprove?: (tool: string, args: any, risk: string) => Promise<boolean>;
}

export interface LLMConfig {
    apiKey: string;
    model: string;
    baseURL?: string;
    siteUrl?: string;
    siteName?: string;
}

export interface LLMResponse {
    content: string | null;
    tool_calls?: ToolCall[];
}

export interface LLM {
    chat(messages: Message[], tools?: Tool[]): Promise<LLMResponse>;
}


export interface Memory {
    add(entry: Omit<MemoryEntry, 'id' | 'created_at'>): Promise<void>;
    search(agentId: string, query: string, type?: string, limit?: number): Promise<MemoryEntry[]>;
    getRecent(agentId: string, type?: string, limit?: number): Promise<MemoryEntry[]>;
    getLearnings(agentId: string, query: string): Promise<string[]>;
    getRelevantContext(agentId: string, query: string, limit?: number): Promise<string[]>; // NEW
  }

export interface MemoryEntry {
    id: string;
    agent_id: string;
    type: 'conversation' | 'fact' | 'learning' | 'skill';
    content: string;
    metadata?: string;
    created_at: number;
}