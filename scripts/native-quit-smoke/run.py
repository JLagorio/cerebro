#!/usr/bin/env python3
"""Root-only closed M93 fixture supervisor. No builds, app discovery or generic process cleanup.
Fresh ownership/group qualification is separate from the accepted known-PID reader.
The only potentially consuming child operation is waitpid AFTER signal closure.
"""
import argparse, ctypes, errno, hashlib, importlib.util, json, os, pathlib
import selectors, signal, stat, subprocess, sys, tempfile, time

CASES = ('failed-owner','pending-owner','late-unresolved','late-ipc-150','late-ipc-350',
         'second-quit','expired-second-quit','hung-webview')
CONTROL_TARGET = 'cerebro_lib::native_quit_smoke'
QUIT_TARGET = 'cerebro_lib::shell::quit'
DEADLINE = 'the webview did not finish saving within 5000 ms, so Cerebro quits without it'
OBSERVER_REL = '.superpowers/sdd/2026-10-23-m93-m99-master-roadmap/m93-scale-20261024/integrated-production/text-resting-clip-integration/wide-filter-diagnostic/selection-range-cleanup-observer-implementation-v1/cleanup_observer.py'
OBSERVER_HASH = '0684c04e32916893cce43dfd9b62a354325f7edd1c52b158c8d1e7f269f1842c'
ACCEPTANCE_HASH = 'c2fa762dd241e71b3e8c828d898c5c909c0f2af063481a8f50755cce981ef96c'
PYTHON_LAUNCHER = '/usr/bin/python3'
PYTHON_LAUNCHER_HASH = '7f30f076d0e9c38f772a76449fca9da8cf97f6a3d43b94c90a00e4f9ce7ad39e'
SCOPE = 'cerebro-native-producer-inputs-v1'
DRAFT = 'M93 controlled retained draft\n'
KEPT = [] # Strong lifetime retention even on an unresolved reap. No Popen destructor while authority is open.


