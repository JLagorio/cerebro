//! Exact selected-operation retention joins. These values describe an admitted
//! operation; they never create a receipt, path lock or selected authority.
use super::*;
use crate::workspace_service::types::selected::SelectedRecordVersion;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RetainedCopy {
    pub(crate) id: String,
    /// Exact Unix seconds, shared with the original unpublished receipt.
    pub(crate) captured_at: i64,
}
impl RetainedCopy {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.id.len() != 32
            || !self
                .id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.captured_at <= 0
            || self.captured_at > now()
        {
            return Err("recovery_selected_identity_conflict".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SelectedJoin {
    pub(crate) version: u32,
    pub(crate) operation_id: String,
    pub(crate) workspace_id: String,
    pub(crate) record_id: String,
    pub(crate) intent_identity_sha256: String,
}
impl SelectedJoin {
    fn source(&self) -> Result<String, String> {
        let uuid = crate::workspace_migration::identity::is_uuid_v4;
        if self.version != 1
            || !uuid(&self.operation_id)
            || !uuid(&self.workspace_id)
            || !uuid(&self.record_id)
            || self.workspace_id == self.record_id
            || self.intent_identity_sha256.len() != 64
            || !self
                .intent_identity_sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("recovery_selected_identity_conflict".into());
        }
        let source = serde_json::to_string(self).map_err(unavailable)?;
        if source.len() > limits().selected_join_bytes {
            return Err(unavailable("selected join exceeds its bound"));
        }
        Ok(source)
    }
}

pub(crate) struct SelectedCaptureRequest<'a> {
    pub(crate) lock: &'a PathLock,
    pub(crate) vault: &'a Path,
    pub(crate) path: &'a str,
    pub(crate) current: &'a str,
    pub(crate) content: &'a str,
    pub(crate) bypass: Option<&'a str>,
    pub(crate) expected: &'a SelectedRecordVersion,
}
pub(crate) struct SelectedSettlement<'a> {
    pub(crate) lock: &'a PathLock,
    pub(crate) vault: &'a Path,
    pub(crate) path: &'a str,
    pub(crate) reference: &'a RetainedCopy,
    pub(crate) join: &'a SelectedJoin,
    pub(crate) before: &'a [u8],
    pub(crate) after_hash: &'a str,
}

impl Journal {
    /// The concrete builder can be constructed only by the selected writer.
    /// This is not a callback accepting arbitrary proofs or an authority door.
    #[cfg(unix)]
    pub(crate) fn prepare_selected(
        &self,
        request: SelectedCaptureRequest<'_>,
        identity: &mut crate::workspace_service::selected::CaptureIdentity<'_>,
    ) -> Result<Outcome, String> {
        let SelectedCaptureRequest {
            lock,
            vault,
            path,
            current,
            content,
            bypass,
            expected,
        } = request;
        if !lock.covers(&vault.join(path)) {
            return Err(unavailable("selected capture lock does not cover target"));
        }
        bounded_path(path)?;
        let vault_id = self.vault(vault)?;
        let before = hash(current.as_bytes());
        let after = hash(content.as_bytes());
        let selected = serde_json::to_string(expected).map_err(unavailable)?;
        if let Some(nonce) = bypass {
            let binding = self
                .failures
                .lock()
                .map_err(|_| unavailable("failure choices unavailable"))?
                .remove(nonce)
                .ok_or("recovery_bypass_invalid")?;
            if binding.vault != vault_id
                || binding.path != path
                || binding.before != before
                || binding.after != after
                || binding.selected.as_deref() != Some(selected.as_str())
                || binding.expires_at <= now()
            {
                return Err("recovery_bypass_invalid".into());
            }
            return Ok(Outcome::WithoutCopy);
        }
        let mut capture = || -> Result<Outcome, String> {
            match eligible_target(vault, path) {
                Err(error) if error == "recovery_privacy_excluded" => {
                    return Ok(Outcome::NotRetained {
                        reason: "privacy".into(),
                    })
                }
                Err(error) => return Err(error),
                Ok(_) => {}
            }
            if !self.enabled(vault)? {
                return Ok(Outcome::Off);
            }
            if current == content {
                return Ok(Outcome::NotRetained {
                    reason: "unchanged".into(),
                });
            }
            let size = i64::try_from(current.len()).map_err(unavailable)?;
            if size > limits().entry_bytes {
                return Ok(Outcome::NotRetained {
                    reason: "entry_limit".into(),
                });
            }
            let mut conn = self.connect()?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(unavailable)?;
            Self::expire(&tx)?;
            let evicted = Self::make_room(&tx, size)?;
            let reference = RetainedCopy {
                id: format!("{:032x}", rand::random::<u128>()),
                captured_at: now(),
            };
            reference.validate()?;
            let join = identity.attach(&reference)?;
            let joined = join.source()?;
            let key = lock.recovery_key(&vault.join(path))?;
            tx.execute("INSERT INTO copies(id,vault,path,lock_key,before_hash,after_hash,captured_at,state,bytes,selected_join) VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',?8,?9)",params![reference.id,vault_id,path,key,before,after,reference.captured_at,current.as_bytes(),joined]).map_err(unavailable)?;
            let settlement = SelectedSettlement {
                lock,
                vault,
                path,
                reference: &reference,
                join: &join,
                before: current.as_bytes(),
                after_hash: &after,
            };
            if self.selected_row(&tx, &settlement)? != "pending" {
                return Err("recovery_selected_identity_conflict".into());
            }
            tx.commit().map_err(unavailable)?;
            crate::crash::stop_point("selected-retention-captured");
            Ok(Outcome::Retained {
                id: reference.id,
                evicted,
            })
        };
        capture().map_err(|error| {
            self.refuse_bound(
                &vault_id,
                path,
                &before,
                &after,
                Some(selected.as_str()),
                if error == "recovery_capacity_pending" {
                    "pending_capacity"
                } else {
                    "journal_storage_failed"
                },
            )
        })
    }

