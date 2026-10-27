"""Source-only pure-validator tests. Root executes these; fixture worker does not."""
import errno, importlib.util, json, pathlib, signal, unittest
spec=importlib.util.spec_from_file_location('native_quit_runner',pathlib.Path(__file__).with_name('run.py'))
r=importlib.util.module_from_spec(spec); spec.loader.exec_module(r)


def controls(events):
    return [{'ordinal':i+1,'ms':float(i*100),'pid':401,'event':name,'data':data}
            for i,(name,data) in enumerate(events)]


def fixture(kind='deadline'):
    ctx={'pid':401,'binary':'/private/tmp/native-read-smoke','root':'/private/tmp/owned',
         'case':'hung-webview','inputs':{'scope':r.SCOPE},'ownershipBound':True}
    events=[('case-start',{'binary':ctx['binary'],'root':ctx['root'],'case':ctx['case'],'compiledInputs':ctx['inputs']}),
            ('request-before',{'call':1}),('emitted-request',{'call':1,'attempt':1}),('request-after',{'call':1})]
    warning=r.DEADLINE
    if kind=='finish': events += [('finish-dispatch',{}),('finish-result',{'ok':True,'error':None})]
    if kind=='complete': events += [('fixture-complete-intent',{})]
    rows=controls(events)
    lines=[json.dumps({'level':'info','target':r.CONTROL_TARGET,'msg':json.dumps(x)}) for x in rows]
    if kind=='deadline': lines.append(json.dumps({'level':'warn','target':r.QUIT_TARGET,'msg':warning}))
    rows+=controls([])
    last={'ordinal':len(rows)+1,'ms':6000.0,'pid':401,'event':'exit','data':{}}; rows.append(last)
    lines.append(json.dumps({'level':'info','target':r.CONTROL_TARGET,'msg':json.dumps(last)}))
    report={'traceBroken':False,'trace':rows,'nativePid':401,'compiledInputs':ctx['inputs']}
    return ('\n'.join(lines)+'\n').encode(),ctx,report


def classify(data=None,**overrides):
    raw,ctx,report=fixture() if data is None else data
    args=dict(retained_exit_ns=8_000_000_000,reap_status=0,signals=[],eof=True,capped=False)
    args.update(overrides)
    return r.classify_exit(raw,ctx,report,**args)


class CauseTests(unittest.TestCase):
    def test_exact_warning_and_owned_exit(self):
        value=classify(); self.assertEqual(value['cause'],'native_deadline'); self.assertEqual(value['attempt'],1)
    def test_emit_failure_is_not_deadline(self):
        raw,ctx,report=fixture()
        raw=raw.replace(r.DEADLINE.encode(),b'the quit request could not reach the webview (fixture), so Cerebro quits now')
        self.assertEqual(classify((raw,ctx,report))['cause'],'emit_failure')
    def test_timer_spawn_failure_is_not_deadline(self):
        raw,ctx,report=fixture()
        raw=raw.replace(r.DEADLINE.encode(),b'the quit deadline could not start (fixture), so Cerebro quits now')
        self.assertEqual(classify((raw,ctx,report))['cause'],'timer_spawn_failure')
    def test_wrong_target_cannot_be_positive(self):
        raw,ctx,report=fixture(); raw=raw.replace(r.QUIT_TARGET.encode(),b'frontend')
        self.assertEqual(classify((raw,ctx,report))['cause'],'unknown')
    def test_substring_cannot_be_positive(self):
        raw,ctx,report=fixture(); raw=raw.replace(r.DEADLINE.encode(),('prefix '+r.DEADLINE).encode())
        self.assertEqual(classify((raw,ctx,report))['cause'],'unknown')
    def test_missing_warning(self):
        raw,ctx,report=fixture(); raw=b'\n'.join(x for x in raw.splitlines() if r.QUIT_TARGET.encode() not in x)+b'\n'
        self.assertEqual(classify((raw,ctx,report))['cause'],'unknown')
    def test_truncation_and_pipe_non_eof(self):
        self.assertEqual(classify(eof=False)['cause'],'unknown')
        self.assertEqual(classify(capped=True)['cause'],'unknown')
        raw,ctx,report=fixture(); self.assertEqual(classify((raw[:-2],ctx,report))['cause'],'unknown')
    def test_finish_requires_actual_ok(self):
        self.assertEqual(classify(fixture('finish'))['cause'],'finish_quit')
        raw,ctx,report=fixture('finish'); row=report['trace'][-2]; row['data']['ok']=False
        raw=b'\n'.join(json.dumps({'level':'info','target':r.CONTROL_TARGET,'msg':json.dumps(x)}).encode() for x in report['trace'])+b'\n'
        self.assertEqual(classify((raw,ctx,report))['cause'],'unknown')
    def test_completion_is_distinct(self): self.assertEqual(classify(fixture('complete'))['cause'],'fixture_completed')
    def test_deadline_plus_completion_conflicts(self):
        raw,ctx,report=fixture('complete')
        raw+=json.dumps({'level':'warn','target':r.QUIT_TARGET,'msg':r.DEADLINE}).encode()+b'\n'
        self.assertEqual(classify((raw,ctx,report))['cause'],'conflicting')
    def test_wrong_child_root_binary_or_report(self):
        for key,value in [('pid',402),('root','/wrong'),('binary','/wrong'),('ownershipBound',False)]:
            raw,ctx,report=fixture(); ctx[key]=value
            self.assertEqual(classify((raw,ctx,report))['cause'],'unknown')
        raw,ctx,report=fixture(); report['trace']=[]
        self.assertEqual(classify((raw,ctx,report))['cause'],'unknown')
    def test_signal_before_exit_is_never_native_deadline(self):
        value=classify(signals=[{'ns':7_000_000_000,'signal':15,'returned':False,'errno':errno.EPERM}])
        self.assertEqual(value['cause'],'conflicting')
    def test_later_cleanup_signal_and_error_remain_separate(self):
        s={'ns':9_000_000_000,'signal':15,'returned':False,'errno':errno.EPERM}
        value=classify(signals=[s]); self.assertEqual(value['cause'],'native_deadline')
        self.assertEqual(value['laterCleanupSignals'],[s])
    def test_abnormal_reap_is_unknown(self): self.assertEqual(classify(reap_status=9)['cause'],'unknown')
    def test_ambiguous_admitted_requests_are_unknown(self):
        raw,ctx,report=fixture(); events=[(x['event'],x['data']) for x in report['trace'][:-1]]
        events += [('request-before',{'call':2}),('emitted-request',{'call':2,'attempt':2}),('request-after',{'call':2}),('exit',{})]
        rows=controls(events); report['trace']=rows
        raw=b'\n'.join(json.dumps({'level':'info','target':r.CONTROL_TARGET,'msg':json.dumps(x)}).encode() for x in rows[:-1])+b'\n'
        raw+=json.dumps({'level':'warn','target':r.QUIT_TARGET,'msg':r.DEADLINE}).encode()+b'\n'
        raw+=json.dumps({'level':'info','target':r.CONTROL_TARGET,'msg':json.dumps(rows[-1])}).encode()+b'\n'
        self.assertEqual(classify((raw,ctx,report))['cause'],'unknown')
    def test_cancel_then_readmission_joins_second_attempt(self):
        raw,ctx,report=fixture(); events=[(x['event'],x['data']) for x in report['trace'][:-1]]
        events += [('cancel-dispatch',{}),('cancel-return',{}),('request-before',{'call':2}),
                   ('emitted-request',{'call':2,'attempt':2}),('request-after',{'call':2}),('exit',{})]
        rows=controls(events); report['trace']=rows
        raw=b'\n'.join(json.dumps({'level':'info','target':r.CONTROL_TARGET,'msg':json.dumps(x)}).encode() for x in rows[:-1])+b'\n'
        raw+=json.dumps({'level':'warn','target':r.QUIT_TARGET,'msg':r.DEADLINE}).encode()+b'\n'
        raw+=json.dumps({'level':'info','target':r.CONTROL_TARGET,'msg':json.dumps(rows[-1])}).encode()+b'\n'
        self.assertEqual(classify((raw,ctx,report))['attempt'],2)
    def test_malformed_control_and_nan_are_unknown(self):
        raw,ctx,report=fixture(); raw+=b'{"target":"cerebro_lib::native_quit_smoke","msg":"bad"}\n'
        self.assertEqual(classify((raw,ctx,report))['cause'],'unknown')
        raw,ctx,report=fixture(); report['trace'][0]['ms']=float('nan')
        raw=b'\n'.join(json.dumps({'level':'info','target':r.CONTROL_TARGET,'msg':json.dumps(x)}).encode() for x in report['trace'])+b'\n'
        self.assertEqual(classify((raw,ctx,report))['cause'],'unknown')
    def test_malformed_control_data_and_report_stay_unknown(self):
        raw,ctx,report=fixture()
        row={'ordinal':1,'ms':0,'pid':401,'event':'request-before','data':{'call':{}}}
        bad=json.dumps({'level':'info','target':r.CONTROL_TARGET,'msg':json.dumps(row)}).encode()+b'\n'
        self.assertEqual(classify((bad+raw,ctx,report))['cause'],'unknown')
        self.assertEqual(classify((raw,ctx,[]))['cause'],'unknown')
    def test_early_cancellation_is_not_late_coverage(self):
        cause={'cause':'fixture_completed','controls':[]}
        self.assertFalse(r.timing_evidence('late-unresolved',cause,None)['accepted'])


