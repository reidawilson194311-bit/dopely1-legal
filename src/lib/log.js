import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLOR = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function emit(level, scope, msg, extra) {
  if (LEVELS[level] < (LEVELS[config.logLevel] ?? 20)) return;
  const ts = new Date().toISOString().slice(11, 19);
  const tag = `[${scope}]`;
  const head = useColor ? `${COLOR[level]}${ts} ${tag}${RESET}` : `${ts} ${tag}`;
  const tail = extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;
  stream(`${head} ${msg}${tail}`);
}

export function logger(scope) {
  return {
    debug: (m, e) => emit('debug', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    error: (m, e) => emit('error', scope, m, e),
    /** Section banner used by the skills so a run reads like the diagram. */
    banner: (title, subtitle) => {
      if (LEVELS.info < (LEVELS[config.logLevel] ?? 20)) return;
      const bar = '─'.repeat(Math.max(8, title.length + 4));
      console.log(`\n${bar}\n  ${title}${subtitle ? `\n  ${subtitle}` : ''}\n${bar}`);
    },
  };
}

export default logger;
