// SPDX-License-Identifier: Apache-2.0

/**
 * Shell-aware git-command parsing.
 *
 * The first implementation substring-matched (`cmd.includes('git push')`), the
 * second split the raw string on `&&|;|\|` and anchored a regex at each piece.
 * Both read the command as TEXT. That is the defect behind #793: the separator
 * split runs BEFORE any quote handling, so it cuts inside single-quoted
 * arguments and heredoc bodies, and a `git push` that is only ever DATA —
 * a markdown table cell being written to a file, a script handed to
 * `tmux send-keys` — is classified as a real mutation. A doc mentioning two
 * pushes then looked like two mutation targets, attribution failed, and the
 * hook blocked a command that never touched GitHub while reporting a
 * credential problem that did not exist.
 *
 * So: TOKENIZE FIRST, then segment. `tokenizeShellCommand` walks the command
 * once, honouring quotes (including `$'…'`), backslash escapes, `#` comments,
 * `$(...)`/backtick substitution, redirections, heredoc bodies and subshell
 * parentheses, and emits a list of segments, each a list of expanded words.
 * Every classifier here — and the mutation-target resolver in
 * `github-command-target.ts`, which used to carry its own copy of the
 * separator regex — reads those segments, so both agree on what a command
 * actually runs.
 *
 * FAIL CLOSED WHEN THE TOKENIZER CANNOT PARSE. `tokenizeShellCommand` returns
 * `null` for a command it cannot read (an unterminated quote or substitution).
 * `null` means "I do not know what this runs", NEVER "nothing here": every
 * classifier below falls back to a cheap raw-text scan and answers
 * conservatively — `detectGitOp` returns the distinct `'unparseable'` op, which
 * the hook turns into an ATTRIBUTION block, and the two Bash-edit-capture
 * predicates return `true` so the capture skips rather than crediting foreign
 * content to the agent.
 *
 * Scope, deliberately: a word is inspected only in COMMAND POSITION, with one
 * level of unwrapping for `sh|bash|zsh|dash|ksh -c <script>` (including the
 * bundled `-lc` / `-ec` / `-xc` spellings) and `eval`. A git
 * mutation reached any other indirect way is not classified here and is not
 * meant to be. Command position does see through the common prefixes
 * (`command`, `exec`, `time`, `timeout N`, `nohup`, `sudo`, `env`, `xargs`)
 * and the reserved words that open a command (`{ …; }`, `!`, `if`/`then`/
 * `else`/`elif`, `do`, `while`/`until`); see `commandWordIndex` (#821). The
 * known non-classified class is interpreter-wrapped calls (`python -c`,
 * `node -e` and the like), which only the helper sees. This parser decides
 * what to OBSERVE and what to attribute a credential to; the Spellguard git
 * credential helper, which git itself invokes per (owner, repository), remains
 * the authoritative gate.
 */

export type GitOp =
  | 'push'
  | 'checkout_new_branch'
  | 'switch_new_branch'
  | 'commit'
  /** The command could not be tokenized but its text mentions a git mutation. */
  | 'unparseable'
  | null;

/** One `&&`/`||`/`;`/`|`/newline-delimited piece of a command, tokenized. */
export interface ShellSegment {
  /** Words in order, quotes removed, redirections and heredocs stripped. */
  words: string[];
  /**
   * Segments of a `sh -c <script>` / `eval` payload, tokenized one level deep.
   * They run in a subshell, so a directory change inside them does not escape.
   */
  nested?: ShellSegment[];
  /**
   * A subshell boundary rather than a command. `(` opens and `)` closes, and a
   * `cd` between them does not survive the closing paren.
   */
  subshell?: 'open' | 'close';
}

const WHITESPACE = /\s/;

interface PendingHeredoc {
  delimiter: string;
  stripTabs: boolean;
}

/** Shells whose `-c <script>` payload is unwrapped one level. */
const SHELL_WRAPPERS = ['sh', 'bash', 'zsh', 'dash', 'ksh'];
/**
 * The `-c` flag, alone or bundled: `bash -lc '…'`, `sh -ec '…'` and
 * `bash -xc '…'` all take the script as the next word, exactly as `-c` does.
 * Matching only the literal `-c` left those three unwrapped AND unlisted.
 */