class LifecycleTests(unittest.TestCase):
    def life(self):
        life=r.Lifecycle(1_000_000_000); life.bound=True; life.terminal(2_000_000_000); return life
    def test_absolute_endpoints_and_85_second_maximum(self):
        life=r.Lifecycle(1_000_000_000); life.terminal(100_000_000_000)
        self.assertEqual(life.c,76_000_000_000); self.assertEqual(life.c+10_000_000_000-life.t0,85_000_000_000)
    def test_fixed_term_kill_and_error_retention(self):
        life=self.life(); life.signal_attempt(life.c,signal.SIGTERM,{'returned':False,'errno':errno.EPERM})
        life.signal_attempt(life.c+3_000_000_000,signal.SIGKILL,{'returned':True,'errno':None})
        self.assertEqual(life.errors[0]['signalError']['errno'],errno.EPERM)
    def test_kill_before_phase_and_after_close_rejected(self):
        life=self.life()
        with self.assertRaises(ValueError): life.signal_attempt(life.c+2_000_000_000,signal.SIGKILL,{})
        life.close(life.c+5_000_000_000)
        with self.assertRaises(ValueError): life.signal_attempt(life.c+5_000_000_000,signal.SIGTERM,{})
    def test_early_consuming_reap_is_rejected(self):
        life=self.life()
        with self.assertRaises(ValueError): life.consume(life.c,0)
    def test_closed_then_reaped_cannot_reopen(self):
        life=self.life(); life.close(life.c+5_000_000_000); life.consume(life.c+6_000_000_000,0)
        life.close(life.c+6_000_000_001); self.assertEqual(life.phase,'reaped')
        with self.assertRaises(ValueError): life.signal_attempt(life.c+6_000_000_002,signal.SIGKILL,{})
    def test_no_consume_at_or_after_reap_endpoint(self):
        life=self.life(); life.close(life.c+5_000_000_000)
        with self.assertRaises(ValueError): life.consume(life.c+7_000_000_000,0)
    def test_unbound_never_signals(self):
        life=self.life(); life.bound=False
        with self.assertRaises(ValueError): life.signal_attempt(life.c,signal.SIGTERM,{})
    def test_two_distinct_spaced_absence_samples(self):
        life=self.life(); life.close(life.c+5_000_000_000); life.consume(life.c+5_000_000_001,0)
        absent={'returned':False,'errno':errno.ESRCH}
        self.assertFalse(life.group(9_000_000_000,absent))
        self.assertFalse(life.group(9_000_000_000,absent))
        self.assertFalse(life.cleanup_complete(True))
        self.assertTrue(life.group(10_000_000_000,absent)); self.assertTrue(life.cleanup_complete(True))
        self.assertFalse(life.cleanup_complete(False))
    def test_eperm_unavailable_or_present_resets_absence(self):
        for result in ({'returned':False,'errno':errno.EPERM},{'returned':False,'errno':None},{'returned':True,'errno':None}):
            life=self.life(); life.close(life.c+5_000_000_000); life.consume(life.c+5_000_000_001,0)
            life.group(9_000_000_000,{'returned':False,'errno':errno.ESRCH})
            life.group(10_000_000_000,result)
            self.assertFalse(life.group(11_000_000_000,{'returned':False,'errno':errno.ESRCH}))
    def test_audit_failure_never_grants_cleanup(self):
        life=self.life(); life.close(life.c+5_000_000_000); life.consume(life.c+5_000_000_001,0)
        life.group(9_000_000_000,{'returned':False,'errno':errno.ESRCH})
        life.group(10_000_000_000,{'returned':False,'errno':errno.ESRCH}); life.audit_broken=True
        self.assertFalse(life.cleanup_complete(True))
    def test_survival_and_cleanup_are_separate(self):
        life=self.life(); self.assertFalse(life.cleanup_complete(True))


class QualifiedRuntimeTests(unittest.TestCase):
    def fixture(self):
        # Pure copied identity fixture from the exact accepted host receipt. It
        # neither reads host state nor grants sigaction/owned-group qualification.
        qualified={'invocation':'/usr/bin/python3','platform':'darwin','implementation':'cpython',
            'version':"3.9.6 (default, Jan  9 2026, 11:03:41) \n[Clang 17.0.0 (clang-1700.6.4.2)]",
            'executable':'/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9',
            'executableSha256':'6b24be8ba00c4abc8b3e7e2620bd710e2cf7a4312d00c147f8f05fbb6f3d297a'}
        launcher={'path':r.PYTHON_LAUNCHER,'sha256':r.PYTHON_LAUNCHER_HASH}
        return qualified,dict(qualified),launcher
    def test_distinct_launcher_and_qualified_actual_interpreter_are_allowed(self):
        qualified,observed,launcher=self.fixture()
        bound=r.bind_qualified_runtime(qualified,observed,launcher)
        self.assertNotEqual(bound['launcher']['path'],bound['interpreter']['path'])
        self.assertNotEqual(bound['launcher']['sha256'],bound['interpreter']['sha256'])
        self.assertEqual(bound['interpreter']['sha256'],qualified['executableSha256'])
    def test_actual_interpreter_path_hash_and_version_must_match_qualified_facts(self):
        for key,value in [('executable','/arbitrary/python3'),('executableSha256','0'*64),('version','other')]:
            qualified,observed,launcher=self.fixture(); observed[key]=value
            with self.assertRaises(ValueError): r.bind_qualified_runtime(qualified,observed,launcher)
    def test_launcher_path_and_hash_stay_separately_pinned(self):
        for key,value in [('path','/arbitrary/python3'),('sha256','0'*64)]:
            qualified,observed,launcher=self.fixture(); launcher[key]=value
            with self.assertRaises(ValueError): r.bind_qualified_runtime(qualified,observed,launcher)
    def test_non_system_invocation_or_non_darwin_qualification_is_refused(self):
        for key,value in [('invocation','/arbitrary/python3'),('platform','linux'),('implementation','pypy')]:
            qualified,observed,launcher=self.fixture(); qualified[key]=value; observed[key]=value
            with self.assertRaises(ValueError): r.bind_qualified_runtime(qualified,observed,launcher)


