import { cx, splitPreviewLineLead } from "./helpers";
import type { PreviewLine } from "./types";

type PreviewColumnProps = {
  xmlPreview: string;
  previewLines: PreviewLine[];
  activeNodeId: string;
  previewPending: boolean;
  copyToken: number;
};

export function PreviewColumn({
  xmlPreview,
  previewLines,
  activeNodeId,
  previewPending,
  copyToken,
}: PreviewColumnProps) {
  return (
    <section className="column preview">
      <h2 className="column-title">Preview</h2>
      <div className="preview-pane" aria-busy={previewPending}>
        <div className="preview-scroll">
          {xmlPreview ? (
            previewLines.map((line) => {
              const isActive = line.kind !== "separator" && line.nodeId === activeNodeId;
              const split = splitPreviewLineLead(line.text);
              return (
                <div
                  key={`${line.nodeId}-${line.kind}`}
                  className={cx("preview-line", isActive && "is-active")}
                >
                  <span className="preview-indicator" aria-hidden="true">
                    {isActive && line.primary ? ">" : ""}
                  </span>
                  <span>
                    {split ? (
                      <>
                        <span className="preview-lead">{split.lead}</span>
                        {split.rest}
                      </>
                    ) : (
                      line.text
                    )}
                  </span>
                </div>
              );
            })
          ) : (
            <div className="preview-empty">Fix validation issues to see the preview.</div>
          )}
        </div>
        {previewPending && (
          <div className="preview-updating-note" role="status">
            Preview updating...
          </div>
        )}
        {copyToken > 0 && <div key={copyToken} className="bloom-overlay" aria-hidden="true" />}
      </div>
    </section>
  );
}
