import { describe, expect, test } from 'bun:test';
import { isAutoApprovable, hasDangerousOperators, extractSubcommandVerb } from '../../src/tools/security';

describe('Security Approval Guard (Task 1.1)', () => {
  describe('hasDangerousOperators', () => {
    test('detects shell chaining operators', () => {
      expect(hasDangerousOperators('kubectl get pods; rm -rf /')).toBe(true);
      expect(hasDangerousOperators('kubectl get pods && kubectl delete ns prod')).toBe(true);
      expect(hasDangerousOperators('kubectl get pods || echo fail')).toBe(true);
      expect(hasDangerousOperators('kubectl get pods & bg_job')).toBe(true);
    });

    test('detects piping and redirection', () => {
      expect(hasDangerousOperators('docker ps | xargs docker stop')).toBe(true);
      expect(hasDangerousOperators('kubectl logs pod-x > logs.txt')).toBe(true);
      expect(hasDangerousOperators('kubectl get pods >> pods.txt')).toBe(true);
      expect(hasDangerousOperators('cat < secret.txt')).toBe(true);
    });

    test('detects subshells and backticks', () => {
      expect(hasDangerousOperators('kubectl logs $(cat secret.txt)')).toBe(true);
      expect(hasDangerousOperators('kubectl get pods `whoami`')).toBe(true);
      expect(hasDangerousOperators('kubectl logs ${ENV_VAR}')).toBe(true);
    });

    test('detects newline injection', () => {
      expect(hasDangerousOperators('kubectl get pods\nrm -rf /')).toBe(true);
      expect(hasDangerousOperators('kubectl get pods\r\necho hack')).toBe(true);
    });

    test('returns false for safe commands', () => {
      expect(hasDangerousOperators('kubectl get pods -n prod')).toBe(false);
      expect(hasDangerousOperators('docker ps -a --format "table {{.ID}}"\t{{.Names}}')).toBe(false);
      expect(hasDangerousOperators('helm list --namespace kube-system')).toBe(false);
    });
  });

  describe('extractSubcommandVerb', () => {
    test('extracts direct subcommand verb', () => {
      expect(extractSubcommandVerb('get pods')).toBe('get');
      expect(extractSubcommandVerb('ps -a')).toBe('ps');
      expect(extractSubcommandVerb('list')).toBe('list');
    });

    test('skips global flags to find verb', () => {
      expect(extractSubcommandVerb('-n default get pods')).toBe('get');
      expect(extractSubcommandVerb('--namespace=prod describe pod/api')).toBe('describe');
      expect(extractSubcommandVerb('--kubeconfig /tmp/config logs my-pod')).toBe('logs');
    });
  });

  describe('isAutoApprovable', () => {
    test('auto-approves read-only kubectl commands', () => {
      expect(isAutoApprovable('kubectl', { command: 'get pods' })).toBe(true);
      expect(isAutoApprovable('kubectl', { command: '-n prod describe pod/web-1' })).toBe(true);
      expect(isAutoApprovable('kubectl', { command: 'logs my-pod --tail 50' })).toBe(true);
      expect(isAutoApprovable('kubectl', { command: 'top nodes' })).toBe(true);
    });

    test('auto-approves read-only docker commands', () => {
      expect(isAutoApprovable('docker', { command: 'ps -a' })).toBe(true);
      expect(isAutoApprovable('docker', { command: 'logs container_id' })).toBe(true);
      expect(isAutoApprovable('docker', { command: 'inspect image_name' })).toBe(true);
      expect(isAutoApprovable('docker', { command: 'images' })).toBe(true);
    });

    test('auto-approves read-only helm commands', () => {
      expect(isAutoApprovable('helm', { command: 'list -A' })).toBe(true);
      expect(isAutoApprovable('helm', { command: 'status my-release' })).toBe(true);
    });

    test('rejects mutating verbs', () => {
      expect(isAutoApprovable('kubectl', { command: 'delete pod/web-1' })).toBe(false);
      expect(isAutoApprovable('kubectl', { command: 'apply -f deployment.yaml' })).toBe(false);
      expect(isAutoApprovable('docker', { command: 'run -d ubuntu' })).toBe(false);
      expect(isAutoApprovable('docker', { command: 'rm container_id' })).toBe(false);
      expect(isAutoApprovable('helm', { command: 'uninstall my-release' })).toBe(false);
    });

    test('rejects command injection bypasses', () => {
      expect(isAutoApprovable('kubectl', { command: 'get pods; delete ns prod' })).toBe(false);
      expect(isAutoApprovable('kubectl', { command: 'get pods && rm -rf /' })).toBe(false);
      expect(isAutoApprovable('docker', { command: 'ps | xargs docker stop' })).toBe(false);
      expect(isAutoApprovable('kubectl', { command: 'logs $(cat secret.txt)' })).toBe(false);
      expect(isAutoApprovable('kubectl', { command: 'get pods > pods.txt' })).toBe(false);
    });

    test('rejects unrecognised tools or empty commands', () => {
      expect(isAutoApprovable('exec', { command: 'ls -la' })).toBe(false);
      expect(isAutoApprovable('kubectl', { command: '' })).toBe(false);
      expect(isAutoApprovable('unknown_tool', { command: 'get' })).toBe(false);
    });
  });
});