class ControlReceiptTests(unittest.TestCase):
    def fixture(self,member_ns=7):
        ready={'toy':'leader-ready','pid':401,'member':{'toy':'member-ready','pid':402,'pgid':401},'role':'leader-exit'}
        member={'toy':'member-term-ignored','pid':402,'ns':member_ns}
        lines=[(json.dumps(row)+'\n').encode() for row in (ready,member)]
        result={'case':'leader-exit','owned':{'pid':401,'pgid':401},
            'signals':[{'signal':15,'ns':1000,'returned':True,'errno':None,'error':None},
                       {'signal':9,'ns':2000,'returned':True,'errno':None,'error':None}],
            'retainedExitObservationNs':900,'cleanupComplete':True,'inputsStable':True,'errors':[],
            'pipeEof':{'stdout':True,'stderr':True},'arrivals':[
                {'stream':'stdout','ns':950,'offset':0,'receivedBytes':len(lines[0])},
                {'stream':'stdout','ns':1100,'offset':len(lines[0]),'receivedBytes':len(lines[1])}]}
        return result,b''.join(lines),lines
    def accepted(self,result,stdout,stderr=b''):
        return r.control_evidence(result,stdout,stderr)['accepted']
    def test_complete_report_joins_exact_byte_range(self):
        result,stdout,lines=self.fixture(); value=r.control_evidence(result,stdout)
        self.assertTrue(value['accepted'],value)
        self.assertEqual(value['memberReceipt']['start'],len(lines[0]))
        self.assertEqual(value['memberReceipt']['endExclusive'],len(stdout))
        self.assertEqual(value['memberReceipt']['clock'],'supervisor-monotonic-ns')
    def test_split_report_entirely_inside_window(self):
        result,stdout,lines=self.fixture(); start=len(lines[0]); size=len(lines[1])
        result['arrivals'][1:]=[
            {'stream':'stdout','ns':1100,'offset':start,'receivedBytes':3},
            {'stream':'stdout','ns':1200,'offset':start+3,'receivedBytes':size-4},
            {'stream':'stdout','ns':1300,'offset':len(stdout)-1,'receivedBytes':1}]
        value=r.control_evidence(result,stdout); self.assertTrue(value['accepted'],value)
        self.assertEqual(len(value['memberReceipt']['chunks']),3)
    def test_different_member_clock_origin_is_diagnostic_only(self):
        for ns in (0,999999999999999999):
            result,stdout,_=self.fixture(ns); self.assertTrue(self.accepted(result,stdout))
    def test_before_or_at_term_receipt_is_refused(self):
        for ns in (999,1000):
            result,stdout,_=self.fixture(); result['arrivals'][1]['ns']=ns
            self.assertFalse(self.accepted(result,stdout))
    def test_split_report_straddling_term_is_refused(self):
        result,stdout,lines=self.fixture(); start=len(lines[0]); size=len(lines[1])
        result['arrivals'][1:]=[
            {'stream':'stdout','ns':999,'offset':start,'receivedBytes':1},
            {'stream':'stdout','ns':1100,'offset':start+1,'receivedBytes':size-1}]
        self.assertFalse(self.accepted(result,stdout))
    def test_split_report_straddling_kill_is_refused(self):
        result,stdout,lines=self.fixture(); start=len(lines[0]); size=len(lines[1])
        result['arrivals'][1:]=[
            {'stream':'stdout','ns':1999,'offset':start,'receivedBytes':size-1},
            {'stream':'stdout','ns':2000,'offset':len(stdout)-1,'receivedBytes':1}]
        self.assertFalse(self.accepted(result,stdout))
    def test_after_kill_receipt_is_refused(self):
        result,stdout,_=self.fixture(); result['arrivals'][1]['ns']=2001
        self.assertFalse(self.accepted(result,stdout))
    def test_mismatched_member_pid_or_group_is_refused(self):
        result,stdout,lines=self.fixture()
        self.assertFalse(self.accepted(result,lines[0]+lines[1].replace(b'"pid": 402',b'"pid": 403')))
        result,stdout,_=self.fixture()
        self.assertFalse(self.accepted(result,stdout.replace(b'"pgid": 401',b'"pgid": 403')))
    def test_duplicate_or_missing_handler_report_is_refused(self):
        result,stdout,lines=self.fixture(); result['arrivals'][1]['receivedBytes']+=len(lines[1])
        self.assertFalse(self.accepted(result,stdout+lines[1]))
        result,stdout,lines=self.fixture(); result['arrivals']=result['arrivals'][:1]
        self.assertFalse(self.accepted(result,lines[0]))
    def test_malformed_incomplete_duplicate_key_or_unbounded_row_is_refused(self):
        for bad in (b'{bad}\n',b'{}',b'{"toy":"member-term-ignored","pid":402,"pid":402,"ns":7}\n',
                    b'['+b' '*2048+b']\n',b'[]\n',b'{}\n',b'{"toy":"member-term-ignored","pid":402,"ns":NaN}\n',
                    b'['*1000+b'0'+b']'*1000+b'\n'):
            result,stdout,lines=self.fixture(); result['arrivals'][1]['receivedBytes']=len(bad)
            self.assertFalse(self.accepted(result,lines[0]+bad))
    def test_reversed_or_unknown_fixed_reports_are_refused(self):
        result,stdout,lines=self.fixture(); stdout=lines[1]+lines[0]
        result['arrivals']=[{'stream':'stdout','ns':1100,'offset':0,'receivedBytes':len(stdout)}]
        self.assertFalse(self.accepted(result,stdout))
        result,stdout,lines=self.fixture(); result['case']='other'
        first=stdout.split(b'\n',1)[0].replace(b'leader-exit',b'other')+b'\n'
        stdout=first+lines[1]; result['arrivals'][0]['receivedBytes']=len(first)
        result['arrivals'][1]['offset']=len(first)
        self.assertFalse(self.accepted(result,stdout))
    def test_missing_or_duplicate_arrival_is_refused(self):
        result,stdout,_=self.fixture(); result['arrivals']=result['arrivals'][:1]
        self.assertFalse(self.accepted(result,stdout))
        result,stdout,_=self.fixture(); result['arrivals'].append(dict(result['arrivals'][-1]))
        self.assertFalse(self.accepted(result,stdout))
    def test_gap_overlap_and_extra_bytes_are_refused(self):
        for key,delta in (('offset',1),('offset',-1),('receivedBytes',1),('receivedBytes',-1)):
            result,stdout,_=self.fixture(); result['arrivals'][1][key]+=delta
            self.assertFalse(self.accepted(result,stdout))
    def test_malformed_arrival_shape_stream_and_scalar_types_are_refused(self):
        for key,value in (('stream','other'),('stream',[]),('ns',True),('ns',1.5),('ns',-1),
                          ('offset',True),('offset',-1),('receivedBytes',0),('receivedBytes',8193)):
            result,stdout,_=self.fixture(); result['arrivals'][1][key]=value
            self.assertFalse(self.accepted(result,stdout))
        result,stdout,_=self.fixture(); del result['arrivals'][1]['ns']
        self.assertFalse(self.accepted(result,stdout))
        result,stdout,_=self.fixture(); result['arrivals'][1]['extra']=1
        self.assertFalse(self.accepted(result,stdout))
        result,stdout,_=self.fixture(); result['arrivals'][1]=None
        self.assertFalse(self.accepted(result,stdout))
    def test_arrival_order_and_non_eof_are_refused(self):
        result,stdout,_=self.fixture(); result['arrivals']=list(reversed(result['arrivals']))
        self.assertFalse(self.accepted(result,stdout))
        result,stdout,_=self.fixture(); result['arrivals'][0]['ns']=1200
        self.assertFalse(self.accepted(result,stdout))
        result,stdout,_=self.fixture(); result['pipeEof']['stdout']=False
        self.assertFalse(self.accepted(result,stdout))
    def test_stderr_arrivals_also_require_exact_coverage(self):
        result,stdout,_=self.fixture(); stderr=b'diagnostic\n'
        result['arrivals'].append({'stream':'stderr','ns':1500,'offset':0,'receivedBytes':len(stderr)})
        self.assertTrue(self.accepted(result,stdout,stderr))
        result['arrivals'][-1]['receivedBytes']-=1
        self.assertFalse(self.accepted(result,stdout,stderr))
    def test_signal_success_and_leader_order_stay_required(self):
        result,stdout,_=self.fixture(); result['signals'][0]['returned']=False
        self.assertFalse(self.accepted(result,stdout))
        result,stdout,_=self.fixture(); result['retainedExitObservationNs']=1001
        self.assertFalse(self.accepted(result,stdout))
    def test_term_leader_control_keeps_exit_after_term_requirement(self):
        result,stdout,_=self.fixture(); result['case']='leader-term'
        stdout=stdout.replace(b'leader-exit',b'leader-term'); result['retainedExitObservationNs']=1200
        self.assertTrue(self.accepted(result,stdout))
        result['retainedExitObservationNs']=900; self.assertFalse(self.accepted(result,stdout))
    def test_cleanup_source_or_raw_error_never_passes(self):
        for key,value in (('cleanupComplete',False),('inputsStable',False),('errors',[{'raw':'error'}])):
            result,stdout,_=self.fixture(); result[key]=value
            self.assertFalse(self.accepted(result,stdout))


