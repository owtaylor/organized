import { FC, useEffect, useRef, useState } from "react";
import { monaco } from "../../monaco-setup";
import type { editor as MonacoEditorType, IRange } from "monaco-editor";
import type { EditorChildProps, ScrollPosition } from "./types";

export const CodeEditor: FC<EditorChildProps> = ({
  controller,
  initialScrollPosition,
  className = "",
  onScrollChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditorType.IStandaloneCodeEditor | null>(null);
  const [editorReady, setEditorReady] = useState(false);

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
    setEditorReady(true);

    editor.setModel(controller.getWorkingModel());

    if (initialScrollPosition !== undefined) {
      const scrollTop =
        editor.getTopForLineNumber(initialScrollPosition.topLineNumber) -
        initialScrollPosition.topLineDelta;
      editor.setScrollTop(scrollTop);
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

    const editor = editorRef.current;

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

CodeEditor.displayName = "CodeEditor";