const SHELL_COMMAND_FLAG_RE = /^-[A-Za-z]*c$/;

/** The script a `sh -c …` / `eval …` segment would run, if any. */
function nestedShellPayload(words: string[]): string | null {
  for (const shell of SHELL_WRAPPERS) {
    const shellIndex = commandWordIndex(words, shell);
    if (shellIndex < 0) continue;
    for (let index = shellIndex + 1; index < words.length; index++) {
      if (SHELL_COMMAND_FLAG_RE.test(words[index])) {
        return words[index + 1] ?? null;
      }
    }
    return null;
  }
  const evalIndex = commandWordIndex(words, 'eval');
  if (evalIndex >= 0 && words.length > evalIndex + 1) {
    // `eval` concatenates its arguments and runs the result as one command.
    return words.slice(evalIndex + 1).join(' ');
  }
  return null;
}

/**
 * Tokenize a shell command into separator-delimited segments of words.
 *
 * Returns `null` when the command cannot be tokenized. Callers must treat
 * `null` as "I do not know what this runs" and fail closed.
 *
 * `depth` is internal: a `-c` payload is unwrapped exactly one level, so a
 * script that spawns a shell that spawns a shell stops being followed.
 */
export function tokenizeShellCommand(
  command: string,
  depth = 0,
): ShellSegment[] | null {
  if (typeof command !== 'string') return null;

  const segments: ShellSegment[] = [];
  let words: string[] = [];
  let current = '';
  let started = false;
  let failed = false;
  const heredocs: PendingHeredoc[] = [];
  let index = 0;

  const flushWord = (): void => {
    if (!started) return;
    words.push(current);
    current = '';
    started = false;
  };
  const flushSegment = (): void => {
    flushWord();
    const segment: ShellSegment = { words };
    if (depth === 0) {
      const payload = nestedShellPayload(words);
      if (payload !== null) {
        const nested = tokenizeShellCommand(payload, depth + 1);
        // An unreadable inner script makes the WHOLE command unreadable: the
        // outer text alone cannot say what the inner one runs.
        if (!nested) failed = true;
        else segment.nested = nested;
      }
    }
    segments.push(segment);
    words = [];
  };
  const append = (value: string): void => {
    current += value;
    started = true;
  };

  /** Read one word starting at `from`, for heredoc delimiters and redirection
   * targets. Returns the expanded value and the index just past it. */
  const readWord = (from: number): { value: string; next: number } | null => {
    let cursor = from;
    while (cursor < command.length && WHITESPACE.test(command[cursor])) {
      if (command[cursor] === '\n') return { value: '', next: cursor };
      cursor++;
    }
    let value = '';
    while (cursor < command.length) {
      const char = command[cursor];
      if (WHITESPACE.test(char) || isSeparatorStart(command, cursor)) break;
      if (char === '\\') {
        if (cursor + 1 >= command.length) return null;
        value += command[cursor + 1];
        cursor += 2;
        continue;
      }
      if (char === "'" || char === '"') {
        const end = command.indexOf(char, cursor + 1);
        if (end < 0) return null;
        value += command.slice(cursor + 1, end);
        cursor = end + 1;
        continue;
      }
      value += char;
      cursor++;
    }
    return { value, next: cursor };
  };

  /** Consume the body of every heredoc opened on the line just ended. */
  const consumeHeredocBodies = (from: number): number => {
    let cursor = from;
    while (heredocs.length > 0) {
      const doc = heredocs.shift();
      if (!doc) break;
      for (;;) {
        const end = command.indexOf('\n', cursor);
        const raw = command.slice(cursor, end < 0 ? command.length : end);
        const line = doc.stripTabs ? raw.replace(/^\t+/, '') : raw;
        cursor = end < 0 ? command.length : end + 1;
        if (line === doc.delimiter || end < 0) break;
      }
    }
    return cursor;
  };

  while (index < command.length) {
    const char = command[index];

    if (char === '\n') {
      flushSegment();
      index = consumeHeredocBodies(index + 1);
      continue;
    }

    // `#` begins a comment only at the start of a word. Everything to the end
    // of the line is DATA — including any quote or `$(` in it, which is why a
    // trailing `# it's done` used to make the whole command unreadable.
    if (char === '#' && !started) {
      const end = command.indexOf('\n', index);
      index = end < 0 ? command.length : end;
      continue;
    }

    if (char === '\\') {
      if (index + 1 >= command.length) return null;
      // A backslash-newline is a line continuation, not a word character.
      if (command[index + 1] === '\n') {
        index += 2;
        continue;
      }
      append(command[index + 1]);
      index += 2;
      continue;
    }

    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end < 0) return null;
      append(command.slice(index + 1, end));
      index = end + 1;
      continue;
    }

    if (char === '"') {
      const scanned = scanDoubleQuoted(command, index);
      if (!scanned) return null;
      append(scanned.value);
      index = scanned.next;
      continue;
    }

    // ANSI-C quoting: `$'it\'s'` is ONE word whose inner `\'` is a literal
    // quote, not a terminator.
    if (char === '$' && command[index + 1] === "'") {
      const scanned = scanDollarQuoted(command, index + 1);
      if (!scanned) return null;
      append(scanned.value);
      index = scanned.next;
      continue;
    }

    if (char === '`') {
      const end = command.indexOf('`', index + 1);
      if (end < 0) return null;
      append(command.slice(index, end + 1));
      index = end + 1;
      continue;
    }

    if (char === '$' && command[index + 1] === '(') {
      const end = matchingParenthesis(command, index + 1);
      if (end < 0) return null;
      append(command.slice(index, end + 1));
      index = end + 1;
      continue;
    }

    const redirection = scanRedirection(command, index, current, started);
    if (redirection) {
      // A leading file-descriptor number (`2>&1`) belongs to the operator, not
      // to the word before it.
      if (redirection.consumedFdDigits) {
        current = current.slice(0, current.length - redirection.fdDigits);
        started = current.length > 0;
      }
      flushWord();
      if (redirection.heredoc) {
        const delimiter = readWord(redirection.next);
        if (!delimiter) return null;
        heredocs.push({
          delimiter: delimiter.value,
          stripTabs: redirection.stripTabs,
        });
        index = delimiter.next;
        continue;
      }
      const target = readWord(redirection.next);
      if (!target) return null;
      index = target.next;
      continue;
    }

    const separator = separatorAt(command, index);
    if (separator) {
      flushSegment();
      if (separator === '(' || separator === ')') {
        segments.push({
          words: [],
          subshell: separator === '(' ? 'open' : 'close',
        });
      }
      index += separator.length;
      continue;
    }

    if (WHITESPACE.test(char)) {
      flushWord();
      index++;
      continue;
    }

    append(char);
    index++;
  }

  flushSegment();
  return failed ? null : segments;
}