class StartupLayoutTests(unittest.TestCase):
    # Root-only temporary-filesystem contracts; no subprocess or native launch.
    def setUp(self):
        self.temp=r.tempfile.TemporaryDirectory(prefix='m93-startup-layout-test-')
        self.addCleanup(self.temp.cleanup)
        self.outer=pathlib.Path(self.temp.name).resolve(); r.os.chmod(self.outer,0o700)
    def test_native_fixture_stays_empty_with_prelaunch_outer_audit(self):
        layout=r.prepare_layout(self.outer,False); native=pathlib.Path(layout['native']['path'])
        audit=r.Audit(self.outer/'cleanup.jsonl',r.Lifecycle(0))
        try:
            audit.add('startup-layout',layout=layout)
            self.assertEqual(r.validate_layout(layout,False,True),native)
            self.assertEqual(list(native.iterdir()),[])
            self.assertNotEqual(native,self.outer)
            self.assertEqual(native.parent,self.outer)
            self.assertEqual(native.name,'fixture')
            self.assertEqual(r.stat.S_IMODE(native.stat().st_mode),0o700)
            self.assertTrue((self.outer/'cleanup.jsonl').is_file())
        finally:audit.close()
    def test_environment_binds_only_native_fixture(self):
        layout=r.prepare_layout(self.outer,False); native=r.validate_layout(layout,False,True)
        env=r.child_environment(native)
        self.assertEqual(env['PATH'],str(native/'bin'))
        self.assertEqual(env['SHELL'],str(native/'bin/smoke-shell'))
        self.assertEqual(env['CLAUDE_CONFIG_DIR'],str(native/'claude-config'))
        self.assertNotEqual(env['PATH'],str(self.outer/'bin'))
    def test_preexisting_native_directory_is_not_reused(self):
        (self.outer/'fixture').mkdir(mode=0o700)
        with self.assertRaises(FileExistsError):r.prepare_layout(self.outer,False)
    def test_native_prelaunch_contamination_is_refused(self):
        layout=r.prepare_layout(self.outer,False); native=pathlib.Path(layout['native']['path'])
        r.write_private(native/'cleanup.jsonl',b'prior evidence\n')
        with self.assertRaises(ValueError):r.validate_layout(layout,False,True)
    def test_outer_report_cannot_substitute_for_native_report_location(self):
        layout=r.prepare_layout(self.outer,False); native=r.validate_layout(layout,False,True)
        r.write_json(self.outer/'report.json',{'substituted':True})
        self.assertFalse((native/'report.json').exists())
        self.assertEqual(r.validate_layout(layout,False,True),native)
    def test_native_writes_are_allowed_only_after_empty_start_check(self):
        layout=r.prepare_layout(self.outer,False); native=r.validate_layout(layout,False,True)
        r.write_json(native/'report.json',{'native':True})
        self.assertEqual(r.validate_layout(layout,False,False),native)
        with self.assertRaises(ValueError):r.validate_layout(layout,False,True)
    def test_replaced_native_inode_is_refused(self):
        layout=r.prepare_layout(self.outer,False); native=pathlib.Path(layout['native']['path'])
        native.rename(self.outer/'original-fixture'); native.mkdir(mode=0o700)
        with self.assertRaises(ValueError):r.validate_layout(layout,False,True)
        with self.assertRaises(ValueError):r.validate_layout(layout,False,False)
    def test_symlink_or_alias_native_root_is_refused(self):
        layout=r.prepare_layout(self.outer,False); native=pathlib.Path(layout['native']['path'])
        native.rename(self.outer/'original-fixture'); native.symlink_to(self.outer/'original-fixture',target_is_directory=True)
        with self.assertRaises(ValueError):r.validate_layout(layout,False,True)
    def test_public_directory_or_changed_layout_identity_is_refused(self):
        layout=r.prepare_layout(self.outer,False); native=pathlib.Path(layout['native']['path'])
        r.os.chmod(native,0o755)
        with self.assertRaises(ValueError):r.validate_layout(layout,False,True)
        r.os.chmod(native,0o700); layout['native']['inode']+=1
        with self.assertRaises(ValueError):r.validate_layout(layout,False,True)
    def test_outer_cannot_be_used_as_native_fixture(self):
        layout=r.prepare_layout(self.outer,False); layout['native']=dict(layout['evidence'])
        with self.assertRaises(ValueError):r.validate_layout(layout,False,True)
    def test_control_keeps_outer_root_and_needs_no_empty_fixture(self):
        layout=r.prepare_layout(self.outer,True); r.write_private(self.outer/'cleanup.jsonl',b'control\n')
        self.assertEqual(r.validate_layout(layout,True,True),self.outer)
        self.assertEqual(layout['native'],layout['evidence'])
        self.assertFalse((self.outer/'fixture').exists())
    def test_cause_classifier_binds_native_bootstrap_not_outer_evidence(self):
        layout=r.prepare_layout(self.outer,False); native=r.validate_layout(layout,False,True)
        raw,ctx,report=fixture(); old=ctx['root']; ctx['root']=str(native)
        report['trace'][0]['data']['root']=str(native); raw=raw.replace(old.encode(),str(native).encode())
        self.assertEqual(classify((raw,ctx,report))['cause'],'native_deadline')
        ctx['root']=str(self.outer)
        self.assertEqual(classify((raw,ctx,report))['cause'],'unknown')



class SourceIdentityTests(unittest.TestCase):
    # Small synthetic version of outcomes.test.ts's nativeFixtureRepository.
    # Files are hash inputs only: no source is executed, copied from the real repo
    # or supplied by the manifest under test. Root alone executes this test suite.
    TREE_ROOTS=('src-tauri/src','shared','src-tauri/fixtures','conformance',
                'src-tauri/build_support','src-tauri/capabilities')
    FIXED_INPUTS=('src-tauri/build.rs','src-tauri/Cargo.toml','src-tauri/Cargo.lock',
        'src-tauri/tauri.conf.json','src-tauri/native-read-smoke/tauri.conf.json',
        'src-tauri/icons/32x32.png','src-tauri/icons/icon.icns','src-tauri/clippy.toml',
        'src-tauri/Info.plist','rust-toolchain.toml','conformance/outcomes/native.rs',
        'scripts/outcomes/native-inputs.ts','scripts/outcomes/native-capture.ts',
        'scripts/outcomes/retrieval.ts','scripts/native-credential-smoke/run.py',
        'scripts/native-quit-smoke/run.py','scripts/native-quit-smoke/test_run.py')
    RETRIEVAL='scripts/outcomes/retrieval.ts'
    def setUp(self):
        self.temp=r.tempfile.TemporaryDirectory(prefix='m97-quit-input-test-')
        self.addCleanup(self.temp.cleanup)
        self.repo=pathlib.Path(self.temp.name).resolve()
        for name in self.TREE_ROOTS:(self.repo/name).mkdir(parents=True,exist_ok=True)
        tree_inputs=('src-tauri/src/probe.rs','shared/policy/probe.json',
            'src-tauri/fixtures/probe.json','src-tauri/build_support/probe.rs',
            'src-tauri/capabilities/probe.json','conformance/outcomes/native-inputs.generated.rs',
            'conformance/outcomes/native-inputs.v1.json')
        self.paths=sorted(set(self.FIXED_INPUTS+tree_inputs))
        for name in self.paths:
            file=self.repo/name; file.parent.mkdir(parents=True,exist_ok=True)
            file.write_bytes(('synthetic input: '+name+'\n').encode())
        self.write_inventory(self.paths)
    def write_inventory(self,paths):
        (self.repo/'conformance/outcomes/native-inputs.v1.json').write_text(
            json.dumps({'version':1,'scope':r.SCOPE,'paths':paths},sort_keys=True)+'\n',encoding='utf-8')
    def test_complete_fixed_discovery_accepts_minimal_manifest(self):
        value=r.source_identity(self.repo)
        self.assertIn(self.RETRIEVAL,self.paths)
        self.assertEqual(value['scope'],r.SCOPE)
        self.assertEqual(value['fileCount'],len(self.paths))
        self.assertEqual(value['totalBytes'],sum((self.repo/name).stat().st_size for name in self.paths))
        self.assertEqual(value['smokeConfigSha256'],r.digest(self.repo/'src-tauri/native-read-smoke/tauri.conf.json'))
    def test_fixed_fixture_contract_matches_current_committed_manifest(self):
        # Read one bounded manifest, never walk/copy the real repository. This
        # catches the next new outside-tree fixed input even if this fixture and
        # the Python discovery list both accidentally omit it.
        real_repo=pathlib.Path(__file__).resolve().parents[2]
        value=json.loads(r.read_regular(real_repo/'conformance/outcomes/native-inputs.v1.json',512*1024))
        self.assertEqual(value['version'],1); self.assertEqual(value['scope'],r.SCOPE)
        paths=value['paths']; self.assertIsInstance(paths,list)
        self.assertLessEqual(len(paths),2048)
        self.assertTrue(all(isinstance(name,str) for name in paths))
        self.assertEqual(paths,sorted(set(paths)))
        outside=lambda name:not any(name.startswith(tree+'/') for tree in self.TREE_ROOTS)
        self.assertEqual({name for name in paths if outside(name)},
                         {name for name in self.FIXED_INPUTS if outside(name)})
    def test_removed_required_manifest_row_is_refused(self):
        self.write_inventory([name for name in self.paths if name!=self.RETRIEVAL])
        with self.assertRaisesRegex(ValueError,'native inventory path coverage changed'):
            r.source_identity(self.repo)
    def test_replaced_required_manifest_row_is_refused_even_when_file_exists(self):
        alias='scripts/outcomes/retrieval-renamed.ts'
        (self.repo/alias).write_bytes(b'synthetic alias\n')
        self.write_inventory(sorted(alias if name==self.RETRIEVAL else name for name in self.paths))
        with self.assertRaisesRegex(ValueError,'native inventory path coverage changed'):
            r.source_identity(self.repo)
    def test_added_unapproved_fixed_manifest_row_is_refused(self):
        extra='scripts/outcomes/unapproved.ts'; (self.repo/extra).write_bytes(b'synthetic extra\n')
        self.write_inventory(sorted(self.paths+[extra]))
        with self.assertRaisesRegex(ValueError,'native inventory path coverage changed'):
            r.source_identity(self.repo)
    def test_missing_required_file_is_refused_without_weakening_coverage(self):
        (self.repo/self.RETRIEVAL).unlink()
        with self.assertRaises(FileNotFoundError):r.source_identity(self.repo)
    def test_retrieval_bytes_are_part_of_actual_input_identity(self):
        before=r.source_identity(self.repo)
        (self.repo/self.RETRIEVAL).write_bytes(b'changed synthetic retrieval source\n')
        after=r.source_identity(self.repo)
        self.assertEqual(after['fileCount'],before['fileCount'])
        self.assertNotEqual(after['aggregateDigest'],before['aggregateDigest'])




