import { FC, useState } from "react";
import MonacoEditor from "@monaco-editor/react";
import { DiffEditor } from "@monaco-editor/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PencilIcon, DocumentPlusIcon, EyeIcon } from "@heroicons/react/24/outline";

type EditorMode = "edit" | "diff" | "preview";

interface EditorProps {
  markdown: string;
  diffMarkdown: string;
  onChange?: (markdown: string) => void;
}

const Editor: FC<EditorProps> = ({ markdown, diffMarkdown, onChange }) => {
  const [mode, setMode] = useState<EditorMode>("edit");

  const handleEditorChange = (value: string | undefined) => {
    if (value !== undefined && onChange) {
      onChange(value);
    }
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
            value={markdown}
            onChange={handleEditorChange}
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
            original={diffMarkdown}
            modified={markdown}
            options={{
              minimap: { enabled: false },
              wordWrap: "on",
              fontSize: 14,
              fontFamily: "Monaco, Menlo, 'Ubuntu Mono', monospace",
              readOnly: true,
              renderSideBySide: false,
            }}
          />
        )}

        {mode === "preview" && (
          <div className="h-full overflow-auto p-4">
            <div className="prose prose-lg max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {markdown}
              </ReactMarkdown>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Editor;