def read_regular(path, maximum, private=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
            raise ValueError('bounded regular file required')
        if private and (before.st_uid != os.geteuid() or before.st_mode & 0o077):
            raise ValueError('private evidence ownership/mode')
        data = bytearray()
        while len(data) <= maximum:
            block = os.read(fd, min(65536,maximum+1-len(data)))
            if not block: break
            data.extend(block)
        after = os.fstat(fd)
        if len(data) > maximum or len(data) != after.st_size or any(getattr(before,k) != getattr(after,k) for k in ('st_dev','st_ino','st_size','st_mtime_ns')):
            raise ValueError('file changed/bound exceeded')
        return bytes(data)
    finally: os.close(fd)


def digest(path, maximum=2*1024*1024*1024):
    return hashlib.sha256(read_regular(path, maximum)).hexdigest()


def write_private(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        view = memoryview(data)
        while view:
            count = os.write(fd, view)
            if count <= 0: raise OSError('short evidence write')
            view = view[count:]
        os.fsync(fd)
    finally: os.close(fd)


def write_json(path, value):
    write_private(path, (json.dumps(value,indent=2)+'\n').encode())


def source_identity(repo):
    raw = read_regular(repo/'conformance/outcomes/native-inputs.v1.json',512*1024)
    inventory = json.loads(raw)
    paths = inventory['paths']
    if inventory.get('scope') != SCOPE or inventory.get('version') != 1 or not isinstance(paths,list) or len(paths)>2048 or paths != sorted(set(paths)):
        raise ValueError('native inventory malformed')
    discovered=set(); visits=0
    def walk(name,depth=0):
        nonlocal visits
        visits+=1
        if visits>8192 or depth>16: raise ValueError('native inventory walk cap')
        p=repo/name; meta=p.lstat()
        if stat.S_ISLNK(meta.st_mode): raise ValueError('native inventory symlink')
        if stat.S_ISREG(meta.st_mode): discovered.add(name); return
        if not stat.S_ISDIR(meta.st_mode): raise ValueError('native inventory type')
        with os.scandir(p) as entries:
            for entry in entries:
                if entry.name=='.DS_Store' and entry.is_file(follow_symlinks=False):
                    visits+=1; continue
                walk(name+'/'+entry.name,depth+1)
    for name in ('src-tauri/src','shared','src-tauri/fixtures','conformance','src-tauri/build_support','src-tauri/capabilities'):
        walk(name)
    discovered.update(('src-tauri/build.rs','src-tauri/Cargo.toml','src-tauri/Cargo.lock',
        'src-tauri/tauri.conf.json','src-tauri/native-read-smoke/tauri.conf.json','src-tauri/icons/32x32.png',
        'src-tauri/icons/icon.icns','src-tauri/clippy.toml','src-tauri/Info.plist','rust-toolchain.toml',
        'conformance/outcomes/native.rs','scripts/outcomes/native-inputs.ts','scripts/outcomes/native-capture.ts',
        'scripts/outcomes/retrieval.ts',
        'scripts/native-credential-smoke/run.py','scripts/native-quit-smoke/run.py','scripts/native-quit-smoke/test_run.py'))
    if paths!=sorted(discovered): raise ValueError('native inventory path coverage changed; root must regenerate/check')
    h = hashlib.sha256((SCOPE+'\n').encode()); total=0
    for name in paths:
        p = checked_local(repo,name)
        data = read_regular(p,4*1024*1024); total += len(data)
        if total>64*1024*1024: raise ValueError('native inventory total cap')
        h.update(('%s\0%d\0%s\n'%(name,len(data),hashlib.sha256(data).hexdigest())).encode())
    return {'scope':SCOPE,'aggregateDigest':h.hexdigest(),'fileCount':len(paths),'totalBytes':total,
            'smokeConfigSha256':digest(repo/'src-tauri/native-read-smoke/tauri.conf.json')}


def checked_local(repo,name):
    if not isinstance(name,str) or '\0' in name or pathlib.PurePosixPath(name).is_absolute() or '..' in pathlib.PurePosixPath(name).parts:
        raise ValueError('nonlocal input')
    p = repo/name
    # Canonical node_modules resolutions are in the manifest; reject symlink aliases.
    if p.resolve(strict=True) != p or not p.is_relative_to(repo): raise ValueError('input identity alias')
    return p


def bundle_identity(repo):
    manifest_path = repo/'conformance/native-read-smoke/web/quit-build.json'
    limits = json.loads(read_regular(repo/'conformance/native-read-smoke/bundle-limits.v1.json',4096))
    if (not isinstance(limits,dict) or set(limits)!={'version','inputFiles','manifestBytes'}
            or type(limits['version']) is not int or limits['version']!=1
            or any(type(limits[key]) is not int or not 0<limits[key]<=2**53-1 for key in ('inputFiles','manifestBytes'))):
        raise ValueError('bundle limits identity')
    data = read_regular(manifest_path,limits['manifestBytes']); manifest=json.loads(data)
    if manifest.get('format') != 1 or manifest.get('entry') != 'conformance/native-read-smoke/quit.tsx':
        raise ValueError('frontend build manifest identity')
    rows = manifest['inputs']+manifest['assets']
    if len(manifest['inputs'])>limits['inputFiles'] or len(manifest['assets'])>64 or len(manifest['virtual'])>512: raise ValueError('bundle closure cap')
    for row in rows:
        p=checked_local(repo,row['path']); b=read_regular(p,4*1024*1024)
        if row['bytes'] != len(b) or row['sha256'] != hashlib.sha256(b).hexdigest(): raise ValueError('frontend input/asset drift')
    contract=manifest.get('entryContract',{})
    entry=[row for row in manifest['assets'] if row['path']=='conformance/native-read-smoke/web/quit.js']
    if (contract.get('fileName')!='quit.js' or contract.get('requiredExport')!='mountQuitFixture'
            or contract.get('entrySignatures')!='strict' or 'mountQuitFixture' not in contract.get('exports',[])
            or len(entry)!=1 or contract.get('generatedSha256')!=entry[0]['sha256']):
        raise ValueError('generated named mount entry contract missing/drifted')
    required={'src/app/quit.ts','src/app/QuitScreen.tsx','src/editor/documentOwner.ts',
              'src/editor/openPages.ts','package.json','pnpm-lock.yaml','conformance/native-read-smoke/build.mjs',
              'conformance/native-read-smoke/quit-build-contract.mjs',
              'conformance/native-read-smoke/bundle-limits.v1.json'}
    if not required.issubset({x['path'] for x in manifest['inputs']}): raise ValueError('real quit module closure missing')
    return {'manifestSha256':hashlib.sha256(data).hexdigest(),'entryContract':contract,'inputs':manifest['inputs'],'assets':manifest['assets']}


def load_observer(repo,acceptance,expected):
    if expected != ACCEPTANCE_HASH: raise ValueError('exact accepted reader receipt required')
    p=repo/OBSERVER_REL
    if digest(p) != OBSERVER_HASH: raise ValueError('cleanup reader changed')
    spec=importlib.util.spec_from_file_location('m93_accepted_cleanup_reader',p)
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    qualification=module.load_accepted_qualification(acceptance,expected)
    return module,qualification


class Sigaction(ctypes.Structure):
    # Darwin user struct sigaction, sys/signal.h (not kernel __sigaction).
    _fields_=[('handler',ctypes.c_void_p),('mask',ctypes.c_uint32),('flags',ctypes.c_int)]


def bind_qualified_runtime(qualified,observed,launcher):
    """Pure identity check; qualified comes only from the exact accepted loader below.
    The system launcher and Xcode interpreter are deliberately separate identities.
    """
    if not isinstance(qualified,dict) or observed!=qualified:
        raise ValueError('actual runtime differs from accepted runtime facts')
    if qualified.get('invocation')!=PYTHON_LAUNCHER or qualified.get('platform')!='darwin' or qualified.get('implementation')!='cpython':
        raise ValueError('accepted Darwin/system-Python runtime required')
    if launcher!={'path':PYTHON_LAUNCHER,'sha256':PYTHON_LAUNCHER_HASH}:
        raise ValueError('exact reviewed system-Python launcher required')
    executable=qualified.get('executable'); executable_hash=qualified.get('executableSha256')
    if not isinstance(executable,str) or not executable.startswith('/') or not isinstance(executable_hash,str) or len(executable_hash)!=64:
        raise ValueError('accepted actual interpreter identity missing')
    return {'launcher':dict(launcher),'interpreter':{'path':executable,'sha256':executable_hash},
            'version':qualified.get('version'),'platform':qualified['platform']}


def establish_waitable_children(runtime_binding):
    if runtime_binding['launcher']['path']!=PYTHON_LAUNCHER or sys.platform != 'darwin' or ctypes.sizeof(Sigaction)!=16 or Sigaction.mask.offset!=8 or Sigaction.flags.offset!=12:
        raise RuntimeError('reviewed Darwin/system-Python sigaction ABI required')
    libc=ctypes.CDLL('/usr/lib/libSystem.B.dylib',use_errno=True)
    libc.sigaction.argtypes=[ctypes.c_int,ctypes.POINTER(Sigaction),ctypes.POINTER(Sigaction)]
    libc.sigaction.restype=ctypes.c_int
    action=Sigaction(None,0,0); old=Sigaction(); observed=Sigaction()
    for new,prior in [(ctypes.byref(action),ctypes.byref(old)),(None,ctypes.byref(observed))]:
        ctypes.set_errno(0); rc=libc.sigaction(signal.SIGCHLD,new,prior); error=ctypes.get_errno()
        if rc != 0: raise OSError(error,'SIGCHLD sigaction')
    if observed.handler is not None or observed.flags & 0x0020 or observed.mask != 0:
        raise RuntimeError('SIGCHLD must be default, SA_NOCLDWAIT clear and mask empty')
    return {'runtimeBinding':runtime_binding,'size':ctypes.sizeof(Sigaction),'offsets':{'handler':0,'mask':8,'flags':12},
            'readback':{'handler':observed.handler,'mask':observed.mask,'flags':observed.flags},
            'libc':'/usr/lib/libSystem.B.dylib','saNoCldWait':0x0020,'signal':int(signal.SIGCHLD)}


class Lifecycle:
    """Pure finite authority/absence reducer; not a host qualification."""
    def __init__(self,t0):
        self.t0=t0; self.c=None; self.phase='open'; self.bound=False
        self.reaped=False; self.reap_status=None; self.retained_exit_ns=None
        self.signals=[]; self.errors=[]; self.group_samples=[]; self.group_proof=[]
        self.closed_ns=None; self.audit_broken=False
    def terminal(self,now):
        if self.c is None: self.c=min(now,self.t0+75_000_000_000)
    def signal_attempt(self,now,signo,result):
        if self.phase!='open' or not self.bound or self.reaped: raise ValueError('nonzero signal authority closed/unbound')
        if self.c is None or now>=self.c+5_000_000_000: raise ValueError('signal outside absolute phase')
        if signo not in (signal.SIGTERM,signal.SIGKILL) or any(x['signal']==int(signo) for x in self.signals): raise ValueError('signal fixed once only')
        required=self.c+(3_000_000_000 if signo==signal.SIGKILL else 0)
        if now<required: raise ValueError('signal before phase')
        row={'ns':now,'signal':int(signo),**result}; self.signals.append(row)
        if result.get('errno') is not None: self.errors.append({'signalError':row})
    def close(self,now):
        if self.phase=='open': self.phase='closed'; self.closed_ns=now
    def consume(self,now,status):
        if self.phase!='closed' or self.c is None or now>=self.c+7_000_000_000: raise ValueError('consume outside closed reap phase')
        self.reaped=True; self.reap_status=status; self.phase='reaped'
    def group(self,now,result):
        if not self.reaped: raise ValueError('absence before actual reap')
        if self.group_samples and now-self.group_samples[-1]['ns']<1_000_000_000: return False
        row={'ns':now,**result}; self.group_samples.append(row)
        if result.get('errno')==errno.ESRCH and result.get('returned') is False:
            self.group_proof=(self.group_proof+[now])[-2:]
        else: self.group_proof=[]
        return len(self.group_proof)==2
    def cleanup_complete(self,leader_absent):
        return self.reaped and leader_absent and len(self.group_proof)==2 and not self.audit_broken


def parse_stream(raw,eof=True,capped=False):
    errors=[]; controls=[]; causes=[]
    if not eof or capped or (raw and not raw.endswith(b'\n')): errors.append('stderr incomplete/truncated')
    for ordinal,line in enumerate(raw.splitlines(),1):
        try: record=json.loads(line)
        except (ValueError,UnicodeDecodeError):
            if b'cerebro' in line or line.startswith(b'{'): errors.append('malformed diagnostic/control line')
            continue
        if not isinstance(record,dict): continue
        if record.get('target')==CONTROL_TARGET:
            try:
                row=json.loads(record['msg'])
                if record.get('level')!='info' or not isinstance(row,dict) or set(row)!={'ordinal','ms','pid','event','data'}:
                    raise ValueError('control shape')
                if not isinstance(row['event'],str) or not isinstance(row['data'],dict): raise ValueError('control event/data')
                d=row['data']
                if row['event'] in ('request-before','request-after','emitted-request'):
                    if type(d.get('call')) is not int or d['call']<=0: raise ValueError('control call')
                    if row['event']=='emitted-request' and (type(d.get('attempt')) is not int or d['attempt']<=0): raise ValueError('control attempt')
                if row['event']=='frontend' and d.get('kind') in ('stage','stayed','hang-armed'):
                    if not isinstance(d.get('snapshot'),dict) or not isinstance(d.get('ms'),(int,float)) or not 0<=d['ms']<=60000:
                        raise ValueError('frontend control snapshot/time')
                controls.append(row)
            except (ValueError,KeyError,TypeError): errors.append('malformed control record')
        elif record.get('target')==QUIT_TARGET and record.get('level')=='warn':
            msg=record.get('msg')
            kind=None
            if msg==DEADLINE: kind='native_deadline'
            elif isinstance(msg,str) and msg.startswith('the quit request could not reach the webview (') and msg.endswith('), so Cerebro quits now'): kind='emit_failure'
            elif isinstance(msg,str) and msg.startswith('the quit deadline could not start (') and msg.endswith('), so Cerebro quits now'): kind='timer_spawn_failure'
            if kind: causes.append({'cause':kind,'line':ordinal,'controlCount':len(controls),'raw':record})
    return controls,causes,errors


def classify_exit(raw,context,report,retained_exit_ns,reap_status,signals,eof=True,capped=False):
    controls,causes,errors=parse_stream(raw,eof,capped)
    # Process ownership is supplied only by the independently bound direct Popen child.
    if retained_exit_ns is None or reap_status is None: errors.append('actual retained exit/reap missing')
    if reap_status != 0: errors.append('owned child did not exit normally with status 0')
    if not context.get('ownershipBound'): errors.append('owned child binding missing')
    previous_ms=-1; calls={}; eligible=[]; canceled=set(); candidate=[]; before=set(); attempts=[]
    allowed={'case-start','request-before','request-after','emitted-request','frontend','cancel-ingress',
             'cancel-dispatch','cancel-return','finish-dispatch','finish-result','survived','probe-cancel-dispatch',
             'probe-cancel-return','fixture-complete-intent','fixture-error','watchdog-intent','exit-requested','exit'}
    if (isinstance(report,dict) and type(report.get('format')) is int and report['format']==2
            and context.get('case') in ('late-ipc-150','late-ipc-350')
            and report.get('case')==context['case']
            and report.get('measurementContract')=='late-window-v1'
            and controls and controls[0]['event']=='case-start'
            and controls[0]['data'].get('case')==context['case']
            and controls[0]['data'].get('measurementContract')=='late-window-v1'):
        allowed.update({'attempt-admitted','attempt-bound','deadline-arm','phase-batch-accepted',
                        'wait-admitted','wait-released','cancel-injection-enter','gate-cancel','gate-deadline'})
    for i,row in enumerate(controls):
        if row.get('ordinal')!=i+1 or row.get('pid')!=context.get('pid') or not isinstance(row.get('ms'),(int,float)) or not 0<=row['ms']<=90000 or row['ms']<previous_ms or row.get('event') not in allowed:
            errors.append('control identity/order'); continue
        previous_ms=row['ms']; event=row['event']; d=row.get('data',{})
        if event=='case-start':
            if i!=0 or d.get('root')!=context.get('root') or d.get('binary')!=context.get('binary') or d.get('case')!=context.get('case') or d.get('compiledInputs')!=context.get('inputs'):
                errors.append('bootstrap process/binary/root/input join')
        elif event=='request-before':
            call=d.get('call')
            if call in before or call != len(before)+1: errors.append('request call order')
            before.add(call)
        elif event=='request-after':
            if d.get('call') not in before: errors.append('request after without before')
        elif event=='emitted-request':
            call=d.get('call'); attempt=d.get('attempt')
            if call not in before or call in calls or attempt!=len(attempts)+1: errors.append('unsolicited/duplicate admitted request')
            calls[call]=attempt; attempts.append(attempt)
            if eligible and not all(a in canceled for a in eligible): errors.append('ambiguous competing attempts')
            eligible=[attempt]
        elif event in ('cancel-return','probe-cancel-return'):
            if not eligible: errors.append('cancel without admitted request')
            canceled.update(eligible)
        elif event=='finish-result' and d.get('ok') is True: candidate.append('finish_quit')
        elif event=='fixture-complete-intent': candidate.append('fixture_completed')
        elif event=='watchdog-intent': candidate.append('smoke_watchdog')
        elif event=='fixture-error': errors.append('fixture error: '+str(d))
    if not controls or controls[0].get('event')!='case-start': errors.append('case bootstrap absent')
    if not any(x.get('event')=='exit' for x in controls): errors.append('native Exit absent')
    if not isinstance(report,dict) or report.get('traceBroken') is not False or report.get('trace')!=controls or report.get('nativePid')!=context.get('pid') or report.get('compiledInputs')!=context.get('inputs'):
        errors.append('native report/owned-pipe trace mismatch')
    attributed=None
    for cause in causes:
        # Reconstruct the eligible attempt at the actual warning position, not final trace.
        admitted=[]; cancel_seen=False
        for row in controls[:cause['controlCount']]:
            if row['event']=='emitted-request':
                if admitted and not cancel_seen: errors.append('ambiguous warning attempt join')
                admitted=[row['data']['attempt']]; cancel_seen=False
            elif row['event'] in ('cancel-return','probe-cancel-return'): cancel_seen=True
        if len(admitted)!=1: errors.append('warning attempt join missing')
        else: attributed=admitted[0]
        candidate.append(cause['cause'])
    competing_signals=[s for s in signals if retained_exit_ns is None or s['ns']<=retained_exit_ns]
    # Later cleanup attempts cannot cause an already-observed leader exit. Preserve every
    # signal result separately; failed attempts at uncertain ordering still block attribution.
    if competing_signals: candidate.append('supervisor_intervention')
    unique=set(candidate)
    cause=next(iter(unique)) if len(candidate)==1 and not errors else ('conflicting' if len(unique)>1 else 'unknown')
    return {'cause':cause,'attempt':attributed if cause in ('native_deadline','emit_failure','timer_spawn_failure') else None,
            'processDeadlineWitness':any(x['cause']=='native_deadline' for x in causes),
            'errors':errors,'candidates':candidate,'controls':controls,'rawCauseRecords':causes,
            'laterCleanupSignals':[s for s in signals if s not in competing_signals]}


class Audit:
    def __init__(self,path,life):
        self.life=life; self.rows=[]; self.bytes=0
        self.fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    def add(self,kind,**data):
        row={'kind':kind,'ns':time.monotonic_ns(),**data}
        encoded=(json.dumps(row,separators=(',',':'))+'\n').encode()
        if len(self.rows)>=128 or self.bytes+len(encoded)>65536:
            self.life.audit_broken=True; raise ValueError('cleanup audit cap')
        # Keep the raw observation in memory even if durable recording fails.
        self.rows.append(row); self.bytes+=len(encoded)
        try:
            view=memoryview(encoded)
            while view:
                n=os.write(self.fd,view)
                if n<=0: raise OSError('audit short write')
                view=view[n:]
        except Exception:
            self.life.audit_broken=True; raise
    def close(self):
        try: os.fsync(self.fd)
        finally: os.close(self.fd)


def raw_group(pgid,signo):
    try:
        os.killpg(pgid,signo)
        return {'returned':True,'errno':None,'error':None}
    except OSError as error:
        return {'returned':False,'errno':error.errno,'error':str(error)}


def raw_reap(pid):
    try:
        observed,status=os.waitpid(pid,os.WNOHANG)
        return {'pid':observed,'status':status,'errno':None,'error':None}
    except OSError as error:
        return {'pid':None,'status':None,'errno':error.errno,'error':str(error)}


def child_environment(root):
    allowed=('HOME','USER','LOGNAME','LANG','LC_ALL','TMPDIR','__CF_USER_TEXT_ENCODING')
    env={key:os.environ[key] for key in allowed if key in os.environ}
    env.update(PATH=str(root/'bin'),SHELL=str(root/'bin/smoke-shell'),CLAUDE_CONFIG_DIR=str(root/'claude-config'))
    return env


def directory_identity(path):
    meta=path.lstat()
    if (not path.is_absolute() or path.resolve(strict=True)!=path
            or not stat.S_ISDIR(meta.st_mode) or meta.st_uid!=os.geteuid()
            or stat.S_IMODE(meta.st_mode)&0o077):
        raise ValueError('canonical private owned directory required')
    return {'path':str(path),'device':meta.st_dev,'inode':meta.st_ino,
            'uid':meta.st_uid,'mode':stat.S_IMODE(meta.st_mode)}


def prepare_layout(evidence_root,control):
    evidence=directory_identity(evidence_root)
    native_root=evidence_root if control else evidence_root/'fixture'
    if not control: native_root.mkdir(mode=0o700) # create-only, initially empty.
    return {'evidence':evidence,'native':directory_identity(native_root)}


def validate_layout(layout,control,empty_native):
    evidence_root=pathlib.Path(layout['evidence']['path'])
    native_root=evidence_root if control else evidence_root/'fixture'
    if (directory_identity(evidence_root)!=layout['evidence']
            or directory_identity(native_root)!=layout['native']):
        raise ValueError('startup directory identity changed')
    if empty_native and not control and next(native_root.iterdir(),None) is not None:
        raise ValueError('native startup fixture must remain empty')
    return native_root


def supervise(repo,binary,case,parent,observer,qualification,control=False,reader_acceptance=None,ownership_acceptance=None):
    # All evidence preparation that may fail is before Popen. No external waiter/thread.
    identity=None if control else source_identity(repo)
    bundle=None if control else bundle_identity(repo)
    binary_hash=digest(binary); runner_hash=digest(pathlib.Path(__file__).resolve())
    root=pathlib.Path(tempfile.mkdtemp(prefix='cerebro-m93-quit-',dir=parent)).resolve()
    os.chmod(root,0o700)
    layout=prepare_layout(root,control)
    native_root=pathlib.Path(layout['native']['path']); native_report=native_root/'report.json'
    command=([str(binary),'-B',str(pathlib.Path(__file__).resolve()),'--toy-leader',case]
             if control else [str(binary),str(native_root),'--quit-'+case])
    if reader_acceptance is None or digest(repo/OBSERVER_REL)!=OBSERVER_HASH:
        raise ValueError('fresh exact accepted known-identity reader required')
    qualification=observer.load_accepted_qualification(reader_acceptance,ACCEPTANCE_HASH)
    runtime_row=qualification.binding['candidateReceipt']
    qualified_runtime=observer.read_pinned_json(runtime_row['path'],runtime_row['sha256'])['runtime']
    runtime_binding=bind_qualified_runtime(qualified_runtime,observer.runtime_facts(),
        {'path':PYTHON_LAUNCHER,'sha256':digest(PYTHON_LAUNCHER)})
    sigaction=establish_waitable_children(runtime_binding)
    ownership_pin=None if control else load_owned_group_acceptance(ownership_acceptance,repo,observer,ACCEPTANCE_HASH)
    reader=observer.Reader(); book=observer.Book()
    t0=time.monotonic_ns(); life=Lifecycle(t0); audit=Audit(root/'cleanup.jsonl',life)
    process=None; scheduler=None; key=None; owned=None; raw_binding=None
    streams={}; eof={}; selector=selectors.DefaultSelector(); arrivals=[]; stderr_scanned=0
    errors=[]; result=None; binding_error=None; last_group_ns=0; reap_done=False; next_reap_ns=0
    def safe_audit(kind,**data):
        try: audit.add(kind,**data)
        except Exception as error:
            errors.append({'auditError':repr(error),'kind':kind})
            life.audit_broken=True; life.terminal(time.monotonic_ns())
    def sink(raw): audit.add('leader-observation',raw=raw)
    def cleanup_step(now):
        nonlocal last_group_ns,reap_done,next_reap_ns
        # One common sequence for ordinary termination and every postlaunch error.
        if life.c is None: return
        if now>=life.c+5_000_000_000 and life.phase=='open':
            life.close(now); safe_audit('signals-closed',closedNs=life.closed_ns)
        if life.phase=='open' and life.bound:
            signo=signal.SIGTERM if not life.signals else (signal.SIGKILL if len(life.signals)==1 and now>=life.c+3_000_000_000 else None)
            if signo is not None:
                called=time.monotonic_ns()
                if called<life.c+5_000_000_000:
                    raw=raw_group(owned['pgid'],signo)
                    life.signal_attempt(called,signo,raw)
                    safe_audit('signal-attempt',signal=life.signals[-1],completedNs=time.monotonic_ns())
        if life.phase=='closed' and now<life.c+7_000_000_000 and now>=next_reap_ns and not reap_done:
            next_reap_ns=now+1_000_000_000
            raw=raw_reap(process.pid); safe_audit('reap-attempt',raw=raw)
            if raw['pid']==process.pid:
                life.consume(time.monotonic_ns(),raw['status']); reap_done=True
                process.returncode=os.waitstatus_to_exitcode(raw['status'])
                safe_audit('reaped',status=raw['status'],exitCode=process.returncode)
            elif raw['errno'] is not None:
                errors.append({'reapError':raw}); reap_done=True
        if life.reaped and now-last_group_ns>=1_000_000_000:
            called=time.monotonic_ns(); last_group_ns=called
            raw=raw_group(owned['pgid'],0) if owned else {'returned':False,'errno':None,'error':'unbound'}
            raw.update(startedNs=called,completedNs=time.monotonic_ns())
            life.group(called,raw); safe_audit('group-observation',raw=raw,originalPgid=None if owned is None else owned['pgid'])
    try:
        validate_layout(layout,control,True)
        audit.add('startup-layout',layout=layout)
        # Clock origin is immediately before the sole direct launch.
        t0=time.monotonic_ns(); life.t0=t0
        process=subprocess.Popen(command,cwd=repo,env=child_environment(native_root),start_new_session=True,
                                 stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        KEPT.append(process)
        for stream,name in ((process.stdout,'stdout'),(process.stderr,'stderr')):
            streams[name]=bytearray(); eof[name]=False; os.set_blocking(stream.fileno(),False)
            selector.register(stream,selectors.EVENT_READ,name)
        safe_audit('launch',pid=process.pid,command=command,t0=t0,binarySha256=binary_hash,
                   runnerSha256=runner_hash,sigaction=sigaction)
        try:
            raw_binding=reader.read(process.pid); fields=raw_binding.get('fields')
            if raw_binding.get('returnedBytes')!=136 or not fields or fields['pid']!=process.pid or fields['ppid']!=os.getpid() or fields['uid']!=os.geteuid() or fields['pgid']!=process.pid:
                raise ValueError('direct child parent/uid/group/full identity mismatch')
            pgid=os.getpgid(process.pid); sid=os.getsid(process.pid)
            if pgid!=process.pid or sid!=process.pid: raise ValueError('not new session/group')
            key=book.add(process.pid,[fields['startSeconds'],fields['startMicros']]); owned=dict(book.records[key])
            owned.update(uid=fields['uid'],ppid=fields['ppid'],pgid=pgid,sid=sid)
            life.bound=True
            scheduler=observer.Scheduler(reader,book,sink)
            scheduler.seed(raw_binding,key,'startup')
            safe_audit('ownership-bound',owned=owned,raw=raw_binding,pgid=pgid,sid=sid)
        except Exception as error:
            binding_error=repr(error); errors.append({'bindingError':binding_error,'raw':raw_binding})
            # No guessed group target. Closing is irreversible even if evidence write fails.
            life.close(time.monotonic_ns()); life.terminal(time.monotonic_ns())
            safe_audit('signals-closed-unbound',reason=binding_error)
        while time.monotonic_ns()<life.t0+85_000_000_000:
            now=time.monotonic_ns()
            if life.c is not None and now>=life.c+10_000_000_000: break
            if life.c is None and now>=life.t0+75_000_000_000:
                errors.append({'runCeiling':now}); life.terminal(now)
            if control and case=='leader-term' and life.c is None and now>=life.t0+2_000_000_000:
                life.terminal(now); safe_audit('control-term-trigger')
            if scheduler is not None:
                try: scheduler.tick('cleanup' if life.c is not None else 'run')
                except Exception as error:
                    errors.append({'observerError':repr(error)}); life.terminal(now)
                state=book.records[key]['state']
                if state=='retained-exited' and life.retained_exit_ns is None:
                    life.retained_exit_ns=book.records[key]['last']['monotonicCompletedNs']
                    safe_audit('retained-exit',observation=book.records[key]['last'])
                    life.terminal(now)
                elif state in ('different-identity','absence-evidence-ready') and not life.reaped:
                    # Unexpected loss while this sole parent still retains the leader.
                    errors.append({'ownershipContradiction':state}); life.close(now); life.terminal(now)
                    safe_audit('signals-closed-ownership-contradiction',state=state)
            if life.c is not None:
                cleanup_step(now)
                if now>=life.c+10_000_000_000: break
            timeout=0.05
            endpoint=life.c+10_000_000_000 if life.c is not None else life.t0+75_000_000_000
            timeout=min(timeout,max(0,(endpoint-time.monotonic_ns())/1e9))
            for selected,_ in selector.select(timeout):
                name=selected.data
                try: block=os.read(selected.fileobj.fileno(),8192)
                except BlockingIOError: continue
                except OSError as error:
                    errors.append({'pipeError':name,'errno':error.errno,'error':str(error)})
                    selector.unregister(selected.fileobj); life.terminal(time.monotonic_ns()); continue
                if not block:
                    eof[name]=True; selector.unregister(selected.fileobj); continue
                remaining=256*1024-len(streams[name]); arrival=time.monotonic_ns()
                arrivals.append({'stream':name,'ns':arrival,'offset':len(streams[name]),'receivedBytes':len(block)})
                streams[name].extend(block[:remaining])
                if name=='stderr':
                    complete=bytes(streams[name]).rfind(b'\n')+1
                    for line in bytes(streams[name][stderr_scanned:complete]).splitlines():
                        try:
                            diagnostic=json.loads(line)
                            if diagnostic.get('target')==CONTROL_TARGET:
                                marker=json.loads(diagnostic['msg'])
                                if marker.get('event') in ('fixture-error','watchdog-intent'):
                                    errors.append({'nativeTerminalMarker':marker}); life.terminal(arrival)
                        except (ValueError,TypeError,KeyError,AttributeError):
                            if CONTROL_TARGET.encode() in line:
                                errors.append({'malformedControlRaw':line.decode('utf8','backslashreplace')})
                                life.terminal(arrival)
                    stderr_scanned=complete
                if len(block)>remaining:
                    errors.append({'outputCap':name,'rawOverflowSha256':hashlib.sha256(block[remaining:]).hexdigest()})
                    selector.unregister(selected.fileobj); life.terminal(arrival)
        if life.phase=='open':
            life.close(time.monotonic_ns()); safe_audit('signals-closed-final',closedNs=life.closed_ns)
    except Exception as error:
        errors.append({'supervisorError':repr(error)})
        life.terminal(time.monotonic_ns())
        if process is not None:
            # Same C and absolute endpoints: failure recovery never appends a timeout.
            observer_failed=False
            while time.monotonic_ns()<life.c+10_000_000_000:
                now=time.monotonic_ns()
                try: cleanup_step(now)
                except Exception as cleanup_error:
                    errors.append({'cleanupError':repr(cleanup_error)})
                    life.audit_broken=True; life.close(time.monotonic_ns())
                    safe_audit('signals-closed-cleanup-error',closedNs=life.closed_ns)
                if scheduler is not None and not observer_failed:
                    try: scheduler.tick('failure-cleanup')
                    except Exception as read_error:
                        errors.append({'failureObserverError':repr(read_error)}); observer_failed=True
                time.sleep(min(0.05,max(0,(life.c+10_000_000_000-time.monotonic_ns())/1e9)))
        else:
            life.close(time.monotonic_ns()); safe_audit('signals-closed-no-child',closedNs=life.closed_ns)
    finally:
        # No Popen context manager, poll/wait/communicate/send_signal, destructor or finalizer
        # is used. An unresolved process remains retained in KEPT until supervisor exit.
        selector.close()
        if process:
            for stream in (process.stdout,process.stderr): stream.close()
        try: audit.close()
        except Exception as error: life.audit_broken=True; errors.append({'auditCloseError':repr(error)})
    ended=time.monotonic_ns()
    for name,data in streams.items(): write_private(root/(name+'.log'),data)
    report=None
    if not control:
        try:
            validate_layout(layout,control,False)
            report=json.loads(read_regular(native_report,65536,True))
        except Exception as error: errors.append({'reportError':repr(error)})
    context={'pid':None if process is None else process.pid,'binary':str(binary),'root':str(native_root),
             'case':case,'inputs':identity,'ownershipBound':life.bound}
    cause=None if control else classify_exit(bytes(streams.get('stderr',b'')),context,report,
            life.retained_exit_ns,life.reap_status,life.signals,eof.get('stderr',False),any('outputCap' in e for e in errors))
    leader_absent=key is not None and qualification.complete(book,key)
    cleanup=life.cleanup_complete(leader_absent)
    stable=False
    try:
        fresh_qualification=observer.load_accepted_qualification(reader_acceptance,ACCEPTANCE_HASH)
        fresh_ownership=None if control else load_owned_group_acceptance(ownership_acceptance,repo,observer,ACCEPTANCE_HASH)
        stable=(digest(PYTHON_LAUNCHER)==PYTHON_LAUNCHER_HASH and digest(repo/OBSERVER_REL)==OBSERVER_HASH and qualification.binding==fresh_qualification.binding
                and ownership_pin==fresh_ownership and binary_hash==digest(binary)
                and runner_hash==digest(pathlib.Path(__file__).resolve())
                and (control or (identity==source_identity(repo) and bundle==bundle_identity(repo))))
    except Exception as error: errors.append({'postInputError':repr(error)})
    result={'format':1,'case':case,'control':control,'root':str(root),'command':command,
            'nativeRoot':None if control else str(native_root),'startupLayout':layout,
            'nativeReportPath':None if control else str(native_report),
            't0Ns':life.t0,'cleanupOriginNs':life.c,'endedNs':ended,'declaredMaximumNs':85_000_000_000,
            'actualElapsedNs':ended-life.t0,'owned':owned,'bindingRaw':raw_binding,'bindingError':binding_error,
            'runnerSha256':runner_hash,'binarySha256':binary_hash,'inputs':identity,'bundle':bundle,
            'readerAcceptance':{'path':str(reader_acceptance),'sha256':ACCEPTANCE_HASH},'ownershipAcceptance':ownership_pin,
            'sigaction':sigaction,'runtime':observer.runtime_facts(),'inputsStable':stable,
            'nativeExit':cause,'retainedExitObservationNs':life.retained_exit_ns,
            'signals':life.signals,'signalsClosedNs':life.closed_ns,'reapStatus':life.reap_status,
            'exitCode':None if process is None else process.returncode,'leaderAbsenceQualified':leader_absent,
            'groupAbsent':len(life.group_proof)==2,'groupSamples':life.group_samples,
            'cleanupComplete':cleanup,'cleanupEvidenceBroken':life.audit_broken,
            'cleanupScope':'newly owned group only; excludes escaped sessions/OS-managed WebKit services',
            'leaderBook':book.snapshot(),'errors':errors+life.errors,'pipeEof':eof,'arrivals':arrivals,
            'stdoutSha256':hashlib.sha256(streams.get('stdout',b'')).hexdigest(),
            'stderrSha256':hashlib.sha256(streams.get('stderr',b'')).hexdigest(),
            'nativeReportSha256':digest(native_report) if report else None,
            'providerOrAccountActivity':False,'packagedAcceptance':False}
    if control:
        result['controlAccepted']=control_evidence(result,bytes(streams.get('stdout',b'')),bytes(streams.get('stderr',b'')))
    else: result['timing']=timing_evidence(case,cause,report)
    write_json(root/'execution.json',result)
    return result


def late_window_evidence(case,cause,report):
    """Versioned measurement only. Process qualification remains classify_exit/supervise's job."""
    metrics={'measurementContract':'late-window-v1','evidenceState':'unavailable',
        'nativeArmNs':None,'nativeDeadlineNs':None,'cancelIngressNs':None,
        'cancelDispatchNs':None,'gateCancelNs':None,'deadlineDecisionNs':None,
        'boundaryOutcome':None,'frontendStageDurationsMs':{},'phaseHeadroomMs':{}}
    errors=[]
    def need(condition,reason):
        if not condition: raise ValueError(reason)
    def number(value):
        return type(value) in (int,float) and float('-inf')<value<float('inf')
    def stamp(row):
        value=row['data'].get('capturedNs')
        need(type(value) is int and 0<=value<=90_000_000_000,'native captured time unavailable/invalid')
        return value
    try:
        need(isinstance(cause,dict) and isinstance(report,dict),'native cause/report unavailable')
        need(report.get('format')==2 and report.get('measurementContract')=='late-window-v1'
             and report.get('case')==case,'late-window report version/case missing')
        need(report.get('traceBroken') is False,'native trace broken/unavailable')
        need(cause.get('errors')==[],'native cause has unresolved errors')
        rows=cause.get('controls')
        need(isinstance(rows,list) and 0<len(rows)<=192 and report.get('trace')==rows,
             'bounded native trace/report correspondence missing')
        need(len(json.dumps(report,separators=(',',':')).encode())<=65536,'native report cap exceeded')
        previous=-1
        for index,row in enumerate(rows,1):
            need(isinstance(row,dict) and isinstance(row.get('data'),dict),'malformed trace row')
            need(row.get('ordinal')==index and row.get('pid')==report.get('nativePid')
                 and number(row.get('ms')) and previous<=row['ms']<=90000,'trace identity/order invalid')
            need(len(json.dumps(row,separators=(',',':')).encode())<=2048,'native trace row cap exceeded')
            previous=row['ms']
        def events(name,source=None):
            return [row for row in (rows if source is None else source) if row['event']==name]
        def one(name,source=None):
            values=events(name,source)
            need(len(values)==1,'missing/ambiguous '+name)
            return values[0]
        start=one('case-start')
        need(start is rows[0] and start['data'].get('case')==case
             and start['data'].get('measurementContract')=='late-window-v1','native case contract missing')
        need(not any(events(name) for name in ('fixture-error','watchdog-intent','finish-dispatch','finish-result')),
             'unexpected fixture error/finish')
        ready=[row for row in events('frontend') if row['data'].get('kind')=='ready']
        need(len(ready)==1,'real listener readiness missing/ambiguous')
        fast=case=='late-ipc-150'
        need(cause.get('cause')==('fixture_completed' if fast else 'native_deadline'),
             'expected measured outcome not established')
        requests=events('request-before'); emitted=events('emitted-request'); admissions=events('attempt-admitted')
        need(len(requests)==len(emitted)==len(admissions)==(2 if fast else 1),'admitted attempt count ambiguous')
        for i,(request,emission,admission) in enumerate(zip(requests,emitted,admissions),1):
            need(request['data'].get('call')==emission['data'].get('call')==admission['data'].get('call')==i
                 and emission['data'].get('attempt')==admission['data'].get('attempt')==i
                 and request['ordinal']<admission['ordinal']<emission['ordinal'],'request/admission join invalid')
            need(type(admission['data'].get('epoch')) is int and admission['data']['epoch']>0
                 and emission['data'].get('epoch')==admission['data']['epoch']
                 and admission['data'].get('phase')=='preparing','actual gate epoch missing')
        first=admissions[0]; epoch=first['data']['epoch']
        prefix=rows[:rows.index(one('survived'))] if fast else rows
        def native(name,bound=True):
            row=one(name,prefix)
            need(row['data'].get('epoch')==epoch,'wrong actual epoch at '+name)
            if bound: need(row['data'].get('binding')==binding,'wrong binding at '+name)
            stamp(row)
            return row
        bound=native('attempt-bound',False); binding=bound['data'].get('binding')
        need(isinstance(binding,str) and 0<len(binding)<=64,'native binding unavailable/invalid')
        need(bound['data'].get('phase')=='preparing','binding did not observe Preparing')
        arm=native('deadline-arm',False)
        need(type(arm['data'].get('durationMs')) is int and arm['data']['durationMs']==5000,
             'production deadline observation changed/missing')
        a=stamp(arm); due=a+arm['data']['durationMs']*1_000_000
        target=due-250_000_000; upper=due-150_000_000
        need(stamp(first)<=min(a,stamp(bound)),'arm/binding precedes actual admission')
        metrics.update(evidenceState='incomplete',nativeArmNs=a,nativeDeadlineNs=due)
        batch=native('phase-batch-accepted'); wait=native('wait-admitted')
        release=native('wait-released'); ingress=native('cancel-ingress'); injection=native('cancel-injection-enter')
        need(stamp(bound)<=stamp(batch)<=stamp(wait)<target and a<=stamp(wait),
             'causal batch/wait arrived after target or before authority')
        need(target<=stamp(release)<=stamp(ingress)<upper,'actual native release/ingress outside late window')
        need(stamp(release)>=stamp(wait) and stamp(injection)>=stamp(ingress),'native wait/injection order invalid')
        for row in (wait,release,ingress):
            need(row['data'].get('phase')=='preparing','actual attempt no longer pending')
        delay=150 if fast else 350
        need(type(injection['data'].get('configuredMs')) is int and injection['data']['configuredMs']==delay,
             'actual selected native injection missing')
        metrics['cancelIngressNs']=stamp(ingress)

        front=[row['data'] for row in events('frontend') if row['data'].get('kind')!='ready']
        need(front,'frontend causal observations unavailable')
        for sequence,data in enumerate(front):
            need(type(data.get('sequence')) is int and data['sequence']==sequence
                 and data.get('binding')==binding and number(data.get('ms')) and 0<=data['ms']<=60000,
                 'frontend binding/sequence/clock invalid')
            if sequence: need(data['ms']>=front[sequence-1]['ms'],'frontend causal clock reversed')
        batch_front=[row['data'] for row in events('frontend')
                     if row['ordinal']<batch['ordinal'] and row['data'].get('kind')!='ready']
        need(batch_front and batch['data'].get('lastSequence')==batch_front[-1]['sequence'],
             'causal batch acknowledgement incomplete')
        need(all(data.get('kind') in ('stage','end-leaving','cancel-wrapper','dependency-check')
                 for data in batch_front),'unexpected pre-window observation')
        def probe(kind):
            values=[data for data in batch_front if data.get('kind')==kind]
            need(len(values)==1,'missing/ambiguous frontend '+kind)
            return values[0]
        def stage(name,edge):
            values=[data for data in batch_front if data.get('kind')=='stage'
                    and data.get('stage')==name and data.get('edge')==edge]
            need(len(values)==1,'missing/ambiguous phase '+name+' '+edge)
            return values[0]
        mounts=[data for data in batch_front if data.get('kind')=='stage' and data.get('stage')=='shell-mounted']
        need(len(mounts)==2 and mounts[0].get('mount')==1 and mounts[1].get('mount')==2
             and mounts[0].get('edge')==mounts[1].get('edge')=='complete','actual initial/restored mounts missing')
        initial,restored=mounts
        key={'vaultId':'m93-controlled-vault','path':'controlled.md','ownerId':'m93-native-quit'}
        identity=initial.get('snapshot',{}).get('ownerInstance')
        need(isinstance(identity,str) and 0<len(identity)<=64,'retained owner identity missing')
        def snapshot(data,text,generation):
            value=data.get('snapshot')
            need(isinstance(value,dict),'owner snapshot unavailable')
            need(value.get('ownerKey')==key and value.get('ownerInstance')==identity,'retained owner replaced/changed')
            need(value.get('latestDraft')==text and type(value.get('generation')) is int
                 and value['generation']==generation and type(value.get('acknowledgedGeneration')) is int
                 and value['acknowledgedGeneration']==0
                 and value.get('payloadSha256')==hashlib.sha256(text.encode()).hexdigest(),
                 'exact retained draft/generation missing')
            need(type(value.get('failed')) is bool and 'inFlightGeneration' in value,'owner status unavailable')
            flight=value['inFlightGeneration']
            need(flight is None or (type(flight) is int and 0<flight<=generation),'owner flight invalid')
        clean='M93 controlled clean source\n'
        snapshot(initial,clean,0); snapshot(restored,DRAFT,1)
        cleanup=stage('cleanup','complete'); snapshot(cleanup,DRAFT,1)
        end=probe('end-leaving'); cancel=probe('cancel-wrapper')
        snapshot(end,DRAFT,1); snapshot(cancel,DRAFT,1)
        need(end.get('hasUnresolved') is True,'actual unresolved cleanup check missing')
        prior=initial['sequence']; phases={}
        for name,budget in (('flush',2500),('settle-first',750),('leave',750),('settle-second',750)):
            enter=stage(name,'enter'); complete=stage(name,'complete')
            need(prior<enter['sequence']<complete['sequence'],'real phase successor order invalid')
            need(enter.get('budgetMs')==complete.get('budgetMs')==budget,'production phase budget changed')
            duration=complete['ms']-enter['ms']
            need(0<=duration<budget,'real phase exhausted its unchanged budget')
            result=complete.get('result')
            need(isinstance(result,dict) and result.get('kind')=='fulfilled' and 'value' in result,
                 'real phase result unavailable/rejected')
            if name=='flush':
                value=result['value']
                need(isinstance(value,dict) and isinstance(value.get('outcomes'),list)
                     and value.get('unresolvedOwnerIds')==[],'earlier flush remained unresolved')
            elif name.startswith('settle'): need(result['value'] is True,'earlier settle remained unresolved')
            else: need(result['value'] is True,'leave result is not a successful acknowledgement')
            for data in (enter,complete):
                dirty=data['sequence']>cleanup['sequence']
                snapshot(data,DRAFT if dirty else clean,1 if dirty else 0)
            metrics['frontendStageDurationsMs'][name]=duration
            metrics['phaseHeadroomMs'][name]=budget-duration
            phases[name]=(enter,complete); prior=complete['sequence']
        need(phases['leave'][0]['sequence']<cleanup['sequence']<phases['leave'][1]['sequence'],
             'cleanup was not created by the real leave')
        need(prior<end['sequence']<restored['sequence'] and end['sequence']<cancel['sequence'],
             'restored shell/cancel did not follow actual late stay')
        need(max(restored['sequence'],cancel['sequence'])<=batch_front[-1]['sequence'],
             'restoration was not acknowledged before wait')
        need(all(data['kind']=='stayed' for data in front[len(batch_front):]),
             'unacknowledged causal observations after batch')
        for data in front[len(batch_front):]: snapshot(data,DRAFT,1)

        deadline=native('gate-deadline')
        need(deadline['data'].get('timerEpoch')==epoch and stamp(deadline)>=due,
             'wrong/early native deadline decision')
        metrics['deadlineDecisionNs']=stamp(deadline)
        dispatches=events('cancel-dispatch',prefix); cancels=events('gate-cancel',prefix); returns=events('cancel-return',prefix)
        need(len(dispatches)<=1 and len(cancels)<=1 and len(returns)<=1,'ambiguous real cancel evidence')
        if dispatches:
            dispatch=native('cancel-dispatch')
            need(dispatch['data'].get('configuredMs')==delay and stamp(dispatch)>=stamp(injection)+delay*1_000_000,
                 'native dispatch did not execute selected delay')
            metrics['cancelDispatchNs']=stamp(dispatch)
            metrics['observedCancelIngressToDispatchMs']=[(stamp(dispatch)-stamp(ingress))/1_000_000]
        if cancels:
            decision=native('gate-cancel')
            need(dispatches and stamp(decision)>=stamp(dispatches[0]),'gate cancel has no actual dispatch')
            metrics['gateCancelNs']=stamp(decision)
        if returns:
            returned=native('cancel-return')
            need(cancels and stamp(returned)>=stamp(cancels[0]),'cancel return has no actual mutation observation')
        if fast:
            need(len(dispatches)==len(cancels)==len(returns)==1,'real fast cancellation incomplete')
            decision=cancels[0]['data']; death=deadline['data']
            need(dispatches[0]['data'].get('phase')=='preparing' and decision.get('cancelled') is True
                 and decision.get('before')=='preparing' and decision.get('after')=='idle'
                 and stamp(cancels[0])<due,'fast gate cancel did not win before nominal deadline')
            need(death.get('exits') is False and death.get('before')==death.get('after')=='idle',
                 'actual original deadline was not suppressed')
            stayed=front[len(batch_front):]
            need(len(stayed)==1,'post-cancel stayed snapshot missing/ambiguous')
            survived=one('survived')
            need(survived['data'].get('call')==1 and survived['data'].get('epoch')==epoch
                 and survived['ms']-requests[0]['ms']>=5250 and survived['ms']*1_000_000>=stamp(deadline),
                 'survival beyond original deadline missing')
            second=admissions[1]['data']['epoch']
            need(second==epoch+1 and admissions[1]['ordinal']>survived['ordinal'],
                 'later real Idle admission missing')
            for name in ('probe-cancel-dispatch','probe-cancel-return'):
                need(one(name)['data'].get('epoch')==second,'later probe cancellation join missing')
            need(len(events('fixture-complete-intent'))==1,'controlled fixture completion missing')
            metrics['boundaryOutcome']='measured pre-deadline cancellation'
            metrics['nativeCancelHeadroomMs']=(due-stamp(cancels[0]))/1_000_000
        else:
            death=deadline['data']
            need(cause.get('attempt')==emitted[0]['data']['attempt'] and death.get('exits') is True
                 and death.get('before')=='preparing' and death.get('after')=='exiting'
                 and stamp(injection)<=stamp(deadline),'same-epoch native deadline did not win during injection')
            need(not events('fixture-complete-intent') and not events('survived'),'unexpected responsive slow outcome')
            if cancels:
                decision=cancels[0]['data']
                need(decision.get('cancelled') is False and decision.get('before')==decision.get('after')=='exiting'
                     and stamp(cancels[0])>=stamp(deadline),'contradictory successful slow cancel')
            metrics['boundaryOutcome']='observed native deadline after actual injection entry'
            metrics['cancelCompletionState']='recorded' if returns else 'not recorded; native deadline won'
        metrics['evidenceState']='validated'
    except (ValueError,TypeError,KeyError,IndexError,OverflowError) as error:
        errors.append(str(error) if isinstance(error,ValueError) else 'malformed late-window evidence')
    return {'accepted':not errors,'errors':errors,'metrics':metrics,
            'scope':'finite controlled late-window fixture; no editor/disk/persistence guarantee'}


def timing_evidence(case,cause,report):
    if case in ('late-ipc-150','late-ipc-350'):
        return late_window_evidence(case,cause,report)
    errors=[]; metrics={}; rows=[] if cause is None else cause['controls']
    if cause is None or cause['cause'] in ('unknown','conflicting','supervisor_intervention','smoke_watchdog','emit_failure','timer_spawn_failure'):
        errors.append('positive expected native/fixture cause not established')
    def events(name): return [r for r in rows if r['event']==name]
    def probes(kind): return [r for r in rows if r['event']=='frontend' and r['data'].get('kind')==kind]
    if len(probes('ready'))!=1: errors.append('registered real listener readiness missing')
    requests=events('request-before'); emitted=events('emitted-request')
    if not requests or not emitted: errors.append('native request/emission missing')
    for r in rows:
        if r['event']=='cancel-return':
            admitted=[q for q in emitted if q['ms']<=r['ms']]
            prior=[q for q in requests if admitted and q['data']['call']==admitted[-1]['data']['call']]
            if prior: metrics.setdefault('conservativeHeadroomMs',[]).append(5000-(r['ms']-prior[-1]['ms']))
        if r['event']=='cancel-dispatch':
            prior=[q for q in rows if q['event']=='cancel-ingress' and q['ms']<=r['ms']]
            if prior: metrics.setdefault('observedCancelIngressToDispatchMs',[]).append(r['ms']-prior[-1]['ms'])
    stayed=probes('stayed')
    boundary_deadline=case=='late-ipc-350' and cause and cause['cause']=='native_deadline'
    snapshots=[r['data']['snapshot'] for r in stayed]
    if boundary_deadline:
        snapshots += [r['data']['snapshot'] for r in probes('stage') if r['data'].get('stage')=='cleanup']
    if case!='hung-webview' and not boundary_deadline and not stayed: errors.append('frontend stayed telemetry missing')
    for s in snapshots:
        if s.get('latestDraft')!=DRAFT or s.get('generation')!=1 or s.get('acknowledgedGeneration')!=0 or s.get('payloadSha256')!=hashlib.sha256(DRAFT.encode()).hexdigest():
            errors.append('exact retained draft/generation not established')
    if case.startswith('late-'):
        for stage in ('flush','settle-first','leave','settle-second'):
            enters=[r for r in probes('stage') if r['data'].get('stage')==stage and r['data'].get('edge')=='enter']
            completed=[r for r in probes('stage') if r['data'].get('stage')==stage and r['data'].get('edge')=='complete']
            if not enters or not completed: errors.append('intended late stage missing: '+stage)
            else: metrics.setdefault('frontendStageDurationsMs',{})[stage]=completed[0]['data']['ms']-enters[0]['data']['ms']
        if not any(r['data'].get('stage')=='cleanup' for r in probes('stage')): errors.append('controlled cleanup edit missing')
        if case=='late-ipc-350' and cause and cause['cause']=='native_deadline':
            # Boundary characterization may lose late completion/cancel records. Retain the
            # process witness, but do not claim coverage without all intended stage records.
            metrics['boundaryOutcome']='observed native deadline'
        elif not cause or cause['cause']!='fixture_completed': errors.append('responsive cancellation/survival not established')
        if not boundary_deadline:
            cleanups=[q for q in probes('stage') if q['data'].get('stage')=='cleanup']
            remounts=[q for q in probes('stage') if q['data'].get('stage')=='shell-mounted']
            if not cleanups or not any(q['ms']>cleanups[0]['ms'] for q in remounts): errors.append('actual shell restoration mount not observed')
    if case in ('failed-owner','pending-owner','late-unresolved','late-ipc-150'):
        if not cause or cause['cause']!='fixture_completed': errors.append('survival fixture completion cause missing')
        survived=events('survived')
        if not survived or not requests or survived[0]['ms']-requests[0]['ms']<5250: errors.append('survival beyond first deadline missing')
        if len(emitted)<2: errors.append('later admitted request did not prove Idle')
        if not events('cancel-dispatch') or not events('cancel-return'): errors.append('real cancellation observation missing')
    if case in ('failed-owner','expired-second-quit'):
        retry=[r for r in probes('stage') if r['data'].get('stage')=='retry' and r['data'].get('edge')=='complete']
        if not retry or not retry[0]['data']['snapshot'].get('failed'): errors.append('unchanged draft Retry still refusing missing')
    if case in ('failed-owner','pending-owner','expired-second-quit'):
        if events('finish-dispatch') or any(r['data'].get('stage')=='leave' for r in probes('stage')): errors.append('unresolved owner unexpectedly left/finished')
    if case=='pending-owner':
        cut=events('survived'); prefix=[r for r in rows if not cut or r['ms']<cut[0]['ms']]
        if len([r for r in prefix if r['event']=='request-before'])!=2 or len([r for r in prefix if r['event']=='emitted-request'])!=1:
            errors.append('duplicate +100ms request did not retain one admitted prepare')
        if len([r for r in prefix if r['event']=='frontend' and r['data'].get('stage')=='flush' and r['data'].get('edge')=='enter'])!=1:
            errors.append('one actual host preparation not established')
        if len(requests)>=2: metrics['duplicateRequestIntervalMs']=requests[1]['ms']-requests[0]['ms']
    if case=='second-quit':
        if not cause or cause['cause']!='finish_quit' or len(emitted)!=2: errors.append('second actual finish cause/admission missing')
        finished=events('finish-result')
        if not requests or not finished or finished[-1]['ms']-requests[0]['ms']<=5000:
            errors.append('second finish did not outlive first canceled deadline')
    if case=='expired-second-quit':
        if len(stayed)!=2 or len(emitted)!=2 or len(requests)!=2: errors.append('expired second stay/admission missing')
        elif requests[1]['ms']-stayed[0]['ms']<31000: errors.append('31 real seconds after stayed not observed')
        survived=events('survived')
        if not survived or len(requests)<2 or survived[0]['ms']-requests[1]['ms']<5250: errors.append('second attempt survival missing')
        if not cause or cause['cause']!='fixture_completed': errors.append('expired second completion cause missing')
    if case=='hung-webview':
        hang=probes('hang-armed'); beats=[r for r in probes('stage') if r['data'].get('stage')=='heartbeat']
        if len(hang)!=1 or len(beats)!=3 or not requests or hang[0]['ms']>=requests[0]['ms'] or any(r['ms']>hang[0]['ms'] for r in beats):
            errors.append('controlled hang handshake/heartbeat order missing')
        if events('cancel-ingress') or events('finish-dispatch'): errors.append('post-hang responsive command observed')
        if not cause or cause['cause']!='native_deadline' or cause['attempt']!=1: errors.append('actual native deadline cause/attempt missing')
    return {'accepted':not errors,'errors':errors,'metrics':metrics,
            'scope':'finite controlled timing fixture, not production draft-loss reproduction/editor coverage'}


def toy_member(ready_fd):
    def ignored(signo,frame):
        os.write(1,(json.dumps({'toy':'member-term-ignored','pid':os.getpid(),'ns':time.monotonic_ns()})+'\n').encode())
    signal.signal(signal.SIGTERM,ignored)
    ready=(json.dumps({'toy':'member-ready','pid':os.getpid(),'pgid':os.getpgrp()})+'\n').encode()
    os.write(ready_fd,ready); os.close(ready_fd)
    time.sleep(25); os._exit(0) # bounded self-exit fallback, not cleanup evidence.


def toy_leader(role):
    if role not in ('leader-exit','leader-term'): os._exit(91)
    signal.signal(signal.SIGTERM,signal.SIG_DFL)
    # Only this fixed control spawns one fixed toy member in its already-owned group.
    read_fd,write_fd=os.pipe()
    child=subprocess.Popen([sys.executable,'-B',str(pathlib.Path(__file__).resolve()),'--toy-member',str(write_fd)],
                           stdin=subprocess.DEVNULL,stdout=None,stderr=subprocess.DEVNULL,pass_fds=(write_fd,))
    KEPT.append(child); os.close(write_fd)
    selector=selectors.DefaultSelector(); selector.register(read_fd,selectors.EVENT_READ)
    data=bytearray(); deadline=time.monotonic()+3
    while time.monotonic()<deadline and b'\n' not in data:
        for key,_ in selector.select(min(.05,max(0,deadline-time.monotonic()))):
            block=os.read(key.fd,1024)
            if not block: os._exit(92)
            data.extend(block)
            if len(data)>2048: os._exit(93)
    selector.close(); os.close(read_fd)
    ready=json.loads(data)
    if ready.get('toy')!='member-ready' or ready.get('pid')!=child.pid or ready.get('pgid')!=os.getpgrp(): os._exit(94)
    os.write(1,(json.dumps({'toy':'leader-ready','pid':os.getpid(),'member':ready,'role':role})+'\n').encode())
    # Member directly inherits the supervisor-owned stdout pipe and ignores TERM.
    if role=='leader-exit': os._exit(0)
    time.sleep(25); os._exit(0)


def control_receipts(stdout,stderr,arrivals,eof):
    """Join complete bounded toy rows to exact chunks in the supervisor clock.
    Member clocks are diagnostic only; receipt does not claim emission/delivery time.
    """
    streams={'stdout':stdout,'stderr':stderr}
    if (any(type(data) is not bytes or len(data)>256*1024 for data in streams.values())
            or not isinstance(eof,dict) or set(eof)!=set(streams)
            or any(eof[name] is not True for name in streams)
            or not isinstance(arrivals,list) or len(arrivals)>512*1024):
        raise ValueError('bounded complete control streams/arrivals required')
    offsets={'stdout':0,'stderr':0}; chunks=[]; previous_ns=-1
    for ordinal,row in enumerate(arrivals,1):
        if not isinstance(row,dict) or set(row)!={'stream','ns','offset','receivedBytes'}:
            raise ValueError('arrival shape')
        name=row['stream']
        if (not isinstance(name,str) or name not in streams
                or any(type(row[key]) is not int for key in ('ns','offset','receivedBytes'))
                or row['ns']<0 or row['ns']<previous_ns
                or row['offset']!=offsets[name] or not 0<row['receivedBytes']<=8192
                or row['offset']+row['receivedBytes']>len(streams[name])):
            raise ValueError('arrival stream/order/range')
        previous_ns=row['ns']; offsets[name]+=row['receivedBytes']
        chunks.append({'ordinal':ordinal,**row})
    if any(offsets[name]!=len(data) for name,data in streams.items()):
        raise ValueError('arrival coverage incomplete')
    if not stdout or not stdout.endswith(b'\n'):
        raise ValueError('complete newline-delimited control row required')
    def unique_object(pairs):
        value={}
        for key,item in pairs:
            if key in value: raise ValueError('duplicate control key')
            value[key]=item
        return value
    def invalid_constant(value): raise ValueError('nonfinite control scalar')
    records=[]; start=0
    for line in stdout.split(b'\n')[:-1]:
        end=start+len(line)+1
        if not line or end-start>2048 or len(records)>=2:
            raise ValueError('fixed control row count/bound')
        value=json.loads(line,object_pairs_hook=unique_object,parse_constant=invalid_constant)
        if not isinstance(value,dict): raise ValueError('control object required')
        received=[row for row in chunks if row['stream']=='stdout'
                  and row['offset']<end and row['offset']+row['receivedBytes']>start]
        records.append({'value':value,'start':start,'endExclusive':end,'chunks':received})
        start=end
    return records


def control_evidence(result,stdout,stderr=b''):
    errors=[]; receipt=None
    try:
        records=control_receipts(stdout,stderr,result['arrivals'],result['pipeEof'])
        ready=[r['value'] for r in records if r['value'].get('toy')=='leader-ready']
        ignored=[r for r in records if r['value'].get('toy')=='member-term-ignored']
        if (len(records)!=2 or len(ready)!=1 or len(ignored)!=1
                or records[0]['value'].get('toy')!='leader-ready'
                or records[1]['value'].get('toy')!='member-term-ignored'
                or result['case'] not in ('leader-exit','leader-term')):
            raise ValueError('exact fixed leader/member reports required')
        leader=ready[0]; member=leader['member']; handler=ignored[0]['value']
        if (set(leader)!={'toy','pid','member','role'}
                or not isinstance(member,dict) or set(member)!={'toy','pid','pgid'}
                or set(handler)!={'toy','pid','ns'} or type(member['pid']) is not int
                or member['pid']<=0 or member['pid']==result['owned']['pid']
                or type(handler['pid']) is not int or type(handler['ns']) is not int or handler['ns']<0
                or leader['pid']!=result['owned']['pid'] or leader['role']!=result['case']
                or member['toy']!='member-ready' or member['pgid']!=result['owned']['pgid']
                or member['pgid']!=result['owned']['pid'] or handler['pid']!=member['pid']):
            errors.append('fixed leader/member handshake and ignored TERM absent')
        signals=result['signals']
        if ([r['signal'] for r in signals]!=[int(signal.SIGTERM),int(signal.SIGKILL)]
                or any(type(r['ns']) is not int or r['returned'] is not True
                       or r['errno'] is not None or r.get('error') is not None for r in signals)):
            raise ValueError('fixed group TERM/KILL delivery incomplete')
        receipt={'clock':'supervisor-monotonic-ns','start':ignored[0]['start'],
                 'endExclusive':ignored[0]['endExclusive'],'chunks':ignored[0]['chunks'],
                 'memberNsDiagnostic':handler['ns']}
        if not receipt['chunks'] or not all(signals[0]['ns']<row['ns']<signals[1]['ns'] for row in receipt['chunks']):
            errors.append('surviving member report not wholly received between TERM and KILL')
        if result['case']=='leader-exit' and (result['retainedExitObservationNs'] is None or result['retainedExitObservationNs']>signals[0]['ns']):
            errors.append('leader retained exit before group TERM missing')
        if result['case']=='leader-term' and (result['retainedExitObservationNs'] is None or result['retainedExitObservationNs']<=signals[0]['ns']):
            errors.append('leader exit on TERM missing')
    except (ValueError,TypeError,KeyError,IndexError,RecursionError): errors.append('control wire/ownership malformed')
    if not result['cleanupComplete'] or not result['inputsStable'] or result['errors']: errors.append('control cleanup/source errors')
    return {'accepted':not errors,'errors':errors,'memberReceipt':receipt}


def load_owned_group_acceptance(path,repo,observer,expected):
    data=read_regular(path,65536); value=json.loads(data)
    if value.get('format')!=1 or value.get('verdict')!='accepted-m93-native-quit-owned-group': raise ValueError('independent owned-group acceptance required')
    if value.get('runnerSha256')!=digest(pathlib.Path(__file__).resolve()) or value.get('runtime')!=observer.runtime_facts() or value.get('observerAcceptanceSha256')!=expected:
        raise ValueError('ownership source/runtime binding drift')
    review=value['review']
    if digest(review['path'])!=review['sha256']: raise ValueError('ownership review changed')
    candidate=value['candidate']; raw=read_regular(candidate['path'],65536)
    if hashlib.sha256(raw).hexdigest()!=candidate['sha256']: raise ValueError('ownership candidate changed')
    controls=json.loads(raw)
    if controls.get('runnerSha256')!=value['runnerSha256'] or controls.get('runtime')!=value['runtime'] or controls.get('status')!='candidate-qualified': raise ValueError('ownership candidate binding')
    if controls.get('productionAccepted') is not False: raise ValueError('qualification is not a production/native acceptance')
    if len(controls.get('controls',[]))!=2: raise ValueError('two fixed ownership controls required')
    for row in controls['controls']:
        raw=read_regular(row['path'],256*1024,True)
        if hashlib.sha256(raw).hexdigest()!=row['sha256']: raise ValueError('control changed')
        result=json.loads(raw)
        if result.get('controlAccepted',{}).get('accepted') is not True or result['runnerSha256']!=value['runnerSha256'] or result['runtime']!=value['runtime']:
            raise ValueError('control/source/runtime not qualified')
        for name in ('stdout','stderr','cleanup'):
            p=pathlib.Path(result['root'])/(name+('.jsonl' if name=='cleanup' else '.log'))
            key=name+'Sha256'
            if digest(p)!=row[key]: raise ValueError('control phase evidence changed')
    return {'path':str(path),'sha256':hashlib.sha256(data).hexdigest()}


def cleanup_audit(result):
    raw=read_regular(pathlib.Path(result['root'])/'cleanup.jsonl',256*1024,True)
    rows=[json.loads(line) for line in raw.splitlines()]
    if not rows or len(rows)>256: raise ValueError('bounded cleanup audit required')
    return rows


def cleanup_disposition(result,audit):
    """Pure resource evidence only. Native semantic acceptance is separate.

    Failed signals remain failed. Only exact observed post-natural-exit absence
    can complete resources without claiming TERM/KILL delivery.
    """
    diagnostics=result.get('errors',[]) if isinstance(result,dict) else []
    denied={'kind':'unavailable','resourceComplete':False,'deliveredSignals':False,'diagnostics':diagnostics}
    def need(ok,reason):
        if not ok: raise ValueError(reason)
    def integer(value):return type(value) is int
    def hash_ok(value):return isinstance(value,str) and len(value)==64 and all(c in '0123456789abcdef' for c in value)
    try:
        need(isinstance(result,dict) and isinstance(audit,list) and 0<len(audit)<=256,'bounded cleanup evidence')
        for flag in ('cleanupComplete','leaderAbsenceQualified','groupAbsent','inputsStable'):
            need(result.get(flag) is True,flag)
        need(result.get('cleanupEvidenceBroken') is False and result.get('bindingError') is None,'unbroken binding/audit')
        need(result.get('pipeEof')=={'stdout':True,'stderr':True},'complete streams')
        for key in ('runnerSha256','binarySha256','nativeReportSha256'):
            need(hash_ok(result.get(key)),key)
        for key in ('readerAcceptance','ownershipAcceptance'):
            pin=result.get(key);need(isinstance(pin,dict) and isinstance(pin.get('path'),str) and bool(pin['path']) and hash_ok(pin.get('sha256')),'accepted pin')
        need(isinstance(result.get('runtime'),dict) and bool(result['runtime']) and isinstance(result.get('inputs'),dict) and hash_ok(result['inputs'].get('aggregateDigest')),'runtime/input binding')
        t0=result['t0Ns'];c=result['cleanupOriginNs'];ended=result['endedNs'];closed=result['signalsClosedNs'];retained=result['retainedExitObservationNs']
        need(all(integer(x) for x in (t0,c,ended,closed,retained)) and 0<=t0<=c<=t0+75_000_000_000,'original bounded origin')
        need(result['declaredMaximumNs']==85_000_000_000 and result['actualElapsedNs']==ended-t0 and c+10_000_000_000<=ended<=t0+85_000_000_000,'fixed overall bound')
        need(c+5_000_000_000<=closed<c+7_000_000_000 and result['reapStatus']==0 and type(result['reapStatus']) is int and result['exitCode']==0 and type(result['exitCode']) is int,'closed normal reap')
        owned=result['owned'];pid=owned['pid'];start=owned['start'];key=owned['key']
        need(integer(pid) and pid>0 and isinstance(start,list) and len(start)==2 and all(integer(x) for x in start) and start[0]>0 and 0<=start[1]<1_000_000,'original identity')
        need(key==str(pid)+':'+str(start[0])+':'+str(start[1]) and owned['pgid']==pid and owned['sid']==pid and integer(owned['ppid']) and owned['ppid']>0 and integer(owned['uid']) and owned['uid']>=0,'original group/session')
        def full_identity(raw,status=None):
            fields=raw.get('fields') if isinstance(raw,dict) else None
            return (isinstance(fields,dict) and raw.get('requestedPid')==pid and raw.get('returnedBytes')==136 and type(raw.get('immediateErrno')) is int and raw.get('immediateErrno')==0 and raw.get('fieldsAvailable') is True
                    and all(fields.get(k)==v for k,v in {'pid':pid,'ppid':owned['ppid'],'pgid':pid,'uid':owned['uid'],'startSeconds':start[0],'startMicros':start[1]}.items())
                    and (status is None or fields.get('status')==status))
        need(full_identity(result['bindingRaw']),'full original binding')
        allowed={'startup-layout','launch','leader-observation','ownership-bound','retained-exit','signal-attempt','signals-closed','reap-attempt','reaped','group-observation'}
        need(all(isinstance(row,dict) and row.get('kind') in allowed and integer(row.get('ns')) and 0<=row['ns']<=ended for row in audit),'closed audit vocabulary')
        need(all(audit[i]['ns']<=audit[i+1]['ns'] for i in range(len(audit)-1)),'audit chronology')
        def rows(kind):return [row for row in audit if row['kind']==kind]
        def one(kind):
            found=rows(kind);need(len(found)==1,kind+' receipt');return found[0]
        need(one('startup-layout')['layout']==result['startupLayout'],'startup custody')
        launch=one('launch');need(launch['pid']==pid and launch['command']==result['command'] and launch['t0']==t0 and launch['runnerSha256']==result['runnerSha256'] and launch['binarySha256']==result['binarySha256'],'launch pins')
        bound=one('ownership-bound');need(bound['owned']==owned and bound['pgid']==pid and bound['sid']==pid,'ownership receipt')
        observed=one('retained-exit')['observation'];need(full_identity(observed,5) and observed['monotonicCompletedNs']==retained,'original retained natural exit')
        signals=result['signals'];need(isinstance(signals,list) and len(signals)==2 and [row['signal'] for row in signals]==[15,9],'fixed signal attempts')
        need(all(integer(row.get('ns')) and retained<row['ns']<c+5_000_000_000 for row in signals) and signals[0]['ns']>=c and signals[1]['ns']>=c+3_000_000_000,'post-exit fixed signal window')
        failed=[]
        for row in signals:
            if row.get('returned') is True:need(row.get('errno') is None and row.get('error') is None,'successful signal shape')
            else:
                need(row.get('returned') is False and type(row.get('errno')) is int and row.get('errno')==errno.EPERM,'only reviewed failed signal errno')
                failed.append({'signalError':row})
        need(isinstance(diagnostics,list) and diagnostics==failed,'no other errors')
        attempts=rows('signal-attempt');need(len(attempts)==2 and all(row['signal']==signals[i] and integer(row.get('completedNs')) and signals[i]['ns']<=row['completedNs']<=closed and row['ns']<=closed for i,row in enumerate(attempts)),'joined signal audit')
        need(one('signals-closed')['closedNs']==closed,'irreversible closure receipt')
        reaped=one('reaped');need(closed<=reaped['ns']<c+7_000_000_000 and reaped['status']==0 and reaped['exitCode']==0,'actual closed-phase normal reap')
        need(any(row['ns']<=reaped['ns'] and row['raw'].get('pid')==pid and row['raw'].get('status')==0 and row['raw'].get('errno') is None for row in rows('reap-attempt')),'actual consuming reap')
        book=result['leaderBook'];need(book.get('errors')==[] and book.get('evidenceBroken') is False and set(book['records'])=={key},'qualified original book')
        record=book['records'][key];proof=record['proof'];need(record['state']=='absence-evidence-ready' and isinstance(proof,list) and len(proof)==2 and proof[0]!=proof[1] and record['absence'][-2:]==proof,'qualified distinct PID proof')
        samples=[]
        for identity in proof:
            found=[row['raw'] for row in rows('leader-observation') if row['raw'].get('observationId')==identity]
            need(len(found)==1,'exact original PID proof receipt');raw=found[0]
            need(raw.get('ownedKey')==key and raw.get('requestedPid')==pid and raw.get('returnedBytes')==0 and raw.get('immediateErrno')==errno.ESRCH and raw.get('fieldsAvailable') is False and raw.get('fields') is None,'qualified PID absence')
            need(integer(raw.get('monotonicStartedNs')) and integer(raw.get('monotonicCompletedNs')) and reaped['ns']<=raw['monotonicStartedNs']<=raw['monotonicCompletedNs']<=c+10_000_000_000,'post-reap PID window');samples.append(raw)
        need(samples[1]['monotonicStartedNs']-samples[0]['monotonicStartedNs']>=1_000_000_000 and record['last']==samples[-1],'spaced original PID absence')
        groups=result['groupSamples'];observations=rows('group-observation')
        need(isinstance(groups,list) and len(groups)>=2 and len(groups)==len(observations),'group observation coverage')
        for i,row in enumerate(groups):
            need(integer(row.get('ns')) and integer(row.get('startedNs')) and integer(row.get('completedNs')) and row['ns']==row['startedNs'] and reaped['ns']<=row['startedNs']<=row['completedNs']<=c+10_000_000_000,'post-reap group window')
            need(i==0 or row['ns']-groups[i-1]['ns']>=1_000_000_000,'group cadence')
            need(observations[i]['originalPgid']==pid and observations[i]['raw']=={k:v for k,v in row.items() if k!='ns'},'original group audit join')
        need(all(row.get('returned') is False and row.get('errno')==errno.ESRCH for row in groups[-2:]),'final original group absence')
        return {'kind':'observed_absent_after_natural_exit_with_failed_signals' if failed else 'delivered_and_absent','resourceComplete':True,'deliveredSignals':not failed,'diagnostics':diagnostics}
    except (ValueError,TypeError,KeyError,IndexError,AttributeError):return denied


def native_attempt_accepted(result,audit):
    if not isinstance(result,dict):return False
    cause=result.get('nativeExit');timing=result.get('timing')
    if not isinstance(cause,dict) or not isinstance(timing,dict):return False
    return (result.get('control') is False and result.get('case') in CASES
            and result.get('timing',{}).get('accepted') is True
            and cause.get('cause') in ('fixture_completed','native_deadline','finish_quit','emit_failure','timer_spawn_failure')
            and cause.get('errors')==[] and cleanup_disposition(result,audit)['resourceComplete'])


def main():
    # Fixed toy roles are selected before parser; they never act on arbitrary targets.
    if len(sys.argv)==3 and sys.argv[1]=='--toy-member': toy_member(int(sys.argv[2])); return
    if len(sys.argv)==3 and sys.argv[1]=='--toy-leader': toy_leader(sys.argv[2]); return
    parser=argparse.ArgumentParser()
    parser.add_argument('--repo',required=True,type=pathlib.Path)
    parser.add_argument('--binary',required=True,type=pathlib.Path)
    parser.add_argument('--output-parent',default=pathlib.Path('/private/tmp'),type=pathlib.Path)
    parser.add_argument('--cleanup-acceptance',required=True,type=pathlib.Path)
    parser.add_argument('--cleanup-acceptance-sha256',required=True)
    parser.add_argument('--ownership-acceptance',type=pathlib.Path)
    parser.add_argument('--qualify-cleanup',action='store_true')
    parser.add_argument('--case',choices=('all',)+CASES,default='all')
    parser.add_argument('--repeat',type=int,choices=range(1,11),default=1)
    args=parser.parse_args()
    repo,binary,parent=(p.resolve(strict=True) for p in (args.repo,args.binary,args.output_parent))
    observer,qualification=load_observer(repo,args.cleanup_acceptance,args.cleanup_acceptance_sha256)
    if args.qualify_cleanup:
        if args.repeat!=1: raise ValueError('fixed controls run once')
        controls=[]
        for case in ('leader-exit','leader-term'):
            result=supervise(repo,pathlib.Path('/usr/bin/python3').resolve(),case,parent,observer,qualification,True,reader_acceptance=args.cleanup_acceptance)
            p=pathlib.Path(result['root'])/'execution.json'
            controls.append({'path':str(p),'sha256':digest(p),
                'stdoutSha256':digest(p.parent/'stdout.log'),'stderrSha256':digest(p.parent/'stderr.log'),
                'cleanupSha256':digest(p.parent/'cleanup.jsonl')})
            if not result['controlAccepted']['accepted']:
                print(json.dumps({'control':case,'accepted':False,'path':str(p)})); raise SystemExit(2)
        receipt={'format':1,'status':'candidate-qualified','productionAccepted':False,
                 'runnerSha256':digest(pathlib.Path(__file__).resolve()),'runtime':observer.runtime_facts(),
                 'observerAcceptanceSha256':args.cleanup_acceptance_sha256,'controls':controls,
                 'scope':'new owned-group lifecycle only; requires independent source/control review'}
        directory=pathlib.Path(tempfile.mkdtemp(prefix='cerebro-m93-quit-qualification-',dir=parent)).resolve()
        os.chmod(directory,0o700); write_json(directory/'candidate-qualification.json',receipt)
        print(json.dumps({'candidate':str(directory/'candidate-qualification.json'),'accepted':False})); return
    if args.ownership_acceptance is None: raise ValueError('root must independently review fixed controls and supply --ownership-acceptance')
    owned_acceptance=load_owned_group_acceptance(args.ownership_acceptance,repo,observer,args.cleanup_acceptance_sha256)
    if binary.name!='native-read-smoke' or not binary.is_file(): raise ValueError('explicit debug native-read-smoke binary required')
    selected=CASES if args.case=='all' else (args.case,)
    if args.repeat>1 and args.case not in ('late-unresolved','late-ipc-150'): raise ValueError('repeats are limited to the two reviewed late cases')
    outcomes=[]
    for case in selected:
        for iteration in range(args.repeat):
            result=supervise(repo,binary,case,parent,observer,qualification,reader_acceptance=args.cleanup_acceptance,ownership_acceptance=args.ownership_acceptance)
            try:
                audit=cleanup_audit(result)
            except (OSError,ValueError,TypeError,KeyError,RuntimeError,UnicodeError):
                disposition={'kind':'unavailable','resourceComplete':False,'deliveredSignals':False,
                             'diagnostics':result['errors'],'evidenceErrors':['cleanup_audit_unavailable_or_malformed']}
                accepted=False
            else:
                disposition=cleanup_disposition(result,audit)
                accepted=native_attempt_accepted(result,audit)
            row={'case':case,'iteration':iteration+1,'accepted':accepted,'root':result['root'],
                 'timing':result['timing'],'nativeCause':result['nativeExit']['cause'],'cleanupComplete':result['cleanupComplete'],
                 'cleanupDisposition':disposition}
            outcomes.append(row); print(json.dumps(row),flush=True)
            if iteration==0 and args.repeat>1 and not accepted: raise SystemExit(2)
    directory=pathlib.Path(tempfile.mkdtemp(prefix='cerebro-m93-quit-series-',dir=parent)).resolve(); os.chmod(directory,0o700)
    values=[v for row in outcomes for v in row['timing']['metrics'].get('conservativeHeadroomMs',[])]
    write_json(directory/'series.json',{'format':1,'ownershipAcceptance':owned_acceptance,'attempts':outcomes,
               'minimumHeadroomMs':min(values) if values else None,'maximumHeadroomMs':max(values) if values else None,
               'scope':'finite controlled observations; no reliability percentile/universal protection claim'})
    print(json.dumps({'series':str(directory/'series.json')}))
    raise SystemExit(0 if all(x['accepted'] for x in outcomes) else 2)


if __name__=='__main__': main()