# M93 late-window-v1 validator contract. These are synthetic INPUTS to the
# real validator, never native timing evidence or substitutes for gate tests.
# Literal times are hand-derived: arm=100, due=5100, ingress=[4850,4950).
def late_window_fixture(case='late-ipc-150'):
    draft='M93 controlled retained draft\n'
    clean='M93 controlled clean source\n'
    owner={'vaultId':'m93-controlled-vault','path':'controlled.md','ownerId':'m93-native-quit'}
    def snapshot(text,generation):
        return {'latestDraft':text,'generation':generation,'acknowledgedGeneration':0,
                'inFlightGeneration':None,'failed':False,
                'payloadSha256':r.hashlib.sha256(text.encode()).hexdigest(),
                'ownerKey':dict(owner),'ownerInstance':'retained-1'}
    clean_snapshot=snapshot(clean,0); dirty_snapshot=snapshot(draft,1)
    token='native-issued-binding-for-epoch-41'
    rows=[]
    def add(ms,event,data):
        rows.append({'ordinal':len(rows)+1,'ms':float(ms),'pid':401,'event':event,'data':data})
    def native(ms,event,**values):
        add(ms,event,dict({'epoch':41,'binding':token,'capturedNs':int(ms*1_000_000)},**values))
    def front(received,local,sequence,stage,edge,snap,**values):
        add(received,'frontend',dict({'kind':'stage','stage':stage,'edge':edge,
            'ms':local,'sequence':sequence,'binding':token,'snapshot':dict(snap)},**values))
    add(0,'case-start',{'case':case,'measurementContract':'late-window-v1'})
    add(1,'frontend',{'kind':'ready'})
    add(90,'request-before',{'call':1})
    native(90.1,'attempt-admitted',call=1,attempt=1,phase='preparing')
    add(90.2,'emitted-request',{'call':1,'attempt':1,'epoch':41})
    add(90.3,'request-after',{'call':1})
    native(100,'deadline-arm',durationMs=5000)
    native(101,'attempt-bound',phase='preparing')
    front(200,0,0,'shell-mounted','complete',clean_snapshot,mount=1)
    front(201,10,1,'flush','enter',clean_snapshot,budgetMs=2500)
    front(202,20,2,'flush','complete',clean_snapshot,budgetMs=2500,
          result={'kind':'fulfilled','value':{'outcomes':[],'unresolvedOwnerIds':[]}})
    front(203,21,3,'settle-first','enter',clean_snapshot,budgetMs=750)
    front(204,30,4,'settle-first','complete',clean_snapshot,budgetMs=750,
          result={'kind':'fulfilled','value':True})
    front(205,31,5,'leave','enter',clean_snapshot,budgetMs=750)
    front(206,32,6,'cleanup','complete',dirty_snapshot)
    front(207,40,7,'leave','complete',dirty_snapshot,budgetMs=750,
          result={'kind':'fulfilled','value':True})
    front(208,41,8,'settle-second','enter',dirty_snapshot,budgetMs=750)
    front(209,50,9,'settle-second','complete',dirty_snapshot,budgetMs=750,
          result={'kind':'fulfilled','value':True})
    add(210,'frontend',{'kind':'end-leaving','ms':51,'sequence':10,'binding':token,
                       'hasUnresolved':True,'snapshot':dict(dirty_snapshot)})
    front(211,60,11,'shell-mounted','complete',dirty_snapshot,mount=2)
    add(212,'frontend',{'kind':'cancel-wrapper','ms':61,'sequence':12,'binding':token,
                       'snapshot':dict(dirty_snapshot)})
    native(700,'phase-batch-accepted',lastSequence=12)
    native(701,'wait-admitted',phase='preparing')
    native(4850,'wait-released',phase='preparing')
    native(4851,'cancel-ingress',phase='preparing')
    native(4852,'cancel-injection-enter',configuredMs=150 if case=='late-ipc-150' else 350)
    if case=='late-ipc-150':
        native(5005,'cancel-dispatch',configuredMs=150,phase='preparing')
        native(5006,'gate-cancel',before='preparing',after='idle',cancelled=True)
        native(5007,'cancel-return')
        add(5010,'frontend',{'kind':'stayed','ms':4870,'sequence':13,'binding':token,
                             'snapshot':dict(dirty_snapshot)})
        native(5102,'gate-deadline',timerEpoch=41,before='idle',after='idle',exits=False)
        add(5391,'survived',{'call':1,'epoch':41})
        add(5392,'request-before',{'call':2})
        add(5392.1,'attempt-admitted',{'epoch':42,'call':2,'attempt':2,'phase':'preparing',
                                     'capturedNs':5_392_100_000})
        add(5392.2,'emitted-request',{'call':2,'attempt':2,'epoch':42})
        add(5392.3,'request-after',{'call':2})
        add(5392.4,'probe-cancel-dispatch',{'epoch':42})
        add(5392.5,'probe-cancel-return',{'epoch':42})
        add(5400,'fixture-complete-intent',{})
        add(5401,'exit-requested',{})
        add(5402,'exit',{})
        cause={'cause':'fixture_completed','attempt':None,'controls':rows,'errors':[]}
    else:
        native(5102,'gate-deadline',timerEpoch=41,before='preparing',after='exiting',exits=True)
        add(5103,'exit-requested',{})
        add(5104,'exit',{})
        cause={'cause':'native_deadline','attempt':1,'controls':rows,'errors':[]}
    report={'format':2,'measurementContract':'late-window-v1','case':case,
            'traceBroken':False,'trace':rows,'nativePid':401}
    return cause,report


