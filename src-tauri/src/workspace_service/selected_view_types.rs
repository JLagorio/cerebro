//! Closed descriptive frame data; no window/opening/store capability is serialized.
use serde::{Deserialize, Serialize};
use crate::workspace_service::{selected::SelectedEditorTarget, types::{selected::{SelectedEntryProperties,SelectedRecordVersion},values::PropertyValue}};
#[cfg(test)]
fn bounded_u32_schema(_: &mut schemars::gen::SchemaGenerator) -> schemars::schema::Schema {
    use schemars::schema::{InstanceType,NumberValidation,SchemaObject};
    SchemaObject { instance_type:Some(InstanceType::Integer.into()), number:Some(Box::new(NumberValidation { minimum:Some(0.0),maximum:Some(f64::from(u32::MAX)),..NumberValidation::default() })),..SchemaObject::default() }.into()
}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct SelectedSavedViewRequest {
    pub target:SelectedEditorTarget,
    pub expected_version:SelectedRecordVersion,
    pub view_id:String,
}
#[derive(Debug,Clone,PartialEq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct SelectedSavedViewRecord {
    pub path:String,pub filename:String,pub folder:String,pub project:Option<String>,pub title:String,
    #[serde(rename="type")] pub entry_type:Option<String>,
    pub snippet:String,pub outgoing_links:Vec<String>,pub created_at:String,pub modified_at:String,pub hash:String,
    pub authority:SelectedRecordVersion,pub canonical_properties:SelectedEntryProperties,
}
#[derive(Debug,Clone,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct SelectedSavedViewColumn {pub name:String,pub kind:String}
#[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="snake_case")]
pub(crate) enum SelectedSavedViewLayout {Table,List}
#[derive(Debug,Clone,PartialEq,Serialize,Deserialize)]
#[cfg_attr(test,derive(schemars::JsonSchema))]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct SelectedSavedViewFrame {
    pub type_record:SelectedSavedViewRecord,
    pub schema_evidence:Vec<SelectedSavedViewRecord>,
    pub entries:Vec<SelectedSavedViewRecord>,pub columns:Vec<SelectedSavedViewColumn>,
    pub layout:SelectedSavedViewLayout,pub view_id:String,pub view_name:String,pub configuration:PropertyValue,
    #[cfg_attr(test,schemars(schema_with="bounded_u32_schema"))] pub total:u32,
    #[cfg_attr(test,schemars(schema_with="bounded_u32_schema"))] pub shown:u32,
    pub capped:bool,pub snapshot_epoch:String,pub timezone:String,pub today:String,
}