function scanDoubleQuoted(
  command: string,
  start: number,
): { value: string; next: number } | null {
  let value = '';
  let index = start + 1;
  while (index < command.length) {
    const char = command[index];
    if (char === '\\' && index + 1 < command.length) {
      value += command[index + 1];
      index += 2;
      continue;
    }
    if (char === '$' && command[index + 1] === '(') {
      const end = matchingParenthesis(command, index + 1);
      if (end < 0) return null;
      value += command.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === '"') return { value, next: index + 1 };
    value += char;
    index++;
  }
  return null;
}

/** `$'…'`: backslash escapes are honoured, so `\'` does not end the quote. */
function scanDollarQuoted(
  command: string,
  start: number,
): { value: string; next: number } | null {
  let value = '';
  let index = start + 1;
  while (index < command.length) {
    const char = command[index];
    if (char === '\\' && index + 1 < command.length) {
      value += command[index + 1];
      index += 2;
      continue;
    }
    if (char === "'") return { value, next: index + 1 };
    value += char;
    index++;
  }
  return null;
}

function matchingParenthesis(command: string, open: number): number {
  let depth = 0;
  for (let index = open; index < command.length; index++) {
    const char = command[index];
    if (char === '\\') {
      index++;
      continue;
    }
    if (char === "'" || char === '"') {
      const end = command.indexOf(char, index + 1);
      if (end < 0) return -1;
      index = end;
      continue;
    }
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

const SEPARATORS = ['&&', '||', ';;', ';', '|&', '|', '&', '(', ')'];

function separatorAt(command: string, index: number): string | null {
  // `&>` / `&>>` are redirections, handled before this is reached.
  for (const separator of SEPARATORS) {
    if (command.startsWith(separator, index)) return separator;
  }
  return null;
}

function isSeparatorStart(command: string, index: number): boolean {
  return separatorAt(command, index) !== null;
}

interface RedirectionScan {
  next: number;
  heredoc: boolean;
  stripTabs: boolean;
  consumedFdDigits: boolean;
  fdDigits: number;
}

/**
 * Recognize a redirection operator at `index`. Redirections and their targets
 * are dropped: `git push origin main 2>&1` must resolve `origin`, not `2>&1`,
 * and a heredoc body is data the shell never executes.
 */
function scanRedirection(
  command: string,
  index: number,
  current: string,
  started: boolean,
): RedirectionScan | null {
  const char = command[index];
  const isFdPrefixed = started && /^\d+$/.test(current);
  if (char === '&') {
    if (command[index + 1] !== '>') return null;
    return {
      next: index + (command.startsWith('&>>', index) ? 3 : 2),
      heredoc: false,
      stripTabs: false,
      consumedFdDigits: false,
      fdDigits: 0,
    };
  }
  if (char !== '<' && char !== '>') return null;
  const fdDigits = isFdPrefixed ? current.length : 0;
  if (command.startsWith('<<<', index)) {
    return {
      next: index + 3,
      heredoc: false,
      stripTabs: false,
      consumedFdDigits: isFdPrefixed,
      fdDigits,
    };
  }
  if (command.startsWith('<<', index)) {
    const stripTabs = command[index + 2] === '-';
    return {
      next: index + (stripTabs ? 3 : 2),
      heredoc: true,
      stripTabs,
      consumedFdDigits: isFdPrefixed,
      fdDigits,
    };
  }
  let length = 1;
  const next = command[index + 1];
  if (next === '>' || next === '&' || next === '|') length = 2;
  return {
    next: index + length,
    heredoc: false,
    stripTabs: false,
    consumedFdDigits: isFdPrefixed,
    fdDigits,
  };
}

const ENV_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Reserved words that open a command within the same segment (#821): a brace
 * group `{ git push; }`, a negation `! git push`, and the bodies and
 * conditions of `if` / `while` / `until` / `for`: `if git push; then …`,
 * `do git push; done`, `else git push`. The command after them runs.
 */
const OPENING_RESERVED_WORDS = new Set([
  '{',
  '!',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
]);

/**
 * Prefix commands that run the rest of the segment as a command (#821), each
 * with the options it takes a separate value for. `timeout` also takes its
 * DURATION before the command.
 */
const PREFIX_VALUE_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'sudo',
    new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T']),
  ],
  ['env', new Set(['-u', '-C', '-S', '--unset', '--chdir'])],
  ['command', new Set<string>()],
  ['exec', new Set(['-a'])],
  ['time', new Set(['-f', '-o'])],
  ['nohup', new Set<string>()],
  ['timeout', new Set(['-s', '-k', '--signal', '--kill-after'])],
  [
    'xargs',
    new Set([
      '-n',
      '-L',
      '-I',
      '-P',
      '-s',
      '-d',
      '-E',
      '-a',
      '--max-args',
      '--max-lines',
      '--replace',
      '--max-procs',
      '--max-chars',
      '--delimiter',
      '--eof',
      '--arg-file',
    ]),
  ],
]);

