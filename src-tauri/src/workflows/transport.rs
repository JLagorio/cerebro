//! Generated workflow transport data only. Native ownership never crosses IPC.
//! JSON text leaves preserve exact decimals and the existing Rust AST codec.
use serde::{Serialize,Deserialize};
use crate::actions::SafeCounter;
use crate::actions::read_types::required_nullable;
#[cfg(test)]use crate::actions::read_types::RequiredNullable;
macro_rules! words{($name:ident{$($variant:ident),+$(,)?})=>{#[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize,Deserialize)]#[cfg_attr(test,derive(schemars::JsonSchema))]#[serde(rename_all="snake_case")]pub(crate) enum $name{$($variant),+}};}
words!(WorkflowRunState{Queued,Running,Waiting,Blocked,Succeeded,Failed,Cancelled});
words!(WorkflowStepState{Pending,Running,Waiting,Blocked,Succeeded,Failed,Skipped,Cancelled});
words!(WorkflowStepKind{Read,Transform,Condition,Action,Timer,ExternalInput,Result});
words!(WorkflowWaitKind{Timer,ExternalInput,PersonApproval});
words!(WorkflowWaitState{Pending,Consumed,Cancelled,Expired});
words!(WorkflowInputScope{AllValidInputs,ExactCanonicalInput});
words!(WorkflowAdmission{Ready,Busy,Unavailable});
words!(WorkflowErrorCode{InvalidInput,InvalidDefinition,UnsupportedFormat,LimitExceeded,Conflict,Stale,Denied,Unavailable});
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowContext{pub vault_id:String,pub store_uuid:String}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowVersionRef{pub workflow_id:String,pub definition_hash:String}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(tag="kind",rename_all="snake_case",rename_all_fields="camelCase",deny_unknown_fields)]
pub(crate) enum WorkflowOperationDraft{
 Read{#[serde(rename="queryJson")]query_json:String,#[serde(rename="outputSchemaJson")]output_schema_json:String,#[serde(rename="nextStepId")]next_step_id:String},
 Transform{#[serde(rename="mappingJson")]mapping_json:String,#[serde(rename="outputSchemaJson")]output_schema_json:String,#[serde(rename="nextStepId")]next_step_id:String},
 Condition{#[serde(rename="predicateJson")]predicate_json:String,#[serde(rename="ifTrue")]if_true:String,#[serde(rename="ifFalse")]if_false:String},
 Action{#[serde(rename="actionId")]action_id:String,#[serde(rename="definitionDigest")]definition_digest:String,#[serde(rename="connectionId")]connection_id:String,#[serde(rename="accountId")]account_id:String,#[serde(rename="inputJson")]input_json:String,#[serde(rename="nextStepId")]next_step_id:String},
 Timer{at:String,#[serde(rename="nextStepId")]next_step_id:String},
 ExternalInput{#[serde(rename="schemaJson")]schema_json:String,#[serde(rename="expiresAt")]expires_at:String,#[serde(rename="nextStepId")]next_step_id:String},
 Result{#[serde(rename="outputJson")]output_json:String},
}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowStepDraft{pub step_id:String,pub label:String,pub operation:WorkflowOperationDraft}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowDraft{pub workflow_id:String,pub entry_step_id:String,pub input_schema_json:String,pub trigger_json:String,pub steps:Vec<WorkflowStepDraft>}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowDraftSnapshot{pub etag:String,pub draft:WorkflowDraft}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowPublication{pub version:WorkflowVersionRef,pub revision:SafeCounter}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowUnpublishRequest {
    pub context: WorkflowContext,
    pub request_key: String,
    pub publication: WorkflowPublication,
}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowUnpublishAck {
    pub context: WorkflowContext,
    pub request_key: String,
    pub original: WorkflowPublication,
    pub publication_revision: SafeCounter,
    pub replayed: bool,
}

#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowDiagnostic{pub code:WorkflowErrorCode,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<String>"))]pub step_id:Option<String>,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<String>"))]pub field:Option<String>}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowValidation{pub valid:bool,pub diagnostics:Vec<WorkflowDiagnostic>}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(tag="state",rename_all="snake_case",rename_all_fields="camelCase",deny_unknown_fields)]
pub(crate) enum WorkflowActivationView{Unavailable{},Disabled{revision:SafeCounter},Enabled{revision:SafeCounter,version:WorkflowVersionRef}}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowListItem{pub workflow_id:String,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<WorkflowPublication>"))]pub publication:Option<WorkflowPublication>,pub readable:bool}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowCatalog{pub context:WorkflowContext,pub items:Vec<WorkflowListItem>,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<String>"))]pub next_cursor:Option<String>,pub truncated:bool}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowDocument{pub context:WorkflowContext,pub workflow_id:String,pub publication_revision:SafeCounter,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<WorkflowDraftSnapshot>"))]pub draft:Option<WorkflowDraftSnapshot>,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<WorkflowPublication>"))]pub publication:Option<WorkflowPublication>,pub versions:Vec<WorkflowVersionRef>,pub versions_truncated:bool,pub activation:WorkflowActivationView}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowAccountPermission{pub connection:String,pub account:String,pub action:String,pub definition:String,pub capabilities:Vec<String>,pub input_scope:WorkflowInputScope,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<String>"))]pub input_digest:Option<String>}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowPermissions{pub read_prefixes:Vec<String>,pub query_records:bool,pub accounts:Vec<WorkflowAccountPermission>}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowStartRequest{pub context:WorkflowContext,pub version:WorkflowVersionRef,pub start_key:String,pub input_json:String,pub permissions:WorkflowPermissions}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowStartAck{pub context:WorkflowContext,pub version:WorkflowVersionRef,pub run_id:String,pub revision:SafeCounter,pub admission_epoch:SafeCounter,pub created:bool,pub admission:WorkflowAdmission}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(tag="state",rename_all="snake_case",deny_unknown_fields)]
pub(crate) enum WorkflowValueView{Available{digest:String,bytes:SafeCounter},NotRecorded{},NotRetained{digest:String},Unavailable{}}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowWaitView{pub continuation_id:String,pub kind:WorkflowWaitKind,pub revision:SafeCounter,pub state:WorkflowWaitState,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<String>"))]pub due_at:Option<String>,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<String>"))]pub expires_at:Option<String>,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<String>"))]pub schema_json:Option<String>}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowStepView{pub step_id:String,pub label:String,pub kind:WorkflowStepKind,pub state:WorkflowStepState,pub ordinal:SafeCounter,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<String>"))]pub reason:Option<String>,pub input:WorkflowValueView,pub output:WorkflowValueView,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<String>"))]pub invocation_id:Option<String>,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<WorkflowWaitView>"))]pub wait:Option<WorkflowWaitView>}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowRunView{pub context:WorkflowContext,pub version:WorkflowVersionRef,pub run_id:String,pub native_run_id:String,pub state:WorkflowRunState,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<String>"))]pub reason:Option<String>,pub revision:SafeCounter,pub admission_epoch:SafeCounter,pub configuration_digest:String,pub input_digest:String,pub cancel_requested:bool,pub steps:Vec<WorkflowStepView>}

words!(WorkflowValueRole{RunInput,StepInput,StepOutput});

#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowSaveRequest{pub context:WorkflowContext,pub draft:WorkflowDraft,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<String>"))]pub expected_etag:Option<String>}

#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowPublishRequest{pub context:WorkflowContext,pub workflow_id:String,pub expected_draft_etag:String,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<SafeCounter>"))]pub expected_publication_revision:Option<SafeCounter>}

#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowRunRequest{pub context:WorkflowContext,pub run_id:String,pub expected_revision:SafeCounter,pub expected_epoch:SafeCounter}

#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowReauthorizeRequest{pub context:WorkflowContext,pub run_id:String,pub expected_epoch:SafeCounter,pub permissions:WorkflowPermissions}

#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowWaitAnswer{pub context:WorkflowContext,pub run_id:String,pub continuation_id:String,pub expected_revision:SafeCounter,pub signal_key:String,pub input_json:String}

#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowActionAnswer{pub context:WorkflowContext,pub run_id:String,pub invocation_id:String,pub approval_id:String,pub expected_invocation_revision:SafeCounter,pub expected_approval_revision:SafeCounter,pub allow:bool,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<String>"))]pub edited_input_json:Option<String>}

#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowValueRequest{pub context:WorkflowContext,pub run_id:String,pub step_id:String,pub role:WorkflowValueRole,pub digest:String}

#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowValueDetail{pub digest:String,pub json:String}

#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowError{pub code:WorkflowErrorCode,pub diagnostics:Vec<WorkflowDiagnostic>}

#[cfg(test)]
#[path="transport_tests.rs"]
mod tests;

/// Finite paged history; completed content is never part of the run index.
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowRunListItem{pub version:WorkflowVersionRef,pub run_id:String,pub state:WorkflowRunState,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<String>"))]pub reason:Option<String>,pub revision:SafeCounter,pub admission_epoch:SafeCounter,pub started_at:String,pub updated_at:String}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowRunCatalog{pub context:WorkflowContext,pub items:Vec<WorkflowRunListItem>,#[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<String>"))]pub next_cursor:Option<String>,pub truncated:bool}

