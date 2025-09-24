import { FC, useEffect, useRef, useState } from "react";
import { monaco } from "../../monaco-setup";
import type {
  editor as MonacoEditorType,
  IRange,
  IDisposable,
} from "monaco-editor";
import type { EditorChildProps } from "./types";

export const DiffEditor: FC<EditorChildProps> = ({
  controller,
  initialScrollPosition,
  className = "",
  onScrollChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditorType.IStandaloneDiffEditor | null>(null);
  const [editorReady, setEditorReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create the Monaco diff editor instance
    const editor = monaco.editor.createDiffEditor(containerRef.current, {
      minimap: { enabled: false },
      wordWrap: "on",
      fontSize: 14,
      fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
      readOnly: false,
      renderSideBySide: false, // Inline diff view
      automaticLayout: true,
      theme: "vs-light",
      originalEditable: false, // Don't allow editing the original (committed) side
    });

    editorRef.current = editor;
    setEditorReady(true);

    editor.setModel({
      original: controller.getCommittedModel(),
      modified: controller.getWorkingModel(),
    });

    /* When the diff editor is created asynchronously computes the diff and
     * updates the models; this means if we immediately try to set the scroll
     * position, it may not work because there might be extra space added to handle
     * removed lines that are in the original view but not the modified view.
     * To handle this, we listen for the `onDidUpdateDiff` event which signals
     * that the diff has been computed and the view is ready.
     */
    if (initialScrollPosition !== undefined) {
      let initialScrollDisposable: IDisposable | null = null;

      initialScrollDisposable = editor.onDidUpdateDiff(() => {
        const modifiedEditor = editor.getModifiedEditor();
        const scrollTop =
          modifiedEditor.getTopForLineNumber(
            initialScrollPosition.topLineNumber,
          ) - initialScrollPosition.topLineDelta;
        modifiedEditor.setScrollTop(scrollTop);

        if (initialScrollDisposable) {
          initialScrollDisposable.dispose();
        }
      });
    }

    // Cleanup function
    return () => {
      if (editorRef.current) {
        editorRef.current.dispose();
        editorRef.current = null;
      }
    };
  }, [controller]);

  useEffect(() => {
    if (!editorRef.current || !onScrollChange) return;

    const editor = editorRef.current.getModifiedEditor();

    const disposable = editor.onDidScrollChange((event) => {
      const ranges = editor.getVisibleRanges();
      const topLineNumber = ranges[0]?.startLineNumber || 0;
      const scrollTop = editor.getScrollTop();
      const topLinePixel = editor.getTopForLineNumber(topLineNumber);
      onScrollChange({
        topLineNumber,
        topLineDelta: topLinePixel - scrollTop,
      });
    });

    return () => {
      disposable.dispose();
    };
  }, [editorReady, onScrollChange]);

  return <div ref={containerRef} className={`h-full w-full ${className}`} />;
};

DiffEditor.displayName = "DiffEditor";
