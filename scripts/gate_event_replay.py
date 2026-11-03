#!/usr/bin/env python3
"""Best-effort hook replay. Read-only observations; generated CC policy, never token logs."""
from __future__ import annotations

import collections
import datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sys

import kitlib_jsonl
from kitlib_run import run

LIMIT = 32768
FIELDS = ('tool', 'arguments', 'cwd', 'staged_paths', 'diff_sha256', 'message', 'custody')


class ScrubPolicy:
    """The existing TS scrub policy as shared data; absent/invalid policy is fatal."""

    def __init__(self, path: Path | None = None) -> None:
        here = Path(__file__).resolve().parent
        if path is None:
            path = here / 'secret-output-policy.v1.json'
            if not path.is_file():
                path = here.parent / 'src' / 'secret-output-policy.v1.json'
        policy = json.loads(path.read_text())
        if policy.get('schema_version') != 'omp-kit.secret-output-policy.v1' or not isinstance(policy.get('binding_keys'), list) or len(policy['binding_keys']) != 7 or not all(isinstance(key, str) and key for key in policy['binding_keys']):
            raise ValueError('SECRET_OUTPUT_POLICY_INVALID')
        self.binding_keys = frozenset(policy['binding_keys'])
        secret_flags = policy.get('secret_flags')
        if (not isinstance(secret_flags, list) or not secret_flags
                or not all(isinstance(flag, str) and len(flag) >= 2 and flag.startswith('-') and flag != '--' and '=' not in flag and all('!' <= char <= '~' for char in flag) for flag in secret_flags)
                or len(set(secret_flags)) != len(secret_flags)):
            raise ValueError('SECRET_OUTPUT_POLICY_INVALID')
        self.secret_flags = frozenset(secret_flags)
        self.short_secret_flags = tuple(flag for flag in secret_flags if len(flag) == 2 and flag[1] != '-')
        self.patterns = {}
        for name in ('GH_CLASSIC', 'GH_FINE_GRAINED', 'HOSTS_OAUTH_TOKEN', 'SECURITY_PASSWORD'):
            spec = policy['patterns'][name]
            if not isinstance(spec.get('pattern'), str) or spec.get('flags') not in ('g', 'gm'):
                raise ValueError('SECRET_OUTPUT_POLICY_INVALID')
            self.patterns[name] = self.compile_scrub_pattern(spec['pattern'], spec['flags'])
        replay_spec = policy['replay_patterns']['GENERIC_ASSIGNMENT']
        if not isinstance(replay_spec.get('pattern'), str) or replay_spec.get('flags') != 'gi':
            raise ValueError('SECRET_OUTPUT_POLICY_INVALID')
        self.replay_assignment = re.compile(replay_spec['pattern'], re.ASCII | re.IGNORECASE)

    @staticmethod
    def compile_scrub_pattern(source: str, flags: str) -> re.Pattern:
        """Translate tokens in the original policy only, never inserted regex text."""
        whitespace = r'\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
        parts = []
        in_class = False
        class_content = -1
        at = 0
        while at < len(source):
            char = source[at]
            if char == '\\':
                if at + 1 >= len(source):
                    raise ValueError('SECRET_OUTPUT_POLICY_UNSUPPORTED_ESCAPE')
                escaped = source[at + 1]
                if escaped == 's':
                    parts.append(whitespace if in_class else '[' + whitespace + ']')
                elif escaped == 'S':
                    if in_class:
                        raise ValueError('SECRET_OUTPUT_POLICY_UNSUPPORTED_CLASS_COMPLEMENT')
                    parts.append('[^' + whitespace + ']')
                else:
                    parts.append(source[at:at + 2])
                at += 2
                continue
            if char == '[' and not in_class:
                in_class = True
                class_content = at + 1 + (1 if source[at + 1:at + 2] == '^' else 0)
            elif char == ']' and in_class and at > class_content:
                in_class = False
            if not in_class and 'm' in flags and char in ('^', '$'):
                parts.append(r'(?<![^\n\r\u2028\u2029])' if char == '^' else r'(?=[\n\r\u2028\u2029]|\Z)')
            else:
                parts.append(char)
            at += 1
        if in_class:
            raise ValueError('SECRET_OUTPUT_POLICY_UNSUPPORTED_CLASS')
        return re.compile(''.join(parts), re.ASCII)

    @staticmethod
    def fingerprint(value: str) -> str:
        return 'fp:' + hashlib.sha256(value.encode('utf-8')).hexdigest()[:16]

    def scrub(self, text: str) -> str:
        text = self.patterns['HOSTS_OAUTH_TOKEN'].sub(lambda match: match[1] + self.fingerprint(match[2]), text)
        for name in ('GH_CLASSIC', 'GH_FINE_GRAINED'):
            text = self.patterns[name].sub(lambda match: self.fingerprint(match[0]), text)
        return self.patterns['SECURITY_PASSWORD'].sub(lambda match: match[1] + '"[REDACTED]"', text)

    def assignments(self, text: str) -> str:
        # Normalize JS-only whitespace for Python's ASCII engine, preserving original
        # spans/prefix bytes in the replacement. ASCII case/boundaries match JS /gi.
        def js_space(char: str) -> bool:
            point = ord(char)
            return point in (0xA0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF) or 0x2000 <= point <= 0x200A
        normalized = ''.join(' ' if js_space(char) else char for char in text)
        parts = []
        at = 0
        for match in self.replay_assignment.finditer(normalized):
            parts.extend((text[at:match.start()], text[match.start(1):match.end(1)], '<redacted>'))
            at = match.end()
        if not parts:
            return text
        parts.append(text[at:])
        return ''.join(parts)

    def scrub_replay(self, text: str, key: str = '') -> str:
        assigned = self.assignments(text)
        if key and assigned == text and self.assignments(key + '=' + text) != key + '=' + text:
            return '[REDACTED]'
        return self.scrub(assigned)




