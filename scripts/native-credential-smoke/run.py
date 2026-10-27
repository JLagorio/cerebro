#!/usr/bin/env python3
"""Root-only runner. Builds nothing; executes only the explicitly supplied smoke binary."""
import argparse, hashlib, json, os, pathlib, selectors, signal, stat, subprocess, tempfile, time


def digest(path):
    h = hashlib.sha256()
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > 2 * 1024 * 1024 * 1024:
            raise RuntimeError('hash input is not a bounded regular file')
        size = 0
        while True:
            block = os.read(fd, 1024 * 1024)
            if not block:
                break
            size += len(block)
            if size > 2 * 1024 * 1024 * 1024:
                raise RuntimeError('hash input grew beyond its cap')
            h.update(block)
        after = os.fstat(fd)
        if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or size != after.st_size:
            raise RuntimeError('hash input changed during observation')
        return h.hexdigest()
    finally:
        os.close(fd)


def inputs(repo):
    source = "import { nativeInputIdentity } from './scripts/outcomes/native-inputs.ts'; process.stdout.write(JSON.stringify(nativeInputIdentity(process.cwd())));"
    value = subprocess.run(['node', '--import', 'tsx', '--input-type=module', '-e', source],
                           cwd=repo, check=True, capture_output=True, timeout=30)
    if len(value.stdout) > 4096 or len(value.stderr) > 65536:
        raise RuntimeError('input identity output exceeded its cap')
    return json.loads(value.stdout)


def private_json(path, maximum):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid() or before.st_mode & 0o077 or before.st_size > maximum:
            raise RuntimeError('metadata evidence is not a bounded private regular file')
        value = bytearray()
        while len(value) <= maximum:
            block = os.read(fd, min(8192, maximum + 1 - len(value)))
            if not block:
                break
            value.extend(block)
        after = os.fstat(fd)
        if len(value) > maximum or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or len(value) != after.st_size:
            raise RuntimeError('metadata evidence changed or exceeded its bound')
        return json.loads(value)
    finally:
        os.close(fd)


def settings_evidence(root, report):
    claims = report.get('claims', {})
    expected_claims = {
        'actualMacosWindow': True, 'actualInjectedCommand': True,
        'disposableAccountMetadataWrites': True, 'providerFreeFixtureCli': True,
        'credentialAccess': False, 'realAccountImport': False, 'providerNetwork': False,
        'grantsOrEffectsEnabled': False, 'realCliAcceptance': False,
        'packagedKeychainAcceptance': False, 'positivePendingCleanupExercised': False,
    }
    if report.get('format') != 2 or report.get('profile') != 'settings-metadata' or report.get('observer') != 'native-injected-window-settings-metadata-smoke' or claims != expected_claims:
        raise RuntimeError('metadata profile identity or claims differ')
    if os.path.lexists(root / 'config.settings-original'):
        raise RuntimeError('metadata origin restoration is pending')
    audit_path = root / 'settings-audit.json'
    audit = private_json(audit_path, 16384)
    if audit.get('format') != 1 or audit.get('profile') != 'settings-metadata' or audit.get('counts') != {'connections': 1, 'attempts': 0, 'secretReferences': 0, 'cleanup': 0, 'accountGrants': 0} or audit.get('matchesExpected') is not True or audit.get('activeAttemptAbsent') is not True or audit.get('secretReferenceAbsent') is not True:
        raise RuntimeError('metadata storage audit differs')
    status = audit.get('status', {})
    expected_status = {'revision': 2, 'login': 'cerebro-native-smoke', 'health': 'disabled',
                       'account': None, 'secretRevision': 0, 'revocationGeneration': 1,
                       'cleanupPending': False, 'remoteRevocation': 'not_attempted'}
    if set(status) != set(expected_status) | {'connectionId', 'observedAt'} or any(status.get(key) != value for key, value in expected_status.items()):
        raise RuntimeError('metadata final status differs')
    identity = status['connectionId']
    if not isinstance(identity, str) or len(identity) != 32 or any(c not in '0123456789abcdef' for c in identity) or not isinstance(status['observedAt'], str) or not status['observedAt'].endswith('Z'):
        raise RuntimeError('metadata final identity or observation is malformed')
    physical = audit.get('physicalIdentity', {})
    if set(physical) != {'root', 'config', 'database'}:
        raise RuntimeError('metadata physical identity is missing')
    for name, path, directory in [('root', root, True), ('config', root / 'config', True), ('database', root / 'config/runtime.db', False)]:
        observed = path.lstat()
        required_type = stat.S_ISDIR if directory else stat.S_ISREG
        if not required_type(observed.st_mode) or observed.st_uid != os.geteuid() or observed.st_mode & (0o077 if directory else 0o022) or path.resolve(strict=True) != path or physical[name] != {'dev': observed.st_dev, 'ino': observed.st_ino}:
            raise RuntimeError('metadata audit path no longer names its original physical file')
    journals = {}
    for stage in ['00-prepared', '01-renamed', '02-linked', '03-restore-intent', '04-restored']:
        path = root / ('settings-origin-' + stage + '.json')
        observed = private_json(path, 4096)
        if observed != {'format': 1, 'stage': stage, 'configName': 'config', 'heldName': 'config.settings-original', 'physicalIdentity': physical}:
            raise RuntimeError('metadata origin journal differs')
        journals[stage] = digest(path)
    return {'auditSha256': digest(audit_path), 'originJournalSha256': journals}



