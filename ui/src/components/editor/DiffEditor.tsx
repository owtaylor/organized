import { FC, useEffect, useRef } from "react";
import { monaco } from "../../monaco-setup";
import type { editor as MonacoEditorType } from "monaco-editor";
import { EditorController } from "../../controllers/EditorController";

interface DiffEditorProps {
  controller: EditorController;
  className?: string;
}

export const DiffEditor: FC<DiffEditorProps> = ({
  controller,
  className = "",
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditorType.IStandaloneDiffEditor | null>(null);

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
    editor.setModel({
      original: controller.getCommittedModel(),
      modified: controller.getWorkingModel(),
    });
    // Cleanup function
    return () => {
      if (editorRef.current) {
        editorRef.current.dispose();
        editorRef.current = null;
      }
    };
  }, [controller]);

  return <div ref={containerRef} className={`h-full w-full ${className}`} />;
};
