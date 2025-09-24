import { FC, useEffect, useRef } from "react";
import { monaco } from "../../monaco-setup";
import type { editor as MonacoEditorType } from "monaco-editor";
import { EditorController } from "../../controllers/EditorController";

interface CodeEditorProps {
  controller: EditorController;
  className?: string;
}

export const CodeEditor: FC<CodeEditorProps> = ({
  controller,
  className = "",
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // Create the Monaco editor instance
    const editor = monaco.editor.create(containerRef.current, {
      minimap: { enabled: false },
      wordWrap: "on",
      fontSize: 14,
      fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
      lineNumbers: "on",
      scrollBeyondLastLine: false,
      automaticLayout: true,
      theme: "vs-light",
    });

    editorRef.current = editor;

    // Register the editor with the controller
    editor.setModel(controller.getWorkingModel());

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
