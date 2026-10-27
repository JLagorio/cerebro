use super::*;
use serde_json::value::RawValue;

fn literal(text: &str) -> Mapping { Mapping::Literal { value: RawValue::from_string(text.into()).unwrap() } }
fn input(path: &[&str]) -> Mapping { Mapping::Input { path: path.iter().map(|s| (*s).into()).collect() } }
fn output(step: &str, path: &[&str]) -> Mapping {
    Mapping::Output { step_id: step.into(), path: path.iter().map(|s| (*s).into()).collect() }
}
fn context(text: &str) -> Context { Context::new(text, &BTreeMap::new()).unwrap() }

#[test]
fn field_selection_and_construction_preserve_exact_values() {
    let context = Context::new(r#"{"rows":[{"title":"first"},{"title":"second"}]}"#,
        &BTreeMap::from([("read".into(), r#"{"count":9007199254740993}"#.into())])).unwrap();
    let mapping = Mapping::Object { fields: BTreeMap::from([
        ("title".into(), input(&["rows", "1", "title"])),
        ("count".into(), output("read", &["count"])),
        ("fixed".into(), Mapping::Array { items: vec![literal("100.00"), literal("null"), literal("false")] }),
    ]) };
    assert_eq!(evaluate(&mapping, &context, None).unwrap(), r#"{"count":9007199254740993,"fixed":[1e2,null,false],"title":"second"}"#);
}

#[test]
fn skipped_branch_is_missing_and_exists_never_invents_an_output() {
    let context = context("{}");
    let missing = output("skipped", &["count"]);
    assert_eq!(evaluate(&missing, &context, None), Err(MappingError::MissingStepOutput {
        step_id: "skipped".into(), path: vec!["count".into()] }));
    assert_eq!(predicate(&Predicate::Exists { value: missing }, &context), Ok(false));
    assert_eq!(evaluate(&input(&["absent"]), &context, None), Err(MappingError::MissingInput { path: vec!["absent".into()] }));
    assert_eq!(predicate(&Predicate::Exists { value: literal("null") }, &context), Ok(true));
}

#[test]
fn comparisons_are_exact_and_do_not_coerce_missing_or_text() {
    let context = context("{}");
    assert_eq!(predicate(&Predicate::Greater { left: literal("9007199254740993"), right: literal("9007199254740992") }, &context), Ok(true));
    assert_eq!(predicate(&Predicate::Less { left: literal("-1e100"), right: literal("-999e95") }, &context), Ok(true));
    assert_eq!(predicate(&Predicate::Equals { left: literal("1.000"), right: literal("1e0") }, &context), Ok(true));
    assert_eq!(predicate(&Predicate::Less { left: literal("\"1\""), right: literal("2") }, &context), Err(MappingError::TypeMismatch));
    assert_eq!(predicate(&Predicate::Equals { left: output("skipped", &[]), right: literal("null") }, &context),
        Err(MappingError::MissingStepOutput { step_id: "skipped".into(), path: vec![] }));
}

#[test]
fn optional_fields_omit_only_under_a_declared_schema() {
    let context = context("{}");
    let mapping = Mapping::Object { fields: BTreeMap::from([
        ("required".into(), literal("1")), ("optional".into(), output("skipped", &[]))]) };
    let schema = r#"{"type":"object","properties":{"required":{"type":"integer"},"optional":{"type":"integer"}},"required":["required"],"additionalProperties":false}"#;
    assert_eq!(evaluate(&mapping, &context, Some(schema)), Ok(r#"{"required":1}"#.into()));
    let required = schema.replace("[\"required\"]", "[\"required\",\"optional\"]");
    for schema in [None, Some(required.as_str()), Some(r#"{"type":"object","additionalProperties":true}"#)] {
        assert!(matches!(evaluate(&mapping, &context, schema), Err(MappingError::MissingStepOutput { .. })));
    }
    assert_eq!(evaluate(&literal("\"wrong\""), &context, Some(r#"{"type":"integer"}"#)), Err(MappingError::SchemaMismatch));
}

#[test]
fn predicates_compose_without_evaluating_unselected_values() {
    let context = context("{}");
    let expr = Predicate::All { items: vec![
        Predicate::Exists { value: input(&["absent"]) },
        Predicate::Less { left: output("skipped", &[]), right: literal("0") },
    ] };
    assert_eq!(predicate(&expr, &context), Ok(false));
    assert_eq!(predicate(&Predicate::Not { value: Box::new(expr) }, &context), Ok(true));
    assert_eq!(predicate(&Predicate::Any { items: vec![Predicate::Exists { value: literal("false") },
        Predicate::Equals { left: output("skipped", &[]), right: literal("0") }] }, &context), Ok(true));
}

#[test]
fn expression_and_output_budgets_stop_bounded_interpretation() {
    let context = context("{}");
    let too_many = Mapping::Array { items: (0..128).map(|_| literal("0")).collect() };
    assert_eq!(evaluate(&too_many, &context, None), Err(MappingError::ExpressionLimit));
    let mut deep = literal("0");
    for _ in 0..16 { deep = Mapping::Array { items: vec![deep] }; }
    assert_eq!(evaluate(&deep, &context, None), Err(MappingError::ExpressionLimit));
    let context = super::tests::context(&serde_json::to_string(&"x".repeat(3_000)).unwrap());
    let repeated = Mapping::Array { items: (0..100).map(|_| input(&[])).collect() };
    assert_eq!(evaluate(&repeated, &context, None), Err(MappingError::OutputLimit));
}

#[test]
fn context_rejects_duplicates_and_unbounded_payloads_before_evaluation() {
    assert!(matches!(Context::new(r#"{"x":1,"x":2}"#, &BTreeMap::new()), Err(MappingError::InvalidJson)));
    let too_large = format!("\"{}\"", "x".repeat(262_144));
    assert!(matches!(Context::new(&too_large, &BTreeMap::new()), Err(MappingError::ContextLimit)));
}