/** Index past a prefix command's options (and `--`), from `index`. */
function skipPrefixOptions(
  words: string[],
  index: number,
  valueOptions: ReadonlySet<string>,
): number {
  let at = index;
  while (at < words.length && words[at].startsWith('-') && words[at] !== '-') {
    if (words[at] === '--') return at + 1;
    at += valueOptions.has(words[at]) ? 2 : 1;
  }
  return at;
}

/**
 * Index of `name` in command position. Returns -1 when the segment runs
 * something else.
 *
 * Skipped before the command word, in any order and repeated: leading
 * `VAR=value` assignments, the opening reserved words above, and the prefix
 * commands `sudo`, `env`, `command`, `exec`, `time`, `nohup`, `timeout <n>`
 * and `xargs`, with their options (#821). `xargs <cmd>` runs `<cmd>` with
 * arguments read from stdin that this parser can't see, so only the visible
 * ones inform attribution. `command -v` / `-V` only looks a command up
 * without running it, so it answers -1.
 */
export function commandWordIndex(words: string[], name: string): number {
  let index = skipOpeners(words, 0);
  let next = skipCommandPrefix(words, index);
  while (next !== index) {
    if (next < 0) return -1;
    index = skipOpeners(words, next);
    next = skipCommandPrefix(words, index);
  }
  return words[index] === name ? index : -1;
}

