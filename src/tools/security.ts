/**
 * Security module for command tokenization and risk analysis.
 * Prevents command injection and approval bypasses.
 */

const READ_VERBS: Record<string, string[]> = {
  kubectl: [
    'get',
    'describe',
    'logs',
    'top',
    'status',
    'version',
    'api-resources',
    'api-versions',
    'cluster-info',
    'explain',
    'config',
  ],
  docker: [
    'ps',
    'logs',
    'inspect',
    'stats',
    'images',
    'info',
    'version',
    'history',
    'top',
  ],
  helm: [
    'list',
    'ls',
    'status',
    'version',
    'history',
    'get',
    'inspect',
    'show',
    'env',
    'search',
  ],
};

// Regex matching dangerous shell syntax operators that allow command chaining, redirection, or subshells
const DANGEROUS_OPERATORS_REGEX = /(?:[;&|<>`]|\$\(|\$\{)/;

/**
 * Returns true if the command contains shell chaining, piping, redirection, backticks, or subshells.
 */
export function hasDangerousOperators(command: string): boolean {
  if (!command) return false;
  if (/[\r\n]/.test(command)) return true;
  return DANGEROUS_OPERATORS_REGEX.test(command);
}

/**
 * Tokenizes a shell command string while respecting quotes, skipping global flags
 * (e.g. -n prod, --kubeconfig=/path) to locate the primary subcommand verb.
 */
export function extractSubcommandVerb(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const tokens: string[] = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(trimmed)) !== null) {
    const token = match[1] ?? match[2] ?? match[3];
    if (token) tokens.push(token);
  }

  if (tokens.length === 0) return null;

  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (!tok) break;

    // Skip flags starting with '-'
    if (tok.startsWith('-')) {
      // Inline assignment like --namespace=prod
      if (tok.includes('=')) {
        idx++;
        continue;
      }
      // Flag with space-separated value like -n prod or --kubeconfig /file
      const next = tokens[idx + 1];
      if (next && !next.startsWith('-')) {
        idx += 2;
        continue;
      }
      idx++;
      continue;
    }

    // Found the first non-flag token - this is the subcommand verb
    return tok;
  }

  return null;
}

/**
 * Evaluates whether a tool invocation is safe for auto-approval.
 */
export function isAutoApprovable(tool: string, args: Record<string, any>): boolean {
  const toolName = tool.toLowerCase();
  const validVerbs = READ_VERBS[toolName];
  if (!validVerbs) return false;

  const command = (args?.command || args?.cmd || '') as string;
  if (!command || typeof command !== 'string') return false;

  // Disallow any command with chaining, redirection, or subshells
  if (hasDangerousOperators(command)) {
    return false;
  }

  // Extract subcommand verb skipping options
  const verb = extractSubcommandVerb(command);
  if (!verb) return false;

  return validVerbs.includes(verb.toLowerCase());
}
