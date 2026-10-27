//! Fixed app R0 adaptation of the independently characterized retention primitive.
use std::io::{self, Read, Write};
use std::mem::{self, ManuallyDrop};
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

type Wire = Arc<Mutex<UnixStream>>;
const IO: Duration = Duration::from_secs(2);
fn fail() -> ! {
    unsafe { libc::_exit(90) }
}
fn done(code: i32) -> ! {
    unsafe { libc::_exit(code) }
}
fn need<T>(r: io::Result<T>) -> T {
    r.unwrap_or_else(|_| fail())
}
fn emit(w: &Wire, s: &str) {
    // A protocol failure never unwinds through retention or invokes cleanup.
    if s.len() > 256 {
        fail();
    }
    let mut w = w.lock().unwrap_or_else(|_| fail());
    if writeln!(&mut *w, "{s}").is_err() {
        fail();
    }
}
fn checked<T>(w: &Wire, stage: &str, result: io::Result<T>) -> T {
    match result {
        Ok(value) => value,
        Err(error) => {
            emit(
                w,
                &format!("REFUSED {stage} {}", error.raw_os_error().unwrap_or(-1)),
            );
            fail()
        }
    }
}
fn line(s: &mut UnixStream) -> io::Result<String> {
    let mut out = Vec::new();
    for _ in 0..256 {
        let mut b = [0];
        s.read_exact(&mut b)?;
        if b[0] == b'\n' {
            return String::from_utf8(out).map_err(io::Error::other);
        }
        if !(32..=126).contains(&b[0]) {
            return Err(io::Error::other("wire byte"));
        }
        out.push(b[0]);
    }
    Err(io::Error::other("wire bound"))
}
fn peer(s: &UnixStream) -> io::Result<i32> {
    let mut pid: i32 = 0;
    let mut n = mem::size_of::<i32>() as libc::socklen_t;
    // Darwin SOL_LOCAL / LOCAL_PEERPID; kernel identity, not the supplied line.
    let rc =
        unsafe { libc::getsockopt(s.as_raw_fd(), 0, 2, (&mut pid as *mut i32).cast(), &mut n) };
    if rc != 0 || n as usize != mem::size_of::<i32>() || pid <= 1 {
        return Err(io::Error::other("peer unavailable"));
    }
    Ok(pid)
}
fn connect(path: &str, expected: i32) -> UnixStream {
    let s = need(UnixStream::connect(path));
    need(s.set_read_timeout(Some(IO)));
    need(s.set_write_timeout(Some(IO)));
    if need(peer(&s)) != expected {
        fail();
    }
    s
}
fn watchdog(seconds: u64) {
    // Independent of Child, protocol writer and every worker; no ordinary cleanup.
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(seconds));
        done(92)
    });
}
#[derive(Clone, Copy)]
struct WaitObservation {
    result: i32,
    pid: i32,
    signo: i32,
    error: i32,
    code: i32,
    status: i32,
}
impl WaitObservation {
    fn matches(self, pid: i32, expected: (i32, i32)) -> bool {
        self.pid == pid && (self.code, self.status) == expected
    }
}
fn observe(pid: i32) -> io::Result<Option<WaitObservation>> {
    let mut info: libc::siginfo_t = unsafe { mem::zeroed() };
    let rc = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    if info.si_pid == 0 {
        return Ok(None);
    }
    if info.si_pid != pid || info.si_signo != libc::SIGCHLD || info.si_errno != 0 {
        return Err(io::Error::other("wait identity"));
    }
    Ok(Some(WaitObservation {
        result: rc,
        pid: info.si_pid,
        signo: info.si_signo,
        error: info.si_errno,
        code: info.si_code,
        status: info.si_status,
    }))
}
fn emit_wait(w: &Wire, ordinal: u8, observed: WaitObservation) {
    emit(
        w,
        &format!(
            "WAIT_RETAINED exited {ordinal} {} {} {} {} {} {}",
            observed.result,
            observed.pid,
            observed.signo,
            observed.error,
            observed.code,
            observed.status
        ),
    );
}
fn wait_retained(w: &Wire, pid: i32, expected: (i32, i32)) -> io::Result<()> {
    let end = Instant::now() + IO;
    loop {
        match observe(pid)? {
            Some(observed) => {
                emit_wait(w, 1, observed);
                if !observed.matches(pid, expected) {
                    return Err(io::Error::other("unexpected exit"));
                }
                break;
            }
            None if Instant::now() < end => std::thread::sleep(Duration::from_millis(5)),
            None => return Err(io::Error::other("no exit")),
        }
    }
    // Two distinct actual WNOWAIT returns are published before exited identity.
    let Some(observed) = observe(pid)? else {
        return Err(io::Error::other("not retained"));
    };
    emit_wait(w, 2, observed);
    if !observed.matches(pid, expected) {
        return Err(io::Error::other("not retained"));
    }
    Ok(())
}
#[derive(Clone, Copy)]
enum IdentityPhase {
    Live,
    Exited,
}
impl IdentityPhase {
    fn wire(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Exited => "exited",
        }
    }
    fn arg(self) -> u64 {
        match self {
            Self::Live => 0,
            Self::Exited => 1,
        }
    }
}
fn identity_refused(w: &Wire, phase: IdentityPhase, reason: &'static str) -> io::Error {
    emit(w, &format!("IDENTITY_REFUSED {} {reason}", phase.wire()));
    io::Error::other(reason)
}
fn identity(w: &Wire, pid: i32, parent: u32, phase: IdentityPhase) -> io::Result<(u64, u64)> {
    let mut b: libc::proc_bsdinfo = unsafe { mem::zeroed() };
    let size = i32::try_from(mem::size_of_val(&b)).map_err(io::Error::other)?;
    let arg = phase.arg();
    // Darwin thread-local errno: clear immediately before, copy immediately after.
    // No formatting, allocation or other FFI intervenes around the actual call.
    let errno_ptr = unsafe { libc::__error() };
    let (got, error) = unsafe {
        *errno_ptr = 0;
        let got = libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            arg,
            (&mut b as *mut libc::proc_bsdinfo).cast(),
            size,
        );
        (got, *errno_ptr)
    };
    if got != size {
        // Incomplete output is not decoded, even though the buffer was zeroed.
        emit(
            w,
            &format!(
                "IDENTITY {} {arg} {pid} {parent} {} {size} {got} {error} 0 - - - - -",
                phase.wire(),
                libc::PROC_PIDTBSDINFO
            ),
        );
        return Err(identity_refused(w, phase, "length"));
    }
    emit(
        w,
        &format!(
            "IDENTITY {} {arg} {pid} {parent} {} {size} {got} {error} 1 {} {} {} {} {}",
            phase.wire(),
            libc::PROC_PIDTBSDINFO,
            b.pbi_pid,
            b.pbi_ppid,
            b.pbi_pgid,
            b.pbi_start_tvsec,
            b.pbi_start_tvusec
        ),
    );
    // A successful full result's errno is recorded, not a new acceptance predicate.
    if b.pbi_pid != pid as u32 {
        return Err(identity_refused(w, phase, "pid"));
    }
    if b.pbi_ppid != parent {
        return Err(identity_refused(w, phase, "ppid"));
    }
    if b.pbi_pgid != pid as u32 {
        return Err(identity_refused(w, phase, "pgid"));
    }
    if b.pbi_start_tvsec == 0 {
        return Err(identity_refused(w, phase, "zero_start"));
    }
    Ok((b.pbi_start_tvsec, b.pbi_start_tvusec))
}

