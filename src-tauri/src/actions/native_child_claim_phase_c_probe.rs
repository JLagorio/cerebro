//! One-shot synchronization only, compiled solely in native-read-smoke.
use super::FreezeRefusal;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[derive(Default)]
struct State {
    reached: bool,
    released: bool,
}
struct Gate {
    state: Mutex<State>,
    changed: Condvar,
}
static ARMED: Mutex<Option<Arc<Gate>>> = Mutex::new(None);
// Fixed fixture bound, not a policy allowance or a replacement child deadline.
const WAIT: Duration = Duration::from_secs(20);

pub(crate) struct PhaseCProbe {
    gate: Arc<Gate>,
}
pub(crate) fn arm_child_claim_phase_c_probe() -> Result<PhaseCProbe, FreezeRefusal> {
    let mut armed = ARMED.lock().map_err(|_| FreezeRefusal::Unavailable)?;
    if armed.is_some() {
        return Err(FreezeRefusal::Unavailable);
    }
    let gate = Arc::new(Gate {
        state: Mutex::new(State::default()),
        changed: Condvar::new(),
    });
    *armed = Some(Arc::clone(&gate));
    Ok(PhaseCProbe { gate })
}
impl PhaseCProbe {
    pub(crate) fn wait_reached(&self) -> Result<(), FreezeRefusal> {
        let state = self
            .gate
            .state
            .lock()
            .map_err(|_| FreezeRefusal::Unavailable)?;
        let (state, _) = self
            .gate
            .changed
            .wait_timeout_while(state, WAIT, |s| !s.reached)
            .map_err(|_| FreezeRefusal::Unavailable)?;
        if state.reached {
            Ok(())
        } else {
            Err(FreezeRefusal::Unavailable)
        }
    }
    pub(crate) fn release(&self) -> Result<(), FreezeRefusal> {
        let mut state = self
            .gate
            .state
            .lock()
            .map_err(|_| FreezeRefusal::Unavailable)?;
        state.released = true;
        self.gate.changed.notify_all();
        Ok(())
    }
}
impl Drop for PhaseCProbe {
    fn drop(&mut self) {
        // Dropping a failed fixture cannot strand a claimant. Poison still
        // refuses the claim; the checkpoint also has its own bounded timeout.
        let _ = self.release();
        if let Ok(mut armed) = ARMED.lock() {
            if armed
                .as_ref()
                .is_some_and(|held| Arc::ptr_eq(held, &self.gate))
            {
                *armed = None;
            }
        }
    }
}
pub(super) fn checkpoint() -> Result<(), FreezeRefusal> {
    let gate = ARMED
        .lock()
        .map_err(|_| FreezeRefusal::Unavailable)?
        .as_ref()
        .map(Arc::clone);
    let Some(gate) = gate else {
        return Ok(());
    };
    let mut state = gate.state.lock().map_err(|_| FreezeRefusal::Unavailable)?;
    if state.reached {
        return Err(FreezeRefusal::Unavailable);
    }
    state.reached = true;
    gate.changed.notify_all();
    let (state, _) = gate
        .changed
        .wait_timeout_while(state, WAIT, |s| !s.released)
        .map_err(|_| FreezeRefusal::Unavailable)?;
    if state.released {
        Ok(())
    } else {
        Err(FreezeRefusal::Unavailable)
    }
}
