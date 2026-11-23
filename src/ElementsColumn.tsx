import { cx } from "./helpers";
import type { NodeOutlineItem } from "./types";

type ElementsColumnProps = {
  items: NodeOutlineItem[];
  activeNodeId: string;
  issueNodeIds: ReadonlySet<string>;
  onSelectNode: (nodeId: string) => void;
};

// Depth indentation uses `.depth-0`..`.depth-12` classes rather than inline
// `style` variables so Chromium's strict `style-src 'self'` CSP never strips
// indentation in production builds.
export function ElementsColumn({
  items,
  activeNodeId,
  issueNodeIds,
  onSelectNode,
}: ElementsColumnProps) {
  return (
    <section className="column elements">
      <h2 className="column-title">Elements</h2>
      <div className="element-list">
        {items.map((item) => {
          const hasIssue = issueNodeIds.has(item.id);
          const isActive = activeNodeId === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={cx(
                "element-row",
                `depth-${Math.min(item.depth, 12)}`,
                isActive && "is-active",
                hasIssue && "has-issue"
              )}
              aria-current={isActive ? "true" : undefined}
              tabIndex={-1}
              onClick={() => onSelectNode(item.id)}
            >
              <span className="element-label">{item.label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