def credential_evidence(root, report):
    expected_claims = {
        'actualMacosWindow': True, 'actualInjectedCommand': True,
        'authenticatedAcquisitionWrappers': True, 'disposableAccountMetadataWrites': True,
        'unavailableHarnessWorkers': True, 'individuallyRegisteredAcquisitionCommands': True,
        'credentialAccess': False, 'realAccountImport': False, 'providerNetwork': False,
        'keychainAccess': False, 'grantsOrEffectsEnabled': False, 'usableConnection': False,
    }
    if report.get('format') != 4 or report.get('profile') != 'credential-metadata' or report.get('observer') != 'native-injected-window-credential-metadata-smoke' or report.get('claims') != expected_claims:
        raise RuntimeError('credential profile identity or claims differ')
    if any(os.path.lexists(root / name) for name in ['runtime.credential-original.db', 'runtime.credential-replacement.db']):
        raise RuntimeError('credential runtime restoration is pending')
    path = root / 'credential-audit.json'
    audit = private_json(path, 16384)
    if audit.get('format') != 1 or audit.get('profile') != 'credential-metadata' or audit.get('counts') != {'connections': 1, 'attempts': 2, 'secretReferences': 0, 'cleanup': 0, 'accountGrants': 0} or audit.get('matchesExpected') is not True or audit.get('activeAttemptAbsent') is not True or audit.get('secretReferenceAbsent') is not True:
        raise RuntimeError('credential audit differs')
    expected_status = {'revision': 6, 'login': 'cerebro-credential-smoke', 'health': 'disabled', 'account': None, 'secretRevision': 0, 'revocationGeneration': 1, 'cleanupPending': False, 'remoteRevocation': 'not_attempted'}
    status = audit.get('status', {})
    if set(status) != set(expected_status) | {'connectionId', 'observedAt'} or any(status.get(key) != value for key, value in expected_status.items()):
        raise RuntimeError('credential final status differs')
    def opaque(value):
        return isinstance(value, str) and len(value) == 32 and all(c in '0123456789abcdef' for c in value)
    def stamp(value):
        return isinstance(value, str) and len(value) <= 128 and value.endswith('Z')
    if not opaque(status['connectionId']) or not stamp(status['observedAt']):
        raise RuntimeError('credential final identity/observation malformed')
    attempts = audit.get('attempts', [])
    if not isinstance(attempts, list) or len(attempts) != 2:
        raise RuntimeError('credential terminal attempt evidence missing')
    keys = {'attemptId', 'connectionId', 'host', 'login', 'expectedRevision', 'revocationGeneration', 'state', 'error', 'observedAt'}
    for attempt, revision, state, error in [(attempts[0], 2, 'failed', 'unavailable'), (attempts[1], 4, 'cancelled', 'cancelled')]:
        if not isinstance(attempt, dict) or set(attempt) != keys or not opaque(attempt['attemptId']) or attempt['connectionId'] != status['connectionId'] or attempt['host'] != 'github.com' or attempt['login'] != expected_status['login'] or attempt['expectedRevision'] != revision or attempt['revocationGeneration'] != 0 or attempt['state'] != state or attempt['error'] != error or not stamp(attempt['observedAt']):
            raise RuntimeError('credential safe acquisition view differs')
    if attempts[0]['attemptId'] == attempts[1]['attemptId']:
        raise RuntimeError('credential attempts reused identity')
    physical = audit.get('physicalIdentity', {})
    if set(physical) != {'root', 'config', 'database'}:
        raise RuntimeError('credential physical identity missing')
    for name, target, directory in [('root', root, True), ('config', root / 'config', True), ('database', root / 'config/runtime.db', False)]:
        current = target.lstat()
        required = stat.S_ISDIR if directory else stat.S_ISREG
        if not required(current.st_mode) or current.st_uid != os.geteuid() or current.st_mode & (0o077 if directory else 0o022) or target.resolve(strict=True) != target or physical[name] != {'dev': current.st_dev, 'ino': current.st_ino}:
            raise RuntimeError('credential original physical file no longer named')
    journals = {}
    replacement = None
    for stage in ['00-prepared', '01-renamed', '02-replaced', '03-restore-intent', '04-restored']:
        entry = root / ('credential-runtime-' + stage + '.json')
        value = private_json(entry, 4096)
        candidate = value.get('replacementIdentity')
        if not isinstance(candidate, dict) or set(candidate) != {'dev', 'ino'} or any(type(candidate[k]) is not int or candidate[k] < 0 for k in ['dev', 'ino']) or candidate == physical['database']:
            raise RuntimeError('credential replacement identity malformed')
        replacement = candidate if replacement is None else replacement
        if value != {'format': 1, 'profile': 'credential-metadata', 'stage': stage, 'databaseName': 'config/runtime.db', 'heldName': 'runtime.credential-original.db', 'replacementName': 'runtime.credential-replacement.db', 'physicalIdentity': physical, 'replacementIdentity': replacement}:
            raise RuntimeError('credential restoration journal differs')
        journals[stage] = digest(entry)
    return {'auditSha256': digest(path), 'runtimeJournalSha256': journals}


def public_bridge_evidence(root, report):
    claims = {
        'actualInjectedCommand': True, 'individuallyRegisteredAcquisitionCommands': True,
        'actualAuthenticatedPublicBegin': True, 'ownedUnavailableWorkerSettled': True,
        'originalAppOwnerAcrossVaults': True, 'disposableAccountMetadataWrites': True,
        'credentialAccess': False, 'realAccountImport': False, 'providerNetwork': False,
        'keychainAccess': False, 'grantsOrEffectsEnabled': False, 'usableConnection': False,
    }
    if report.get('format') != 1 or report.get('profile') != 'credential-public' or report.get('observer') != 'native-public-credential-bridge-smoke' or report.get('claims') != claims:
        raise RuntimeError('public credential bridge claims differ')
    path = root / 'credential-public-audit.json'
    audit = private_json(path, 16384)
    counts = {'connections': 1, 'attempts': 1, 'secretReferences': 0, 'cleanup': 0, 'accountGrants': 0}
    if audit.get('format') != 1 or audit.get('profile') != 'credential-public' or audit.get('counts') != counts or audit.get('matchesExpected') is not True or audit.get('activeAttemptAbsent') is not True or audit.get('secretReferenceAbsent') is not True:
        raise RuntimeError('public credential bridge storage audit differs')
    keys = {'attemptId', 'connectionId', 'host', 'login', 'expectedRevision', 'revocationGeneration', 'state', 'error', 'observedAt'}
    pending, terminal, status = (audit.get(key, {}) for key in ['pending', 'terminal', 'status'])
    def opaque(value):
        return isinstance(value, str) and len(value) == 32 and all(c in '0123456789abcdef' for c in value)
    for view, state, error in [(pending, 'pending', None), (terminal, 'failed', 'unavailable')]:
        if set(view) != keys or not opaque(view.get('attemptId')) or not opaque(view.get('connectionId')) or view.get('host') != 'github.com' or view.get('login') != 'cerebro-public-bridge-smoke' or view.get('expectedRevision') != 2 or view.get('revocationGeneration') != 0 or view.get('state') != state or view.get('error') != error or not isinstance(view.get('observedAt'), str) or not view['observedAt'].endswith('Z') or len(view['observedAt']) > 128:
            raise RuntimeError('public credential bridge safe view differs')
    if pending['attemptId'] != terminal['attemptId'] or pending['connectionId'] != terminal['connectionId']:
        raise RuntimeError('public credential bridge changed original attempt')
    expected_status = {'revision': 3, 'login': 'cerebro-public-bridge-smoke', 'health': 'unavailable', 'account': None, 'secretRevision': 0, 'revocationGeneration': 0, 'cleanupPending': False, 'remoteRevocation': 'not_attempted'}
    if set(status) != set(expected_status) | {'connectionId', 'observedAt'} or status.get('connectionId') != pending['connectionId'] or any(status.get(key) != value for key, value in expected_status.items()) or not isinstance(status.get('observedAt'), str) or not status['observedAt'].endswith('Z') or len(status['observedAt']) > 128:
        raise RuntimeError('public credential bridge status differs')
    physical = audit.get('physicalIdentity', {})
    if set(physical) != {'root', 'config', 'database'}:
        raise RuntimeError('public credential bridge physical identity missing')
    for name, target, directory in [('root', root, True), ('config', root / 'config', True), ('database', root / 'config/runtime.db', False)]:
        current = target.lstat()
        required = stat.S_ISDIR if directory else stat.S_ISREG
        if not required(current.st_mode) or current.st_uid != os.geteuid() or current.st_mode & (0o077 if directory else 0o022) or target.resolve(strict=True) != target or physical[name] != {'dev': current.st_dev, 'ino': current.st_ino}:
            raise RuntimeError('public credential bridge original file no longer named')
    if any(os.path.lexists(root / name) for name in ['runtime.credential-original.db', 'runtime.credential-replacement.db']):
        raise RuntimeError('public credential bridge restoration pending')
    return {'auditSha256': digest(path)}