class LateWindowTimingTests(unittest.TestCase):
    def evidence(self,case='late-ipc-150',mutate=None):
        cause,report=late_window_fixture(case)
        if mutate is not None: mutate(cause,report)
        # Keep transport ordinals valid so a missing/duplicate fact cannot pass
        # this negative test merely because its removal left an ordinal hole.
        cause['controls'].sort(key=lambda row:row['ms'])
        for ordinal,row in enumerate(cause['controls'],1): row['ordinal']=ordinal
        return r.timing_evidence(case,cause,report)

    def test_complete_fast_evidence_is_positive_validator_control(self):
        self.assertTrue(self.evidence()['accepted'])

    def test_slow_deadline_after_injection_without_dispatch_is_positive_control(self):
        self.assertTrue(self.evidence('late-ipc-350')['accepted'])

    def test_legacy_stage_list_without_native_authority_is_not_current_acceptance(self):
        def strip(cause,report):
            names={'attempt-admitted','deadline-arm','attempt-bound','phase-batch-accepted',
                   'wait-admitted','wait-released','cancel-injection-enter','gate-cancel','gate-deadline'}
            cause['controls'][:]=[row for row in cause['controls'] if row['event'] not in names]
        self.assertFalse(self.evidence(mutate=strip)['accepted'])

    def test_each_native_authority_fact_is_required(self):
        for missing in ('deadline-arm','attempt-bound','phase-batch-accepted','wait-admitted',
                        'wait-released','cancel-injection-enter','gate-cancel','gate-deadline'):
            with self.subTest(missing=missing):
                def remove(cause,report):
                    cause['controls'][:]=[row for row in cause['controls'] if row['event']!=missing]
                self.assertFalse(self.evidence(mutate=remove)['accepted'])

    def test_wrong_epoch_at_each_native_boundary_is_refused(self):
        for name in ('deadline-arm','attempt-bound','wait-admitted','wait-released','cancel-ingress',
                     'cancel-injection-enter','cancel-dispatch','gate-cancel','gate-deadline'):
            with self.subTest(event=name):
                def wrong(cause,report):
                    next(row for row in cause['controls'] if row['event']==name)['data']['epoch']=42
                self.assertFalse(self.evidence(mutate=wrong)['accepted'])

    def test_repeated_arm_wait_release_or_cancel_is_ambiguous(self):
        for name in ('deadline-arm','wait-admitted','wait-released','cancel-ingress','gate-cancel'):
            with self.subTest(event=name):
                def repeat(cause,report):
                    rows=cause['controls']; index=next(i for i,row in enumerate(rows) if row['event']==name)
                    rows.insert(index+1,json.loads(json.dumps(rows[index])))
                self.assertFalse(self.evidence(mutate=repeat)['accepted'])

    def test_actual_ingress_lower_and_upper_endpoints(self):
        for ingress,accepted in ((4849.999,False),(4850.0,True),(4949.999,True),(4950.0,False)):
            with self.subTest(ingress=ingress):
                def move(cause,report):
                    # Keep a physically consistent fast segment for every boundary.
                    times={'cancel-ingress':ingress,'cancel-injection-enter':ingress,
                           'cancel-dispatch':ingress+150,'gate-cancel':ingress+150,
                           'cancel-return':ingress+150}
                    for row in cause['controls']:
                        if row['event'] in times:
                            row['ms']=times[row['event']]
                            row['data']['capturedNs']=round(times[row['event']]*1_000_000)
                        if row['event']=='frontend' and row['data'].get('kind')=='stayed':
                            row['ms']=ingress+150
                self.assertEqual(self.evidence(mutate=move)['accepted'],accepted)

    def test_wait_admission_after_target_or_release_before_target_is_refused(self):
        for event,at in (('wait-admitted',4850),('wait-released',4849.999),('wait-released',4950)):
            with self.subTest(event=event,at=at):
                def move(cause,report):
                    row=next(row for row in cause['controls'] if row['event']==event)
                    row['ms']=at; row['data']['capturedNs']=round(at*1_000_000)
                self.assertFalse(self.evidence(mutate=move)['accepted'])

    def test_fast_gate_cancel_at_nominal_due_is_not_saved_by_late_timer(self):
        def late(cause,report):
            for row in cause['controls']:
                if row['event'] in ('cancel-dispatch','gate-cancel','cancel-return'):
                    row['ms']=5100; row['data']['capturedNs']=5_100_000_000
                if row['event']=='frontend' and row['data'].get('kind')=='stayed': row['ms']=5101
        self.assertFalse(self.evidence(mutate=late)['accepted'])

    def test_gate_cancel_false_is_not_successful_cancel_return(self):
        def refused(cause,report):
            row=next(row for row in cause['controls'] if row['event']=='gate-cancel')
            row['data'].update(cancelled=False,before='exiting',after='exiting')
        self.assertFalse(self.evidence(mutate=refused)['accepted'])

    def test_unknown_or_nonfinite_arm_never_defaults_to_origin(self):
        for value in (None,-1,float('nan'),float('inf')):
            with self.subTest(value=value):
                def missing(cause,report):
                    next(row for row in cause['controls'] if row['event']=='deadline-arm')['data']['capturedNs']=value
                self.assertFalse(self.evidence(mutate=missing)['accepted'])

    def test_wrong_binding_and_missing_result_are_not_complete_phases(self):
        for mutation in ('binding','result','unresolved-result','rejected','duration'):
            with self.subTest(mutation=mutation):
                def change(cause,report):
                    row=next(row for row in cause['controls'] if row['event']=='frontend'
                             and row['data'].get('stage')=='flush' and row['data'].get('edge')=='complete')
                    if mutation=='binding': row['data']['binding']='stale-binding'
                    elif mutation=='result': del row['data']['result']
                    elif mutation=='unresolved-result':
                        row['data']['result']['value']['unresolvedOwnerIds']=['retained-1']
                    elif mutation=='rejected':
                        row['data']['result']={'kind':'rejected','code':'controlled-throw'}
                    else: row['data']['ms']=2510  # entry 10 + full 2500 ms budget
                self.assertFalse(self.evidence(mutate=change)['accepted'])

    def test_restoration_must_be_after_cleanup_on_the_retained_owner(self):
        for mutation in ('missing','initial-only','replacement-owner','wrong-draft'):
            with self.subTest(mutation=mutation):
                def change(cause,report):
                    rows=cause['controls']
                    restored=next(row for row in rows if row['event']=='frontend'
                                  and row['data'].get('stage')=='shell-mounted' and row['data'].get('mount')==2)
                    if mutation=='missing': rows.remove(restored)
                    elif mutation=='initial-only': restored['data'].update(sequence=0,ms=0,mount=1)
                    elif mutation=='replacement-owner': restored['data']['snapshot']['ownerInstance']='replacement-2'
                    else: restored['data']['snapshot']['latestDraft']='wrong'
                self.assertFalse(self.evidence('late-ipc-350',change)['accepted'])

    def test_slow_deadline_requires_actual_injection_entry(self):
        def remove(cause,report):
            cause['controls'][:]=[row for row in cause['controls'] if row['event']!='cancel-injection-enter']
        self.assertFalse(self.evidence('late-ipc-350',remove)['accepted'])

    def test_slow_deadline_requires_matching_actual_gate_winner(self):
        for mutation in ('missing','wrong-epoch','false','early','wrong-delay'):
            with self.subTest(mutation=mutation):
                def change(cause,report):
                    row=next(row for row in cause['controls'] if row['event']=='gate-deadline')
                    if mutation=='missing': cause['controls'].remove(row)
                    elif mutation=='wrong-epoch': row['data']['timerEpoch']=40
                    elif mutation=='false': row['data'].update(exits=False,after='preparing')
                    elif mutation=='early': row['data']['capturedNs']=5_099_999_999
                    else:
                        next(x for x in cause['controls'] if x['event']=='cancel-injection-enter')['data']['configuredMs']=150
                self.assertFalse(self.evidence('late-ipc-350',change)['accepted'])

    def test_slow_late_cancellation_is_not_automatically_a_boundary_success(self):
        cause,report=late_window_fixture('late-ipc-150')
        report['case']='late-ipc-350'; cause['controls'][0]['data']['case']='late-ipc-350'
        for row in cause['controls']:
            if row['event'] in ('cancel-injection-enter','cancel-dispatch'): row['data']['configuredMs']=350
            if row['event'] in ('cancel-dispatch','gate-cancel','cancel-return'):
                row['ms']=5202; row['data']['capturedNs']=5_202_000_000
            if row['event']=='gate-deadline': row['ms']=5300; row['data']['capturedNs']=5_300_000_000
            if row['event']=='frontend' and row['data'].get('kind')=='stayed': row['ms']=5210
        self.assertFalse(r.timing_evidence('late-ipc-350',cause,report)['accepted'])

    def test_broken_or_missing_report_cannot_certify_a_window(self):
        cause,report=late_window_fixture()
        self.assertFalse(r.timing_evidence('late-ipc-150',cause,None)['accepted'])
        report['traceBroken']=True
        self.assertFalse(r.timing_evidence('late-ipc-150',cause,report)['accepted'])


class LateWindowAggregateRegressionTests(unittest.TestCase):
    def test_signal_error_still_fails_the_actual_main_aggregate_with_green_timing(self):
        # Exercise main's real aggregate branch, replacing only process/host
        # boundaries. This creates inert temporary files; it launches nothing.
        from contextlib import redirect_stdout
        from io import StringIO
        from unittest import mock
        with r.tempfile.TemporaryDirectory(prefix='m93-aggregate-unit-') as directory:
            parent=pathlib.Path(directory); binary=parent/'native-read-smoke'
            binary.write_bytes(b'inert unit-test path, never executed')
            result={'root':str(parent),'timing':{'accepted':True,'metrics':{}},
                    'cleanupComplete':True,'inputsStable':True,
                    'nativeExit':{'cause':'fixture_completed'},
                    'errors':[{'signalError':{'signal':15,'returned':False,'errno':errno.EPERM}}]}
            argv=['run.py','--repo',str(parent),'--binary',str(binary),
                  '--output-parent',str(parent),'--cleanup-acceptance',str(parent/'reader.json'),
                  '--cleanup-acceptance-sha256','unit-reader-pin',
                  '--ownership-acceptance',str(parent/'owner.json'),'--case','late-ipc-150']
            output=StringIO()
            with mock.patch.object(r.sys,'argv',argv), \
                 mock.patch.object(r,'load_observer',return_value=(None,None)), \
                 mock.patch.object(r,'load_owned_group_acceptance',return_value={'unit':True}), \
                 mock.patch.object(r,'supervise',return_value=result), \
                 redirect_stdout(output):
                with self.assertRaises(SystemExit) as stopped: r.main()
            self.assertEqual(stopped.exception.code,2)
            row=json.loads(output.getvalue().splitlines()[0])
            self.assertIs(row['timing']['accepted'],True)
            self.assertIs(row['accepted'],False)
            self.assertEqual(result['errors'][0]['signalError']['errno'],errno.EPERM)




    def test_missing_or_malformed_audit_records_unavailable_and_finishes_series(self):
        from contextlib import redirect_stdout
        from io import StringIO
        from unittest import mock
        for audit_bytes in (None,b'{malformed\n'):
            with self.subTest(audit=audit_bytes),r.tempfile.TemporaryDirectory(prefix='m93-audit-unavailable-unit-') as directory:
                parent=pathlib.Path(directory);binary=parent/'native-read-smoke';binary.write_bytes(b'inert, never executed')
                if audit_bytes is not None:r.write_private(parent/'cleanup.jsonl',audit_bytes)
                value={'root':str(parent),'timing':{'accepted':True,'metrics':{}},'cleanupComplete':True,'inputsStable':True,'nativeExit':{'cause':'fixture_completed'},'errors':[]}
                argv=['run.py','--repo',str(parent),'--binary',str(binary),'--output-parent',str(parent),'--cleanup-acceptance',str(parent/'reader.json'),'--cleanup-acceptance-sha256','unit-reader-pin','--ownership-acceptance',str(parent/'owner.json'),'--case','late-ipc-150']
                output=StringIO()
                with mock.patch.object(r.sys,'argv',argv),mock.patch.object(r,'load_observer',return_value=(None,None)),mock.patch.object(r,'load_owned_group_acceptance',return_value={'unit':True}),mock.patch.object(r,'supervise',return_value=value),redirect_stdout(output):
                    with self.assertRaises(SystemExit) as stopped:r.main()
                self.assertEqual(stopped.exception.code,2);lines=output.getvalue().splitlines();row=json.loads(lines[0]);series=json.loads(lines[-1])
                self.assertFalse(row['accepted']);self.assertFalse(row['cleanupDisposition']['resourceComplete']);self.assertFalse(row['cleanupDisposition']['deliveredSignals']);self.assertEqual(row['cleanupDisposition']['evidenceErrors'],['cleanup_audit_unavailable_or_malformed'])
                self.assertEqual(value['errors'],[]);self.assertTrue(pathlib.Path(series['series']).is_file())


