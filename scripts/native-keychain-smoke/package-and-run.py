#!/usr/bin/env python3
"""Root-reviewed disposable ad-hoc package only. Builds nothing; never installs."""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import plistlib
import selectors
import signal
import stat
import subprocess
import tempfile
import time

PROFILE = 'adhoc-minus-no-entitlements'
IDENTIFIER = 'com.cerebro.native-read-smoke'
READ_RUNNER = '.superpowers/sdd/2026-10-23-m93-m99-master-roadmap/m96-native-admission/native-read-smoke-offsource/run-smoke.py'
READ_RUNNER_SHA256 = '7f51daf00f0f0086e5aa5f77edd5351d78e48ca64cc8bd71ef35cb989246576d'
CASES = {
    'keychain-injected-bundle': 'actual-window-private-app',
    'keychain-three-fresh-refs': 'missing-sign-in-required',
    'keychain-create-A': 'created',
    'keychain-read-A': 'exact-rust-comparison',
    'keychain-duplicate-A': 'refused-original-retained',
    'keychain-create-B': 'fresh-reference-replacement',
    'keychain-independent-A-B': 'both-exact',
    'keychain-delete-A': 'A-missing-B-retained',
    'keychain-create-C': 'uncommitted-candidate',
    'keychain-cancelled-C': 'C-missing-B-retained',
    'keychain-delete-B': 'missing-sign-in-required',
    'keychain-repeat-delete-B': 'idempotent',
    'keychain-final-cleanup': 'all-three-missing',
}
SUCCESS_STAGES = ['fresh-references-before-io', 'three-references-missing',
    'put-A-intent', 'put-confirmed', 'duplicate-A-put-intent', 'duplicate-A-original-confirmed',
    'put-B-intent', 'put-confirmed', 'delete-A-intent', 'delete-confirmed-missing',
    'put-C-intent', 'put-confirmed', 'candidate-C-cancelled', 'delete-C-intent',
    'delete-confirmed-missing', 'delete-B-intent', 'delete-confirmed-missing',
    'repeat-delete-B-intent', 'all-confirmed-missing']


def private_directory(path, expected=None):
    metadata = path.lstat()
    identity = (metadata.st_dev, metadata.st_ino)
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.geteuid() or metadata.st_mode & 0o077 or path.resolve(strict=True) != path or (expected is not None and identity != expected):
        raise RuntimeError('owned-directory-identity-changed')
    return identity


def reviewed_helper(repo, path):
    cursor = repo
    for segment in path.relative_to(repo).parts[:-1]:
        cursor = cursor / segment
        metadata = cursor.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            raise RuntimeError('helper-parent-is-not-regular-directory')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > 65536:
            raise RuntimeError('helper-file-bound')
        value = bytearray()
        while len(value) <= 65536:
            block = os.read(fd, min(8192, 65537 - len(value)))
            if not block:
                break
            value.extend(block)
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or len(value) != after.st_size or len(value) > 65536 or hashlib.sha256(value).hexdigest() != READ_RUNNER_SHA256:
            raise RuntimeError('reviewed-read-supervisor-dependency-changed')
        return bytes(value)
    finally:
        os.close(fd)