def compile_regex(spec: dict) -> re.Pattern:
    if spec.get('flags') != 'u':
        raise ValueError('CC_CREDENTIAL_REGEX_DIALECT')
    pattern = re.sub(r'\\u\{([0-9a-fA-F]+)\}', lambda match: '\\U%08x' % int(match[1], 16), spec['pattern'])
    # ECMAScript word boundaries are ASCII; normalized Unicode character classes stay intact.
    pattern = pattern.replace(r'\b', r'(?:(?<![A-Za-z0-9_])(?=[A-Za-z0-9_])|(?<=[A-Za-z0-9_])(?![A-Za-z0-9_]))')
    return re.compile(pattern)


class CredentialScreen:
    def __init__(self) -> None:
        here = Path(__file__).resolve().parent
        source = here / 'cc-credential-shapes.v1.json'
        if not source.is_file():
            source = here.parent / 'src' / 'cc-credential-shapes.v1.json'
        catalog = json.loads(source.read_text())
        if catalog.get('schema_version') != 'omp-kit.cc.credential-shapes.v1' or catalog.get('regex_dialect') != 'ecmascript-u' or not catalog.get('rules'):
            raise ValueError('CC_CREDENTIAL_CATALOG')
        self.ranges = catalog['python_digit_ranges']
        self.global_allows = [self.allow_spec(value) for value in catalog.get('global_allowlists', [])]
        self.rules = [(rule, compile_regex(rule['regex']), [self.allow_spec(value) for value in rule.get('allowlists', [])]) for rule in catalog['rules']]

        self.scrub_policy = ScrubPolicy()
    @staticmethod
    def allow_spec(spec: dict) -> tuple:
        regexes = [compile_regex(value) for value in spec.get('regexes', [])]
        words = [word.lower() for word in spec.get('stopwords', [])]
        and_condition = spec.get('condition') == 'AND'
        applicable = bool(regexes or words) and not (and_condition and spec.get('needs_path') is True)
        return and_condition, spec.get('target', 'secret'), regexes, words, applicable

    @staticmethod
    def allowed(spec: tuple, secret: str, match: str, line: str) -> bool:
        and_condition, target, regexes, words, applicable = spec
        if not applicable:
            return False
        candidate = line if target == 'line' else match if target == 'match' else secret
        regex_match = any(regex.search(candidate) is not None for regex in regexes)
        word_match = any(word in secret.lower() for word in words)
        return ((not regexes or regex_match) and (not words or word_match)) if and_condition else regex_match or word_match

    def __call__(self, text: str) -> bool:
        lower = text.lower()
        for rule, regex, allows in self.rules:
            if rule.get('keywords') and not any(word.lower() in lower for word in rule['keywords']):
                continue
            for match in regex.finditer(text):
                group = rule.get('secret_group', 0)
                secret = match.group(group) if group > 0 and group <= len(match.groups()) and match.group(group) else next((value for value in match.groups() if value), match.group())
                threshold = rule.get('entropy')
                if threshold is not None:
                    counts = collections.Counter(secret)
                    entropy = -sum((count / len(secret)) * math.log2(count / len(secret)) for count in counts.values()) if secret else 0
                    has_digit = any(any(start <= ord(char) <= end for start, end in self.ranges) for char in secret)
                    if entropy <= threshold or (rule['id'].startswith('generic') and not has_digit):
                        continue
                if not any(self.allowed(allow, secret, match.group(), text) for allow in [*allows, *self.global_allows]):
                    return True
        return False