def managed_launch_binding(value, owned, profile):
    """Finite metadata join; ownership itself comes only from original launch."""
    def integer(number, low, high):
        return type(number) is int and low <= number <= high
    scenarios = ('allow', 'stop', 'window')
    if profile not in tuple('managed-action-' + scenario for scenario in scenarios):
        raise ValueError('Unknown managed profile')
    if (not isinstance(owned, dict) or not integer(owned.get('pid'), 2, 2**31 - 1)
            or not integer(owned.get('uid'), 0, 2**32 - 1)
            or owned.get('pgid') != owned['pid'] or owned.get('sid') != owned['pid']):
        raise ValueError('Qualified native app owner is missing')
    if (not isinstance(value, dict)
            or set(value) != {'format', 'observer', 'profile', 'scenario', 'nativePid', 'run', 'child'}
            or type(value['format']) is not int or value['format'] != 1
            or value['observer'] != 'native-owned-managed-cli-launch'
            or value['profile'] != 'managed-action' or value['scenario'] != profile[len('managed-action-'):]
            or type(value['nativePid']) is not int or value['nativePid'] != owned['pid']
            or type(value['run']) is not int or value['run'] != 0):
        raise ValueError('Original managed launch receipt differs')
    child = value['child']
    if (not isinstance(child, dict)
            or set(child) != {'pid', 'parent_pid', 'group_pid', 'uid', 'start_seconds', 'start_micros'}
            or not integer(child['pid'], 2, 2**31 - 1) or child['pid'] == owned['pid']
            or type(child['parent_pid']) is not int or child['parent_pid'] != owned['pid']
            or type(child['group_pid']) is not int or child['group_pid'] != child['pid']
            or type(child['uid']) is not int or child['uid'] != owned['uid']
            or not integer(child['start_seconds'], 1, 2**64 - 1)
            or not integer(child['start_micros'], 0, 999999)):
        raise ValueError('Original managed child identity differs')
    return {'pid': child['pid'], 'start': [child['start_seconds'], child['start_micros']],
            'ppid': child['parent_pid'], 'pgid': child['group_pid'], 'uid': child['uid']}


# Keep the accepted module and any unresolved Popen references alive until this
# supervisor exits. Do not monkeypatch its lifecycle, selectors or classifiers.
QUALIFIED_MODULES = []
MANAGED_PROFILES = ('managed-action-allow', 'managed-action-stop', 'managed-action-window')


