//! Page sheets use one source-fence dialect and upstream IronCalc. Agent
//! readers parse the fences here; scratch formulas use a private workbook.
//! Neither reader writes calculated values into the vault.

pub mod ai;
pub mod edit;
pub mod engine;
pub mod fence;
pub mod grid;
pub mod xlsx;

#[tauri::command(async)]
pub fn sheet_fill(
    sheets: Vec<engine::SheetInput>,
    sheet: usize,
    area: grid::Area,
    axis: grid::FillAxis,
    to: i32,
) -> Result<grid::FillResult, String> {
    engine::run_on_engine_thread(move |thread| grid::fill(thread, &sheets, sheet, area, axis, to))
}
#[tauri::command(async)]
pub fn sheet_complete(
    names: Vec<String>,
    sheet: usize,
    row: i32,
    column: i32,
    text: String,
    cursor: usize,
) -> Result<ironcalc_base::expressions::parser::CompletionContext, String> {
    engine::run_on_engine_thread(move |thread| {
        grid::complete(thread, names, sheet, row, column, text, cursor)
    })
}

#[tauri::command(async)]
pub fn calculate_sheets(
    sheets: Vec<engine::SheetInput>,
) -> Result<Vec<engine::SheetResult>, String> {
    let zone = crate::runtime::budget::system_timezone();
    engine::run_on_engine_thread(move |thread| engine::calculate(thread, &sheets, &zone))
}

#[tauri::command(async)]
pub fn sheet_restructure(
    sheets: Vec<engine::SheetInput>,
    sheet: usize,
    change: grid::GridChange,
    at: i32,
    count: i32,
) -> Result<grid::RestructureResult, String> {
    engine::run_on_engine_thread(move |thread| {
        grid::restructure(thread, &sheets, sheet, change, at, count)
    })
}