def capture(input_value: dict, screen: CredentialScreen, *, lost: bool = False) -> dict:
    redacted = False
    truncated = lost
    nodes = 0

    def clean(value: object, depth: int = 0, key: str = '') -> object:
        nonlocal redacted, truncated, nodes
        nodes += 1
        if nodes > 1024 or depth > 8:
            truncated = True
            return None
        if isinstance(value, str):
            # The entire original string is screened BEFORE any prefix is retained.
            if len(value) > 8192:
                truncated = True
            if key.lower() in screen.scrub_policy.binding_keys or screen(value) or (key and screen(key + '=' + value)):
                redacted = True
                return '[REDACTED]'
            scrubbed = screen.scrub_policy.scrub_replay(value, key)
            if scrubbed != value:
                redacted = True
            return scrubbed[:8192]
        if value is None or isinstance(value, (bool, int)) or (isinstance(value, float) and math.isfinite(value)):
            return value
        if isinstance(value, list):
            if len(value) > 128:
                truncated = True
            result = []
            hide_next = False
            for item in value[:128]:
                if hide_next:
                    hide_next = False
                    redacted = True
                    if isinstance(item, str) and len(item) > 8192:
                        truncated = True
                    result.append('[REDACTED]')
                    continue
                if isinstance(item, str):
                    if item in screen.scrub_policy.secret_flags:
                        hide_next = True
                    else:
                        equals = item.find('=')
                        flag = item[:equals] if equals > 0 and item[:equals] in screen.scrub_policy.secret_flags else next(
                            (flag for flag in screen.scrub_policy.short_secret_flags if len(item) > len(flag) and item.startswith(flag)), None)
                        if flag:
                            redacted = True
                            if len(item) > 8192:
                                truncated = True
                            result.append(flag + ('=' if equals == len(flag) else '') + '[REDACTED]')
                            continue
                result.append(clean(item, depth + 1))
            return result
        if isinstance(value, dict):
            result = {}
            if len(value) > 128:
                truncated = True
            for name, item in list(value.items())[:128]:
                safe_name = str(clean(str(name)))[:256]
                if len(safe_name) != len(str(name)):
                    truncated = True
                result[safe_name] = clean(item, depth + 1, str(name))
            return result
        truncated = True
        return None

    replay = {'version': 1, **{key: clean(input_value.get(key)) for key in FIELDS}}
    if isinstance(replay['staged_paths'], list):
        replay['staged_paths'] = [path for path in replay['staged_paths'] if isinstance(path, str)]
    replay.update(redacted=redacted, truncated=truncated, missing=[key for key in FIELDS if replay[key] is None])
    while len(json.dumps(replay, ensure_ascii=False, separators=(',', ':')).encode()) > LIMIT:
        key = max(FIELDS, key=lambda name: len(json.dumps(replay[name])))
        replay[key] = None
        replay['truncated'] = True
        if key not in replay['missing']:
            replay['missing'].append(key)
    return replay


