export type XmlNode = {
  id: string;
  tagName: string;
  textContent: string;
  children: XmlNode[];
};

export type ValidationIssue = {
  nodeId: string;
  message: string;
};

export type NodeOutlineItem = {
  id: string;
  depth: number;
  label: string;
  duplicate: boolean;
};

export type PreviewLine = {
  text: string;
  nodeId: string | null;
  primary: boolean;
};