/** Index past leading assignments and opening reserved words. */
function skipOpeners(words: string[], index: number): number {
  let at = index;
  while (
    at < words.length &&
    (OPENING_RESERVED_WORDS.has(words[at]) ||
      ENV_ASSIGNMENT_RE.test(words[at] ?? ''))
  ) {
    at++;
  }
  return at;
}

/**
 * Index past the prefix command at `index` and its options; `index` itself
 * when the word there is no prefix; -1 when the prefix doesn't run the rest.
 */
function skipCommandPrefix(words: string[], index: number): number {
  const prefix = words[index];
  const valueOptions = PREFIX_VALUE_OPTIONS.get(prefix);
  if (!valueOptions) return index;
  if (prefix === 'command' && isLookupOnly(words, index + 1)) return -1;
  const end = skipPrefixOptions(words, index + 1, valueOptions);
  return prefix === 'timeout' ? end + 1 : end; // `timeout` takes a DURATION
}

/** `command -v` / `-V` (alone or bundled) only prints what would run. */
function isLookupOnly(words: string[], index: number): boolean {
  for (let at = index; words[at]?.startsWith('-'); at++) {
    if (/^-[A-Za-z]*[vV]/.test(words[at])) return true;
  }
  return false;
}

/** Git global options that take a separate value word. */
const GIT_GLOBAL_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
]);
/** Git global options that take no value. */
const GIT_GLOBAL_FLAGS = new Set([
  '--no-pager',
  '--paginate',
  '-p',
  '--bare',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
]);
/** Global options that only change WHERE git runs, not which remote it picks. */
const GIT_DIRECTORY_OPTIONS = new Set(['-C']);

export interface GitCommandHead {
  /** Directories named by `-C`, in order, each relative to the previous. */
  chdirs: string[];
  /**
   * True when a global option other than `-C` and the paging flags was
   * present. Those can rewrite `remote.<name>.url`, relocate the git dir, or
   * install a different credential helper, so a mutation carrying one cannot
   * be attributed to a remote read from the working directory.
   */
  redirected: boolean;
  /** The git subcommand, or undefined when the segment is only options. */
  subcommand?: string;
  /** Words after the subcommand. */
  args: string[];
}