def observe_git(cwd: str, args: list[str]) -> tuple[bytes | None, bool]:
    try:
        result = run(['git', *args], cwd=cwd, deadline_s=2, max_output_bytes=8 * 1024 * 1024)
        return (result.stdout if result.rc == 0 and not result.timed_out and not result.truncated else None, result.truncated)
    except (OSError, ValueError):
        return None, False


def observe_custody(cwd: str, paths: list[str] | None) -> dict:
    """Resolve the same canonical fleet reader as src/custody.ts; never reserve."""
    roots = [os.environ['OMP_KIT_FLEET_ROOT']] if os.environ.get('OMP_KIT_FLEET_ROOT') else []
    config = os.environ.get('OMP_KIT_FLEET_WATCH_CONFIG') or str(Path.home() / '.config' / 'omp-kit' / 'fleet-watch.json')
    try:
        sessions = json.loads(Path(config).read_text()).get('sessions', [])
        roots.extend(row['repo'] for row in sessions if isinstance(row, dict) and isinstance(row.get('repo'), str))
    except (OSError, ValueError, TypeError, AttributeError):
        pass
    script = None
    for root in roots:
        candidate = Path(root) / 'scripts' / 'cc' / 'custody.py'
        try:
            stat = candidate.lstat()
            if candidate.is_file() and not candidate.is_symlink() and stat.st_uid == os.getuid():
                script = candidate
                break
        except OSError:
            continue
    if script is None or not paths:
        return {'status': 'UNAVAILABLE', 'reason': 'Canonical custody reader unavailable.' if script is None else 'No staged paths were observed.'}
    observations = []
    seat = os.environ.get('BR_ACTOR') or os.environ.get('BR_AGENT_NAME') or os.environ.get('AGENT_NAME')
    for path in paths[:16]:
        try:
            result = run(['python3', str(script), '--repo', cwd, *(['--agent', seat] if seat else []), path], cwd=cwd, deadline_s=2, max_output_bytes=65536)
            if result.timed_out or result.truncated:
                observations.append({'path': path, 'status': 'UNAVAILABLE', 'reason': 'Canonical custody read exceeded its observation bound.'})
            else:
                observations.append({'path': path, 'rc': result.rc, 'result': json.loads(result.stdout)})
        except (OSError, ValueError):
            observations.append({'path': path, 'status': 'UNAVAILABLE', 'reason': 'Canonical custody reader could not complete.'})
    return {'observations': observations, **({'omitted_paths': len(paths) - 16} if len(paths) > 16 else {})}