class LateWindowClassifierVocabularyTests(unittest.TestCase):
    # Synthetic diagnostic bytes exercise the real classifier only. They do not
    # establish a live binding, timer, owned process or qualified native outcome.
    OBSERVER_EVENTS=(
        'attempt-admitted','attempt-bound','deadline-arm','phase-batch-accepted',
        'wait-admitted','wait-released','cancel-injection-enter','gate-cancel','gate-deadline')

    def encode(self,report,warning=False):
        lines=[]
        for index,row in enumerate(report['trace'],1):
            row['ordinal']=index
            if warning and row['event']=='exit-requested':
                lines.append(json.dumps({'level':'warn','target':r.QUIT_TARGET,'msg':r.DEADLINE}))
            lines.append(json.dumps({'level':'info','target':r.CONTROL_TARGET,'msg':json.dumps(row)}))
        return ('\n'.join(lines)+'\n').encode()

    def selected_fixture(self,case):
        _,context,_=fixture('complete' if case=='late-ipc-150' else 'deadline')
        _,report=late_window_fixture(case)
        context['case']=case
        report['compiledInputs']=context['inputs']
        report['trace'][0]['data'].update(
            binary=context['binary'],root=context['root'],compiledInputs=context['inputs'])
        return self.encode(report,warning=case=='late-ipc-350'),context,report

    def vocabulary_fixture(self,event):
        _,context,report=fixture('complete')
        context['case']='late-ipc-150'
        report.update(format=2,measurementContract='late-window-v1',case=context['case'])
        report['trace'][0]['data'].update(case=context['case'],measurementContract='late-window-v1')
        _,late=late_window_fixture()
        data=next(row['data'] for row in late['trace'] if row['event']==event)
        events=[(row['event'],row['data']) for row in report['trace']]
        events.insert(-2,(event,dict(data)))
        report['trace']=controls(events)
        return context,report

    def test_v2_fast_observer_vocabulary_preserves_real_cause_rules(self):
        data=self.selected_fixture('late-ipc-150')
        value=classify(data)
        self.assertEqual(value['errors'],[])
        self.assertEqual(value['cause'],'fixture_completed')
        self.assertEqual(value['candidates'],['fixture_completed'])
        self.assertIsNone(value['attempt'])
        self.assertFalse(value['processDeadlineWitness'])
        self.assertEqual(value['controls'],data[2]['trace'])
        # Observer rows cannot replace the existing completion marker.
        _,context,report=self.selected_fixture('late-ipc-150')
        report['trace']=[row for row in report['trace'] if row['event']!='fixture-complete-intent']
        no_completion=classify((self.encode(report),context,report))
        self.assertEqual(no_completion['errors'],[])
        self.assertEqual(no_completion['cause'],'unknown')
        self.assertEqual(no_completion['candidates'],[])
        # Even valid v2 vocabulary cannot bypass competing process authority.
        interrupted=classify(data,signals=[{'ns':7_000_000_000,'signal':15,
                                          'returned':False,'errno':errno.EPERM}])
        self.assertEqual(interrupted['cause'],'conflicting')
        _,context,report=self.selected_fixture('late-ipc-150')
        report['trace']=[row for row in report['trace'] if row['event']!='cancel-return']
        no_return=classify((self.encode(report),context,report))
        self.assertEqual(no_return['cause'],'unknown')
        self.assertIn('ambiguous competing attempts',no_return['errors'])

    def test_v2_slow_observer_vocabulary_preserves_warning_attempt_join(self):
        data=self.selected_fixture('late-ipc-350')
        value=classify(data)
        self.assertEqual(value['errors'],[])
        self.assertEqual(value['cause'],'native_deadline')
        self.assertEqual(value['attempt'],1) # actual emitted attempt, not actual gate epoch41
        self.assertEqual(value['candidates'],['native_deadline'])
        self.assertTrue(value['processDeadlineWitness'])
        warning_position=next(i for i,row in enumerate(data[2]['trace'])
                              if row['event']=='exit-requested')
        self.assertEqual(len(value['rawCauseRecords']),1)
        self.assertEqual(value['rawCauseRecords'][0]['controlCount'],warning_position)
        # A captured Deadline row alone must not manufacture the process cause.
        _,context,report=self.selected_fixture('late-ipc-350')
        no_warning=classify((self.encode(report),context,report))
        self.assertEqual(no_warning['errors'],[])
        self.assertEqual(no_warning['cause'],'unknown')
        self.assertEqual(no_warning['candidates'],[])
        self.assertIsNone(no_warning['attempt'])
        self.assertFalse(no_warning['processDeadlineWitness'])

    def test_observer_vocabulary_is_closed_outside_selected_v2_contract(self):
        variants=('non-selected','format-one','format-missing','report-contract-wrong',
                  'report-contract-missing','start-contract-wrong','start-contract-missing',
                  'report-case-mismatch')
        for event in self.OBSERVER_EVENTS:
            for variant in variants:
                with self.subTest(event=event,variant=variant):
                    context,report=self.vocabulary_fixture(event)
                    start=report['trace'][0]['data']
                    if variant=='non-selected':
                        context['case']=report['case']=start['case']='hung-webview'
                    elif variant=='format-one': report['format']=1
                    elif variant=='format-missing': del report['format']
                    elif variant=='report-contract-wrong': report['measurementContract']='other'
                    elif variant=='report-contract-missing': del report['measurementContract']
                    elif variant=='start-contract-wrong': start['measurementContract']='other'
                    elif variant=='start-contract-missing': del start['measurementContract']
                    else: report['case']='late-ipc-350'
                    value=classify((self.encode(report),context,report))
                    self.assertEqual(value['cause'],'unknown')
                    self.assertTrue(value['errors'])
        context,report=self.vocabulary_fixture('attempt-bound')
        next(row for row in report['trace'] if row['event']=='attempt-bound')['event']='observer-unknown'
        unknown=classify((self.encode(report),context,report))
        self.assertEqual(unknown['cause'],'unknown')
        self.assertTrue(unknown['errors'])


class LeaveAcknowledgementTests(unittest.TestCase):
    def test_actual_leave_acknowledgement_is_true_in_both_boundary_cases(self):
        for case in ('late-ipc-150','late-ipc-350'):
            with self.subTest(case=case):
                cause,report=late_window_fixture(case)
                result=r.timing_evidence(case,cause,report)
                self.assertTrue(result['accepted'],result['errors'])
    def test_nonacknowledgements_never_claim_completed_leave(self):
        for invalid in (None,False,1,'true',{},[]):
            with self.subTest(value=invalid):
                cause,report=late_window_fixture()
                row=next(row for row in cause['controls'] if row['event']=='frontend' and row['data'].get('stage')=='leave' and row['data'].get('edge')=='complete')
                row['data']['result']['value']=invalid
                result=r.timing_evidence('late-ipc-150',cause,report)
                self.assertFalse(result['accepted'])
                self.assertIn('leave',result['errors'][0])