pub(super) fn toy(root: &std::path::Path) -> ! {
    watchdog(60);
    let (path, outer) =
        crate::native_read_smoke::child_claim_profile::restart_profile::control_endpoint(root)
            .unwrap_or_else(|_| fail());
    let mut s = connect(path.to_str().unwrap_or_else(|| fail()), outer);
    need(s.set_read_timeout(Some(Duration::from_secs(50))));
    let pid = unsafe { libc::getpid() };
    let parent = unsafe { libc::getppid() };
    if unsafe { libc::getpgrp() } != pid {
        fail();
    }
    need(writeln!(s, "TOY {pid} {parent}"));
    match line(&mut s) {
        Ok(s) if s == "EXIT" => done(0),
        _ => done(91),
    }
}
pub(super) fn retain(
    handle: super::Handle,
    prepared: crate::native_read_smoke::child_claim_profile::restart_profile::Prepared,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
    closing: Arc<std::sync::atomic::AtomicBool>,
) -> ! {
    watchdog(20);
    let prepared = Box::leak(Box::new(prepared));
    let (path, outer) = prepared.endpoint().unwrap_or_else(|_| fail());
    if outer != unsafe { libc::getppid() } {
        fail();
    }
    let mut input = connect(path.to_str().unwrap_or_else(|| fail()), outer);
    let wire = Arc::new(Mutex::new(need(input.try_clone())));
    emit(&wire, &format!("A {}", std::process::id()));
    // Existing Arc, not a reconstructed Child. Leak the owner before lock. No
    // allocation/fallible work between successful lock acquisition and no-Drop.
    let owned = Box::leak(Box::new(handle.child));
    let guard = ManuallyDrop::new(owned.lock().unwrap_or_else(|_| fail()));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let pid = i32::try_from(guard.id()).unwrap_or_else(|_| fail());
        if pid <= 1 || pid != handle.pgid || pid == unsafe { libc::getpid() } {
            fail();
        }
        if checked(&wire, "initial_wait", observe(pid)).is_some() {
            fail();
        }
        let start = checked(
            &wire,
            "initial_identity",
            identity(&wire, pid, std::process::id(), IdentityPhase::Live),
        );
        emit(&wire, &format!("HELD {pid} {} {}", start.0, start.1));
        if prepared.checkpoint(false).is_err() {
            emit(&wire, "REFUSED ready_audit -1");
            fail();
        }
        if cancelled.load(std::sync::atomic::Ordering::SeqCst)
            || closing.load(std::sync::atomic::Ordering::SeqCst)
        {
            emit(&wire, "REFUSED ordinary_stop -1");
            fail();
        }
        emit(&wire, "READY");
        if need(line(&mut input)) != "OBSERVE" {
            fail();
        }
        let expected = (libc::CLD_EXITED, 0);
        checked(&wire, "retained_wait", wait_retained(&wire, pid, expected));
        let after = checked(
            &wire,
            "exit_identity",
            identity(&wire, pid, std::process::id(), IdentityPhase::Exited),
        );
        if after != start {
            emit(&wire, "IDENTITY_REFUSED exited changed_start");
            fail();
        }
        let visibility_started = Instant::now();
        emit(&wire, "EXIT_RETAINED 1 0");
        if checked(&wire, "visibility_gate", line(&mut input)) != "RETAINED_VISIBLE"
            || visibility_started.elapsed() > IO
        {
            fail();
        }
        if !checked(&wire, "visibility_retained", observe(pid))
            .is_some_and(|o| o.matches(pid, expected))
        {
            fail();
        }
        emit(&wire, "VISIBILITY_CONFIRMED");
        if prepared.checkpoint(true).is_err() {
            emit(&wire, "REFUSED exited_audit -1");
            fail();
        }
        if cancelled.load(std::sync::atomic::Ordering::SeqCst)
            || closing.load(std::sync::atomic::Ordering::SeqCst)
        {
            emit(&wire, "REFUSED ordinary_stop -1");
            fail();
        }
        emit(&wire, "CRASH_READY");
        loop {
            std::thread::park_timeout(IO);
        }
    }));
    if result.is_err() {
        emit(&wire, "PANIC_RETAINED");
        done(71);
    }
    fail()
}
