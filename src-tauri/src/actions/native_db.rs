//! Read-only query surface shared by the native kernel and action adapter.
#[cfg(test)]
use crate::runtime::ReadOnly;
use rusqlite::Connection;

#[derive(Clone, Copy)]
pub(super) enum AuthorityDb<'a> {
    Writer(&'a Connection),
    Retained(&'a super::native_owner::RetainedRead<'a>),
    #[cfg(test)]
    Reader(&'a ReadOnly),
}
impl AuthorityDb<'_> {
    pub(super) fn query_all<T>(
        &self,
        sql: &str,
        values: &[&str],
        f: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<Vec<T>> {
        if let Self::Retained(read) = self {
            return read.query_all(sql, values, f);
        }
        let mut statement = match self {
            Self::Writer(c) => c.prepare(sql)?,
            Self::Retained(_) => unreachable!("retained reader handled above"),
            #[cfg(test)]
            Self::Reader(c) => c.prepare(sql)?,
        };
        let rows = statement.query_map(rusqlite::params_from_iter(values), f)?;
        rows.collect()
    }
    pub(super) fn query<T>(
        &self,
        sql: &str,
        values: &[&str],
        f: impl FnOnce(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
    ) -> rusqlite::Result<T> {
        match self {
            Self::Writer(c) => c.query_row(sql, rusqlite::params_from_iter(values), f),
            Self::Retained(c) => c.query(sql, values, f),
            #[cfg(test)]
            Self::Reader(c) => c.query_row(sql, rusqlite::params_from_iter(values), f),
        }
    }
}
