//! Reads cached values from the unchanged IronCalc 0.8.3 workbook carrier.
//! No evaluation, formula rewriting, filesystem, or clock. The reader never
//! calls the unused wasm-bindgen import stubs inherited from its dependency.
//! The browser passes only bytes just returned by the pinned model's toBytes.
use ironcalc_base::{cell::CellValue, language::get_language, types::Workbook};
use serde_json::{json, Value};
use std::cell::RefCell;
const MAX_BYTES: usize = 64 * 1024 * 1024;
thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}
fn values(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > MAX_BYTES {
        return Err("The calculation snapshot is too large.".into());
    }
    let workbook: Workbook =
        bitcode::decode(bytes).map_err(|_| "The calculation snapshot could not be read.")?;
    let language = get_language("en")?;
    let mut cells = Vec::new();
    for (sheet, worksheet) in workbook.worksheets.iter().enumerate() {
        for (row, columns) in &worksheet.sheet_data {
            for (col, cell) in columns {
                let value = match cell.value(&workbook.shared_strings, language) {
                    CellValue::None => Value::Null,
                    CellValue::Number(value) => json!(value),
                    CellValue::Boolean(value) => json!(value),
                    CellValue::String(value) => json!(value),
                };
                cells.push(json!({"sheet":sheet,"row":row,"col":col,"value":value}));
            }
        }
    }
    Ok(json!(cells))
}
// These are the complete C ABI. Vec owns every allocation; no raw pointer is
// dereferenced in Rust. The host copies into/out of the returned memory spans.
#[no_mangle]
pub extern "C" fn input_buffer(len: u32) -> u32 {
    if len as usize > MAX_BYTES {
        return 0;
    }
    INPUT.with(|input| {
        let mut bytes = input.borrow_mut();
        bytes.resize(len as usize, 0);
        bytes.as_mut_ptr() as u32
    })
}
#[no_mangle]
pub extern "C" fn read_values() -> u32 {
    let reply = INPUT.with(|input| match values(&input.borrow()) {
        Ok(cells) => json!({"ok":true,"cells":cells}),
        Err(error) => json!({"ok":false,"error":error}),
    });
    OUTPUT.with(|output| {
        let mut bytes = output.borrow_mut();
        *bytes = serde_json::to_vec(&reply).expect("JSON data serializes");
        bytes.as_ptr() as u32
    })
}
#[no_mangle]
pub extern "C" fn output_len() -> u32 {
    OUTPUT.with(|output| output.borrow().len() as u32)
}
#[no_mangle]
pub extern "C" fn release_buffers() {
    INPUT.with(|input| *input.borrow_mut() = Vec::new());
    OUTPUT.with(|output| *output.borrow_mut() = Vec::new());
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cached_values_keep_precision_and_never_recalculate() {
        let mut model = ironcalc_base::Model::new_empty("report", "en", "UTC", "en").unwrap();
        model.set_user_input(0, 1, 1, "=1/3".into()).unwrap();
        model.set_user_input(0, 2, 1, "=SHEETS()".into()).unwrap();
        model.evaluate();
        let answer = values(&model.to_bytes()).unwrap();
        let cells = answer.as_array().unwrap();
        assert_eq!(
            cells.iter().find(|c| c["row"] == 1).unwrap()["value"].as_f64(),
            Some(1.0 / 3.0)
        );
        assert_eq!(
            cells.iter().find(|c| c["row"] == 2).unwrap()["value"].as_f64(),
            Some(1.0)
        );
    }
    #[test]
    fn malformed_carriers_refuse_without_panicking() {
        assert!(values(b"not a workbook").is_err());
    }
}
