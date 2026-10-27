//! Bounded-message streaming export through an original held native save choice.
use super::{rows, transport::*};
use crate::{
    runtime::chat_generations::Scope,
    shell::file_actions::{publish_archive_copy, DraftCopyDestination},
};
use rusqlite::Connection;
use std::{
    io::{BufWriter, Write},
    path::Path,
};
fn unavailable<T>(_: T) -> ArchiveError {
    ArchiveError::unavailable()
}
pub(crate) fn write(
    conn: &Connection,
    scope: Scope<'_>,
    root: &Path,
    origin: &Path,
    choice: DraftCopyDestination,
    thread: &str,
    format: ExportFormat,
) -> Result<(String, bool), ArchiveError> {
    let mut statement = conn
        .prepare("SELECT vault_path FROM vault_registry")
        .map_err(unavailable)?;
    let mut cursor = statement.query([]).map_err(unavailable)?;
    let mut protected = Vec::new();
    while let Some(row) = cursor.next().map_err(unavailable)? {
        let value = row
            .get_ref(0)
            .map_err(unavailable)?
            .as_str()
            .map_err(unavailable)?;
        if value.len() > 4096 {
            return Err(ArchiveError::unavailable());
        }
        // An unreadable registered root cannot silently stop protecting it.
        protected.push(Path::new(value).canonicalize().map_err(unavailable)?);
    }
    let mut projection_error = None;
    let mut partial = false;
    let path = publish_archive_copy(origin, &protected, root, choice, |output| {
        match stream(conn, scope, thread, format, output) {
            Ok(value) => {
                partial = value;
                Ok(())
            }
            Err(error) => {
                projection_error = Some(error);
                Err(crate::files::bytes::Refusal {
                    code: "archive_unavailable".into(),
                    message: "Conversation export could not be completed.".into(),
                })
            }
        }
    })
    .map_err(|_| projection_error.unwrap_or_else(ArchiveError::unavailable))?;
    Ok((path, partial))
}
pub(super) fn stream(
    conn: &Connection,
    scope: Scope<'_>,
    thread: &str,
    format: ExportFormat,
    output: &mut impl Write,
) -> Result<bool, ArchiveError> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut writer = BufWriter::with_capacity(64 * 1024, output);
    let mut before = None;
    let mut first = true;
    let mut partial:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM conversation_bindings WHERE owner_person=?1 AND vault_id=?2 AND store_uuid=?3 AND thread_id=?4 AND completed_at IS NULL)",rusqlite::params![scope.owner,scope.vault,scope.store,thread],|row|row.get(0)).map_err(unavailable)?;
    let metadata:(Option<String>,Option<String>,Option<String>)=conn.query_row("SELECT CASE WHEN EXISTS(SELECT 1 FROM conversation_archive_content c WHERE c.attempt_id=t.title_generation_id AND (c.expires_at IS NULL OR c.expires_at>?5)) THEN t.title ELSE NULL END,t.parent_thread_id,t.branch_message_id FROM conversation_threads t WHERE t.owner_person=?1 AND t.vault_id=?2 AND t.store_uuid=?3 AND t.thread_id=?4 AND t.tombstone_at IS NULL",rusqlite::params![scope.owner,scope.vault,scope.store,thread,now],|row|{
            let mut fields=Vec::new();
            for (index,cap) in [(0,320),(1,128),(2,128)] {
                if matches!(row.get_ref(index)?,rusqlite::types::ValueRef::Null){fields.push(None);}else{
                    let value=row.get_ref(index)?.as_str()?;if value.len()>cap{return Err(rusqlite::Error::InvalidQuery);}fields.push(Some(value.to_owned()));
                }
            } Ok((fields.remove(0),fields.remove(0),fields.remove(0)))
        }).map_err(unavailable)?;
    let thread_record = serde_json::json!({"id":thread,"title":metadata.0,"parentThreadId":metadata.1,"branchMessageId":metadata.2});
    match format {
            ExportFormat::Json=>{
                writer.write_all(b"{\"format\":1,\"provenance\":\"local_archive\",\"order\":\"newest_first\",\"context\":").map_err(unavailable)?;
                serde_json::to_writer(&mut writer,&rows::context(scope)).map_err(unavailable)?;
                writer.write_all(b",\"thread\":").map_err(unavailable)?;serde_json::to_writer(&mut writer,&thread_record).map_err(unavailable)?;
                writer.write_all(b",\"messages\":[").map_err(unavailable)?;
            }
            ExportFormat::Markdown=>writeln!(writer,"# Conversation archive\n\nThread: {thread}\nVault identity: {}\nStore identity: {}\nParent thread: {}\nBranch message: {}\nTitle: {}\n\nNewest messages first. Only completed retained content is included. Expired, unavailable and unretained portions are labeled below.\n",scope.vault,scope.store,thread_record["parentThreadId"].as_str().unwrap_or("not recorded"),thread_record["branchMessageId"].as_str().unwrap_or("not recorded"),thread_record["title"].as_str().unwrap_or("not retained")).map_err(unavailable)?,
        }
    loop {
        // One bounded message at a time, never materialize a whole thread.
        let page = rows::messages(conn, scope, thread, before.as_deref(), 1, now)?;
        for message in page.items {
            partial |= message.content.as_ref().is_none_or(|content| {
                content.answer.availability != crate::agent::archive_codec::Availability::Complete
            });
            match format {
                ExportFormat::Json => {
                    if !first {
                        writer.write_all(b",").map_err(unavailable)?;
                    }
                    serde_json::to_writer(&mut writer, &message).map_err(unavailable)?;
                }
                ExportFormat::Markdown => {
                    writeln!(writer,"## Attempt {}\n\nOriginal completion: {}\nImported: {}\nOrigin: {:?}\nExpires: {}\nPersistence: {:?}\nContent state: {:?}\n",message.attempt_id,message.completed_at.as_deref().unwrap_or("not recorded"),message.imported_at.as_deref().unwrap_or("not an imported cache record"),message.origin,message.expires_at.as_deref().unwrap_or("no expiry recorded"),message.persistence,message.content_state).map_err(unavailable)?;
                    if let Some(content) = message.content {
                        writeln!(
                            writer,
                            "### Question\n\n{}\n\n### Answer\n",
                            content.display_message.text
                        )
                        .map_err(unavailable)?;
                        use crate::agent::archive_codec::Block;
                        for block in content.answer.blocks {
                            match block {
                                Block::Text { text, .. } => {
                                    writeln!(writer, "{text}\n").map_err(unavailable)?
                                }
                                Block::Tool { name, state, .. } => {
                                    writeln!(writer, "Tool: {name} ({state})\n")
                                        .map_err(unavailable)?
                                }
                                Block::Child { summary, .. } => {
                                    writeln!(writer, "Child summary: {summary}\n")
                                        .map_err(unavailable)?
                                }
                            }
                        }
                        writeln!(
                            writer,
                            "Completion: {}. Content availability: {:?}.\n",
                            content.completion_status, content.answer.availability
                        )
                        .map_err(unavailable)?;
                        for reference in content.answer.references {
                            use crate::agent::archive_references::Reference;
                            match reference {
                                Reference::Source { url, .. } => {
                                    writeln!(writer, "Source reference: {url}\n")
                                        .map_err(unavailable)?
                                }
                                Reference::Effect { invocation_id } => {
                                    writeln!(writer, "Effect reference: {invocation_id}\n")
                                        .map_err(unavailable)?
                                }
                                Reference::Artifact { path } => {
                                    writeln!(writer, "Artifact reference: {path}\n")
                                        .map_err(unavailable)?
                                }
                            }
                        }
                    } else {
                        writeln!(
                            writer,
                            "Content: {:?}; persistence: {:?}.\n",
                            message.content_state, message.persistence
                        )
                        .map_err(unavailable)?;
                    }
                }
            }
            first = false;
        }
        before = page.next_cursor;
        if before.is_none() {
            break;
        }
    }
    match format {ExportFormat::Json=>{write!(writer,"],\"partial\":{partial},\"storageNotice\":\"This user-owned export has its own lifetime. Archive expiry does not delete it, SQLite/WAL copies, backups, saved artifacts or CLI-owned sessions.\"}}\n").map_err(unavailable)?;},ExportFormat::Markdown=>writeln!(writer,"\nPartial export: {partial}. This user-owned export has its own lifetime. Archive expiry does not delete it, SQLite/WAL copies, backups, saved artifacts or CLI-owned sessions.").map_err(unavailable)?}
    writer.flush().map_err(unavailable)?;
    Ok(partial)
}
