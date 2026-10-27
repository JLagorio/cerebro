import type { CliReadiness } from './cliReadinessTypes';

export function cliReadinessWords(status: CliReadiness): string {
  switch (status.state) {
    case 'checking':
      return 'Checking for Claude Code…';
    case 'available':
      return `Claude Code ${status.version ?? '(version not reported)'}`;
    case 'missing':
      return 'Claude Code was not found on this machine. Install it, then choose Check again.';
    case 'unavailable':
      switch (status.code) {
        case 'timeout':
          return 'Checking for Claude Code timed out. Try checking again.';
        case 'permission':
          return 'Cerebro could not access Claude Code. Check its permissions, then try again.';
        case 'output_limit':
          return 'The Claude Code check returned too much output. Try checking again.';
        default:
          return "Couldn't check for Claude Code on this machine.";
      }
  }
}
