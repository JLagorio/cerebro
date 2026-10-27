"""Supervisor regressions only: disposable fixture children, no signing/Keychain."""
import errno
import importlib.util
import json
import os
import pathlib
import signal
import sys
import tempfile
import time
import unittest
from unittest import mock

MODULE_PATH = pathlib.Path(os.environ.get('CEREBRO_KEYCHAIN_PACKAGER_UNDER_TEST', pathlib.Path(__file__).with_name('package-and-run.py')))
spec = importlib.util.spec_from_file_location('keychain_package_supervisor', MODULE_PATH)
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class BoundedInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cerebro-keychain-supervisor-test-')
        self.root = pathlib.Path(self.temporary.name).resolve()

    def tearDown(self):
        self.temporary.cleanup()

    def executable_fixture(self, body):
        # The explicit executable imitates Node's argv boundary only. It does not
        # pretend to observe the real repository inventory or native acceptance.
        interpreter = pathlib.Path(sys.executable).resolve()
        self.assertNotIn(' ', str(interpreter), 'fixture shebang needs a plain absolute interpreter')
        path = self.root / 'selected-node-fixture'
        path.write_text('#!' + str(interpreter) + '\n' + body)
        path.chmod(0o700)
        return path

    def test_inventory_uses_explicit_child_with_scrubbed_environment_and_closed_stdin(self):
        node = self.executable_fixture('''import json, os, sys
assert sys.argv[1:5] == ['--import', 'tsx', '--input-type=module', '-e']
assert 'nativeInputIdentity(process.cwd())' in sys.argv[5]
assert sys.stdin.buffer.read() == b''
assert os.environ['PATH'] == '/usr/bin:/bin'
for name in ['NODE_OPTIONS', 'NODE_PATH', 'NODE_REPL_EXTERNAL_MODULE', 'DYLD_INSERT_LIBRARIES', 'LD_PRELOAD', 'UNRELATED_SENTINEL']:
    assert name not in os.environ, name
print(json.dumps({'version': 1, 'aggregateDigest': 'a' * 64, 'fileCount': 1, 'totalBytes': 12}))
''')
        hostile = {'NODE_OPTIONS': '--require=/never/load-this', 'NODE_PATH': '/never/search-this',
            'NODE_REPL_EXTERNAL_MODULE': '/never/repl', 'DYLD_INSERT_LIBRARIES': '/never/load',
            'LD_PRELOAD': '/never/load', 'UNRELATED_SENTINEL': 'synthetic-only'}
        with mock.patch.dict(os.environ, hostile):
            selected = supervisor.selected_node(node)
            observed = supervisor.inventory_inputs(self.root, selected)
            self.assertEqual(os.environ['NODE_OPTIONS'], hostile['NODE_OPTIONS'], 'parent env must not be mutated')
        self.assertEqual(observed, {'version': 1, 'aggregateDigest': 'a' * 64, 'fileCount': 1, 'totalBytes': 12})

    def test_inventory_rejects_excess_output_through_actual_bounded_child(self):
        node = self.executable_fixture("import os, time\nos.write(1, b'x' * 8192)\ntime.sleep(30)\n")
        with self.assertRaisesRegex(RuntimeError, 'bounded-inventory-child-failed'):
            supervisor.inventory_inputs(self.root, supervisor.selected_node(node))

    def test_inventory_rejects_nonzero_or_invalid_result(self):
        for body in ['raise SystemExit(9)\n', "print('{}')\n", "print('not-json')\n"]:
            with self.subTest(body=body):
                node = self.executable_fixture(body)
                with self.assertRaises((RuntimeError, ValueError)):
                    supervisor.inventory_inputs(self.root, supervisor.selected_node(node))

    def test_node_selection_does_not_resolve_a_bare_path_command(self):
        with self.assertRaisesRegex(RuntimeError, 'explicit-absolute'):
            supervisor.selected_node(pathlib.Path('node'))

    def test_capture_has_independent_stdout_and_stderr_stream_caps(self):
        for descriptor in [1, 2]:
            with self.subTest(descriptor=descriptor):
                result, stdout, stderr = supervisor.capture(
                    [sys.executable, '-c', f'import os,time; os.write({descriptor}, b"x" * 100000); time.sleep(30)'],
                    self.root, supervisor.child_environment(), 3, 4096, stderr_cap=1024)
                self.assertEqual(result['failure'], 'output-cap')
                self.assertIsNotNone(result['exitCode'], 'direct child must be reaped')
                self.assertLessEqual(len(stdout), 4096)
                self.assertLessEqual(len(stderr), 1024)

    def assert_group_gone(self, group):
        deadline = time.monotonic() + 3
        last_probe = 'not observed'
        while time.monotonic() < deadline:
            try:
                os.killpg(group, 0)
                last_probe = 'present'
            except ProcessLookupError:
                return
            except PermissionError:
                # Group teardown can briefly return EPERM on this host. It is
                # inconclusive, never absence; only a later ESRCH can pass.
                last_probe = 'EPERM (inconclusive)'
            time.sleep(0.02)
        self.fail('owned descendant group absence not established before deadline: ' + last_probe)

    def test_group_probe_requires_esrch_after_transient_eperm(self):
        with mock.patch.object(os, 'killpg', side_effect=[
            PermissionError(errno.EPERM, 'synthetic'),
            ProcessLookupError(errno.ESRCH, 'synthetic'),
        ]) as probe, mock.patch.object(time, 'monotonic', side_effect=[0, 0, 0.02]), mock.patch.object(time, 'sleep'):
            self.assert_group_gone(12345)
        self.assertEqual(probe.call_args_list, [mock.call(12345, 0), mock.call(12345, 0)])

    def test_group_probe_rejects_persistent_eperm_or_present_group(self):
        for observed in [PermissionError(errno.EPERM, 'synthetic'), None]:
            with self.subTest(observed=type(observed).__name__):
                with mock.patch.object(os, 'killpg', side_effect=[observed, observed]) as probe, mock.patch.object(time, 'monotonic', side_effect=[0, 0, 1, 3]), mock.patch.object(time, 'sleep'):
                    with self.assertRaisesRegex(AssertionError, 'absence not established before deadline'):
                        self.assert_group_gone(12345)
                self.assertEqual(probe.call_args_list, [mock.call(12345, 0), mock.call(12345, 0)])

    def stop_fixture_after_assertions(self, stop):
        original_failure = sys.exception()
        try:
            # A private fixture-local stop request cannot target a recycled PID.
            # It runs after all absence assertions, so cannot establish success.
            with stop.open('x') as file:
                file.write('stop\n')
        except OSError as error:
            if original_failure is None:
                raise
            original_failure.add_note(f'fixture stop-file cleanup failed: {type(error).__name__}, errno={error.errno}')

    def test_fixture_cleanup_preserves_original_failure(self):
        original = AssertionError('original group-absence failure')
        with mock.patch.object(pathlib.Path, 'open', side_effect=PermissionError(errno.EPERM, 'synthetic')):
            with self.assertRaises(AssertionError) as caught:
                try:
                    raise original
                finally:
                    self.stop_fixture_after_assertions(self.root / 'never-created.stop')
        self.assertIs(caught.exception, original)
        self.assertIn('fixture stop-file cleanup failed', original.__notes__[0])

    def exited_leader_with_pipe_holder(self, overflow):
        marker = self.root / ('overflow-group.json' if overflow else 'deadline-group.json')
        code = '''import json, os, pathlib, signal, sys, time
marker = pathlib.Path(sys.argv[1])
parent = os.getpid()
child = os.fork()
if child == 0:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while os.getppid() == parent:
        time.sleep(0.001)
    if sys.argv[2] == 'overflow':
        os.write(1, b'x' * 8192)
    # No success timer: only the test's finally block requests fixture cleanup.
    while marker.parent.exists() and not marker.with_suffix('.stop').exists():
        time.sleep(0.02)
else:
    marker.write_text(json.dumps({'leader': parent, 'group': os.getpgrp(), 'child': child}))
    os._exit(0)
'''
        try:
            result, stdout, stderr = supervisor.capture(
                [sys.executable, '-c', code, str(marker), 'overflow' if overflow else 'idle'],
                self.root, {'PATH': '/usr/bin:/bin'}, 0.4, 4096)
            owned = json.loads(marker.read_text())
            self.assertEqual(owned['leader'], owned['group'])
            self.assertNotEqual(owned['group'], os.getpgrp())
            self.assertEqual(result['exitCode'], 0, 'the leader really exited before pipe completion')
            self.assertEqual(result['failure'], 'output-cap' if overflow else 'deadline')
            self.assertLessEqual(len(stdout), 4096)
            self.assertLessEqual(len(stderr), 4096)
            self.assert_group_gone(owned['group'])
        finally:
            self.stop_fixture_after_assertions(marker.with_suffix('.stop'))

    def assert_capture_keeps_leader_until_last_signal(self, body, seconds, expected_failure):
        real_popen = supervisor.subprocess.Popen
        real_killpg = os.killpg
        started = []
        observations = []
        read_only_observations = []

        def start(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            started.append(process)
            return process

        def observe_group_signal(group, sig):
            process = started[0]
            if group == process.pid:
                try:
                    # Real child waitability, observed without releasing it.
                    os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                    retained = True
                except ChildProcessError:
                    retained = False
                if sig == 0:
                    read_only_observations.append(retained)
                else:
                    observations.append((sig, retained))
            return real_killpg(group, sig)

        with mock.patch.object(supervisor.subprocess, 'Popen', side_effect=start), mock.patch.object(os, 'killpg', side_effect=observe_group_signal):
            result, stdout, stderr = supervisor.capture(
                [sys.executable, '-c', body], self.root, {'PATH': '/usr/bin:/bin'}, seconds, 4096)
        self.assertEqual(len(started), 1)
        self.assertEqual(result['failure'], expected_failure)
        self.assertIsNotNone(result['exitCode'], 'the real direct child must eventually be reaped')
        self.assertEqual((stdout, stderr), (b'', b''))
        self.assertEqual(observations, [(signal.SIGTERM, True), (signal.SIGKILL, True)],
            'every group signal must precede release of the original waitable child identity')
        self.assertTrue(read_only_observations, 'cleanup must observe group absence after reap')
        self.assertEqual(read_only_observations, [False] * len(read_only_observations),
            'read-only group probes must follow release of the original child')
        with self.assertRaises(ChildProcessError):
            os.waitid(os.P_PID, started[0].pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)

    def test_normal_completion_keeps_leader_identity_until_final_group_signal(self):
        self.assert_capture_keeps_leader_until_last_signal('raise SystemExit(0)', 3, None)

    def test_term_completion_keeps_leader_identity_until_final_group_signal(self):
        self.assert_capture_keeps_leader_until_last_signal('import time; time.sleep(30)', 0.2, 'deadline')

    def capture_with_controlled_absence(self, probe_mode, body='raise SystemExit(0)', reap_elapsed=0):
        # Real Popen/streams/owned signals/reap; only errno/probe outcomes and
        # elapsed final-budget time are injected. No fake ownership constructor.
        real_popen = supervisor.subprocess.Popen
        real_killpg = os.killpg
        real_monotonic = time.monotonic
        started = []
        signals = []
        wait_timeouts = []
        zero_probes = []
        elapsed = [0]

        def start(*args, **kwargs):
            process = real_popen(*args, **kwargs)
            real_wait = process.wait

            def wait(timeout=None):
                wait_timeouts.append(timeout)
                result = real_wait(timeout=timeout)
                elapsed[0] += reap_elapsed
                return result

            process.wait = wait
            started.append(process)
            return process

        def group_signal(group, sig):
            self.assertEqual(group, started[0].pid)
            if sig != 0:
                # Refuse to forward a destructive signal if the real child is
                # no longer ours. The unchanged ownership tests also observe it.
                os.waitid(os.P_PID, group, os.WEXITED | os.WNOHANG | os.WNOWAIT)
                signals.append(sig)
                try:
                    real_killpg(group, sig)
                except (PermissionError, ProcessLookupError):
                    pass
                raise PermissionError(errno.EPERM, 'injected signal result')
            with self.assertRaises(ChildProcessError):
                os.waitid(os.P_PID, group, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            zero_probes.append(group)
            elapsed[0] += 0.25
            if probe_mode == 'transient' and len(zero_probes) > 1:
                raise ProcessLookupError(errno.ESRCH, 'injected absence observation')
            if probe_mode != 'present':
                raise PermissionError(errno.EPERM, 'injected inconclusive observation')
            return None

        with mock.patch.object(supervisor.subprocess, 'Popen', side_effect=start), mock.patch.object(os, 'killpg', side_effect=group_signal), mock.patch.object(time, 'monotonic', side_effect=lambda: real_monotonic() + elapsed[0]):
            result, _, _ = supervisor.capture([sys.executable, '-c', body], self.root,
                {'PATH': '/usr/bin:/bin'}, 3, 4096)
        self.assertEqual(signals, [signal.SIGTERM, signal.SIGKILL])
        self.assertEqual(len(wait_timeouts), 1)
        self.assertGreater(wait_timeouts[0], 0)
        self.assertLessEqual(wait_timeouts[0], 5)
        self.assertTrue(zero_probes)
        if reap_elapsed == 4.5:
            self.assertLessEqual(len(zero_probes), 2,
                'absence must consume the remainder of the five-second reap budget')
        with self.assertRaises(ChildProcessError):
            os.waitid(os.P_PID, started[0].pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        self.assertEqual(result['cleanup']['signalErrors'], [
            {'signal': int(signal.SIGTERM), 'errno': errno.EPERM},
            {'signal': int(signal.SIGKILL), 'errno': errno.EPERM},
        ])
        self.assertIs(result['cleanup']['reaped'], True)
        self.assertIsNone(result['cleanup']['observationErrno'])
        return result

    def test_cleanup_signal_errors_require_later_esrch_for_success(self):
        result = self.capture_with_controlled_absence('transient')
        self.assertIsNone(result['failure'])
        self.assertEqual(result['exitCode'], 0)
        self.assertIs(result['cleanup']['groupAbsent'], True)
        self.assertEqual(result['cleanup']['lastGroupProbe'], 'ESRCH')

    def test_cleanup_persistent_eperm_or_presence_fails_within_shared_budget(self):
        for probe_mode in ['EPERM', 'present']:
            with self.subTest(probe_mode=probe_mode):
                result = self.capture_with_controlled_absence(probe_mode, reap_elapsed=4.5)
                self.assertEqual(result['failure'], 'cleanup-unavailable')
                self.assertIsNone(result['cleanup']['groupAbsent'])
                self.assertEqual(result['cleanup']['lastGroupProbe'], probe_mode)

    def test_cleanup_unavailable_preserves_original_output_cap_failure(self):
        result = self.capture_with_controlled_absence('EPERM',
            body="import os; os.write(1, b'x' * 8192)", reap_elapsed=4.5)
        self.assertEqual(result['failure'], 'output-cap')
        self.assertIsNone(result['cleanup']['groupAbsent'])
        self.assertEqual(result['cleanup']['lastGroupProbe'], 'EPERM')

    def test_deadline_retires_pipe_holder_after_direct_child_exits(self):
        self.exited_leader_with_pipe_holder(False)

    def test_overflow_retires_pipe_holder_after_direct_child_exits(self):
        self.exited_leader_with_pipe_holder(True)


if __name__ == '__main__':
    unittest.main()
