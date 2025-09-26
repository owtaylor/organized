import { FC, useState, useRef, useEffect } from "react";
import {
  PencilIcon,
  DocumentPlusIcon,
  EyeIcon,
} from "@heroicons/react/24/outline";
import { useFileSystem } from "./contexts/FileSystemContext";
import { EditorController } from "./controllers/EditorController";
import { CodeEditor, DiffEditor, MarkdownPreview } from "./components/editor";
import { ScrollPosition } from "./components/editor/types";

type EditorMode = "edit" | "diff" | "preview";

interface EditorProps {
  path: string;
}

const Editor: FC<EditorProps> = ({ path }) => {
  const { fileSystem } = useFileSystem();
  const [mode, setMode] = useState<EditorMode>("edit");
  const controllerRef = useRef<EditorController | null>(null);
  const scrollPositionsRef = useRef<{
    [key in EditorMode]?: ScrollPosition;
  }>({});
  const shortlyAfterModeSwitchRef = useRef(false);

  useEffect(() => {
    const controller = new EditorController(fileSystem, path);
    controllerRef.current = controller;

    return () => {
      controller.dispose();
    };
  }, [fileSystem, path]);

  useEffect(() => {
    // Reset the shortlyAfterModeSwitch flag after a brief delay
    shortlyAfterModeSwitchRef.current = true;
    const timeout = setTimeout(() => {
      shortlyAfterModeSwitchRef.current = false;
    }, 1000); // 1 second delay

    return () => clearTimeout(timeout);
  }, [mode]);

  // Because we are creating and destroying the editor instances when switching modes,
  // we need to keep track of the scroll positions for each mode so we can restore them
  // when switching back.
  //
  // In general, we want to keep the scroll positions in sync across modes, but we
  // also want to keep an exact pixel position (not just topLineNumber, but also the
  // offset within that line) for the current mode so that when the user switches
  // back, they see exactly what they were looking at before. This particularly matters
  // for the diff editor where a single "line" might be one line of unchanged content
  // plus many lines of removed content.
  //
  // To achieve this, when the user scrolls in the current mode, we update the scroll
  // position for that mode with the exact pixel offset, and we update the other modes
  // with just the topLineNumber (and reset their pixel offset to 0).
  //
  // However, when the user switches modes, we don't want to immediately overwrite
  // the other modes' scroll positions with the current mode's position, because
  // that would prevent them from maintaining their own positions. To handle this,
  // we use a shortlyAfterModeSwitchRef flag to skip updating other modes' positions
  // for a brief period after a mode switch.
  //
  const handleScrollChange = (position: ScrollPosition) => {
    scrollPositionsRef.current[mode] = position;
    if (!shortlyAfterModeSwitchRef.current) {
      for (const key of ["edit", "diff", "preview"]) {
        if (key !== mode) {
          scrollPositionsRef.current[key as EditorMode] = {
            topLineNumber: position.topLineNumber,
            topLineDelta: 0, // Reset delta for other modes
          };
        }
      }
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
        {mode === "edit" && controllerRef.current && (
          <CodeEditor
            controller={controllerRef.current}
            initialScrollPosition={scrollPositionsRef.current.edit}
            onScrollChange={handleScrollChange}
          />
        )}

        {mode === "diff" && controllerRef.current && (
          <DiffEditor
            controller={controllerRef.current}
            initialScrollPosition={scrollPositionsRef.current.diff}
            onScrollChange={handleScrollChange}
          />
        )}

        {mode === "preview" && controllerRef.current && (
          <MarkdownPreview
            controller={controllerRef.current}
            initialScrollPosition={scrollPositionsRef.current.preview}
            onScrollChange={handleScrollChange}
          />
        )}
      </div>
    </div>
  );
};

export default Editor;