/** Parse a tokenized segment as a `git` invocation, or return null. */
export function parseGitCommand(words: string[]): GitCommandHead | null {
  const gitIndex = commandWordIndex(words, 'git');
  if (gitIndex < 0) return null;
  const chdirs: string[] = [];
  let redirected = false;
  let index = gitIndex + 1;
  while (index < words.length) {
    const word = words[index];
    if (!word.startsWith('-')) break;
    const [name] = word.split('=', 1);
    if (GIT_GLOBAL_FLAGS.has(word)) {
      index++;
      continue;
    }
    if (word.includes('=') && GIT_GLOBAL_VALUE_OPTIONS.has(name)) {
      if (!GIT_DIRECTORY_OPTIONS.has(name)) redirected = true;
      else chdirs.push(word.slice(name.length + 1));
      index++;
      continue;
    }
    if (word.startsWith('-C') && word.length > 2) {
      chdirs.push(word.slice(2));
      index++;
      continue;
    }
    if (GIT_GLOBAL_VALUE_OPTIONS.has(word)) {
      const value = words[index + 1];
      if (value === undefined) return { chdirs, redirected: true, args: [] };
      if (GIT_DIRECTORY_OPTIONS.has(word)) chdirs.push(value);
      else redirected = true;
      index += 2;
      continue;
    }
    // An unknown global option may do anything; treat it as redirecting.
    redirected = true;
    index++;
  }
  const subcommand = words[index];
  return {
    chdirs,
    redirected,
    subcommand,
    args: subcommand === undefined ? [] : words.slice(index + 1),
  };
}

function hasNewBranchFlag(args: string[], flags: string[]): boolean {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--') return false;
    if (flags.includes(args[index])) {
      const name = args[index + 1];
      return name !== undefined && name.length > 0 && !name.startsWith('-');
    }
  }
  return false;
}

/** Every segment, including the ones inside an unwrapped `-c` payload. */
export function flattenShellSegments(segments: ShellSegment[]): ShellSegment[] {
  return segments.flatMap((segment) =>
    segment.nested ? [segment, ...segment.nested] : [segment],
  );
}

function segmentGitOp(words: string[]): GitOp {
  const git = parseGitCommand(words);
  if (!git?.subcommand) return null;
  if (git.subcommand === 'push') return 'push';
  if (git.subcommand === 'checkout' && hasNewBranchFlag(git.args, ['-b', '-B']))
    return 'checkout_new_branch';
  if (
    git.subcommand === 'switch' &&
    hasNewBranchFlag(git.args, ['-b', '-B', '-c'])
  )
    return 'switch_new_branch';
  if (
    git.subcommand === 'commit' &&
    !git.args.includes('--help') &&
    !git.args.includes('-h')
  )
    return 'commit';
  return null;
}

// Raw-text scans, used ONLY when the tokenizer could not read the command.
// They are deliberately loose: the question they answer is "might this command
// touch GitHub?", and on an unreadable command the honest answer must err
// towards yes.
//
// `[^\n;&|]*` between the program and its subcommand, rather than `\s+`, is
// load-bearing: global options sit there. `git -C /x push`, `git --no-pager push`
// and `gh -R owner/repo pr create` all carry one, and requiring the subcommand
// to be the very next token made the fallback miss them and hand the hook a
// null op again — the exact fail-open this fallback exists to close. The
// character class stops the match at a command separator so the scan cannot
// pair a `git` in one command with a subcommand word in the next.
const UNPARSEABLE_GIT_SCAN =
  /\bgit\b[^\n;&|]*\b(?:push|commit|checkout|switch)\b/;
const UNPARSEABLE_GH_SCAN = /\bgh\b[^\n;&|]*\bpr\s+create\b/;
const UNPARSEABLE_MATERIALIZE_SCAN =
  /\bgit\b[^\n;&|]*\b(?:merge|rebase|cherry-pick|revert|pull|reset|restore|stash|checkout|switch)\b/;
const UNPARSEABLE_AMEND_SCAN = /--amend\b/;

/**
 * Segment the command and classify the first git mutation in COMMAND position.
 * A command whose text merely mentions a mutation — inside a quoted argument, a
 * heredoc body, a `#` comment, or a command substitution — is not a mutation.
 *
 * Returns `'unparseable'` when the command could not be tokenized at all AND
 * its raw text mentions a git mutation. That is not the same as "no git op":
 * the caller must block on it rather than wave the command through.
 */
export function detectGitOp(cmd: string): GitOp {
  if (typeof cmd !== 'string' || cmd.length === 0) return null;
  const segments = tokenizeShellCommand(cmd);
  if (!segments) return UNPARSEABLE_GIT_SCAN.test(cmd) ? 'unparseable' : null;
  for (const segment of flattenShellSegments(segments)) {
    const op = segmentGitOp(segment.words);
    if (op) return op;
  }
  return null;
}

