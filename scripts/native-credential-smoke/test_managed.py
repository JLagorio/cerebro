"""Pure receipt-boundary checks; no child, native window, reader or qualification factory."""
import copy, importlib.util, pathlib, unittest
HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('managed_credential_runner', HERE / 'run.py')
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)
qspec = importlib.util.spec_from_file_location('unchanged_qualified_runner', HERE.parent / 'native-quit-smoke' / 'run.py')
q = importlib.util.module_from_spec(qspec); qspec.loader.exec_module(q)


def fixture():
    owner = {'pid': 701, 'uid': 501, 'ppid': 700, 'pgid': 701, 'sid': 701,
             'start': [1800000000, 12], 'key': '701:1800000000:12'}
    launch = {'format': 1, 'observer': 'native-owned-managed-cli-launch',
              'profile': 'managed-action', 'scenario': 'allow', 'nativePid': 701, 'run': 0,
              'child': {'pid': 702, 'parent_pid': 701, 'group_pid': 702, 'uid': 501,
                        'start_seconds': 1800000001, 'start_micros': 21}}
    return launch, owner


class OriginalManagedChildBinding(unittest.TestCase):
    def test_first_actual_zero_run_joins_only_owning_launch_and_qualified_parent(self):
        launch, owner = fixture()
        self.assertEqual(r.managed_launch_binding(launch, owner, 'managed-action-allow'),
                         {'pid': 702, 'start': [1800000001, 21], 'ppid': 701, 'pgid': 702, 'uid': 501})

    def test_all_three_fixed_profiles_join_without_creating_new_child_authority(self):
        for scenario in ('allow', 'stop', 'window'):
            with self.subTest(scenario=scenario):
                launch, owner = fixture(); launch['scenario'] = scenario
                self.assertEqual(r.managed_launch_binding(launch, owner, 'managed-action-' + scenario)['pid'], 702)

    def test_missing_malformed_or_unrelated_launch_is_refused(self):
        launch, owner = fixture()
        changes = [('format', True), ('format', 2), ('observer', 'sampled-pid'),
                   ('profile', 'read-only'), ('scenario', 'stop'), ('nativePid', 700),
                   ('nativePid', True), ('run', None), ('run', True), ('run', 1)]
        bad = [None, [], {}, dict(launch, extra='unreviewed')]
        for key, value in changes:
            row = copy.deepcopy(launch); row[key] = value; bad.append(row)
        for row in bad:
            with self.subTest(launch=row), self.assertRaises(ValueError):
                r.managed_launch_binding(row, owner, 'managed-action-allow')
        for profile in ('managed-action-other', 'read-only', None):
            with self.subTest(profile=profile), self.assertRaises(ValueError):
                r.managed_launch_binding(launch, owner, profile)

    def test_child_pid_parent_group_uid_start_and_exact_shape_are_checked(self):
        launch, owner = fixture()
        changes = [('pid', 701), ('pid', 0), ('pid', -1), ('pid', True), ('pid', 2**31),
                   ('parent_pid', 700), ('group_pid', 701), ('uid', 502),
                   ('start_seconds', 0), ('start_seconds', -1), ('start_seconds', True),
                   ('start_seconds', 2**64), ('start_micros', -1), ('start_micros', 1000000),
                   ('start_micros', True)]
        for key, value in changes:
            row = copy.deepcopy(launch); row['child'][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                r.managed_launch_binding(row, owner, 'managed-action-allow')
        for child in (None, {}, dict(launch['child'], arbitrary='pid')):
            row = dict(launch, child=child)
            with self.subTest(child=child), self.assertRaises(ValueError):
                r.managed_launch_binding(row, owner, 'managed-action-allow')

    def test_absent_or_malformed_qualified_parent_is_not_an_owning_launch(self):
        launch, owner = fixture()
        for bad in (None, {}, dict(owner, pid=True), dict(owner, pid=702),
                    dict(owner, uid=True), dict(owner, uid=-1)):
            with self.subTest(owner=bad), self.assertRaises(ValueError):
                r.managed_launch_binding(launch, bad, 'managed-action-allow')

    def test_unchanged_qualified_quit_classifiers_are_total_for_managed_cases(self):
        # No fake accepted qualification is constructed. These are pure existing
        # classifiers; lifecycle still runs before their inapplicable quit result.
        for case in ('managed-action-allow', 'managed-action-stop', 'managed-action-window'):
            with self.subTest(case=case):
                cause = q.classify_exit(b'', {'case': case, 'pid': 701, 'ownershipBound': True},
                                        {'profile': 'managed-action'}, 100, 0, [])
                self.assertEqual(cause['cause'], 'unknown')
                self.assertFalse(q.timing_evidence(case, cause, {'profile': 'managed-action'})['accepted'])




def managed_observational_fixture():
    fixture_spec=importlib.util.spec_from_file_location('cleanup_protocol_fixture',HERE.parent/'native-quit-smoke'/'test_run.py')
    fixture_module=importlib.util.module_from_spec(fixture_spec);fixture_spec.loader.exec_module(fixture_module)
    value,audit=fixture_module.observed_cleanup_fixture()
    launch_hash='a'*64
    names=[('managed-original-publication','actual-installed-original-run'),('managed-first-run-zero','zero-is-an-actual-original-handle'),('managed-access-held','original-run-null-correlation-zero-effects'),('managed-effect-held','original-interaction-zero-provider-before-answer'),('managed-person-answer','finite-original-answered-no-resumed-handle'),('managed-completed-effect','one-original-attempt-receipt-and-canonical-output')]
    report={'format':1,'observer':'native-original-attended-managed-action-smoke','profile':'managed-action','scenario':'allow','nativePid':value['owned']['pid'],'childLaunchSha256':launch_hash,'compiledInputs':value['inputs'],'passed':True,
            'claims':{'actualMacosWindow':True,'actualOriginalPublication':True,'actualLoopbackManagedCall':True,'actualPersonAnswerCommand':True,'fixedFakeProviderOnly':True,'credentialAccess':False,'providerNetwork':False,'realAccount':False,'realClaudeCode':False,'realPersonBehavior':False,'packagedSigningAcceptance':False},
            'cases':[{'name':name,'observed':observed} for name,observed in names],
            'audit':{'runs':1,'native_runs':1,'connections':1,'grants':1,'invocations':1,'attempts':1,'receipts':1,'provider_entries':1,'state':'succeeded','invocation':'b'*32}}
    raw=r.json.dumps(report).encode();value['nativeReportSha256']=r.hashlib.sha256(raw).hexdigest()
    return value,audit,report,raw,launch_hash


class ManagedObservedCleanup(unittest.TestCase):
    def test_original_positive_report_can_join_observed_cleanup_without_signal_delivery(self):
        value,audit,report,raw,launch_hash=managed_observational_fixture()
        result=r.managed_cleanup_disposition(q,value,audit,raw,'managed-action-allow',launch_hash)
        self.assertTrue(result['resourceComplete']);self.assertFalse(result['deliveredSignals']);self.assertEqual(result['diagnostics'],value['errors'])
    def test_no_generic_report_or_caller_allow_flag_can_bypass_original_native_positive(self):
        value,audit,report,raw,launch_hash=managed_observational_fixture()
        with self.assertRaises(ValueError):r.managed_cleanup_disposition(q,value,audit,raw+b' ','managed-action-allow',launch_hash)
        for field,replacement in [('passed',False),('nativePid',999),('compiledInputs',{}),('childLaunchSha256','c'*64)]:
            with self.subTest(field=field):
                value,audit,report,raw,launch_hash=managed_observational_fixture();report[field]=replacement
                raw=r.json.dumps(report).encode();value['nativeReportSha256']=r.hashlib.sha256(raw).hexdigest()
                with self.assertRaises(ValueError):r.managed_cleanup_disposition(q,value,audit,raw,'managed-action-allow',launch_hash)
        value,audit,report,raw,launch_hash=managed_observational_fixture();value['groupAbsent']=False
        self.assertFalse(r.managed_cleanup_disposition(q,value,audit,raw,'managed-action-allow',launch_hash)['resourceComplete'])

if __name__ == '__main__': unittest.main()
