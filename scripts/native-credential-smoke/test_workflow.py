"""Pure finite workflow evidence controls. No native process or authority construction."""
import copy, hashlib, importlib.util, json, pathlib, unittest
HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('workflow_existing_runner', HERE / 'run.py')
r = importlib.util.module_from_spec(spec); spec.loader.exec_module(r)


def fixture():
    context = {'vaultId': 'a' * 32, 'storeUuid': 'store-original'}
    first = {'version': {'workflowId': 'native-pinned-journey', 'definitionHash': '1' * 64}, 'revision': 1}
    second = {'version': {'workflowId': 'native-pinned-journey', 'definitionHash': '2' * 64}, 'revision': 2}
    output = hashlib.sha256(b'{"answer":"answered","version":"v1"}').hexdigest()
    empty = {'readPrefixes': [], 'queryRecords': False, 'accounts': []}
    counts = {'runs': 1, 'nativeRuns': 1, 'workflowRuns': 1, 'origins': 1, 'steps': 2,
              'attempts': 2, 'waits': 1, 'values': 0, 'connections': 0, 'grants': 0,
              'invocations': 0, 'actionAttempts': 0}
    cases = [
        ('workflow-v1-published', 'actual-save-publish-original-opening'),
        ('workflow-v1-waiting', 'actual-owned-worker-original-continuation'),
        ('workflow-v2-published', 'new-publication-original-wait-unchanged'),
        ('workflow-unpublished', 'revisioned-tombstone-pinned-v1-wait-preserved'),
        ('workflow-start-replayed', 'same-key-original-run-no-new-admission'),
        ('workflow-explicit-continue', 'original-revision-epoch-and-wait'),
        ('workflow-v1-result', 'v1-answer-digest-completed-content-not-retained'),
        ('workflow-final-audit', 'one-original-run-zero-effects-zero-value-bodies'),
    ]
    owner = {'pid': 701}
    inputs = {'scope': 'cerebro-native-producer-inputs-v1', 'aggregateDigest': 'c' * 64,
              'fileCount': 1138, 'totalBytes': 40000000, 'smokeConfigSha256': 'd' * 64}
    report = {'format': 1, 'observer': 'native-original-pinned-workflow-smoke', 'profile': 'workflow-pinned',
              'nativePid': 701, 'passed': True, 'failedStage': None, 'compiledInputs': inputs,
              'claims': {'actualMacosWindow': True, 'actualInjectedCommand': True, 'actualWorkflowCommands': True,
                         'actualOwnedWorker': True, 'originalPinnedVersion': True, 'completedDetailRetention': 'off',
                         'cliExecution': False, 'credentialAccess': False, 'providerNetwork': False,
                         'accountAuthority': False, 'automaticScheduling': False, 'realPersonBehavior': False,
                         'packagedSigningAcceptance': False},
              'cases': [{'name': name, 'observed': observed} for name, observed in cases],
              'audit': {'context': context, 'first': first, 'second': second,
                        'unpublish': {'context': context, 'requestKey': '3' * 32, 'original': second,
                                      'publicationRevision': 3, 'replayed': False},
                        'expectedOutputDigest': output,
                        'physicalIdentity': {'root': {'dev': 1, 'ino': 10}, 'config': {'dev': 1, 'ino': 11},
                                             'database': {'dev': 1, 'ino': 12}},
                        'rows': {'runId': 'b' * 32, 'nativeRunId': 'c' * 32, 'vaultId': context['vaultId'],
                                 'storeUuid': context['storeUuid'], 'version': '1' * 64, 'originVersion': '1' * 64,
                                 'startKey': '1' * 32, 'state': 'succeeded', 'outputDigest': output,
                                 'continuationId': 'd' * 32, 'waitVersion': '1' * 64, 'waitState': 'consumed',
                                 'signalKey': '2' * 32, 'originalPermissions': copy.deepcopy(empty),
                                 'currentPermissions': copy.deepcopy(empty), 'counts': counts, 'reservedBytes': 0}}}
    return report, owner, inputs


