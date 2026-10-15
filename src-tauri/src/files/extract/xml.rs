//! Small, bounded XML tree for Office parts. No DTD or custom entity is accepted.
use super::Failure;
use quick_xml::{events::Event, Reader};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default)]
pub struct Node {
    pub name: String,
    pub attrs: BTreeMap<String, String>,
    pub raw_attrs: BTreeMap<String, String>,
    pub children: Vec<Node>,
    pub text: String,
}
impl Node {
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.get(name).map(String::as_str)
    }
    pub fn raw_attr(&self, name: &str) -> Option<&str> {
        self.raw_attrs.get(name).map(String::as_str)
    }
    pub fn child(&self, name: &str) -> Option<&Node> {
        self.children.iter().find(|n| n.name == name)
    }
    pub fn descendants<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Node> {
        let mut stack = vec![self];
        std::iter::from_fn(move || loop {
            let node = stack.pop()?;
            stack.extend(node.children.iter().rev());
            if node.name == name {
                return Some(node);
            }
        })
    }
    pub fn all_text(&self) -> String {
        let mut out = self.text.clone();
        for child in &self.children {
            out.push_str(&child.all_text());
        }
        out
    }
}
fn decode(bytes: &[u8]) -> Result<String, Failure> {
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|_| Failure::corrupt("XML is not UTF-8"))
}
pub fn unescape(text: &str) -> Result<String, Failure> {
    quick_xml::escape::unescape(text)
        .map(|s| s.into_owned())
        .map_err(|_| Failure::corrupt("XML contains an unknown entity"))
}
pub fn parse(bytes: &[u8]) -> Result<Node, Failure> {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().check_end_names = true;
    let mut stack = vec![Node::default()];
    let mut nodes = 0_usize;
    loop {
        let event = reader
            .read_event()
            .map_err(|_| Failure::corrupt("XML is malformed"))?;
        let empty = matches!(&event, Event::Empty(_));
        match event {
            Event::Start(e) | Event::Empty(e) => {
                nodes += 1;
                if nodes > 1_000_000 {
                    return Err(Failure::too_large(
                        "an XML part has more than 1,000,000 elements",
                    ));
                }
                if stack.len() > 256 {
                    return Err(Failure::corrupt("XML nesting is deeper than 256"));
                }
                let mut node = Node {
                    name: decode(e.local_name().as_ref())?,
                    ..Node::default()
                };
                for attr in e.attributes() {
                    let attr =
                        attr.map_err(|_| Failure::corrupt("XML has a malformed attribute"))?;
                    let name = decode(attr.key.local_name().as_ref())?;
                    let value = unescape(&decode(&attr.value)?)?;
                    node.raw_attrs
                        .insert(decode(attr.key.as_ref())?, value.clone());
                    // Local-name matching also accepts Strict Office namespace URIs.
                    // Office commonly has both numeric `id` and relationship
                    // `r:id`; the latter is the reference regardless of order.
                    let qualified = attr.key.as_ref().contains(&b':');
                    if qualified || !node.attrs.contains_key(&name) {
                        node.attrs.insert(name, value);
                    }
                }
                if empty {
                    stack.last_mut().expect("root").children.push(node);
                } else {
                    stack.push(node);
                }
            }
            Event::End(_) => {
                if stack.len() == 1 {
                    return Err(Failure::corrupt("XML has an unmatched closing tag"));
                }
                let node = stack.pop().expect("non-root");
                stack.last_mut().expect("root").children.push(node);
            }
            Event::Text(e) => stack
                .last_mut()
                .expect("root")
                .text
                .push_str(&unescape(&decode(&e)?)?),
            Event::CData(e) => stack.last_mut().expect("root").text.push_str(&decode(&e)?),
            Event::DocType(_) => {
                return Err(Failure::corrupt(
                    "declares a DOCTYPE, which no Office file does",
                ))
            }
            Event::GeneralRef(e) => {
                let entity = format!("&{};", decode(&e)?);
                stack
                    .last_mut()
                    .expect("root")
                    .text
                    .push_str(&unescape(&entity)?);
            }
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 {
        return Err(Failure::corrupt("XML ended inside an element"));
    }
    let mut root = stack.pop().expect("root");
    if root.children.len() != 1 || !root.text.trim().is_empty() {
        return Err(Failure::corrupt("XML needs one root element"));
    }
    Ok(root.children.remove(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_doctype_is_refused_and_nothing_expands() {
        assert!(parse(br#"<!DOCTYPE x [<!ENTITY a "boom">]><x>&a;</x>"#)
            .unwrap_err()
            .detail()
            .contains("DOCTYPE"));
    }
    #[test]
    fn only_the_five_entities_and_numeric_references_unescape() {
        assert_eq!(
            parse(b"<x>&lt;&gt;&amp;&apos;&quot;&#65;&#x1f600;</x>")
                .unwrap()
                .text,
            "<>&'\"A😀"
        );
        assert!(parse(b"<x>&nbsp;</x>").is_err());
    }
    #[test]
    fn nesting_past_256_is_corrupt() {
        let deep = format!("{}{}", "<x>".repeat(257), "</x>".repeat(257));
        assert!(parse(deep.as_bytes()).is_err());
        let edge = format!("{}{}", "<x>".repeat(256), "</x>".repeat(256));
        assert!(parse(edge.as_bytes()).is_ok());
    }
}
