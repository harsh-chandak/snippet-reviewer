import { Language } from '../../model/constants';
import { codeLines } from '../../utils/codeLines';
import { RuleFinding } from './types';

// Language-agnostic rules: plain text scans that run on every snippet, in every language, whether
// or not it parses and whether or not the language has an analyzer. analyzeSnippet merges them in.
//
// any/hardcoded-secret: an AWS access key id, a private key block, or a password / secret / token /
// API key assigned a string literal. The description names what was found and, for an assignment,
// the variable; it never contains the secret itself, because findings are stored and shown.

export const HARDCODED_SECRET_RULE = 'any/hardcoded-secret';
export const COMMON_RULE_IDS = [HARDCODED_SECRET_RULE] as const;

const SUGGESTED_FIX =
  'Read it from an environment variable or a secret manager instead, and rotate it: anything committed to code should be treated as leaked.';

// AKIA = long-term key, ASIA = temporary (STS) key; both are followed by 16 upper-case letters or digits.
const AWS_KEY_ID = /(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/;
const PRIVATE_KEY_BEGIN = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;
const PRIVATE_KEY_END = /-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/;

// name, an optional closing quote (a JSON / dict key), an assignment-like operator (=, :=, :, =>,
// never == or ===), an optional r/b/u string prefix, then a one-line string literal. The lookbehind
// keeps every match starting at the beginning of a name, so a long line is scanned in linear time.
const ASSIGNMENT =
  /(?<![\w$-])([A-Za-z_$][\w$-]*)['"]?\s*(?::=|=>|=(?!=)|:(?!:))\s*(?:[rRbBuU]{1,2})?(?:'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`)/g;

// SQL has no assignment to a variable called password; the literal follows a keyword:
// CREATE USER x WITH PASSWORD 'p', ALTER ROLE x PASSWORD 'p', IDENTIFIED BY 'p'.
const SQL_PASSWORD = /\b(PASSWORD|IDENTIFIED\s+BY)\s+'([^'\n]*)'/gi;

// Words that make a name a secret, after splitting it into words (dbPassword -> db, password).
const SECRET_WORDS = new Set(['password', 'passwd', 'pwd', 'passphrase', 'secret', 'token', 'apikey', 'credential', 'credentials']);
// Two-word secrets: api_key, apiKey, access_key, private_key, client_secret is caught by 'secret'.
const SECRET_PAIRS = [
  ['api', 'key'],
  ['access', 'key'],
  ['private', 'key'],
  ['auth', 'key'],
];
// A name ending in one of these holds something about the secret, not the secret:
// password_label = "Password", token_type = "Bearer", secret_name = "prod/db".
const NOT_SECRET_LAST_WORDS = new Set([
  'url', 'uri', 'endpoint', 'type', 'name', 'field', 'label', 'header', 'placeholder', 'prompt', 'message',
  'msg', 'text', 'title', 'hint', 'error', 'pattern', 'regex', 're', 'path', 'file', 'dir', 'env', 'var',
  'policy', 'length', 'len', 'min', 'max', 'count', 'id', 'ids', 'expiry', 'expires', 'ttl', 'format', 'kind',
  'mode', 'version', 'prefix', 'param', 'column', 'col', 'class', 'selector', 'route',
]);

function nameWords(name: string): string[] {
  return name
    .replace(/^\$+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-$]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function isSecretName(name: string): boolean {
  const words = nameWords(name);
  if (words.length === 0) return false;
  if (NOT_SECRET_LAST_WORDS.has(words[words.length - 1])) return false;
  if (words.some((w) => SECRET_WORDS.has(w))) return true;
  return SECRET_PAIRS.some(([a, b]) => words.some((w, i) => w === a && words[i + 1] === b));
}

// Values that are visibly not a real secret: empty, a template or interpolation, a <placeholder>,
// a run of one character (****, xxxx), or a "your-api-key-here" example.
function isPlaceholderValue(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  if (/\$\{|\{\{|%\(|^%s$/.test(v)) return true;
  if (/^<[^>]*>$/.test(v)) return true;
  if (/^(.)\1*$/.test(v)) return true;
  if (/^(your|my|insert|enter)[\s_-]/i.test(v)) return true;
  return false;
}

function secretFinding(lineStart: number, lineEnd: number, description: string): RuleFinding {
  return {
    ruleId: HARDCODED_SECRET_RULE,
    lineStart,
    lineEnd,
    severity: 'critical',
    category: 'security',
    description,
    suggestedFix: SUGGESTED_FIX,
    fix: null,
  };
}

// Variable names are shown, but cut short and stripped of anything odd, so a description stays readable.
function displayName(name: string): string {
  const clean = name.replace(/[^\w$-]/g, '');
  return clean.length > 60 ? `${clean.slice(0, 60)}...` : clean;
}

function assignmentOnLine(line: string, language: Language): string | null {
  if (language === 'sql') {
    for (const m of line.matchAll(SQL_PASSWORD)) {
      if (!isPlaceholderValue(m[2])) return 'A password is hard-coded as a string literal in this statement.';
    }
    return null;
  }
  for (const m of line.matchAll(ASSIGNMENT)) {
    const value = m[2] ?? m[3] ?? m[4] ?? '';
    if (isSecretName(m[1]) && !isPlaceholderValue(value)) {
      return `\`${displayName(m[1])}\` is assigned a hard-coded string literal; it looks like a credential.`;
    }
  }
  return null;
}

// At most one finding per line; a private key block is one finding over its BEGIN..END lines.
export function hardcodedSecretFindings(code: string, language: Language): RuleFinding[] {
  const lines = codeLines(code);
  const findings: RuleFinding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;

    if (PRIVATE_KEY_BEGIN.test(line)) {
      let end = i;
      while (end < lines.length && !PRIVATE_KEY_END.test(lines[end])) end++;
      if (end === lines.length) end = i; // no END line: report the BEGIN line alone
      findings.push(secretFinding(lineNo, end + 1, 'A private key block is embedded in the code.'));
      i = end; // the key's own lines are not scanned again
      continue;
    }

    if (AWS_KEY_ID.test(line)) {
      findings.push(secretFinding(lineNo, lineNo, 'An AWS access key id is hard-coded here.'));
      continue;
    }

    const assignment = assignmentOnLine(line, language);
    if (assignment) findings.push(secretFinding(lineNo, lineNo, assignment));
  }
  return findings;
}

// Every language-agnostic rule, for one snippet.
export function commonFindings(code: string, language: Language): RuleFinding[] {
  return hardcodedSecretFindings(code, language);
}
