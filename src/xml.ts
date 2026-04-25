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
        message:
          "Tag name must start with a letter or underscore and then use only letters, numbers, hyphen, underscore, or dot."
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
  const textContent = node.textContent;

  if (node.children.length === 0 && textContent === "") {
    return [
      {
        text: `${indent}<${tagName}/>`,
        nodeId: node.id,
        primary: true
      }
    ];
  }

  if (node.children.length === 0) {
    return [
      {
        text: `${indent}<${tagName}>${textContent}</${tagName}>`,
        nodeId: node.id,
        primary: true
      }
    ];
  }

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

function isValidXmlName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9._-]*$/.test(value);
}