def managed_qualified_module(repo, expected):
    import types
    path = repo / 'scripts/native-quit-smoke/run.py'
    if path.resolve(strict=True) != path or not isinstance(expected, str) or len(expected) != 64 or any(c not in '0123456789abcdef' for c in expected):
        raise ValueError('Exact reviewed qualified supervisor source pin required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > 4 * 1024 * 1024:
            raise ValueError('Qualified supervisor source is not bounded regular input')
        source = bytearray()
        while len(source) <= 4 * 1024 * 1024:
            block = os.read(fd, min(65536, 4 * 1024 * 1024 + 1 - len(source)))
            if not block: break
            source.extend(block)
        after = os.fstat(fd)
        if (len(source) != after.st_size or len(source) > 4 * 1024 * 1024
                or any(getattr(before, key) != getattr(after, key) for key in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns'))
                or hashlib.sha256(source).hexdigest() != expected):
            raise ValueError('Qualified supervisor source pin changed')
    finally:
        os.close(fd)
    module = types.ModuleType('managed_unchanged_qualified_supervisor')
    module.__file__ = str(path)
    exec(compile(bytes(source), str(path), 'exec'), module.__dict__)
    QUALIFIED_MODULES.append(module)
    return module


def managed_child_absence(q, observer, qualification, result, binding):
    """Read only the original child identity; no signal, waiter or new owner."""
    root = pathlib.Path(result['root'])
    q.validate_layout(result['startupLayout'], False, False)
    path = root / 'managed-child-cleanup.jsonl'
    book = observer.Book()
    key = book.add(binding['pid'], binding['start'])
    fd = None; written = 0; errors = []
    started = time.monotonic_ns()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        def sink(raw):
            nonlocal written
            data = (json.dumps(raw, separators=(',', ':')) + '\n').encode()
            if written + len(data) > 65536:
                raise ValueError('Original child observation evidence cap')
            view = memoryview(data)
            while view:
                count = os.write(fd, view)
                if count <= 0: raise OSError('Short original child evidence write')
                view = view[count:]
            os.fsync(fd); written += len(data)
        scheduler = observer.Scheduler(observer.Reader(), book, sink)
        # Same accepted one-second observation cadence, with a separate fixed
        # three-second read-only phase AFTER the full unchanged main cleanup.
        while time.monotonic_ns() < started + 3_000_000_000:
            scheduler.tick('managed-original-cli-absence')
            if qualification.complete(book, key): break
            time.sleep(min(0.05, max(0, (started + 3_000_000_000 - time.monotonic_ns()) / 1e9)))
    except Exception as error:
        book.evidence_failure('managed original-child read phase failed')
        errors.append(repr(error))
    finally:
        if fd is not None:
            try: os.close(fd)
            except OSError as error:
                book.evidence_failure('managed original-child evidence close failed')
                errors.append(repr(error))
    return {'format': 1, 'scope': 'original owning-launch PID/start identity only; read-only, no signaling or wait',
            'original': binding, 'ownedKey': key, 'startedNs': started, 'endedNs': time.monotonic_ns(),
            'declaredPhaseMaximumNs': 3_000_000_000,
            'qualifiedReaderVerdict': qualification.complete(book, key),
            'book': book.snapshot(), 'errors': errors,
            'observationsPath': str(path), 'observationsSha256': digest(path) if fd is not None else None}


def managed_action_evidence(report, profile, owner, launch_sha256, inputs):
    expected_claims = {'actualMacosWindow': True, 'actualOriginalPublication': True,
                      'actualLoopbackManagedCall': True, 'actualPersonAnswerCommand': True,
                      'fixedFakeProviderOnly': True, 'credentialAccess': False, 'providerNetwork': False,
                      'realAccount': False, 'realClaudeCode': False, 'realPersonBehavior': False,
                      'packagedSigningAcceptance': False}
    scenario = profile[len('managed-action-'):]
    if (not isinstance(report, dict) or type(report.get('format')) is not int or report['format'] != 1
            or report.get('observer') != 'native-original-attended-managed-action-smoke'
            or report.get('profile') != 'managed-action' or report.get('scenario') != scenario
            or report.get('claims') != expected_claims or report.get('passed') is not True
            or type(report.get('nativePid')) is not int or report['nativePid'] != owner['pid']
            or report.get('childLaunchSha256') != launch_sha256 or report.get('compiledInputs') != inputs):
        raise ValueError('Managed action native identity, claims, launch or compiled inputs differ')
    required = [
        ('managed-original-publication', 'actual-installed-original-run'),
        ('managed-first-run-zero', 'zero-is-an-actual-original-handle'),
        ('managed-access-held', 'original-run-null-correlation-zero-effects'),
        ('managed-effect-held', 'original-interaction-zero-provider-before-answer'),
    ]
    required += ([('managed-person-answer', 'finite-original-answered-no-resumed-handle'),
                  ('managed-completed-effect', 'one-original-attempt-receipt-and-canonical-output')]
                 if scenario == 'allow' else
                 [('managed-late-answer', 'refused-no-new-owner'),
                  ('managed-stopped-effect', 'cancelled-before-submit-zero-provider')])
    cases = report.get('cases')
    if (not isinstance(cases, list) or len(cases) != len(required)
            or any(not isinstance(row, dict) or set(row) != {'name', 'observed'} for row in cases)
            or [(row['name'], row['observed']) for row in cases] != required):
        raise ValueError('Managed action finite native observation sequence differs')
    audit = report.get('audit')
    expected = {'runs': 1, 'native_runs': 1, 'connections': 1, 'grants': 1, 'invocations': 1,
                'attempts': 1 if scenario == 'allow' else 0, 'receipts': 1 if scenario == 'allow' else 0,
                'provider_entries': 1 if scenario == 'allow' else 0,
                'state': 'succeeded' if scenario == 'allow' else 'cancelled'}
    if (not isinstance(audit, dict) or set(audit) != set(expected) | {'invocation'}
            or any(audit.get(key) != value or (type(value) is int and type(audit.get(key)) is not int)
                   for key, value in expected.items())
            or not isinstance(audit['invocation'], str) or len(audit['invocation']) != 32
            or any(c not in '0123456789abcdef' for c in audit['invocation'])):
        raise ValueError('Managed action exact original audit differs')
    return {'scenario': scenario, 'audit': audit, 'realCredentialOrProvider': False}


def managed_cleanup_disposition(q,result,audit,report_bytes,profile,launch_hash):
    # This is not an arbitrary caller allow flag: the exact original native
    # report must pass the existing finite semantic validator first.
    if (profile not in MANAGED_PROFILES or not isinstance(report_bytes,bytes) or len(report_bytes)>65536
            or hashlib.sha256(report_bytes).hexdigest()!=result['nativeReportSha256']):
        raise ValueError('Original managed native report pin differs')
    report=json.loads(report_bytes)
    managed_action_evidence(report,profile,result['owned'],launch_hash,result['inputs'])
    return q.cleanup_disposition(result,audit)


def managed_main(args, repo, binary, parent):
    if (args.cleanup_acceptance is None or args.cleanup_acceptance_sha256 is None
            or args.ownership_acceptance is None or args.qualified_runner_sha256 is None):
        raise ValueError('Managed profiles require exact accepted reader, owned-group and qualified supervisor pins')
    wrapper_hash = digest(pathlib.Path(__file__).resolve())
    q = managed_qualified_module(repo, args.qualified_runner_sha256)
    observer, qualification = q.load_observer(repo, args.cleanup_acceptance, args.cleanup_acceptance_sha256)
    ownership = q.load_owned_group_acceptance(args.ownership_acceptance, repo, observer, args.cleanup_acceptance_sha256)
    # This is the sole managed native launch. Keep supervise byte/behavior intact;
    # unknown quit classification is recorded after its complete cleanup, never
    # used as the managed semantic verdict and never monkeypatched away.
    result = q.supervise(repo, binary, args.profile, parent, observer, qualification,
                         reader_acceptance=args.cleanup_acceptance, ownership_acceptance=args.ownership_acceptance)
    root = pathlib.Path(result['root']); native = pathlib.Path(result['nativeRoot'])
    errors = []; child = None; action = None; launch_hash = None; fresh = False; report_bytes = None
    try:
        q.validate_layout(result['startupLayout'], False, False)
        launch_path = native / 'managed-child-launch.json'
        launch = private_json(launch_path, 4096); launch_hash = digest(launch_path)
        binding = managed_launch_binding(launch, result['owned'], args.profile)
        child = managed_child_absence(q, observer, qualification, result, binding)
    except Exception as error:
        errors.append({'originalChildEvidenceError': repr(error)})
    try:
        report_path = native / 'report.json'
        report_bytes=q.read_regular(report_path,65536,True)
        report=json.loads(report_bytes)
        if digest(report_path) != result['nativeReportSha256']:
            raise ValueError('Qualified-supervision native report pin changed')
        action = managed_action_evidence(report, args.profile, result['owned'], launch_hash, result['inputs'])
    except Exception as error:
        errors.append({'managedSemanticError': repr(error)})
    try:
        fresh_observer, fresh_qualification = q.load_observer(repo, args.cleanup_acceptance, args.cleanup_acceptance_sha256)
        fresh_ownership = q.load_owned_group_acceptance(args.ownership_acceptance, repo, fresh_observer, args.cleanup_acceptance_sha256)
        fresh = (result['inputsStable'] is True and result['inputs'] == q.source_identity(repo)
                 and result['bundle'] == q.bundle_identity(repo) and result['binarySha256'] == digest(binary)
                 and result['runnerSha256'] == args.qualified_runner_sha256
                 and digest(repo / 'scripts/native-quit-smoke/run.py') == args.qualified_runner_sha256
                 and wrapper_hash == digest(pathlib.Path(__file__).resolve())
                 and qualification.binding == fresh_qualification.binding
                 and result['runtime'] == fresh_observer.runtime_facts()
                 and result['ownershipAcceptance'] == ownership == fresh_ownership)
        if not fresh: raise ValueError('Managed source/binary/bundle/runtime/acceptance pins changed')
    except Exception as error:
        errors.append({'postChildPinError': repr(error)})
    disposition={'kind':'unavailable','resourceComplete':False,'deliveredSignals':False,'diagnostics':result['errors']}
    try:
        disposition=managed_cleanup_disposition(q,result,q.cleanup_audit(result),report_bytes,args.profile,launch_hash)
    except Exception as error:
        errors.append({'managedCleanupEvidenceError':repr(error)})
    main_cleanup=disposition['resourceComplete']
    child_absent = child is not None and child['qualifiedReaderVerdict'] is True and not child['errors']
    # Cleanup and semantic success remain independent: a causal native RED may
    # exit 2 after complete cleanup. An intervention never masquerades as Allow.
    retained = result['retainedExitObservationNs']
    ordinary_exit = (result['exitCode'] == 0 and type(retained) is int
                     and all(type(row.get('ns')) is int and row['ns'] > retained for row in result['signals']))
    accepted = main_cleanup and child_absent and fresh and ordinary_exit and action is not None and not errors
    evidence = {'format': 1, 'profile': args.profile, 'accepted': accepted,
                'managedRunnerSha256': wrapper_hash, 'qualifiedSupervisorSha256': result['runnerSha256'],
                'qualifiedExecutionPath': str(root / 'execution.json'),
                'qualifiedExecutionSha256': digest(root / 'execution.json'),
                'qualifiedMainCleanup': main_cleanup, 'cleanupDisposition':disposition, 'originalChildIdentityAbsentQualified': child_absent,
                'freshPinsVerified': fresh, 'ordinaryNativeExit': ordinary_exit,
                'quitNativeExitAndTimingApplicability': 'inapplicable to managed semantic verdict; preserved unchanged in qualified execution',
                'originalChildLaunchSha256': launch_hash, 'childCleanup': child, 'managedActionEvidence': action,
                'errors': errors, 'credentialAccess': False, 'providerNetwork': False,
                'fixedFakeProviderOnly': True, 'realCliAcceptance': False, 'realPersonBehavior': False,
                'packagedAcceptance': False}
    q.write_json(root / 'managed-execution.json', evidence)
    print(json.dumps({'accepted': accepted, 'directory': str(root),
                      'qualifiedExecution': str(root / 'execution.json'),
                      'managedExecution': str(root / 'managed-execution.json')}), flush=True)
    raise SystemExit(0 if accepted else 2)


WORKFLOW_PROFILE = 'workflow-pinned'
WORKFLOW_CASES = [
    ('workflow-v1-published', 'actual-save-publish-original-opening'),
    ('workflow-v1-waiting', 'actual-owned-worker-original-continuation'),
    ('workflow-v2-published', 'new-publication-original-wait-unchanged'),
    ('workflow-unpublished', 'revisioned-tombstone-pinned-v1-wait-preserved'),
    ('workflow-start-replayed', 'same-key-original-run-no-new-admission'),
    ('workflow-explicit-continue', 'original-revision-epoch-and-wait'),
    ('workflow-v1-result', 'v1-answer-digest-completed-content-not-retained'),
    ('workflow-final-audit', 'one-original-run-zero-effects-zero-value-bodies'),
]


def workflow_evidence(report, owner, inputs):
    """Pure closed native report validation; never supplies process authority."""
    def need(value, reason):
        if not value: raise ValueError(reason)
    def hex_value(value, size):
        return isinstance(value, str) and len(value) == size and all(c in '0123456789abcdef' for c in value)
    def exact_keys(value, keys):
        return isinstance(value, dict) and set(value) == set(keys)
    claims = {
        'actualMacosWindow': True, 'actualInjectedCommand': True,
        'actualWorkflowCommands': True, 'actualOwnedWorker': True, 'originalPinnedVersion': True,
        'completedDetailRetention': 'off', 'cliExecution': False, 'credentialAccess': False,
        'providerNetwork': False, 'accountAuthority': False, 'automaticScheduling': False,
        'realPersonBehavior': False, 'packagedSigningAcceptance': False,
    }
    need(exact_keys(report, ('format', 'observer', 'profile', 'nativePid', 'passed', 'failedStage',
                            'compiledInputs', 'cases', 'audit', 'claims')), 'workflow report fields')
    need(type(report['format']) is int and report['format'] == 1
         and report['observer'] == 'native-original-pinned-workflow-smoke'
         and report['profile'] == WORKFLOW_PROFILE and report['passed'] is True and report['failedStage'] is None,
         'workflow profile or failure')
    need(isinstance(owner, dict) and type(owner.get('pid')) is int and owner['pid'] > 1, 'workflow original native owner')
    need(isinstance(inputs, dict) and hex_value(inputs.get('aggregateDigest'), 64), 'workflow original source identity')
    need(type(report['nativePid']) is int and report['nativePid'] == owner['pid']
         and report['compiledInputs'] == inputs, 'workflow original native or source pins')
    need(report['claims'] == claims and all(type(report['claims'][key]) is type(value) for key, value in claims.items()),
         'workflow bounded claims')
    cases = report['cases']
    need(isinstance(cases, list) and len(cases) == len(WORKFLOW_CASES)
         and all(exact_keys(row, ('name', 'observed')) for row in cases)
         and [(row['name'], row['observed']) for row in cases] == WORKFLOW_CASES, 'workflow finite case sequence')
    audit = report['audit']
    need(exact_keys(audit, ('rows', 'context', 'first', 'second', 'unpublish', 'expectedOutputDigest', 'physicalIdentity')),
         'workflow audit fields')
    context = audit['context']
    need(exact_keys(context, ('vaultId', 'storeUuid')) and hex_value(context['vaultId'], 32)
         and isinstance(context['storeUuid'], str) and 0 < len(context['storeUuid']) <= 128
         and all(ord(c) >= 32 and ord(c) != 127 for c in context['storeUuid']), 'workflow context')
    for name, revision in [('first', 1), ('second', 2)]:
        publication = audit[name]
        need(exact_keys(publication, ('version', 'revision')) and type(publication['revision']) is int
             and publication['revision'] == revision, 'workflow monotonic publication')
        version = publication['version']
        need(exact_keys(version, ('workflowId', 'definitionHash')) and version['workflowId'] == 'native-pinned-journey'
             and hex_value(version['definitionHash'], 64), 'workflow pinned definition')
    first = audit['first']['version']['definitionHash']; second = audit['second']['version']['definitionHash']
    need(first != second, 'workflow changed definition must differ')
    unpublish = audit['unpublish']
    need(exact_keys(unpublish, ('context', 'requestKey', 'original', 'publicationRevision', 'replayed'))
         and unpublish['context'] == context and unpublish['requestKey'] == '3' * 32
         and unpublish['original'] == audit['second'] and type(unpublish['publicationRevision']) is int
         and unpublish['publicationRevision'] == 3 and unpublish['replayed'] is False, 'workflow tombstone acknowledgement')
    rows = audit['rows']
    need(exact_keys(rows, ('runId', 'nativeRunId', 'vaultId', 'storeUuid', 'version', 'originVersion', 'startKey',
                          'state', 'outputDigest', 'continuationId', 'waitVersion', 'waitState', 'signalKey',
                          'originalPermissions', 'currentPermissions', 'counts', 'reservedBytes')), 'workflow row fields')
    for key in ('runId', 'nativeRunId', 'continuationId'):
        need(hex_value(rows[key], 32), 'workflow actual finite identity')
    need(rows['runId'] != rows['nativeRunId'] and rows['continuationId'] != rows['runId'], 'workflow identities aliased')
    expected_digest = hashlib.sha256(b'{"answer":"answered","version":"v1"}').hexdigest()
    need(rows['vaultId'] == context['vaultId'] and rows['storeUuid'] == context['storeUuid']
         and rows['version'] == rows['originVersion'] == rows['waitVersion'] == first
         and rows['startKey'] == '1' * 32 and rows['signalKey'] == '2' * 32
         and rows['state'] == 'succeeded' and rows['waitState'] == 'consumed'
         and rows['outputDigest'] == audit['expectedOutputDigest'] == expected_digest,
         'workflow original run/wait/result linkage')
    empty = {'readPrefixes': [], 'queryRecords': False, 'accounts': []}
    need(rows['originalPermissions'] == rows['currentPermissions'] == empty
         and rows['originalPermissions']['queryRecords'] is False
         and rows['currentPermissions']['queryRecords'] is False, 'workflow introduced permission')
    expected_counts = {'runs': 1, 'nativeRuns': 1, 'workflowRuns': 1, 'origins': 1, 'steps': 2,
                       'attempts': 2, 'waits': 1, 'values': 0, 'connections': 0, 'grants': 0,
                       'invocations': 0, 'actionAttempts': 0}
    need(rows['counts'] == expected_counts and all(type(rows['counts'][key]) is int for key in expected_counts)
         and type(rows['reservedBytes']) is int and rows['reservedBytes'] == 0, 'workflow count/retention/effect invariant')
    physical = audit['physicalIdentity']
    need(exact_keys(physical, ('root', 'config', 'database')), 'workflow original physical identity')
    for identity in physical.values():
        need(exact_keys(identity, ('dev', 'ino')) and type(identity['dev']) is int and identity['dev'] >= 0
             and type(identity['ino']) is int and identity['ino'] > 0,
             'workflow physical identity fields')
    return {'runId': rows['runId'], 'nativeRunId': rows['nativeRunId'], 'continuationId': rows['continuationId'],
            'firstVersion': first, 'secondVersion': second, 'outputDigest': expected_digest, 'counts': rows['counts'],
            'completedDetailRetention': 'off', 'credentialOrProviderOrCli': False}


def workflow_cleanup_disposition(q, result, audit, report_bytes):
    if (not isinstance(report_bytes, bytes) or len(report_bytes) > 65536
            or hashlib.sha256(report_bytes).hexdigest() != result['nativeReportSha256']):
        raise ValueError('Original workflow report pin differs')
    workflow_evidence(json.loads(report_bytes), result['owned'], result['inputs'])
    return q.cleanup_disposition(result, audit)


def workflow_main(args, repo, binary, parent):
    if (args.cleanup_acceptance is None or args.cleanup_acceptance_sha256 is None
            or args.ownership_acceptance is None or args.qualified_runner_sha256 is None):
        raise ValueError('Workflow profile requires accepted reader, owned-group and qualified supervisor pins')
    wrapper_hash = digest(pathlib.Path(__file__).resolve())
    q = managed_qualified_module(repo, args.qualified_runner_sha256)
    observer, qualification = q.load_observer(repo, args.cleanup_acceptance, args.cleanup_acceptance_sha256)
    ownership = q.load_owned_group_acceptance(args.ownership_acceptance, repo, observer, args.cleanup_acceptance_sha256)
    # Sole native launch. Qualified supervisor, deadlines and raw classification
    # remain unchanged. No CLI child is started by the fixed native profile.
    result = q.supervise(repo, binary, WORKFLOW_PROFILE, parent, observer, qualification,
                         reader_acceptance=args.cleanup_acceptance, ownership_acceptance=args.ownership_acceptance)
    root = pathlib.Path(result['root']); native = pathlib.Path(result['nativeRoot'])
    errors = []; evidence = None; fresh = False; report_bytes = None; audit_hash = None
    try:
        q.validate_layout(result['startupLayout'], False, False)
        report_bytes = q.read_regular(native / 'report.json', 65536, True)
        if hashlib.sha256(report_bytes).hexdigest() != result['nativeReportSha256']:
            raise ValueError('Qualified native workflow report pin changed')
        report = json.loads(report_bytes)
        evidence = workflow_evidence(report, result['owned'], result['inputs'])
        audit_path = native / 'workflow-audit.json'
        audit_bytes = q.read_regular(audit_path, 16384, True)
        if json.loads(audit_bytes) != report['audit']:
            raise ValueError('Original workflow audit differs from native report')
        audit_hash = hashlib.sha256(audit_bytes).hexdigest()
        for key, path, directory in [('root', native, True), ('config', native / 'config', True),
                                     ('database', native / 'config/runtime.db', False)]:
            current = path.lstat()
            correct_type = stat.S_ISDIR if directory else stat.S_ISREG
            if (not correct_type(current.st_mode) or current.st_uid != os.geteuid()
                    or current.st_mode & (0o077 if directory else 0o022) or path.resolve(strict=True) != path
                    or report['audit']['physicalIdentity'][key] != {'dev': current.st_dev, 'ino': current.st_ino}):
                raise ValueError('Original workflow physical runtime was replaced')
    except Exception as error:
        errors.append({'workflowSemanticError': repr(error)})
    try:
        fresh_observer, fresh_qualification = q.load_observer(repo, args.cleanup_acceptance, args.cleanup_acceptance_sha256)
        fresh_ownership = q.load_owned_group_acceptance(args.ownership_acceptance, repo, fresh_observer, args.cleanup_acceptance_sha256)
        fresh = (result['inputsStable'] is True and result['inputs'] == q.source_identity(repo)
                 and result['bundle'] == q.bundle_identity(repo) and result['binarySha256'] == digest(binary)
                 and result['runnerSha256'] == args.qualified_runner_sha256
                 and digest(repo / 'scripts/native-quit-smoke/run.py') == args.qualified_runner_sha256
                 and wrapper_hash == digest(pathlib.Path(__file__).resolve())
                 and qualification.binding == fresh_qualification.binding
                 and result['runtime'] == fresh_observer.runtime_facts()
                 and result['ownershipAcceptance'] == ownership == fresh_ownership)
        if not fresh: raise ValueError('Workflow source/binary/bundle/runtime/acceptance pins changed')
    except Exception as error:
        errors.append({'workflowPinError': repr(error)})
    disposition = {'kind': 'unavailable', 'resourceComplete': False, 'deliveredSignals': False, 'diagnostics': result['errors']}
    try:
        disposition = workflow_cleanup_disposition(q, result, q.cleanup_audit(result), report_bytes)
    except Exception as error:
        errors.append({'workflowCleanupEvidenceError': repr(error)})
    retained = result['retainedExitObservationNs']
    ordinary_exit = (result['exitCode'] == 0 and type(retained) is int
                    and all(type(row.get('ns')) is int and row['ns'] > retained for row in result['signals']))
    accepted = disposition['resourceComplete'] and fresh and ordinary_exit and evidence is not None and not errors
    value = {'format': 1, 'profile': WORKFLOW_PROFILE, 'accepted': accepted,
             'workflowRunnerSha256': wrapper_hash, 'qualifiedSupervisorSha256': result['runnerSha256'],
             'qualifiedExecutionPath': str(root / 'execution.json'),
             'qualifiedExecutionSha256': digest(root / 'execution.json'),
             'cleanupDisposition': disposition, 'freshPinsVerified': fresh, 'ordinaryNativeExit': ordinary_exit,
             'quitNativeExitAndTimingApplicability': 'inapplicable to workflow semantics; preserved unchanged in qualified execution',
             'workflowAuditSha256': audit_hash, 'workflowEvidence': evidence, 'errors': errors,
             'cliExecution': False, 'credentialAccess': False, 'providerNetwork': False,
             'automaticScheduling': False, 'realPersonBehavior': False, 'packagedAcceptance': False}
    q.write_json(root / 'workflow-execution.json', value)
    print(json.dumps({'accepted': accepted, 'directory': str(root),
                      'qualifiedExecution': str(root / 'execution.json'),
                      'workflowExecution': str(root / 'workflow-execution.json')}), flush=True)
    raise SystemExit(0 if accepted else 2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True, type=pathlib.Path)
    parser.add_argument('--binary', required=True, type=pathlib.Path)
    parser.add_argument('--output-parent', default=pathlib.Path('/private/tmp'), type=pathlib.Path)
    parser.add_argument('--profile', choices=['read-only', 'settings-metadata', 'credential-metadata', 'credential-public', 'managed-action-allow', 'managed-action-stop', 'managed-action-window', WORKFLOW_PROFILE], default='credential-metadata')
    parser.add_argument('--cleanup-acceptance', type=pathlib.Path)
    parser.add_argument('--cleanup-acceptance-sha256')
    parser.add_argument('--ownership-acceptance', type=pathlib.Path)
    parser.add_argument('--qualified-runner-sha256')
    args = parser.parse_args()
    repo, binary, parent = (p.resolve(strict=True) for p in (args.repo, args.binary, args.output_parent))
    if not binary.is_file() or binary.name != 'native-read-smoke':
        raise RuntimeError('supply the separately built native-read-smoke executable')
    if args.profile == WORKFLOW_PROFILE:
        return workflow_main(args, repo, binary, parent)
    if args.profile in MANAGED_PROFILES:
        return managed_main(args, repo, binary, parent)
    before = inputs(repo)
    binary_hash = digest(binary)
    smoke_config_hash = digest(repo / 'src-tauri/native-read-smoke/tauri.conf.json')
    root = pathlib.Path(tempfile.mkdtemp(prefix='cerebro-native-read-smoke-', dir=parent)).resolve()
    os.chmod(root, 0o700)
    # Preserve system identity; never repoint HOME. Application/CLI data is isolated
    # by the executable's feature-only managed resource and CLAUDE_CONFIG_DIR.
    allowed = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', '__CF_USER_TEXT_ENCODING']
    env = {key: os.environ[key] for key in allowed if key in os.environ}
    # These paths are created by the child after it validates this exact environment.
    env['PATH'] = str(root / 'bin')
    env['SHELL'] = str(root / 'bin/smoke-shell')
    env['CLAUDE_CONFIG_DIR'] = str(root / 'claude-config')
    command = [str(binary), str(root)]
    if args.profile in ['settings-metadata', 'credential-metadata', 'credential-public']:
        command.append('--' + args.profile)
    process = subprocess.Popen(command, cwd=repo, env=env,
                               start_new_session=True, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    poll = selectors.DefaultSelector()
    streams = {process.stdout: bytearray(), process.stderr: bytearray()}
    for stream in streams:
        os.set_blocking(stream.fileno(), False)
        poll.register(stream, selectors.EVENT_READ)
    deadline = time.monotonic() + 75
    failure = None
    try:
        while poll.get_map() or process.poll() is None:
            if time.monotonic() >= deadline:
                failure = 'native smoke runtime exceeded 75 seconds'
                break
            for key, _ in poll.select(0.1):
                block = os.read(key.fileobj.fileno(), 8192)
                if not block:
                    poll.unregister(key.fileobj)
                    continue
                target = streams[key.fileobj]
                if len(target) + len(block) > 256 * 1024:
                    failure = 'native output exceeded 256 KiB per stream'
                    break
                target.extend(block)
            if failure:
                break
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
        for stream, name in [(process.stdout, 'stdout.log'), (process.stderr, 'stderr.log')]:
            (root / name).write_bytes(streams[stream])
            os.chmod(root / name, 0o600)
            stream.close()
        poll.close()
    after = inputs(repo)
    path = root / 'report.json'
    report = None
    if path.exists():
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > 65536:
            failure = failure or 'native report is not a bounded regular file'
        else:
            report = json.loads(path.read_bytes())
    required = {
        'unstarted-run': 'unavailable',
        'live-original-origin-catalog': 'empty-measured-no-account-grants',
        'authenticated-managed-metadata-read': 'not-found',
        'ungranted-definition': 'not-found',
        'stopped-original-run': 'unavailable',
        'before-same-path-opening': 'catalog-available',
        'same-path-new-opening': 'unavailable',
        'before-opening-departure': 'catalog-available',
        'opening-A-B-A': 'unavailable',
        'before-store-replacement': 'catalog-available',
        'same-id-store-inode-replaced': 'unavailable',
        'before-native-window-destroy': 'catalog-available',
        'destroyed-native-owner': 'unavailable',
    }
    if args.profile == 'settings-metadata':
        required = {
            'settings-before-open': 'all-four-unavailable',
            'settings-initial-list': 'empty-measured',
            'settings-invalid-selection': 'unsupported-invalid-unchanged',
            'settings-add-metadata': 'sign-in-required-no-credential',
            'settings-point-and-list': 'exact-row',
            'settings-invalid-cursor': 'invalid-unchanged',
            'settings-stale-disable': 'stale-unchanged',
            'settings-disable': 'disabled-no-cleanup-required',
            'settings-replayed-disable': 'stale-unchanged',
            'settings-after-stop': 'same-app-account',
            'settings-after-opening-aba': 'same-app-account',
            'settings-before-origin-alias': 'exact-disabled-row',
            'settings-origin-alias': 'all-four-unavailable',
            'settings-original-origin-restored': 'exact-disabled-row',
            'settings-destroyed-window': 'all-four-unavailable',
            'settings-final-storage-audit': 'one-metadata-zero-acquisition-secret-cleanup-grants',
        }
    if args.profile == 'credential-metadata':
        required = {'credential-before-open': 'all-three-unavailable', 'credential-invalid-selection': 'exact-refusals-unchanged', 'credential-wrong-window': 'all-three-unavailable', 'credential-begin': 'pending-original-owner', 'credential-poll': 'exact-pending', 'credential-unavailable-worker': 'failed-unavailable-no-credential', 'credential-terminal-cancel': 'idempotent-no-revision-change', 'credential-second-begin': 'new-exact-pending', 'credential-cancel': 'durable-cancelled', 'credential-late-worker': 'cancel-preserved-no-resurrection', 'credential-disabled': 'disabled-no-secret-or-effect-authority', 'credential-runtime-replaced': 'all-three-unavailable', 'credential-runtime-restored': 'original-owner-stays-retired', 'credential-destroyed-window': 'all-three-unavailable', 'credential-final-storage-audit': 'one-connection-two-terminal-attempts-zero-secrets-cleanup-grants'}
    if args.profile == 'credential-metadata':
        required.update({
            'credential-route-dispatch-controls': 'known-and-unknown-distinct',
            'credential-route-before-open': 'all-three-domain-unavailable-not-unknown',
            'credential-route-wrong-window': 'native-window-wins-over-wire-selectors',
            'credential-route-current-vault': 'original-app-owner-across-vault-switch',
        })
    if args.profile == 'credential-public':
        required = {
            'public-bridge-dispatch-controls': 'known-and-unknown-distinct',
            'public-bridge-before-open': 'all-three-domain-unavailable-not-unknown',
            'public-bridge-invalid-selection': 'domain-refusal-no-attempt',
            'public-bridge-wrong-window': 'native-window-wins-over-wire-selectors',
            'public-bridge-owned-begin': 'pending-transferred-to-owned-worker',
            'public-bridge-unavailable-settlement': 'one-terminal-attempt-zero-credential-backend',
            'public-bridge-terminal-vault-switch': 'exact-original-app-attempt-idempotent-cancel',
            'public-bridge-storage-audit': 'one-selection-one-terminal-attempt-zero-secrets-cleanup-grants',
            'public-bridge-retired-runtime': 'original-owner-retired-no-reopen',
        }
    observed = {} if report is None else {x['name']: x['observed'] for x in report.get('cases', [])}
    if before != after or binary_hash != digest(binary) or smoke_config_hash != digest(repo / 'src-tauri/native-read-smoke/tauri.conf.json'):
        failure = failure or 'reviewed input/binary bytes changed during capture'
    if report is None or not report.get('passed') or process.returncode != 0 or observed != required or len(report.get('cases', [])) != len(required):
        failure = failure or 'native observations did not satisfy all required cases'
    if report is not None:
        compiled = report.get('compiledInputs', {})
        for key in ['aggregateDigest', 'fileCount', 'totalBytes']:
            if compiled.get(key) != before.get(key):
                failure = failure or 'compiled native producer input identity differs'
        if compiled.get('smokeConfigSha256') != smoke_config_hash:
            failure = failure or 'compiled smoke config identity differs'
    metadata_evidence = None
    if args.profile == 'settings-metadata':
        try:
            if report is None:
                raise RuntimeError('metadata native report is missing')
            metadata_evidence = settings_evidence(root, report)
        except (OSError, ValueError, TypeError, KeyError, RuntimeError):
            failure = failure or 'metadata profile claims, restoration or storage audit failed'
    credential_metadata = None
    if args.profile == 'credential-metadata':
        try:
            if report is None:
                raise RuntimeError('credential native report missing')
            credential_metadata = credential_evidence(root, report)
        except (OSError, ValueError, TypeError, KeyError, RuntimeError):
            failure = failure or 'credential profile claims, restoration or audit failed'
    public_bridge = None
    if args.profile == 'credential-public':
        try:
            if report is None:
                raise RuntimeError('public credential bridge native report missing')
            public_bridge = public_bridge_evidence(root, report)
        except (OSError, ValueError, TypeError, KeyError, RuntimeError):
            failure = failure or 'public credential bridge claims or audit failed'
    evidence = {'format': 1, 'runnerSha256': digest(pathlib.Path(__file__).resolve()), 'binarySha256': binary_hash, 'producerInputsBefore': before,
                'producerInputsAfter': after, 'exitCode': process.returncode,
                'reportSha256': digest(path) if path.is_file() else None,
                'passed': failure is None, 'failure': failure,
                'evidenceDirectory': str(root), 'providerOrAccountActivity': False,
                'realCliAcceptance': False, 'fullPackagedAcceptance': False}
    if args.profile == 'settings-metadata':
        observed_writes = None if report is None else report.get('claims', {}).get('disposableAccountMetadataWrites')
        evidence.update({'format': 2, 'profile': 'settings-metadata',
                         'providerOrAccountActivity': observed_writes,
                         'disposableAccountMetadataWrites': observed_writes,
                         'credentialAccess': False, 'providerNetwork': False,
                         'grantsOrEffectsEnabled': False, 'metadataEvidence': metadata_evidence})
    if args.profile == 'credential-metadata':
        writes = None if report is None else report.get('claims', {}).get('disposableAccountMetadataWrites')
        evidence.update({'format': 4, 'profile': 'credential-metadata', 'providerOrAccountActivity': writes, 'disposableAccountMetadataWrites': writes, 'credentialAccess': False, 'providerNetwork': False, 'keychainAccess': False, 'usableConnection': False, 'credentialMetadataEvidence': credential_metadata})
    if args.profile == 'credential-public':
        writes = None if report is None else report.get('claims', {}).get('disposableAccountMetadataWrites')
        evidence.update({'format': 1, 'profile': 'credential-public', 'providerOrAccountActivity': writes,
                         'disposableAccountMetadataWrites': writes, 'credentialAccess': False,
                         'providerNetwork': False, 'keychainAccess': False, 'usableConnection': False,
                         'publicCredentialBridgeEvidence': public_bridge})
    (root / 'execution.json').write_text(json.dumps(evidence, indent=2) + '\n')
    os.chmod(root / 'execution.json', 0o600)
    print(json.dumps({'passed': failure is None, 'directory': str(root), 'failure': failure}))
    raise SystemExit(0 if failure is None else 2)


if __name__ == '__main__':
    main()