def capture_hook(argv: list[str], screen: CredentialScreen) -> dict:
    env = os.environ
    cwd = os.getcwd()
    paths, path_lost = observe_git(cwd, ['diff', '--cached', '--name-only', '-z'])
    diff, diff_lost = observe_git(cwd, ['diff', '--cached', '--binary', '--no-ext-diff'])
    hook = env.get('OMP_KIT_GATE_EVENT_HOOK')
    args: object = argv
    if env.get('OMP_KIT_GATE_EVENT_ARGUMENTS'):
        try:
            args = json.loads(env['OMP_KIT_GATE_EVENT_ARGUMENTS'])
        except ValueError:
            args = None
    message_file = env.get('OMP_KIT_GATE_EVENT_MESSAGE_FILE')
    if not message_file and hook in ('commit-msg', 'prepare-commit-msg') and argv:
        message_file = argv[0]
    message = None
    message_lost = False
    if message_file:
        try:
            with open(message_file, 'rb') as handle:
                raw = handle.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                # Do not retain an unscreened prefix of an oversized secret-bearing file.
                message_lost = True
            else:
                try:
                    message = raw.decode('utf-8')
                except UnicodeDecodeError:
                    message = raw.decode('utf-8', errors='replace')
                    message_lost = True
        except OSError:
            pass
    arguments = {'hook': hook, 'argv': args, 'message_file': message_file}
    if 'OMP_KIT_GATE_EVENT_COMMAND' in env:
        arguments['command'] = env['OMP_KIT_GATE_EVENT_COMMAND']
    if not argv and hook is None and 'OMP_KIT_GATE_EVENT_ARGUMENTS' not in env and 'OMP_KIT_GATE_EVENT_COMMAND' not in env and message_file is None:
        arguments = None
    staged = None
    if paths is not None:
        try:
            decoded_paths = paths.decode('utf-8')
        except UnicodeDecodeError:
            decoded_paths = paths.decode('utf-8', errors='replace')
            path_lost = True
        staged = [path for path in decoded_paths.split('\0') if path]
    custody = observe_custody(cwd, staged)
    return capture({'tool': 'git-hook' if hook is not None else None, 'arguments': arguments, 'cwd': cwd,
                    'staged_paths': staged,
                    'diff_sha256': hashlib.sha256(diff).hexdigest() if diff is not None else None,
                    'message': message, 'custody': custody}, screen, lost=path_lost or diff_lost or message_lost)


def main(argv: list[str]) -> None:
    screen = CredentialScreen()
    env = os.environ
    row = {'ts': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
           'seat': env.get('GATE_EVENT_SEAT') or None, 'act': env['GATE_EVENT_ACT'],
           'target': env.get('GATE_EVENT_TARGET') or None, 'gate': env['GATE_EVENT_GATE'], 'kind': env['GATE_EVENT_KIND']}
    attempt = env.get('GATE_EVENT_ATTEMPT')
    if attempt:
        row.update(attempt=attempt, event_id=attempt)
    raw_rc = env.get('OMP_KIT_GATE_EVENT_RC')
    if raw_rc is None:
        raw_rc = next((word[3:] for word in env.get('GATE_EVENT_DETAIL', '').split() if word.startswith('rc=')), None)
    if raw_rc is not None:
        try:
            row['rc'] = int(raw_rc)
        except ValueError:
            pass
    if row.get('rc') == 0 and row['kind'] == 'refuse':
        row['kind'] = 'pass'
    if env.get('GATE_EVENT_DETAIL'):
        row['detail'] = env['GATE_EVENT_DETAIL']
    for key in ('seat', 'act', 'target', 'gate', 'kind', 'attempt', 'event_id', 'detail'):
        if isinstance(row.get(key), str):
            metadata = capture({'message': row[key]}, screen)
            row[key] = metadata['message'] if metadata['message'] is not None else '[OMITTED]'
            if key == 'detail':
                row[key] = row[key][:400]
            if metadata['redacted']:
                row['metadata_redacted'] = True
            if metadata['truncated']:
                row['metadata_truncated'] = True
    if row['kind'] == 'refuse':
        row['replay'] = capture_hook(argv, screen)
    ledger = env['GATE_EVENT_LEDGER']
    kitlib_jsonl.append_jsonl(ledger, lambda _state: row, deadline_s=2, torn_tail='newline', state_dir=os.path.dirname(ledger))


if __name__ == '__main__':
    # This outer best-effort boundary deliberately emits neither secrets nor failures.
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, TypeError, KeyError, re.error):
        pass