/**
 * True when a segment runs `gh pr create` in command position — or when the
 * command could not be tokenized and its raw text mentions one.
 */
export function detectGhPrCreate(cmd: string): boolean {
  if (typeof cmd !== 'string' || cmd.length === 0) return false;
  const segments = tokenizeShellCommand(cmd);
  if (!segments) return UNPARSEABLE_GH_SCAN.test(cmd);
  return flattenShellSegments(segments).some((segment) =>
    isGhPrCreate(segment.words),
  );
}

/** True when the tokenized segment runs `gh pr create`. */
export function isGhPrCreate(words: string[]): boolean {
  const ghIndex = commandWordIndex(words, 'gh');
  if (ghIndex < 0) return false;
  const prIndex = words.indexOf('pr', ghIndex + 1);
  return prIndex > 0 && words[prIndex + 1] === 'create';
}

// Git operations that MATERIALIZE existing content into the working tree from
// git objects / other refs / stashes — i.e. content that was NOT authored by
// the agent typing this command. The Bash-edit capture must NOT attribute the
// files these touch to the agent: their working-tree mtime becomes "now" (so
// the mtime gate alone would wrongly capture them), but the content came from
// a colleague's branch, a human's stash, an upstream pull, etc.
//
// New-branch creation (`checkout -b` / `switch -c`) is intentionally NOT here —
// it only moves a ref and leaves the working tree unchanged, so it never
// materializes foreign content. Plain `checkout`/`switch`/`restore` (no
// new-branch flag) DO change working-tree files and are treated as
// materializing.
const MATERIALIZING_SUBCOMMANDS = new Set([
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'pull',
  'reset',
  'restore',
]);
const NEW_BRANCH_FLAGS = ['-b', '-B', '-c', '-C'];

/**
 * True if any segment of the command is a tree-materializing git op (merge,
 * rebase, cherry-pick, revert, pull, reset, restore, stash pop/apply, or a
 * non-new-branch checkout/switch), accounting for `git -C`/`sudo`/`env`
 * prefixes. The capture skips entirely for these so it never credits foreign
 * content (a colleague's branch, a stash, an upstream pull) to the agent.
 *
 * An unreadable command whose text mentions one of those subcommands answers
 * `true`: skipping a capture costs an attribution, crediting a colleague's
 * merged work to the agent is a wrong one.
 */
export function detectTreeMaterializingGitOp(cmd: string): boolean {
  if (typeof cmd !== 'string' || cmd.length === 0) return false;
  const segments = tokenizeShellCommand(cmd);
  if (!segments) return UNPARSEABLE_MATERIALIZE_SCAN.test(cmd);
  return flattenShellSegments(segments).some(({ words }) => {
    const git = parseGitCommand(words);
    if (!git?.subcommand) return false;
    if (MATERIALIZING_SUBCOMMANDS.has(git.subcommand)) return true;
    if (git.subcommand === 'stash')
      return git.args[0] === 'pop' || git.args[0] === 'apply';
    if (git.subcommand !== 'checkout' && git.subcommand !== 'switch')
      return false;
    return !git.args.some((arg) => NEW_BRANCH_FLAGS.includes(arg));
  });
}

/**
 * True if a `git commit --amend` appears in the command, or if the command is
 * unreadable and its text carries both. `true` makes the capture skip the
 * committed-set synthesis, which is the conservative direction.
 */
export function isAmendCommit(cmd: string): boolean {
  if (typeof cmd !== 'string' || cmd.length === 0) return false;
  const segments = tokenizeShellCommand(cmd);
  if (!segments) {
    return UNPARSEABLE_GIT_SCAN.test(cmd) && UNPARSEABLE_AMEND_SCAN.test(cmd);
  }
  return flattenShellSegments(segments).some(({ words }) => {
    const git = parseGitCommand(words);
    if (git?.subcommand !== 'commit') return false;
    return git.args.some(
      (arg) => arg === '--amend' || arg.startsWith('--amend='),
    );
  });
}