/// Original permission ceiling and current selection, read-only comparison data.
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowAccessView{pub context:WorkflowContext,pub run_id:String,pub admission_epoch:SafeCounter,pub original:WorkflowPermissions,pub current:WorkflowPermissions}

// Awake schedule configuration is separate from completed-run retention and
// from a currently admitted native execution. These are comparison data only.
words!(WorkflowScheduleState{Enabled,Paused,Removed});
words!(WorkflowScheduleOperation{Enable,Pause,Remove});
words!(WorkflowMonitoring{Queued,Observed,Busy,Unavailable});
words!(WorkflowScheduleReadiness{Unconfigured,Ready,Paused,Removed,RecoveryHeld,NeedsAccess,Unavailable});
words!(WorkflowMonitorState{Watching,Stopped,Unavailable});
words!(WorkflowScheduleDisposition{Idle,Due,Paused,NotReady,RecoveryHeld,ClockBackwards});
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowScheduleConfiguration{
 pub activation_id:String,pub version:WorkflowVersionRef,pub state:WorkflowScheduleState,
 pub revision:SafeCounter,pub epoch:String,pub configuration_digest:String,
 pub input_digest:String,pub permission_digest:String,pub trigger_digest:String,
 pub anchor_ms:SafeCounter,pub cursor_ms:SafeCounter,pub recovery_held:bool,
 pub coverage_known:bool,pub skipped_count:SafeCounter,pub coalesced_count:SafeCounter,
 #[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<SafeCounter>"))]pub observed_at_ms:Option<SafeCounter>,
 #[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<SafeCounter>"))]pub first_skipped_ms:Option<SafeCounter>,
 #[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<SafeCounter>"))]pub last_skipped_ms:Option<SafeCounter>,
 #[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<String>"))]pub input_json:Option<String>,
 #[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<WorkflowPermissions>"))]pub permissions:Option<WorkflowPermissions>,
}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowScheduleView{
 pub context:WorkflowContext,pub workflow_id:String,
 #[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<WorkflowScheduleConfiguration>"))]pub configuration:Option<WorkflowScheduleConfiguration>,
 pub readiness:WorkflowScheduleReadiness,pub monitoring:WorkflowMonitorState,
}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowScheduleEnableRequest{
 pub context:WorkflowContext,pub version:WorkflowVersionRef,pub request_key:String,
 pub expected_revision:SafeCounter,pub input_json:String,pub permissions:WorkflowPermissions,
}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowScheduleChangeRequest{
 pub context:WorkflowContext,pub workflow_id:String,pub request_key:String,pub expected_revision:SafeCounter,
}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowScheduleReceipt{
 pub operation:WorkflowScheduleOperation,pub revision:SafeCounter,pub epoch:String,
 pub state:WorkflowScheduleState,pub version:WorkflowVersionRef,
}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowScheduleAck{
 pub context:WorkflowContext,pub workflow_id:String,pub receipt:WorkflowScheduleReceipt,
 pub current:WorkflowScheduleConfiguration,pub replayed:bool,
 // Null means this response did not request installation (replay/Pause/Remove).
 #[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<WorkflowMonitoring>"))]pub monitoring:Option<WorkflowMonitoring>,
}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowScheduleMonitorAck{pub context:WorkflowContext,pub monitoring:WorkflowMonitoring}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct WorkflowSchedulePreview{
 pub context:WorkflowContext,pub workflow_id:String,pub revision:SafeCounter,pub epoch:String,
 pub disposition:WorkflowScheduleDisposition,pub coverage_known:bool,
 #[serde(deserialize_with="required_nullable")]#[cfg_attr(test,schemars(with="RequiredNullable<SafeCounter>"))]pub due_at_ms:Option<SafeCounter>,
 pub cursor_ms:SafeCounter,pub skipped_count:SafeCounter,pub coalesced_count:SafeCounter,
}
