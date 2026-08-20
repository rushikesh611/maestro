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
  exec: [
    'which',
    'where',
    'pwd',
    'whoami',
    'echo',
    'hostname',
    'uname',
    'uptime',
    'date',
    'ls',
    'dir',
    'cat',
    'head',
    'tail',
    'grep',
    'find',
    'aws',
  ],
  aws: [
    'describe',
    'list',
    'get',
    'ls',
    'help',
    'version',
    'sts',
    'ec2',
    's3',
    'iam',
    'cloudwatch',
    'logs',
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
  // Allow safe stdio redirects like 2>&1, logical operators (|| &&), or safe pipes to head/tail/grep/wc
  const sanitized = command
    .replace(/\|\|/g, '')
    .replace(/&&/g, '')
    .replace(/2>&1/g, '')
    .replace(/\|\s*(?:head|tail|grep|wc|sort|uniq|less|more|cat)\b[^\r\n;&|<>`]*/gi, '');
  return DANGEROUS_OPERATORS_REGEX.test(sanitized);
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
  const command = (args?.command || args?.cmd || '') as string;
  if (!command || typeof command !== 'string') return false;

  // Disallow dangerous operators
  if (hasDangerousOperators(command)) {
    return false;
  }

  const toolName = tool.toLowerCase();

  // If tool is exec, check if it starts with docker, kubectl, helm or a safe exec verb
  if (toolName === 'exec') {
    const verb = extractSubcommandVerb(command)?.toLowerCase();
    if (!verb) return false;

    if (READ_VERBS.exec?.includes(verb)) return true;

    if (verb === 'docker' || verb === 'kubectl' || verb === 'helm') {
      const rest = command.slice(command.indexOf(verb) + verb.length);
      const subVerb = extractSubcommandVerb(rest)?.toLowerCase();
      if (subVerb && READ_VERBS[verb]?.includes(subVerb)) return true;
    }
    if (verb === 'aws') {
      const rest = command.slice(command.indexOf('aws') + 3);
      const service = extractSubcommandVerb(rest)?.toLowerCase();
      if (!service) return false;
      // Direct aws verbs like "aws help", "aws version"
      if (['help', 'version'].includes(service)) return true;
      // For aws <service> <read-action>, check READ_VERBS.aws for common read prefixes
      const actionRest = rest.slice(rest.indexOf(service) + service.length);
      const action = extractSubcommandVerb(actionRest)?.toLowerCase();
      if (action) {
        const readPrefixes = ['describe', 'list', 'get', 'help', 'version'];
        if (readPrefixes.some(p => action === p || action.startsWith(p + '-'))) return true;
      }
    }
    return false;
  }

  const validVerbs = READ_VERBS[toolName];
  if (!validVerbs) return false;

  const verb = extractSubcommandVerb(command);
  if (!verb) return false;

  return validVerbs.includes(verb.toLowerCase());
}