    fn selected_row(
        &self,
        conn: &Connection,
        request: &SelectedSettlement<'_>,
    ) -> Result<String, String> {
        let SelectedSettlement {
            lock,
            vault,
            path,
            reference,
            join,
            before,
            after_hash,
        } = request;
        if !lock.covers(&vault.join(path)) {
            return Err(unavailable(
                "selected settlement lock does not cover target",
            ));
        }
        reference.validate()?;
        bounded_path(path)?;
        let vault_id = self.vault(vault)?;
        let key = lock.recovery_key(&vault.join(path))?;
        let source = join.source()?;
        let found: Option<(String,Vec<u8>)> = conn.query_row(
            "SELECT state,bytes FROM copies WHERE id=?1 AND vault=?2 AND path=?3 AND lock_key=?4 AND before_hash=?5 AND after_hash=?6 AND captured_at=?7 AND selected_join=?8 AND length(bytes)<=?9",
            params![reference.id,vault_id,path,key,hash(before),after_hash,reference.captured_at,source,limits().entry_bytes],
            |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional().map_err(unavailable)?;
        // Absence is never authenticated expiry or a successful earlier delete.
        let Some((state, bytes)) = found else {
            return Err("recovery_selected_identity_conflict".into());
        };
        if bytes != *before || !matches!(state.as_str(), "pending" | "committed") {
            return Err("recovery_selected_identity_conflict".into());
        }
        Ok(state)
    }

    pub(crate) fn verify_selected_rollback(
        &self,
        request: &SelectedSettlement<'_>,
    ) -> Result<(), String> {
        if self.selected_row(&self.connect()?, request)? != "pending" {
            return Err("recovery_selected_identity_conflict".into());
        }
        Ok(())
    }
    pub(crate) fn verify_selected_commit(
        &self,
        request: &SelectedSettlement<'_>,
    ) -> Result<(), String> {
        // Retirement-first producers commit the retained row only after the
        // pending intent is gone. A committed row here has no supported cause
        // and is evictable, so it cannot protect an unretired intent.
        self.verify_selected_rollback(request)
    }
    pub(crate) fn commit_selected(&self, request: &SelectedSettlement<'_>) -> Result<(), String> {
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(unavailable)?;
        if self.selected_row(&tx, request)? == "pending" {
            let changed = tx.execute("UPDATE copies SET state='committed' WHERE id=?1 AND state='pending' AND selected_join=?2 AND captured_at=?3",
                params![request.reference.id,request.join.source()?,request.reference.captured_at]).map_err(unavailable)?;
            if changed != 1 {
                return Err("recovery_selected_identity_conflict".into());
            }
        }
        tx.commit().map_err(unavailable)?;
        crate::crash::stop_point("selected-retention-committed");
        Ok(())
    }
    /// Only after rollback retirement. A failure leaves conservative pending
    /// bytes; another operation cannot turn them into a committed copy.
    pub(crate) fn discard_selected_rollback(
        &self,
        request: &SelectedSettlement<'_>,
    ) -> Result<(), String> {
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(unavailable)?;
        if self.selected_row(&tx, request)? != "pending" {
            return Err("recovery_selected_identity_conflict".into());
        }
        let changed = tx.execute("DELETE FROM copies WHERE id=?1 AND state='pending' AND selected_join=?2 AND captured_at=?3",
            params![request.reference.id,request.join.source()?,request.reference.captured_at]).map_err(unavailable)?;
        if changed != 1 {
            return Err("recovery_selected_identity_conflict".into());
        }
        tx.commit().map_err(unavailable)?;
        crate::crash::stop_point("selected-retention-rollback-deleted");
        Ok(())
    }
}