def create(path, data, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as file:
            file.write(data)
            file.flush()
            os.fsync(fd)
    finally:
        os.close(fd)


def capture(command, cwd, env, seconds, cap, stderr_cap=None):
    # Require non-reaping exit observation before starting any owned child.
    waitid = os.waitid
    wait_kind = os.P_PID
    wait_flags = os.WEXITED | os.WNOHANG | os.WNOWAIT
    process = subprocess.Popen(command, cwd=cwd, env=env, start_new_session=True,
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def exited_without_reaping():
        # Retain the waitable leader so its PID/PGID cannot be recycled while
        # this capture may still signal descendants in the original group.
        return waitid(wait_kind, process.pid, wait_flags) is not None
    poll = selectors.DefaultSelector()
    streams = {process.stdout: bytearray(), process.stderr: bytearray()}
    limits = {process.stdout: cap, process.stderr: cap if stderr_cap is None else stderr_cap}
    for stream in streams:
        os.set_blocking(stream.fileno(), False)
        poll.register(stream, selectors.EVENT_READ)
    failure = None
    deadline = time.monotonic() + seconds
    try:
        while poll.get_map() or not exited_without_reaping():
            if time.monotonic() >= deadline:
                failure = 'deadline'
                break
            for key, _ in poll.select(0.1):
                target = streams[key.fileobj]
                limit = limits[key.fileobj]
                block = os.read(key.fileobj.fileno(), min(8192, limit + 1 - len(target)))
                if not block:
                    poll.unregister(key.fileobj)
                    continue
                if len(target) + len(block) > limit:
                    failure = 'output-cap'
                    break
                target.extend(block)
            if failure:
                break
    finally:
        cleanup = {'signalErrors': [], 'observationErrno': None, 'reaped': False,
            'reapFailure': None, 'groupAbsent': None, 'lastGroupProbe': 'not-observed'}
        try:
            try:
                # Keep the original leader waitable through every nonzero
                # signal. EPERM can describe a dead-but-unreaped group here;
                # record it without interpreting it as absence or skipping KILL.
                exited_without_reaping()
                grace_deadline = time.monotonic() + 5
                for sig in [signal.SIGTERM, signal.SIGKILL]:
                    try:
                        os.killpg(process.pid, sig)
                    except ProcessLookupError:
                        pass
                    except OSError as error:
                        cleanup['signalErrors'].append({'signal': int(sig), 'errno': error.errno})
                    if sig == signal.SIGTERM:
                        while not exited_without_reaping():
                            remaining = grace_deadline - time.monotonic()
                            if remaining <= 0:
                                break
                            time.sleep(min(0.01, remaining))
            except OSError as error:
                # An unavailable waitable identity never licenses a later signal.
                cleanup['observationErrno'] = error.errno
            finally:
                # Even a signal/observation failure must attempt bounded reap.
                # Reap and read-only absence share the same five-second budget.
                final_deadline = time.monotonic() + 5
                try:
                    process.wait(timeout=max(0, final_deadline - time.monotonic()))
                    cleanup['reaped'] = True
                except subprocess.TimeoutExpired:
                    cleanup['reapFailure'] = 'timeout'
                except OSError:
                    cleanup['reapFailure'] = 'os-error'
                if cleanup['reaped']:
                    # Ownership is now released. Never send another nonzero
                    # signal; only ESRCH can establish group absence.
                    while time.monotonic() < final_deadline:
                        try:
                            os.killpg(process.pid, 0)
                            cleanup['lastGroupProbe'] = 'present'
                        except ProcessLookupError:
                            cleanup['lastGroupProbe'] = 'ESRCH'
                            cleanup['groupAbsent'] = True
                            break
                        except PermissionError:
                            cleanup['lastGroupProbe'] = 'EPERM'
                        except OSError:
                            cleanup['lastGroupProbe'] = 'os-error'
                            break
                        remaining = final_deadline - time.monotonic()
                        if remaining <= 0:
                            break
                        time.sleep(min(0.01, remaining))
                if cleanup['observationErrno'] is not None or not cleanup['reaped'] or cleanup['groupAbsent'] is not True:
                    failure = failure or 'cleanup-unavailable'
        finally:
            stdout, stderr = (bytes(streams[stream]) for stream in (process.stdout, process.stderr))
            for stream in streams:
                stream.close()
            poll.close()
    return {'exitCode': process.returncode, 'failure': failure, 'cleanup': cleanup}, stdout, stderr


def child_environment():
    # Nothing may introduce Node preload/module hooks or loader injection. The
    # exact Node executable is a separate explicit selector, never PATH lookup.
    allowed = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', '__CF_USER_TEXT_ENCODING']
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    env['PATH'] = '/usr/bin:/bin'
    return env


def selected_node(path):
    if not path.is_absolute():
        raise RuntimeError('node-must-be-explicit-absolute-path')
    resolved = path.resolve(strict=True)
    metadata = resolved.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o022 or not os.access(resolved, os.X_OK):
        raise RuntimeError('node-must-be-regular-non-writable-executable')
    return resolved


def inventory_inputs(repo, node):
    source = "import { nativeInputIdentity } from './scripts/outcomes/native-inputs.ts'; process.stdout.write(JSON.stringify(nativeInputIdentity(process.cwd())));"
    result, stdout, _ = capture([str(node), '--import', 'tsx', '--input-type=module', '-e', source],
        repo, child_environment(), 30, 4096, stderr_cap=65536)
    if result['failure'] or result['exitCode'] != 0:
        raise RuntimeError('bounded-inventory-child-failed')
    value = json.loads(stdout)
    if not isinstance(value, dict) or set(value) != {'version', 'aggregateDigest', 'fileCount', 'totalBytes'} or value['version'] != 1:
        raise RuntimeError('inventory-result-shape')
    digest = value['aggregateDigest']
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
        raise RuntimeError('inventory-result-digest')
    if type(value['fileCount']) is not int or not 1 <= value['fileCount'] <= 2048 or type(value['totalBytes']) is not int or not 0 <= value['totalBytes'] <= 64 * 1024 * 1024:
        raise RuntimeError('inventory-result-limits')
    return value


def tool(command, root, env):
    result, stdout, stderr = capture(command, root, env, 30, 65536)
    if result['failure'] or result['exitCode'] != 0:
        raise RuntimeError('bounded-package-tool-failed')
    return stdout, stderr


def signature(bundle, root, env):
    tool(['/usr/bin/codesign', '--verify', '--strict', '--verbose=2', str(bundle)], root, env)
    stdout, stderr = tool(['/usr/bin/codesign', '--display', '--verbose=4', str(bundle)], root, env)
    details = (stdout + stderr).decode('utf8', errors='strict').splitlines()
    fields = {}
    authorities = []
    for line in details:
        if '=' not in line:
            continue
        key, value = line.split('=', 1)
        if key == 'Authority':
            authorities.append(value)
        elif key in ['Identifier', 'TeamIdentifier', 'CDHash', 'Signature']:
            if key in fields:
                raise RuntimeError('duplicate-signature-field')
            fields[key] = value
    if fields.get('Identifier') != IDENTIFIER or fields.get('Signature') != 'adhoc' or fields.get('TeamIdentifier') not in [None, 'not set'] or authorities:
        raise RuntimeError('not-the-reviewed-ad-hoc-profile')
    cdhash = fields.get('CDHash', '')
    if len(cdhash) != 40 or any(c not in '0123456789abcdef' for c in cdhash):
        raise RuntimeError('missing-cdhash')
    entitlement_bytes, _ = tool(['/usr/bin/codesign', '--display', '--entitlements', '-', str(bundle)], root, env)
    if entitlement_bytes.strip() and plistlib.loads(entitlement_bytes) != {}:
        raise RuntimeError('unexpected-entitlements')
    requirement_out, requirement_err = tool(['/usr/bin/codesign', '--display', '-r-', str(bundle)], root, env)
    requirement = (requirement_out + requirement_err).decode('utf8', errors='strict')
    if 'designated =>' not in requirement:
        raise RuntimeError('missing-designated-requirement')
    return {'profile': PROFILE, 'identityArgument': '-', 'fields': fields, 'authorities': authorities,
        'entitlements': {}, 'entitlementsOutputSha256': hashlib.sha256(entitlement_bytes).hexdigest(),
        'designatedRequirement': requirement}


def bundle_inventory(bundle, digest):
    result = []
    entries = 0
    def walk(directory):
        nonlocal entries
        with os.scandir(directory) as listing:
            for entry in listing:
                entries += 1
                if entries > 128:
                    raise RuntimeError('bundle-entry-cap')
                path = pathlib.Path(entry.path)
                metadata = path.lstat()
                if metadata.st_uid != os.geteuid() or metadata.st_mode & 0o022 or stat.S_ISLNK(metadata.st_mode):
                    raise RuntimeError('unsafe-owned-bundle-entry')
                if stat.S_ISDIR(metadata.st_mode):
                    walk(path)
                elif stat.S_ISREG(metadata.st_mode):
                    limit = 2 * 1024**3 if path.name == 'native-read-smoke' else 4 * 1024**2
                    if metadata.st_size > limit:
                        raise RuntimeError('bundle-file-cap')
                    result.append({'path': str(path.relative_to(bundle)), 'bytes': metadata.st_size, 'sha256': digest(path)})
                else:
                    raise RuntimeError('nonregular-bundle-entry')
    walk(bundle)
    return sorted(result, key=lambda item: item['path'])


def copy_binary(source, target):
    source_fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    target_fd = None
    try:
        before = os.fstat(source_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > 2 * 1024**3:
            raise RuntimeError('binary-not-bounded-regular')
        target_fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700)
        count = 0
        with os.fdopen(target_fd, 'wb', closefd=False) as output:
            while True:
                block = os.read(source_fd, 1024**2)
                if not block:
                    break
                count += len(block)
                if count > 2 * 1024**3:
                    raise RuntimeError('binary-grew')
                output.write(block)
            output.flush()
            os.fsync(target_fd)
        after = os.fstat(source_fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or count != before.st_size:
            raise RuntimeError('binary-changed-during-copy')
    finally:
        os.close(source_fd)
        if target_fd is not None:
            os.close(target_fd)


def receipts(root, private_json, digest):
    names = []
    with os.scandir(root) as listing:
        for index, entry in enumerate(listing):
            if index >= 64:
                raise RuntimeError('run-directory-entry-cap')
            if entry.name.startswith('keychain-receipt-'):
                names.append(entry.name)
    if len(names) > 32 or sorted(names) != [f'keychain-receipt-{i:02}.json' for i in range(len(names))]:
        raise RuntimeError('receipt-sequence')
    root_stat = root.lstat()
    identity = {'dev': root_stat.st_dev, 'ino': root_stat.st_ino}
    values, hashes, nonce, refs = [], {}, None, None
    hex32 = lambda text: isinstance(text, str) and len(text) == 32 and all(c in '0123456789abcdef' for c in text)
    for index, name in enumerate(sorted(names)):
        value = private_json(root / name, 8192)
        if set(value) != {'format', 'profile', 'sequence', 'runNonce', 'stage', 'items', 'signingProfile', 'rootIdentity'} or value['format'] != 1 or value['profile'] != 'keychain-adhoc' or value['sequence'] != index or value['signingProfile'] != PROFILE or value['rootIdentity'] != identity or not hex32(value['runNonce']):
            raise RuntimeError('receipt-envelope')
        if nonce is not None and value['runNonce'] != nonce:
            raise RuntimeError('receipt-run-changed')
        nonce = value['runNonce']
        items = value['items']
        if not isinstance(items, list) or len(items) != 3:
            raise RuntimeError('receipt-item-count')
        references = []
        for item_index, item in enumerate(items):
            if set(item) != {'label', 'reference', 'state'} or item['label'] != ['A', 'B', 'C'][item_index] or item['state'] not in ['unchecked', 'absent', 'preexisting', 'put_in_flight', 'owned', 'delete_in_flight', 'missing']:
                raise RuntimeError('receipt-item-shape')
            reference = item['reference']
            if set(reference) != {'id', 'accountId', 'issuer', 'subject', 'secretRevision'} or not hex32(reference['id']) or not hex32(reference['accountId']) or reference['issuer'] != 'cerebro-native-acceptance' or reference['subject'] != 'disposable-noncredential' or reference['secretRevision'] != item_index + 1:
                raise RuntimeError('receipt-reference-shape')
            references.append(reference)
        if len({ref['id'] for ref in references}) != 3 or len({ref['accountId'] for ref in references}) != 1 or (refs is not None and references != refs):
            raise RuntimeError('receipt-reference-changed')
        refs = references
        values.append(value)
        hashes[name] = digest(root / name)
    return values, hashes


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', type=pathlib.Path, required=True)
    parser.add_argument('--binary', type=pathlib.Path, required=True)
    parser.add_argument('--node', type=pathlib.Path, required=True)
    parser.add_argument('--signing-profile', choices=[PROFILE], required=True)
    parser.add_argument('--output-parent', type=pathlib.Path, default=pathlib.Path('/private/tmp'))
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        raise RuntimeError('macOS-only')
    repo, binary, parent = (path.resolve(strict=True) for path in (args.repo, args.binary, args.output_parent))
    if binary.name != 'native-read-smoke' or not binary.is_file():
        raise RuntimeError('explicit-native-read-smoke-binary-required')
    node = selected_node(args.node)
    helper_path = repo / READ_RUNNER
    helper_bytes = reviewed_helper(repo, helper_path)
    # Execute only the exact reviewed helper bytes; its __main__ runner stays idle.
    helper = {'__name__': 'reviewed_native_read_helpers'}
    exec(compile(helper_bytes, str(helper_path), 'exec'), helper)
    digest, private_json = (helper[name] for name in ['digest', 'private_json'])
    root = pathlib.Path(tempfile.mkdtemp(prefix='cerebro-keychain-adhoc-', dir=parent)).resolve()
    os.chmod(root, 0o700)
    root_identity = private_directory(root)
    env = child_environment()
    runner_path = pathlib.Path(__file__).resolve()
    runner_hash = digest(runner_path)
    stage = 'source-identity'
    evidence = {'format': 1, 'profile': 'keychain-adhoc', 'signingProfile': PROFILE,
        'passed': False, 'outcome': 'not_exercised', 'cleanup': 'unknown',
        'evidenceDirectory': str(root), 'realCredentials': False, 'realAccountImport': False,
        'providerNetwork': False, 'grantsOrEffectsEnabled': False, 'productionSigningAcceptance': False,
        'architecture': platform.machine(), 'runnerSha256': runner_hash,
        'readRunnerSha256': READ_RUNNER_SHA256}
    run = root / 'run'
    launched = False
    try:
        node_hash = digest(node)
        node_stat = node.lstat()
        node_identity = {'device': node_stat.st_dev, 'inode': node_stat.st_ino,
            'bytes': node_stat.st_size, 'modifiedNs': node_stat.st_mtime_ns}
        before = inventory_inputs(repo, node)
        source_hash = digest(binary)
        config_hash = digest(repo / 'src-tauri/native-read-smoke/tauri.conf.json')
        evidence.update({'producerInputsBefore': before, 'sourceBinarySha256': source_hash, 'smokeConfigSha256': config_hash, 'nodeExecutable': str(node), 'nodeSha256': node_hash, 'nodeIdentity': node_identity})
        stage = 'private-package'
        bundle = root / 'Cerebro Keychain Acceptance.app'
        for path in [bundle, bundle / 'Contents', bundle / 'Contents/MacOS', run]:
            path.mkdir(mode=0o700)
        run_identity = private_directory(run)
        executable = bundle / 'Contents/MacOS/native-read-smoke'
        copy_binary(binary, executable)
        if digest(executable) != source_hash:
            raise RuntimeError('copied-binary-mismatch')
        plist = {'CFBundleIdentifier': IDENTIFIER, 'CFBundleExecutable': 'native-read-smoke',
            'CFBundleName': 'Cerebro Keychain Acceptance', 'CFBundlePackageType': 'APPL',
            'CFBundleShortVersionString': '0.1.0', 'CFBundleVersion': '1',
            'LSMinimumSystemVersion': '14.0', 'NSHighResolutionCapable': True}
        create(bundle / 'Contents/Info.plist', plistlib.dumps(plist, sort_keys=True))
        create(root / 'package-intent.json', json.dumps({'format': 1, 'profile': PROFILE,
            'identityArgument': '-', 'entitlementsAdded': False, 'sourceBinarySha256': source_hash,
            'bundleIdentifier': IDENTIFIER, 'bundlePath': str(bundle), 'runRoot': str(run)}, indent=2).encode())
        stage = 'ad-hoc-signing'
        # The only signing identity is literal '-'. No certificates, keychains or
        # existing app installations are enumerated, consulted or modified.
        tool(['/usr/bin/codesign', '--force', '--sign', '-', '--timestamp=none', '--identifier', IDENTIFIER, str(bundle)], root, env)
        signed = signature(bundle, root, env)
        inventory = bundle_inventory(bundle, digest)
        signed_hash = digest(executable)
        os_version, _ = tool(['/usr/bin/sw_vers'], root, env)
        evidence.update({'signatureBefore': signed, 'bundleFilesBefore': inventory,
            'signedBinarySha256': signed_hash, 'osVersion': os_version.decode('utf8', errors='strict')})
        create(root / 'package-ready.json', json.dumps(evidence, indent=2).encode())
        stage = 'native-keychain-capture'
        child_env = dict(env)
        child_env.update({'PATH': str(run / 'bin'), 'SHELL': str(run / 'bin/smoke-shell'), 'CLAUDE_CONFIG_DIR': str(run / 'claude-config')})
        launched = True
        result, stdout, stderr = capture([str(executable), str(run), '--keychain-adhoc'], root, child_env, 75, 256 * 1024)
        create(run / 'stdout.log', stdout)
        create(run / 'stderr.log', stderr)
        evidence.update({'process': result, 'outcome': 'cleanup_pending', 'cleanup': 'unknown'})
        stage = 'post-capture-identity'
        private_directory(root, root_identity)
        private_directory(run, run_identity)
        after = inventory_inputs(repo, node)
        node_after = node.lstat()
        if node_identity != {'device': node_after.st_dev, 'inode': node_after.st_ino,
            'bytes': node_after.st_size, 'modifiedNs': node_after.st_mtime_ns}:
            raise RuntimeError('selected-node-identity-drift')
        signature_after = signature(bundle, root, env)
        inventory_after = bundle_inventory(bundle, digest)
        evidence.update({'producerInputsAfter': after, 'signatureAfter': signature_after, 'bundleFilesAfter': inventory_after})
        if before != after or digest(binary) != source_hash or digest(executable) != signed_hash or inventory != inventory_after or signed != signature_after or config_hash != digest(repo / 'src-tauri/native-read-smoke/tauri.conf.json') or digest(helper_path) != READ_RUNNER_SHA256 or digest(runner_path) != runner_hash or digest(node) != node_hash:
            raise RuntimeError('source-package-identity-drift')
        stage = 'native-report-and-receipts'
        values, receipt_hashes = receipts(run, private_json, digest)
        evidence['receiptSha256'] = receipt_hashes
        report = private_json(run / 'report.json', 65536)
        evidence['reportSha256'] = digest(run / 'report.json')
        observation = report.get('observation', {})
        if report.get('format') != 3 or report.get('profile') != 'keychain-adhoc' or report.get('observer') != 'native-injected-window-packaged-keychain-smoke' or report.get('signingProfile') != PROFILE:
            raise RuntimeError('native-profile-mismatch')
        compiled = report.get('compiledInputs', {})
        if any(compiled.get(key) != before.get(key) for key in ['aggregateDigest', 'fileCount', 'totalBytes']) or compiled.get('smokeConfigSha256') != config_hash:
            raise RuntimeError('compiled-source-mismatch')
        claims = {'actualInjectedCommand': True, 'realCredentials': False, 'realAccountImport': False,
            'providerNetwork': False, 'grantsOrEffectsEnabled': False, 'runtimeAccountLifecycle': False,
            'productionSigningAcceptance': False}
        if report.get('claims') != claims:
            raise RuntimeError('native-claims-mismatch')
        expected_bundle = {'identifier': IDENTIFIER, 'path': str(bundle), 'executablePath': str(executable)}
        if observation.get('bundle') != expected_bundle:
            raise RuntimeError('actual-nsbundle-mismatch')
        if (run / 'config/runtime.db').exists() or (run / 'bin').exists() or (run / 'vault-a').exists() or (run / 'vault-b').exists():
            raise RuntimeError('unexpected-runtime-or-cli-fixture')
        outcome = observation.get('outcome')
        if outcome not in ['pass', 'defect', 'environment_blocked', 'not_exercised', 'cleanup_pending'] or observation.get('cleanup') not in ['complete', 'pending', 'not_needed', 'unknown']:
            raise RuntimeError('native-outcome-shape')
        evidence.update({'outcome': outcome, 'cleanup': observation['cleanup'],
            'failureKind': observation.get('failureKind'), 'failedStage': observation.get('failedStage'),
            'keychainAccess': observation.get('keychainAccess'), 'deniedOrLocked': 'not_exercised'})
        observed = observation.get('cases', [])
        if not isinstance(observed, list) or observed != [{'name': name, 'observed': value} for name, value in list(CASES.items())[:len(observed)]]:
            raise RuntimeError('native-cases-not-an-exact-prefix')
        if values and any(item['state'] in ['put_in_flight', 'owned', 'delete_in_flight'] for item in values[-1]['items']) and observation['cleanup'] != 'pending':
            raise RuntimeError('possible-owned-item-not-reported-pending')
        if outcome == 'pass':
            expected_cases = [{'name': name, 'observed': value} for name, value in CASES.items()]
            if observed != expected_cases or [value['stage'] for value in values] != SUCCESS_STAGES or any(item['state'] != 'missing' for item in values[-1]['items']) or observation.get('receiptCount') != len(values) or observation.get('referenceCount') != 3 or observation.get('confirmedOwned') != 0 or observation.get('uncertainPuts') != 0 or observation.get('keychainAccess') is not True or observation['cleanup'] != 'complete' or observation.get('failedStage') is not None or observation.get('failureKind') is not None or report.get('passed') is not True or result['exitCode'] != 0 or result['failure'] is not None or result['cleanup']['reaped'] is not True or result['cleanup']['groupAbsent'] is not True or result['cleanup']['observationErrno'] is not None:
                raise RuntimeError('keychain-pass-evidence-incomplete')
            expected_states = [
                ['unchecked', 'unchecked', 'unchecked'], ['absent', 'absent', 'absent'],
                ['put_in_flight', 'absent', 'absent'], ['owned', 'absent', 'absent'],
                ['owned', 'absent', 'absent'], ['owned', 'absent', 'absent'],
                ['owned', 'put_in_flight', 'absent'], ['owned', 'owned', 'absent'],
                ['delete_in_flight', 'owned', 'absent'], ['missing', 'owned', 'absent'],
                ['missing', 'owned', 'put_in_flight'], ['missing', 'owned', 'owned'],
                ['missing', 'owned', 'owned'], ['missing', 'owned', 'delete_in_flight'],
                ['missing', 'owned', 'missing'], ['missing', 'delete_in_flight', 'missing'],
                ['missing', 'missing', 'missing'], ['missing', 'missing', 'missing'],
                ['missing', 'missing', 'missing'],
            ]
            if [[item['state'] for item in value['items']] for value in values] != expected_states:
                raise RuntimeError('receipt-ownership-transitions-differ')
            evidence['passed'] = True
        elif report.get('passed') is not False or result['exitCode'] == 0:
            raise RuntimeError('failed-observation-reported-success')
    except (OSError, ValueError, TypeError, KeyError, RuntimeError, subprocess.SubprocessError):
        evidence['supervisorFailureStage'] = stage
        evidence['passed'] = False
        if launched:
            evidence['outcome'] = 'cleanup_pending'
            evidence['cleanup'] = 'unknown'
        else:
            evidence['outcome'] = 'environment_blocked'
            evidence['cleanup'] = 'not_needed'
    # Never remove the package, receipts or an uncertain item. There is no
    # arbitrary-reference cleanup entrypoint and no automatic rerun.
    create(root / 'execution.json', (json.dumps(evidence, indent=2) + '\n').encode())
    print(json.dumps({'passed': evidence['passed'], 'outcome': evidence['outcome'], 'cleanup': evidence['cleanup'], 'directory': str(root)}))
    raise SystemExit(0 if evidence['passed'] else 2)


if __name__ == '__main__':
    main()