def observed_cleanup_fixture():
    # Descriptive pure protocol data, never an accepted host qualification.
    owned={'pid':401,'ppid':400,'uid':501,'pgid':401,'sid':401,'start':[1800000000,12],'key':'401:1800000000:12'}
    c=2_000_000_000;retained=c+1_000_000
    signals=[{'ns':c+100_000_000,'signal':15,'returned':False,'errno':errno.EPERM,'error':'Operation not permitted'},
             {'ns':c+3_100_000_000,'signal':9,'returned':False,'errno':errno.EPERM,'error':'Operation not permitted'}]
    binding={'requestedPid':401,'returnedBytes':136,'immediateErrno':0,'fieldsAvailable':True,'fields':{'pid':401,'ppid':400,'uid':501,'pgid':401,'startSeconds':1800000000,'startMicros':12,'status':2}}
    exit_observation={'requestedPid':401,'returnedBytes':136,'immediateErrno':0,'fieldsAvailable':True,'fields':dict(binding['fields'],status=5),'monotonicCompletedNs':retained,'ownedKey':owned['key']}
    def absence(identity,ns):return {'requestedPid':401,'returnedBytes':0,'immediateErrno':errno.ESRCH,'fieldsAvailable':False,'fields':None,'monotonicStartedNs':ns,'monotonicCompletedNs':ns+1000,'ownedKey':owned['key'],'observationId':identity}
    a=absence(3,c+5_100_000_000);b=absence(4,c+6_200_000_000)
    groups=[{'ns':ns,'startedNs':ns,'completedNs':ns+1000,'returned':False,'errno':errno.ESRCH,'error':'No such process'} for ns in (c+5_030_000_000,c+6_130_000_000)]
    value={'control':False,'case':'late-ipc-150','root':'/pure-owned-evidence','owned':owned,'bindingRaw':binding,'bindingError':None,
           'startupLayout':{'pure':'not a host qualification'},'command':['/pure/native-read-smoke'],'t0Ns':1_000_000_000,'cleanupOriginNs':c,'endedNs':c+10_001_000_000,'actualElapsedNs':c+9_001_000_000,'declaredMaximumNs':85_000_000_000,
           'runnerSha256':'1'*64,'binarySha256':'2'*64,'nativeReportSha256':'3'*64,'readerAcceptance':{'path':'/pure/reader','sha256':'4'*64},'ownershipAcceptance':{'path':'/pure/owner','sha256':'5'*64},'runtime':{'pureProtocolOnly':True},'inputs':{'aggregateDigest':'6'*64},
           'retainedExitObservationNs':retained,'signals':signals,'signalsClosedNs':c+5_010_000_000,'reapStatus':0,'exitCode':0,'leaderAbsenceQualified':True,'groupAbsent':True,'groupSamples':groups,'cleanupComplete':True,'cleanupEvidenceBroken':False,'inputsStable':True,'pipeEof':{'stdout':True,'stderr':True},
           'leaderBook':{'errors':[],'evidenceBroken':False,'records':{owned['key']:{**owned,'state':'absence-evidence-ready','last':b,'absence':[3,4],'proof':[3,4]}}},
           'errors':[{'signalError':row} for row in signals],'nativeExit':{'cause':'fixture_completed','errors':[]},'timing':{'accepted':True}}
    audit=[{'kind':'startup-layout','ns':1_000_000_000,'layout':value['startupLayout']},
           {'kind':'launch','ns':1_010_000_000,'pid':401,'command':value['command'],'t0':value['t0Ns'],'runnerSha256':value['runnerSha256'],'binarySha256':value['binarySha256']},
           {'kind':'ownership-bound','ns':1_020_000_000,'owned':owned,'pgid':401,'sid':401},
           {'kind':'retained-exit','ns':retained+1000,'observation':exit_observation},
           *[{'kind':'signal-attempt','ns':row['ns']+1000,'signal':row,'completedNs':row['ns']+1000} for row in signals],
           {'kind':'signals-closed','ns':value['signalsClosedNs'],'closedNs':value['signalsClosedNs']},
           {'kind':'reap-attempt','ns':c+5_019_000_000,'raw':{'pid':401,'status':0,'errno':None,'error':None}},
           {'kind':'reaped','ns':c+5_020_000_000,'status':0,'exitCode':0},
           *[{'kind':'leader-observation','ns':row['monotonicCompletedNs'],'raw':row} for row in (a,b)],
           *[{'kind':'group-observation','ns':row['completedNs'],'raw':{k:v for k,v in row.items() if k!='ns'},'originalPgid':401} for row in groups]]
    audit.sort(key=lambda row:row['ns']);return value,audit


class ObservationalCleanupDisposition(unittest.TestCase):
    def test_failed_postexit_signals_preserve_diagnostics_but_record_resource_absence(self):
        value,audit=observed_cleanup_fixture();before=json.dumps(value,sort_keys=True)
        result=r.cleanup_disposition(value,audit)
        self.assertTrue(result['resourceComplete']);self.assertEqual(result['kind'],'observed_absent_after_natural_exit_with_failed_signals');self.assertFalse(result['deliveredSignals']);self.assertEqual(result['diagnostics'],value['errors']);self.assertEqual(json.dumps(value,sort_keys=True),before)
    def test_existing_delivered_and_absent_control_stays_distinct(self):
        value,audit=observed_cleanup_fixture()
        for row in value['signals']:row.update(returned=True,errno=None,error=None)
        value['errors']=[];result=r.cleanup_disposition(value,audit)
        self.assertTrue(result['resourceComplete']);self.assertTrue(result['deliveredSignals']);self.assertEqual(result['kind'],'delivered_and_absent')
    def test_each_missing_or_uncertain_resource_fact_denies_observational_completion(self):
        changes=[('cleanupComplete',False),('leaderAbsenceQualified',False),('groupAbsent',False),('cleanupEvidenceBroken',True),('inputsStable',False),('reapStatus',9),('exitCode',-9),('bindingError','wrong owner'),('pipeEof',{'stdout':True,'stderr':False}),('ownershipAcceptance',None),('signalsClosedNs',None),('nativeReportSha256','bad')]
        for key,replacement in changes:
            with self.subTest(key=key):
                value,audit=observed_cleanup_fixture();value[key]=replacement
                self.assertFalse(r.cleanup_disposition(value,audit)['resourceComplete'])
    def test_live_or_unavailable_group_and_unqualified_original_pid_never_clear(self):
        for outcome in ({'returned':True,'errno':None},{'returned':False,'errno':errno.EPERM},{'returned':False,'errno':None}):
            with self.subTest(group=outcome):
                value,audit=observed_cleanup_fixture();value['groupSamples'][-1].update(outcome)
                self.assertFalse(r.cleanup_disposition(value,audit)['resourceComplete'])
        value,audit=observed_cleanup_fixture();value['leaderBook']['records'][value['owned']['key']]['proof']=[3,3]
        self.assertFalse(r.cleanup_disposition(value,audit)['resourceComplete'])
    def test_early_failed_signal_missing_actual_reap_other_errors_or_changed_binding_deny(self):
        value,audit=observed_cleanup_fixture();value['retainedExitObservationNs']=value['signals'][0]['ns']+1
        self.assertFalse(r.cleanup_disposition(value,audit)['resourceComplete'])
        value,audit=observed_cleanup_fixture();audit[:]=[row for row in audit if row['kind']!='reaped']
        self.assertFalse(r.cleanup_disposition(value,audit)['resourceComplete'])
        value,audit=observed_cleanup_fixture();value['errors'].append({'observerError':'unavailable'})
        self.assertFalse(r.cleanup_disposition(value,audit)['resourceComplete'])
        value,audit=observed_cleanup_fixture();value['bindingRaw']['fields']['pgid']=999
        self.assertFalse(r.cleanup_disposition(value,audit)['resourceComplete'])
    def test_native_aggregation_requires_its_own_positive_original_exit_and_timing(self):
        value,audit=observed_cleanup_fixture();self.assertTrue(r.native_attempt_accepted(value,audit))
        for cause in ('unknown','conflicting'):
            value,audit=observed_cleanup_fixture();value['nativeExit']['cause']=cause
            self.assertFalse(r.native_attempt_accepted(value,audit))
        value,audit=observed_cleanup_fixture();value['timing']['accepted']=False
        self.assertFalse(r.native_attempt_accepted(value,audit))
    def test_observation_cannot_make_fixed_live_member_qualification_pass(self):
        value,audit=observed_cleanup_fixture();value['control']=True;value['case']='leader-exit'
        self.assertFalse(r.control_evidence(value,b'')['accepted'])


if __name__=='__main__': unittest.main()
