import { FC, useState, useRef, useEffect } from "react";
import {
  PencilIcon,
  DocumentPlusIcon,
  EyeIcon,
} from "@heroicons/react/24/outline";
import { useFileSystem } from "./contexts/FileSystemContext";
import { EditorController } from "./controllers/EditorController";
import { CodeEditor, DiffEditor, MarkdownPreview } from "./components/editor";

type EditorMode = "edit" | "diff" | "preview";

interface EditorProps {
  path: string;
}

const Editor: FC<EditorProps> = ({ path }) => {
  const { fileSystem } = useFileSystem();
  const [mode, setMode] = useState<EditorMode>("edit");
  const controllerRef = useRef<EditorController | null>(null);

  useEffect(() => {
    const controller = new EditorController(fileSystem, path);
    controllerRef.current = controller;

    return () => {
      controller.dispose();
    };
  }, [fileSystem, path]);

  return (
    <div className="relative h-full">
      {/* Floating Toolbar */}
      <div className="absolute right-2 top-2 z-10 flex space-x-1 rounded border bg-white p-1 shadow-md">
        <button
          onClick={() => setMode("edit")}
          className={`rounded p-1 ${
            mode === "edit"
              ? "bg-blue-500 text-white"
              : "text-gray-600 hover:bg-gray-100"
          }`}
          title="Edit"
        >
          <PencilIcon className="h-4 w-4" />
        </button>
        <button
          onClick={() => setMode("diff")}
          className={`rounded p-1 ${
            mode === "diff"
              ? "bg-blue-500 text-white"
              : "text-gray-600 hover:bg-gray-100"
          }`}
          title="Diff"
        >
          <DocumentPlusIcon className="h-4 w-4" />
        </button>
        <button
          onClick={() => setMode("preview")}
          className={`rounded p-1 ${
            mode === "preview"
              ? "bg-blue-500 text-white"
              : "text-gray-600 hover:bg-gray-100"
          }`}
          title="Preview"
        >
          <EyeIcon className="h-4 w-4" />
        </button>
      </div>

      {/* Editor Content */}
      <div className="h-full">
        {mode === "edit" && controllerRef.current && (
          <CodeEditor controller={controllerRef.current} />
        )}

        {mode === "diff" && controllerRef.current && (
          <DiffEditor controller={controllerRef.current} />
        )}

        {mode === "preview" && controllerRef.current && (
          <MarkdownPreview controller={controllerRef.current} />
        )}
      </div>
    </div>
  );
};

export default Editor;
