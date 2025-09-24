import { FC, useState, useRef, useEffect, useMemo } from "react";
import MonacoEditor from "@monaco-editor/react";
import { DiffEditor } from "@monaco-editor/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  PencilIcon,
  DocumentPlusIcon,
  EyeIcon,
} from "@heroicons/react/24/outline";
import { useFileSystem } from "./contexts/FileSystemContext";
import { EditorController } from "./controllers/EditorController";
import type { editor as MonacoEditorType, IRange } from "monaco-editor";

type EditorMode = "edit" | "diff" | "preview";

interface EditorProps {
  path: string;
}

/**
 * It would be nice if we could create the models and pass them into the
 * MonacoEditor and DiffEditor components, but that isn't supported, so
 * instead we hack into the system that @monaco-editor/react provides to
 * cache models by file path - we generate unique paths for this control,
 * lazily accumulate references to the models that get created, and
 * dispose of them when the component is unmounted.
 */
interface ModelInfo {
  originalPath: string;
  modifiedPath: string;
  original: MonacoEditorType.ITextModel | null;
  modified: MonacoEditorType.ITextModel | null;
}

let counter = 0;
function _makeBlankModelInfo() {
  counter += 1;
  return {
    originalPath: `original-${counter}`,
    modifiedPath: `modified-${counter}`,
    original: null,
    modified: null,
  };
}

const Editor: FC<EditorProps> = ({ path }) => {
  const { fileSystem } = useFileSystem();
  const [mode, setMode] = useState<EditorMode>("edit");
  const [previewContents, setPreviewContents] = useState("");
  const [committedContents, setCommittedContents] = useState("");
  const modeRef = useRef<EditorMode>(mode);
  const controllerRef = useRef<EditorController | null>(null);
  const modelInfoRef = useRef<ModelInfo>(_makeBlankModelInfo());
  const savedVisibleRanges = useRef<IRange[] | null>(null);

  useEffect(() => {
    return () => {
      // Clean up models on unmount
      if (modelInfoRef.current.original) {
        modelInfoRef.current.original.dispose();
        modelInfoRef.current.original = null;
      }
      if (modelInfoRef.current.modified) {
        modelInfoRef.current.modified.dispose();
        modelInfoRef.current.modified = null;
      }
    };
  }, []);

  useEffect(() => {
    const controller = new EditorController(fileSystem, path);
    controllerRef.current = controller;

    // We avoid tracking the current local contents as state
    // to avoid a rerendering per keystroke, but we *do* need
    // it as state when we're in preview mode.
    controller.addLocalContentsChangedListener((contents) => {
      if (modeRef.current === "preview") {
        setPreviewContents(contents);
      }
    });

    controller.addCommittedContentsChangedListener((contents) => {
      setCommittedContents(contents);
    });

    return () => {
      controller.dispose();
    };
  }, [fileSystem, path]);

  useEffect(() => {
    modeRef.current = mode;
    if (mode === "preview") {
      setPreviewContents(controllerRef.current?.localContents ?? "");
    }
  }, [mode]);

  const handleCodeEditorDidMount = (
    editor: MonacoEditorType.IStandaloneCodeEditor,
  ) => {
    modelInfoRef.current.modified = editor.getModel();
    controllerRef.current?.setCodeEditor(editor);
  };

  const handleDiffEditorDidMount = (
    editor: MonacoEditorType.IStandaloneDiffEditor,
  ) => {
    modelInfoRef.current.original = editor.getOriginalEditor().getModel();
    modelInfoRef.current.modified = editor.getModifiedEditor().getModel();
    controllerRef.current?.setDiffEditor(editor);
  };

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
        {mode === "edit" && (
          <MonacoEditor
            height="100%"
            defaultLanguage="markdown"
            defaultValue={controllerRef.current?.localContents}
            keepCurrentModel={true}
            path={modelInfoRef.current.modifiedPath}
            onMount={handleCodeEditorDidMount}
            options={{
              minimap: { enabled: false },
              wordWrap: "on",
              lineNumbers: "on",
              fontSize: 14,
              fontFamily: "Monaco, Menlo, 'Ubuntu Mono', monospace",
            }}
          />
        )}

        {mode === "diff" && (
          <DiffEditor
            height="100%"
            language="markdown"
            keepCurrentOriginalModel={true}
            keepCurrentModifiedModel={true}
            original={committedContents}
            originalModelPath={modelInfoRef.current.originalPath}
            modifiedModelPath={modelInfoRef.current.modifiedPath}
            onMount={handleDiffEditorDidMount}
            options={{
              minimap: { enabled: false },
              wordWrap: "on",
              fontSize: 14,
              fontFamily: "Monaco, Menlo, 'Ubuntu Mono', monospace",
              readOnly: false,
              renderSideBySide: false,
            }}
          />
        )}

        {mode === "preview" && (
          <div className="h-full overflow-auto p-4">
            <div className="prose prose-lg max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {previewContents}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Editor;