class PinnedWorkflowEvidence(unittest.TestCase):
    def test_actual_finite_shape_joins_original_version_and_off_retention(self):
        report, owner, inputs = fixture()
        observed = r.workflow_evidence(report, owner, inputs)
        self.assertEqual(observed['firstVersion'], '1' * 64)
        self.assertEqual(observed['secondVersion'], '2' * 64)
        self.assertEqual(observed['runId'], 'b' * 32)
        self.assertEqual(observed['counts']['values'], 0)
        self.assertEqual(observed['completedDetailRetention'], 'off')
        self.assertIs(observed['credentialOrProviderOrCli'], False)

    def test_wrong_native_or_source_identity_and_false_success_are_refused(self):
        for field, value in [('nativePid', 702), ('nativePid', True), ('compiledInputs', {}), ('passed', False),
                             ('failedStage', 'workflow-result'), ('format', True), ('profile', 'other')]:
            report, owner, inputs = fixture(); report[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): r.workflow_evidence(report, owner, inputs)

    def test_missing_extra_reordered_or_changed_observations_are_refused(self):
        for change in ('missing', 'extra', 'reordered', 'changed'):
            report, owner, inputs = fixture()
            if change == 'missing': report['cases'].pop()
            elif change == 'extra': report['cases'].append(copy.deepcopy(report['cases'][-1]))
            elif change == 'reordered': report['cases'][0], report['cases'][1] = report['cases'][1], report['cases'][0]
            else: report['cases'][-1]['observed'] = 'fixture-claimed-success'
            with self.subTest(change=change), self.assertRaises(ValueError): r.workflow_evidence(report, owner, inputs)

    def test_version_scope_wait_and_request_substitution_are_refused(self):
        for field, value in [('version', '2' * 64), ('originVersion', '2' * 64), ('waitVersion', '2' * 64),
                             ('vaultId', 'f' * 32), ('storeUuid', 'other'), ('continuationId', ''),
                             ('startKey', '4' * 32), ('signalKey', '4' * 32), ('state', 'failed'),
                             ('waitState', 'pending'), ('outputDigest', 'f' * 64)]:
            report, owner, inputs = fixture(); report['audit']['rows'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): r.workflow_evidence(report, owner, inputs)
        report, owner, inputs = fixture(); report['audit']['second']['version']['definitionHash'] = '1' * 64
        with self.assertRaises(ValueError): r.workflow_evidence(report, owner, inputs)

    def test_extra_run_effect_grant_retained_value_or_reservation_is_refused(self):
        report, _, _ = fixture()
        for key in report['audit']['rows']['counts']:
            report, owner, inputs = fixture(); report['audit']['rows']['counts'][key] += 1
            with self.subTest(key=key), self.assertRaises(ValueError): r.workflow_evidence(report, owner, inputs)
        for value in (1, True):
            report, owner, inputs = fixture(); report['audit']['rows']['reservedBytes'] = value
            with self.subTest(reserved=value), self.assertRaises(ValueError): r.workflow_evidence(report, owner, inputs)
        report, owner, inputs = fixture(); report['audit']['rows']['counts']['runs'] = True
        with self.assertRaises(ValueError): r.workflow_evidence(report, owner, inputs)

    def test_permissions_retention_and_lifecycle_claim_widening_are_refused(self):
        for selection in ('originalPermissions', 'currentPermissions'):
            for key, value in [('readPrefixes', ['']), ('queryRecords', True), ('accounts', [{'account': 'unexpected'}])]:
                report, owner, inputs = fixture(); report['audit']['rows'][selection][key] = value
                with self.subTest(selection=selection, key=key), self.assertRaises(ValueError): r.workflow_evidence(report, owner, inputs)
        for key, value in [('completedDetailRetention', '90days'), ('cliExecution', True), ('providerNetwork', True),
                           ('actualOwnedWorker', False), ('packagedSigningAcceptance', True)]:
            report, owner, inputs = fixture(); report['claims'][key] = value
            with self.subTest(claim=key), self.assertRaises(ValueError): r.workflow_evidence(report, owner, inputs)

    def test_tombstone_and_original_physical_receipt_cannot_be_omitted(self):
        for key, value in [('publicationRevision', 2), ('replayed', True), ('requestKey', '4' * 32), ('context', {})]:
            report, owner, inputs = fixture(); report['audit']['unpublish'][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): r.workflow_evidence(report, owner, inputs)
        for value in ({}, None, {'root': {'dev': 1, 'ino': 1}}):
            report, owner, inputs = fixture(); report['audit']['physicalIdentity'] = value
            with self.subTest(identity=value), self.assertRaises(ValueError): r.workflow_evidence(report, owner, inputs)
        report, owner, inputs = fixture(); report['audit']['physicalIdentity']['database']['ino'] = 0
        with self.assertRaises(ValueError): r.workflow_evidence(report, owner, inputs)


if __name__ == '__main__': unittest.main()
