import type { PreviewLine, ValidationIssue, XmlNode } from "./types";

export function validateDocument(root: XmlNode): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const walk = (node: XmlNode) => {
    const tagName = node.tagName.trim();
    if (!tagName) {
      issues.push({
        nodeId: node.id,
        message: "Tag name cannot be empty."
      });
    } else if (!isValidXmlName(tagName)) {
      issues.push({
        nodeId: node.id,
        message: "Tag name does not match the W3C XML 1.0 Name production."
      });
    }

    node.children.forEach(walk);
  };

  walk(root);
  return issues;
}

export function buildXml(root: XmlNode): string {
  return buildPreview(root).xml;
}

export function buildPreview(root: XmlNode): {
  xml: string;
  lines: PreviewLine[];
} {
  const lines = renderNode(root, 0);
  return {
    xml: lines.map((line) => line.text).join("\n"),
    lines
  };
}

export function findDuplicateNodes(root: XmlNode): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const walk = (node: XmlNode) => {
    const byTagName = new Map<string, XmlNode[]>();

    node.children.forEach((child) => {
      const tagName = child.tagName.trim();
      if (!tagName) {
        return;
      }

      const group = byTagName.get(tagName) ?? [];
      group.push(child);
      byTagName.set(tagName, group);
    });

    byTagName.forEach((group, tagName) => {
      if (group.length < 2) {
        return;
      }

      group.forEach((duplicateNode) => {
        issues.push({
          nodeId: duplicateNode.id,
          message: `Duplicate element name <${tagName}> under <${node.tagName.trim() || "parent"}>.`
        });
      });
    });

    node.children.forEach(walk);
  };

  walk(root);
  return issues;
}

function renderNode(node: XmlNode, depth: number): PreviewLine[] {
  const indent = "  ".repeat(depth);
  const tagName = node.tagName.trim();
  // WYSIWYG: textContent is emitted verbatim. This is intentional — the tool
  // outputs LLM-prompt markup, not strict XML, so users can write `<` `>` `&`
  // and have them appear literally in the prompt. Don't reintroduce escaping
  // unless adding an explicit "strict mode" toggle.
  const textContent = node.textContent;

  // Spec §3.1 distinguishes three forms — empty-element tag, start+end-tag
  // pair around char data, and start+end-tag pair around child elements.
  // Don't merge these branches; they're semantically distinct in XML.
  if (node.children.length === 0 && textContent === "") {
    // Empty-element tag (production [44]): `<x/>`
    return [
      {
        text: `${indent}<${tagName}/>`,
        nodeId: node.id,
        primary: true
      }
    ];
  }

  if (node.children.length === 0) {
    // Start-tag + char data + end-tag, single line
    return [
      {
        text: `${indent}<${tagName}>${textContent}</${tagName}>`,
        nodeId: node.id,
        primary: true
      }
    ];
  }

  // Start-tag + (optional char data) + child elements + end-tag, multi-line

  const lines: PreviewLine[] = [
    {
      text: `${indent}<${tagName}>`,
      nodeId: node.id,
      primary: true
    }
  ];

  if (textContent !== "") {
    lines.push({
      text: `${indent}  ${textContent}`,
      nodeId: node.id,
      primary: false
    });
  }

  node.children.forEach((child) => {
    lines.push(...renderNode(child, depth + 1));
  });

  lines.push({
    text: `${indent}</${tagName}>`,
    nodeId: node.id,
    primary: false
  });

  return lines;
}

// W3C XML 1.0 Fifth Edition §2.3 Name production. Don't narrow this back to
// ASCII without an explicit product reason — broadening from v1's narrower
// regex was a deliberate decision so users can use Chinese/Greek/etc. tag
// names. Note: ":" is allowed per spec but is reserved for the XML Namespaces
// spec (a separate W3C Rec we explicitly do not parse). The "u" flag is
// required for the \u{10000}-\u{EFFFF} range syntax.
const NAME_START_CHAR =
  ":_A-Za-z" +
  "\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF" +
  "\\u0370-\\u037D\\u037F-\\u1FFF" +
  "\\u200C-\\u200D" +
  "\\u2070-\\u218F\\u2C00-\\u2FEF" +
  "\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD" +
  "\\u{10000}-\\u{EFFFF}";

const NAME_CHAR =
  NAME_START_CHAR + "\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040";

const NAME_REGEX = new RegExp(`^[${NAME_START_CHAR}][${NAME_CHAR}]*$`, "u");

function isValidXmlName(value: string): boolean {
  return NAME_REGEX.test(value);
}
